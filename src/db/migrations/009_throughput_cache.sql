-- Cached throughput sample (plan Phase 2, phần B4).
--
-- The watcher already reads speed and bitrate on every sweep. Storing the last
-- values lets the dashboard and project page show "1.00x · 4500 kbps" straight
-- from the database, instead of opening an SSH connection per card on page load.
--
-- Transient telemetry, not a source of truth: cleared whenever a destination
-- stops.

ALTER TABLE live_destinations ADD COLUMN last_speed REAL;
ALTER TABLE live_destinations ADD COLUMN last_bitrate_kbps REAL;
