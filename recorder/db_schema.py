"""SQLite 스키마 및 CRUD 함수 (data/recording.db)"""
import sqlite3
import json
import time
import uuid
from datetime import datetime, timezone
from . import config


def _connect():
    conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


_db = None

def get_db():
    global _db
    if _db is None:
        _db = _connect()
        _create_tables(_db)
    return _db


def _create_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS recording_sessions (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            started_at  TEXT NOT NULL,
            ended_at    TEXT,
            status      TEXT NOT NULL DEFAULT 'recording',
            total_events INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT
        );

        CREATE TABLE IF NOT EXISTS activity_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    TEXT NOT NULL,
            event_type    TEXT NOT NULL,
            timestamp_ms  INTEGER NOT NULL,
            timestamp_abs TEXT NOT NULL,
            data_json     TEXT,
            FOREIGN KEY (session_id) REFERENCES recording_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS screenshots (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            file_path   TEXT NOT NULL,
            width       INTEGER,
            height      INTEGER,
            captured_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES recording_sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session ON activity_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON activity_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);
    """)


# ─── 세션 CRUD ──────────────────────────────────

def create_session(name, metadata=None):
    db = get_db()
    sid = str(uuid.uuid4())[:8] + "-" + str(int(time.time()))
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT INTO recording_sessions (id, name, started_at, status, total_events, metadata_json) VALUES (?,?,?,?,?,?)",
        (sid, name, now, "recording", 0, json.dumps(metadata or {}))
    )
    db.commit()
    return sid


def end_session(session_id, status="completed"):
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    count = db.execute("SELECT COUNT(*) FROM activity_events WHERE session_id=?", (session_id,)).fetchone()[0]
    db.execute(
        "UPDATE recording_sessions SET ended_at=?, status=?, total_events=? WHERE id=?",
        (now, status, count, session_id)
    )
    db.commit()


def get_session(session_id):
    row = get_db().execute("SELECT * FROM recording_sessions WHERE id=?", (session_id,)).fetchone()
    return dict(row) if row else None


def list_sessions(limit=50):
    rows = get_db().execute(
        "SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def update_session_status(session_id, status):
    db = get_db()
    db.execute("UPDATE recording_sessions SET status=? WHERE id=?", (status, session_id))
    db.commit()


# ─── 이벤트 CRUD ────────────────────────────────

def insert_events_batch(events):
    """배치로 이벤트 삽입 (성능 최적화)"""
    db = get_db()
    db.executemany(
        "INSERT INTO activity_events (session_id, event_type, timestamp_ms, timestamp_abs, data_json) VALUES (?,?,?,?,?)",
        [(e["session_id"], e["event_type"], e["timestamp_ms"], e["timestamp_abs"], json.dumps(e.get("data", {}))) for e in events]
    )
    db.commit()


def get_events(session_id, event_type=None, limit=10000, offset=0):
    db = get_db()
    if event_type:
        rows = db.execute(
            "SELECT * FROM activity_events WHERE session_id=? AND event_type=? ORDER BY timestamp_ms LIMIT ? OFFSET ?",
            (session_id, event_type, limit, offset)
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM activity_events WHERE session_id=? ORDER BY timestamp_ms LIMIT ? OFFSET ?",
            (session_id, limit, offset)
        ).fetchall()
    return [dict(r) for r in rows]


def get_event_count(session_id):
    return get_db().execute(
        "SELECT COUNT(*) FROM activity_events WHERE session_id=?", (session_id,)
    ).fetchone()[0]


# ─── 스크린샷 CRUD ──────────────────────────────

def insert_screenshot(screenshot_id, session_id, file_path, width, height):
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT INTO screenshots (id, session_id, file_path, width, height, captured_at) VALUES (?,?,?,?,?,?)",
        (screenshot_id, session_id, file_path, width, height, now)
    )
    db.commit()


def get_screenshot(screenshot_id):
    row = get_db().execute("SELECT * FROM screenshots WHERE id=?", (screenshot_id,)).fetchone()
    return dict(row) if row else None


def get_screenshots_by_session(session_id):
    rows = get_db().execute(
        "SELECT * FROM screenshots WHERE session_id=? ORDER BY captured_at", (session_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def close():
    global _db
    if _db:
        _db.close()
        _db = None
