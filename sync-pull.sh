#!/bin/bash
# sync-pull.sh — macOS: 최신 코드 가져오기
cd "$(dirname "$0")"

echo ""
echo "════════════════════════════════════════"
echo "   🔄 MindMap Sync Pull (Mac)"
echo "════════════════════════════════════════"
echo ""

# 로컬 변경사항 있으면 경고
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  커밋 안 된 변경사항이 있습니다:"
  git status --short
  echo ""
  read -p "계속 pull하시겠습니까? (y/N) " answer
  [[ "$answer" != "y" && "$answer" != "Y" ]] && echo "취소됨." && exit 0
fi

echo "📥 최신 코드 가져오는 중..."
git pull --rebase

echo ""
echo "✅ 동기화 완료"
echo ""
echo "서버 시작: bash start.sh"
echo ""
