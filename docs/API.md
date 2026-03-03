# API Reference — Orbit AI

모든 HTTP 엔드포인트를 기능별로 정리합니다.

Base URL: `http://localhost:4747/api`

---

## 이벤트 수신

### `POST /api/hook`
Claude Code / orbit CLI에서 작업 이벤트를 수신합니다.

**Request Body**:
```json
{
  "events":     "MindmapEvent[]",  // 이벤트 배열 (필수, → docs/EVENTS.md)
  "channelId":  "string",          // 채널 ID (기본값: "default")
  "memberName": "string"           // 작업자 이름 (기본값: "Claude")
}
```

**Response**:
```json
{ "success": true, "received": 3, "leaksDetected": 0 }
```

**부가 기능**: 이벤트 수신 시 자동으로 보안 유출 스캔, 감사 로그, Shadow AI 감지, 충돌 감지를 수행합니다.

---

## 그래프

### `GET /api/graph`
전체 작업 그래프를 반환합니다.

**Query Params**:
- `session`: 세션 ID 필터
- `channel`: 채널 ID 필터

**Response**: `{ nodes: Node[], edges: Edge[] }`

### `GET /api/sessions`
세션 목록을 반환합니다 (최신순).

**Response**: `Session[]`

### `GET /api/stats`
전체 통계를 반환합니다.

**Response**: `{ eventCount, sessionCount, fileCount }`

### `GET /api/activity`
노드별 활동 점수를 반환합니다 (0.0~1.0, 24h 감쇠).

**Response**: `{ [nodeId]: number }`

### `GET /api/files`
파일 접근 통계 목록을 반환합니다.

**Response**: `File[]`

### `GET /api/members`
Claude Code, Zoom, Calendar 참여자를 통합한 멤버 목록.

**Response**: `{ name, channels, eventCount, sources, lastActive }[]`

### `GET /api/overlay`
멤버별 그래프 오버레이를 반환합니다.

**Query Params**:
- `members`: 쉼표 구분 멤버 이름 목록
- `from`: ISO 8601 시작 시간
- `to`: ISO 8601 종료 시간

**Response**: `{ overlay: { [name]: Graph }, timeRange: { from, to } }`

### `GET /api/turns`
전체 이벤트를 반환합니다. (`/api/graph` 권장)

### `GET /api/snapshots`
저장된 스냅샷 파일 목록.

### `POST /api/rollback/:id`
지정 이벤트 ID 이후 이벤트를 삭제합니다 (되돌리기 불가).

### `DELETE /api/clear`
전체 이벤트 및 세션을 초기화합니다 (되돌리기 불가).

---

## 목적 분류

### `GET /api/purposes`
목적 윈도우 목록 (시간순).

**Query Params**: `channel`, `session`

### `GET /api/purposes/summary`
목적별 통계 `{ implement: 12, fix: 5, ... }`.

**Query Params**: `channel`

### `GET /api/purposes/categories`
9개 목적 카테고리 정의 목록.

---

## 검색

### `GET /api/search?q=키워드`
이벤트 내용, 파일명, 도구명 대상 키워드 검색.

**Response**: `Event[]`

---

## 주석 / 사용자 설정

### `GET /api/annotations`
주석 목록.

### `POST /api/annotations`
주석 생성.
```json
{ "linkedEventId": "...", "label": "Note", "description": "...", "color": "#f0c674", "icon": "📌" }
```

### `DELETE /api/annotations/:id`
주석 삭제.

### `GET /api/user-config`
사용자 라벨 + 카테고리 + 도구 매핑 전체 조회.

### `GET/POST/DELETE /api/user-labels[/:eventId]`
노드 커스텀 라벨 CRUD.

### `GET/POST/DELETE /api/user-categories[/:id]`
사용자 카테고리 CRUD.

### `GET/POST/DELETE /api/tool-mappings[/:toolName]`
도구 라벨 매핑 CRUD.

### `GET /api/suggest-label/:eventId`
이벤트 내용 기반 라벨 자동 제안.

---

## 멀티 AI 이벤트

### `POST /api/ai-event`
Gemini, OpenAI 등 외부 AI 어댑터의 이벤트를 수신합니다.

**Request Body** (normalizeAiEvent() 반환 형식):
```json
{
  "id":       "uuid",
  "type":     "ai.message",
  "aiSource": "gemini",
  "data":     { "aiLabel": "Gemini", "model": "gemini-1.5-pro", "content": "..." }
}
```

### `GET /api/ai-sources`
지원 AI 소스 목록 + 시각화 스타일.

---

## 코드 분석 / Context Bridge

### `POST /api/analyze`
코드 복잡도 분석.
```json
{ "code": "...", "filename": "server.js" }
```

### `GET /api/analyze?file=<절대경로>`
파일 경로로 복잡도 분석.

### `GET /api/analyze-project?dir=<경로>&ext=js,ts`
프로젝트 전체 파일 일괄 분석 (최대 30개).

### `GET /api/context/bridge`
현재 작업 컨텍스트 추출 (Claude/Cursor 프롬프트 주입용).

**Query Params**:
- `session`, `channel`: 필터
- `format`: `markdown` | `prompt` | (기본: JSON)
- `save`: `1` 또는 디렉토리 경로 → `ORBIT_CONTEXT.md` 저장

### `GET /api/conflicts?channel=X&hours=24`
파일/이벤트 충돌 감지.

---

## 보안

### `GET /api/shadow-ai?channel=X&hours=168`
Shadow AI(비승인 AI 도구) 감지.

### `GET /api/shadow-ai/approved`
승인된 AI 소스 목록.

### `POST /api/shadow-ai/approved`
AI 소스 승인 추가/제거.
```json
{ "source": "cursor", "action": "remove" }
```

### `GET /api/audit`
감사 로그 조회.

**Query Params**: `from`, `to`, `type`, `channel`, `memberId`, `limit`, `format=html`

### `GET /api/audit/verify`
감사 로그 무결성 검증.

### `GET /api/audit/report`
감사 리포트 HTML 출력.

---

## 리포트

### `GET /api/report/daily`
일일 활동 리포트.

**Query Params**: `from`, `to`, `channel`, `format=markdown|slack`

### `GET /api/report/weekly`
최근 7일 주간 리포트.

---

## 채널 (팀 협업)

### `GET /api/channels`
현재 접속 중인 채널 목록 + 멤버 수.

---

## 테마 마켓

### `GET /api/themes`
전체 테마 목록.

### `GET /api/themes/:id`
특정 테마 조회.

### `POST /api/themes`
테마 등록.

### `POST /api/themes/:id/download`
다운로드 수 카운트.

### `POST /api/themes/:id/rate`
평점 등록 (1-5).
```json
{ "rating": 4.5 }
```

### `DELETE /api/themes/:id`
테마 삭제.

---

## 계정 인증

### `POST /api/auth/register`
회원가입.
```json
{ "email": "user@example.com", "password": "securepass", "name": "홍길동" }
```

### `POST /api/auth/login`
로그인 → 토큰 발급.

### `GET /api/auth/me`
현재 사용자 정보.

**Headers**: `Authorization: orbit_xxxx...`

---

## 결제/플랜

### `GET /api/payment/plans`
구독 플랜 목록 (free/pro/team).

### `POST /api/payment/create`
결제창 초기화.
```json
{ "planId": "pro", "userId": "...", "userEmail": "user@example.com" }
```

### `POST /api/payment/confirm`
결제 최종 승인 (Toss Payments 콜백 후 호출).
```json
{ "paymentKey": "...", "orderId": "...", "amount": 9900 }
```

---

## 성장 엔진

### `GET /api/growth/suggestions?channel=X&limit=20`
AI 자동 제안 목록.

### `GET /api/growth/patterns?channel=X`
반복 패턴 감지 결과.

### `POST /api/growth/feedback`
제안에 피드백 등록.
```json
{
  "suggestionId": "...",
  "vote": "down",
  "reason": "너무 복잡함",
  "alternativeIdea": "간단한 배치 스크립트로 충분"
}
```

### `GET /api/growth/candidates`
마켓 출시 후보 (confidence >= 0.8 + upvotes >= 3).

### `POST /api/growth/analyze`
수동 패턴 분석 트리거.
```json
{ "channel": "default" }
```

### `GET /api/growth/solutions`
솔루션 마켓 목록.

### `POST /api/growth/solutions`
솔루션 등록.

---

## 커뮤니티 게시판

### `GET /api/community/posts`
게시물 목록 (answers 포함).

### `POST /api/community/posts`
게시물 등록.
```json
{
  "title": "질문 제목",
  "body": "내용 (Markdown)",
  "category": "question",
  "author": "홍길동",
  "tags": ["claude-code", "bash"]
}
```

### `POST /api/community/answers`
답변 등록.
```json
{ "postId": "p-xxx", "body": "답변 내용", "author": "이름" }
```

### `POST /api/community/accept`
답변 채택.
```json
{ "postId": "p-xxx", "answerId": "ans-xxx" }
```

### `POST /api/community/vote`
추천/비추천.
```json
{ "postId": "p-xxx", "direction": "up" }
```
답변 투표: `answerId` 필드 추가.

### `GET /api/community/similar?tags=태그1,태그2`
중복 게시물 검색 (태그 2개 이상 교집합).

---

## WebSocket 프로토콜

`ws://localhost:4747` 연결 후 JSON 메시지 교환.

### 서버 → 클라이언트

| type | 설명 |
|------|------|
| `init` | 초기 연결 시 전체 그래프 전송 |
| `update` | 새 이벤트 수신 시 그래프 업데이트 |
| `activity` | 10초마다 활동 점수 업데이트 |
| `channel.joined` | 채널 입장 확인 |
| `channel.member_joined` | 다른 멤버 입장 알림 |
| `channel.member_left` | 멤버 퇴장 알림 |
| `channel.activity` | 멤버 커서/활동 브로드캐스트 |
| `userConfigUpdate` | 사용자 설정 변경 브로드캐스트 |
| `event` | 주석 생성 이벤트 |
| `filtered` | 세션 필터 결과 |

### 클라이언트 → 서버

| type | 설명 |
|------|------|
| `channel.join` | 채널 입장 `{ channelId, memberName, memberId }` |
| `channel.activity` | 커서/활동 브로드캐스트 `{ action, nodeId }` |
| `annotation.create` | 주석 생성 `{ data: AnnotationData }` |
| `filter` | 세션 필터 `{ sessionId }` |

---

## 헬스체크

### `GET /health`
서버 상태 확인 (Docker, Railway, Render 등 배포 플랫폼용).

```json
{
  "status": "ok",
  "version": "2.0.0",
  "uptime": 3600,
  "events": 1500,
  "sessions": 12,
  "channels": 2,
  "clients": 5,
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```
