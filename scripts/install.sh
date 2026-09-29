#!/bin/sh
# gsheets-mcp installer for macOS / Linux.
# Usage:  curl -fsSL https://raw.githubusercontent.com/vannguyen799/gsheets-mcp/main/scripts/install.sh | sh
set -eu
IMAGE="${GSMCP_IMAGE:-ghcr.io/vannguyen799/gsheets-mcp:edge}"
NAME=gsheets-mcp

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker and run this again."; exit 1; }

echo "Pulling $IMAGE ..."
docker pull -q "$IMAGE" >/dev/null
# Re-running upgrades in place: the named volume keeps pairing, password and tokens.
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p 8787:8787 -p 127.0.0.1:8788:8788 -v gsmcp-data:/data "$IMAGE" >/dev/null

i=0
until curl -fsS http://localhost:8787/healthz >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 1; done

TOKEN=$(docker logs "$NAME" 2>&1 | sed -n 's/^Setup token: \([^ ]*\).*/\1/p' | tail -n 1)
URL="http://localhost:8788/"
[ -n "$TOKEN" ] && URL="http://localhost:8788/#setup=$TOKEN"
echo "Done. Open: $URL"
(command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true
