-- How long a destination keeps playing.
--
-- Until now every broadcast looped forever (`-stream_loop -1`) and only stopped
-- when the user pressed Stop. That is right for a 24/7 channel and wrong for
-- "play my 2-hour video three times and finish".
--
-- Measured on the real VPS before choosing the mechanism:
--
--   * `-stream_loop -1` with `-t 12` on a 5-second file exits 0 after 12.26s, and
--     does the same through a concat playlist (13s -> 13.18s). So the end can be
--     placed exactly, including mid-video, without re-encoding.
--   * systemd `Restart=always` restarts a process that exited CLEANLY — a probe
--     unit ran 3 times in 9 seconds. So a finite broadcast must switch to
--     `Restart=on-failure`, or it would loop forever regardless of `-t`.
--     `Restart=on-failure` still restarted a crashing probe 4 times, so crash
--     recovery is not lost.
--
-- planned_end_at is computed at start time, not stored as config, because the
-- number of loops means nothing without the playlist's current duration — and the
-- playlist can change between one broadcast and the next.
ALTER TABLE live_destinations ADD COLUMN loop_mode TEXT NOT NULL DEFAULT 'infinite';
ALTER TABLE live_destinations ADD COLUMN loop_count INTEGER;
ALTER TABLE live_destinations ADD COLUMN loop_hours REAL;
ALTER TABLE live_destinations ADD COLUMN planned_end_at TEXT;
