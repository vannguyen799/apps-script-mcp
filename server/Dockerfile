# syntax=docker/dockerfile:1
# Build context is the REPOSITORY ROOT (the image also ships apps-script/Code.gs):
#   docker build -f server/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/scripts ./scripts
COPY server/src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Tunnel binaries (DESIGN.md 11), taken from the vendors' official multi-arch images at pinned versions.
# Bump by changing the tags; the version check in the final stage fails the build if a binary is missing or broken.
FROM cloudflare/cloudflared:2026.9.3 AS cloudflared
FROM ngrok/ngrok:3.39.11-alpine AS ngrok

FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    APPS_SCRIPT_BUNDLE_PATH=/app/apps-script/Code.gs
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=ngrok /bin/ngrok /usr/local/bin/ngrok
RUN cloudflared --version && ngrok version
# The single-file Apps Script bundle; the server personalises it per "add Apps Script" session (DESIGN.md 9.2).
COPY apps-script/Code.gs /app/apps-script/Code.gs
# /data is created owned by the non-root user so a fresh named volume inherits that ownership.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 38787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:38787/healthz || exit 1
CMD ["node", "dist/main.js"]
