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

FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    APPS_SCRIPT_BUNDLE_PATH=/app/apps-script/Code.gs
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/package.json ./
# The single-file Apps Script bundle; the server personalises it per "add Apps Script" session (DESIGN.md 9.2).
COPY apps-script/Code.gs /app/apps-script/Code.gs
# /data is created owned by the non-root user so a fresh named volume inherits that ownership.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/main.js"]
