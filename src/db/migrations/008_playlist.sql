-- Multi-video playlists (plan Phase 2, phần C).
--
-- A project could previously hold exactly one video (projects.video_id). This
-- table makes it an ordered list, played end to end and then looped as a whole
-- via FFmpeg's concat demuxer.
--
-- projects.video_id is deliberately kept and stays in sync with position 0, so
-- existing views and assertStartable() keep working without a rewrite.

CREATE TABLE project_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(video_id) REFERENCES videos(id),
  UNIQUE(project_id, video_id)
);

CREATE INDEX idx_project_videos ON project_videos(project_id, position);

-- Carry every existing single-video project across, so a project that is live
-- right now keeps playing the same file.
INSERT INTO project_videos (project_id, video_id, position)
SELECT id, video_id, 0 FROM projects WHERE video_id IS NOT NULL;
