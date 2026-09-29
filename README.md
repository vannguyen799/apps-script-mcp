# gsheets-mcp

**Cho Claude đọc và ghi Google Sheets, mà không cần Google Cloud Project, Service Account hay OAuth client.**

```
Claude / MCP client ──OAuth 2.1 / PAT──▶ Docker MCP server ──HMAC──▶ Google Apps Script ──▶ Google Sheets
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

Chỉ cần Docker, không cần Node.js hay Google SDK.

```bash
mkdir gsheets-mcp && cd gsheets-mcp
curl -fsSLO https://raw.githubusercontent.com/vannguyen799/gsheets-mcp/main/docker-compose.yml
docker compose up -d
docker compose logs gsheets-mcp | grep "Setup token"
```

Mở **http://localhost:8788**, nhập setup token và đặt mật khẩu admin.

### 2. Triển khai Apps Script

Làm theo [apps-script/README.md](apps-script/README.md): tạo project, dán code, rồi Deploy → Web app với
*Execute as: Me* và *Who has access: Anyone*. Khi Google hỏi quyền, bạn cấp bằng tài khoản của mình.

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
  claude mcp add --transport http gsheets http://localhost:8787/mcp --header "Authorization: Bearer gsmcp_pat_..."
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

Không có tool nào chạy code tùy ý. Công thức (`=…`, `+…`, `-…`, `@…`) bị từ chối trừ khi gọi với `allow_formulas: true`.

## Public qua tunnel

Chỉ cổng **8787** được phép public (gồm `/mcp`, OAuth, `/healthz`). Trang admin **8788** chỉ bind `127.0.0.1`.

Cách dùng Cloudflare named tunnel (URL cố định):

1. Trong Cloudflare Zero Trust, tạo tunnel và trỏ public hostname tới `http://gsheets-mcp:8787`.
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
| Claude → MCP | OAuth 2.1 + PKCE (DCR, consent cần mật khẩu admin, access token 1h, refresh token xoay vòng có phát hiện reuse) hoặc PAT. Scope `sheets.read` / `sheets.write`. Chỉ lưu hash. Không đặt token trong URL. |
| Trang admin | Chỉ loopback, setup token một lần, mật khẩu scrypt, cookie session HttpOnly/SameSite=Strict, CSRF token, kiểm tra Host/Origin, rate-limit. |
| MCP → Apps Script | HMAC-SHA256 trên mọi request (timestamp ±5 phút, nonce chống replay), response cũng được ký. Secret được tạo lúc pairing và không bao giờ hiển thị. |
| Apps Script → Sheets | Quyền Google của chính bạn. Allowlist kiểm tra *trước khi* mở file, và quyền ghi tách riêng cho từng file. |

Log không ghi secret, token, mật khẩu, mã pairing, nội dung ô hay query tìm kiếm.
Để báo lỗ hổng bảo mật, vui lòng mở một private security advisory trên GitHub.

## Phát triển

```bash
cd apps-script && npm test                          # test Apps Script trên Node (mock Google services)
cd server && npm ci && npm run build && npm test    # server, gồm test chéo với code Apps Script thật
docker compose up -d --build                        # build image từ source
```

Image được build tự động lên `ghcr.io/vannguyen799/gsheets-mcp` (`edge` từ `main`; `x.y.z` / `latest` khi push tag `vX.Y.Z`).

Kiến trúc: tầng tool/business chỉ phụ thuộc vào port `SheetsGateway`. Apps Script chỉ là một adapter, nên sau này có
thể thay bằng Google OAuth hoặc Service Account mà không phải sửa tool.

## License

[MIT](LICENSE)
