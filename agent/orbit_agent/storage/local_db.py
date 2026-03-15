"""
storage/local_db.py
로컬 SQLite 저장소 — 원시 이벤트 + 분석 결과

테이블:
  - raw_events: 수집된 원시 이벤트 (30일 후 자동 삭제)
  - analysis_results: Haiku 분석 결과 (영구 보관)
  - task_graphs: 학습된 작업 그래프 (영구 보관)
  - sync_queue: 서버 전송 대기열
"""
import json
import sqlite3
import logging
from datetime import datetime, timedelta
from pathlib import Path

from ..config import LOCAL_DB_PATH

logger = logging.getLogger('orbit.db')

_db = None


def get_db():
    """SQLite 연결 반환 (싱글톤)"""
    global _db
    if _db is None:
        LOCAL_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(str(LOCAL_DB_PATH), check_same_thread=False)
        _db.row_factory = sqlite3.Row
        _db.execute("PRAGMA journal_mode=WAL")
        _db.execute("PRAGMA synchronous=NORMAL")
        _init_tables(_db)
    return _db


def _init_tables(db):
    """테이블 생성"""
    db.executescript("""
        CREATE TABLE IF NOT EXISTS raw_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            app TEXT DEFAULT '',
            title TEXT DEFAULT '',
            category TEXT DEFAULT '',
            data_json TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS analysis_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            analyzed_at TEXT NOT NULL,
            period_start TEXT,
            period_end TEXT,
            events_count INTEGER DEFAULT 0,
            result_json TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            synced INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS task_graphs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_name TEXT NOT NULL,
            category TEXT DEFAULT '',
            steps_json TEXT NOT NULL,
            apps_json TEXT DEFAULT '[]',
            frequency TEXT DEFAULT '',
            avg_duration_min REAL DEFAULT 0,
            automation_score REAL DEFAULT 0,
            first_seen TEXT,
            last_seen TEXT,
            occurrence_count INTEGER DEFAULT 1,
            synced INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payload_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            attempts INTEGER DEFAULT 0,
            last_attempt TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_raw_events_ts ON raw_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events(type);
        CREATE INDEX IF NOT EXISTS idx_analysis_synced ON analysis_results(synced);
        CREATE INDEX IF NOT EXISTS idx_task_graphs_name ON task_graphs(task_name);
    """)
    db.commit()


def insert_event(event):
    """원시 이벤트 저장"""
    db = get_db()
    # data_json에 전체 이벤트 저장 (type, timestamp, app, title은 별도 컬럼)
    data = {k: v for k, v in event.items() if k not in ('type', 'timestamp', 'app', 'title', 'category')}

    db.execute(
        "INSERT INTO raw_events (type, timestamp, app, title, category, data_json) VALUES (?,?,?,?,?,?)",
        (
            event.get('type', ''),
            event.get('timestamp', datetime.utcnow().isoformat()),
            event.get('app', ''),
            event.get('title', ''),
            event.get('category', ''),
            json.dumps(data, ensure_ascii=False),
        )
    )
    db.commit()


def insert_events_batch(events):
    """이벤트 배치 저장"""
    db = get_db()
    rows = []
    for e in events:
        data = {k: v for k, v in e.items() if k not in ('type', 'timestamp', 'app', 'title', 'category')}
        rows.append((
            e.get('type', ''),
            e.get('timestamp', datetime.utcnow().isoformat()),
            e.get('app', ''),
            e.get('title', ''),
            e.get('category', ''),
            json.dumps(data, ensure_ascii=False),
        ))
    db.executemany(
        "INSERT INTO raw_events (type, timestamp, app, title, category, data_json) VALUES (?,?,?,?,?,?)",
        rows
    )
    db.commit()


def get_events_since(since_iso, event_types=None):
    """특정 시점 이후 이벤트 조회"""
    db = get_db()
    if event_types:
        placeholders = ','.join('?' * len(event_types))
        rows = db.execute(
            f"SELECT * FROM raw_events WHERE timestamp >= ? AND type IN ({placeholders}) ORDER BY timestamp",
            [since_iso] + list(event_types)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM raw_events WHERE timestamp >= ? ORDER BY timestamp",
            (since_iso,)
        ).fetchall()

    events = []
    for r in rows:
        e = dict(r)
        try:
            e.update(json.loads(e.pop('data_json', '{}')))
        except (json.JSONDecodeError, TypeError):
            pass
        events.append(e)
    return events


def save_analysis(result, period_start, period_end, events_count):
    """분석 결과 저장"""
    db = get_db()
    meta = result.get('_meta', {})
    db.execute(
        """INSERT INTO analysis_results
           (analyzed_at, period_start, period_end, events_count, result_json, input_tokens, output_tokens)
           VALUES (?,?,?,?,?,?,?)""",
        (
            datetime.utcnow().isoformat(),
            period_start,
            period_end,
            events_count,
            json.dumps(result, ensure_ascii=False),
            meta.get('input_tokens', 0),
            meta.get('output_tokens', 0),
        )
    )
    db.commit()


def upsert_task_graph(task):
    """작업 그래프 업데이트 (같은 이름이면 업데이트)"""
    db = get_db()
    existing = db.execute(
        "SELECT id, occurrence_count FROM task_graphs WHERE task_name = ?",
        (task['task_name'],)
    ).fetchone()

    now = datetime.utcnow().isoformat()
    if existing:
        db.execute(
            """UPDATE task_graphs SET
               steps_json=?, apps_json=?, avg_duration_min=?,
               automation_score=?, last_seen=?, occurrence_count=occurrence_count+1, synced=0
               WHERE id=?""",
            (
                json.dumps(task.get('steps', []), ensure_ascii=False),
                json.dumps(task.get('apps_used', []), ensure_ascii=False),
                task.get('duration_min', 0),
                task.get('automation_score', 0),
                now,
                existing['id'],
            )
        )
    else:
        db.execute(
            """INSERT INTO task_graphs
               (task_name, category, steps_json, apps_json, frequency,
                avg_duration_min, automation_score, first_seen, last_seen)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                task['task_name'],
                task.get('category', ''),
                json.dumps(task.get('steps', []), ensure_ascii=False),
                json.dumps(task.get('apps_used', []), ensure_ascii=False),
                task.get('frequency_guess', ''),
                task.get('duration_min', 0),
                task.get('automation_score', 0),
                now, now,
            )
        )
    db.commit()


def enqueue_sync(payload):
    """서버 동기화 대기열에 추가"""
    db = get_db()
    db.execute(
        "INSERT INTO sync_queue (payload_json) VALUES (?)",
        (json.dumps(payload, ensure_ascii=False),)
    )
    db.commit()


def get_pending_syncs(limit=50):
    """미전송 동기화 항목 조회"""
    db = get_db()
    rows = db.execute(
        "SELECT * FROM sync_queue WHERE attempts < 5 ORDER BY created_at LIMIT ?",
        (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def mark_synced(sync_id):
    """동기화 완료 처리"""
    db = get_db()
    db.execute("DELETE FROM sync_queue WHERE id = ?", (sync_id,))
    db.commit()


def mark_sync_failed(sync_id):
    """동기화 실패 기록"""
    db = get_db()
    db.execute(
        "UPDATE sync_queue SET attempts = attempts + 1, last_attempt = datetime('now') WHERE id = ?",
        (sync_id,)
    )
    db.commit()


def purge_old_events(days=30):
    """오래된 원시 이벤트 삭제 (분석 결과는 유지)"""
    db = get_db()
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
    result = db.execute("DELETE FROM raw_events WHERE timestamp < ?", (cutoff,))
    db.commit()
    count = result.rowcount
    if count:
        logger.info(f"오래된 이벤트 {count}개 삭제 ({days}일 이전)")
        db.execute("VACUUM")
    return count


def get_db_size_mb():
    """로컬 DB 파일 크기 (MB)"""
    if LOCAL_DB_PATH.exists():
        return LOCAL_DB_PATH.stat().st_size / (1024 * 1024)
    return 0
