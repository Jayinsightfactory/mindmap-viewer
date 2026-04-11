"""Orbit 서버 HTTP 통신 브리지"""
import json
import threading
import requests
from . import config


class OrbitBridge:
    def __init__(self):
        self._base = config.ORBIT_SERVER_URL
        self._enabled = config.ORBIT_ENABLED

    def notify_start(self, session_id, name):
        self._post("/api/recording/status", {
            "action": "start",
            "session_id": session_id,
            "name": name,
        })

    def notify_stop(self, session_id, total_events):
        self._post("/api/recording/status", {
            "action": "stop",
            "session_id": session_id,
            "total_events": total_events,
        })

    def send_activity(self, session_id, summary):
        self._post("/api/recording/activity", {
            "session_id": session_id,
            **summary,
        })

    def notify_playback(self, action, session_id, **kwargs):
        self._post(f"/api/recording/{'play' if action == 'start' else 'stop-playback'}", {
            "session_id": session_id,
            **kwargs,
        })

    def _post(self, path, data):
        if not self._enabled:
            return
        def _do():
            try:
                requests.post(
                    f"{self._base}{path}",
                    json=data,
                    timeout=3,
                )
            except Exception:
                pass  # 서버 미실행 시 무시
        threading.Thread(target=_do, daemon=True).start()
