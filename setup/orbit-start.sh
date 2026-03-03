#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Orbit AI — 원클릭 시작 (macOS / Linux)
# ───────────────────────────────────────────────────────────────
# 어떤 PC에서든 터미널에 한 줄만 붙여넣기:
#
#   bash <(curl -sL https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-start.sh)
#
# 하는 일:
#   1. Claude Code 퍼미션 자동 설정 (묻지 않음)
#   2. 프로젝트 클론/업데이트
#   3. 훅 등록 (작업 자동 트래킹)
#   4. 서버 시작 + 브라우저 열기
# ═══════════════════════════════════════════════════════════════
set -e

# ── 색상 ──
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Orbit AI — 원클릭 시작                     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Node.js 확인 ──
find_node() {
  if command -v node &>/dev/null; then echo "node"; return; fi
  NVM_NODE="$HOME/.nvm/versions/node"
  if [ -d "$NVM_NODE" ]; then
    LATEST=$(ls "$NVM_NODE" 2>/dev/null | sort -V | tail -1)
    [ -n "$LATEST" ] && echo "$NVM_NODE/$LATEST/bin/node" && return
  fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -f "$p" ] && echo "$p" && return
  done
  # nvm 로드 시도
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v node &>/dev/null && echo "node" && return
  echo ""
}

NODE_BIN=$(find_node)
if [ -z "$NODE_BIN" ]; then
  echo -e "${RED}Node.js가 없습니다. 설치: https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}Node.js: $($NODE_BIN --version)${NC}"

# ── 1단계: Claude Code 퍼미션 설정 (묻지 않음) ──
echo ""
echo -e "${CYAN}[1/4] 퍼미션 설정...${NC}"

CLAUDE_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_DIR"

cat > "$CLAUDE_DIR/settings.local.json" << 'PERMS'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Task",
      "NotebookEdit",
      "mcp__Claude_in_Chrome__*",
      "mcp__Claude_Preview__*",
      "mcp__mcp-registry__*"
    ]
  }
}
PERMS
echo -e "${GREEN}  퍼미션 설정 완료 (묻지 않음 모드)${NC}"

# ── 2단계: 프로젝트 클론/업데이트 ──
echo ""
echo -e "${CYAN}[2/4] 프로젝트 준비...${NC}"

REPO_URL="https://github.com/dlaww-wq/mindmap-viewer.git"
PROJECT_DIR="$HOME/mindmap-viewer"

# 이미 로컬에 있는 경우 탐색
if [ -f "./server.js" ] && [ -f "./save-turn.js" ]; then
  PROJECT_DIR="$(pwd)"
  echo -e "${GREEN}  현재 디렉토리 사용: $PROJECT_DIR${NC}"
elif [ -d "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/server.js" ]; then
  echo -e "${GREEN}  기존 프로젝트 발견: $PROJECT_DIR${NC}"
  cd "$PROJECT_DIR"
  git pull --quiet 2>/dev/null || true
else
  echo "  프로젝트 다운로드 중..."
  git clone "$REPO_URL" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"

# npm install
if [ ! -d "node_modules" ]; then
  echo "  의존성 설치 중..."
  npm install --silent
fi
mkdir -p data snapshots
echo -e "${GREEN}  프로젝트 준비 완료${NC}"

# ── 3단계: 훅 등록 ──
echo ""
echo -e "${CYAN}[3/4] 작업 트래킹 훅 등록...${NC}"

SAVE_TURN="$PROJECT_DIR/save-turn.js"
HOOK_CMD="node \"$SAVE_TURN\""

python3 - "$CLAUDE_DIR/settings.json" "$HOOK_CMD" << 'PYSCRIPT'
import json, sys, os

settings_file = sys.argv[1]
cmd = sys.argv[2]

try:
    with open(settings_file, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except:
    cfg = {}

if 'hooks' not in cfg:
    cfg['hooks'] = {}

cfg['autoUpdatesChannel'] = 'latest'

hook_events = [
    'UserPromptSubmit', 'PostToolUse', 'Stop',
    'SessionStart', 'SessionEnd',
    'SubagentStart', 'SubagentStop',
    'Notification', 'TaskCompleted', 'PreToolUse',
]

hook_entry = {"type": "command", "command": cmd}

for event in hook_events:
    if event in ('PostToolUse', 'PreToolUse'):
        cfg['hooks'][event] = [{"matcher": "*", "hooks": [hook_entry]}]
    else:
        cfg['hooks'][event] = [{"hooks": [hook_entry]}]

with open(settings_file, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
PYSCRIPT

echo -e "${GREEN}  10개 훅 이벤트 등록 완료${NC}"

# ── 4단계: 서버 시작 ──
echo ""
echo -e "${CYAN}[4/4] 서버 시작...${NC}"

# 이미 실행 중인지 확인
if curl -s http://localhost:4747/health > /dev/null 2>&1; then
  echo -e "${GREEN}  서버 이미 실행 중 (http://localhost:4747)${NC}"
else
  nohup "$NODE_BIN" server.js > /dev/null 2>&1 &
  SERVER_PID=$!
  sleep 2
  if curl -s http://localhost:4747/health > /dev/null 2>&1; then
    echo -e "${GREEN}  서버 시작됨 (PID: $SERVER_PID)${NC}"
  else
    echo -e "${YELLOW}  서버 시작 대기 중...${NC}"
  fi
fi

# 브라우저 열기
if command -v open &>/dev/null; then
  open "http://localhost:4747"
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:4747"
fi

# ── 완료 ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Orbit AI 준비 완료!                        ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║   웹 UI:  http://localhost:4747              ║${NC}"
echo -e "${GREEN}║   배포:   https://orbit3d-production.up.railway.app${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║   이제 Claude Code를 실행하면                ║${NC}"
echo -e "${GREEN}║   퍼미션 없이 자동 트래킹됩니다!              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  프로젝트: ${CYAN}$PROJECT_DIR${NC}"
echo ""
