'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');

const config = require('./config');
const logger = require('./utils/logger');
const migrate = require('./db/migrate');
const seedAdmin = require('./db/seed');
const { loadUser, requireAuth } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rate-limit');
const { notFound, errorHandler } = require('./middleware/error-handler');

// Schema and admin account are brought up to date before the first request so a
// fresh Render deploy is immediately usable (spec section 5).
migrate();
seedAdmin();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// EJS templates cannot require() modules, so formatting helpers are exposed as
// app locals and are available in every view and partial.
const { formatBytes, formatDuration } = require('./utils/format-bytes');
const { maskRtmpsUrl } = require('./utils/mask');
Object.assign(app.locals, { formatBytes, formatDuration, maskRtmpsUrl });
app.set('trust proxy', 1); // Render terminates TLS in front of us.
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Would break http://localhost during development.
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
  })
);

// Health check must answer before auth so Render can probe it (spec section 42).
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));

// Neither parser touches multipart/form-data, so the streaming upload route
// still receives an untouched request body (spec section 44).
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

app.use(loadUser);
app.use('/api', apiLimiter);

app.use(require('./routes/auth.routes'));

// Everything below this line requires a session (spec section 11).
app.use(requireAuth);

// While somebody is actually navigating, refresh the Sheet cache so an edit made
// there shows up without waiting for the slow baseline cycle.
//
// Page views only. The dashboard polls /api/dashboard/status every 15 seconds, and
// letting that trigger a refresh would spend a 2-second Apps Script call every 30
// seconds for as long as a tab stays open — around 100 minutes a day against a
// 90-minute allowance, from an idle browser.
const sheets = require('./services/sheets.service');
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) sheets.activityPull();
  next();
});

// Refuses catalogue changes while the Sheet is unreachable, per the user's choice
// to stop rather than diverge. Never blocks going live, staying live, stopping, or
// freeing disk — see the route table in the middleware.
app.use(require('./middleware/sheets-gate').sheetsGate);

app.use(require('./routes/dashboard.routes'));
app.use(require('./routes/jobs.routes'));
app.use(require('./routes/servers.routes'));
app.use(require('./routes/videos.routes'));
app.use(require('./routes/projects.routes'));
app.use(require('./routes/logs.routes'));
app.use(require('./routes/sheets.routes'));

// Work that lives on the VPS (a curl download, an FFmpeg normalise) survived our
// restart, so re-attach to it instead of leaving jobs stuck at "running".
require('./services/job.service').resumeOrphaned();

// Watches every live destination on a timer: records what died and restarts what
// froze. Only effective while this process stays awake.
require('./services/watcher.service').start();

// Mirrors the catalogue to the user's Google Sheet and reads their edits back. A
// no-op unless SHEETS_ENABLED=1 with a webhook URL and token.
sheets.start();

app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`Facebook Live Manager listening on port ${config.port} (${config.env})`);
  logger.info(`Database: ${config.dbPath}`);
});

// Render sends SIGTERM on deploy; close cleanly so in-flight requests finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}

module.exports = app;
