'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Applies every .sql file in migrations/ that has not run yet, in filename
 * order. Each file runs inside a transaction so a syntax error cannot leave the
 * schema half-migrated.
 */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });

    try {
      run();
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }

    logger.info(`Applied migration ${file}`);
    count += 1;
  }

  if (count === 0) logger.info('Database schema already up to date');
  return count;
}

module.exports = migrate;

// Allow `npm run migrate`.
if (require.main === module) {
  migrate();
}
