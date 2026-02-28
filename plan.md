# Orbit Personal Context MCP 서버 — 구현 계획

> 작성일: 2026-02-28
> 목표: Orbit이 MCP 서버 역할을 해서, Claude가 MCP 프로토콜로 "내 작업 패턴/이력/outcome"을 읽고 개인화 추론에 활용할 수 있게 한다.

---

## 접근 방식 및 근거

### 왜 HTTP transport인가 (stdio 아님)
- server.js가 이미 `http.createServer(app)`로 실행 중
- `@modelcontextprotocol/sdk`의 `StreamableHTTPServerTransport`를 Express 라우터로 마운트 가능
- stdio transport는 별도 프로세스가 필요해서 기존 DB/WebSocket 접근이 복잡해짐
- 기존 `authMiddleware` (Bearer 토큰) 그대로 재사용 가능

### 왜 새 파일 `src/mcp-server.js`인가
- 기존 라우터 패턴 `createRouter(deps)` 유지
- server.js는 마운트만 함 → God File 방지
- 테스트 시 deps mock 주입 가능 (기존 패턴 동일)

### outcome-store는 왜 따로 만드는가
- 현재 DB에 "세션 목표 + 결과" 개념이 없음 (sessions 테이블은 시작/종료만)
- growth.db의 patterns/suggestions는 자동 감지용 — 사용자가 직접 기록하는 게 다름
- SQLite 파일 추가 없이 기존 `src/db.js`의 `mindmap.db`에 테이블 추가 (마이그레이션)

---

## 수정/생성 파일 목록

| 파일 | 작업 | 이유 |
|------|------|------|
| `package.json` | `@modelcontextprotocol/sdk` 추가 | MCP SDK 필요 |
| `src/outcome-store.js` | **신규 생성** | 세션 목표+결과 저장소 |
| `src/mcp-server.js` | **신규 생성** | MCP 서버 핵심 로직 |
| `src/db.js` | `outcomes` 테이블 마이그레이션 추가 | ALTER TABLE 안전하게 |
| `server.js` | MCP 라우터 마운트 추가 | 기존 패턴 그대로 |
| `.env.example` | `MCP_AUTH_TOKEN` 변수 추가 | 문서화 |

**건드리면 안 되는 것:**
- `src/db.js`의 기존 `events`, `sessions`, `files` 테이블 스키마
- `src/insight-engine.js`의 `analyzeEvents` 로직 (재사용만)
- `broadcastAll`, `broadcastToChannel` 시그니처
- `authMiddleware`, `optionalAuth` 동작 방식
- 기존 `/api/*` 엔드포인트 URL 전부

---

## 단계별 작업 목록

### Step 1. 패키지 설치
- [x] `package.json`에 `"@modelcontextprotocol/sdk": "^1.0.0"` 추가
- [x] `npm install` 실행

### Step 2. outcome-store.js 생성
- [x] `src/outcome-store.js` 신규 생성
- [x] 기존 `src/db.js`의 `getDb()` 함수로 동일 DB 연결 재사용 (새 DB 파일 금지)
- [x] `outcomes` 테이블 DDL (try/catch ALTER TABLE 패턴으로 기존 DB 안전 처리)
- [x] 구현할 함수:
  - `saveOutcome({ sessionId, userId, goal, result, toolsUsed, durationMin, tags })`
  - `getOutcomes({ userId, limit, fromDate })`
  - `getOutcomeBySession(sessionId)`

**outcomes 테이블 스키마:**
```sql
CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  user_id     TEXT DEFAULT 'local',
  goal        TEXT,           -- 사용자가 입력한 작업 목표
  result      TEXT,           -- 'success' | 'partial' | 'abandoned'
  summary     TEXT,           -- 자유형식 메모
  tools_used  TEXT,           -- JSON array of tool names
  duration_min INTEGER,
  tags        TEXT,           -- JSON array
  created_at  TEXT NOT NULL
)
```

### Step 3. src/mcp-server.js 생성
- [x] `createMcpRouter(deps)` 패턴으로 작성
- [x] deps에 주입받을 것: `{ getAllEvents, getStats, getSessions, getInsights, getPatterns, getSuggestions, getOutcomes, analyzeEvents, verifyToken }`
- [x] MCP 서버 인스턴스 생성 (`new McpServer({ name: 'orbit', version: '1.0.0' })`)
- [x] **Resources** 등록 (5개):
  - `orbit://context` — 개인 작업 패턴 요약 (자연어)
  - `orbit://events/recent` — 최근 이벤트 목록
  - `orbit://sessions` — 세션 목록 + outcome
  - `orbit://insights` — 인사이트 목록
  - `orbit://stats` — 통계 요약
- [x] **Tools** 등록 (4개):
  - `get_work_context` — 현재 작업 컨텍스트 전체 요약 생성
  - `get_patterns` — 반복 패턴 + 제안 목록
  - `search_events` — 키워드로 이벤트 검색
  - `save_outcome` — 세션 결과 저장 (유일한 쓰기 tool)
- [x] Express 라우터로 `POST /api/mcp` 마운트 (StreamableHTTPServerTransport)
- [x] 토큰 인증: `MCP_AUTH_TOKEN` 환경변수 또는 기존 `verifyToken` 사용

**MCP Tool 반환 포맷 설계:**
```
get_work_context 반환 예시:
{
  "period": "최근 7일",
  "totalEvents": 1997,
  "peakHour": 14,
  "hotFiles": ["server.js", "src/db.js"],
  "errorRate": "8%",
  "topTools": ["Bash", "Edit", "Read"],
  "recentOutcomes": [...],
  "insights": [...]
}
```

### Step 4. src/db.js 수정
- [x] `initDatabase()` 함수 내부에 `outcomes` 테이블 CREATE TABLE IF NOT EXISTS 추가
- [x] `module.exports`에 outcome 관련 함수 추가 불필요 (outcome-store.js에서 getDb() 직접 사용)

### Step 5. server.js 수정
- [x] `require('./src/outcome-store')` import 추가
- [x] `require('./src/mcp-server')` import 추가
- [x] `dbDeps` 객체에 `getInsights: insightEngine.getInsights` 추가
- [x] MCP 라우터 마운트:
  ```javascript
  const createMcpRouter = require('./src/mcp-server');
  app.use('/api', createMcpRouter({
    getAllEvents, getStats, getSessions,
    getInsights: insightEngine.getInsights,
    getPatterns, getSuggestions,
    getOutcomes: outcomeStore.getOutcomes,
    saveOutcome: outcomeStore.saveOutcome,
    analyzeEvents: insightEngine.analyzeEvents,
    verifyToken,
  }));
  ```
- [x] 서버 시작 로그에 `MCP: http://localhost:${PORT}/api/mcp` 추가

### Step 6. Claude Desktop 연동 설정 파일 생성
- [x] `mcp-config.example.json` 생성 (사용자가 `~/.claude/claude_desktop_config.json`에 복사)
  ```json
  {
    "mcpServers": {
      "orbit": {
        "command": "curl",
        "args": ["-s", "http://localhost:4747/api/mcp"],
        "type": "http",
        "headers": {
          "Authorization": "Bearer YOUR_ORBIT_TOKEN"
        }
      }
    }
  }
  ```
  > 참고: Claude Desktop의 MCP HTTP 설정 방식

### Step 7. 검증
- [x] `curl -X POST http://localhost:4747/api/mcp` 로 기본 연결 확인
- [x] `POST /api/mcp` — `initialize` 요청/응답 확인
- [x] `tools/list` — 4개 tool 목록 확인
- [x] `tools/call get_work_context` — 컨텍스트 반환 확인
- [x] `tools/call save_outcome` — outcome 저장 + DB 확인

---

## 핵심 코드 스니펫 (미리보기)

### src/mcp-server.js 구조
```javascript
'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const express = require('express');
const { z } = require('zod');

function createMcpRouter(deps) {
  const { getAllEvents, getStats, getSessions, getInsights,
          getPatterns, getSuggestions, getOutcomes, saveOutcome,
          analyzeEvents, verifyToken } = deps;

  const router = express.Router();

  // 요청마다 새 McpServer 인스턴스 (stateless HTTP transport 방식)
  router.post('/mcp', async (req, res) => {
    // 토큰 인증 (MCP_AUTH_TOKEN 없으면 로컬 전용으로 통과)
    const token = req.headers.authorization?.replace('Bearer ', '');
    const required = process.env.MCP_AUTH_TOKEN;
    if (required && token !== required) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const server = new McpServer({ name: 'orbit', version: '1.0.0' });

    // Resources 등록
    server.resource('orbit://stats', /* ... */);
    server.resource('orbit://insights', /* ... */);

    // Tools 등록
    server.tool('get_work_context', { days: z.number().optional() }, async ({ days = 7 }) => {
      const events   = getAllEvents().filter(/* 최근 N일 */);
      const insights = analyzeEvents(events);
      const stats    = getStats();
      const outcomes = getOutcomes({ limit: 10 });
      return { content: [{ type: 'text', text: JSON.stringify({ stats, insights, outcomes }) }] };
    });

    server.tool('save_outcome', {
      sessionId: z.string(),
      goal:      z.string(),
      result:    z.enum(['success', 'partial', 'abandoned']),
      summary:   z.string().optional(),
      tags:      z.array(z.string()).optional(),
    }, async (args) => {
      const saved = saveOutcome({ ...args, userId: 'local' });
      return { content: [{ type: 'text', text: `저장됨: ${saved.id}` }] };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}

module.exports = createMcpRouter;
```

### src/outcome-store.js 구조
```javascript
'use strict';
const { getDb } = require('./db');   // 기존 DB 연결 재사용

function initOutcomeTable() {
  const db = getDb();
  if (!db) return;
  db.prepare(`CREATE TABLE IF NOT EXISTS outcomes (
    id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT DEFAULT 'local',
    goal TEXT, result TEXT, summary TEXT,
    tools_used TEXT, duration_min INTEGER, tags TEXT, created_at TEXT NOT NULL
  )`).run();
}

function saveOutcome({ sessionId, userId = 'local', goal, result, summary, toolsUsed = [], tags = [] }) {
  const db = getDb();
  const id = require('crypto').randomBytes(8).toString('hex');
  db.prepare(`INSERT INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, userId, goal, result, summary || null,
         JSON.stringify(toolsUsed), null, JSON.stringify(tags),
         new Date().toISOString());
  return { id };
}

function getOutcomes({ userId, limit = 20, fromDate } = {}) { /* ... */ }
function getOutcomeBySession(sessionId) { /* ... */ }

module.exports = { initOutcomeTable, saveOutcome, getOutcomes, getOutcomeBySession };
```

---

## 트레이드오프 및 고려 사항

### 1. Stateless vs Stateful MCP 세션
- **선택: Stateless** (요청마다 새 McpServer 인스턴스)
- 이유: SSE 기반 stateful 세션은 Express와 충돌 가능성, 복잡도 높음
- 단점: 연속 대화에서 세션 컨텍스트 유지 불가 (MCP 자체가 단발 요청 중심이라 문제 없음)

### 2. 인증 전략
- `MCP_AUTH_TOKEN` 환경변수 없으면 → localhost 전용으로 인증 없이 통과
- 있으면 → Bearer 토큰 비교 (단순 비교, 타이밍 어택 방지 위해 `crypto.timingSafeEqual` 사용)
- 기존 `verifyToken()`은 사용자 DB 조회 — MCP는 서버 단위 토큰이라 분리

### 3. `get_work_context` 데이터 크기
- 이벤트 1997개 전체를 Claude에 전달하면 토큰 낭비
- 해결: 기간 필터 (기본 7일) + 요약 통계만 반환, 원본 이벤트는 넘기지 않음
- 인사이트 엔진의 `analyzeEvents()` 결과(6개 패턴)만 전달

### 4. `save_outcome` 쓰기 권한
- MCP tool 중 유일한 쓰기 작업 → 인증 필수
- 토큰 없는 환경에서는 save_outcome 비활성화 옵션 고려

### 5. zod 의존성
- `@modelcontextprotocol/sdk`가 zod를 peerDependency로 요구
- package.json에 `"zod": "^3.0.0"` 추가 필요

---

## 건드리면 안 되는 것

1. `src/db.js` — `events`, `sessions`, `files`, `annotations` 테이블 스키마 변경 금지
2. `src/insight-engine.js` — `analyzeEvents()` 함수 시그니처 변경 금지 (재사용만)
3. `routes/` 하위 기존 라우터들 — URL 패턴 변경 금지
4. `broadcastAll(msg)` / `broadcastToChannel(channelId, msg)` — 시그니처 변경 금지
5. `authMiddleware` / `optionalAuth` — 동작 방식 변경 금지
6. `dbDeps` 객체 기존 키 — 삭제/이름 변경 금지 (추가만 허용)
7. `PORT=4747` 기본값 — 변경 금지
