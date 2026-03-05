# ─────────────────────────────────────────────────────────────────────────────
# Orbit AI — Dockerfile  (멀티스테이지)
# ─────────────────────────────────────────────────────────────────────────────

# ── 1단계: 네이티브 패키지 빌드 (bcrypt, better-sqlite3) ──────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# bcrypt + better-sqlite3 컴파일에 필요한 빌드툴
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package*.json ./
RUN npm ci --omit=dev

# ── 2단계: 프로덕션 런타임 이미지 ─────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# tini: PID 1 신호 처리 / curl: HEALTHCHECK
RUN apk add --no-cache tini curl libstdc++

# 빌드된 node_modules 복사
COPY --from=deps /app/node_modules ./node_modules

# 소스 복사 (node_modules, data/, .git/ 제외 → .dockerignore)
COPY . .

# 데이터/스냅샷 디렉토리 준비
RUN mkdir -p data snapshots && chmod 755 data snapshots

ENV NODE_ENV=production \
    PORT=4747 \
    AUTH_DISABLED=0

EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:4747/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
