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

# Built-in tunnel settings (DESIGN.md 11) are passed through only when set in your shell. `-e NAME` takes the value from
# the environment, so tokens never appear on the command line.
$envArgs = @()
foreach ($v in 'TUNNEL', 'CLOUDFLARE_TUNNEL_TOKEN', 'NGROK_AUTHTOKEN', 'NGROK_DOMAIN', 'PUBLIC_BASE_URL') {
  if ([Environment]::GetEnvironmentVariable($v)) { $envArgs += '-e'; $envArgs += $v }
}

# Re-running upgrades in place: the named volume keeps pairing, password and tokens.
docker rm -f $Name *> $null
docker run -d --name $Name --restart unless-stopped `
  -p 38787:38787 `
  -v asmcp-data:/data @envArgs $Image | Out-Null

Write-Host 'Dang khoi dong ...'
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:38787/healthz | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

# Only the first start prints a generated password; with an existing owner (upgrade) the line is absent.
$login = docker logs $Name 2>&1 | Select-String -Pattern '^Admin login:.*' | Select-Object -Last 1
if ($login) { Write-Host $login.Matches[0].Value } else { Write-Host 'Dung tai khoan admin hien co' }

$url = 'http://localhost:38787/account'
if ($env:TUNNEL -and $env:TUNNEL -ne 'off') {
  $public = $null
  for ($i = 0; $i -lt 30 -and -not $public; $i++) {
    $m = docker logs $Name 2>&1 | Select-String -Pattern '^Public URL: (https://\S+)/mcp$' | Select-Object -Last 1
    if ($m) { $public = $m.Matches[0].Groups[1].Value } else { Start-Sleep -Seconds 1 }
  }
  if ($public) { Write-Host "Public URL: $public/mcp"; $url = "$public/account" } else { Write-Host "Tunnel chua co URL: xem 'docker logs $Name'." }
}
Write-Host "Xong! Mo trang: $url" -ForegroundColor Green
Start-Process $url
