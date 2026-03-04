#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# MindMap Viewer — 자동 설치 스크립트 (macOS / Linux)
# ───────────────────────────────────────────────────────────────
# 사용법:
#   bash setup/install.sh           # 기본 설치 (Claude Code 훅 자동 등록)
#   bash setup/install.sh --no-hook # 훅 등록 건너뜀
#   bash setup/install.sh --channel team-alpha --member 다린
# ═══════════════════════════════════════════════════════════════
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHANNEL="default"
MEMBER=""
REGISTER_HOOK=true

# ── 인수 파싱 ────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-hook)   REGISTER_HOOK=false ;;
    --channel)   CHANNEL="$2"; shift ;;
    --member)    MEMBER="$2"; shift ;;
  esac
  shift
done

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🧠 MindMap Viewer 자동 설치               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Node.js 확인 ─────────────────────────────────────────────
find_node() {
  if command -v node &>/dev/null; then
    echo "node"
    return
  fi
  # nvm
  NVM_NODE="$HOME/.nvm/versions/node"
  if [ -d "$NVM_NODE" ]; then
    LATEST=$(ls "$NVM_NODE" | sort -V | tail -1)
    if [ -n "$LATEST" ]; then
      echo "$NVM_NODE/$LATEST/bin/node"
      return
    fi
  fi
  # homebrew
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

NODE_BIN=$(find_node)
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node.js를 찾을 수 없습니다."
  echo "   설치: https://nodejs.org  또는  brew install node"
  exit 1
fi

NODE_VER=$("$NODE_BIN" --version 2>/dev/null)
echo "✅ Node.js: $NODE_VER ($NODE_BIN)"

# Node >= 18 확인
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "⚠️  Node.js 18 이상이 필요합니다. 현재: $NODE_VER"
  echo "   업그레이드: nvm install 20  또는  brew upgrade node"
  exit 1
fi

# ── 의존성 설치 ──────────────────────────────────────────────
cd "$REPO_DIR"
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
  echo ""
  echo "📦 npm install 실행 중..."
  NODE_PATH=$(dirname "$NODE_BIN")
  PATH="$NODE_PATH:$PATH" npm install --silent
  echo "✅ 의존성 설치 완료"
else
  echo "✅ node_modules 이미 있음 (건너뜀)"
fi

# ── 데이터 디렉토리 생성 ─────────────────────────────────────
mkdir -p "$REPO_DIR/data" "$REPO_DIR/snapshots"
echo "✅ 데이터 디렉토리 준비"

# ── Claude Code 훅 등록 ──────────────────────────────────────
SAVE_TURN_PATH="$REPO_DIR/save-turn.js"
SAVE_TURN_CMD="node \"$SAVE_TURN_PATH\""

# Claude 설정 경로 탐색 (macOS/Linux 공통)
CLAUDE_SETTINGS=""
for p in \
  "$HOME/.claude/settings.json" \
  "$HOME/Library/Application Support/Claude/settings.json" \
  "$HOME/.config/claude/settings.json"; do
  if [ -f "$p" ] || [ -d "$(dirname "$p")" ]; then
    CLAUDE_SETTINGS="$p"
    break
  fi
done

# 기본 경로
if [ -z "$CLAUDE_SETTINGS" ]; then
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
fi

register_hook() {
  local settings_file="$1"
  local cmd="$2"
  mkdir -p "$(dirname "$settings_file")"

  # 기존 설정 읽기
  local existing="{}"
  if [ -f "$settings_file" ]; then
    existing=$(cat "$settings_file")
  fi

  # Python3로 JSON 병합 (jq 없어도 동작)
  python3 - <<PYEOF
import json, sys, os

settings_file = """$settings_file"""
cmd = """$cmd"""

try:
    with open(settings_file, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except:
    cfg = {}

if 'hooks' not in cfg:
    cfg['hooks'] = {}

hook_events = [
    'UserPromptSubmit', 'PostToolUse', 'Stop',
    'SessionStart', 'SessionEnd',
    'SubagentStart', 'SubagentStop',
    'Notification', 'TaskCompleted', 'PreToolUse',
]

hook_entry = {"type": "command", "command": cmd}

for event in hook_events:
    if event not in cfg['hooks']:
        cfg['hooks'][event] = []
    # 이미 등록됐으면 스킵
    hooks_list = cfg['hooks'][event]
    if not isinstance(hooks_list, list):
        hooks_list = [hooks_list]
        cfg['hooks'][event] = hooks_list

    # matcher가 있는 이벤트 처리
    if event == 'PostToolUse' or event == 'PreToolUse':
        existing_entry = next((h for h in hooks_list if isinstance(h, dict) and 'hooks' in h), None)
        if existing_entry is None:
            hooks_list.append({"matcher": "*", "hooks": [hook_entry]})
        else:
            cmds = [h.get('command') for h in existing_entry.get('hooks', []) if isinstance(h, dict)]
            if cmd not in cmds:
                existing_entry['hooks'].append(hook_entry)
    else:
        existing_entry = next((h for h in hooks_list if isinstance(h, dict) and 'hooks' in h), None)
        if existing_entry is None:
            hooks_list.append({"hooks": [hook_entry]})
        else:
            cmds = [h.get('command') for h in existing_entry.get('hooks', []) if isinstance(h, dict)]
            if cmd not in cmds:
                existing_entry['hooks'].append(hook_entry)

with open(settings_file, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

print("registered")
PYEOF
}

if $REGISTER_HOOK; then
  echo ""
  echo "🔗 Claude Code 훅 등록 중..."
  echo "   설정 파일: $CLAUDE_SETTINGS"

  result=$(register_hook "$CLAUDE_SETTINGS" "$SAVE_TURN_CMD" 2>&1)
  if echo "$result" | grep -q "registered"; then
    echo "✅ 훅 등록 완료"
  else
    echo "⚠️  훅 자동 등록 실패 — 수동으로 설정하세요:"
    echo "   cp \"$REPO_DIR/setup/settings/claude-macos.json\" \"$CLAUDE_SETTINGS\""
    echo "   (경로를 $SAVE_TURN_PATH 으로 수정 필요)"
  fi
else
  echo "⏭  훅 등록 건너뜀 (--no-hook)"
fi

# ── 환경변수 안내 ────────────────────────────────────────────
echo ""
echo "── 팀 채널 설정 (선택) ──────────────────────────────────"
if [ -n "$CHANNEL" ] && [ "$CHANNEL" != "default" ]; then
  echo "   채널: $CHANNEL"
  echo ""
  echo "   아래를 ~/.zshrc 또는 ~/.bashrc에 추가하세요:"
  echo "   export MINDMAP_CHANNEL=$CHANNEL"
  if [ -n "$MEMBER" ]; then
    echo "   export MINDMAP_MEMBER=$MEMBER"
  fi
else
  echo "   팀 채널을 쓰려면:"
  echo "   export MINDMAP_CHANNEL=팀채널명   # ~/.zshrc에 추가"
  echo "   export MINDMAP_MEMBER=내이름      # ~/.zshrc에 추가"
fi

# ── 완료 ─────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅ 설치 완료!                              ║"
echo "║                                              ║"
echo "║   서버 시작:  bash start.sh                 ║"
echo "║   팀 공유:    bash start.sh --tunnel         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
