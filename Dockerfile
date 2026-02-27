# ═══════════════════════════════════════════════════
# MindMap Viewer — Dockerfile
# Multi-stage build: 빌드 → 런타임 분리
# ═══════════════════════════════════════════════════

# ── 1단계: 의존성 설치 ──────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# better-sqlite3 빌드를 위한 네이티브 툴
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# ── 2단계: 런타임 ────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# 실행에 필요한 네이티브 라이브러리
RUN apk add --no-cache libstdc++

# 의존성 복사
COPY --from=deps /app/node_modules ./node_modules

# 소스 복사 (node_modules 제외)
COPY . .

# 데이터 디렉토리 생성 + 권한
RUN mkdir -p data snapshots && chmod 755 data snapshots

# 포트
EXPOSE 4747

# 헬스체크
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4747/health || exit 1

# 비루트 사용자
RUN addgroup -S mindmap && adduser -S mindmap -G mindmap
RUN chown -R mindmap:mindmap /app
USER mindmap

ENV NODE_ENV=production \
    PORT=4747

CMD ["node", "server.js"]
