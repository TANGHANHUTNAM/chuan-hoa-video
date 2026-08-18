# Bắt đầu từ đây

Hướng dẫn cho **lần đầu tiên** mở app, viết cho người không rành máy tính.
Không cần biết lập trình. Không cần gõ lệnh.

App này để làm gì: phát video có sẵn lên **Facebook Live** 24/7 từ một máy chủ
thuê ngoài (VPS), thay vì phải để máy tính của bạn mở suốt.

---

## Trước tiên: bạn đang có bản nào?

Có hai cách nhận app, và **cách chuẩn bị khác nhau**. Nhìn vào thư mục là biết ngay:

**Trong thư mục có sẵn một folder tên `runtime` không?**

| | Nghĩa là | Bạn cần làm gì |
|---|---|---|
| ✅ **Có** `runtime` | Bạn nhận bản đóng gói sẵn (file zip) | **Không cần cài gì cả.** Bỏ qua mục dưới, nhảy thẳng xuống Bước 1 |
| ❌ **Không có** `runtime` | Bạn tải mã nguồn về từ GitHub | Cần cài **Node.js** trước, xem mục ngay dưới |

Lý do: bản zip đã gói sẵn Node.js ở trong (khoảng 88 MB), còn mã nguồn trên GitHub thì
không — phần đó cố ý không đưa lên GitHub vì nó nặng và tải lại lúc nào cũng được.

---

## Cần chuẩn bị

| | Là gì | Lấy ở đâu |
|---|---|---|
| **Node.js** | phần mềm để chạy app, cài một lần rồi thôi.<br>**Chỉ cần khi thư mục KHÔNG có folder `runtime`** | [nodejs.org](https://nodejs.org) — tải bản ghi chữ **LTS** |
| **Một VPS** | máy chủ chạy Ubuntu, có sẵn địa chỉ IP và mật khẩu root | thuê ở bất kỳ nhà cung cấp nào |
| **Stream key** | chuỗi Facebook cấp cho buổi live của bạn | trang phát trực tiếp của Facebook |

VPS và Stream key chưa cần ngay. Cứ mở app trước đã.

> **Cách cài Node.js:** tải file về, bấm đôi, rồi bấm *Next → Next → Finish*.
> Không cần đổi gì trong lúc cài. Cài xong nên khởi động lại máy cho chắc.

---

## Bước 1 — Mở app

Trong thư mục bạn vừa tải về, tìm file:

```
Bat dau mo app quan ly live facebook.cmd
```

**Bấm đôi vào nó.** Chỉ vậy thôi.

Một cửa sổ màu đen hiện ra và tự làm mọi thứ: cài thư viện, tạo file cấu hình,
bật app, mở trình duyệt.

⏳ **Mất bao lâu:**

- Bản zip (có folder `runtime`): vài giây, không cần mạng.
- Bản tải từ GitHub: lần đầu khoảng **1–2 phút** và **cần mạng**, vì app đang tải
  thư viện về. Những lần sau chỉ vài giây.

Trong lúc chờ, cửa sổ đen chạy chữ liên tục — đó là bình thường, đừng đóng nó.

> Nếu Windows chặn không cho chạy: bấm chuột phải vào file `.cmd` → *Properties*
> → tích ô **Unblock** → *OK*, rồi bấm đôi lại.

---

## Bước 2 — Ghi lại mật khẩu ⚠️

Đây là bước **quan trọng nhất**. Trong cửa sổ đen sẽ hiện ra một đoạn như thế này:

```
  Tài khoản đăng nhập vừa tạo:
    Email:      you@example.com
    Mật khẩu:   DbSJsevGn2cv
```

**Chép hai dòng đó ra giấy hoặc vào ghi chú.** Mật khẩu là chuỗi ngẫu nhiên, mỗi
máy một khác, và chỉ hiện ra đúng một lần duy nhất này.

Lỡ tắt cửa sổ trước khi kịp ghi? Không sao. Mật khẩu vẫn nằm trong file tên `.env`
ở ngay thư mục này. Bấm chuột phải vào nó → *Open with* → **Notepad**, rồi tìm hai
dòng:

```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=DbSJsevGn2cv
```

> Bấm đôi vào file `.env` thì Windows sẽ hỏi "mở bằng gì" vì nó không phải file
> văn bản thông thường. Cứ chọn Notepad là đọc được.

---

## Bước 3 — Đăng nhập

Trình duyệt tự mở ra trang `http://localhost:3000`. Nếu không tự mở, bạn gõ địa chỉ
đó vào thanh địa chỉ của Chrome.

Đăng nhập bằng đúng email và mật khẩu vừa ghi ở Bước 2.

Xong. Bạn đã vào được app.

---

## Bước 4 — Kết nối VPS

App sẽ đưa bạn thẳng tới màn hình **Chào mừng bạn**. Điền vào đó:

- **Địa chỉ IP** của VPS (dạng `123.45.67.89`)
- **Tên đăng nhập**: thường là `root`
- **Mật khẩu** của VPS

Rồi bấm nút kết nối và **chờ**. App tự cài FFmpeg, tạo thư mục, đồng bộ đồng hồ,
thử kết nối tới Facebook, và tự tạo một chìa khoá SSH riêng để những lần sau không
cần mật khẩu nữa. Việc này mất vài phút và có thanh tiến trình.

Tài khoản VPS phải là `root`, hoặc là tài khoản có quyền `sudo`. Nếu không đủ quyền,
app sẽ báo rõ ràng chứ không im lặng.

---

## Quy trình chuẩn: từ video tới buổi live

Bốn bước dưới đây là cách làm **được khuyên dùng**. Làm đúng thứ tự này thì nhanh nhất
và ít lỗi nhất:

```
  Bước 5              Bước 6                Bước 7               Bước 8
┌──────────┐      ┌────────────┐      ┌─────────────┐      ┌────────────┐
│ Chuẩn hoá│  ──► │ Lên Google │  ──► │ Dán link vào│  ──► │ Dán Stream │
│  video   │      │   Drive    │      │ app, VPS tự │      │ key, phát  │
│(máy bạn) │      │(mở public) │      │  tải về     │      │   live     │
└──────────┘      └────────────┘      └─────────────┘      └────────────┘
```

**Vì sao đi vòng qua Google Drive** thay vì tải thẳng từ app lên VPS? Vì file đi thẳng
sẽ chạy đường **máy bạn → app → VPS**, tức là qua hai chặng. Còn dán link thì VPS **tự
tải một chặng**, nhanh hơn hẳn, không tốn băng thông của app, và quan trọng nhất là
**tải tiếp được khi đứt mạng** — bạn tắt trình duyệt hay tắt máy giữa chừng cũng không
sao. Với video vài GB thì khác biệt này rất lớn.

---

## Bước 5 — Chuẩn hoá video

Facebook chỉ nhận video đúng chuẩn. Video xuất từ phần mềm dựng thường **không** đạt,
và đó là lý do phổ biến nhất khiến buổi live bị giật.

**Làm thế này:**

1. Chép video vào thư mục **`video-can-chuan-hoa`** (nằm ngay cạnh hai file `.cmd`)
2. Bấm đôi **`Bat dau mo app chuan hoa video.cmd`**
3. Trình duyệt mở ra, mỗi video hiện một thẻ với nhãn:
   - 🟢 **Đã đạt chuẩn** — không cần làm gì, dùng luôn được
   - 🟡 **Cần chuẩn hoá** — bấm vào mục *Vì sao cần chuẩn hoá* sẽ thấy lý do cụ thể
4. Chọn **Độ phân giải đầu ra**:

   | Chọn | Khi nào dùng |
   |---|---|
   | **Giữ nguyên** | Video đã đúng khung hình, chỉ cần sửa phần kỹ thuật |
   | **1920×1080 · tỉ lệ 16:9 (ngang)** | Live ngang, kiểu YouTube |
   | **1080×1920 · tỉ lệ 9:16 (dọc)** | Live dọc, kiểu điện thoại / Reels |

   Nếu video gốc không vừa khung, bạn chọn thêm cách lấp phần trống:
   - **Nền mờ** — phần trống là bản phóng to làm mờ của chính video. Đầy khung, đẹp mắt.
   - **Viền đen** — phần trống để đen trơn. Nhanh hơn và ảnh nét hơn một chút.

5. Bấm **Chuẩn hoá** rồi chờ. Có dòng chữ báo tiến độ, trang tự cập nhật.
6. File kết quả nằm ở thư mục **`video-da-chuan-hoa`**

⏱ **Mất bao lâu:** video 26 phút khoảng 10 phút trên máy tính thường. Cứ để đó làm việc
khác, đừng đóng cửa sổ đen.

> **Vì sao chuẩn hoá trên máy bạn chứ không trên VPS?** Cùng video đó, VPS 2 nhân mất
> khoảng **một tiếng**, máy tính thường chỉ mất **10 phút**. Mà CPU của VPS còn phải lo
> phát live — bắt nó vừa mã hoá vừa phát là làm buổi live đang chạy bị giật.

---

## Bước 6 — Đưa video lên Google Drive

1. Mở [drive.google.com](https://drive.google.com), tạo một thư mục riêng cho tiện,
   ví dụ đặt tên *Video Live*
2. Kéo file trong **`video-da-chuan-hoa`** thả vào đó, chờ tải xong
3. Bấm chuột phải vào video → **Chia sẻ** (*Share*)
4. Ở mục *Quyền truy cập chung* (*General access*), đổi từ **Bị hạn chế** (*Restricted*)
   sang **Bất kỳ ai có đường liên kết** (*Anyone with the link*)
5. Bấm **Sao chép đường liên kết** (*Copy link*)

⚠️ **Bước 4 là bắt buộc.** Nếu để *Restricted*, VPS không tải được vì nó không đăng nhập
Google. App sẽ báo lỗi ngay khi bạn bấm *Kiểm tra link*, chứ không để bạn chờ vô ích.

Link copy được có dạng:

```
https://drive.google.com/file/d/1a2B3c4D5e6F7g8H9i/view?usp=sharing
```

> Không thích Google Drive cũng được. App nhận cả **Dropbox**, **OneDrive**, và bất kỳ
> **link tải trực tiếp** nào. Dropbox và OneDrive thậm chí ổn định hơn Drive một chút.

---

## Bước 7 — Dán link vào app

Quay lại app quản lý live (`http://localhost:3000`):

1. Vào trang **Project** → bấm tạo project mới
2. Tới mục chọn video, bấm tab **Nhập từ link** (cạnh hai tab *Video đã có* và
   *Tải từ máy tính*)
3. Dán link Drive vào ô **Link tới file video**
4. Bấm **Kiểm tra link**

App sẽ báo lại: tên file, dung lượng, và VPS còn đủ chỗ trống không. Nếu ổn, nút
**Bắt đầu tải về VPS** hiện ra — bấm vào đó.

VPS tự tải file về. Có thanh tiến trình. **Bạn đóng trình duyệt hay tắt máy lúc này
cũng không sao**, việc tải vẫn chạy tiếp trên VPS.

> **Khi nào dùng tab "Tải từ máy tính"?** Chỉ khi file nhỏ hoặc bạn ngại upload lên
> Drive. Cách đó đi hai chặng nên chậm hơn, và mất mạng giữa chừng là phải làm lại từ đầu.

---

## Bước 8 — Dán Stream key và phát live

1. Mở **Facebook Live Producer** trên trang fanpage của bạn
2. Chọn **Use stream key** (dùng khoá luồng)
3. Copy ô **Stream key** — chuỗi bắt đầu bằng `FB-…`
4. Quay lại app, dán vào ô **Tên fanpage** + **Stream key**. Mỗi fanpage một dòng, phát
   nhiều fanpage cùng lúc được.
5. Chọn **Phát trong bao lâu**: lặp mãi, lặp N vòng, hoặc tự dừng sau X giờ
6. Bấm phát

Xong. Buổi live chạy trên VPS, **không phụ thuộc máy tính của bạn nữa** — tắt máy đi ngủ
vẫn phát bình thường.

---

## Tắt app thế nào

**Đóng cửa sổ màu đen.** Vậy là xong.

> Buổi live đang phát **vẫn chạy tiếp** dù bạn tắt app hay tắt luôn máy tính — vì
> nó chạy trên VPS chứ không chạy trên máy bạn. Tắt app chỉ là tắt bảng điều khiển.

---

## Trong thư mục có hai app

| Bấm đôi file | Để làm gì |
|---|---|
| `Bat dau mo app quan ly live facebook.cmd` | Quản lý VPS và phát live |
| `Bat dau mo app chuan hoa video.cmd` | Sửa video cho đúng chuẩn Facebook |

Hai app chạy độc lập, mở cùng lúc được.

**Khi nào cần app thứ hai?** Bất cứ khi nào app quản lý live gắn nhãn vàng
**CẦN CHUẨN HOÁ** lên video của bạn. Cách dùng chi tiết ở [Bước 5](#bước-5--chuẩn-hoá-video).

---

## Gặp trục trặc

| Bạn thấy | Nên làm |
|---|---|
| *NODE.JS IS NOT INSTALLED* | Chỉ xảy ra với bản tải từ GitHub. Máy chưa có Node.js — bấm một phím để mở trang tải, cài bản **LTS**, rồi bấm đôi lại file `.cmd` |
| *CỔNG 3000 ĐANG ĐƯỢC MỘT BẢN KHÁC DÙNG* | Có một thư mục app khác đang chạy. App sẽ chỉ sẵn hai cách ngay trong cửa sổ đen: tắt bản kia, hoặc sửa `PORT=3001` trong file `.env` để chạy song song |
| Cửa sổ đen hiện ra rồi tắt ngay | Bấm chuột phải file `.cmd` → *Properties* → tích **Unblock** → *OK* |
| Trình duyệt không tự mở | Tự gõ `http://localhost:3000` vào Chrome |
| Quên mật khẩu đăng nhập | Mở file `.env` bằng Notepad, xem dòng `ADMIN_PASSWORD` |
| Lần đầu chạy rất lâu | Bình thường, app đang tải thư viện về. Cần có mạng. Chờ 1–2 phút |
| Dán link Drive mà báo lỗi tải | Video chưa mở quyền. Vào Drive → chuột phải video → *Chia sẻ* → đổi sang **Bất kỳ ai có đường liên kết**, rồi copy link lại |
| Link Drive đúng quyền vẫn không tải được | Với file rất lớn, Drive đôi khi tự chặn tải máy. Đổi sang **Dropbox** hoặc **OneDrive** — hai chỗ này ổn định hơn |
| Video bị nhãn vàng **CẦN CHUẨN HOÁ** | Chưa đúng chuẩn Facebook. Làm theo [Bước 5](#bước-5--chuẩn-hoá-video). Cứ phát luôn thì live dễ bị giật |
| Live bị giật, hình khựng | Hay gặp nhất là do khung hình chính cách nhau quá 2 giây. Chuẩn hoá lại video ở [Bước 5](#bước-5--chuẩn-hoá-video) là hết |
| VPS báo hết dung lượng | Vào trang Video, xoá bớt ở khối **Video không dùng** |

Nếu vẫn không được, chụp lại **toàn bộ cửa sổ đen** rồi gửi cho người đã đưa bạn app
này. Dòng chữ trong đó nói rõ nguyên nhân.

---

## Hai điều về an toàn

**1. File `.env` là chìa khoá của mọi thứ.** Ai cầm được nó thì vào được VPS của bạn
bằng quyền cao nhất và phát live được lên kênh của bạn. Đừng gửi cho ai, đừng đăng
lên mạng, đừng đưa lên GitHub.

**2. Mật khẩu đăng nhập app** nên đổi thành của riêng bạn. Sửa dòng `ADMIN_PASSWORD`
trong file `.env` **trước lần chạy đầu tiên** — sau lần đầu thì tài khoản đã được tạo
xong rồi, sửa file cũng không còn tác dụng nữa.

---

## Muốn tìm hiểu thêm

- **Dùng chung dữ liệu với người khác**, hoặc chuyển sang máy tính mới mà không phải
  làm lại từ đầu → xem mục *Quản lý dữ liệu bằng Google Sheet* trong [README.md](README.md)
- **Mọi thứ khác** (phát trong bao lâu, giới hạn 8 giờ của Facebook, tự khởi động lại
  khi live bị treo, cài lên máy chủ) → [README.md](README.md)

---

## Nếu bạn quen dùng dòng lệnh

Ba lệnh này thay cho việc bấm đôi:

```bash
npm install
npm run setup
npm start
```

`npm run setup` in ra mật khẩu vừa sinh. Lệnh này không bao giờ ghi đè file `.env`
đã có, nên chạy lại nhiều lần vẫn an toàn.
