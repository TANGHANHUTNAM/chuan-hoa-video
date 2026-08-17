'use strict';

const express = require('express');
const jobs = require('../services/job.service');
const { isPositiveInt } = require('../utils/validators');
const { AppError } = require('../middleware/error-handler');

const router = express.Router();

function jobId(req) {
  if (!isPositiveInt(req.params.id)) throw new AppError('Mã tiến trình không hợp lệ.', 400);
  return Number(req.params.id);
}

// Single polling endpoint shared by provisioning, link import and normalise.
router.get('/api/jobs/:id', (req, res) => {
  res.json(jobs.toJson(jobs.getOrThrow(jobId(req))));
});

router.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.requestCancel(jobId(req));

  // The Cancel button is a plain form so it works without JS; a form post asks
  // for HTML and would otherwise be shown raw JSON.
  if (req.accepts(['json', 'html']) === 'html') {
    return res.redirect(req.get('referer') || '/dashboard');
  }
  res.json(jobs.toJson(job));
});

module.exports = router;
