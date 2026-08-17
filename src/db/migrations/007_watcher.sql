-- Stall detection and self-recovery (plan Phase 2, phần B3).
--
-- `systemctl is-active` only proves the FFmpeg process exists. It can be alive
-- while frozen or stuck reconnecting, and the UI would still show green. These
-- columns record the last throughput sample so a stalled stream can be told
-- apart from a healthy one.

-- Microseconds of media FFmpeg has pushed, from its -progress output.
ALTER TABLE live_destinations ADD COLUMN last_out_time_us INTEGER;

-- When that sample was taken, so "unchanged for how long" is answerable.
ALTER TABLE live_destinations ADD COLUMN last_progress_at TEXT;

-- Per-destination switch: detect and record a stall, but only restart when on.
ALTER TABLE live_destinations ADD COLUMN auto_recover_enabled INTEGER NOT NULL DEFAULT 1;

-- How many times the watcher has restarted this destination, kept separate from
-- restart_count (which counts user-initiated restarts).
ALTER TABLE live_destinations ADD COLUMN recover_count INTEGER NOT NULL DEFAULT 0;
