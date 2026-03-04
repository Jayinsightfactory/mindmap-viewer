#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Orbit AI — 작업 완료 후 백업 (Git + Google Drive)
# ───────────────────────────────────────────────────────────────
# 터미널에 복붙:
#   bash <(curl -sL https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-backup.sh)
# ═══════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Orbit AI — 백업 (Git + Drive)              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── 프로젝트 찾기 ──
DIR=""
if [ -f "./server.js" ] && [ -f "./package.json" ]; then
  DIR="$(pwd)"
elif [ -d "$HOME/mindmap-viewer" ] && [ -f "$HOME/mindmap-viewer/server.js" ]; then
  DIR="$HOME/mindmap-viewer"
elif [ -d "$HOME/코워크1/mindmap-viewer" ] && [ -f "$HOME/코워크1/mindmap-viewer/server.js" ]; then
  DIR="$HOME/코워크1/mindmap-viewer"
fi

if [ -z "$DIR" ]; then
  echo -e "${RED}프로젝트를 찾을 수 없습니다${NC}"
  exit 1
fi
cd "$DIR"
echo -e "  프로젝트: ${CYAN}$DIR${NC}"

# ── [1/2] Git 백업 ──
echo -e "\n${CYAN}[1/2] Git 백업...${NC}"

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo -e "${GREEN}  변경사항 없음 (이미 최신)${NC}"
else
  git add -A
  MSG="backup: $(date '+%Y-%m-%d %H:%M')"
  git commit -m "$MSG" 2>/dev/null || true
  echo -e "${GREEN}  커밋 완료: $MSG${NC}"
fi

if git remote get-url origin &>/dev/null; then
  git push origin main 2>/dev/null && echo -e "${GREEN}  Git push 완료${NC}" || echo -e "${YELLOW}  push 실패 (네트워크 확인)${NC}"
else
  echo -e "${YELLOW}  remote 없음 (로컬 커밋만)${NC}"
fi

# ── [2/2] Google Drive 백업 ──
echo -e "\n${CYAN}[2/2] Google Drive 백업...${NC}"

DRIVE=""
for d in \
  "$HOME/Library/CloudStorage/GoogleDrive-"*"/내 드라이브/mindmap-viewer" \
  "$HOME/Library/CloudStorage/GoogleDrive-"*"/My Drive/mindmap-viewer" \
  "$HOME/Google Drive/내 드라이브/mindmap-viewer" \
  "$HOME/Google Drive/My Drive/mindmap-viewer" \
  "$USERPROFILE/Google Drive/mindmap-viewer" \
  "$USERPROFILE/GoogleDrive/mindmap-viewer"; do
  if [ -d "$(dirname "$d")" ]; then
    DRIVE="$d"
    break
  fi
done

if [ -n "$DRIVE" ]; then
  mkdir -p "$DRIVE"
  rsync -av --delete \
    --exclude 'node_modules' --exclude '.git' --exclude 'data/mindmap.db' \
    --exclude 'data/mindmap.db-wal' --exclude 'data/mindmap.db-shm' \
    --exclude 'conversation.jsonl' --exclude 'hook.log' --exclude '.hook-state.json' \
    "$DIR/" "$DRIVE/" > /dev/null 2>&1
  echo -e "${GREEN}  Drive 백업 완료: $DRIVE${NC}"
else
  echo -e "${YELLOW}  Google Drive 경로를 찾을 수 없음 (건너뜀)${NC}"
fi

# ── 완료 ──
echo -e "\n${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  백업 완료! (Git + Drive)                    ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
