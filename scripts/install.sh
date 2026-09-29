#!/bin/sh
# apps-script-mcp installer for macOS / Linux.
# Usage:  curl -fsSL https://raw.githubusercontent.com/vannguyen799/apps-script-mcp/main/scripts/install.sh | sh
set -eu
IMAGE="${ASMCP_IMAGE:-ghcr.io/vannguyen799/apps-script-mcp:edge}"
NAME=apps-script-mcp

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker and run this again."; exit 1; }

echo "Pulling $IMAGE ..."
docker pull -q "$IMAGE" >/dev/null
# Built-in tunnel settings (DESIGN.md 11) are passed through only when set in your shell. `-e NAME` takes the value from
# the environment, so tokens never appear on the command line.
for v in TUNNEL CLOUDFLARE_TUNNEL_TOKEN NGROK_AUTHTOKEN NGROK_DOMAIN PUBLIC_BASE_URL; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && set -- "$@" -e "$v"
done
# Re-running upgrades in place: the named volume keeps pairing, password and tokens.
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p 8787:8787 -p 127.0.0.1:8788:8788 -v asmcp-data:/data "$@" "$IMAGE" >/dev/null

i=0
until curl -fsS http://localhost:8787/healthz >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 1; done

# Only the first start prints a generated password; with an existing owner (upgrade) the line is absent.
LOGIN=$(docker logs "$NAME" 2>&1 | grep '^Admin login:' | tail -n 1 || true)
if [ -n "$LOGIN" ]; then echo "$LOGIN"; else echo "Dùng tài khoản admin hiện có"; fi

URL="http://localhost:8788/"
if [ -n "${TUNNEL:-}" ] && [ "${TUNNEL}" != off ]; then
  PUBLIC=""
  i=0
  while [ -z "$PUBLIC" ] && [ $i -lt 30 ]; do
    PUBLIC=$(docker logs "$NAME" 2>&1 | sed -n 's|^Public URL: \(https://[^ ]*\)/mcp$|\1|p' | tail -n 1)
    [ -n "$PUBLIC" ] || { i=$((i+1)); sleep 1; }
  done
  if [ -n "$PUBLIC" ]; then echo "Public URL: $PUBLIC/mcp"; URL="$PUBLIC/account"; else echo "The tunnel has no URL yet: check 'docker logs $NAME'."; fi
fi
echo "Done. Open: $URL"
(command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true
