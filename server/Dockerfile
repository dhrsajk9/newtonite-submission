# Built from the repository root (see docker-compose.yml), in two stages.

# ── Stage 1: build the web app into static files ─────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── Stage 2: the server (API and worker), which also serves the web app ──────
FROM node:22-alpine
WORKDIR /app

# Install dependencies first so Docker can cache this layer between code changes.
COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json server/vitest.config.ts ./
COPY server/src ./src
COPY server/test ./test
COPY --from=web /web/dist ./public

EXPOSE 3000
# Apply migrations and seed data (both are safe to re-run), then start the API.
CMD ["sh", "-c", "npm run setup && npm start"]
