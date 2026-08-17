-- Server provisioning and health state (plan R1, R2, R6).

-- Pinned SSH host key, OpenSSH "SHA256:..." form. ssh2 accepts any host key
-- unless we verify it ourselves, so this column is what makes trust-on-first-use
-- possible.
ALTER TABLE servers ADD COLUMN host_key_fingerprint TEXT;

-- root | sudo_nopasswd | sudo_password | none
ALTER TABLE servers ADD COLUMN privilege_mode TEXT;

-- new | provisioning | ready | failed
ALTER TABLE servers ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'new';

-- Whether this FFmpeg build can actually speak rtmps. Facebook only accepts
-- RTMPS, and a build without TLS support fails at stream time with an opaque
-- error, so we check it up front.
ALTER TABLE servers ADD COLUMN ffmpeg_has_rtmps INTEGER;

ALTER TABLE servers ADD COLUMN nic_speed_mbps INTEGER;
ALTER TABLE servers ADD COLUMN cpu_cores INTEGER;
ALTER TABLE servers ADD COLUMN ram_total_mb INTEGER;

-- Full result of the last health run, as JSON, for rendering the checklist.
ALTER TABLE servers ADD COLUMN checks_json TEXT;

-- Set once the app has installed its own dedicated key on this VPS.
ALTER TABLE servers ADD COLUMN key_installed_at TEXT;
