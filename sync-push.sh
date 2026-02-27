#!/bin/bash
# sync-push.sh — macOS: 변경사항 GitHub에 올리기
cd "$(dirname "$0")"

echo ""
echo "════════════════════════════════════════"
echo "   🚀 MindMap Sync Push (Mac)"
echo "════════════════════════════════════════"
echo ""

# 변경사항 확인
echo "📋 변경사항:"
git status --short
echo ""

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "변경사항 없음. push 불필요."
  exit 0
fi

# 민감정보 정리 (sanitize-db.js 있으면 실행)
if [ -f "src/sanitize-db.js" ]; then
  echo "[1/3] 민감정보 정리 중..."
  node src/sanitize-db.js
  if [ $? -ne 0 ]; then
    echo "❌ 민감정보 정리 실패. push 중단."
    exit 1
  fi
fi

# 커밋 메시지 입력
echo ""
read -p "커밋 메시지 (엔터 = 'Sync: Mac update'): " msg
msg="${msg:-Sync: Mac update $(date '+%Y-%m-%d %H:%M')}"

echo ""
echo "[2/3] 스테이징..."
git add -A

echo "[3/3] 커밋 & 푸시..."
git commit -m "$msg"
git push

echo ""
echo "✅ 푸시 완료: $msg"
echo ""
