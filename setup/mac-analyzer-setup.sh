#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Orbit AI — Mac Mini 상시 분석 서버 원클릭 설정
#
# 실행: bash <(curl -sL 'https://mindmap-viewer-production-adb2.up.railway.app/setup/mac-analyzer-setup.sh')
# ═══════════════════════════════════════════════════════════════

set -e

REMOTE="https://mindmap-viewer-production-adb2.up.railway.app"
DIR="$HOME/orbit-analyzer"
REPO="https://github.com/Jayinsightfactory/mindmap-viewer.git"
PLIST_NAME="com.orbit.analyzer"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/.orbit"
LOG_FILE="$LOG_DIR/analyzer.log"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  Orbit AI — Mac Mini 분석 서버 설정   ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. 기본 환경 확인 ──────────────────────────────────────────
echo "[1/7] 환경 확인..."
mkdir -p "$LOG_DIR"

# Node.js
if ! command -v node &>/dev/null; then
  echo "  Node.js 설치 중..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    echo "  Homebrew 설치 중..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null
    brew install node
  fi
fi
echo "  Node.js: $(node --version)"

# Git
if ! command -v git &>/dev/null; then
  xcode-select --install 2>/dev/null || true
fi
echo "  Git: $(git --version | head -1)"

# ── 2. Claude Code 설치 ──────────────────────────────────────
echo "[2/7] Claude Code 확인..."
if ! command -v claude &>/dev/null; then
  echo "  Claude Code 설치 중..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null || {
    echo "  npm global 설치 실패, sudo로 재시도..."
    sudo npm install -g @anthropic-ai/claude-code
  }
fi

if command -v claude &>/dev/null; then
  echo "  Claude Code: $(claude --version 2>/dev/null || echo 'installed')"
else
  echo ""
  echo "  ⚠️  Claude Code 수동 설치 필요:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo "  설치 후 'claude' 로 로그인 완료한 다음 이 스크립트를 다시 실행하세요."
  echo ""
  exit 1
fi

# ── 3. 프로젝트 다운로드 ──────────────────────────────────────
echo "[3/7] 프로젝트 다운로드..."
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git pull --quiet
  echo "  업데이트 완료"
else
  git clone "$REPO" "$DIR" 2>/dev/null
  cd "$DIR"
  echo "  클론 완료"
fi
npm install --silent 2>/dev/null
echo "  패키지 설치 완료"

# ── 4. 서버 연결 설정 ──────────────────────────────────────────
echo "[4/7] 서버 연결..."
CONFIG="$HOME/.orbit-config.json"

# 토큰 입력 (없으면)
if [ -f "$CONFIG" ]; then
  EXISTING_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG')).get('token',''))" 2>/dev/null)
fi

if [ -z "$EXISTING_TOKEN" ]; then
  echo ""
  echo "  Orbit AI 웹에서 로그인 → 설정 → 설치코드 복사 → 토큰 확인"
  echo "  또는 직접 입력:"
  read -p "  Orbit 토큰 (orbit_xxx): " INPUT_TOKEN
  TOKEN="${INPUT_TOKEN:-}"
else
  TOKEN="$EXISTING_TOKEN"
  echo "  기존 토큰 사용"
fi

cat > "$CONFIG" << EOFCFG
{
  "serverUrl": "$REMOTE",
  "token": "$TOKEN",
  "role": "analyzer",
  "analyzerId": "mac-mini-$(hostname -s)"
}
EOFCFG
echo "  설정 저장: $CONFIG"

# ── 5. 분석 워커 스크립트 생성 ──────────────────────────────────
echo "[5/7] 분석 워커 설정..."

cat > "$DIR/bin/analyzer-loop.sh" << 'EOFLOOP'
#!/bin/bash
# Orbit AI 상시 분석 루프
# Vision 워커 + 주기적 deep-analyze + git pull 자동 업데이트

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.orbit/analyzer.log"

echo "[$(date)] 분석 서버 시작" >> "$LOG"

# 환경변수
export ORBIT_SERVER_URL=$(python3 -c "import json; print(json.load(open('$HOME/.orbit-config.json')).get('serverUrl',''))" 2>/dev/null)
export ORBIT_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.orbit-config.json')).get('token',''))" 2>/dev/null)

# 자동 업데이트 (1시간마다)
update_check() {
  while true; do
    sleep 3600
    cd "$DIR"
    BEFORE=$(git rev-parse HEAD 2>/dev/null)
    git pull --quiet 2>/dev/null
    AFTER=$(git rev-parse HEAD 2>/dev/null)
    if [ "$BEFORE" != "$AFTER" ]; then
      echo "[$(date)] 코드 업데이트 감지 → npm install" >> "$LOG"
      npm install --silent 2>/dev/null
      echo "[$(date)] 업데이트 완료, 재시작 필요" >> "$LOG"
      # 프로세스 재시작은 launchd가 처리
      exit 0
    fi
  done
}
update_check &

# Vision 워커 실행 (백그라운드)
if command -v claude &>/dev/null; then
  echo "[$(date)] Vision 워커 시작 (Claude CLI 모드)" >> "$LOG"
  node "$DIR/bin/vision-worker.js" >> "$LOG" 2>&1 &
  VISION_PID=$!
  echo "[$(date)] Vision PID: $VISION_PID" >> "$LOG"
else
  echo "[$(date)] Claude CLI 미설치 — Vision 워커 비활성화" >> "$LOG"
fi

# 주기적 분석 루프 (10분마다)
while true; do
  echo "[$(date)] 정기 분석 실행" >> "$LOG"

  # deep-analyze 호출
  RESULT=$(curl -s --max-time 30 -X POST "$ORBIT_SERVER_URL/api/learning/deep-analyze" \
    -H "Authorization: Bearer $ORBIT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null)

  MEMBER_COUNT=$(echo "$RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(len(d.get('members',[])))" 2>/dev/null || echo "0")
  echo "[$(date)] 분석 완료: ${MEMBER_COUNT}명" >> "$LOG"

  # 리포트 생성 (매 시간)
  HOUR=$(date +%H)
  MIN=$(date +%M)
  if [ "$MIN" -lt "11" ]; then
    if [ "$HOUR" = "00" ] || [ "$HOUR" = "04" ] || [ "$HOUR" = "09" ]; then
      echo "[$(date)] 리포트 생성" >> "$LOG"
      curl -s --max-time 30 -X POST "$ORBIT_SERVER_URL/api/learning/report" \
        -H "Authorization: Bearer $ORBIT_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{}' >> "$LOG" 2>&1
    fi
  fi

  sleep 600  # 10분
done
EOFLOOP
chmod +x "$DIR/bin/analyzer-loop.sh"

# ── 6. launchd 서비스 등록 (시스템 시작 시 자동 실행) ──────────
echo "[6/7] 시스템 서비스 등록..."

# 기존 서비스 중지
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" << EOFPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DIR}/bin/analyzer-loop.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>WorkingDirectory</key>
  <string>${DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
EOFPLIST

launchctl load "$PLIST_PATH"
echo "  서비스 등록 완료 (시스템 시작 시 자동 실행)"

# ── 7. 상태 확인 ──────────────────────────────────────────────
echo "[7/7] 상태 확인..."
sleep 3

if launchctl list | grep -q "$PLIST_NAME"; then
  echo "  ✅ 분석 서비스 실행 중"
else
  echo "  ⚠️  서비스 시작 실패 — 로그 확인: $LOG_FILE"
fi

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║  ✅ Orbit AI 분석 서버 설정 완료!             ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo "  분석 서버: $(hostname)"
echo "  프로젝트:  $DIR"
echo "  로그:      $LOG_FILE"
echo "  서비스:    $PLIST_NAME"
echo ""
echo "  ── 동작 ──"
echo "  • Vision 워커: Claude CLI로 캡처 이미지 분석 (3분마다)"
echo "  • 정기 분석: 키로그+마우스+캡처 조합 분석 (10분마다)"
echo "  • 리포트: Google Sheets 자동 생성 (09:00/13:30/18:00)"
echo "  • 자동 업데이트: git pull (1시간마다)"
echo "  • 시스템 재시작 시 자동 실행"
echo ""
echo "  ── 관리 명령어 ──"
echo "  로그 확인:    tail -f $LOG_FILE"
echo "  서비스 중지:  launchctl unload $PLIST_PATH"
echo "  서비스 시작:  launchctl load $PLIST_PATH"
echo "  서비스 상태:  launchctl list | grep orbit"
echo ""
