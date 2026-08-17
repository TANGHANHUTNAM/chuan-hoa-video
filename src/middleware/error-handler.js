'use strict';

const logger = require('../utils/logger');
const config = require('../config');

/**
 * Thrown by services when the problem is the user's input or the VPS state,
 * not a bug. The message is safe to show as-is and is already in Vietnamese.
 */
class AppError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
    this.expected = true;
  }
}

function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Không tìm thấy đường dẫn này.' });
  }
  return res.status(404).render('error', {
    title: 'Không tìm thấy trang',
    message: 'Đường dẫn bạn mở không tồn tại.',
    details: null,
  });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  // Unexpected errors are bugs: log the stack. Expected ones are routine
  // (wrong password, disk full) and would just be noise.
  if (!err.expected || status >= 500) {
    logger.error('Request failed', req.method, req.path, err);
  }

  const message = err.expected
    ? err.message
    : 'Có lỗi không mong muốn xảy ra. Vui lòng thử lại.';

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      error: message,
      details: err.expected ? err.details || null : null,
    });
  }

  return res.status(status).render('error', {
    title: status >= 500 ? 'Lỗi hệ thống' : 'Không thực hiện được',
    message,
    details: err.expected ? err.details : config.isProduction ? null : err.stack,
  });
}

module.exports = { AppError, notFound, errorHandler };
