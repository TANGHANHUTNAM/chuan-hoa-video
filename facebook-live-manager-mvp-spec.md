# Facebook Live Manager — MVP Technical Specification

> **Mục tiêu của tài liệu:** Đây là đặc tả để AI/code agent có thể xây dựng trực tiếp một MVP quản lý nhiều VPS, nhiều video và nhiều phiên Facebook Live mà người dùng **không cần biết Linux, FFmpeg, PostgreSQL hay tự host database**.
>
> **Yêu cầu bắt buộc:** Giữ stack tối giản. Không tự ý thêm PostgreSQL, Supabase, Redis, Docker, queue service, object storage, Next.js, React hoặc agent chạy thường trú trên VPS nếu chưa thật sự cần.

---

## 1. Mục tiêu sản phẩm

Xây dựng một web app tên tạm **Facebook Live Manager** deploy trên **Render**.

Người dùng chỉ cần:

1. Đăng nhập bằng 1 tài khoản admin duy nhất.
2. Thêm VPS Ubuntu bằng SSH.
3. Bấm **Setup Server** để app tự kiểm tra/cài FFmpeg và tạo thư mục cần thiết.
4. Tạo Project.
5. Chọn video có sẵn trên VPS hoặc upload video mới lên VPS.
6. Thêm một hoặc nhiều Facebook Live destination bằng `RTMPS URL + Stream Key`.
7. Bấm **Start Live**.
8. Có thể Start / Stop / Restart từng live hoặc toàn bộ live trong project.
9. Có thể thay video cho project mà không sửa câu lệnh FFmpeg.
10. App phải luôn kiểm tra dung lượng VPS trước khi upload để tránh làm đầy ổ cứng.

Một video phải có thể được dùng cho **nhiều live cùng lúc** mà không nhân bản file.

Ví dụ:

```text
Project: Mega Live Dr.Natro
Video: mega-live.mp4

├── Facebook Page A → FFmpeg process #1
├── Facebook Page B → FFmpeg process #2
├── Facebook Page C → FFmpeg process #3
└── Facebook Page D → FFmpeg process #4
```

---

# 2. Stack bắt buộc

Chỉ sử dụng stack sau cho MVP:

```text
Node.js
Express.js
EJS hoặc server-rendered HTML
Plain CSS / minimal client-side JS
SQLite
ssh2
FFmpeg trên VPS của user
systemd trên VPS của user
Render Web Service
Render Persistent Disk
```

### Package Node.js đề xuất

```json
{
  "express": "latest",
  "ejs": "latest",
  "better-sqlite3": "latest",
  "ssh2": "latest",
  "busboy": "latest",
  "bcryptjs": "latest",
  "jsonwebtoken": "latest",
  "helmet": "latest",
  "express-rate-limit": "latest"
}
```

Không dùng ORM ở MVP. Viết SQL migration đơn giản để giảm dependency.

---

# 3. Những thứ KHÔNG được dùng trong MVP

Không tự ý thêm:

- PostgreSQL
- Supabase
- Neon
- Redis
- BullMQ
- RabbitMQ
- Cloudflare R2
- AWS S3
- Firebase
- Docker
- Kubernetes
- Next.js
- React SPA
- Agent Node/Python cài trên VPS user
- Database riêng trên VPS user
- Video binary trong SQLite

VPS user chỉ cần:

```text
Ubuntu
SSH
FFmpeg
systemd
```

---

# 4. Kiến trúc tổng thể

```text
                           USER BROWSER
                                │
                                │ HTTPS
                                ▼
                    ┌───────────────────────┐
                    │    NODE.JS / RENDER   │
                    │                       │
                    │ Express + EJS         │
                    │ SQLite                │
                    │ SSH2 / SFTP           │
                    │ Auth                  │
                    └───────────┬───────────┘
                                │
                                │ SSH / SFTP
                                ▼
                    ┌───────────────────────┐
                    │    USER UBUNTU VPS    │
                    │                       │
                    │ /opt/live-manager/    │
                    │ ├── videos/           │
                    │ ├── temp/             │
                    │ └── logs/             │
                    │                       │
                    │ FFmpeg                │
                    │ systemd               │
                    └───────────┬───────────┘
                                │
                                │ RTMPS
                                ▼
                         FACEBOOK LIVE
```

### Trách nhiệm của Render app

Render app chỉ là **control panel**:

- lưu metadata;
- lưu server SSH credential đã mã hóa;
- upload video bằng SFTP;
- gọi SSH command;
- kiểm tra VPS;
- tạo/xóa/start/stop systemd service;
- đọc trạng thái FFmpeg;
- đọc log;
- hiển thị dashboard.

### Trách nhiệm của VPS user

VPS thực hiện:

- lưu video;
- chạy FFmpeg;
- giữ process live;
- gửi RTMPS tới Facebook.

Render **không chạy FFmpeg livestream**.

---

# 5. Authentication

MVP chỉ có **1 tài khoản admin duy nhất**.

Thông tin mặc định:

```text
Username: drnatro@gmail.com
Password: drnatro123123!
```

## Yêu cầu bảo mật

Không lưu password plaintext trong SQLite.

Khi app khởi động lần đầu:

1. đọc `ADMIN_EMAIL` và `ADMIN_PASSWORD` từ environment variables;
2. hash password bằng bcrypt;
3. insert admin nếu chưa tồn tại;
4. các lần deploy sau không overwrite password nếu account đã tồn tại.

Environment mặc định khi deploy Render:

```env
ADMIN_EMAIL=drnatro@gmail.com
ADMIN_PASSWORD=drnatro123123!
```

Session authentication dùng JWT trong cookie:

```text
HttpOnly=true
Secure=true khi production
SameSite=Lax
Expire=7 days
```

Không lưu JWT trong localStorage.

---

# 6. SQLite trên Render

SQLite chỉ lưu metadata, không lưu video.

Database path:

```text
/var/data/live-manager.db
```

Render service phải attach **Persistent Disk** mount tại:

```text
/var/data
```

Không đặt SQLite trong source directory vì filesystem thường của Render là ephemeral.

App MVP chỉ chạy **1 Render instance**.

Không bật horizontal scaling khi đang dùng SQLite.

---

# 7. Cấu trúc source code

Đề xuất:

```text
facebook-live-manager/
│
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── README.md
├── render.yaml                 # optional nhưng nên có
│
├── src/
│   ├── server.js               # entry point Express
│   ├── config.js               # đọc env + constants
│   │
│   ├── db/
│   │   ├── index.js            # SQLite connection
│   │   ├── migrate.js          # chạy migrations
│   │   ├── seed.js             # tạo admin mặc định
│   │   └── migrations/
│   │       └── 001_init.sql
│   │
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── error-handler.js
│   │   └── rate-limit.js
│   │
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── dashboard.routes.js
│   │   ├── servers.routes.js
│   │   ├── videos.routes.js
│   │   ├── projects.routes.js
│   │   └── lives.routes.js
│   │
│   ├── services/
│   │   ├── crypto.service.js
│   │   ├── ssh.service.js
│   │   ├── server.service.js
│   │   ├── storage.service.js
│   │   ├── upload.service.js
│   │   ├── video.service.js
│   │   ├── ffmpeg.service.js
│   │   └── live.service.js
│   │
│   ├── utils/
│   │   ├── shell-escape.js
│   │   ├── format-bytes.js
│   │   ├── validators.js
│   │   └── logger.js
│   │
│   ├── views/
│   │   ├── layout.ejs
│   │   ├── login.ejs
│   │   ├── dashboard.ejs
│   │   ├── servers/
│   │   │   ├── index.ejs
│   │   │   ├── new.ejs
│   │   │   └── detail.ejs
│   │   ├── videos/
│   │   │   └── index.ejs
│   │   └── projects/
│   │       ├── index.ejs
│   │       ├── new.ejs
│   │       └── detail.ejs
│   │
│   └── public/
│       ├── css/app.css
│       └── js/app.js
│
└── scripts/
    └── dev-seed.js
```

Giữ code modular nhưng không over-engineer.

---

# 8. Cấu trúc thư mục trên VPS user

Khi bấm **Setup Server**, app tự tạo:

```text
/opt/live-manager/
├── videos/
├── temp/
└── logs/
```

Video hoàn chỉnh:

```text
/opt/live-manager/videos/{video_uuid}.mp4
```

File đang upload:

```text
/opt/live-manager/temp/{video_uuid}.mp4.part
```

Chỉ rename `.part` sang file thật sau khi upload hoàn tất.

Không lưu video theo original filename để tránh path injection và trùng tên.

Original filename chỉ lưu trong database để hiển thị.

---

# 9. Database schema

## users

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## servers

```sql
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
```

`auth_type`:

```text
password
private_key
```

## videos

```sql
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
```

Video statuses:

```text
uploading
analyzing
ready
needs_optimize
optimizing
error
```

## projects

```sql
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
```

Một project luôn nằm trên một VPS.

Video được chọn cho project phải thuộc cùng `server_id`.

## live_destinations

```sql
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
```

`encrypted_rtmps_url` lưu full URL gồm RTMPS URL + stream key, ví dụ logic:

```text
rtmps://live-api-s.facebook.com:443/rtmp/{STREAM_KEY}
```

Không hiển thị full key ở UI sau khi lưu.

Hiển thị dạng:

```text
rtmps://live-api-s.facebook.com/.../FB-************abcd
```

## activity_logs

```sql
CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Chỉ cần log các hành động quan trọng:

```text
server_connected
server_setup
video_uploaded
video_deleted
project_created
live_started
live_stopped
live_restarted
live_failed
```

---

# 10. Mã hóa SSH credential và Facebook key

Không lưu plaintext:

```text
SSH password
SSH private key
Facebook RTMPS URL / Stream Key
```

Dùng AES-256-GCM.

Environment:

```env
APP_ENCRYPTION_KEY=<64 hex characters / 32 bytes>
```

Mỗi encrypted value cần lưu:

```text
iv
ciphertext
authTag
```

Có thể encode thành một string JSON/base64 trước khi lưu SQLite.

Không log secret.

Không trả secret đầy đủ về browser sau khi đã lưu.

---

# 11. Trang Login

URL:

```text
/login
```

Fields:

```text
Email
Password
Login
```

Sau login redirect:

```text
/dashboard
```

Tất cả route khác `/login` phải yêu cầu auth.

---

# 12. Dashboard

Dashboard phải cực đơn giản.

Hiển thị:

```text
Servers: 2
Projects: 5
Videos: 8
Live now: 6
```

Server cards:

```text
Personal Server
103.xxx.xxx.xxx
● Connected

Disk: 42 GB / 100 GB
Free: 58 GB
CPU: optional
RAM: optional

[Manage]
```

Live cards:

```text
Dr.Natro Việt Nam
Project: Mega Live
Video: mega-live.mp4
● LIVE
Started: 01:35:22

[Stop] [Restart]
```

Refresh status bằng polling mỗi 10–20 giây.

Không cần WebSocket ở MVP.

---

# 13. Servers — tính năng bắt buộc

## Add Server

Form:

```text
Server Name
Host/IP
SSH Port (default 22)
Username (default root)
Authentication:
  - Password
  - Private Key
Password / Private Key
```

Buttons:

```text
[Test Connection]
[Save Server]
```

### Test Connection

SSH vào VPS và chạy:

```bash
uname -a
cat /etc/os-release
command -v ffmpeg || true
df -Pk /opt || df -Pk /
```

Kết quả UI:

```text
✓ SSH Connected
✓ Ubuntu 24.04
✓ Disk detected
⚠ FFmpeg not installed

[Setup Server]
```

---

# 14. Setup Server tự động

User không được yêu cầu tự chạy command Linux.

Backend SSH và chạy tuần tự:

```bash
mkdir -p /opt/live-manager/videos
mkdir -p /opt/live-manager/temp
mkdir -p /opt/live-manager/logs
```

Nếu FFmpeg chưa có:

```bash
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
```

Sau đó verify:

```bash
ffmpeg -version
ffprobe -version
```

Không cài PostgreSQL.

Không cài Node.js trên VPS user.

Không cài Docker.

Không cần deploy backend lên VPS user.

---

# 15. Kiểm tra dung lượng VPS

Đây là **business rule bắt buộc**.

App phải lấy dung lượng thật của VPS bằng SSH, không chỉ dùng cache database.

Command đề xuất:

```bash
df -Pk /opt/live-manager
```

Parse:

```text
total
used
available
percentage
```

Lưu snapshot vào bảng `servers` nhưng trước upload luôn query lại VPS.

---

# 16. Storage Safety Rule

Luôn giữ một phần dung lượng VPS làm vùng an toàn.

Công thức:

```text
reserveBytes = max(5 GB, totalBytes * 10%)
usableFreeBytes = max(0, availableBytes - reserveBytes)
```

Ví dụ VPS:

```text
Total: 100GB
Available: 20GB
Reserve: 10GB
Usable free: 10GB
```

Nếu user chọn video 12GB:

```text
BLOCK UPLOAD
```

Thông báo:

```text
Không đủ dung lượng VPS.

Dung lượng còn trống: 20 GB
Dung lượng dự phòng bắt buộc: 10 GB
Có thể sử dụng: 10 GB
Video cần upload: 12 GB

Vui lòng xóa video cũ hoặc tăng dung lượng VPS.
```

### Storage status UI

```text
0–79% used      Normal
80–89% used     Warning
>=90% used      Critical
```

Khi Critical:

```text
Disable: Upload New Video
```

Không cần disable project nếu project dùng video đã tồn tại.

---

# 17. Rule khi tạo Project

Có hai cách tạo project:

## A. Chọn video đã có

Không tốn thêm dung lượng.

Cho phép tạo nếu:

```text
server connected
video.status = ready
video.server_id = project.server_id
```

## B. Upload video mới khi tạo project

Trước khi upload:

1. browser đọc `file.size`;
2. gửi preflight request với `server_id + file_size`;
3. backend SSH vào VPS chạy `df`;
4. tính `usableFreeBytes`;
5. chỉ trả `allowed=true` nếu đủ dung lượng.

Nếu không đủ thì **không bắt đầu HTTP upload**.

---

# 18. Upload video — yêu cầu cực kỳ quan trọng

Video có thể khoảng 2GB hoặc lớn hơn.

Không được:

```text
Browser → upload toàn bộ vào RAM Node.js ❌
Browser → lưu temp trên Render ❌
Browser → SQLite ❌
```

Phải stream:

```text
Browser
  │ multipart stream
  ▼
Node.js trên Render
  │ stream trực tiếp
  ▼
SSH2 SFTP
  │
  ▼
User VPS
/opt/live-manager/temp/{uuid}.mp4.part
```

Node.js không giữ toàn bộ file trong memory.

Dùng `busboy` hoặc parser hỗ trợ streaming.

### Upload flow

```text
1. Select file
2. Preflight disk check
3. Create video row status=uploading
4. Open SSH/SFTP
5. Create remote .part file
6. Stream HTTP chunks → SFTP write stream
7. Track bytesUploaded
8. Show progress %
9. Upload finished
10. Rename .part → final path
11. Analyze using ffprobe
12. status → ready / needs_optimize
```

Nếu request/upload bị lỗi:

```text
status=error
remove remote .part file
```

### MVP concurrency rule

Chỉ cho phép **1 upload đang chạy trên mỗi VPS**.

Điều này tránh race condition khiến hai upload cùng vượt quá disk capacity.

Nếu server đang upload:

```text
Another upload is in progress on this server.
```

---

# 19. Video Library

Trang:

```text
/videos
```

Filter theo VPS.

Mỗi video hiển thị:

```text
Mega Live 15-08.mp4
2.02 GB
1920 × 1080
30 FPS
H.264
AAC
12:30:15
READY

Used by 3 live destinations

[Use in Project]
[Analyze]
[Delete]
```

Không duplicate video khi nhiều live dùng chung.

---

# 20. Analyze video bằng ffprobe

Sau upload chạy remote command:

```bash
ffprobe -v quiet \
-print_format json \
-show_format \
-show_streams \
"/opt/live-manager/videos/VIDEO.mp4"
```

Parse:

```text
codec_video
codec_audio
width
height
fps
duration
bitrate
```

### Video ready tối thiểu

Ưu tiên:

```text
Video codec: h264
Pixel format: yuv420p
Resolution: <= 1920x1080
FPS: <= 30 cho preset MVP
Audio: AAC nếu có audio
```

Nếu compatible:

```text
status=ready
```

Nếu chưa compatible:

```text
status=needs_optimize
```

---

# 21. Optimize video

Không tự encode trước khi user biết.

UI:

```text
Video chưa tối ưu để stream ổn định.
[Optimize for Facebook]
```

Trước khi optimize, query dung lượng lại.

Phải đảm bảo đủ chỗ tạo file mới.

Command cơ bản:

```bash
ffmpeg -y \
-i INPUT \
-c:v libx264 \
-preset veryfast \
-profile:v high \
-level 4.1 \
-pix_fmt yuv420p \
-r 30 \
-g 60 \
-keyint_min 60 \
-b:v 4500k \
-maxrate 4500k \
-bufsize 9000k \
-c:a aac \
-b:a 128k \
-ar 44100 \
OUTPUT
```

Optimization là remote job trên VPS.

Không giữ HTTP request chờ toàn bộ encode.

Start process bằng systemd transient unit hoặc background process, sau đó UI poll trạng thái.

MVP có thể dùng systemd unit riêng:

```text
live-manager-optimize-{videoId}.service
```

Sau khi thành công:

```text
replace video.remote_path bằng optimized file
status=ready
```

Có thể xóa original sau khi optimized file verify thành công.

---

# 22. Project model

Một project gồm:

```text
Project Name
Server
Current Video
Many Live Destinations
```

Ví dụ:

```text
Project: Dr.Natro Mega Live
Server: Personal VPS
Video: mega-live.mp4

Destinations:
1. Dr.Natro Việt Nam
2. Dr.Natro Hợp Tác
3. Natus Clean
```

---

# 23. Project Detail UI

Ví dụ:

```text
DR.NATRO MEGA LIVE

Server
Personal VPS ● Online
Disk 42 / 100 GB

Current Video
mega-live.mp4
2.02 GB · 1080p · H264 · READY

[Change Video]

-------------------------------------------------
LIVE DESTINATIONS

Dr.Natro Việt Nam
● LIVE
01:45:12
[Stop] [Restart] [Logs]

Dr.Natro Hợp Tác
○ STOPPED
[Start] [Edit] [Delete]

Natus Clean
○ STOPPED
[Start] [Edit] [Delete]

[+ Add Facebook Live]

[Start All] [Stop All]
```

---

# 24. Add Facebook Live Destination

Fields:

```text
Name
RTMPS URL / Stream URL
Stream Key
```

Hoặc cho phép paste full RTMPS URL.

Backend normalize thành:

```text
full_rtmps_url
```

Ví dụ:

```text
rtmps://live-api-s.facebook.com:443/rtmp/STREAM_KEY
```

Sau khi save chỉ hiển thị masked key.

Không log full URL.

---

# 25. Start Live

Khi bấm Start:

Backend phải kiểm tra:

```text
✓ server SSH connected
✓ FFmpeg installed
✓ project has video
✓ video exists remotely
✓ video.status=ready
✓ destination RTMPS configured
✓ unit not already running
```

Sau đó tạo systemd service trên VPS.

Unit name:

```text
live-manager-{destinationId}.service
```

Ví dụ service:

```ini
[Unit]
Description=Facebook Live Manager Destination 123
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ffmpeg -re -stream_loop -1 -i /opt/live-manager/videos/VIDEO.mp4 -c copy -f flv RTMPS_FULL_URL
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

File service:

```text
/etc/systemd/system/live-manager-{destinationId}.service
```

Sau tạo:

```bash
systemctl daemon-reload
systemctl enable --now live-manager-{destinationId}.service
```

### Security

Không lấy user input làm tên systemd unit.

Unit name chỉ dùng numeric ID từ database.

Video path dùng UUID do backend tạo.

Shell escape tất cả argument.

---

# 26. Stop Live

```bash
systemctl stop live-manager-{destinationId}.service
```

Update:

```text
status=stopped
stopped_at=now
```

Không xóa destination.

---

# 27. Restart Live

```bash
systemctl restart live-manager-{destinationId}.service
```

UI hiển thị trạng thái:

```text
RESTARTING
```

Sau đó poll `systemctl is-active`.

---

# 28. Delete Live Destination

Flow:

```text
1. stop unit if active
2. disable unit
3. delete service file
4. systemctl daemon-reload
5. delete database row
```

Commands:

```bash
systemctl disable --now live-manager-ID.service || true
rm -f /etc/systemd/system/live-manager-ID.service
systemctl daemon-reload
```

---

# 29. Live Status

Không tin hoàn toàn vào status trong database.

Khi mở Project Detail, backend SSH kiểm tra:

```bash
systemctl is-active live-manager-ID.service
```

Map:

```text
active      → live
inactive    → stopped
failed      → error
activating  → starting
```

Database chỉ là snapshot/cache.

---

# 30. Live Logs

Button:

```text
[Logs]
```

Backend SSH chạy:

```bash
journalctl -u live-manager-ID.service -n 100 --no-pager
```

Không trả quá nhiều log.

Mask RTMPS URL / Stream Key trước khi trả về browser.

UI:

```text
Last 100 lines

frame=...
time=...
speed=1.00x
...
```

---

# 31. Một video chạy nhiều live

Đây là requirement bắt buộc.

Không copy file.

Nếu project có:

```text
video_id=5
```

và 4 destination:

```text
Destination 11
Destination 12
Destination 13
Destination 14
```

VPS chạy 4 process FFmpeg cùng đọc:

```text
/opt/live-manager/videos/video-uuid.mp4
```

Không tạo:

```text
video-copy-1.mp4
video-copy-2.mp4
video-copy-3.mp4
```

---

# 32. Change / Update Video

User bấm:

```text
[Change Video]
```

Có hai lựa chọn:

```text
Choose Existing Video
Upload New Video
```

Nếu upload mới thì chạy storage preflight trước.

Sau khi video mới `READY`:

```text
Set as Project Video
```

Nếu project có live đang chạy, UI hỏi:

```text
3 live destinations are currently running.

○ Save video only. Apply next time live restarts.
● Save and restart all live destinations now.
```

Default:

```text
Save and restart all live destinations now
```

Flow:

```text
1. update project.video_id
2. rewrite systemd service files using new path
3. systemctl daemon-reload
4. restart active destinations
```

Không cần user chỉnh FFmpeg command.

---

# 33. Delete Video Safety

Không cho xóa video nếu:

```text
video đang được project sử dụng
OR
video có live đang active
```

Thông báo:

```text
Video đang được sử dụng bởi:
- Project A
- Project B

Hãy đổi video cho các project trước khi xóa.
```

Nếu không được sử dụng:

```bash
rm -f REMOTE_PATH
```

Sau đó delete DB record.

Sau delete refresh disk information.

---

# 34. Server storage UI

Ở mọi Server Detail hiển thị:

```text
Storage
██████████░░░░░░
42 GB / 100 GB
58 GB free

Safe upload capacity: 48 GB
```

`Safe upload capacity` khác `Free` vì phải trừ reserve.

Ví dụ:

```text
Free = 58GB
Reserve = 10GB
Safe upload = 48GB
```

Buttons:

```text
[Refresh Storage]
[Manage Videos]
```

---

# 35. Server health

MVP chỉ cần:

```text
SSH status
Disk
FFmpeg installed
OS
```

Optional nhưng dễ thêm:

```bash
free -m
uptime
nproc
```

Hiển thị:

```text
CPU cores: 4
RAM: 1.2 / 8GB
Load: 0.42
```

Không cần realtime monitoring phức tạp.

---

# 36. API routes đề xuất

Có thể dùng HTML forms + JSON API kết hợp.

## Auth

```text
GET  /login
POST /login
POST /logout
```

## Dashboard

```text
GET /dashboard
GET /api/dashboard/status
```

## Servers

```text
GET  /servers
GET  /servers/new
POST /servers
GET  /servers/:id
POST /servers/:id/test
POST /servers/:id/setup
POST /servers/:id/storage/refresh
PUT  /servers/:id
DELETE /servers/:id
```

## Videos

```text
GET    /videos
POST   /api/videos/preflight
POST   /api/videos/upload
POST   /api/videos/:id/analyze
POST   /api/videos/:id/optimize
GET    /api/videos/:id/optimize-status
DELETE /api/videos/:id
```

## Projects

```text
GET  /projects
GET  /projects/new
POST /projects
GET  /projects/:id
PUT  /projects/:id
POST /projects/:id/change-video
DELETE /projects/:id
```

## Live destinations

```text
POST   /projects/:id/lives
PUT    /lives/:id
DELETE /lives/:id

POST /lives/:id/start
POST /lives/:id/stop
POST /lives/:id/restart
GET  /lives/:id/status
GET  /lives/:id/logs

POST /projects/:id/start-all
POST /projects/:id/stop-all
```

---

# 37. SSH service interface

`ssh.service.js` nên expose API nội bộ đơn giản:

```js
connect(server)
exec(server, command)
execMany(server, commands)
createSftp(server)
testConnection(server)
```

Tất cả SSH connection:

```text
open
execute
close
```

Không giữ SSH connection lâu dài giữa các HTTP requests.

Exception: upload SFTP giữ connection đến khi upload xong.

---

# 38. Upload progress

MVP không cần WebSocket.

Browser đã biết:

```text
file.size
```

Dùng `XMLHttpRequest.upload.onprogress` hoặc client upload progress API để hiển thị:

```text
Uploading 46%
943 MB / 2.02 GB
```

Nút:

```text
[Cancel Upload]
```

Khi cancel:

```text
abort HTTP request
close SFTP stream
remove remote .part file
status=error/cancelled
```

Có thể thêm `cancelled` vào video status.

---

# 39. Error handling cần có

## SSH unavailable

```text
Cannot connect to VPS.
Check IP, port, username and SSH credentials.
```

## Disk insufficient

Block upload trước khi gửi file.

## Upload interrupted

Xóa `.part`.

## FFmpeg missing

Show:

```text
Server setup required.
```

## Video missing from VPS

Set:

```text
video.status=error
```

Không start live.

## Facebook connection failure

Show systemd/FFmpeg status + masked log.

## Render restart while live

Không ảnh hưởng live đang chạy vì FFmpeg nằm trên user VPS và được systemd quản lý.

Đây là behavior quan trọng.

---

# 40. Security requirements

Bắt buộc:

1. bcrypt password hash.
2. JWT HttpOnly cookie.
3. SSH credentials encrypted AES-256-GCM.
4. Facebook stream keys encrypted AES-256-GCM.
5. Mask secrets trong UI/log.
6. Không hardcode secret trong Git.
7. Validate IP/hostname.
8. Validate port 1–65535.
9. Validate file extensions.
10. Generate own UUID filename.
11. Không nối user-provided string trực tiếp vào shell command.
12. Shell escape arguments.
13. systemd unit dùng DB numeric IDs.
14. `helmet()`.
15. rate limit login.
16. Upload route chỉ cho authenticated admin.
17. Không expose SQLite file qua static route.

---

# 41. Environment variables

`.env.example`:

```env
NODE_ENV=development
PORT=3000

DB_PATH=./data/live-manager.db

ADMIN_EMAIL=drnatro@gmail.com
ADMIN_PASSWORD=drnatro123123!

JWT_SECRET=change-me-to-a-long-random-secret
APP_ENCRYPTION_KEY=64_HEX_CHARACTERS

STORAGE_RESERVE_PERCENT=10
STORAGE_RESERVE_MIN_GB=5
MAX_UPLOAD_GB=10
```

Production Render:

```env
NODE_ENV=production
DB_PATH=/var/data/live-manager.db
ADMIN_EMAIL=drnatro@gmail.com
ADMIN_PASSWORD=drnatro123123!
JWT_SECRET=<random>
APP_ENCRYPTION_KEY=<64 hex>
STORAGE_RESERVE_PERCENT=10
STORAGE_RESERVE_MIN_GB=5
MAX_UPLOAD_GB=10
```

---

# 42. Render deployment

Deploy dạng:

```text
Render Web Service
```

Không dùng Render Static Site.

### Build Command

```bash
npm ci
```

### Start Command

```bash
npm start
```

Express phải bind:

```js
app.listen(process.env.PORT || 3000, '0.0.0.0')
```

### Persistent Disk

Attach Render Persistent Disk:

```text
Mount path: /var/data
```

Dung lượng 1GB là đủ cho MVP vì chỉ lưu SQLite metadata.

**Không lưu video trên Render disk.**

### Instance count

```text
1 instance only
```

Không scale ngang khi dùng SQLite.

### Health check

Route:

```text
GET /health
```

Response:

```json
{
  "status": "ok"
}
```

---

# 43. Render-specific constraint

Render filesystem ngoài Persistent Disk là ephemeral.

Do đó mọi dữ liệu cần tồn tại phải nằm ở:

```text
/var/data
```

SQLite bắt buộc:

```text
/var/data/live-manager.db
```

Video không đi vào `/var/data`; video nằm trên VPS user.

Render Persistent Disk gắn với một service instance, vì vậy app SQLite MVP chỉ chạy một instance.

---

# 44. Video upload qua Render

Video 2GB có thể upload theo HTTP request dài, nhưng implementation phải streaming hoàn toàn.

Không được dùng:

```js
express.raw({ limit: '3gb' })
```

Không được Buffer toàn bộ file.

Không được dùng multer memory storage.

Ưu tiên:

```text
busboy stream
     ↓
ssh2 SFTP write stream
```

Do request lớn có thể bị gián đoạn bởi mạng, MVP phải hỗ trợ:

```text
progress
cancel
cleanup .part
retry bằng upload lại
```

Resumable/chunked upload là V2, không bắt buộc MVP.

---

# 45. Không tạo Project khi nào?

Nút `Create Project` không nhất thiết phải block chỉ vì disk gần đầy nếu user chọn video đã tồn tại.

Business rule đúng:

### Cho phép

```text
Create Project + Existing Video
```

vì không tốn storage mới.

### Block

```text
Create Project + Upload New Video
```

khi:

```text
fileSize > safeUploadCapacity
```

UI phải giải thích rõ lý do.

---

# 46. Server deletion safety

Không cho delete Server khỏi database nếu:

```text
server có live active
```

Nếu không có live active, confirm:

```text
Removing server only removes it from Live Manager.
It does not automatically delete VPS files unless explicitly selected.
```

MVP mặc định **không xóa video trên VPS khi remove Server**.

---

# 47. Project deletion safety

Khi delete Project:

```text
1. Stop all active live destinations
2. Remove their systemd units
3. Delete destinations DB rows
4. Delete project row
5. Keep shared video file by default
```

Không tự xóa video.

---

# 48. Simple UI navigation

Sidebar:

```text
Dashboard
Servers
Videos
Projects
Logout
```

Không cần settings phức tạp.

---

# 49. Dashboard trạng thái màu

Dùng đơn giản:

```text
Green   = Running / Connected / Ready
Yellow  = Warning / Processing
Red     = Error / Critical Disk
Gray    = Stopped / Unknown
```

Không cần chart ở MVP.

---

# 50. MVP user journey hoàn chỉnh

## Lần đầu

```text
Login
 ↓
Servers
 ↓
Add VPS
 ↓
Test Connection
 ↓
Setup Server
 ↓
READY
```

## Tạo live

```text
Create Project
 ↓
Select VPS
 ↓
Upload Video
 ↓
Storage Preflight
 ↓
SFTP Upload
 ↓
FFprobe Analyze
 ↓
READY
 ↓
Add Facebook Live Destination
 ↓
Paste URL + Stream Key
 ↓
START LIVE
 ↓
systemd starts FFmpeg
 ↓
Facebook Live Producer receives video
```

## Thêm nhiều fanpage

```text
Project Detail
 ↓
Add Live Destination
 ↓
Page B
 ↓
Add Live Destination
 ↓
Page C
 ↓
Start All
```

Một file video duy nhất được đọc bởi nhiều FFmpeg processes.

---

# 51. Phase 1 — Build order

AI nên implement theo thứ tự:

### Step 1

```text
Express app
EJS layout
SQLite migration
Admin seed
Login/logout
```

### Step 2

```text
Server CRUD
Encrypt credentials
SSH test
Storage query
```

### Step 3

```text
Setup Server
FFmpeg detection/install
Remote directory creation
```

### Step 4

```text
Video library
Storage preflight
Streaming SFTP upload
Progress
ffprobe
```

### Step 5

```text
Project CRUD
Select current video
```

### Step 6

```text
Live destination CRUD
Create systemd units
Start/Stop/Restart
Status
Logs
```

### Step 7

```text
Change video
Restart active destinations
Storage/delete safety
Dashboard polish
```

### Step 8

```text
Render deployment
Persistent disk
Production security check
```

---

# 52. Acceptance Criteria

MVP được xem là hoàn thành khi pass toàn bộ:

## Auth

- [ ] Login được bằng `drnatro@gmail.com` / `drnatro123123!`.
- [ ] Password trong SQLite là hash, không plaintext.
- [ ] Không login thì không truy cập dashboard.

## Server

- [ ] Add được VPS Ubuntu bằng IP/port/user/password.
- [ ] Test SSH connection được.
- [ ] Hiển thị total/used/free disk.
- [ ] Setup tự cài FFmpeg nếu thiếu.
- [ ] Setup tự tạo `/opt/live-manager/...`.

## Storage

- [ ] Hiển thị storage bar.
- [ ] Tính Safe Upload Capacity.
- [ ] Block upload nếu không đủ dung lượng.
- [ ] Không cho hai upload cùng lúc trên cùng VPS.
- [ ] Partial upload được cleanup.

## Video

- [ ] Upload video ~2GB mà Node không giữ cả file trong RAM.
- [ ] Video được lưu trực tiếp trên VPS.
- [ ] ffprobe đọc metadata.
- [ ] Video Library hiển thị dung lượng và trạng thái.
- [ ] Một video không bị duplicate khi nhiều live dùng chung.

## Project

- [ ] Project chọn một VPS.
- [ ] Project chọn một current video.
- [ ] Project có nhiều Facebook destinations.
- [ ] Đổi video mà không sửa FFmpeg command thủ công.

## Live

- [ ] Start live tạo/chạy systemd FFmpeg unit.
- [ ] Stop live dừng unit.
- [ ] Restart live hoạt động.
- [ ] Start All hoạt động.
- [ ] Stop All hoạt động.
- [ ] Hiển thị live status thực tế từ VPS.
- [ ] Xem được 100 dòng logs gần nhất.
- [ ] Stream Key không xuất hiện đầy đủ trong logs/UI.

## Resilience

- [ ] Đóng browser không làm live dừng.
- [ ] Render restart không làm live trên VPS dừng.
- [ ] SSH request kết thúc không làm FFmpeg dừng.
- [ ] systemd restart FFmpeg khi process crash do lỗi tạm thời.

## Render

- [ ] App deploy được bằng Render Web Service.
- [ ] SQLite nằm tại `/var/data/live-manager.db`.
- [ ] Render service có Persistent Disk.
- [ ] App chạy 1 instance.
- [ ] `/health` trả status 200.

---

# 53. Out of Scope — KHÔNG làm ở MVP

Không làm các tính năng sau cho đến khi MVP ổn định:

```text
Facebook Graph API login
Tự tạo Facebook Live post
Facebook comments/chat
Auto schedule
Auto restart Facebook session sau giới hạn platform
Playlist nhiều video
Seamless switch không gián đoạn
YouTube/TikTok/Shopee
Multiple users
Role/permission
Subscription/payment
Object storage
PostgreSQL
Redis
Background queue service
Mobile app
Notifications Telegram/Zalo
Analytics phức tạp
Bandwidth billing
Resumable upload
```

---

# 54. Phase 2 có thể bổ sung sau

Sau khi MVP chạy ổn mới cân nhắc:

```text
Resumable/chunk upload
Playlist
Schedule
Seamless video switching
Live duration alerts
CPU/RAM/network monitoring
Auto cleanup old videos
Multi-platform RTMP
Multiple users
Permissions
Managed storage
PostgreSQL nếu cần scale nhiều app instances
```

---

# 55. Nguyên tắc quan trọng cho AI code agent

**AI PHẢI tuân thủ:**

1. Build MVP trước, không over-engineer.
2. Không thay SQLite bằng PostgreSQL.
3. Không thêm Redis/queue nếu chưa được yêu cầu.
4. Không lưu video trên Render.
5. Không lưu video trong database.
6. Video phải stream trực tiếp từ browser → Node → SFTP → VPS.
7. Không Buffer video 2GB vào RAM.
8. Luôn kiểm tra VPS disk trước upload.
9. Một video phải support nhiều live.
10. Live phải sống độc lập với browser và Render request.
11. Dùng systemd để giữ FFmpeg process trên VPS.
12. Không expose Stream Key.
13. Không expose SSH password/private key.
14. Không bắt user chạy command Linux thủ công.
15. UI phải ưu tiên thao tác bằng button.
16. Nếu một feature không nằm trong spec, không tự ý thêm stack mới để giải quyết.

---

# 56. Kết quả UI cuối cùng mong muốn

Người dùng bình thường chỉ cần hiểu workflow sau:

```text
LOGIN
 ↓
ADD VPS
 ↓
SETUP SERVER
 ↓
CREATE PROJECT
 ↓
UPLOAD VIDEO
 ↓
ADD FACEBOOK URL + KEY
 ↓
START LIVE
```

Sau này thay video:

```text
PROJECT
 ↓
CHANGE VIDEO
 ↓
UPLOAD
 ↓
APPLY & RESTART
```

Thêm fanpage:

```text
PROJECT
 ↓
ADD LIVE
 ↓
URL + KEY
 ↓
START
```

Không cần biết:

```text
FFmpeg command
Linux command
systemd
SQLite
SSH CLI
PostgreSQL
```

---

# 57. Definition of Done

Sản phẩm đạt yêu cầu khi một người chỉ biết mua VPS có thể:

1. lấy IP + SSH account từ nhà cung cấp VPS;
2. nhập vào Facebook Live Manager;
3. bấm Setup;
4. upload video;
5. paste Facebook RTMPS URL + Stream Key;
6. bấm Start;
7. thấy video xuất hiện trong Facebook Live Producer;
8. quản lý nhiều fanpage từ cùng một Project;
9. thay video mà không phải SSH thủ công;
10. không thể upload làm đầy VPS do app luôn có Storage Safety Rule.

Đây là phạm vi MVP. Không mở rộng stack hoặc tính năng ngoài phạm vi cho đến khi toàn bộ Acceptance Criteria ở trên đã pass.
