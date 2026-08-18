-- Global row identity, so more than one machine can share one Sheet.
--
-- The Sheet keyed every row by `id`. `id` is INTEGER PRIMARY KEY AUTOINCREMENT, which
-- is numbered per DATABASE — so machine A's `Projects#3` and machine B's `Projects#3`
-- were the same spreadsheet row while being two different projects. Measured before
-- this change: a second install rewrote 1 Servers row and 5 Projects rows on its first
-- sync, and both machines then pushed their own version back on every cycle, forever.
-- Nothing was lost, but the Sheet flipped between two realities and the ping-pong ate
-- the 90-minute daily Apps Script allowance.
--
-- `uuid` is generated once, travels with the row, and is what the Sheet is keyed by
-- now. `id` stays and is still synced, because it is NOT free to renumber: the systemd
-- unit, the env file and the progress file on the VPS are all named from the numeric
-- id (`live-manager-<id>`, `dest-<id>.env`). A restore therefore keeps the id it reads
-- from the Sheet, and uuid only decides WHICH row is which.
--
-- `videos` already had a uuid — it names the file on the VPS — and it is reused here
-- rather than adding a second one.

ALTER TABLE servers ADD COLUMN uuid TEXT;
ALTER TABLE projects ADD COLUMN uuid TEXT;
ALTER TABLE project_videos ADD COLUMN uuid TEXT;
ALTER TABLE live_destinations ADD COLUMN uuid TEXT;
ALTER TABLE activity_logs ADD COLUMN uuid TEXT;

-- randomblob() is evaluated per row, so these are distinct.
UPDATE servers SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
UPDATE projects SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
UPDATE project_videos SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
UPDATE live_destinations SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
UPDATE activity_logs SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;

CREATE UNIQUE INDEX idx_servers_uuid ON servers(uuid);
CREATE UNIQUE INDEX idx_projects_uuid ON projects(uuid);
CREATE UNIQUE INDEX idx_project_videos_uuid ON project_videos(uuid);
CREATE UNIQUE INDEX idx_live_destinations_uuid ON live_destinations(uuid);
CREATE UNIQUE INDEX idx_activity_logs_uuid ON activity_logs(uuid);

-- Filled by a trigger rather than by every INSERT in the app.
--
-- activity_logs alone is written from a dozen services, each with its own little
-- logActivity helper; servers and destinations have several insert paths too. Every
-- one of those would be a place to forget, and a forgotten uuid means a row that
-- silently never reaches the Sheet. The same reasoning as sheet_snapshot in 011.
--
-- `WHEN NEW.uuid IS NULL` leaves an explicitly supplied uuid alone, which is what lets
-- restoreFromSheet insert a row under the identity it already has on the Sheet.

CREATE TRIGGER servers_uuid AFTER INSERT ON servers WHEN NEW.uuid IS NULL
BEGIN
  UPDATE servers SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TRIGGER projects_uuid AFTER INSERT ON projects WHEN NEW.uuid IS NULL
BEGIN
  UPDATE projects SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TRIGGER project_videos_uuid AFTER INSERT ON project_videos WHEN NEW.uuid IS NULL
BEGIN
  UPDATE project_videos SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TRIGGER live_destinations_uuid AFTER INSERT ON live_destinations WHEN NEW.uuid IS NULL
BEGIN
  UPDATE live_destinations SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TRIGGER activity_logs_uuid AFTER INSERT ON activity_logs WHEN NEW.uuid IS NULL
BEGIN
  UPDATE activity_logs SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- The queue and the snapshot are both keyed by the OLD identity, so every row in them
-- refers to a Sheet row that is about to be keyed differently. Clearing them makes the
-- next reconcile treat everything as unsent and push it in full under the new key.
-- Nothing is lost: both tables are derived from the catalogue, never a source of truth.
DELETE FROM sheet_outbox;
DELETE FROM sheet_snapshot;

-- Read by sheets.service on startup: the Sheet itself still has id-keyed rows and a
-- header with no uuid column, and only a rebuild can fix that. Removed once done.
INSERT INTO sheet_state (key, value, updated_at)
VALUES ('key_scheme_pending', 'uuid', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = 'uuid', updated_at = CURRENT_TIMESTAMP;
