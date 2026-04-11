#!/bin/bash
# deploy.sh — Google Drive → Git → Railway 자동 배포 스크립트
# 사용법: ./deploy.sh [커밋 메시지]
set -e

DRIVE_PATH="/Users/darlene/Library/CloudStorage/GoogleDrive-dlaww@kicda.com/내 드라이브/mindmap-viewer/"
GIT_PATH="/Users/darlene/mindmap-viewer/"
PROD_URL="https://mindmap-viewer-production-adb2.up.railway.app"

cd "$GIT_PATH"

echo "═══════════════════════════════════════════════════"
echo " Orbit AI 배포 스크립트"
echo "═══════════════════════════════════════════════════"

# ── Phase 1: 안전 체크 ──────────────────────────────────────────────────────
echo ""
echo "📋 Phase 1: 안전 체크"

# Git 미커밋 변경 있으면 stash
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  echo "⚠️  미커밋 변경 감지 — stash 저장"
  git stash push -m "pre-deploy-$(date +%Y%m%d-%H%M%S)"
  echo "   복구: git stash pop"
fi

# 롤백 태그 생성
TAG="pre-deploy-$(date +%Y%m%d-%H%M%S)"
git tag "$TAG" 2>/dev/null || true
echo "🏷  롤백 태그: $TAG"

# ── Phase 2: Drive → Git 동기화 ─────────────────────────────────────────────
echo ""
echo "📂 Phase 2: Google Drive → Git 동기화"

rsync -av \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  --exclude='conversation-backup' \
  --exclude='.claude' \
  --exclude='snapshots' \
  --exclude='scripts' \
  --delete \
  "$DRIVE_PATH" "$GIT_PATH" 2>&1 | tail -20

echo ""
echo "📊 변경 파일:"
git diff --stat

# ── Phase 3: 배포 전 검증 ──────────────────────────────────────────────────
echo ""
echo "🔍 Phase 3: 배포 전 검증"
node scripts/validate.js || { echo "🚫 검증 실패 — 배포 중단"; exit 1; }

# ── Phase 4: 캐시 버스터 통일 ──────────────────────────────────────────────
echo ""
echo "🔄 Phase 4: 캐시 버스터 통일"
node scripts/build-version.js

# ── Phase 5: 커밋 & 푸시 ──────────────────────────────────────────────────
echo ""
echo "🚀 Phase 5: 커밋 & 푸시"

git add -A
CHANGES=$(git diff --cached --stat)
if [ -z "$CHANGES" ]; then
  echo "변경 사항 없음 — 배포 건너뜀"
  exit 0
fi

echo "$CHANGES"
echo ""

# 커밋 메시지
MSG="${1:-deploy: $(date +%Y-%m-%d\ %H:%M)}"
git commit -m "$MSG"
git push origin main

# ── Phase 6: 배포 확인 ─────────────────────────────────────────────────────
echo ""
echo "⏳ Phase 6: Railway 배포 대기 (30초)..."
sleep 30

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PROD_URL")
if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ 프로덕션 정상 (HTTP $HTTP_CODE)"
  echo "🌐 $PROD_URL"
else
  echo "⚠️  프로덕션 응답: HTTP $HTTP_CODE"
  echo "   롤백: git revert HEAD && git push origin main"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo " 배포 완료"
echo "═══════════════════════════════════════════════════"
