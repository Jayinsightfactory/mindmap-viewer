#!/bin/bash
# SessionStart 훅 — Claude Code on the web 세션 준비
#   1) 의존성 설치 (테스트/린터/로컬 작업용)
#   2) 프리뷰 디스패처 기동 (포트 4747, launch.json 'orbit-preview'와 동일)
#      preview-launch.js가 배포웹 도달 여부를 보고 프록시/로컬을 자동 선택:
#        - Railway 도달 가능  → 배포웹 중계 (네트워크 허용목록 설정된 경우)
#        - 도달 불가          → 로컬 브랜치 서버
set -euo pipefail

# 원격(웹) 세션에서만 동작 — 로컬 개발 환경은 건드리지 않음
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# 1) 의존성 설치 (idempotent — 이미 있으면 빠르게 통과)
npm install --no-audit --no-fund

# 2) 프리뷰 디스패처 기동 (이미 떠 있으면 건너뜀)
if ! curl -s -o /dev/null --max-time 2 http://localhost:4747/ 2>/dev/null; then
  PORT=4747 nohup node scripts/preview-launch.js > /tmp/orbit-preview.log 2>&1 &
fi


