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

# ── [1/7] 퍼미션 설정 ──
echo -e "\n${CYAN}[1/7] 퍼미션 설정...${NC}"
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

# ── [2/7] 프로젝트 준비 ──
echo -e "\n${CYAN}[2/7] 프로젝트 준비...${NC}"
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

# ── [3/7] 훅 등록 ──
echo -e "\n${CYAN}[3/7] 훅 등록...${NC}"
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

# ── [4/7] 서버 시작 ──
echo -e "\n${CYAN}[4/7] 서버 시작...${NC}"
if curl -s http://localhost:4747/health >/dev/null 2>&1; then
  echo -e "${GREEN}  이미 실행 중${NC}"
else
  nohup "$NODE_BIN" server.js >/dev/null 2>&1 &
  sleep 2
  echo -e "${GREEN}  서버 시작됨 (PID: $!)${NC}"
fi

SERVER_URL="http://localhost:4747"

# ── [5/7] 키로거 데몬 백그라운드 실행 ──
echo -e "\n${CYAN}[5/7] 키로거 데몬 설치...${NC}"

DAEMON_SCRIPT="$DIR/daemon/personal-agent.js"

if [ ! -f "$DAEMON_SCRIPT" ]; then
  echo -e "${YELLOW}  daemon/personal-agent.js 없음 — 건너뜀${NC}"
else
  # 이미 실행 중인지 확인
  ORBIT_PID_FILE="$HOME/.orbit/personal-agent.pid"
  DAEMON_RUNNING=false
  if [ -f "$ORBIT_PID_FILE" ]; then
    OLD_PID=$(cat "$ORBIT_PID_FILE" 2>/dev/null)
    if kill -0 "$OLD_PID" 2>/dev/null; then
      DAEMON_RUNNING=true
      echo -e "${GREEN}  데몬 이미 실행 중 (PID: $OLD_PID)${NC}"
    fi
  fi

  if [ "$DAEMON_RUNNING" = false ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      # macOS: LaunchAgent로 자동 시작 등록
      PLIST_DIR="$HOME/Library/LaunchAgents"
      PLIST_PATH="$PLIST_DIR/com.orbit.daemon.plist"
      mkdir -p "$PLIST_DIR"

      NODE_FULL=$($NODE_BIN -e "process.stdout.write(process.execPath)")

      cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orbit.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_FULL}</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORBIT_PORT</key><string>4747</string>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/tmp/orbit-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/orbit-daemon-err.log</string>
</dict>
</plist>
PLIST
      # 기존 등록 해제 후 재등록
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      launchctl load "$PLIST_PATH" 2>/dev/null
      echo -e "${GREEN}  키로거 데몬 등록 완료 (LaunchAgent)${NC}"
      echo -e "${YELLOW}  macOS: 시스템 환경설정 > 개인정보 보호 > 접근성 에서 터미널 허용 필요${NC}"
    else
      # Linux: systemd user service
      SERVICE_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SERVICE_DIR"

      NODE_FULL=$($NODE_BIN -e "process.stdout.write(process.execPath)")

      cat > "$SERVICE_DIR/orbit-daemon.service" << SVC
[Unit]
Description=Orbit AI Personal Agent Daemon
After=network.target

[Service]
Type=simple
ExecStart=${NODE_FULL} ${DAEMON_SCRIPT}
WorkingDirectory=${DIR}
Environment=ORBIT_PORT=4747
Environment=HOME=${HOME}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
SVC
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable orbit-daemon 2>/dev/null || true
      systemctl --user start orbit-daemon 2>/dev/null || true
      echo -e "${GREEN}  키로거 데몬 등록 완료 (systemd)${NC}"
    fi

    # 즉시 시작 (LaunchAgent/systemd 시작 실패 대비)
    if [ ! -f "$ORBIT_PID_FILE" ] || ! kill -0 "$(cat "$ORBIT_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      nohup "$NODE_BIN" "$DAEMON_SCRIPT" --port 4747 > /tmp/orbit-daemon.log 2>&1 &
      echo -e "${GREEN}  데몬 직접 시작됨 (PID: $!)${NC}"
    fi
  fi
fi

# ── [6/7] 스크린 캡처 안내 ──
echo -e "\n${CYAN}[6/7] 스크린 캡처 확인...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo -e "${YELLOW}  macOS 스크린 캡처:${NC}"
  echo -e "${YELLOW}    시스템 환경설정 > 개인정보 보호 > 화면 기록 에서 터미널 허용 필요${NC}"
  echo -e "${GREEN}  screencapture 명령 사용 가능${NC}"
elif command -v scrot &>/dev/null; then
  echo -e "${GREEN}  scrot 설치됨 — 스크린 캡처 가능${NC}"
elif command -v gnome-screenshot &>/dev/null; then
  echo -e "${GREEN}  gnome-screenshot 설치됨 — 스크린 캡처 가능${NC}"
else
  echo -e "${YELLOW}  스크린 캡처 도구 미감지. 설치 추천:${NC}"
  echo -e "${YELLOW}    sudo apt install scrot  (Ubuntu/Debian)${NC}"
  echo -e "${YELLOW}    sudo dnf install scrot  (Fedora)${NC}"
fi

# ── [7/7] Chrome 확장 설치 안내 ──
echo -e "\n${CYAN}[7/7] Chrome 확장 안내...${NC}"
echo -e "${GREEN}  브라우저 AI 대화 + 웹 활동 추적을 위한 Chrome 확장:${NC}"
echo -e "${CYAN}    ${SERVER_URL}/chrome-extension/${NC}"
echo -e "${YELLOW}  Chrome > 확장 프로그램 > 개발자 모드 > 압축해제된 확장 로드${NC}"

command -v open &>/dev/null && open "$SERVER_URL"
command -v xdg-open &>/dev/null 2>&1 && xdg-open "$SERVER_URL" 2>/dev/null

echo -e "\n${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  완료! http://localhost:4747                 ║${NC}"
echo -e "${GREEN}║  이제 claude 실행하면 퍼미션 없이 진행됩니다  ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  설치된 구성요소:                              ║${NC}"
echo -e "${GREEN}║    1. Claude Code 퍼미션 + 훅 등록           ║${NC}"
echo -e "${GREEN}║    2. Orbit 서버 (localhost:4747)             ║${NC}"
echo -e "${GREEN}║    3. 키로거 데몬 (백그라운드)                 ║${NC}"
echo -e "${GREEN}║    4. Chrome 확장 (수동 설치)                  ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  작업 끝나면 백업:                            ║${NC}"
echo -e "${GREEN}║  bash <(curl -sL https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-backup.sh)${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
