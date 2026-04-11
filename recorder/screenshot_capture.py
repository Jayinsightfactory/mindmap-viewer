"""스크린샷 캡처 (mss + Pillow)"""
import uuid
import threading
from pathlib import Path
from datetime import datetime, timezone

import mss
from PIL import Image

from . import config
from . import db_schema as db


class ScreenshotCapture:
    def __init__(self, session_id):
        self._session_id = session_id
        self._lock = threading.Lock()
        self._periodic_timer = None

    def start(self):
        """주기적 캡처 시작 (설정된 경우)"""
        if config.SCREENSHOT_INTERVAL_SEC > 0:
            self._schedule_periodic()

    def stop(self):
        if self._periodic_timer:
            self._periodic_timer.cancel()
            self._periodic_timer = None

    def capture(self, trigger="click"):
        """스크린샷 캡처 → 파일 저장 → DB 기록 → screenshot_id 반환"""
        with self._lock:
            try:
                screenshot_id = uuid.uuid4().hex[:12]
                filename = f"{screenshot_id}.jpg"
                filepath = config.SCREENSHOT_DIR / filename

                with mss.mss() as sct:
                    monitor = sct.monitors[0]  # 전체 화면
                    raw = sct.grab(monitor)
                    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

                # 리사이즈 (max width)
                if img.width > config.SCREENSHOT_MAX_WIDTH:
                    ratio = config.SCREENSHOT_MAX_WIDTH / img.width
                    new_h = int(img.height * ratio)
                    img = img.resize((config.SCREENSHOT_MAX_WIDTH, new_h), Image.LANCZOS)

                img.save(str(filepath), "JPEG", quality=config.SCREENSHOT_QUALITY)

                db.insert_screenshot(
                    screenshot_id, self._session_id,
                    str(filepath), img.width, img.height
                )

                return screenshot_id, img.width, img.height
            except Exception as e:
                print(f"[screenshot] 캡처 실패: {e}")
                return None, 0, 0

    def _schedule_periodic(self):
        if config.SCREENSHOT_INTERVAL_SEC > 0:
            self.capture(trigger="periodic")
            self._periodic_timer = threading.Timer(
                config.SCREENSHOT_INTERVAL_SEC, self._schedule_periodic
            )
            self._periodic_timer.daemon = True
            self._periodic_timer.start()
