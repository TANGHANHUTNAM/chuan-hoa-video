# Nối app với Google Sheet

Làm một lần, khoảng 5 phút. Sau đó dữ liệu của app nằm trên Sheet và bạn xem/sửa
trực tiếp ở đó.

---

## 1. Tạo Sheet

Mở [sheets.new](https://sheets.new), đặt tên gì cũng được, ví dụ
*Facebook Live Manager*.

## 2. Mở Apps Script

Trong Sheet: **Extensions → Apps Script**.

Xoá hết code mẫu trong `Code.gs`, dán toàn bộ nội dung file
[`Code.gs`](Code.gs) ở thư mục này vào.

## 3. Đặt token

Sinh một chuỗi ngẫu nhiên — chạy lệnh này trên máy bạn:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Trong `Code.gs`, thay dòng:

```js
var TOKEN = 'DOI_CHUOI_NAY_THANH_TOKEN_CUA_BAN';
```

bằng chuỗi vừa sinh. **Giữ lại chuỗi này**, bước 5 cần dùng.

> Token quan trọng: URL của web app ai có cũng gọi được, nên token là thứ duy
> nhất ngăn người khác đọc và ghi dữ liệu của bạn.

Bấm biểu tượng đĩa mềm để lưu.

## 4. Deploy

**Deploy → New deployment**:

| Mục | Chọn |
|---|---|
| Type (bánh răng bên cạnh "Select type") | **Web app** |
| Execute as | **Me** |
| Who has access | **Anyone** |

Bấm **Deploy**. Google sẽ hỏi cấp quyền — chọn tài khoản của bạn, bấm
*Advanced* → *Go to (tên project) (unsafe)* → *Allow*. Cảnh báo này là bình
thường với script tự viết.

Copy **Web app URL**, dạng:

```
https://script.google.com/macros/s/AKfycb..../exec
```

### Kiểm tra nhanh

Dán URL đó vào trình duyệt. Phải thấy:

```json
{"ok":true,"service":"facebook-live-manager-sheets","tabs":["Servers","Videos",...]}
```

Thấy như vậy là script đã sống.

## 5. Điền vào app

Mở file `.env` trong thư mục app, thêm:

```env
SHEETS_ENABLED=1
SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfycb..../exec
SHEETS_TOKEN=<chuỗi token ở bước 3>
```

Khởi động lại app (đóng cửa sổ đen rồi bấm đôi `Bat dau mo app quan ly live facebook.cmd`).

---

## Mỗi khi sửa `Code.gs`

Phải **Deploy → Manage deployments → bút chì → Version: New version → Deploy**.
Chỉ bấm Save trong editor thì URL vẫn chạy code cũ.

> **Có thay đổi mới, deploy lại khi nào rảnh.** Tab `Destinations` được thêm hai cột
> `loop` và `planned_end` (cài đặt vòng lặp và giờ dự kiến kết thúc). Không deploy lại
> cũng **không sao** — script chỉ ghi những cột có trong hàng tiêu đề của nó, nên hai
> cột mới đơn giản là chưa xuất hiện; mọi thứ khác chạy y như cũ.

---

## Giới hạn cần biết

Tài khoản **Gmail thường** có **90 phút** runtime Apps Script mỗi ngày
(Google Workspace được 6 giờ).

Quan trọng: Google tính **thời gian script chạy phía họ**, không tính thời gian
bạn chờ. Đo trên Sheet thật của bạn:

| Thao tác | Bạn chờ | Google tính |
|---|---|---|
| ping | ~2,0s | **3 ms** |
| đọc toàn bộ Sheet | ~3,9s | ~2,3s |
| ghi | ~2,4s | ~1,6s |

Vì vậy app được thiết kế để gọi ít:

- đọc toàn bộ Sheet trong **một** lần gọi, mỗi 5 phút (và thêm khi bạn đang bấm
  qua các trang, tối đa 30 giây một lần)
- gom mọi thay đổi rồi ghi trong **một** lần gọi, tối đa 15 giây một lần
- **không** đẩy dữ liệu tần số cao (nhịp tim upload 2 giây, throughput watcher
  60 giây). Thời lượng live và tốc độ luồng chỉ lên Sheet mỗi 5 phút
- app rảnh thì **không gọi lần nào** — chỉ gọi khi thật sự có thay đổi

Dự báo theo nhịp này, ngày dùng nhiều: **~27 phút / 90 phút (30%)**. App tự đếm
và ngưng đồng bộ định kỳ ở mốc 70%, có cảnh báo trên Tổng quan.

Hạn mức reset lúc nửa đêm Los Angeles — với bạn là **14:00 giờ Việt Nam**, không
phải nửa đêm.

## Những gì KHÔNG lên Sheet

Vì URL web app không xác thực, các thứ sau luôn ở lại máy, mã hoá AES-256-GCM:

- mật khẩu SSH và SSH private key của VPS
- Facebook stream key (Sheet chỉ hiện 4 ký tự cuối)
- mật khẩu đăng nhập app

## Tình trạng hiện tại

Đã xong và đã kiểm trên Sheet thật của bạn:

- app tự đẩy lên Sheet khi bạn tạo/sửa/xoá trong app
- app tự đọc ngược khi bạn sửa `name`, `note`, `position` trên Sheet
- sửa trên Sheet **không** bị app ghi đè; sửa trong app **vẫn** lên được Sheet
- xoá dòng trên Sheet thì app từ chối và trả dòng đó về, ghi cảnh báo ở Lịch sử
- token chặn truy cập lạ
- stream key **không** lên Sheet (chỉ 4 ký tự cuối), không có `rtmps://`
- Google sập thì thao tác sửa dữ liệu bị chặn, nhưng **Dừng / Khởi động lại /
  Dọn dung lượng vẫn chạy** (xem mục dưới)

## Khi Google sập thì sao

Bạn chọn "dừng thao tác, chờ Sheets trở lại". App làm đúng vậy — nhưng **không**
áp cho mọi thứ, và đây là chỗ tôi cố tình làm khác yêu cầu:

| Thao tác | Khi Google sập |
|---|---|
| Tạo/xoá project, VPS, điểm phát · quét video · tải video lên | **bị chặn**, báo rõ lý do |
| **Dừng live**, Khởi động lại, Dừng tất cả | vẫn chạy |
| Dọn dung lượng, chuẩn hoá video, chuẩn bị VPS | vẫn chạy |
| Watcher tự cứu live bị treo | vẫn chạy |

Lý do: những việc ở nhóm dưới chỉ nói chuyện SSH với VPS của bạn, Google không
liên quan. Nếu chặn cả chúng thì lúc Google sập bạn không tắt được buổi live trên
fanpage của mình — rất tệ nếu đang bị đánh bản quyền — và ổ đĩa đầy cũng không dọn
được. Thay đổi từ các thao tác này vẫn được xếp hàng và đẩy lên Sheet sau.

Danh sách đầy đủ nằm ở `src/middleware/sheets-gate.js`, cố ý gom vào một chỗ để
đọc một lượt là thấy hết.

## Sửa gì được trên Sheet

Sửa được đúng ba thứ:

| Cột | Ở tab |
|---|---|
| `name` | Servers, Videos, Projects, Destinations |
| `note` | Servers, Videos, Projects, Destinations |
| `position` | Playlist (đổi thứ tự phát) |

**Đừng sửa `id`.** Không phải vì khó, mà vì `id` không phải dữ liệu — app dùng nó
để đặt tên systemd unit (`live-manager-<id>.service`) và file chứa stream key
(`/etc/live-manager/dest-<id>.env`) trên VPS. Đổi `id` trên Sheet có thể làm app
mất dấu tiến trình đang phát, tức là mất luôn nút Dừng. Google Sheets cũng không
có ràng buộc khoá ngoại hay chống trùng như database, và kéo chuột xuống một cột
số là đủ để đánh số lại cả cột.

Các cột trạng thái (`status`, `uptime`, `throughput`, `recover_count`…) do app sở
hữu — sửa cũng bị ghi đè ở lần đồng bộ sau.

Xoá một dòng trên Sheet thì app **không tự xoá theo**, mà ghi cảnh báo ở trang
Lịch sử và đưa dòng đó trở lại. Xoá là việc có tác động thật lên VPS, và một buổi
live không được chết vì một dòng bảng tính biến mất.

## Đừng chia sẻ Sheet này cho ai

Tab `Servers` chứa IP, cổng và tên đăng nhập VPS của bạn. Google Sheets còn lưu
**toàn bộ lịch sử sửa đổi vĩnh viễn**, nên thứ đã từng xuất hiện trong ô thì xoá ô
đi cũng không mất. Giữ Sheet ở chế độ chỉ mình bạn xem.
