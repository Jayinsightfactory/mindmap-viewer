# Database Schema — Orbit AI

모든 DB 테이블의 컬럼 정의와 관계를 설명합니다.

---

## 1. 메인 DB (`data/orbit.db` — SQLite / PostgreSQL)

### `events` 테이블

작업 이벤트의 핵심 저장소. 모든 Claude Code / Cursor / AI 어댑터 이벤트가 저장됩니다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 이벤트 고유 ID (UUID 또는 타임스탬프 기반) |
| `type` | TEXT | 이벤트 타입 (→ `docs/EVENTS.md` 참고) |
| `source` | TEXT | 이벤트 발생 소스 (`claude-code`, `cursor`, `ai-adapter` 등) |
| `sessionId` | TEXT | 세션 ID (같은 작업 세션의 이벤트를 묶음) |
| `parentEventId` | TEXT | 부모 이벤트 ID (트리 구조 형성) |
| `channelId` | TEXT | 채널 ID (팀 채널별 분리) |
| `userId` | TEXT | 이벤트 생성 사용자 ID |
| `timestamp` | TEXT | ISO 8601 타임스탬프 |
| `data` | TEXT | JSON 직렬화된 이벤트 상세 데이터 |
| `metadata` | TEXT | JSON 직렬화된 메타데이터 (aiSource, model 등) |

**인덱스**: `sessionId`, `channelId`, `timestamp`, `type`

---

### `sessions` 테이블

작업 세션 정보. 각 세션은 `events.sessionId` 를 통해 연결됩니다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 세션 ID |
| `memberName` | TEXT | 작업자 이름 |
| `userId` | TEXT | 사용자 ID |
| `channelId` | TEXT | 채널 ID |
| `startedAt` | TEXT | 세션 시작 시간 (ISO 8601) |
| `lastActiveAt` | TEXT | 마지막 활동 시간 |
| `eventCount` | INTEGER | 이벤트 수 |

---

### `files` 테이블

파일 접근 통계. `tool.start` 이벤트에서 파일 경로를 추출해 집계합니다.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `path` | TEXT PK | 파일 절대 경로 |
| `accessCount` | INTEGER | 총 접근 횟수 |
| `editCount` | INTEGER | 편집(write) 횟수 |
| `readCount` | INTEGER | 읽기(read) 횟수 |
| `lastAccessed` | TEXT | 마지막 접근 시간 |

---

### `annotations` 테이블

사용자가 노드에 추가한 주석.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 주석 ID (연결된 이벤트 ID와 동일) |
| `eventId` | TEXT | 연결된 이벤트 ID (NULL 가능) |
| `label` | TEXT | 라벨 텍스트 (기본값: 'Note') |
| `description` | TEXT | 상세 설명 |
| `color` | TEXT | HEX 색상 코드 (기본값: '#f0c674') |
| `icon` | TEXT | 아이콘 문자 |
| `createdAt` | TEXT | 생성 시간 |

---

### `user_labels` 테이블

노드별 사용자 커스텀 라벨.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `eventId` | TEXT PK | 대상 이벤트 ID |
| `customHeader` | TEXT | 커스텀 헤더 |
| `customBody` | TEXT | 커스텀 본문 |
| `updatedAt` | TEXT | 마지막 수정 시간 |

---

### `user_categories` 테이블

사용자 정의 카테고리.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 카테고리 ID |
| `name` | TEXT | 카테고리 이름 |
| `color` | TEXT | 색상 |
| `icon` | TEXT | 아이콘 |
| `description` | TEXT | 설명 |

---

### `tool_label_mappings` 테이블

도구 이름 → 커스텀 라벨 매핑.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `toolName` | TEXT PK | 원본 도구 이름 (예: `Read`, `Bash`) |
| `customLabel` | TEXT | 표시할 커스텀 라벨 |
| `customHeader` | TEXT | 커스텀 헤더 |

---

## 2. 사용자 DB (`data/users.db` — SQLite)

### `users` 테이블

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 사용자 ID (타임스탬프+랜덤 base36) |
| `email` | TEXT UNIQUE | 이메일 주소 (소문자 정규화) |
| `name` | TEXT | 표시 이름 |
| `passwordHash` | TEXT | bcrypt 해시 (rounds=12) |
| `plan` | TEXT | `free` / `pro` / `team` |
| `createdAt` | TEXT | 가입 시간 |
| `lastLoginAt` | TEXT | 마지막 로그인 시간 |
| `settings` | TEXT | JSON 직렬화된 사용자 설정 |

### `tokens` 테이블

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `token` | TEXT PK | 인증 토큰 (`orbit_` + 48자 hex) |
| `userId` | TEXT FK | 소유 사용자 ID |
| `type` | TEXT | `api` (365일) / `session` (30일) |
| `expiresAt` | TEXT | 만료 시간 (NULL=영구) |
| `createdAt` | TEXT | 발급 시간 |

---

## 3. 성장 엔진 DB (`data/growth.db` — SQLite)

### `patterns` 테이블

반복 패턴 감지 결과.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 패턴 ID |
| `type` | TEXT | `repeat_file` / `repeat_command` / `repeat_error` |
| `channelId` | TEXT | 발생 채널 |
| `key` | TEXT | 패턴 식별 키 (파일명, 명령어 등) |
| `count` | INTEGER | 반복 횟수 |
| `data` | TEXT | JSON 상세 데이터 |
| `detectedAt` | TEXT | 감지 시간 |

### `suggestions` 테이블

AI 자동 제안.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 제안 ID |
| `patternId` | TEXT FK | 연결된 패턴 ID |
| `type` | TEXT | `automation_script` / `workflow_recipe` / `alias_shortcut` / `error_prevention` / `refactor_hint` |
| `title` | TEXT | 제안 제목 |
| `description` | TEXT | 상세 설명 |
| `confidence` | REAL | 신뢰도 (0.0~1.0) |
| `upvotes` | INTEGER | 추천 수 |
| `downvotes` | INTEGER | 비추천 수 |
| `status` | TEXT | `pending` / `accepted` / `rejected` |
| `createdAt` | TEXT | 생성 시간 |

### `feedbacks` 테이블

사용자 피드백 (👍/👎 + 대안 아이디어).

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 피드백 ID |
| `suggestionId` | TEXT FK | 대상 제안 ID |
| `vote` | TEXT | `up` / `down` |
| `reason` | TEXT | 비추천 이유 |
| `alternativeIdea` | TEXT | 대안 아이디어 (학습 데이터) |
| `userId` | TEXT | 피드백 제공자 ID |
| `channelId` | TEXT | 채널 ID |
| `createdAt` | TEXT | 생성 시간 |

### `learned_rules` 테이블

피드백에서 학습된 개선 규칙.

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | TEXT PK | 규칙 ID |
| `fromSuggestionId` | TEXT | 원본 제안 ID |
| `rule` | TEXT | 학습된 규칙 내용 |
| `appliedCount` | INTEGER | 적용 횟수 |
| `createdAt` | TEXT | 생성 시간 |

---

## 4. 파일 기반 저장소

### `data/solutions.json`

솔루션 마켓 데이터 (배열). 각 항목은 `src/solution-store.js`의 `Solution` 스키마를 따릅니다.

### `data/community.json`

커뮤니티 게시판 데이터 (`{ posts: Post[] }`). 각 게시물은 `answers` 배열을 포함합니다.
스키마는 `src/community-store.js` 참고.

### `data/themes.json`

테마 마켓 데이터. 내장 테마 + 사용자 등록 테마. `src/theme-store.js` 참고.

### `data/audit.jsonl`

감사 로그. 한 줄에 JSON 한 개 (JSONL 포맷). `src/audit-log.js` 참고.

---

## 데이터 흐름

```
Claude Code / Cursor
    ↓ (HTTP POST /api/hook)
server.js
    ↓ insertEvent()
events 테이블
    ↓ buildGraph()
src/graph-engine.js
    ↓ WebSocket broadcast
브라우저 orbit.html
```
