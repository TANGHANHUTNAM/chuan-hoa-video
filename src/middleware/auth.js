'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Minimal cookie header parser. The app needs exactly one cookie, so pulling in
 * cookie-parser would add a dependency for no benefit (spec section 2 asks for a
 * minimal stack).
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!(key in out)) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

// JWT lives in an HttpOnly cookie, never localStorage (spec section 5).
function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

function readUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

/** Attaches req.user when a valid session exists, without blocking. */
function loadUser(req, res, next) {
  req.user = readUser(req);
  res.locals.currentUser = req.user;
  next();
}

/**
 * Gate for everything except /login and /health (spec section 11).
 * API routes get a 401 JSON body; page routes get a redirect so the browser
 * lands somewhere useful.
 */
function requireAuth(req, res, next) {
  if (req.user) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Bạn cần đăng nhập lại.' });
  }
  const target = req.originalUrl && req.originalUrl !== '/' ? req.originalUrl : '';
  const suffix = target ? `?next=${encodeURIComponent(target)}` : '';
  return res.redirect(`/login${suffix}`);
}

module.exports = {
  parseCookies,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  loadUser,
  requireAuth,
};
