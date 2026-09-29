# gsheets-mcp

Let Claude read and write Google Sheets through a Google Apps Script you deploy under your own account.
No Google Cloud project, service account or OAuth client is needed, and no Google credential ever lives in this container.

## Quick start

Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/vannguyen799/gsheets-mcp/main/scripts/install.ps1 | iex
```

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/vannguyen799/gsheets-mcp/main/scripts/install.sh | sh
```

Or run it yourself:
```bash
docker run -d --name gsheets-mcp --restart unless-stopped \
  -p 8787:8787 -p 127.0.0.1:8788:8788 -v gsmcp-data:/data vannguyen799/gsheets-mcp
```

- `8787`: the MCP endpoint (`/mcp`) plus OAuth. This is the only port to expose through a tunnel.
- `8788`: the admin UI. Keep it on localhost. The one-time setup token is printed in the container logs.

Full guide, security model and Apps Script setup: https://github.com/vannguyen799/gsheets-mcp
