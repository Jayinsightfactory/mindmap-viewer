#!/bin/bash
# SessionStart 훅 — Claude Code on the web 세션 준비
#   1) 의존성 설치 (테스트/린터/로컬 작업용)
#   2) 로컬 프리뷰 서버 기동 (포트 4747, launch.json 'orbit-local'과 동일)
#      → 프리뷰 패널이 현재 브랜치 코드를 바로 보여줌 (외부 네트워크 불필요)
set -euo pipefail

# 원격(웹) 세션에서만 동작 — 로컬 개발 환경은 건드리지 않음
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# 1) 의존성 설치 (idempotent — 이미 있으면 빠르게 통과)
npm install --no-audit --no-fund

# 2) 로컬 프리뷰 서버 기동 (이미 떠 있으면 건너뜀)
if ! curl -s -o /dev/null --max-time 2 http://localhost:4747/ 2>/dev/null; then
  PORT=4747 NODE_ENV=development nohup node server.js > /tmp/orbit-server.log 2>&1 &
fi


