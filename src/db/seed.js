'use strict';

const bcrypt = require('bcryptjs');
const db = require('./index');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Creates the single admin account on first boot (spec section 5).
 *
 * Deliberately does NOT update the password when the account already exists:
 * otherwise every redeploy would reset a password the user had changed, and
 * ADMIN_PASSWORD would effectively become a permanent backdoor.
 */
function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) {
    logger.info('Admin account already exists, leaving it untouched');
    return false;
  }

  const hash = bcrypt.hashSync(config.admin.password, 12);
  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(
    config.admin.email.trim().toLowerCase(),
    hash
  );

  logger.info(`Created admin account for ${config.admin.email}`);
  return true;
}

module.exports = seedAdmin;

if (require.main === module) {
  require('./migrate')();
  seedAdmin();
}
