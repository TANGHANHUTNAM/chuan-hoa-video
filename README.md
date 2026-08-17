# Facebook Live Manager

Phát Facebook Live 24/7 từ video đặt trên VPS Ubuntu của bạn, điều khiển qua web.

Bạn chỉ cần: **kết nối VPS → tạo project → chọn video → dán Stream key → bấm Phát.**
Không cần biết Linux, FFmpeg, systemd hay SSH.

---

## Cách hoạt động

```
Trình duyệt ──HTTPS──▶ App (Render)  ──SSH/SFTP──▶ VPS Ubuntu của bạn ──RTMPS──▶ Facebook
                       control panel                FFmpeg + systemd
```

App **không** phát video. Nó chỉ điều khiển VPS: cài đặt, tải video, tạo và quản lý
systemd unit. Vì FFmpeg chạy trên VPS dưới systemd:

- đóng trình duyệt → live vẫn chạy;
- app trên Render restart → live vẫn chạy;
- FFmpeg crash → systemd tự bật lại.

Một file video phát được cho nhiều fanpage cùng lúc, không nhân bản file.

---

## Chạy trên máy — cách dễ nhất

Bấm đôi vào **`Bat dau mo app quan ly live facebook.cmd`**.

File này tự làm hết: kiểm tra Node.js, cài thư viện ở lần đầu, tạo `.env` nếu chưa có,
bật server rồi mở trình duyệt. Đóng cửa sổ đen đó là tắt app.

Nếu Node.js chưa được cài, file sẽ tự mở trang tải và hướng dẫn.

> Không phải file `.exe` thật. Đóng gói thành một `.exe` duy nhất không đáng làm ở đây:
> `better-sqlite3` là native addon và app cần `src/views` + `src/public` nằm trên đĩa.
> Về trải nghiệm thì file `.cmd` này giống hệt — bấm đôi là chạy.
>
> Muốn có icon như app thật: chuột phải file `.cmd` → *Create shortcut* → chuột phải
> shortcut → *Properties* → *Change Icon*.

### Hoặc chạy bằng lệnh

```bash
npm install && npm run setup && npm start
```

Mở http://localhost:3000 và đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env`.

`npm run setup` tạo `.env` với `JWT_SECRET` và `APP_ENCRYPTION_KEY` sinh mới. Lệnh này
**không ghi đè** `.env` đã có — nên key và mật khẩu hiện tại của bạn được giữ nguyên.

> `APP_ENCRYPTION_KEY` phải đúng **64 ký tự hex**. Đổi khoá này sẽ làm mọi mật khẩu SSH
> và Stream key đã lưu không giải mã được nữa.

---

## Đóng gói để đưa cho người khác

```bash
npm run package
```

Tạo `dist/facebook-live-manager.zip`. Người nhận giải nén rồi **bấm đôi vào
`Bat dau mo app quan ly live facebook.cmd`** — không cần gõ lệnh gì. Trong zip có sẵn file
`BAT-DAU-TU-DAY.txt` hướng dẫn đúng một bước đó.

Nếu Windows chặn file vừa tải từ mạng: chuột phải file `.cmd` → *Properties* →
tích *Unblock* → OK.

### Bản không cần cài gì (khuyến nghị khi đưa người không rành tech)

```bash
npm run bundle-runtime
```

Tải Node.js chính thức về `runtime/` (đã đối chiếu SHA256 với `SHASUMS256.txt` của
nodejs.org). Sau đó `npm run package` sẽ **tự kèm luôn `runtime/` và `node_modules/`**.

| | Không kèm runtime | Kèm runtime |
|---|---|---|
| Dung lượng zip | ~0.2 MB | ~39 MB |
| Người nhận cần cài Node.js | Có | **Không** |
| Lần mở đầu cần mạng | Có (tải thư viện) | **Không** |
| Thời gian mở lần đầu | 1–2 phút | vài giây |

Phiên bản Node được ghim đúng bằng phiên bản trên máy bạn, vì `better-sqlite3` là
native addon biên dịch theo đúng một ABI — ghim sai phiên bản thì runtime sẽ không mở
được database. Script kiểm tra điều này và báo lỗi thay vì đóng gói một bản hỏng.

### Đừng tự nén thư mục bằng tay

Nén cả thư mục (chuột phải → Send to → Compressed folder) sẽ **kèm theo**:

| File | Bên trong có gì |
|---|---|
| `.env` | `APP_ENCRYPTION_KEY` — khoá giải mã mọi bí mật đã lưu |
| `data/live-manager.db` | SSH private key của VPS + Facebook Stream key (đã mã hoá) |

Gửi cả hai là **trao quyền root vào VPS của bạn** cho người nhận: database chứa key đã
mã hoá, còn `.env` chứa đúng khoá để giải mã nó.

`npm run package` loại bỏ `.env`, `data/`, `node_modules/`, `dist/`, rồi **đọc lại toàn
bộ file đã đóng gói** và đối chiếu với giá trị bí mật thật trong `.env` của bạn. Nếu tìm
thấy bất kỳ giá trị nào, script **dừng và không tạo file zip**.

`node_modules/` bị loại bỏ không chỉ vì dung lượng: `better-sqlite3` là native addon
biên dịch riêng cho từng hệ điều hành và phiên bản Node, nên copy sang máy khác sẽ lỗi.
Người nhận chạy `npm install` là xong.

### Nếu dùng Git thay vì zip

`.gitignore` đã chặn `.env`, `data/` và `dist/`. Kiểm tra trước lần commit đầu:

```bash
git status --short
```

Không được thấy `.env` hay `data/` trong danh sách.

### Clone về máy khác thì có sẵn dữ liệu không

Không. Repo chỉ có **code**; dữ liệu nằm trong `data/app.db` và file đó bị `.gitignore`
chặn (nó chứa mật khẩu VPS và Stream key đã mã hoá). Sau khi clone:

```bash
npm install && npm run setup && npm start
```

rồi copy `.env` cũ vào — app mở lên nhưng danh sách VPS / project / video **trống**.

Muốn dựng lại: bấm **Lấy dữ liệu từ Sheet về**. Nút này nằm ở **hai chỗ**, vì lúc mới cài
thì trang Tổng quan chưa mở được (chưa có VPS nào, app đẩy thẳng sang màn hình kết nối VPS):

- **Màn hình đầu tiên** (*Chào mừng bạn — kết nối VPS*): hiện sẵn khi máy có `.env` nối
  với Sheet mà danh mục còn trống. Đây là chỗ bạn sẽ thấy trước.
- **Trang Tổng quan → thẻ Google Sheet**: dùng cho những lần sau.

Nó lấy lại **VPS, project và danh sách phát** từ Sheet. Thứ tự đúng là:

1. Bấm **Lấy dữ liệu từ Sheet về** → có VPS và project
2. Vào trang VPS, nhập lại mật khẩu root → bấm **Kiểm tra lại** (app tự tạo SSH key mới)
3. Vào trang Video, bấm **Làm mới** → app nhận lại các file video đang có trên VPS
4. Bấm **Lấy dữ liệu từ Sheet về** lần nữa → danh sách phát khớp lại theo tên video
5. Tạo lại điểm phát và dán Stream key

Bước 2 và 5 phải làm tay vì **mật khẩu VPS và Stream key không bao giờ được ghi lên
Sheet** (Sheet chỉ lưu 4 ký tự cuối của key). Xem [Bảo mật](#bảo-mật).

Nút này chỉ thêm, không xoá: thứ nào đã có thì bỏ qua, nên bấm nhiều lần vẫn an toàn.

> **Hai máy dùng chung một Sheet thì sao?** Đọc thì không sao. Nhưng cả hai máy đều ghi
> lên Sheet theo `id`, và id của máy mới đánh số lại từ đầu — nên hai bên sẽ ghi đè lẫn
> nhau (đo được: bản clone ghi lại 1 dòng Servers + 5 dòng Projects với cột đĩa/ffmpeg
> để trống). Không mất dòng nào, nhưng Sheet sẽ nhảy qua nhảy lại. Dùng chung `.env`
> khi **chuyển sang máy khác** thì hợp lý; nếu hai người dùng song song, mỗi người nên
> có Sheet + Apps Script riêng.

---

## Deploy lên Render

Dùng [render.yaml](render.yaml) (Blueprint), hoặc tạo Web Service thủ công với:

| Mục | Giá trị |
|---|---|
| Build command | `npm ci` |
| Start command | `npm start` |
| Instances | **1** (bắt buộc — SQLite) |
| Persistent disk | mount tại **`/var/data`**, 1 GB |
| Health check | `/health` |
| `DB_PATH` | `/var/data/live-manager.db` |

Đặt `ADMIN_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY` trong Environment.

### Lưu ý về băng thông Render

Render tính phí **outbound bandwidth**, và một lần đẩy video qua SFTP lên VPS **được
tính là outbound**. Hạn mức: Hobby 5 GB, Pro 25 GB, Scale 1 TB mỗi tháng; vượt hạn mức
mà không có thẻ thanh toán thì Render **tạm dừng service**.

Vì vậy app có hai đường đưa video lên VPS:

| Cách | Băng thông Render | Khi nào dùng |
|---|---|---|
| **Nhập từ link** | 0 | Mặc định nên dùng. VPS tự `curl` file về. |
| **Tải từ máy tính** | = dung lượng video | Khi file chỉ có trên máy bạn. |

Đặt `RENDER_BANDWIDTH_BUDGET_GB` bằng hạn mức của bạn để app cảnh báo ở mốc 80%.

---

## Nhập video từ link

| Nguồn | Độ tin cậy | Cần làm gì |
|---|---|---|
| Link trực tiếp / S3 presigned | Cao | — |
| Dropbox | Cao | — |
| OneDrive | Cao | Chia sẻ "Anyone with the link" |
| Google Drive | Trung bình | Chia sẻ "Anyone with the link" |

Google Drive chặn tải tự động với file lớn qua trang cảnh báo virus. App xử lý được
phần lớn trường hợp, nhưng nếu Drive từ chối, app sẽ nói rõ và bạn nên dùng Dropbox,
link trực tiếp, hoặc tải lên từ máy. App luôn kiểm tra file tải về có phải video thật
(bằng `ffprobe`) trước khi cho dùng.

---

## Video thế nào là đủ chuẩn để stream

App dùng `-c copy` — **không** mã hoá lại trong lúc phát. Đó là lý do một VPS nhỏ gánh được
nhiều fanpage cùng lúc, và cũng là lý do file phải đúng chuẩn từ trước: trên đường ra không có
ai sửa nó nữa. (OBS thì ngược lại — nó mã hoá lại 30 lần mỗi giây, nên thuộc tính file gốc
không quan trọng.)

| Thuộc tính | Phải là |
|---|---|
| Codec hình | **H.264** — HEVC/VP9/AV1 bị Facebook từ chối |
| Màu | **yuv420p** 8-bit |
| Khung hình | cạnh dài ≤ 1920, cạnh ngắn ≤ 1080 — **dọc hay ngang đều được** |
| **Keyframe** | **≤ 2 giây** — sai cái này là live giật, người mới vào thấy đen |
| FPS | ≤ 30 |
| Codec tiếng | **AAC**, và **phải có** luồng tiếng (dù im lặng) |

Tự kiểm một file trên máy:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt -of default=nw=1 video.mp4
```

Kiểm khoảng cách keyframe — thứ hay sai nhất, các mốc phải cách nhau ~2 giây:

```bash
ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals %+60 -of csv=p=0 video.mp4
```

Video đã đạt hết thì app đánh dấu **Sẵn sàng** ngay, không chuẩn hoá gì cả.

---

## Chuẩn hoá video — chạy trên máy bạn, không chạy trên VPS

Facebook yêu cầu **khung hình chính (keyframe) mỗi 2 giây**. Phần lớn video xuất từ
phần mềm dựng dùng 5–10 giây, nên sẽ hiện *CẦN CHUẨN HOÁ*.

**Chuẩn hoá chạy ở máy của bạn.** VPS là phần cứng chậm nhất trong cả hệ thống và CPU
của nó còn phải phục vụ các buổi live đang phát:

| | Tốc độ | Video 26 phút |
|---|---|---|
| VPS 2 core dùng chung | 0,32–0,51× thời gian thực | ~1 giờ |
| Máy Windows (Ryzen 5, libx264) | 2,53× | ~10 phút |

Ba bước:

1. Copy video vào thư mục **`video-can-chuan-hoa`** ở gốc thư mục app
2. Mở app → **Chuẩn hoá tại máy** → chọn độ phân giải đầu ra → bấm
3. Copy file trong **`video-da-chuan-hoa`** lên VPS, rồi bấm **Làm mới** ở trang Video

Trang đó **ghi rõ tên máy sẽ encode** ngay đầu trang. Nếu app được đặt trên VPS
(`deploy/vps-install.sh`) thì cùng cái nút ấy sẽ encode trên VPS — nên trang báo đỏ và
bảo bạn mở app ở máy mình.

Kết quả: H.264 / yuv420p / 30 fps CFR / GOP 60 (keyframe 2 giây) / AAC **48 kHz** stereo.
Video không có tiếng được thêm luồng im lặng vì Facebook cần một luồng âm thanh.

> Bộ encode phía VPS vẫn còn trong code và vẫn có test, nhưng **không còn chỗ nào trong
> giao diện gọi tới**. Gọi `POST /videos/:id/normalize` sẽ trả lỗi kèm hướng dẫn làm ở
> máy. Muốn bật lại thì chỉ cần đổi lại route đó.

**App chỉ encode lại phần đang sai.** Nếu hình đã đạt mà chỉ thiếu AAC thì nó dùng
`-c:v copy` — hình giữ nguyên chất lượng và nhanh hơn hẳn. Đo trên VPS 2 core với clip
1080p 180 giây:

| | Thời gian | So với thời gian thực |
|---|---|---|
| encode lại hình | 125,0 s | 1,44× |
| chỉ sửa âm thanh | 12,9 s | 13,97× |

Tức **nhanh hơn 9,7 lần**. Suy ra cho video 2 tiếng trên VPS 2 core: encode hình mất
**~1,4 giờ**, chỉ sửa âm thanh mất **~9 phút**. App hiện ước lượng này ngay trên thẻ video
trước khi bạn bấm.

**Khung hình không bị đổi** — video dọc 1080×1920 vẫn ra 1080×1920. Chỉ khi video thật sự
vượt mức (ví dụ 4K 3840×2160) thì app mới thu về vừa khung, giữ đúng tỉ lệ và chiều.

### Chuẩn hoá trên máy mình — menu "Chuẩn hoá tại máy"

VPS là phần cứng chậm nhất trong cả hệ thống: 2 core chia sẻ, đo được **0,32–0,51×** thời gian
thực. Máy Windows thường nhanh hơn nhiều, và nếu có GPU NVIDIA/Intel/AMD thì hơn cả chục lần.

Cách dùng:

1. Copy video vào thư mục **`video-can-chuan-hoa`** ở gốc thư mục app.
2. Mở app → menu **Chuẩn hoá tại máy** → chọn độ phân giải đầu ra và bộ mã hoá → bấm.
3. Kết quả nằm ở **`video-da-chuan-hoa`**. Copy lên VPS rồi bấm *Làm mới* ở trang Video.

Tham số đầu ra **giống hệt** đường chuẩn hoá trên VPS (cùng một hàm sinh câu lệnh), nên file
làm ở máy và file làm ở VPS dùng thay nhau được.

**Cần ffmpeg trên máy.** Cài một lần:

```bash
winget install --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
```

Rồi mở lại app. App tự tìm ffmpeg theo thứ tự: `runtime/ffmpeg/` → PATH → `LOCAL_FFMPEG_PATH`
trong `.env`.

**Bộ mã hoá GPU chỉ được đưa ra chọn sau khi app encode thử thật và nó chạy được.** Có tên
trong bản build không có nghĩa là máy chạy được — VPS liệt kê `h264_nvenc` mà không có GPU nào.

**Để người nhận không phải cài gì**, chạy `npm run bundle-ffmpeg`: nó copy ffmpeg/ffprobe đang
có trên máy vào `runtime/ffmpeg/`, và `npm run package` sẽ kèm vào zip. Script này **copy** chứ
không tải từ mạng — bản Node có file checksum chính chủ để đối chiếu, còn các bản ffmpeg cho
Windows thì không, nên việc tải một binary 106 MB để bạn đem phát lại không nên do script tự
quyết.

Hai thư mục video **không** được đưa vào zip (video của bạn có thể nặng hàng GB); app tự tạo lại
khi cần.

---

### Hoặc tự chạy lệnh ffmpeg bằng tay

VPS 2 core là chỗ chậm nhất để encode. Máy tính của bạn nhanh hơn nhiều (có NVENC/QuickSync
thì hơn cả chục lần). Chuẩn hoá trước rồi `scp`/`rsync` lên là app đánh dấu **Sẵn sàng** ngay:

```bash
ffmpeg -i goc.mp4 -c:v libx264 -preset veryfast -profile:v high -level 4.1 \
  -pix_fmt yuv420p -r 30 -g 60 -keyint_min 60 -sc_threshold 0 \
  -b:v 4500k -maxrate 4500k -bufsize 9000k \
  -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart ra.mp4
```

### Nút Kiểm tra lại

Đọc lại file bằng ffprobe và tính lại kết luận. Dùng khi trạng thái đã cũ, hoặc để thoát
khỏi một lần chuẩn hoá bị lỗi. Kết luận (*Sẵn sàng* / *Cần chuẩn hoá*) được lưu trong
database, nên nó không tự cập nhật khi luật kiểm tra thay đổi.

---

## Giám sát và tự chữa

App có một tiến trình chạy nền kiểm tra mọi điểm phát theo chu kỳ (mặc định 60 giây).
Nó phát hiện hai loại hỏng, và loại thứ hai mới là lý do chính:

1. **Unit chết hoặc failed** — `systemctl is-active` thấy được.
2. **Unit vẫn "active" nhưng FFmpeg không đẩy dữ liệu nữa.** Process đóng băng hoặc
   reconnect liên tục vẫn tính là active, nên chỉ có số liệu throughput mới lộ ra.

Với loại 2, app **tự khởi động lại** điểm phát đó (tắt được từng điểm phát một).
Vì vậy trang project hiện `1.00x · 4500 kbps` chứ không chỉ một đèn xanh — và badge
"không theo kịp" khi `speed` tụt dưới 0.9 (dấu hiệu VPS thiếu băng thông hoặc CPU).

Mọi sự cố được ghi vào trang **Lịch sử**, kèm nguyên nhân đã dịch sang tiếng Việt.

```env
WATCHER_ENABLED=1
WATCHER_INTERVAL_SECONDS=60
STALL_SECONDS=90
```

> Watcher chỉ chạy khi app còn sống. Trên Render app có thể sleep khi không ai truy cập
> → mất tính năng tự chữa. Buổi live vẫn không bị ảnh hưởng (systemd trên VPS giữ
> FFmpeg), nhưng muốn giám sát 24/7 thật thì đặt app trên VPS bằng
> [deploy/vps-install.sh](deploy/vps-install.sh).

---

## Danh sách phát nhiều video

Một project phát được nhiều video lần lượt rồi lặp lại từ đầu, dùng concat demuxer của
FFmpeg (`-f concat -safe 0 -stream_loop -1`), vẫn `-c copy` nên gần như không tốn CPU.

Điều kiện: **các video phải cùng độ phân giải, FPS và codec.** Bước *Chuẩn hoá cho
Facebook* ép mọi video về đúng một preset nên video đã qua chuẩn hoá luôn thoả. Hai video
đều `READY` vẫn có thể lệch nhau (một 1080p, một 720p) — khi đó app **chặn phát** và nói
rõ video nào lệch chỗ nào, thay vì để live chạy vài giây rồi vỡ hình.

Đổi thứ tự hoặc thêm/xoá video khi đang live → app ghi lại unit và khởi động lại các
điểm phát để áp dụng. Xoá video cuối cùng khỏi danh sách sẽ dừng toàn bộ live của project.

---

## Dọn dung lượng

Trang Video hiện khối **Video không dùng (n) — X GB** kèm một nút xoá tất cả. Chỉ những
video không project nào tham chiếu mới được liệt kê — kể cả video nằm giữa một danh sách
phát cũng được bảo vệ.

Mỗi video có ảnh xem trước, tạo trên VPS lúc phân tích rồi tải về cache một lần
(`<thư mục database>/thumbs`), nên trang danh sách không mở SSH cho từng ảnh.

---

## Quản lý dữ liệu bằng Google Sheet

Tuỳ chọn, tắt sẵn. Bật lên thì toàn bộ danh mục (VPS, video, project, danh sách phát,
điểm phát, lịch sử) hiện trên một Google Sheet của bạn, xem và sửa trực tiếp ở đó.

Hướng dẫn cài: [deploy/apps-script/README.md](deploy/apps-script/README.md) — khoảng 5 phút.

Cách vận hành:

- Sheet là nơi bạn nhìn dữ liệu; SQLite vẫn giữ **secret** (mật khẩu SSH, SSH key,
  stream key) vì URL webhook của Apps Script không xác thực. Sheet chỉ thấy 4 ký tự
  cuối của stream key.
- Sửa được trên Sheet: `name`, `note`, và `position` ở tab Playlist. Các cột khác do
  app ghi.
- App **không** ghi đè thứ bạn sửa trên Sheet, vì nó chỉ gửi cột nào thật sự thay đổi
  ở phía app.
- Xoá dòng trên Sheet thì app không xoá theo — nó trả dòng đó về và ghi cảnh báo ở
  Lịch sử. Một buổi live không được chết vì một dòng bảng tính biến mất.
- Google sập thì thao tác **sửa dữ liệu** bị chặn, nhưng **Dừng / Khởi động lại / Dọn
  dung lượng / watcher tự cứu vẫn chạy** — chúng chỉ cần SSH tới VPS của bạn.
- Đừng chia sẻ Sheet: tab `Servers` có IP và tên đăng nhập VPS, và Google lưu lịch sử
  sửa đổi vĩnh viễn.

Bốn nút trong thẻ Google Sheet ở trang Tổng quan:

| Nút | Chiều | Làm gì |
| --- | --- | --- |
| **Đọc lại từ Sheet** | Sheet → app | Áp dụng `name` / `note` / `position` bạn vừa sửa tay. Không tạo, không xoá dòng nào. |
| **Đẩy ngay** | app → Sheet | Gửi hàng đợi hiện tại thay vì chờ tới nhịp 5 phút. |
| **Đẩy toàn bộ lên Sheet** | app → Sheet | Ghi lại mọi thứ app đang có. Dùng khi Sheet bị lệch. |
| **Lấy dữ liệu từ Sheet về** | Sheet → app | **Dựng lại** VPS, project, danh sách phát khi máy mới / DB mới. Xem [Clone về máy khác](#clone-về-máy-khác-thì-có-sẵn-dữ-liệu-không). |

Hai nút cuối nghe giống nhau nhưng ngược chiều: *Đẩy toàn bộ* sửa **Sheet**, *Lấy dữ
liệu về* sửa **app**.

---

## Phát bao lâu: vòng lặp và tự dừng

Mỗi điểm phát chọn một trong ba kiểu, ở mục **Phát trong bao lâu**:

| Chọn | Nghĩa |
|---|---|
| **Lặp mãi** (mặc định) | phát lại từ đầu vô hạn cho tới khi bạn bấm Dừng |
| **Lặp N vòng** | video 2 tiếng × 3 vòng = 6 tiếng rồi tự dừng |
| **Tự dừng sau X giờ** | dừng theo thời gian, không cần biết độ dài video |

Với playlist nhiều video, một "vòng" là hết cả danh sách, không phải một file.

Cách làm bên dưới, vì có một xung đột không hiển nhiên:

- Kết thúc đúng chỗ do FFmpeg lo, bằng `-t <tổng giây>` ở phía đầu ra. Đo trên VPS
  thật: file 5 giây với `-t 12` kết thúc ở 12,26s, kể cả khi phát qua playlist. Nên
  buổi live có thể dừng **giữa video**, không bắt buộc dừng ở ranh giới file.
- `Restart=always` khởi động lại tiến trình **dù nó kết thúc sạch** — thử trên VPS:
  chạy 3 lần trong 9 giây. Nên buổi live hữu hạn phải chuyển sang
  `Restart=on-failure`, nếu không thì `-t` vô nghĩa và nó vẫn lặp mãi. `on-failure`
  vẫn cứu tiến trình chết thật (thử: khởi động lại 4 lần).
- **Buổi live dài hơn 7 giờ 45** không dùng được `-t`, vì tới mốc đó systemd phải
  làm mới phiên cho Facebook, và bộ đếm `-t` sẽ đếm lại từ 0 → live chạy dài gấp
  đôi. Trường hợp này app tự dừng theo `planned_end_at`, sai số tối đa một nhịp
  watcher (60 giây).
- Watcher tự cứu live bị treo sẽ **giữ nguyên giờ kết thúc** và chỉ đưa cho FFmpeg
  phần thời gian **còn lại**. Nếu không, một lần treo ở giờ thứ 5 của buổi 6 giờ sẽ
  kéo thành 11 giờ.

Phát xong đúng kế hoạch được ghi ở trang Lịch sử là **Phát xong** (màu xanh), khác
với **Live dừng ngoài ý muốn** (màu đỏ) — và watcher **không** đi cứu một buổi live
vừa kết thúc đúng ý bạn.

---

## Giới hạn 8 giờ của Facebook

Facebook cắt buổi live ở mốc 8 giờ. App bật sẵn **Tự làm mới**: systemd dừng FFmpeg ở
mốc 7 giờ 45 rồi bật lại ngay (`RuntimeMaxSec` + `Restart=always`). Với stream key cố
định (persistent stream key), Facebook nhận kết nối lại và buổi live tiếp tục.

Có thể tắt cho từng điểm phát nếu bạn muốn live dừng đúng một phiên. Với buổi live
ngắn hơn 7 giờ 45 thì mục này không có tác dụng — chưa tới mốc đó đã kết thúc.

---

## VPS cần gì

Ubuntu (hoặc Debian) + SSH. App tự lo phần còn lại:

- cài FFmpeg, kiểm tra bản FFmpeg có hỗ trợ RTMPS;
- tạo `/opt/live-manager/{videos,temp,logs}`;
- đồng bộ đồng hồ (giờ sai làm TLS tới Facebook thất bại);
- thử kết nối tới `live-api-s.facebook.com:443`;
- **tự tạo SSH key riêng**, cài lên VPS, kiểm tra đăng nhập được rồi mới xoá mật khẩu.

Tài khoản SSH phải là `root` hoặc có `sudo` (app tự nhận biết).

---

## Bảo mật

- Mật khẩu admin: bcrypt (cost 12). JWT trong cookie `HttpOnly`, không dùng localStorage.
- Mật khẩu SSH, SSH private key, RTMPS URL + Stream key: mã hoá **AES-256-GCM**.
- **Host key pinning (TOFU)**: `ssh2` mặc định chấp nhận mọi host key, nên app tự ghim
  fingerprint lần đầu và từ chối kết nối nếu danh tính VPS đổi.
- Stream key được che trong UI và trong log (`journalctl`) trước khi trả về trình duyệt.
- Stream key nằm trong file env `chmod 600` thay vì trong unit file — vì
  `/etc/systemd/system/*.service` ai cũng đọc được.
  *(Lưu ý: `ps` trên VPS vẫn thấy URL vì argv của FFmpeg buộc phải chứa nó.)*
- Tên systemd unit chỉ sinh từ id số trong database, không từ dữ liệu người dùng.
- Nội dung file ghi lên VPS truyền qua base64 nên shell không thể diễn giải.
- Video luôn lưu theo UUID do app sinh, không dùng tên file gốc.

---

## Cấu trúc

```
src/
├── server.js              Express, helmet + CSP, mount routes
├── config.js              env + hằng số
├── db/                    SQLite, migrations, seed admin
├── middleware/            auth (JWT cookie), error handler, rate limit
├── routes/                auth, dashboard, servers, videos, projects, jobs
├── services/
│   ├── crypto.service     AES-256-GCM
│   ├── ssh.service        kết nối, TOFU, sudo, ghi file qua base64
│   ├── provision.service  tự cài SSH key + 10 mục kiểm tra VPS
│   ├── storage.service    df, Storage Safety Rule
│   ├── import.service     nhập từ link (Drive/Dropbox/OneDrive/trực tiếp)
│   ├── upload.service     busboy → SFTP, không buffer
│   ├── video.service      ffprobe, GOP, chuẩn hoá
│   ├── rtmps-parser       đọc mọi kiểu Stream key dán vào
│   ├── ffmpeg.service     sinh systemd unit
│   ├── live.service       start/stop/restart/status/logs
│   ├── error-decoder      lỗi FFmpeg → tiếng Việt
│   ├── project.service    project + danh sách phát + kiểm tra tương thích
│   ├── watcher.service    giám sát nền, phát hiện treo, tự khởi động lại
│   └── job.service        tiến trình chạy nền
└── views/                 EJS
```

Tiến trình chạy lâu (chuẩn bị VPS, tải từ link, chuẩn hoá) là `jobs` chạy nền, UI
poll `/api/jobs/:id`. Việc chạy trên VPS trong systemd unit vẫn tiếp tục nếu app
restart, và app tự gắn lại tiến trình khi khởi động.
