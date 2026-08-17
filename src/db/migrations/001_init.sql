-- Initial schema (spec section 9).

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  encrypted_password TEXT,
  encrypted_private_key TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  os_name TEXT,
  ffmpeg_version TEXT,
  total_bytes INTEGER,
  used_bytes INTEGER,
  available_bytes INTEGER,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL,
  codec_video TEXT,
  codec_audio TEXT,
  width INTEGER,
  height INTEGER,
  fps REAL,
  bitrate INTEGER,
  status TEXT NOT NULL DEFAULT 'uploading',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(server_id) REFERENCES servers(id)
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  video_id INTEGER,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(server_id) REFERENCES servers(id),
  FOREIGN KEY(video_id) REFERENCES videos(id)
);

CREATE TABLE live_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  encrypted_rtmps_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  systemd_unit TEXT,
  started_at TEXT,
  stopped_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_videos_server ON videos(server_id);
CREATE INDEX idx_projects_server ON projects(server_id);
CREATE INDEX idx_projects_video ON projects(video_id);
CREATE INDEX idx_destinations_project ON live_destinations(project_id);
CREATE INDEX idx_logs_created ON activity_logs(created_at DESC);
