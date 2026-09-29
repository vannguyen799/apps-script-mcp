# apps-script-mcp installer for Windows (Docker Desktop).
# Usage (PowerShell):  irm https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Image = if ($env:ASMCP_IMAGE) { $env:ASMCP_IMAGE } else { 'ghcr.io/vannguyen799/apps-script-mcp:edge' }
$Name = 'apps-script-mcp'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Chua co Docker. Cai Docker Desktop: https://www.docker.com/products/docker-desktop/' -ForegroundColor Red
  return
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker Desktop chua chay. Hay mo Docker Desktop roi chay lai lenh nay.' -ForegroundColor Red; return }

Write-Host "Dang tai image $Image ..."
docker pull $Image | Out-Null

# Re-running upgrades in place: the named volume keeps pairing, password and tokens.
docker rm -f $Name *> $null
docker run -d --name $Name --restart unless-stopped `
  -p 8787:8787 -p 127.0.0.1:8788:8788 `
  -v asmcp-data:/data $Image | Out-Null

Write-Host 'Dang khoi dong ...'
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:8787/healthz | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

$token = (docker logs $Name 2>&1 | Select-String -Pattern 'Setup token: (\S+)' | Select-Object -Last 1).Matches.Groups[1].Value
$url = if ($token) { "http://localhost:8788/#setup=$token" } else { 'http://localhost:8788/' }
Write-Host "Xong! Mo trang cai dat: http://localhost:8788" -ForegroundColor Green
Start-Process $url
