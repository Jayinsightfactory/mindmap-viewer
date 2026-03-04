# PostgreSQL 전환 계획

> SQLite → PostgreSQL 마이그레이션
> 목적: SaaS 멀티테넌트 대응, 다중 서버 배포, 동시 쓰기 처리

---

## 왜 지금 해야 하는가

| 항목 | SQLite (현재) | PostgreSQL (목표) |
|------|--------------|------------------|
| 다중 서버 | 불가 (파일 기반) | 가능 |
| 동시 쓰기 | Write Lock 병목 | 완전 병렬 처리 |
| Railway 배포 | 영구 볼륨 필요, 복잡 | 환경변수 하나로 연결 |
| 데이터 백업 | 수동 | 자동 (Railway/Supabase 제공) |
| 유료 사용자 10팀 이상 | 위험 | 안전 |

**타이밍**: 유료 사용자 생기기 전에 완료해야 함. 이후엔 데이터 이전이 매우 복잡해짐.

---

## 현재 테이블 목록 (db.js 기준)

```
events              ← 핵심, 가장 많은 데이터
sessions            ← 세션 관리
files               ← 파일 접근 추적
annotations         ← 이벤트 주석
user_labels         ← 노드 라벨 커스텀
user_categories     ← 카테고리 커스텀
category_mappings   ← 타입-카테고리 연결
tool_label_mappings ← 도구명 커스텀
```

---

## 전환 3단계

---

### Stage 1: PostgreSQL 준비 (1~2일)

#### 1-1. 로컬 PostgreSQL 설치 (개발용)

```bash
# macOS
brew install postgresql@15
brew services start postgresql@15

# DB 생성
psql postgres -c "CREATE USER orbit WITH PASSWORD 'orbit_dev';"
psql postgres -c "CREATE DATABASE orbit_dev OWNER orbit;"
```

#### 1-2. 의존성 교체

```bash
# 제거
npm uninstall better-sqlite3

# 추가
npm install pg pg-pool dotenv
```

#### 1-3. .env 파일 생성

```bash
# .env (gitignore에 이미 포함됨)
DATABASE_URL=postgresql://orbit:orbit_dev@localhost:5432/orbit_dev

# Railway 배포 시엔 자동으로 DATABASE_URL 주입됨
```

---

### Stage 2: db.js 교체 (2~3일)

SQLite API와 PostgreSQL API의 핵심 차이:

```js
// SQLite (현재)                     // PostgreSQL (변경 후)
db.prepare(sql).run(...params)   →   await pool.query(sql, params)
db.prepare(sql).get(...params)   →   const { rows } = await pool.query(sql, params); rows[0]
db.prepare(sql).all(...params)   →   const { rows } = await pool.query(sql, params); rows
db.transaction(fn)()             →   client = await pool.connect(); BEGIN/COMMIT/ROLLBACK
db.pragma(...)                   →   연결 옵션으로 처리
```

#### 새 db.js 구조

```js
// db.js (PostgreSQL 버전)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // Railway SSL
    : false
});

async function initDatabase() {
  await createTables();
  console.log('[DB] PostgreSQL 연결 완료');
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'claude-hook',
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'local',
      channel_id TEXT NOT NULL DEFAULT 'default',
      parent_event_id TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      data_json JSONB NOT NULL,           -- TEXT → JSONB (쿼리 가능)
      metadata_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel_id);

    -- JSONB 인덱스 (data_json 내부 필드 검색용)
    CREATE INDEX IF NOT EXISTS idx_events_data ON events USING GIN(data_json);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      channel_id TEXT NOT NULL DEFAULT 'default',
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      source TEXT,
      model_id TEXT,
      project_dir TEXT,
      event_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      name TEXT,
      language TEXT,
      first_seen_at TIMESTAMPTZ,
      last_accessed_at TIMESTAMPTZ,
      access_count INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES events(id),
      label TEXT NOT NULL,
      description TEXT,
      color TEXT DEFAULT '#f0c674',
      icon TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_labels (
      event_id TEXT PRIMARY KEY,
      custom_header TEXT,
      custom_body TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8b949e',
      icon TEXT DEFAULT '📁',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_mappings (
      event_type TEXT NOT NULL,
      category_id TEXT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
      PRIMARY KEY (event_type, category_id)
    );

    CREATE TABLE IF NOT EXISTS tool_label_mappings (
      tool_name TEXT PRIMARY KEY,
      custom_label TEXT NOT NULL,
      custom_header TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
```

#### SQLite → PostgreSQL 문법 차이 체크리스트

```
SQLite                          PostgreSQL
─────────────────────────────────────────────
datetime('now')              →  NOW()
INSERT OR IGNORE             →  INSERT ... ON CONFLICT DO NOTHING
INSERT OR REPLACE            →  INSERT ... ON CONFLICT DO UPDATE
json_extract(col, '$.key')   →  col->>'key'  (JSONB)
TEXT (날짜 저장)              →  TIMESTAMPTZ
AUTOINCREMENT                →  SERIAL 또는 GENERATED ALWAYS
```

---

### Stage 3: 데이터 이전 (1일)

기존 SQLite 데이터를 PostgreSQL로 옮기는 스크립트:

```js
// migrate-sqlite-to-pg.js
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config();

const sqlite = new Database('./data/mindmap.db');
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  console.log('SQLite → PostgreSQL 마이그레이션 시작...');

  // 1. events
  const events = sqlite.prepare('SELECT * FROM events').all();
  console.log(`events: ${events.length}개`);
  for (const e of events) {
    await pg.query(
      `INSERT INTO events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [e.id, e.type, e.source, e.session_id, e.user_id, e.channel_id,
       e.parent_event_id, e.timestamp, e.data_json, e.metadata_json, e.created_at]
    );
  }

  // 2. sessions
  const sessions = sqlite.prepare('SELECT * FROM sessions').all();
  for (const s of sessions) {
    await pg.query(
      `INSERT INTO sessions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [s.id, s.user_id, s.channel_id, s.started_at, s.ended_at,
       s.source, s.model_id, s.project_dir, s.event_count, s.status]
    );
  }

  // 3. files, annotations, user_labels 등 동일하게 반복

  console.log('✅ 마이그레이션 완료');
  process.exit(0);
}

migrate().catch(console.error);
```

---

## Railway 배포 변경사항

현재 Railway 설정 (railway.json):
```json
{ "build": { "builder": "NIXPACKS" }, "deploy": { "startCommand": "node server.js" } }
```

PostgreSQL 전환 후 추가:
1. Railway 대시보드 → 프로젝트 → **Add Service → PostgreSQL** 클릭
2. 자동으로 `DATABASE_URL` 환경변수 주입됨
3. 코드 변경 없이 바로 연결됨

---

## 전환 순서 요약

```
Day 1:  로컬 PostgreSQL 설치 + .env 설정
        npm 패키지 교체 (better-sqlite3 → pg)

Day 2:  db.js 새 버전 작성
        서버 로컬 테스트

Day 3:  migrate-sqlite-to-pg.js 실행
        기존 데이터 이전 확인

Day 4:  Railway에 PostgreSQL 서비스 추가
        배포 테스트
        기존 SQLite 파일 아카이브 (삭제 X)
```

---

## 롤백 계획

전환 중 문제 발생 시:
- SQLite db 파일은 `data/mindmap.db`에 그대로 보존
- `DATABASE_URL` 환경변수 제거하면 SQLite 모드로 폴백 가능하도록
  db.js에 분기 처리 추가

```js
// db.js 상단 분기
if (process.env.DATABASE_URL) {
  module.exports = require('./db-pg.js');   // PostgreSQL
} else {
  module.exports = require('./db-sqlite.js'); // SQLite (기존)
}
```

→ 안전하게 단계적 전환 가능

---

## 완료 기준

- [ ] 로컬에서 PostgreSQL로 서버 정상 실행
- [ ] 기존 SQLite 데이터 100% 이전 확인
- [ ] Railway 배포 후 정상 동작
- [ ] better-sqlite3 의존성 제거
- [ ] .env.example 파일 업데이트
