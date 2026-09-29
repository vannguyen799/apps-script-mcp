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
> Apps Script you deploy under your own account. There are no Google credentials on the server. The server is for
> personal use: one owner account; you pair one or more Apps Script "connections" once (by pasting a personalised
> `Code.gs`, no code to type) and later just pick one when connecting Claude. MCP clients
> authenticate with OAuth 2.1 (login + connection picker) or a personal access token bound to one connection. The
> server authenticates to Apps Script with an HMAC secret. Only allowlisted spreadsheets are reachable. See
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

Script tự tải image, chạy container với đúng port và volume, in ra dòng đăng nhập rồi mở trình duyệt vào **http://localhost:8788**:
```
Admin login: admin / <mật khẩu ngẫu nhiên 20 ký tự>  (đổi mật khẩu trong /account)
```
Đây là tài khoản **chủ sở hữu**, tạo ở lần chạy đầu tiên. Hãy đổi mật khẩu ngay ở mục *Đổi mật khẩu* của `/account` hoặc trang admin.
Chạy lại script khi đã có tài khoản thì không có dòng đó và script in "Dùng tài khoản admin hiện có".
Nếu shell đã đặt sẵn `TUNNEL`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, `CLOUDFLARE_TUNNEL_TOKEN` hoặc `PUBLIC_BASE_URL`, script chuyển chúng
vào container (xem [Public qua tunnel](#public-qua-tunnel)), rồi in URL public (`Public URL: …`) và mở `/account` trên URL đó.
Muốn nâng cấp, chạy lại đúng dòng đó; dữ liệu (tài khoản, kết nối Apps Script, token) vẫn được giữ. Bản cũ (một script duy nhất)
tự được chuyển sang định dạng mới: mật khẩu admin thành tài khoản `admin`, script cũ thành một kết nối, token và PAT cũ vẫn dùng được
(bản sao file cũ nằm ở `state.json.v1.bak` trong volume `/data`).

<details>
<summary>Cách khác: bấm trên giao diện Docker Desktop, hoặc dùng docker compose</summary>

**Docker Desktop:**
1. Tìm `kortisol/apps-script-mcp` và bấm **Run**.
2. Mở **Optional settings** và điền:
   - Ports: `8787` → `8787`, `8788` → `8788`.
   - Volumes: tên `asmcp-data`, đường dẫn trong container là `/data`.
3. Xem dòng đăng nhập ở tab **Logs** của container (`Admin login: admin / …`).

Lưu ý: giao diện Docker Desktop mở cổng admin 8788 cho cả mạng LAN (vẫn cần mật khẩu). Script một dòng ở trên chỉ mở
cổng này cho `localhost`, nên an toàn hơn.

**docker compose**:
```bash
curl -fsSLO https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/docker-compose.yml
docker compose up -d
docker compose logs apps-script-mcp | grep "Admin login"
```
</details>

### 2. Đăng nhập

Mở trang tài khoản và đăng nhập bằng tài khoản chủ sở hữu vừa tạo:

- máy local: **http://localhost:8787/account**;
- khi đã có tunnel: `https://<domain>/account` (URL public lấy từ tunnel tích hợp, `PUBLIC_BASE_URL` hoặc trang admin, xem [Public qua tunnel](#public-qua-tunnel)).

Server này dành cho **một người dùng**: chỉ có tài khoản chủ sở hữu, không có thành viên hay lời mời. Nếu bản cũ của bạn từng có thành viên,
khi khởi động lần đầu với bản mới, các thành viên cùng kết nối, token và PAT của họ bị xóa (log ghi `users_pruned` kèm số lượng).

Muốn tự chọn mật khẩu ban đầu thay vì mật khẩu ngẫu nhiên (ví dụ triển khai tự động), xem [Tạo chủ sở hữu từ biến môi trường](#tạo-chủ-sở-hữu-từ-biến-môi-trường).

### 3. Kết nối một Apps Script (dán 1 file, không nhập mã)

Làm một lần cho mỗi script (mỗi script là một tài khoản Google):

1. Ở trang `/account` bấm **Thêm Apps Script**, rồi **Tải Code.gs** hoặc **Copy Code.gs**. File này đã được cá nhân hóa cho lần thêm này.
2. Mở <https://script.new>, xóa nội dung mặc định của `Code.gs`, dán file vừa lấy vào và lưu.
3. **Deploy → New deployment → Web app**, chọn *Execute as: Me* và *Who has access: Anyone*, rồi cấp quyền bằng tài khoản Google của bạn.
4. Copy URL web app (`https://script.google.com/macros/s/…/exec`) và dán vào trang `/account`, bấm **Kết nối**.
5. Trạng thái chuyển sang **Đã kết nối**. Phiên thêm Apps Script hết hạn sau 30 phút.

Nếu bạn triển khai lại cùng một script (URL đổi), cứ thêm lại: server nhận ra đó là cùng script và cập nhật kết nối cũ
(token và PAT đang dùng vẫn chạy), không tạo bản mới.

<details>
<summary>Script đã cài sẵn từ trước (dùng mã ghép nối)</summary>

Dành cho script đã có bản `Code.gs` mới nhưng chưa ghép với server này. Ở trang **Thêm Apps Script**, mục *Cách 2*: dán URL web app và bấm
**Tạo mã ghép cặp**; mở trang quản trị Apps Script (đăng nhập bằng đúng tài khoản chủ) và nhập mã `XXXX-XXXX` hiện ra. Mã dùng một lần, hết hạn sau 10 phút.

Chi tiết và cách cập nhật script: [apps-script/README.md](apps-script/README.md).
</details>

### 4. Chọn spreadsheet

Trong trang Apps Script, thêm spreadsheet bằng URL hoặc ID. Đặt alias (ví dụ `sales`) và quyền cho từng file:
**chỉ đọc** hoặc **đọc/ghi**. Claude chỉ thấy các file trong danh sách này.

### 5. Kết nối Claude

- **claude.ai (Custom connector)**: cần một URL HTTPS public, xem [Public qua tunnel](#public-qua-tunnel).
  Thêm connector với URL `https://<domain>/mcp`. Claude mở trang cấp quyền: **đăng nhập** bằng tài khoản của bạn, **chọn Apps Script**
  muốn dùng (lần sau kết nối, script dùng gần nhất được chọn sẵn; có thể **Thêm Apps Script mới** ngay tại đó) rồi bấm **Cho phép**.
  Không cần ghép nối lại.
- **Claude Code / Claude Desktop** (máy local): ở trang `/account`, mục *Personal Access Tokens*, chọn kết nối, tick quyền và tạo token, rồi chạy:
  ```bash
  claude mcp add --transport http apps-script http://localhost:8787/mcp --header "Authorization: Bearer asmcp_pat_..."
  ```
  Mỗi PAT gắn với đúng một kết nối Apps Script. Xóa kết nối thì các token gắn với nó báo lỗi *"Kết nối Apps Script đã bị xóa, hãy kết nối lại"*.

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

**Claude Code / Claude Desktop (PAT).** Ở trang `/account`, mục *Personal Access Tokens*, tick thêm ô `script.eval` (mặc định không tick)
khi tạo token, rồi thêm connector như ở bước 5 với token đó. Nên tạo một token riêng cho việc này và thu hồi khi không dùng.

**claude.ai (OAuth).** Client tự quyết định xin scope nào; server không tự thêm `script.eval` cho ai. Một client không gửi
`scope` khi xin quyền chỉ nhận mặc định `sheets.read sheets.write` (kể cả khi lúc đăng ký DCR nó khai `scope` chứa `script.eval`),
và metadata OAuth cũng chỉ quảng bá hai scope Sheets. Vì vậy **connector claude.ai chỉ có quyền Sheets** trừ khi bạn dùng đường PAT
ở trên (một PAT có thể dán vào client hỗ trợ header tùy chỉnh). Nếu một client cố tình xin `script.eval`, trang đồng ý sẽ hiện cảnh báo đỏ và bạn vẫn phải đăng nhập và bấm Cho phép.

## Lưu trữ: file hay PostgreSQL

Mặc định server lưu trạng thái (tài khoản, kết nối Apps Script, token dạng hash, số liệu dùng) trong file `state.json` ở `DATA_DIR` (volume `/data`), ghi nguyên tử, quyền `0600`.
Muốn dùng PostgreSQL, đặt `DATABASE_URL`:

```env
DATABASE_URL=postgres://asmcp:mat-khau@postgres:5432/asmcp
```

- TLS theo tham số của URL (ví dụ `?sslmode=require`); không có biến riêng cho TLS.
- Server tự tạo bảng `asmcp_state` (một dòng: `doc jsonb`, `updated_at`). Cơ sở dữ liệu chỉ dành cho **một instance server**: không có cơ chế phát hiện hai server cùng ghi, bản ghi sau ghi đè bản trước.
- Lần khởi động đầu với database còn trống, nếu `DATA_DIR/state.json` tồn tại thì nó được nhập vào một lần (file cũ định dạng v1 vẫn được chuyển sang v2) và log ghi `state_imported_from_file`. File được giữ nguyên, không bị sửa; sau đó database là nguồn duy nhất.
- Không đặt `DATABASE_URL` thì mọi thứ chạy như trước, không cần PostgreSQL.

Với docker compose có sẵn một PostgreSQL tùy chọn (profile `postgres`, không mở cổng ra ngoài): đặt `POSTGRES_PASSWORD` và `DATABASE_URL` trong `.env` (xem `.env.example`), rồi chạy `docker compose --profile postgres up -d`.

## Tài khoản chủ sở hữu

Ở lần khởi động đầu, khi chưa có chủ sở hữu, server tự tạo tài khoản: tên đăng nhập `ADMIN_USERNAME` (mặc định `admin`) và mật khẩu
`ADMIN_PASSWORD` nếu bạn đặt, nếu không thì một mật khẩu ngẫu nhiên 20 ký tự. Mật khẩu ngẫu nhiên được in **một lần** ra stdout của
container (dòng `Admin login: <tên> / <mật khẩu>`, xem bằng `docker logs apps-script-mcp`), không đi qua logger, và chỉ lưu hash scrypt.

```env
ADMIN_USERNAME=admin        # mặc định admin
ADMIN_PASSWORD=mat-khau-dai-it-nhat-10-ky-tu   # bỏ trống = mật khẩu ngẫu nhiên; khi đặt thì không in ra
```

- Chỉ dùng khi **chưa có** chủ sở hữu. Các lần khởi động sau bỏ qua hai biến này và **không bao giờ ghi đè** mật khẩu.
- `ADMIN_PASSWORD` ngắn hơn 10 ký tự thì server báo lỗi và không khởi động.
- **Đổi mật khẩu:** mục *Đổi mật khẩu* trên `/account` hoặc trang admin (mật khẩu hiện tại + mật khẩu mới tối thiểu 10 ký tự + nhập lại).
  Giới hạn thử sai như đăng nhập. Mọi phiên đăng nhập khác bị đăng xuất, phiên hiện tại được giữ. Nếu đặt `ADMIN_PASSWORD`, hãy xóa nó khỏi `.env` sau khi đổi.

### Quên mật khẩu

Lệnh `reset-password` đặt mật khẩu ngẫu nhiên mới cho chủ sở hữu, xóa mọi phiên đăng nhập và in `Admin login: …`.
Server ghi lại toàn bộ trạng thái khi tắt, nên **phải dừng container trước** (lệnh từ chối chạy nếu thấy server đang chạy):

```bash
docker stop apps-script-mcp
docker run --rm -v asmcp-data:/data ghcr.io/vannguyen799/apps-script-mcp:edge node dist/cli.js reset-password
docker start apps-script-mcp
```

Với docker compose: `docker compose stop apps-script-mcp && docker compose run --rm apps-script-mcp node dist/cli.js reset-password && docker compose up -d`
(đọc `.env`, nên dùng được cả với PostgreSQL). Với `docker run` và PostgreSQL, thêm `-e DATABASE_URL`.

## Lượt dùng

Server đếm mỗi lần Claude gọi một tool: theo **ngày (UTC)** và **tên tool**, gồm số lượt và số lỗi, giữ 30 ngày. Xem ở bảng *Lượt dùng 30 ngày* trên `/account` và trên trang admin.
Chỉ có tên tool và hai con số: không ghi tài khoản, kết nối, token, vùng ô, dữ liệu, câu tìm kiếm, mã hay nội dung lỗi.
Bộ đếm gom trong bộ nhớ và ghi vào trạng thái mỗi 60 giây và khi tắt server, nên nếu server sập đột ngột có thể mất tối đa một phút số liệu.

## Public qua tunnel

Chỉ cổng **8787** được phép public (gồm `/mcp`, OAuth, `/account`, `/healthz`). Trang admin **8788** chỉ bind `127.0.0.1`.
Vì `/account` và trang cấp quyền nằm trên cổng public, chỉ chủ sở hữu (đăng nhập bằng tài khoản trên server) mới kết nối được Claude.

Container có sẵn tunnel, bật bằng biến môi trường (trong `.env` hoặc `-e`), không cần service riêng. Khi có URL, log in ra
`Public URL: https://…/mcp`, và URL đó được dùng làm base URL (thứ tự ưu tiên: `PUBLIC_BASE_URL` > URL của tunnel > giá trị lưu ở trang admin).
Khi bật tunnel, server chỉ tin `X-Forwarded-For` từ loopback (`TRUST_PROXY` mặc định `loopback`), nên IP giả không qua được.
Tunnel tự khởi động lại (chờ 1 giây, tăng gấp đôi tới 60 giây) nếu bị dừng; token truyền qua biến môi trường của tiến trình con, không nằm trên dòng lệnh.

**Khuyên dùng: ngrok với domain tĩnh miễn phí** (URL không đổi, không cần domain riêng). Tài khoản ngrok free có một static domain:

```env
TUNNEL=ngrok
NGROK_AUTHTOKEN=...                        # dashboard.ngrok.com > Your Authtoken
NGROK_DOMAIN=ten-cua-ban.ngrok-free.app    # dashboard.ngrok.com > Domains, chỉ tên miền, không có https://
```

**Cloudflare named tunnel** (cho ai có domain riêng, URL cố định): tạo tunnel trong Cloudflare Zero Trust, đặt public hostname trỏ
tới `http://localhost:8787`, rồi:

```env
TUNNEL=cloudflare
CLOUDFLARE_TUNNEL_TOKEN=...
PUBLIC_BASE_URL=https://mcp.example.com    # bắt buộc, đúng hostname đã cấu hình trong dashboard
```

**Cloudflare quick tunnel** (`TUNNEL=cloudflare`, không token) chỉ để thử: URL `*.trycloudflare.com` ngẫu nhiên và **đổi sau mỗi lần khởi động lại**,
làm hỏng connector trên claude.ai (URL là OAuth issuer) nên phải thêm lại mỗi lần.

Kiểm tra cấu hình khi khởi động: `TUNNEL` phải là `off`/`cloudflare`/`ngrok`; `ngrok` cần `NGROK_AUTHTOKEN`; `NGROK_DOMAIN` chỉ là hostname.
Dùng script cài đặt thì đặt các biến này trong shell trước khi chạy (xem [Cài đặt](#1-chạy-mcp-server)).

## Bảo mật

Ba lớp credential độc lập, lộ một lớp không lộ lớp khác:

| Lớp | Cơ chế |
|---|---|
| Claude → MCP | OAuth 2.1 + PKCE (DCR; trang cấp quyền yêu cầu đăng nhập tài khoản trên server và chọn kết nối của chính bạn; access token 1h, refresh token xoay vòng có phát hiện reuse) hoặc PAT. Grant, token và PAT gắn với `{tài khoản, kết nối}`: mỗi lệnh gọi chỉ đi tới kết nối đó, không bao giờ lấy từ tham số của tool. Scope `sheets.read` / `sheets.write` (và `script.eval`, chỉ khi xin rõ ràng). Chỉ lưu hash. Không đặt token trong URL. |
| Tài khoản (`/account`, cổng public) | Mật khẩu scrypt, cookie session `HttpOnly; SameSite=Lax` (+`Secure` khi base URL là https) chỉ lưu hash, CSRF token theo phiên, kiểm tra Origin, rate-limit 5 lần sai / 15 phút theo IP **và** theo tên đăng nhập, scrypt giả cho tên không tồn tại. |
| Trang admin | Chủ sở hữu, chỉ loopback, mật khẩu scrypt (mật khẩu ngẫu nhiên in một lần ở lần chạy đầu), cookie session HttpOnly/SameSite=Strict, CSRF token, kiểm tra Host/Origin, rate-limit. |
| MCP → Apps Script | HMAC-SHA256 trên mọi request (timestamp ±5 phút, nonce chống replay), response cũng được ký. Secret được tạo lúc pairing và không bao giờ hiển thị. |
| Apps Script → Sheets | Quyền Google của chính bạn. Allowlist kiểm tra *trước khi* mở file, và quyền ghi tách riêng cho từng file. |

Log không ghi secret, token, mật khẩu, mã pairing, nội dung ô hay query tìm kiếm.
Để báo lỗ hổng bảo mật, vui lòng mở một private security advisory trên GitHub.

## Phát triển

```bash
cd apps-script && npm test && npm run test:bundle   # test Apps Script trên Node (src/ và bản gộp Code.gs)
cd server && npm ci && npm run build && npm test    # server, gồm test chéo với code Apps Script thật
docker compose up -d --build                        # build image từ source (build context là thư mục gốc repo)
docker build -f server/Dockerfile -t apps-script-mcp .   # hoặc build trực tiếp; image chứa cả apps-script/Code.gs
```

Image được build tự động lên `ghcr.io/vannguyen799/apps-script-mcp`, và lên Docker Hub `kortisol/apps-script-mcp` khi repo có secret
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` (`edge` từ `main`; `x.y.z` / `latest` khi push tag `vX.Y.Z`).

Kiến trúc: tầng tool/business chỉ phụ thuộc vào port `SheetsGateway`. Apps Script chỉ là một adapter, nên sau này có
thể thay bằng Google OAuth hoặc Service Account mà không phải sửa tool.

## License

[MIT](LICENSE)
