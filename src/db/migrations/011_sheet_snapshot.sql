-- What the Sheet currently holds, as far as this app knows.
--
-- The obvious way to keep a Sheet in step is to call queueUpsert() from every
-- place that writes a row. That was the original plan and it is a trap: writes
-- happen in twenty-odd places across video/project/live/server/provision
-- services, and the ONE that gets forgotten produces a Sheet that is silently
-- wrong — the worst possible failure for something the user is told is their
-- system of record. It also cannot see a row changed by a raw UPDATE, and
-- provision.service alone has seven of those.
--
-- So instead the app periodically compares every mapped row against the copy it
-- last sent, and queues only the difference. Nothing can be missed, because
-- nothing has to be remembered. The comparison is local SQLite over a handful of
-- rows, which costs microseconds and no Apps Script quota at all.
--
-- Storing the whole pushed row rather than a hash is what makes column ownership
-- work. A push carries only the columns that actually changed locally, so a name
-- the user typed in the Sheet is never overwritten by the app re-sending a name
-- it never changed — while a rename done IN the app still reaches the Sheet.
CREATE TABLE sheet_snapshot (
  tab TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  payload TEXT NOT NULL,            -- JSON of the row as the Sheet has it
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tab, entity_id)
);

-- The row as it will look on the Sheet once this queued write lands.
--
-- The snapshot is advanced only when a flush SUCCEEDS. Advancing it at queue time
-- would mean a write that failed six times and was abandoned leaves the app
-- believing the Sheet has a value it never received — the change would be lost
-- with nothing to detect it. Carrying the post-write state alongside the queued
-- delta keeps that promotion atomic with the successful call, and survives a
-- restart mid-queue.
ALTER TABLE sheet_outbox ADD COLUMN snapshot_payload TEXT;
