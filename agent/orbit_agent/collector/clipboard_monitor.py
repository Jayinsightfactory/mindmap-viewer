"""
collector/clipboard_monitor.py
클립보드 모니터링 — 복사/붙여넣기 데이터 흐름 추적

수집 데이터:
  - 복사한 내용 (텍스트)
  - 복사 시점의 앱 + 창 제목
  - 붙여넣기 시점의 앱 + 창 제목
  → 앱 간 데이터 이동 흐름 파악 (예: 이메일 → Excel)
"""
import time
import logging
import threading
from datetime import datetime

logger = logging.getLogger('orbit.clipboard')


class ClipboardMonitor:
    """클립보드 변경 감지"""

    def __init__(self, process_monitor=None, on_event=None):
        self._process_monitor = process_monitor
        self._on_event = on_event
        self._last_content = None
        self._last_hash = None
        self._running = False

    def poll(self):
        """클립보드 변경 체크 (1회)"""
        try:
            import pyperclip
            content = pyperclip.paste()
        except Exception:
            return

        if not content or content == self._last_content:
            return

        # 너무 긴 내용은 잘라서 저장 (원본은 10KB까지)
        self._last_content = content
        now = datetime.utcnow().isoformat() + 'Z'

        ctx = {}
        if self._process_monitor:
            ctx = self._process_monitor.get_context()

        truncated = content[:10240]
        preview = content[:200]

        event = {
            'type': 'clipboard.copy',
            'timestamp': now,
            'app': ctx.get('app', ''),
            'title': ctx.get('title', ''),
            'category': ctx.get('category', ''),
            'content': truncated,
            'preview': preview,
            'length': len(content),
            'is_multiline': '\n' in content,
        }

        if self._on_event:
            self._on_event(event)
