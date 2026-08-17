'use strict';

const rateLimit = require('express-rate-limit');

// Login is the only unauthenticated write route, so it is the one that needs a
// brute-force guard (spec section 40.15).
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng đợi 10 phút.',
});

/**
 * Broad ceiling for the JSON API. The dashboard polls every 10-20 seconds and
 * job progress polls faster, so this is set high enough to never bother a real
 * user while still capping a runaway script.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Uploads are a single long request; counting them is pointless and the
  // per-server single-upload rule already limits them.
  skip: (req) => req.path === '/api/videos/upload',
});

module.exports = { loginLimiter, apiLimiter };
