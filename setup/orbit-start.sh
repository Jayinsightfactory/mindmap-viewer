#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Orbit AI — 원클릭 시작 (macOS / Linux)
# ───────────────────────────────────────────────────────────────
# 터미널에 아래 전체를 복붙하세요. 외부 URL 불필요.
# ═══════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Orbit AI — 원클릭 시작                     ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Node.js 찾기 ──
find_node() {
  command -v node &>/dev/null && echo "node" && return
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v node &>/dev/null && echo "node" && return
  for p in "$HOME/.nvm/versions/node"/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

NODE_BIN=$(find_node)
if [ -z "$NODE_BIN" ]; then
  echo -e "${RED}Node.js가 없습니다. https://nodejs.org 에서 설치하세요${NC}"; exit 1
fi
echo -e "${GREEN}Node.js: $($NODE_BIN --version)${NC}"

# ── [1/4] 퍼미션 설정 ──
echo -e "\n${CYAN}[1/4] 퍼미션 설정...${NC}"
CLAUDE_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_DIR"

cat > "$CLAUDE_DIR/settings.local.json" << 'EOF'
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Task", "NotebookEdit",
      "mcp__Claude_in_Chrome__*", "mcp__Claude_Preview__*", "mcp__mcp-registry__*"
    ]
  }
}
EOF
echo -e "${GREEN}  퍼미션 완료${NC}"

# ── [2/4] 프로젝트 준비 ──
echo -e "\n${CYAN}[2/4] 프로젝트 준비...${NC}"
REPO="https://github.com/dlaww-wq/mindmap-viewer.git"
DIR="$HOME/mindmap-viewer"

if [ -f "./server.js" ] && [ -f "./save-turn.js" ]; then
  DIR="$(pwd)"
elif [ -f "$DIR/server.js" ]; then
  cd "$DIR"; git pull --quiet 2>/dev/null || true
else
  git clone "$REPO" "$DIR"; cd "$DIR"
fi
cd "$DIR"

[ ! -d "node_modules" ] && echo "  npm install..." && npm install --silent
mkdir -p data snapshots
echo -e "${GREEN}  프로젝트 준비 완료: $DIR${NC}"

# ── [3/4] 훅 등록 ──
echo -e "\n${CYAN}[3/4] 훅 등록...${NC}"
SAVE="$DIR/save-turn.js"
CMD="node \"$SAVE\""

python3 - "$CLAUDE_DIR/settings.json" "$CMD" << 'PYEOF'
import json, sys
f, cmd = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(f, encoding='utf-8'))
except: cfg = {}
cfg.setdefault('hooks', {})
cfg['autoUpdatesChannel'] = 'latest'
h = {"type": "command", "command": cmd}
for e in ['UserPromptSubmit','PostToolUse','Stop','SessionStart','SessionEnd',
          'SubagentStart','SubagentStop','Notification','TaskCompleted','PreToolUse']:
    cfg['hooks'][e] = [{"matcher":"*","hooks":[h]}] if e in ('PostToolUse','PreToolUse') else [{"hooks":[h]}]
json.dump(cfg, open(f,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
PYEOF
echo -e "${GREEN}  10개 훅 등록 완료${NC}"

# ── [4/4] 서버 시작 ──
echo -e "\n${CYAN}[4/4] 서버 시작...${NC}"
if curl -s http://localhost:4747/health >/dev/null 2>&1; then
  echo -e "${GREEN}  이미 실행 중${NC}"
else
  nohup "$NODE_BIN" server.js >/dev/null 2>&1 &
  sleep 2
  echo -e "${GREEN}  서버 시작됨 (PID: $!)${NC}"
fi

command -v open &>/dev/null && open "http://localhost:4747"
command -v xdg-open &>/dev/null 2>&1 && xdg-open "http://localhost:4747" 2>/dev/null

echo -e "\n${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  완료! http://localhost:4747                 ║${NC}"
echo -e "${GREEN}║  이제 claude 실행하면 퍼미션 없이 진행됩니다  ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  작업 끝나면 백업:                            ║${NC}"
echo -e "${GREEN}║  bash <(curl -sL https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-backup.sh)${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
