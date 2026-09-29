# apps-script-mcp

Let Claude read and write Google Sheets through a Google Apps Script you deploy under your own account.
No Google Cloud project, service account or OAuth client is needed, and no Google credential ever lives in this container.

## Quick start

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.ps1 | iex
```

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.sh | sh
```

Or run it yourself:
```bash
docker run -d --name apps-script-mcp --restart unless-stopped \
  -p 38787:38787 -v asmcp-data:/data kortisol/apps-script-mcp
```

- `38787`: the single port. It serves the MCP endpoint (`/mcp`), OAuth and the `/account` page (`/` redirects there);
  open `http://localhost:38787/account`. This is the port to expose through a tunnel. On first start the log prints `Admin login: admin / <random password>` once
  (`docker logs apps-script-mcp`); change it under "Đổi mật khẩu" in `/account`. Lost it: stop the container, then
  `docker run --rm -v asmcp-data:/data kortisol/apps-script-mcp node dist/cli.js reset-password`, and start it again.

### Built-in tunnel (optional)

Pass environment variables and the container exposes port 38787 itself; the URL is printed as `Public URL: https://.../mcp`.

```bash
# ngrok with a free static domain: a stable URL (recommended)
docker run -d --name apps-script-mcp --restart unless-stopped -p 38787:38787 -v asmcp-data:/data \
  -e TUNNEL=ngrok -e NGROK_AUTHTOKEN=... -e NGROK_DOMAIN=my-name.ngrok-free.app kortisol/apps-script-mcp
```

- `TUNNEL=ngrok` needs `NGROK_AUTHTOKEN`; `NGROK_DOMAIN` is a bare hostname (your free static domain).
- `TUNNEL=cloudflare` + `CLOUDFLARE_TUNNEL_TOKEN` + `PUBLIC_BASE_URL`: a Cloudflare named tunnel on your own domain.
- `TUNNEL=cloudflare` alone: a quick tunnel for trying things out. Its URL changes on every restart, which breaks claude.ai connectors.
- `PUBLIC_BASE_URL`, when set, wins over the tunnel's URL.

Full guide, security model and Apps Script setup: https://github.com/vannguyen799/apps-script-mcp
