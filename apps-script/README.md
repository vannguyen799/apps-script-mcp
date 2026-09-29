# apps-script-mcp: phần Google Apps Script

Đây là thành phần duy nhất chạm vào Google Sheets. Nó chạy dưới danh nghĩa tài khoản Google của bạn, giữ danh sách bảng tính được phép (allowlist) và chỉ chấp nhận các yêu cầu có chữ ký HMAC từ máy chủ MCP (Docker). Đặc tả giao thức: `docs/DESIGN.md` mục 4, 5 và 9.3.

## Cấu trúc

| Tệp | Vai trò |
|---|---|
| `src/Code.js` | `doGet`, `doPost` và các hàm quản trị `admin_*` (mỗi hàm gọi `assertOwner_()` trước) |
| `src/Setup.js` | Một dòng `ASMCP_SETUP_` (mặc định `null`). Máy chủ MCP thay dòng này khi tạo `Code.gs` cá nhân hóa; nằm đầu bản gộp |
| `src/Auth.js` | HMAC, so sánh hằng thời gian, ghép nối, xác thực yêu cầu, chống replay, ký phản hồi |
| `src/Actions.js` | Danh sách action cố định và các thao tác Sheets |
| `src/A1.js` | Phân tích ký hiệu A1 |
| `src/Store.js` | Lưu allowlist và các ghép nối (tối đa 20) trong ScriptProperties |
| `src/Eval.js` | Chạy script tùy chọn (`script.eval`), tắt mặc định, nhật ký chỉ lưu mã băm |
| `src/Admin.html` | Trang quản trị dành cho chủ sở hữu |
| `src/appsscript.json` | Manifest (V8, scope tối thiểu) |
| `appsscript.full.example.json` | Manifest mẫu có thêm scope Docs, Drive, Gmail, Lịch... (chỉ dùng khi bật chạy script) |
| `Code.gs` | Bản gộp 1 file để dán (sinh bằng `npm run bundle`, không sửa tay) |

## Triển khai từng bước

### Cách chính: dán `Code.gs` cá nhân hóa từ trang MCP (không phải gõ mã nào)

1. Mở trang **Thêm Apps Script** trên máy chủ MCP (`/account`, hoặc trang admin của máy chủ) rồi bấm **Tải / Copy Code.gs**.
   Tệp này là `Code.gs` đã gắn sẵn một mã cài đặt dùng một lần (khối `ASMCP_SETUP_`), hết hạn sau 30 phút.
2. Đăng nhập tài khoản Google mà bạn muốn cấp quyền truy cập bảng tính, rồi mở <https://script.new>.
3. Chọn toàn bộ nội dung `Code.gs` trong trình soạn thảo (Ctrl+A), dán **đè** tệp vừa copy. Bấm Lưu.
4. **Triển khai** → **Tùy chọn triển khai mới** → loại **Ứng dụng web**:
   *Thực thi dưới dạng*: **Tôi**; *Người có quyền truy cập*: **Bất kỳ ai**. Bấm Triển khai và cấp quyền khi được hỏi.
5. Copy URL web app (kết thúc bằng `/exec`) và **dán lại vào trang MCP**. Máy chủ tự ghép nối với script qua khối cài đặt; bạn không nhập mã nào.
6. Mở URL web app (đã đăng nhập bằng tài khoản chủ sở hữu) để thêm bảng tính vào danh sách được phép, xem [Thêm bảng tính](#5-thêm-bảng-tính).
   Trước khi ghép nối xong, trang quản trị hiển thị "Script này đã sẵn sàng kết nối với <máy chủ>"; sau đó hiển thị "Đã kết nối".

Mã cài đặt chỉ dùng được **một lần** (kể cả khi ghép nối lỗi giữa chừng thì bạn vẫn có thể thử lại cho đến khi thành công). Nhập sai chứng thực
5 lần, hoặc quá hạn, mã bị hủy: hãy tạo `Code.gs` mới từ trang MCP. Không chia sẻ `Code.gs` cá nhân hóa cho người khác trước khi dùng.

### `Code.gs` chung: để cập nhật

Bản chung (không có mã cài đặt) là <https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/apps-script/Code.gs>. Dùng nó để **cập nhật** script đã cài:
dán đè lên `Code.gs`, lưu, rồi **Triển khai** → **Quản lý bản triển khai** → sửa bản hiện có → **Phiên bản mới**. URL giữ nguyên nên không phải ghép nối lại
(các ghép nối được lưu trong ScriptProperties). Bản chung không tự ghép nối được: nó không có khối cài đặt.

### Kết nối script đã cài với một máy chủ MCP khác (luồng nhập mã)

Một script ghép nối được với tối đa **20** máy chủ MCP cùng lúc (mỗi máy chủ có khóa riêng; hủy một cái không ảnh hưởng các cái còn lại).
Khi script đã cài sẵn (mọi phiên bản có hỗ trợ mục 9.3), hãy dùng luồng nhập mã: dán URL web app vào máy chủ MCP muốn thêm, máy chủ hiển thị mã
`XXXX-XXXX`, rồi nhập mã ở mục **Nhập mã ghép nối** của trang quản trị Apps Script. Chi tiết ở mục [Ghép nối](#4-ghép-nối-với-máy-chủ-mcp).

Không bắt buộc sửa `appsscript.json`: Google tự nhận diện quyền cần thiết (`spreadsheets`, `userinfo.email`).
Nếu muốn khóa đúng scope tối thiểu, bật hiển thị manifest trong **Cài đặt dự án** và dán `src/appsscript.json`.

Các mục dưới đây là cách cài chi tiết (nhiều file hoặc dùng `clasp`), dành cho người phát triển. Với cách cài này, hãy ghép nối bằng luồng nhập mã (mục 4).

### 1. Tạo dự án Apps Script

1. Đăng nhập tài khoản Google mà bạn muốn cấp quyền truy cập bảng tính (đây sẽ là "chủ sở hữu").
2. Mở <https://script.google.com> và chọn **Dự án mới** (New project). Đặt tên, ví dụ `apps-script-mcp`.
3. Đưa mã nguồn vào dự án, chọn một trong hai cách:

**Cách A: dán thủ công**

- Trong trình soạn thảo, mở **Cài đặt dự án** (biểu tượng bánh răng) và bật **Hiển thị tệp kê khai "appsscript.json" trong trình chỉnh sửa**.
- Dán nội dung `src/appsscript.json` vào tệp `appsscript.json`.
- Với mỗi tệp `.js`: tạo tệp script cùng tên (bỏ đuôi, ví dụ `Setup`, `Code`, `Auth`, `Actions`, `A1`, `Store`) và dán nội dung. Xóa tệp `Code.gs` mặc định nếu trùng tên.
- Tạo tệp HTML tên `Admin` (**Tệp > + > HTML**) và dán nội dung `src/Admin.html`.

**Cách B: dùng `clasp`**

```bash
npm install -g @google/clasp
clasp login
cd apps-script/src
clasp create --type webapp --title apps-script-mcp   # hoặc: clasp clone <scriptId>
clasp push
```

(`clasp` tự đổi `.js` thành `.gs` khi đẩy lên; giữ nguyên `appsscript.json`.)

### 2. Triển khai Web app

1. Nhấn **Triển khai > Tùy chọn triển khai mới** (Deploy > New deployment).
2. Chọn loại **Ứng dụng web** (Web app).
3. Cấu hình:
   - **Thực thi với tư cách (Execute as):** `Tôi` (Me)
   - **Người có quyền truy cập (Who has access):** `Bất kỳ ai` (Anyone)
4. Nhấn **Triển khai**. Google sẽ yêu cầu cấp quyền: chọn tài khoản, **Advanced > Go to apps-script-mcp (unsafe) > Allow**. Chỉ có hai quyền: Google Sheets và địa chỉ email. Không cần quyền Drive.
5. Sao chép **URL ứng dụng web**, có dạng `https://script.google.com/macros/s/<id>/exec`.

> "Anyone" là bắt buộc để máy chủ MCP gọi được mà không cần đăng nhập Google. An toàn nằm ở chữ ký HMAC trong từng yêu cầu: nếu chưa ghép nối hoặc chữ ký sai, không có gì được thực thi.

### 3. Mở trang quản trị

Mở URL ứng dụng web ở trên trong trình duyệt **khi đang đăng nhập bằng đúng tài khoản chủ sở hữu**. Trang quản trị chỉ hiển thị cho chủ sở hữu; người ẩn danh hoặc tài khoản khác sẽ thấy "Truy cập bị từ chối".

### 4. Ghép nối với máy chủ MCP

1. Mở trang quản trị của máy chủ Docker (`http://127.0.0.1:8788`).
2. Dán URL ứng dụng web vào ô Apps Script URL và nhấn **Pair**. Máy chủ hiển thị mã ghép nối dạng `XXXX-XXXX` (hiệu lực 10 phút).
3. Ở trang quản trị Apps Script, nhập mã vào mục **Nhập mã ghép nối** rồi nhấn **Xác nhận mã**.
4. Trong vài giây máy chủ Docker sẽ tự xác nhận và chuyển sang trạng thái `connected`. Trang Apps Script hiển thị **Đã ghép nối**.

Nhập sai mã 5 lần thì mã bị hủy; hãy tạo mã mới ở máy chủ và nhập lại. Trang quản trị liệt kê mọi máy chủ đã ghép nối; nút **Hủy ghép nối** ở từng dòng xóa khóa bí mật của riêng máy chủ đó (các máy chủ khác vẫn chạy); máy chủ bị hủy cần ghép nối lại. Ghép nối lại cùng một máy chủ (cùng `instanceId`) sẽ thay thế mục cũ của nó. Nếu script còn khóa ghép nối kiểu cũ (một máy chủ), nó được tự chuyển vào danh sách này.

### 5. Thêm bảng tính

Máy chủ MCP chỉ truy cập được các bảng tính nằm trong danh sách này (mặc định là rỗng).

1. Ở mục **Bảng tính được phép**, dán URL hoặc ID của bảng tính, đặt alias (tùy chọn) và chọn quyền **Chỉ đọc** hoặc **Đọc và ghi**.
2. Nhấn **Thêm**. Script mở thử bảng tính để kiểm tra; tài khoản chủ sở hữu phải có quyền truy cập bảng tính đó.
3. Có thể **Sửa** alias/quyền hoặc **Xóa** bất cứ lúc nào. Các thao tác ghi cần quyền **Đọc và ghi**.

Danh sách lưu trong ScriptProperties (giới hạn khoảng 9 KB, đủ cho khoảng vài chục bảng tính).

## Chạy Apps Script (tùy chọn)

Mặc định máy chủ MCP chỉ dùng được các action cố định trên bảng tính trong allowlist. Nếu bạn muốn Claude với tới cả Drive, Docs,
Gmail, Lịch..., có thể bật action `script.eval` (tool `run_apps_script` phía máy chủ). Đây là ngoại lệ có chủ đích, và **rủi ro cao**.

### Cách bật

1. Mở trang quản trị Apps Script (URL web app, đăng nhập bằng tài khoản chủ sở hữu).
2. Ở mục **Chạy Apps Script (nâng cao)**, đọc cảnh báo rồi bấm **Bật chạy script**. Chỉ chủ sở hữu bật/tắt được; máy chủ MCP và người ẩn danh thì không.
3. Tạo token có scope `script.eval` (PAT: tick ô `script.eval` trong trang admin của máy chủ). Xem [README gốc](../README.md#chạy-apps-script-tùy-chọn-rủi-ro-cao).
4. Muốn tắt: bấm lại nút ở mục trên. Có hiệu lực ngay.

Trang quản trị cũng hiện 50 lần chạy gần nhất (thời gian, mã băm SHA-256 của mã, kết quả, thời lượng). Nhật ký **không** lưu mã, tham số
hay kết quả; ai cần biết mã nào đã chạy thì đối chiếu mã băm. `ping` báo `evalEnabled` để trang admin của máy chủ hiển thị "Chạy script: bật/tắt".

### Scope trong appsscript.json mới là ranh giới thật sự

Allowlist bảng tính **không** áp dụng cho mã được chạy: mã có thể mở bất kỳ bảng tính nào tài khoản của bạn mở được. Điều duy nhất giới hạn
mã là **các scope OAuth khai báo trong `appsscript.json`**: mã chỉ gọi được dịch vụ nào có scope tương ứng. Vì vậy hãy khai báo đúng những gì bạn muốn, không hơn.
Mã cũng đọc được `PropertiesService` của dự án (kể cả khóa HMAC), nên chỉ bật khi bạn chấp nhận rủi ro này.

`src/appsscript.json` (mặc định) chỉ có `spreadsheets` và `userinfo.email`. Với các scope này, mã chạy được cũng chỉ làm việc với Sheets.

### Dùng appsscript.full.example.json

1. Trong **Cài đặt dự án**, bật **Hiển thị tệp kê khai "appsscript.json" trong trình chỉnh sửa**.
2. Mở `appsscript.full.example.json` (thư mục `apps-script/`), copy nội dung và dán đè vào tệp `appsscript.json` trong trình soạn thảo.
3. **Xóa các dòng scope bạn không muốn** trước khi lưu. Mẫu khai báo: `spreadsheets`, `documents`, `drive`, `gmail.readonly`, `calendar`,
   `script.external_request`, `userinfo.email`. Đừng giữ dư "cho tiện": mỗi scope là một cánh cửa mở cho mã do Claude viết.
   - **`script.external_request` và Gmail là hai thứ rủi ro nhất**, vì cho phép đưa dữ liệu ra ngoài (gọi `UrlFetchApp` tới máy chủ bất kỳ, gửi hoặc đọc email). Nếu không thật sự cần, xóa chúng đầu tiên.
   - `drive` là toàn bộ Drive (đọc, sửa, xóa, chia sẻ). Nếu đủ dùng, hãy thay bằng `drive.readonly` hoặc `drive.file`.
4. Lưu, rồi **Triển khai > Quản lý bản triển khai > Sửa > Phiên bản mới**. Bạn sẽ được yêu cầu cấp quyền lại; URL giữ nguyên nên không cần ghép nối lại.

Muốn thu hẹp lại: sửa `appsscript.json` bỏ scope, triển khai phiên bản mới, và (tùy chọn) thu hồi quyền cũ tại <https://myaccount.google.com/permissions>.

### Giới hạn

- `code` tối đa 100 000 ký tự; là thân của một hàm, được chạy với `args` và `log`, và phải `return` giá trị JSON được (tối đa 4 MB sau khi tuần tự hóa; `undefined` thành `null`).
- `log(...)`: mỗi dòng tối đa 2 000 ký tự, tối đa 200 dòng.
- Lỗi được trả về dạng `EVAL_ERROR` kèm log đã ghi trước khi lỗi. Đây là lỗi duy nhất có thể chứa dữ liệu, vì chính bạn yêu cầu chạy mã.
- Apps Script dừng mọi lần chạy sau 6 phút, và một lần chạy quá thời gian sẽ không kịp ghi vào nhật ký.

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

- Mã cài đặt nằm trong chính `Code.gs` cá nhân hóa (biến `ASMCP_SETUP_`): coi tệp đó như một bí mật cho đến khi ghép nối xong. Mã dùng một lần, có hạn, và bị hủy sau 5 lần thử sai; trang quản trị không bao giờ hiển thị nó.
- Khóa HMAC nằm trong ScriptProperties của dự án. Ai sửa được dự án Apps Script đều đọc được, vì vậy không chia sẻ quyền chỉnh sửa dự án.
- Mã ghép nối, khóa bí mật và nội dung ô không bao giờ được ghi log.
- Allowlist được kiểm tra trước khi mở bảng tính; lỗi nội bộ (`INTERNAL`) không kèm dữ liệu hay stack trace.
- Chạy script (`script.eval`) tắt mặc định và bỏ qua allowlist khi bật; xem [Chạy Apps Script](#chạy-apps-script-tùy-chọn).
- Giới hạn của Apps Script (thời gian chạy, hạn mức) vẫn áp dụng. `batch.update` kiểm tra tất cả thao tác trước khi thực hiện, nhưng Google Sheets không có giao dịch: nếu Sheets báo lỗi giữa chừng, các thao tác trước đó vẫn được giữ lại.
