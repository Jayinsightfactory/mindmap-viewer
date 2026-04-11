"""
orbit_bridge.py
─────────────────────────────────────────────────────────────────────────────
nenova_agent → Orbit 통합 이벤트 버스 HTTP 브릿지

사용법:
  from orbit_bridge import OrbitBridge

  bridge = OrbitBridge()  # .env 또는 config/orbit.json에서 설정 로드
  bridge.publish("agent.pipeline.stage_complete", {"stage": 1, "name": "수입/입고"})
  bridge.publish_batch([...])

네트워크 장애 시 로컬 SQLite 큐에 저장 후 자동 재전송.
─────────────────────────────────────────────────────────────────────────────
"""

import os
import json
import time
import sqlite3
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    raise ImportError("requests 패키지 필요: pip install requests")

logger = logging.getLogger("orbit_bridge")

# 기본 설정
DEFAULT_ORBIT_URL = "https://mindmap-viewer-production-adb2.up.railway.app"
DEFAULT_SOURCE = "nenova-agent"
DEFAULT_WORKSPACE = "nenova"
QUEUE_DB_PATH = Path(__file__).parent / "data" / "event_queue.db"
MAX_BATCH_SIZE = 50
RETRY_INTERVAL = 60  # 초
REQUEST_TIMEOUT = 15  # 초


class OrbitBridge:
    """Orbit 이벤트 버스 HTTP 클라이언트 + 로컬 큐 백업"""

    def __init__(self, orbit_url=None, api_token=None, source=None):
        self.orbit_url = (
            orbit_url
            or os.getenv("ORBIT_URL")
            or self._load_config("orbit_url")
            or DEFAULT_ORBIT_URL
        )
        self.api_token = (
            api_token
            or os.getenv("ORBIT_API_TOKEN")
            or os.getenv("AGENT_API_TOKEN")
            or self._load_config("api_token")
        )
        self.source = source or DEFAULT_SOURCE
        self.workspace_id = os.getenv("ORBIT_WORKSPACE") or DEFAULT_WORKSPACE

        if not self.api_token:
            logger.warning("ORBIT_API_TOKEN 미설정 — 이벤트 발행 시 인증 실패 가능")

        # 로컬 SQLite 큐 초기화
        self._init_queue_db()

        # 백그라운드 재전송 스레드
        self._retry_thread = None
        self._running = False

    def _load_config(self, key):
        """config/orbit.json에서 설정 로드"""
        config_path = Path(__file__).parent / "config" / "orbit.json"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    return json.load(f).get(key)
            except Exception:
                pass
        return None

    def _init_queue_db(self):
        """로컬 이벤트 큐 DB 초기화"""
        QUEUE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._queue_db = sqlite3.connect(str(QUEUE_DB_PATH), check_same_thread=False)
        self._queue_db.execute("""
            CREATE TABLE IF NOT EXISTS pending_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                retry_count INTEGER DEFAULT 0,
                last_error TEXT
            )
        """)
        self._queue_db.commit()
        self._queue_lock = threading.Lock()

    # ─── 이벤트 발행 ──────────────────────────────────────────────────────

    def publish(self, event_type, data=None, **kwargs):
        """
        단일 이벤트 발행

        Args:
            event_type: 이벤트 타입 (예: "agent.pipeline.stage_complete")
            data: 이벤트 페이로드 (dict)
            **kwargs: user_id, session_id, correlation_id, metadata 등

        Returns:
            dict: 발행 결과 또는 None (큐에 저장됨)
        """
        event = {
            "type": event_type,
            "source": self.source,
            "workspace_id": self.workspace_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data or {},
        }
        for k in ("user_id", "session_id", "correlation_id", "metadata"):
            if k in kwargs:
                event[k] = kwargs[k]

        return self._send_events([event])

    def publish_batch(self, events):
        """
        배치 이벤트 발행

        Args:
            events: list of dicts, 각각 {"type": ..., "data": ...}
        """
        prepared = []
        ts = datetime.now(timezone.utc).isoformat()
        for evt in events:
            prepared.append({
                "type": evt.get("type"),
                "source": self.source,
                "workspace_id": self.workspace_id,
                "timestamp": evt.get("timestamp", ts),
                "data": evt.get("data", {}),
                "user_id": evt.get("user_id"),
                "session_id": evt.get("session_id"),
                "correlation_id": evt.get("correlation_id"),
                "metadata": evt.get("metadata"),
            })
        return self._send_events(prepared)

    def _send_events(self, events):
        """HTTP POST로 이벤트 전송, 실패 시 로컬 큐에 저장"""
        url = f"{self.orbit_url.rstrip('/')}/api/events/publish"
        headers = {"Content-Type": "application/json"}
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"

        try:
            resp = requests.post(
                url,
                json=events if len(events) > 1 else events[0],
                headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 200:
                result = resp.json()
                logger.info(
                    "이벤트 발행 성공: %d건 (published=%s)",
                    len(events),
                    result.get("published"),
                )
                return result
            else:
                raise Exception(f"HTTP {resp.status_code}: {resp.text[:200]}")

        except Exception as e:
            logger.warning("이벤트 전송 실패 → 로컬 큐 저장: %s", str(e)[:100])
            self._enqueue(events, str(e))
            return None

    # ─── 로컬 큐 관리 ──────────────────────────────────────────────────────

    def _enqueue(self, events, error_msg=""):
        """실패한 이벤트를 로컬 SQLite 큐에 저장"""
        with self._queue_lock:
            ts = datetime.now(timezone.utc).isoformat()
            for evt in events:
                self._queue_db.execute(
                    "INSERT INTO pending_events (event_json, created_at, last_error) VALUES (?, ?, ?)",
                    (json.dumps(evt, ensure_ascii=False), ts, error_msg[:500]),
                )
            self._queue_db.commit()

    def flush_queue(self):
        """큐에 쌓인 이벤트를 재전송"""
        with self._queue_lock:
            rows = self._queue_db.execute(
                "SELECT id, event_json, retry_count FROM pending_events ORDER BY id LIMIT ?",
                (MAX_BATCH_SIZE,),
            ).fetchall()

        if not rows:
            return 0

        events = []
        ids = []
        for row_id, event_json, retry_count in rows:
            try:
                events.append(json.loads(event_json))
                ids.append(row_id)
            except json.JSONDecodeError:
                # 깨진 이벤트 제거
                with self._queue_lock:
                    self._queue_db.execute("DELETE FROM pending_events WHERE id = ?", (row_id,))
                    self._queue_db.commit()

        if not events:
            return 0

        url = f"{self.orbit_url.rstrip('/')}/api/events/publish"
        headers = {"Content-Type": "application/json"}
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"

        try:
            resp = requests.post(url, json=events, headers=headers, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                with self._queue_lock:
                    self._queue_db.execute(
                        f"DELETE FROM pending_events WHERE id IN ({','.join('?' * len(ids))})",
                        ids,
                    )
                    self._queue_db.commit()
                logger.info("큐 플러시 성공: %d건 재전송", len(events))
                return len(events)
            else:
                raise Exception(f"HTTP {resp.status_code}")
        except Exception as e:
            # 재시도 카운트 증가
            with self._queue_lock:
                for row_id in ids:
                    self._queue_db.execute(
                        "UPDATE pending_events SET retry_count = retry_count + 1, last_error = ? WHERE id = ?",
                        (str(e)[:500], row_id),
                    )
                self._queue_db.commit()
            logger.warning("큐 플러시 실패: %s", str(e)[:100])
            return 0

    def queue_size(self):
        """큐에 남은 이벤트 수"""
        with self._queue_lock:
            row = self._queue_db.execute("SELECT COUNT(*) FROM pending_events").fetchone()
            return row[0] if row else 0

    # ─── 백그라운드 재전송 ──────────────────────────────────────────────────

    def start_retry_loop(self, interval=RETRY_INTERVAL):
        """백그라운드에서 큐 재전송 루프 시작"""
        if self._running:
            return
        self._running = True

        def _loop():
            while self._running:
                try:
                    flushed = self.flush_queue()
                    if flushed > 0:
                        logger.info("백그라운드 재전송: %d건", flushed)
                except Exception as e:
                    logger.warning("재전송 루프 오류: %s", str(e)[:100])
                time.sleep(interval)

        self._retry_thread = threading.Thread(target=_loop, daemon=True)
        self._retry_thread.start()
        logger.info("백그라운드 재전송 루프 시작 (간격: %ds)", interval)

    def stop_retry_loop(self):
        """백그라운드 재전송 중지"""
        self._running = False

    # ─── 유틸리티 ──────────────────────────────────────────────────────────

    def health(self):
        """Orbit 이벤트 버스 상태 확인"""
        url = f"{self.orbit_url.rstrip('/')}/api/events/health"
        try:
            resp = requests.get(url, timeout=5)
            return resp.json()
        except Exception as e:
            return {"status": "unreachable", "error": str(e)[:200]}

    def close(self):
        """리소스 정리"""
        self.stop_retry_loop()
        if self._queue_db:
            self._queue_db.close()


# ─── 편의 함수 (모듈 레벨) ──────────────────────────────────────────────────

_default_bridge = None


def get_bridge():
    """싱글턴 브릿지 인스턴스"""
    global _default_bridge
    if _default_bridge is None:
        _default_bridge = OrbitBridge()
        _default_bridge.start_retry_loop()
    return _default_bridge


def publish(event_type, data=None, **kwargs):
    """모듈 레벨 이벤트 발행"""
    return get_bridge().publish(event_type, data, **kwargs)


# ─── CLI 테스트 ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")

    bridge = OrbitBridge()

    if len(sys.argv) > 1 and sys.argv[1] == "test":
        print("=== Orbit Bridge 연결 테스트 ===")
        print(f"URL: {bridge.orbit_url}")
        print(f"Token: {'설정됨' if bridge.api_token else '미설정'}")

        # Health check
        h = bridge.health()
        print(f"Health: {json.dumps(h, indent=2)}")

        # 테스트 이벤트 발행
        result = bridge.publish(
            "agent.test.ping",
            {"message": "orbit_bridge 연결 테스트", "timestamp": datetime.now(timezone.utc).isoformat()},
        )
        if result:
            print(f"테스트 이벤트 발행 성공: {json.dumps(result, indent=2)}")
        else:
            print(f"테스트 이벤트 큐에 저장됨 (큐 크기: {bridge.queue_size()})")

        bridge.close()
    else:
        print("Usage: python orbit_bridge.py test")
