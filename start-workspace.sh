#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start-workspace.sh — dev-workspace tmux 레이아웃 기동
# ─────────────────────────────────────────────────────────────────────────────
# 사전 조건:
#   - tmux 설치:   brew install tmux  |  apt-get install tmux
#   - tmuxp 설치:  pipx install tmuxp  |  pip install --user tmuxp
#   - claude 설치: npm install -g @anthropic-ai/claude-code
#
# 실행:
#   chmod +x start-workspace.sh
#   ./start-workspace.sh
#
# 종료:
#   tmux kill-session -t dev-workspace
#
# 레이아웃:
#   TOP(40%)                = 🌐 DEPLOY         (npm run dev)
#   BOTTOM-LEFT(50%)        = 📋 PLANNING       (logs/planning.log + git log)
#   BOTTOM-RIGHT(50%, 5분할) = 🧠 PLANNER         Max 계정: claude
#                              🎨 FRONTEND       claude --dangerously-skip-permissions
#                              ⚙️  BACKEND        claude --dangerously-skip-permissions
#                              🧪 QA             claude --dangerously-skip-permissions
#                              💰 MONETIZE       claude --dangerously-skip-permissions
# ─────────────────────────────────────────────────────────────────────────────
set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

SESSION="dev-workspace"
C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'

echo ""
echo -e "${C}╔══════════════════════════════════════════════╗${N}"
echo -e "${C}║   🖥️  dev-workspace 레이아웃 기동            ║${N}"
echo -e "${C}╚══════════════════════════════════════════════╝${N}"

# ── [1/4] 의존성 체크 ──────────────────────────────────────────────────────
echo ""
echo -e "${C}[1/4] 의존성 확인${N}"

if ! command -v tmux &>/dev/null; then
  echo -e "${R}  ❌ tmux 미설치${N}"
  echo     "     설치: brew install tmux  (macOS)"
  echo     "           sudo apt-get install tmux  (Linux)"
  exit 1
fi
echo -e "${G}  ✅ tmux: $(tmux -V)${N}"

if ! command -v tmuxp &>/dev/null; then
  echo -e "${R}  ❌ tmuxp 미설치${N}"
  echo     "     설치: pipx install tmuxp"
  echo     "     또는: pip install --user tmuxp"
  exit 1
fi
echo -e "${G}  ✅ tmuxp: $(tmuxp --version 2>&1 | head -1)${N}"

if ! command -v claude &>/dev/null; then
  echo -e "${Y}  ⚠️  claude CLI 미설치 — 에이전트 패널은 수동으로 claude 실행 필요${N}"
  echo     "     설치: npm install -g @anthropic-ai/claude-code"
else
  echo -e "${G}  ✅ claude: $(claude --version 2>&1 | head -1)${N}"
fi

# ── [2/4] 에이전트 작업 디렉터리 + CLAUDE.md 배치 ─────────────────────────
echo ""
echo -e "${C}[2/4] 에이전트 디렉터리 준비${N}"

AGENTS=(planner frontend backend qa monetize)
for a in "${AGENTS[@]}"; do
  dir="$REPO_DIR/agents/$a"
  mkdir -p "$dir"
  # agents/<NAME>.md 템플릿을 해당 에이전트 디렉터리의 CLAUDE.md 로 복사
  tpl_upper=$(echo "$a" | tr '[:lower:]' '[:upper:]')
  tpl="$REPO_DIR/agents/${tpl_upper}.md"
  if [ -f "$tpl" ] && [ ! -f "$dir/CLAUDE.md" ]; then
    cp "$tpl" "$dir/CLAUDE.md"
    echo -e "${G}  ✅ agents/$a/CLAUDE.md 생성${N}"
  else
    echo -e "${G}  ✅ agents/$a/${N}"
  fi
done

mkdir -p "$REPO_DIR/logs"
touch    "$REPO_DIR/logs/planning.log"

# ── [3/4] 기존 세션 정리 ──────────────────────────────────────────────────
echo ""
echo -e "${C}[3/4] 기존 세션 정리${N}"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo -e "${Y}  ⚠️  기존 세션 '$SESSION' 발견 → 종료${N}"
  tmux kill-session -t "$SESSION"
fi
echo -e "${G}  ✅ clean${N}"

# ── [4/4] tmuxp 로드 + 오른쪽 아래 패널을 5분할로 확장 ────────────────────
echo ""
echo -e "${C}[4/4] 레이아웃 기동${N}"

# tmuxp 는 detached 모드로 로드 (-d), 그 뒤에 split 으로 5분할 + attach
tmuxp load -d workspace.yaml
sleep 0.6

# 현재 세션/윈도우에서 우측 아래 패널(인덱스 2번째로 생성된 pane)을 기준으로 4번 split
#   pane 0: TOP DEPLOY
#   pane 1: BOTTOM-LEFT PLANNING
#   pane 2: BOTTOM-RIGHT PLANNER  ← 여기서 아래로 4번 수직 split
TARGET="$SESSION:main.2"

# FRONTEND
tmux split-window -v -t "$TARGET" -c "$REPO_DIR/agents/frontend" \
  "printf '\\033]2;🎨 FRONTEND\\033\\\\'; clear; echo '🎨 FRONTEND — claude --dangerously-skip-permissions'; exec bash"
tmux select-pane -t "$SESSION:main.{last}" -T "🎨 FRONTEND"

# BACKEND
tmux split-window -v -t "$SESSION:main.{last}" -c "$REPO_DIR/agents/backend" \
  "printf '\\033]2;⚙️  BACKEND\\033\\\\'; clear; echo '⚙️  BACKEND — claude --dangerously-skip-permissions'; exec bash"
tmux select-pane -t "$SESSION:main.{last}" -T "⚙️  BACKEND"

# QA
tmux split-window -v -t "$SESSION:main.{last}" -c "$REPO_DIR/agents/qa" \
  "printf '\\033]2;🧪 QA\\033\\\\'; clear; echo '🧪 QA — claude --dangerously-skip-permissions'; exec bash"
tmux select-pane -t "$SESSION:main.{last}" -T "🧪 QA"

# MONETIZE
tmux split-window -v -t "$SESSION:main.{last}" -c "$REPO_DIR/agents/monetize" \
  "printf '\\033]2;💰 MONETIZE\\033\\\\'; clear; echo '💰 MONETIZE — claude --dangerously-skip-permissions'; exec bash"
tmux select-pane -t "$SESSION:main.{last}" -T "💰 MONETIZE"

# 오른쪽 아래 5개 pane 세로 균등 분할
tmux select-layout -t "$SESSION:main" main-horizontal
# 우측 컬럼 5개 pane 높이 균등
for p in 2 3 4 5 6; do
  tmux select-pane -t "$SESSION:main.$p" 2>/dev/null || true
done

echo -e "${G}  ✅ 5-pane agent column 구성 완료${N}"
echo ""
echo -e "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo -e "${C}  세션:   ${G}$SESSION${N}"
echo -e "${C}  attach: ${G}tmux attach -t $SESSION${N}"
echo -e "${C}  kill:   ${G}tmux kill-session -t $SESSION${N}"
echo -e "${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""

# 사용자에게 자동 attach
if [ -z "${TMUX:-}" ]; then
  tmux attach -t "$SESSION"
else
  tmux switch-client -t "$SESSION"
fi
