#!/bin/bash
# start.sh — macOS 서버 시작 스크립트
# Claude MindMap Viewer + 선택적 Cloudflare 터널
#
# 사용법:
#   bash start.sh          # 서버만 시작 (로컬)
#   bash start.sh --tunnel # 서버 + cloudflared 터널

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# ── Node.js 경로 자동 탐색 ──────────────────────────
if ! command -v node &>/dev/null; then
  # nvm 사용 환경
  NVM_NODE="$HOME/.nvm/versions/node"
  if [ -d "$NVM_NODE" ]; then
    LATEST=$(ls "$NVM_NODE" | sort -V | tail -1)
    export PATH="$NVM_NODE/$LATEST/bin:$PATH"
  fi
  # Homebrew 환경
  if [ -d "/opt/homebrew/bin" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
fi

if ! command -v node &>/dev/null; then
  echo "❌ node를 찾을 수 없습니다. Node.js를 설치하세요."
  echo "   brew install node  또는  https://nodejs.org"
  exit 1
fi

PORT="${PORT:-4747}"
TUNNEL=false
if [[ "$1" == "--tunnel" ]]; then
  TUNNEL=true
fi

echo ""
echo "════════════════════════════════════════"
echo "   Claude MindMap Viewer"
echo "   Node: $(node --version)"
echo "════════════════════════════════════════"
echo ""

# ── 의존성 확인 ─────────────────────────────────────
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "📦 node_modules 없음 → npm install 실행 중..."
  npm install
fi

# ── 서버 시작 (백그라운드) ──────────────────────────
echo "[1/2] 서버 시작 중... (포트 $PORT)"
node server.js &
SERVER_PID=$!

# 서버 준비 대기
sleep 1.5

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "❌ 서버가 시작되지 않았습니다."
  exit 1
fi

echo "✅ 서버 실행 중 (PID: $SERVER_PID)"
echo "   로컬: http://localhost:$PORT"
echo ""

# ── 브라우저 자동 열기 ───────────────────────────────
if command -v open &>/dev/null; then
  sleep 0.5
  open "http://localhost:$PORT" &
fi

# ── 터널 (선택) ─────────────────────────────────────
if $TUNNEL; then
  if ! command -v cloudflared &>/dev/null; then
    echo "⚠️  cloudflared 미설치 — 터널 없이 로컬로 실행"
    echo "   설치: brew install cloudflared"
  else
    echo "[2/2] Cloudflare 터널 시작 중..."
    echo "   터널 주소는 아래에 표시됩니다:"
    echo "════════════════════════════════════════"
    echo ""
    cloudflared tunnel --url "http://localhost:$PORT"
  fi
else
  echo "   터널 없이 실행 중 (종료: Ctrl+C)"
  echo "════════════════════════════════════════"
  # 서버 프로세스를 포그라운드로 유지
  wait "$SERVER_PID"
fi

# ── 종료 처리 ────────────────────────────────────────
trap 'echo ""; echo "🛑 종료 중..."; kill "$SERVER_PID" 2>/dev/null; exit 0' INT TERM
