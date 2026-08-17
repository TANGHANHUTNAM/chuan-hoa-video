-- Background jobs.
--
-- Provisioning a VPS, importing a video by URL and normalising a video all take
-- minutes. None of them can sit inside an HTTP request: the browser would time
-- out and Render's proxy may cut the connection. Each one instead becomes a row
-- here that the UI polls.

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  type TEXT NOT NULL,                  -- setup | import | normalize | upload
  entity_type TEXT,
  entity_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|success|failed|cancelled
  progress_percent INTEGER NOT NULL DEFAULT 0,
  step TEXT,                           -- plain-language current step, shown to the user
  detail TEXT,                         -- masked log tail
  unit_name TEXT,                      -- systemd transient unit, when work runs on the VPS
  error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY(server_id) REFERENCES servers(id)
);

CREATE INDEX idx_jobs_entity ON jobs(entity_type, entity_id);
CREATE INDEX idx_jobs_status ON jobs(status, type);
CREATE INDEX idx_jobs_server ON jobs(server_id, status);
