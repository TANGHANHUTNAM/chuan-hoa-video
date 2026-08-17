#!/bin/bash
#
# Cài Facebook Live Manager (bảng điều khiển) lên chính VPS Ubuntu/Debian.
#
# Cách dùng, chạy bằng root trên VPS:
#     bash vps-install.sh
#
# Vì sao nên chạy panel trên VPS thay vì trên Render:
#   - không tốn thêm tiền, và có ổ đĩa thật để lưu SQLite
#   - video đi từ trình duyệt tới VPS một chặng duy nhất, không qua trung gian,
#     nên không tốn băng thông chịu phí của bên thứ ba
#   - VPS đã có FFmpeg và systemd sẵn
#
# Script này idempotent: chạy lại nhiều lần không sao, và KHÔNG BAO GIỜ ghi đè
# file .env đang có (đổi APP_ENCRYPTION_KEY sẽ làm mọi mật khẩu SSH và stream key
# đã lưu không giải mã được nữa).

set -euo pipefail

APP_USER="livemanager"
APP_DIR="/opt/live-manager-panel"   # tách khỏi /opt/live-manager (nơi chứa video)
DATA_DIR="/var/lib/live-manager"
SERVICE="live-manager-panel"
PORT="${PORT:-3000}"
NODE_MAJOR=22

log()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mLỖI: %s\033[0m\n\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Cần chạy bằng root. Thử: sudo bash $0"

command -v apt-get >/dev/null 2>&1 || die "Script này dành cho Ubuntu/Debian."

# --- Node.js ---------------------------------------------------------------
log "Kiểm tra Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$current" -ge 20 ]]; then
    echo "    Đã có Node $(node -v)"
    need_node=0
  else
    warn "Node $(node -v) quá cũ, cần >= 20. Sẽ cài bản mới."
  fi
fi

if [[ "$need_node" -eq 1 ]]; then
  log "Cài Node.js ${NODE_MAJOR}.x"
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=180 update -qq
  apt-get -o DPkg::Lock::Timeout=180 install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod a+r /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get -o DPkg::Lock::Timeout=180 update -qq
  apt-get -o DPkg::Lock::Timeout=180 install -y -qq nodejs
  echo "    Đã cài Node $(node -v)"
fi

# --- Tài khoản chạy app ----------------------------------------------------
# Panel không cần quyền root: nó chỉ SSH ra ngoài. Chạy bằng user riêng để nếu
# app bị lỗi thì cũng không ảnh hưởng phần còn lại của máy.
log "Chuẩn bị tài khoản $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
  echo "    Đã tạo user $APP_USER"
else
  echo "    User $APP_USER đã có"
fi

# --- Mã nguồn --------------------------------------------------------------
log "Cài mã nguồn vào $APP_DIR"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$SOURCE_DIR/package.json" ]] || die "Không tìm thấy package.json. Hãy giải nén cả thư mục app rồi chạy deploy/vps-install.sh từ trong đó."

mkdir -p "$APP_DIR"
# Loại các thứ không nên mang lên server. runtime/ là Node cho Windows nên vô
# dụng ở đây; .env và data/ là của máy khác, mang lên là lẫn dữ liệu.
tar -C "$SOURCE_DIR" \
    --exclude=.git --exclude=node_modules --exclude=runtime \
    --exclude=dist --exclude=data --exclude=.env \
    -cf - . | tar -C "$APP_DIR" -xf -

cd "$APP_DIR"

log "Cài thư viện (npm ci)"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

# --- Cấu hình --------------------------------------------------------------
log "Cấu hình"
mkdir -p "$DATA_DIR"

if [[ -f "$APP_DIR/.env" ]]; then
  warn ".env đã tồn tại — giữ nguyên, không ghi đè."
  warn "(Đổi APP_ENCRYPTION_KEY sẽ mất toàn bộ mật khẩu SSH và stream key đã lưu.)"
else
  JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  ENC_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  ADMIN_PASS="$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')"

  cat > "$APP_DIR/.env" <<ENVFILE
NODE_ENV=production
PORT=${PORT}

DB_PATH=${DATA_DIR}/live-manager.db

ADMIN_EMAIL=admin@localhost
ADMIN_PASSWORD=${ADMIN_PASS}

JWT_SECRET=${JWT_SECRET}
APP_ENCRYPTION_KEY=${ENC_KEY}

STORAGE_RESERVE_PERCENT=10
STORAGE_RESERVE_MIN_GB=5
MAX_UPLOAD_GB=10

# Panel chạy ngay trên VPS nên upload không đi qua bên thứ ba nào.
# Đặt cao để tắt cảnh báo băng thông.
RENDER_BANDWIDTH_BUDGET_GB=100000
ENVFILE

  echo "    Đã tạo .env với khoá mới"
  NEW_LOGIN=1
fi

chmod 600 "$APP_DIR/.env"

# ProtectSystem=strict bên dưới khiến mọi thứ read-only trừ ReadWritePaths.
# Nếu .env có sẵn từ trước và trỏ DB_PATH sang chỗ khác (ví dụ ./data), app sẽ
# crash với lỗi EROFS rất khó hiểu. Nên đọc DB_PATH thật rồi mở quyền ghi đúng
# thư mục đó.
DB_PATH_CONF="$(grep -E '^DB_PATH=' "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"' | xargs || true)"
[[ -n "$DB_PATH_CONF" ]] || DB_PATH_CONF="${DATA_DIR}/live-manager.db"
case "$DB_PATH_CONF" in
  /*) DB_ABS="$DB_PATH_CONF" ;;
  *)  DB_ABS="${APP_DIR}/${DB_PATH_CONF#./}" ;;
esac
DB_DIR="$(dirname "$DB_ABS")"
mkdir -p "$DB_DIR"
echo "    Database: $DB_ABS"

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR" "$DB_DIR"

# --- systemd ---------------------------------------------------------------
log "Tạo service systemd"
cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=Facebook Live Manager control panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/src/server.js
Restart=always
RestartSec=5

# Chỉ nghe localhost là đủ: đưa ra internet bằng Cloudflare Tunnel hoặc
# reverse proxy, để không phải mở port ra ngoài.
Environment=NODE_ENV=production

# Siết quyền: panel chỉ cần ghi vào thư mục database (kể cả file -wal và -shm
# mà SQLite tạo cùng chỗ). Mọi nơi khác read-only.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DB_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE}"

sleep 2
if ! systemctl is-active --quiet "${SERVICE}"; then
  echo
  journalctl -u "${SERVICE}" -n 25 --no-pager || true
  die "Service không chạy được. Xem log phía trên."
fi

# --- Xong ------------------------------------------------------------------
log "Đã cài xong"
cat <<DONE

    Panel đang chạy tại:  http://127.0.0.1:${PORT}
    Service            :  ${SERVICE}
    Mã nguồn           :  ${APP_DIR}
    Database           :  ${DATA_DIR}/live-manager.db

DONE

if [[ "${NEW_LOGIN:-0}" -eq 1 ]]; then
  echo "    Đăng nhập:"
  grep -E '^ADMIN_(EMAIL|PASSWORD)=' "$APP_DIR/.env" | sed 's/^/      /'
  echo
  echo "    Hãy lưu lại mật khẩu trên. Xem lại bất cứ lúc nào bằng:"
  echo "      grep ADMIN_ ${APP_DIR}/.env"
  echo
fi

cat <<'NEXT'
    ĐƯA RA INTERNET (chọn một cách)

    1) Test nhanh, không cần domain, miễn phí:

         cloudflared tunnel --url http://localhost:3000

       In ra một URL https://...trycloudflare.com dùng được ngay.
       Tắt lệnh là hết. Cài cloudflared:

         curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
           | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
         echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
           > /etc/apt/sources.list.d/cloudflared.list
         apt-get update && apt-get install -y cloudflared

    2) Chạy 24/7 với domain của bạn:

         cloudflared tunnel login
         cloudflared tunnel create live-manager
         cloudflared tunnel route dns live-manager panel.tenmien.com
         cloudflared service install

       Trỏ tunnel về http://localhost:3000 trong file config của cloudflared.

    LỆNH HAY DÙNG

      systemctl status live-manager-panel      # xem trạng thái
      systemctl restart live-manager-panel     # khởi động lại
      journalctl -u live-manager-panel -f      # xem log trực tiếp

    Lưu ý: buổi live do systemd trên VPS quản lý, nên restart panel
    KHÔNG làm gián đoạn live đang phát.

NEXT
