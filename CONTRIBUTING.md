# Contributing to Claude Work MindMap

짝작업 환경에서 빠르게 온보딩하기 위한 가이드입니다.

---

## 시작하기

```bash
git clone https://github.com/Jayinsightfactory/mindmap-viewer.git
cd mindmap-viewer
npm install
cp .env.example .env    # 환경변수 설정
node server.js          # http://localhost:4747
```

---

## 브랜치 전략

```
main          → 배포 가능한 안정 버전 (직접 push 금지)
dev           → 통합 브랜치
feat/기능명   → 새 기능
fix/버그명    → 버그 수정
refactor/대상 → 리팩토링
```

**작업 흐름:**
```bash
git checkout -b feat/planet-ui
# 작업
git push origin feat/planet-ui
# GitHub에서 PR → dev 머지 요청
```

---

## 커밋 메시지 규칙

```
feat:     새 기능
fix:      버그 수정
refactor: 동작 변경 없는 코드 개선
docs:     문서 수정
style:    포매팅 (세미콜론 등)
db:       DB 스키마/마이그레이션
chore:    빌드, 의존성, 설정
test:     테스트 추가/수정
```

예시:
```
feat: 행성계 줌 레벨 0-6 렌더링 추가
fix: WebSocket 재연결 시 채널 중복 등록 버그
db: events 테이블 trace_id 컬럼 추가
```

---

## 코드 구조

```
server.js          # Express + WebSocket 서버 (포트 4747)
db.js              # SQLite DB (better-sqlite3, 동기 API)
graph-engine.js    # 노드/엣지 계산, 활동 점수
event-normalizer.js# 다양한 AI 이벤트 → 통일 포맷
code-analyzer.js   # 파일 복잡도 분석
security-scanner.js# API키·JWT 등 유출 패턴 감지
game-effects.js    # BLAZING/COOL 애니메이션 상태
save-turn.js       # 대화 턴 저장
adapters/          # AI별 어댑터 (gemini, openai, perplexity, vscode)
public/index.html  # 프론트엔드 (단일 파일)
tests/unit/        # Jest 단위 테스트
setup/             # 설치 스크립트 (Mac/Windows)
```

---

## 테스트

```bash
npm test              # 전체 실행
npm run test:watch    # 파일 변경 시 자동 재실행
npm run test:coverage # 커버리지 리포트
```

새 기능에는 `tests/unit/기능명.test.js` 추가 권장.

---

## 핵심 API

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /api/hook` | Claude Code 훅 이벤트 수신 |
| `POST /api/ai-event` | 다른 AI 툴 이벤트 수신 |
| `GET /api/graph` | 현재 그래프 상태 반환 |
| `WS ws://localhost:4747` | 실시간 그래프 업데이트 |

이벤트 포맷:
```json
{
  "source": "claude|cursor|gemini|gpt",
  "type": "tool_use|message|file_edit",
  "sessionId": "string",
  "data": {}
}
```

---

## PR 체크리스트

- [ ] `npm test` 통과
- [ ] 새 기능이면 테스트 추가
- [ ] `.env.example` 업데이트 (새 환경변수 추가 시)
- [ ] README 업데이트 (새 기능/API 추가 시)

---

## 질문 / 이슈

GitHub Issues에 올리거나 같은 채널로 접속해서 실시간으로 확인하세요.
