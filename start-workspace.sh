#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Orbit AI — start-workspace.sh
# workspace.yaml 기반으로 로컬 워크스페이스 스택을 기동
# ─────────────────────────────────────────────────────────────────────────────
# 사용법:
#   bash start-workspace.sh                     # workspace.yaml 그대로 기동
#   bash start-workspace.sh --tunnel            # + cloudflared 공유 URL
#   bash start-workspace.sh --with-daemon       # + 키로거 데몬
#   bash start-workspace.sh --with-vision       # + Vision 워커
#   WORKSPACE_FILE=other.yaml bash start-workspace.sh
#
# 의존성:
#   - node (필수)
#   - python3 (YAML 파싱, macOS/Linux 기본 탑재)
# ─────────────────────────────────────────────────────────────────────────────
set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

WORKSPACE_FILE="${WORKSPACE_FILE:-$REPO_DIR/workspace.yaml}"
WITH_TUNNEL=false
WITH_DAEMON=false
WITH_VISION=false

for arg in "$@"; do
  case "$arg" in
    --tunnel)       WITH_TUNNEL=true ;;
    --with-daemon)  WITH_DAEMON=true ;;
    --with-vision)  WITH_VISION=true ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
  esac
done

# ── 색상 ────────────────────────────────────────────────────────────────────
C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'

# ── Node.js 경로 탐색 ──────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  for p in "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin; do
    [ -d "$p" ] && export PATH="$p:$PATH"
  done
fi
if ! command -v node &>/dev/null; then
  echo -e "${R}❌ node 없음 — https://nodejs.org 에서 설치하세요${N}"; exit 1
fi

# ── workspace.yaml 확인 ────────────────────────────────────────────────────
if [ ! -f "$WORKSPACE_FILE" ]; then
  echo -e "${R}❌ workspace.yaml 없음: $WORKSPACE_FILE${N}"; exit 1
fi
if ! command -v python3 &>/dev/null; then
  echo -e "${R}❌ python3 필요 (YAML 파싱)${N}"; exit 1
fi

# ── YAML 파싱 (stdlib만 사용, 경량 파서) ──────────────────────────────────
#    pyyaml 의존성을 피하기 위해 필요한 필드만 인덴트 기반 추출
read_field() {
  # usage: read_field <yaml_path> <dot.key>
  python3 - "$1" "$2" <<'PYEOF'
import sys, re
path, key_path = sys.argv[1], sys.argv[2].split('.')
with open(path, encoding='utf-8') as f:
    lines = f.readlines()

def find(lines, keys):
    depth = 0
    idx = 0
    for k in keys:
        found = False
        indent_req = depth * 2
        while idx < len(lines):
            ln = lines[idx].rstrip('\n')
            if not ln.strip() or ln.strip().startswith('#'):
                idx += 1; continue
            m = re.match(r'^( *)([A-Za-z_][\w\-]*)\s*:\s*(.*)$', ln)
            if m:
                ind = len(m.group(1))
                if ind < indent_req:
                    return None
                if ind == indent_req and m.group(2) == k:
                    # 인라인 주석 제거 (# 앞까지만)
                    val = re.sub(r'\s+#.*$', '', m.group(3)).strip()
                    if val:
                        return val
                    found = True
                    depth += 1
                    idx += 1
                    break
            idx += 1
        if not found:
            return None
    return ''

print(find(lines, key_path) or '')
PYEOF
}

WS_NAME=$(read_field "$WORKSPACE_FILE" "workspace.name")
WS_ID=$(read_field "$WORKSPACE_FILE" "workspace.id")
PORT=$(read_field "$WORKSPACE_FILE" "workspace.runtime.port")
PORT="${PORT:-4747}"

SERVER_ENABLED=$(read_field "$WORKSPACE_FILE" "processes.server.enabled")
DAEMON_ENABLED=$(read_field "$WORKSPACE_FILE" "processes.daemon.enabled")
VISION_ENABLED=$(read_field "$WORKSPACE_FILE" "processes.vision_worker.enabled")
TUNNEL_ENABLED=$(read_field "$WORKSPACE_FILE" "processes.tunnel.enabled")

# CLI 플래그로 오버라이드
$WITH_TUNNEL && TUNNEL_ENABLED=true
$WITH_DAEMON && DAEMON_ENABLED=true
$WITH_VISION && VISION_ENABLED=true

echo ""
echo -e "${C}════════════════════════════════════════${N}"
echo -e "${C}  🌐 Orbit AI Workspace${N}"
echo -e "${C}  name: ${G}${WS_NAME:-?}${N}  id: ${WS_ID:-?}"
echo -e "${C}  port: ${G}${PORT}${N}"
echo -e "${C}════════════════════════════════════════${N}"
echo ""

# ── 의존성 ─────────────────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo -e "${C}📦 npm install ...${N}"
  npm install
fi

# ── 종료 처리 ──────────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo -e "${Y}🛑 종료 중...${N}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

start_proc() {
  # $1: 라벨, $2: 명령어
  echo -e "${C}▶ $1${N}  $2"
  bash -c "$2" &
  local pid=$!
  PIDS+=("$pid")
  sleep 0.5
  if ! kill -0 "$pid" 2>/dev/null; then
    echo -e "${R}  ❌ $1 시작 실패${N}"
    return 1
  fi
  echo -e "${G}  ✅ $1 PID: $pid${N}"
}

# ── 서버 ───────────────────────────────────────────────────────────────────
if [ "${SERVER_ENABLED:-true}" = "true" ]; then
  start_proc "server" "PORT=$PORT node server.js"
  sleep 1.5
  if command -v curl &>/dev/null && curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo -e "${G}  ↳ health OK${N}"
  else
    echo -e "${Y}  ↳ health 응답 없음 (기동 중일 수 있음)${N}"
  fi
fi

# ── 데몬 ───────────────────────────────────────────────────────────────────
if [ "${DAEMON_ENABLED:-false}" = "true" ]; then
  if [ -f "$REPO_DIR/daemon/personal-agent.js" ]; then
    start_proc "daemon" "ORBIT_SERVER_URL=http://localhost:$PORT node daemon/personal-agent.js"
  else
    echo -e "${Y}  ⚠️  daemon/personal-agent.js 없음 — 건너뜀${N}"
  fi
fi

# ── Vision 워커 ────────────────────────────────────────────────────────────
if [ "${VISION_ENABLED:-false}" = "true" ]; then
  if [ -f "$REPO_DIR/bin/vision-worker.js" ]; then
    start_proc "vision-worker" "node bin/vision-worker.js"
  else
    echo -e "${Y}  ⚠️  bin/vision-worker.js 없음 — 건너뜀${N}"
  fi
fi

# ── 터널 ───────────────────────────────────────────────────────────────────
if [ "${TUNNEL_ENABLED:-false}" = "true" ]; then
  if command -v cloudflared &>/dev/null; then
    start_proc "tunnel" "cloudflared tunnel --url http://localhost:$PORT"
  else
    echo -e "${Y}  ⚠️  cloudflared 미설치 — 터널 건너뜀 (brew install cloudflared)${N}"
  fi
fi

echo ""
echo -e "${C}════════════════════════════════════════${N}"
echo -e "  로컬:    ${G}http://localhost:$PORT${N}"
echo -e "  관리자:  ${G}http://localhost:$PORT/admin-analysis.html${N}"
echo -e "  종료:    Ctrl+C"
echo -e "${C}════════════════════════════════════════${N}"

# 첫 번째 프로세스가 살아있는 동안 대기
if [ "${#PIDS[@]}" -gt 0 ]; then
  wait "${PIDS[0]}"
else
  echo -e "${R}❌ 기동된 프로세스가 없습니다. workspace.yaml 확인하세요.${N}"
  exit 1
fi
