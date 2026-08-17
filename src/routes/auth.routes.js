'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, setAuthCookie, clearAuthCookie } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rate-limit');
const logger = require('../utils/logger');

const router = express.Router();

/** Only allow redirects back into this app, never to an attacker-supplied host. */
function safeNext(value) {
  const next = String(value || '');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { error: null, email: '', next: req.query.next || '' });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = req.body.next;

  const fail = () =>
    res.status(401).render('login', {
      error: 'Email hoặc mật khẩu không đúng.',
      email,
      next: next || '',
    });

  if (!email || !password) return fail();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  // Compare against a dummy hash when the user does not exist so a missing
  // account and a wrong password take the same amount of time.
  const hash = user ? user.password_hash : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = bcrypt.compareSync(password, hash);

  if (!user || !ok) {
    logger.warn(`Failed login attempt for ${email}`);
    return fail();
  }

  setAuthCookie(res, signToken(user));
  logger.info(`Login succeeded for ${email}`);
  res.redirect(safeNext(next));
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/login');
});

module.exports = router;
