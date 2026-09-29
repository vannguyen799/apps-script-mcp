# gsheets-mcp: phần Google Apps Script

Đây là thành phần duy nhất chạm vào Google Sheets. Nó chạy dưới danh nghĩa tài khoản Google của bạn, giữ danh sách bảng tính được phép (allowlist) và chỉ chấp nhận các yêu cầu có chữ ký HMAC từ máy chủ MCP (Docker). Đặc tả giao thức: `docs/DESIGN.md` mục 4 và 5.

## Cấu trúc

| Tệp | Vai trò |
|---|---|
| `src/Code.js` | `doGet`, `doPost` và các hàm quản trị `admin_*` (mỗi hàm gọi `assertOwner_()` trước) |
| `src/Auth.js` | HMAC, so sánh hằng thời gian, ghép nối, xác thực yêu cầu, chống replay, ký phản hồi |
| `src/Actions.js` | Danh sách action cố định và các thao tác Sheets |
| `src/A1.js` | Phân tích ký hiệu A1 |
| `src/Store.js` | Lưu allowlist và thông tin ghép nối trong ScriptProperties |
| `src/Admin.html` | Trang quản trị dành cho chủ sở hữu |
| `src/appsscript.json` | Manifest (V8, scope tối thiểu) |

## Triển khai từng bước

### 1. Tạo dự án Apps Script

1. Đăng nhập tài khoản Google mà bạn muốn cấp quyền truy cập bảng tính (đây sẽ là "chủ sở hữu").
2. Mở <https://script.google.com> và chọn **Dự án mới** (New project). Đặt tên, ví dụ `gsheets-mcp`.
3. Đưa mã nguồn vào dự án, chọn một trong hai cách:

**Cách A: dán thủ công**

- Trong trình soạn thảo, mở **Cài đặt dự án** (biểu tượng bánh răng) và bật **Hiển thị tệp kê khai "appsscript.json" trong trình chỉnh sửa**.
- Dán nội dung `src/appsscript.json` vào tệp `appsscript.json`.
- Với mỗi tệp `.js`: tạo tệp script cùng tên (bỏ đuôi, ví dụ `Code`, `Auth`, `Actions`, `A1`, `Store`) và dán nội dung. Xóa tệp `Code.gs` mặc định nếu trùng tên.
- Tạo tệp HTML tên `Admin` (**Tệp > + > HTML**) và dán nội dung `src/Admin.html`.

**Cách B: dùng `clasp`**

```bash
npm install -g @google/clasp
clasp login
cd apps-script/src
clasp create --type webapp --title gsheets-mcp   # hoặc: clasp clone <scriptId>
clasp push
```

(`clasp` tự đổi `.js` thành `.gs` khi đẩy lên; giữ nguyên `appsscript.json`.)

### 2. Triển khai Web app

1. Nhấn **Triển khai > Tùy chọn triển khai mới** (Deploy > New deployment).
2. Chọn loại **Ứng dụng web** (Web app).
3. Cấu hình:
   - **Thực thi với tư cách (Execute as):** `Tôi` (Me)
   - **Người có quyền truy cập (Who has access):** `Bất kỳ ai` (Anyone)
4. Nhấn **Triển khai**. Google sẽ yêu cầu cấp quyền: chọn tài khoản, **Advanced > Go to gsheets-mcp (unsafe) > Allow**. Chỉ có hai quyền: Google Sheets và địa chỉ email. Không cần quyền Drive.
5. Sao chép **URL ứng dụng web**, có dạng `https://script.google.com/macros/s/<id>/exec`.

> "Anyone" là bắt buộc để máy chủ MCP gọi được mà không cần đăng nhập Google. An toàn nằm ở chữ ký HMAC trong từng yêu cầu: nếu chưa ghép nối hoặc chữ ký sai, không có gì được thực thi.

### 3. Mở trang quản trị

Mở URL ứng dụng web ở trên trong trình duyệt **khi đang đăng nhập bằng đúng tài khoản chủ sở hữu**. Trang quản trị chỉ hiển thị cho chủ sở hữu; người ẩn danh hoặc tài khoản khác sẽ thấy "Truy cập bị từ chối".

### 4. Ghép nối với máy chủ MCP

1. Mở trang quản trị của máy chủ Docker (`http://127.0.0.1:8788`).
2. Dán URL ứng dụng web vào ô Apps Script URL và nhấn **Pair**. Máy chủ hiển thị mã ghép nối dạng `XXXX-XXXX` (hiệu lực 10 phút).
3. Ở trang quản trị Apps Script, nhập mã vào mục **Nhập mã ghép nối** rồi nhấn **Xác nhận mã**.
4. Trong vài giây máy chủ Docker sẽ tự xác nhận và chuyển sang trạng thái `connected`. Trang Apps Script hiển thị **Đã ghép nối**.

Nhập sai mã 5 lần thì mã bị hủy; hãy tạo mã mới ở máy chủ và nhập lại. Nút **Hủy ghép nối** xóa khóa bí mật; sau đó cần ghép nối lại.

### 5. Thêm bảng tính

Máy chủ MCP chỉ truy cập được các bảng tính nằm trong danh sách này (mặc định là rỗng).

1. Ở mục **Bảng tính được phép**, dán URL hoặc ID của bảng tính, đặt alias (tùy chọn) và chọn quyền **Chỉ đọc** hoặc **Đọc và ghi**.
2. Nhấn **Thêm**. Script mở thử bảng tính để kiểm tra; tài khoản chủ sở hữu phải có quyền truy cập bảng tính đó.
3. Có thể **Sửa** alias/quyền hoặc **Xóa** bất cứ lúc nào. Các thao tác ghi cần quyền **Đọc và ghi**.

Danh sách lưu trong ScriptProperties (giới hạn khoảng 9 KB, đủ cho khoảng vài chục bảng tính).

## Cập nhật mã nguồn

Sau khi sửa mã, việc lưu hoặc `clasp push` **chưa** ảnh hưởng đến URL `/exec` đang chạy. Bạn phải tạo phiên bản mới:

1. **Triển khai > Quản lý bản triển khai** (Manage deployments).
2. Nhấn biểu tượng bút chì (Chỉnh sửa) ở bản triển khai hiện có.
3. Ở **Phiên bản**, chọn **Phiên bản mới** rồi nhấn **Triển khai**.

Cách này giữ nguyên URL, nên không cần ghép nối lại và cấu hình Docker không đổi. Nếu chọn **Tùy chọn triển khai mới** thì URL sẽ đổi và phải ghép nối lại. Nếu thay đổi `appsscript.json` (thêm quyền) bạn sẽ được yêu cầu cấp quyền lại.

## Kiểm thử cục bộ

Không cần cài gói nào (Node 20 trở lên):

```bash
cd apps-script
npm test
```

Bộ kiểm thử nạp `src/*.js` vào một sandbox `vm` với bản giả lập của `Utilities`, `PropertiesService`, `CacheService`, `LockService`, `Session`, `ContentService` và `SpreadsheetApp` (trong bộ nhớ). Xem chú thích đầu `test/harness.js` để tái sử dụng (`createSandbox`).

## Lưu ý bảo mật

- Khóa HMAC nằm trong ScriptProperties của dự án. Ai sửa được dự án Apps Script đều đọc được, vì vậy không chia sẻ quyền chỉnh sửa dự án.
- Mã ghép nối, khóa bí mật và nội dung ô không bao giờ được ghi log.
- Allowlist được kiểm tra trước khi mở bảng tính; lỗi nội bộ (`INTERNAL`) không kèm dữ liệu hay stack trace.
- Giới hạn của Apps Script (thời gian chạy, hạn mức) vẫn áp dụng. `batch.update` kiểm tra tất cả thao tác trước khi thực hiện, nhưng Google Sheets không có giao dịch: nếu Sheets báo lỗi giữa chừng, các thao tác trước đó vẫn được giữ lại.
