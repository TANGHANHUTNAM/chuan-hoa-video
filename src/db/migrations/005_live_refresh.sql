-- Live destination additions (plan R5).

-- Facebook cuts a broadcast at 8 hours. With Restart=always plus RuntimeMaxSec,
-- systemd recycles FFmpeg before that limit and the stream continues, which is
-- what makes a long-running "mega live" possible without extra tooling.
ALTER TABLE live_destinations ADD COLUMN auto_refresh_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE live_destinations ADD COLUMN runtime_max_seconds INTEGER NOT NULL DEFAULT 27900;

-- Last 4 characters of the stream key, so the UI can tell destinations apart
-- without decrypting the secret on every page render.
ALTER TABLE live_destinations ADD COLUMN key_last4 TEXT;

ALTER TABLE live_destinations ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_destinations ADD COLUMN last_status_at TEXT;
