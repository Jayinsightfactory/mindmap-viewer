# 메모리

## 사용자 환경 설정
- **언어**: 모든 질문과 답변을 한국어로 작성할 것
- **진행 방식**: 확인 질문 없이 무조건 진행 (항상 yes로 처리)

## MindMap Viewer 프로젝트
- **경로**: `C:\Users\cando\mindmap-viewer\`
- **실행**: `cd C:\Users\cando\mindmap-viewer && npm run dev`
- **URL**: `http://localhost:4747`
- **포트 충돌 시**: `cmd /c "taskkill /PID [PID] /F"` (PID는 `cmd /c "netstat -ano | findstr :4747"`로 확인)
- **구성 파일**:
  - `server.js` - Express + WebSocket + chokidar 파일 감시
  - `save-turn.js` - Claude Code PostToolUse/Stop 훅 수신기
  - `public/index.html` - vis-network 기반 마인드맵 UI
  - `conversation.jsonl` - 대화 턴 누적 저장
  - `snapshots/` - 롤백용 스냅샷
- **훅 설정**: `~/.claude/settings.json`에 PostToolUse + Stop 훅으로 save-turn.js 연결됨
- **3000번 포트**: Remotion Studio가 사용 중이므로 4747 사용
