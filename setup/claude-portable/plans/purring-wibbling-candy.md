# Work Mindmap Viewer - 전체 기획 및 Phase 1 구현 계획

## Context

현재 `mindmap-viewer`는 Claude Code의 PostToolUse/Stop 훅으로 도구 호출 이벤트만 캡처하여 vis-network으로 시각화하는 단순한 도구다. 사용자의 비전은 이것을 **개인 → 팀 → 회사** 단위의 실시간 작업 시각화 플랫폼으로 확장하는 것이다.

**핵심 문제**: 현재는 도구 이벤트만 기록되고, 실제 대화 내용(질문/답변/의사결정)이 빠져있다. 마인드맵의 가장 중요한 "의사결정 흐름"이 없는 상태.

**목표**: 대화 전체가 트리 구조로 시각화되고, 활동량에 따라 노드가 빛나며, 롤백/분기/주석이 가능한 실시간 작업 대시보드.

---

## 전체 비전 (3 스케일)

| 스케일 | 대상 | 핵심 기능 |
|--------|------|-----------|
| **Small** | 개인 | 내 대화/작업 마인드맵, 에이전트 동작 시각화, 노드 수동 추가 |
| **Medium** | 팀 | 채널 공유, 팀원별 작업 실시간 확인, 멀티유저 프레즌스 |
| **Large** | 회사 | 권한 관리, 메신저/브라우저 연동, 부서별 대시보드 |

---

## Phase 1 구현 계획 (개인용 강화 버전)

### 변경 파일 목록

| 파일 | 작업 | 설명 |
|------|------|------|
| `package.json` | 수정 | better-sqlite3, ulid 추가 |
| `save-turn.js` | **대폭 수정** | 16개 훅 전체 처리, 이벤트 정규화 |
| `event-normalizer.js` | **신규** | 훅 데이터 → 표준 이벤트 변환 |
| `db.js` | **신규** | SQLite 초기화/쿼리/마이그레이션 |
| `graph-engine.js` | **신규** | 이벤트 → 노드/엣지 투영, 활동 점수 |
| `server.js` | **대폭 수정** | SQLite 연동, 확장 API, 그래프 엔진 |
| `public/index.html` | **대폭 수정** | 트리 구조, 활동 시각화, 검색, 주석 |
| `~/.claude/settings.json` | 수정 | 10개 훅 등록 (현재 2개 → 10개) |

### Step 1: 이벤트 정규화 레이어 (`event-normalizer.js`)

모든 데이터를 하나의 표준 이벤트 포맷으로 통일:

```
MindmapEvent {
  id: ULID (시간순 정렬 가능)
  type: 'user.message' | 'assistant.message' | 'tool.end' | 'session.start' | ...
  sessionId, userId, channelId
  parentEventId (트리 구조의 핵심)
  data: 타입별 페이로드
  timestamp
}
```

훅 → 이벤트 매핑:

| Claude Code 훅 | 이벤트 타입 | 부모 연결 |
|----------------|-------------|-----------|
| UserPromptSubmit | `user.message` | 이전 assistant 메시지 |
| PostToolUse | `tool.end` + `file.*` | 현재 assistant 메시지 |
| Stop | `assistant.message` | 이전 user 메시지 |
| SessionStart | `session.start` | 없음 (루트) |
| SessionEnd | `session.end` | session.start |
| SubagentStart | `subagent.start` | 생성한 assistant 메시지 |
| SubagentStop | `subagent.stop` | subagent.start |

### Step 2: SQLite 저장소 (`db.js`)

JSONL은 유지하면서 SQLite를 주 쿼리 소스로 추가:

- `events` 테이블: 모든 이벤트 (ULID PK, type/session/timestamp 인덱스)
- `sessions` 테이블: 세션 메타데이터
- `files` 테이블: 파일별 접근 횟수 (중복 제거된 파일 노드)
- `annotations` 테이블: 사용자 수동 주석
- `graph_nodes`/`graph_edges`: 캐시된 그래프 상태

첫 기동 시 기존 conversation.jsonl → SQLite 자동 마이그레이션.

### Step 3: 그래프 엔진 (`graph-engine.js`)

현재 플랫 체인 → **트리 구조**로 전환:

```
Session (육각형)
├── User Message (파란 박스)
│   └── Assistant Message (초록 박스)
│       ├── Tool: Read (주황 다이아몬드) → File (보라 타원)
│       ├── Tool: Bash (주황 다이아몬드)
│       ├── Tool: Edit (주황 다이아몬드) → File (보라 타원)
│       └── Subagent (점선 그룹)
│           ├── Tool: Grep → File
│           └── Tool: Read → File
├── User Message
│   └── Assistant Message
│       └── ...
```

**활동 점수 알고리즘** (노드 빛남 강도 결정):
- 최근 활동: 지수 감쇠 (반감기 5분)
- 빈도 보정: 접근 횟수 log 스케일
- 합산: 최근성 70% + 빈도 30%
- 점수 0~1 → 노드 테두리 밝기, 크기(1x~1.5x), 펄스 애니메이션 속도

### Step 4: save-turn.js 확장

현재 2개 훅 → 10개 훅 처리:
- `UserPromptSubmit`: 사용자 실제 입력 텍스트 직접 캡처
- `PostToolUse`: 도구 결과 + 파일 추출 (기존 유지 + 강화)
- `Stop`: assistant 최종 응답 (`last_assistant_message`) 캡처
- `SessionStart/End`: 세션 시작/종료 이벤트
- `SubagentStart/Stop`: 서브에이전트 라이프사이클
- `Notification`, `TaskCompleted`: 알림/작업완료 이벤트

### Step 5: server.js 확장

새 API:
- `GET /api/graph?session=X` - 그래프 데이터 (노드+엣지)
- `GET /api/sessions` - 세션 목록
- `GET /api/search?q=X` - 전문 검색
- `GET /api/activity` - 활동 점수
- `POST /api/annotations` - 주석 추가
- `GET /api/files` - 파일 접근 통계

WebSocket 확장:
- `{ type: 'event', event, nodeUpdates, edgeUpdates }` - 실시간 그래프 업데이트
- `{ type: 'activity', scores }` - 10초마다 활동 점수 브로드캐스트

### Step 6: UI 대폭 강화 (`public/index.html`)

vis-network 유지하면서 다음 추가:

**A. 트리 그래프**: 세션 → 대화 → 도구 → 파일 계층 구조
**B. 노드 활동 시각화**: CSS glow 애니메이션, 점수 기반 밝기/크기/펄스
**C. 세션 사이드바**: 왼쪽에 세션 목록, 클릭하면 해당 세션 포커스
**D. 검색/필터**: 상단 검색바, 타입별 토글, 시간 범위 필터
**E. 주석 시스템**: 우클릭 → 메모 추가, 빈 공간 더블클릭 → 자유 노드
**F. 미니맵**: 우하단 전체 조감도
**G. 활동 대시보드**: 하단에 시간별 활동 히트맵

### Step 7: 훅 설정 업데이트

`~/.claude/settings.json`에 10개 훅 등록:
UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, SubagentStart, SubagentStop, Notification, TaskCompleted

---

## Phase 2-4 로드맵 (요약)

### Phase 2: 팀 공유 (React Flow + Yjs 마이그레이션)
- UI: vanilla JS → React + Vite + React Flow
- 실시간 협업: Yjs CRDT + y-websocket (채널/룸)
- 인증: JWT 기반 로그인
- 프레즌스: 팀원 커서/상태 표시
- save-turn.js → 중앙 서버 REST API로 POST

### Phase 3: 회사 대시보드
- Redis pub/sub로 수평 확장
- RBAC 권한 관리 (admin/manager/member/viewer)
- 부서별 채널 자동 생성
- 활동 리포트 (일간/주간)
- SSO 연동

### Phase 4: 외부 연동
- 플러그인/어댑터 시스템
- 메신저 연동 (Slack/Teams/카카오톡)
- 브라우저 확장
- 데스크톱 에이전트 (PC 활동 opt-in)

---

## 기술 스택

| 레이어 | Phase 1 | Phase 2+ |
|--------|---------|----------|
| 시각화 | vis-network 9 (유지) | React Flow 12 |
| 서버 | Express 4 | Express 4 |
| 실시간 | ws 8 | ws 8 + Yjs + y-websocket |
| DB | better-sqlite3 + JSONL | SQLite → PostgreSQL (P3) |
| ID | ulid | ulid |
| UI | vanilla JS (single file) | React 18 + Vite |
| 빌드 | 없음 | Vite |

**핵심 설계 원칙**: 이벤트 소싱 (모든 데이터는 이벤트로 들어오고, 그래프는 투영)

---

## Phase 5: 툴샵 & 플랫폼 생태계 (기획)

> 개발 범위 아님. MindMap을 **개발자 생태계 플랫폼**으로 확장하는 전략.

### 5-A. 툴샵 (Layout & Theme Marketplace)

사용자가 커스텀 레이아웃, 노드 스타일, 시각화 테마를 만들어 **공유·판매**할 수 있는 마켓플레이스.

**판매 가능 아이템:**

| 카테고리 | 예시 | 형태 |
|----------|------|------|
| **레이아웃 엔진** | 칸반 보드형, 타임라인형, 방사형, 깃 브랜치형, 피쉬본(원인분석)형 | JSON 설정 + JS 플러그인 |
| **노드 테마** | 네온, 미니멀, 레트로, 기업용 화이트 | CSS 변수 팩 |
| **필터 프리셋** | "코드 리뷰 모드" (파일+도구만), "의사결정 모드" (사용자+AI만) | 필터 규칙 JSON |
| **대시보드 위젯** | 활동 히트맵, 파일 접근 순위, 에러 추적기 | React 컴포넌트 |
| **커넥터** | Jira, Linear, Notion, Figma, GitHub Issues | 어댑터 모듈 |

**수익 구조:**
- 무료 공유 + 유료 프리미엄 템플릿 (70/30 수익 분배)
- 기업용 전용 테마 라이선스
- 인기 크리에이터 프로그램 (후원/구독)

**기술 요건:**
- 레이아웃 설정을 JSON Schema로 표준화
- 플러그인 샌드박스 (iframe 또는 Web Worker)
- 버전 관리 + 원클릭 설치/적용
- 평점·리뷰 시스템

### 5-B. 개발 플랫폼 통합 (Plugin/Extension System)

각 개발 도구에서 MindMap을 **네이티브처럼** 사용할 수 있게 하는 플러그인 시스템.

**대상 플랫폼 & 통합 방식:**

| 플랫폼 | 통합 형태 | 캡처 이벤트 |
|--------|-----------|-------------|
| **VS Code** | 사이드바 Extension | 파일 열기/저장, 디버그 세션, 터미널 명령, Git 작업 |
| **JetBrains (IntelliJ/WebStorm)** | Tool Window Plugin | 리팩토링, 빌드, 테스트 실행, VCS 작업 |
| **Git** | post-commit/post-merge 훅 | 커밋, 브랜치, 머지, 리베이스, PR 생성 |
| **GitHub/GitLab** | GitHub App / Webhook | PR 리뷰, 이슈 변경, CI/CD 파이프라인 |
| **브라우저** | Chrome/Firefox Extension | 탭 활동, 개발자 도구 사용, 문서 참조 |
| **터미널** | Shell 래퍼 (zsh/fish 플러그인) | 명령어 실행, 에러, 디렉토리 이동 |

**핵심 설계:**
- **이벤트 어댑터 패턴**: 각 플랫폼의 이벤트 → 표준 MindmapEvent 변환
- **로컬 우선**: 모든 데이터는 사용자 로컬에 저장 (옵트인으로 팀 서버 동기화)
- **설정 파일**: `.mindmap.json` (프로젝트 루트) — 어떤 이벤트를 캡처할지 사용자가 제어
- **SDK 제공**: `@mindmap/sdk` npm 패키지로 커스텀 이벤트 전송 API

### 5-C. 자유도 확대 로드맵

**노드 편집 자유도:**
- 노드 모양/색/크기를 우클릭 메뉴에서 직접 변경
- 수동 노드 생성 (더블클릭 → 타입 선택 → 텍스트 입력)
- 노드 그룹핑 (드래그로 선택 → 그룹 생성 → 접기/펼치기)
- 노드 간 수동 엣지 생성 (Shift+드래그)

**엣지 커스텀:**
- 의존성, 참조, 분기, 충돌 등 엣지 타입 정의
- 색상/두께/스타일(실선/점선/파선) 편집
- 양방향/단방향 전환

**뷰 저장:**
- 현재 필터+레이아웃+줌 상태를 "뷰"로 저장
- 뷰 간 빠른 전환 (탭 또는 단축키)
- 뷰를 팀과 공유 가능

**템플릿 시스템:**
- 빈 캔버스에서 시작하는 "수동 모드"
- 자동 캡처 + 수동 편집 혼합 모드
- 프로젝트별 기본 템플릿 설정

---

## Phase 6: 수익화 모델 — 컨텍스트 기반 스마트 광고 (기획)

> 개발 범위 아님. 최종 제품화 단계의 수익화 전략.

### 핵심 컨셉

사용자가 마인드맵에서 작업하는 **맥락(context)**을 분석하여, 그 작업을 **도와줄 수 있거나 연관된 제품/서비스** 광고를 노출.

기존 배너 광고와 다른 점: "방해"가 아니라 "도움"이 되는 광고.

### 광고 유형

| 유형 | 트리거 | 예시 |
|------|--------|------|
| **도구 추천** | 특정 도구를 반복 사용할 때 | "Bash로 DB 작업 많이 하시네요 → DataGrip 30일 무료" |
| **서비스 연동** | 외부 서비스 언급/사용 시 | "Slack 연동 논의 중 → Slack MCP 커넥터 프리미엄" |
| **학습 콘텐츠** | 에러/실패 패턴 감지 시 | "TypeScript 에러 자주 발생 → TS 마스터클래스 20% 할인" |
| **인프라 제안** | 스케일 관련 대화 시 | "배포 논의 중 → Vercel Pro 첫 달 무료" |
| **팀 협업 도구** | 멀티유저 기능 사용 시 | "팀 채널 3개 이상 → Linear/Notion 팀 플랜 추천" |

### 광고 배치 위치 (UI)

- **상세 패널 하단**: 선택한 노드 컨텍스트에 맞는 추천 1건
- **세션 사이드바 하단**: 현재 세션 전체 맥락에 맞는 추천
- **활동 대시보드 옆**: 작업 패턴 기반 주간 추천

### 수익화 단계

1. **무료 개인 사용**: 광고 없음 (사용자 확보)
2. **무료 팀 사용 (5인 이하)**: 하단에 컨텍스트 추천 1건
3. **프로 (유료)**: 광고 제거 + 고급 분석 + 무제한 채널
4. **엔터프라이즈**: 자체 호스팅 + RBAC + SLA + 광고 완전 제거

### 광고 수익 모델

- **CPC (클릭당 과금)**: 개발 도구/서비스 광고주로부터
- **제휴 수수료**: SaaS 연동 시 레퍼럴 수익
- **프리미엄 전환**: 광고 제거를 위한 유료 구독 유도
- **데이터 인사이트 (익명화)**: "개발자들이 가장 많이 쓰는 도구 TOP 10" 같은 트렌드 리포트를 B2B로 판매

### 핵심 원칙

- 광고는 **작업 흐름을 방해하지 않아야** 함
- 사용자 데이터는 **절대 외부 유출 없이** 로컬/서버 내에서만 분석
- 광고 클릭/노출 데이터만 익명 집계
- 유료 플랜에서는 완전 제거 가능

---

## 검증 방법

1. `npm install` 후 `npm run dev`로 서버 시작
2. Claude Code에서 아무 작업 수행
3. http://localhost:4747 에서 확인:
   - 사용자 질문이 파란 노드로 표시되는가?
   - AI 응답이 초록 노드로 표시되는가?
   - 도구 호출이 assistant 노드에서 분기되는가?
   - 최근 활동 노드가 밝게 빛나는가?
   - 검색으로 특정 내용을 찾을 수 있는가?
   - 노드 우클릭으로 주석을 달 수 있는가?
4. 롤백: 특정 노드에서 롤백 후 그래프가 정확히 잘리는가?
5. 새 세션 시작 시 사이드바에 새 세션이 나타나는가?
