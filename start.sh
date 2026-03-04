#!/bin/bash
# start.sh — macOS 서버 시작 스크립트
# Claude MindMap Viewer + 선택적 Cloudflare 터널
#
# 사용법:
#   bash start.sh          # 서버만 시작 (로컬)
#   bash start.sh --tunnel # 서버 + cloudflared 터널 (외부 공유용)

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# ── Node.js 경로 자동 탐색 ──────────────────────────
if ! command -v node &>/dev/null; then
  NVM_NODE="$HOME/.nvm/versions/node"
  if [ -d "$NVM_NODE" ]; then
    LATEST=$(ls "$NVM_NODE" | sort -V | tail -1)
    export PATH="$NVM_NODE/$LATEST/bin:$PATH"
  fi
  for BREW_PATH in "/opt/homebrew/bin" "/usr/local/bin"; do
    [ -d "$BREW_PATH" ] && export PATH="$BREW_PATH:$PATH"
  done
fi

if ! command -v node &>/dev/null; then
  echo "❌ node를 찾을 수 없습니다. Node.js를 설치하세요."
  echo "   https://nodejs.org"
  exit 1
fi

# ── cloudflared 경로 탐색 (~/bin, homebrew, 시스템) ──
if ! command -v cloudflared &>/dev/null; then
  for CF_PATH in "$HOME/bin" "$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    if [ -x "$CF_PATH/cloudflared" ]; then
      export PATH="$CF_PATH:$PATH"
      break
    fi
  done
fi

PORT="${PORT:-4747}"
TUNNEL=false
[[ "$1" == "--tunnel" ]] && TUNNEL=true

echo ""
echo "════════════════════════════════════════"
echo "   🧠 Claude MindMap Viewer v2.0"
echo "   Node: $(node --version)"
echo "════════════════════════════════════════"
echo ""

# ── 의존성 확인 ─────────────────────────────────────
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "📦 node_modules 없음 → npm install 실행 중..."
  npm install
fi

# ── 종료 처리 ────────────────────────────────────────
cleanup() {
  echo ""
  echo "🛑 종료 중..."
  kill "$SERVER_PID" 2>/dev/null
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ── 서버 시작 (백그라운드) ──────────────────────────
echo "[1/2] 서버 시작 중... (포트 $PORT)"
node server.js &
SERVER_PID=$!

sleep 1.5

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "❌ 서버가 시작되지 않았습니다."
  exit 1
fi

echo "✅ 서버 실행 중 (PID: $SERVER_PID)"
echo "   로컬: http://localhost:$PORT"
echo ""

# ── 브라우저 자동 열기 ───────────────────────────────
command -v open &>/dev/null && open "http://localhost:$PORT" &

# ── 터널 (선택) ─────────────────────────────────────
if $TUNNEL; then
  if ! command -v cloudflared &>/dev/null; then
    echo "⚠️  cloudflared 미설치"
    echo ""
    echo "   설치 방법 (한 번만):"
    echo "   brew install cloudflared"
    echo "   또는: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar xz -C ~/bin"
    echo ""
    echo "   터널 없이 로컬에서만 실행합니다..."
    wait "$SERVER_PID"
  else
    echo "[2/2] Cloudflare 터널 시작 중..."
    echo ""
    echo "   ⏳ 터널 URL이 잠시 후 표시됩니다..."
    echo "   📋 표시된 https://xxxxx.trycloudflare.com 주소를 팀원에게 공유하세요"
    echo "   ⚠️  Ctrl+C 하면 터널과 서버가 함께 종료됩니다"
    echo ""
    echo "════════════════════════════════════════"

    # cloudflared 실행 + URL 감지해서 클립보드 복사
    cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | tee /tmp/cf-tunnel.log | while IFS= read -r line; do
      echo "$line"
      # trycloudflare.com URL 감지 → 클립보드 복사
      if echo "$line" | grep -qo 'https://[a-z0-9-]*\.trycloudflare\.com'; then
        URL=$(echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com')
        echo ""
        echo "════════════════════════════════════════"
        echo "  🌐 공유 URL (클립보드에 복사됨):"
        echo "  $URL"
        echo "════════════════════════════════════════"
        echo "$URL" | pbcopy 2>/dev/null || true
      fi
    done &
    TUNNEL_PID=$!
    wait "$SERVER_PID"
  fi
else
  echo "   💡 팀원과 공유하려면: bash start.sh --tunnel"
  echo "   종료: Ctrl+C"
  echo "════════════════════════════════════════"
  wait "$SERVER_PID"
fi
