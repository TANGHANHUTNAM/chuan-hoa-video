-- Google Sheets sync (plan Phase 3, phần C).
--
-- The user chose Sheets as the place they manage data, reached through an Apps
-- Script webhook. A consumer Gmail account allows only 90 MINUTES of Apps Script
-- runtime per day, so the design has to spend calls carefully: reads come from a
-- local cache, and writes are queued here and flushed in batches.

-- Pending writes, so nothing is lost if the app restarts or Google is briefly
-- unreachable.
--
-- UNIQUE(tab, entity_id) with INSERT OR REPLACE coalesces repeated edits to the
-- same row into one pending write. Ten renames of the same video cost one call,
-- not ten.
CREATE TABLE sheet_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  operation TEXT NOT NULL,          -- upsert | delete
  payload TEXT,                     -- JSON row for upsert, null for delete
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tab, entity_id)
);

CREATE INDEX idx_sheet_outbox_ready ON sheet_outbox(attempts, id);

-- Sync bookkeeping: when the cache was last refreshed, whether it worked, and
-- what went wrong. The freshness gate reads this to decide whether a write may
-- proceed.
CREATE TABLE sheet_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every webhook call, with how long it took.
--
-- This is what makes the 90-minute budget observable instead of guessed: the app
-- can report actual consumption over the last 24 hours and throttle itself before
-- Google cuts it off.
CREATE TABLE sheet_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  duration_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sheet_calls_time ON sheet_calls(created_at);

-- Human-owned free text that only exists on the Sheet. Kept here so a pull can
-- round-trip it without the app inventing a column on every table.
ALTER TABLE videos ADD COLUMN note TEXT;
ALTER TABLE projects ADD COLUMN note TEXT;
ALTER TABLE live_destinations ADD COLUMN note TEXT;
ALTER TABLE servers ADD COLUMN note TEXT;
