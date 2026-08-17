-- Video pipeline additions (plan R4, Phần 3, Phần 7).

-- upload | url | existing
ALTER TABLE videos ADD COLUMN source_type TEXT NOT NULL DEFAULT 'upload';

-- A link import URL may carry a signed token, so it is encrypted like any secret.
ALTER TABLE videos ADD COLUMN source_url_encrypted TEXT;

-- Largest gap between keyframes, in seconds. Facebook requires one at least
-- every 2 seconds; most editor exports use 5-10, which is why this is measured
-- rather than assumed.
ALTER TABLE videos ADD COLUMN max_keyframe_interval REAL;

-- Facebook expects an audio track. A silent one is added during normalise when
-- the source has none.
ALTER TABLE videos ADD COLUMN has_audio INTEGER;

-- Cached result of the compliance rule, so the library can be listed without
-- re-deriving it.
ALTER TABLE videos ADD COLUMN fb_compliant INTEGER;

-- Why the video is not compliant, as JSON array of plain-language reasons.
ALTER TABLE videos ADD COLUMN compliance_notes TEXT;

-- Set on a normalised copy, pointing back at the original.
ALTER TABLE videos ADD COLUMN normalized_from_video_id INTEGER
  REFERENCES videos(id);

CREATE INDEX idx_videos_status ON videos(status);
