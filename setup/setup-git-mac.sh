#!/bin/bash
# setup-git-mac.sh
# GitHub PAT(Personal Access Token) 설정 스크립트 (macOS)
#
# 사용법:
#   bash setup/setup-git-mac.sh
#
# 사전 준비:
#   1. https://github.com/settings/tokens/new 접속
#   2. Note: mindmap-viewer, Expiration: 원하는 기간
#   3. Scopes: [repo] 체크 → Generate token
#   4. 토큰 복사 후 이 스크립트 실행

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo ""
echo "════════════════════════════════════════"
echo "   GitHub PAT 설정 (macOS osxkeychain)"
echo "════════════════════════════════════════"
echo ""

# Git 사용자 정보 확인
GIT_USER=$(git config --global user.name 2>/dev/null || echo "")
GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")

if [ -z "$GIT_USER" ]; then
  echo -n "GitHub 사용자 이름 입력: "
  read GIT_USER
  git config --global user.name "$GIT_USER"
fi

if [ -z "$GIT_EMAIL" ]; then
  echo -n "GitHub 이메일 입력: "
  read GIT_EMAIL
  git config --global user.email "$GIT_EMAIL"
fi

echo "✓ 사용자: $GIT_USER <$GIT_EMAIL>"
echo ""

# PAT 입력
echo "GitHub Personal Access Token (PAT) 입력:"
echo "  (https://github.com/settings/tokens 에서 생성)"
echo -n "  토큰: "
read -s PAT
echo ""

if [ -z "$PAT" ]; then
  echo "❌ 토큰이 비어있습니다."
  exit 1
fi

# Git credentials 설정 (credential.helper = osxkeychain)
REMOTE=$(git remote get-url origin)
HOST=$(echo "$REMOTE" | sed 's|https://||' | cut -d'/' -f1)

# osxkeychain에 저장
echo "protocol=https
host=$HOST
username=$GIT_USER
password=$PAT" | git credential approve

echo "✅ 키체인에 저장 완료"
echo ""

# push 테스트
echo "--- push 테스트 ---"
git push origin main 2>&1

echo ""
echo "════════════════════════════════════════"
echo "   완료! 이후 push는 자동 인증됩니다."
echo "════════════════════════════════════════"
