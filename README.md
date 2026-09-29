# apps-script-mcp

**Cho Claude làm việc với Google Sheets, và tùy chọn với mọi thứ Apps Script của bạn chạm tới được (Drive, Docs,
Gmail, Calendar…), mà không cần Google Cloud Project, Service Account hay OAuth client.**

```
Claude / MCP client ──OAuth 2.1 / PAT──▶ Docker MCP server ──HMAC──▶ Google Apps Script ──▶ Google Sheets / Workspace
                                          (máy của bạn)               (tài khoản Google của bạn)
```

- **Docker MCP server** nói chuyện với Claude theo giao thức MCP, kiểm tra request và ký request gửi sang Apps Script.
  Nó **không bao giờ** giữ credential Google.
- **Google Apps Script** chạy dưới quyền tài khoản Google của bạn. Chỉ nó chạm vào Sheets, và nó chỉ làm việc
  với các spreadsheet bạn đã cho phép.
- **Tunnel** (Cloudflare Tunnel / ngrok) là tùy chọn, chỉ cần khi muốn Claude trên web kết nối từ Internet.

> English summary: a self-hosted MCP server (Docker) that lets Claude read and write Google Sheets through a Google
> Apps Script you deploy under your own account. There are no Google credentials on the server. MCP clients
> authenticate with OAuth 2.1 or a personal access token. The server authenticates to Apps Script with an HMAC
> secret established by one-time code pairing. Only allowlisted spreadsheets are reachable. See
> [docs/DESIGN.md](docs/DESIGN.md).

## Cài đặt nhanh

### 1. Chạy MCP server

Chỉ cần [Docker Desktop](https://www.docker.com/products/docker-desktop/), không cần Node.js hay Google SDK.
Mở Docker Desktop, rồi chạy **một dòng**:

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.ps1 | iex
```

**macOS / Linux**:
```bash
curl -fsSL https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.sh | sh
```

Script tự tải image, chạy container với đúng port và volume, rồi mở trình duyệt vào **http://localhost:8788**
với setup token đã điền sẵn. Bạn chỉ cần đặt mật khẩu admin.
Muốn nâng cấp, chạy lại đúng dòng đó; dữ liệu (pairing, mật khẩu, token) vẫn được giữ.

<details>
<summary>Cách khác: bấm trên giao diện Docker Desktop, hoặc dùng docker compose</summary>

**Docker Desktop:**
1. Tìm `vannguyen799/apps-script-mcp` và bấm **Run**.
2. Mở **Optional settings** và điền:
   - Ports: `8787` → `8787`, `8788` → `8788`.
   - Volumes: tên `asmcp-data`, đường dẫn trong container là `/data`.
3. Xem setup token ở tab **Logs** của container (dòng `Setup token: …`).

Lưu ý: giao diện Docker Desktop mở cổng admin 8788 cho cả mạng LAN (vẫn cần mật khẩu). Script một dòng ở trên chỉ mở
cổng này cho `localhost`, nên an toàn hơn.

**docker compose** (có tunnel Cloudflare kèm theo):
```bash
curl -fsSLO https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/docker-compose.yml
docker compose up -d
docker compose logs apps-script-mcp | grep "Setup token"
```
</details>

### 2. Triển khai Apps Script (dán 1 file)

1. Vào <https://script.google.com> → **New project**.
2. Copy toàn bộ [`apps-script/Code.gs`](https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/apps-script/Code.gs)
   rồi dán đè vào `Code.gs` trong trình soạn thảo, bấm Lưu.
3. **Deploy → New deployment → Web app**, chọn *Execute as: Me* và *Who has access: Anyone*, rồi cấp quyền bằng tài
   khoản Google của bạn.

Chi tiết và cách cập nhật: [apps-script/README.md](apps-script/README.md).

### 3. Pair hai bên

1. Trong trang admin Docker, dán URL web app (`https://script.google.com/macros/s/…/exec`) và bấm **Tạo mã pairing**.
2. Mở URL web app trên trình duyệt (đăng nhập bằng đúng tài khoản chủ) và nhập mã, ví dụ `7K4P-92XM`.
3. Trạng thái trên Docker chuyển sang **Đã kết nối**. Mã chỉ dùng một lần và hết hạn sau 10 phút.

### 4. Chọn spreadsheet

Trong trang Apps Script, thêm spreadsheet bằng URL hoặc ID. Đặt alias (ví dụ `sales`) và quyền cho từng file:
**chỉ đọc** hoặc **đọc/ghi**. Claude chỉ thấy các file trong danh sách này.

### 5. Kết nối Claude

- **Claude Code / Claude Desktop** (máy local): tạo Personal Access Token trong trang admin, rồi chạy:
  ```bash
  claude mcp add --transport http apps-script http://localhost:8787/mcp --header "Authorization: Bearer asmcp_pat_..."
  ```
- **claude.ai (Custom connector)**: cần một URL HTTPS public, xem [Public qua tunnel](#public-qua-tunnel).
  Sau đó thêm connector với URL `https://<domain>/mcp`. Claude sẽ tự mở trang đăng nhập OAuth, bạn nhập mật khẩu
  admin để cho phép.

Xong. Thử hỏi Claude: *“Đọc Sales!A1:F100 trong spreadsheet sales”*.

## MCP tools

| Tool | Quyền | Mô tả |
|---|---|---|
| `list_spreadsheets` | đọc | Danh sách spreadsheet được phép |
| `list_sheets` | đọc | Các sheet trong một spreadsheet |
| `get_metadata` | đọc | Metadata spreadsheet/sheet (kích thước, frozen, hidden…) |
| `read_range` | đọc | Đọc một vùng A1, ví dụ `Sales!A1:F100` |
| `search` | đọc | Tìm giá trị trong spreadsheet hoặc một sheet |
| `write_range` | ghi | Ghi vào một vùng (kích thước phải khớp, hoặc chỉ ghi một ô neo) |
| `append_rows` | ghi | Thêm dòng vào cuối sheet |
| `batch_update` | ghi | Nhiều thao tác write / append / clear; validate toàn bộ trước khi chạy |

Mặc định không có tool nào chạy code tùy ý (tool `run_apps_script` là tùy chọn, tắt sẵn, xem [Chạy Apps Script](#chạy-apps-script-tùy-chọn-rủi-ro-cao)). Công thức (`=…`, `+…`, `-…`, `@…`) bị từ chối trừ khi gọi với `allow_formulas: true`.

## Chạy Apps Script (tùy chọn, rủi ro cao)

Tool `run_apps_script {code, args?}` cho Claude chạy JavaScript ngay trên Apps Script của bạn, để với tới những thứ ngoài
Sheets (Drive, Docs, Gmail, Lịch...). Mặc định **tắt** và cần bật ở **hai** nơi:

1. **Apps Script**: mở trang quản trị Apps Script (chủ sở hữu), mục *Chạy Apps Script (nâng cao)*, bấm *Bật chạy script*.
   Máy chủ MCP không thể tự bật. Hướng dẫn chi tiết và cách khai báo scope: [apps-script/README.md](apps-script/README.md#chạy-apps-script-tùy-chọn).
2. **Token**: token phải có scope `script.eval`. Scope này không nằm trong mặc định, token và PAT cũ không tự có.

**Rủi ro:**

- **Prompt injection.** Nội dung bảng tính, email hay tệp mà Claude đọc có thể chứa lệnh ẩn khiến nó gọi `run_apps_script`
  với mã do kẻ khác viết.
- **Allowlist bị bỏ qua.** Danh sách bảng tính và quyền đọc/ghi từng file **không** áp dụng cho mã được chạy. Ranh giới thật sự
  là các scope trong `appsscript.json`; hãy xóa những scope bạn không cần (nhất là `script.external_request` và Gmail, vì chúng cho phép đưa dữ liệu ra ngoài).
- Mã chạy với toàn quyền của tài khoản Google của bạn, trong giới hạn 6 phút của Apps Script. Nhật ký trên Apps Script chỉ lưu mã băm của mã (50 lần gần nhất), không lưu nội dung.

**Claude Code / Claude Desktop (PAT).** Trong trang admin, mục *Personal Access Tokens*, tick thêm ô `script.eval` (mặc định không tick)
khi tạo token, rồi thêm connector như ở bước 5 với token đó. Nên tạo một token riêng cho việc này và thu hồi khi không dùng.

**claude.ai (OAuth).** Client tự quyết định xin scope nào; server không tự thêm `script.eval` cho ai. Một client không gửi
`scope` khi xin quyền chỉ nhận mặc định `sheets.read sheets.write` (kể cả khi lúc đăng ký DCR nó khai `scope` chứa `script.eval`),
và metadata OAuth cũng chỉ quảng bá hai scope Sheets. Vì vậy **connector claude.ai chỉ có quyền Sheets** trừ khi bạn dùng đường PAT
ở trên (một PAT có thể dán vào client hỗ trợ header tùy chỉnh). Nếu một client cố tình xin `script.eval`, trang đồng ý sẽ hiện cảnh báo đỏ và bạn vẫn phải nhập mật khẩu admin.

## Public qua tunnel

Chỉ cổng **8787** được phép public (gồm `/mcp`, OAuth, `/healthz`). Trang admin **8788** chỉ bind `127.0.0.1`.

Cách dùng Cloudflare named tunnel (URL cố định):

1. Trong Cloudflare Zero Trust, tạo tunnel và trỏ public hostname tới `http://apps-script-mcp:8787`.
2. Tạo file `.env`:
   ```env
   TUNNEL_TOKEN=...
   PUBLIC_BASE_URL=https://mcp.example.com
   TRUST_PROXY=1
   ```
3. Chạy `docker compose --profile tunnel up -d`.

Quick tunnel (`trycloudflare.com`) hoặc ngrok free cũng chạy được. Nhưng URL đổi sau mỗi lần restart làm hỏng OAuth
issuer, nên chỉ hợp để thử nhanh.

## Bảo mật

Ba lớp credential độc lập, lộ một lớp không lộ lớp khác:

| Lớp | Cơ chế |
|---|---|
| Claude → MCP | OAuth 2.1 + PKCE (DCR, consent cần mật khẩu admin, access token 1h, refresh token xoay vòng có phát hiện reuse) hoặc PAT. Scope `sheets.read` / `sheets.write` (và `script.eval`, chỉ khi xin rõ ràng). Chỉ lưu hash. Không đặt token trong URL. |
| Trang admin | Chỉ loopback, setup token một lần, mật khẩu scrypt, cookie session HttpOnly/SameSite=Strict, CSRF token, kiểm tra Host/Origin, rate-limit. |
| MCP → Apps Script | HMAC-SHA256 trên mọi request (timestamp ±5 phút, nonce chống replay), response cũng được ký. Secret được tạo lúc pairing và không bao giờ hiển thị. |
| Apps Script → Sheets | Quyền Google của chính bạn. Allowlist kiểm tra *trước khi* mở file, và quyền ghi tách riêng cho từng file. |

Log không ghi secret, token, mật khẩu, mã pairing, nội dung ô hay query tìm kiếm.
Để báo lỗ hổng bảo mật, vui lòng mở một private security advisory trên GitHub.

## Phát triển

```bash
cd apps-script && npm test && npm run test:bundle   # test Apps Script trên Node (src/ và bản gộp Code.gs)
cd server && npm ci && npm run build && npm test    # server, gồm test chéo với code Apps Script thật
docker compose up -d --build                        # build image từ source
```

Image được build tự động lên `ghcr.io/vannguyen799/apps-script-mcp`, và lên Docker Hub `vannguyen799/apps-script-mcp` khi repo có secret
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` (`edge` từ `main`; `x.y.z` / `latest` khi push tag `vX.Y.Z`).

Kiến trúc: tầng tool/business chỉ phụ thuộc vào port `SheetsGateway`. Apps Script chỉ là một adapter, nên sau này có
thể thay bằng Google OAuth hoặc Service Account mà không phải sửa tool.

## License

[MIT](LICENSE)
