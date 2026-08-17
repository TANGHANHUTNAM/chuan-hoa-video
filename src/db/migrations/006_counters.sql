-- Outbound bandwidth tracking (plan R3).
--
-- Render bills traffic a service sends out, and an SFTP push to the user's VPS
-- is exactly that. A 2 GB upload therefore costs 2 GB of billable egress, and on
-- the Hobby plan (5 GB/month) Render suspends the service once it runs out. We
-- count what we send so the UI can warn before that happens.

CREATE TABLE app_counters (
  month TEXT PRIMARY KEY,         -- 'YYYY-MM'
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
