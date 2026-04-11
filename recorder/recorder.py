"""메인 녹화 오케스트레이터 - 키보드+마우스+스크린샷 통합"""
import time
import platform
import threading
from datetime import datetime, timezone

from . import config
from . import db_schema as db
from .keyboard_capture import KeyboardCapture
from .mouse_capture import MouseCapture
from .screenshot_capture import ScreenshotCapture
from .orbit_bridge import OrbitBridge


class Recorder:
    def __init__(self, name="unnamed"):
        self._name = name
        self._session_id = None
        self._start_time = 0
        self._running = False
        self._paused = False
        self._event_buffer = []
        self._buffer_lock = threading.Lock()
        self._flush_timer = None

        self._keyboard = None
        self._mouse = None
        self._screenshot = None
        self._bridge = OrbitBridge()
        self._activity_count = {"keydown": 0, "keyup": 0, "mouse_click": 0, "mouse_move": 0, "mouse_scroll": 0}

    @property
    def session_id(self):
        return self._session_id

    @property
    def is_running(self):
        return self._running

    def start(self):
        """녹화 시작"""
        if self._running:
            print("[recorder] 이미 녹화 중")
            return

        # 메타데이터 수집
        meta = {
            "platform": platform.system(),
            "platform_version": platform.version(),
            "hostname": platform.node(),
        }

        # 세션 생성
        self._session_id = db.create_session(self._name, meta)
        self._start_time = time.time()
        self._running = True
        self._paused = False

        # 스크린샷 엔진
        self._screenshot = ScreenshotCapture(self._session_id)
        self._screenshot.start()

        # 마우스 캡처
        self._mouse = MouseCapture(
            event_callback=self._on_event,
            click_callback=self._on_click_screenshot,
        )
        self._mouse.start()

        # 키보드 캡처
        self._keyboard = KeyboardCapture(
            event_callback=self._on_event,
            emergency_stop_callback=self._emergency_stop,
        )
        self._keyboard.start()

        # 배치 플러시 시작
        self._schedule_flush()

        # Orbit 알림
        self._bridge.notify_start(self._session_id, self._name)

        print(f"[recorder] 녹화 시작: {self._name} (session: {self._session_id})")
        print(f"[recorder] F12 = 긴급 정지")

    def stop(self):
        """녹화 종료"""
        if not self._running:
            return

        self._running = False

        # 리스너 정지
        if self._keyboard:
            self._keyboard.stop()
        if self._mouse:
            self._mouse.stop()
        if self._screenshot:
            self._screenshot.stop()

        # 타이머 정지
        if self._flush_timer:
            self._flush_timer.cancel()

        # 잔여 버퍼 플러시
        self._flush_buffer()

        # 세션 종료
        db.end_session(self._session_id)

        total = db.get_event_count(self._session_id)
        self._bridge.notify_stop(self._session_id, total)

        print(f"[recorder] 녹화 종료: {total}개 이벤트 기록됨")

    def pause(self):
        self._paused = True
        db.update_session_status(self._session_id, "paused")
        print("[recorder] 일시정지")

    def resume(self):
        self._paused = False
        db.update_session_status(self._session_id, "recording")
        print("[recorder] 재개")

    def _on_event(self, event):
        """이벤트 콜백 → 버퍼에 추가"""
        if not self._running or self._paused:
            return

        now = time.time()
        event["session_id"] = self._session_id
        event["timestamp_ms"] = int((now - self._start_time) * 1000)
        event["timestamp_abs"] = datetime.now(timezone.utc).isoformat()

        with self._buffer_lock:
            self._event_buffer.append(event)

        # 활동 카운트
        etype = event.get("event_type", "")
        if etype in self._activity_count:
            self._activity_count[etype] += 1

    def _on_click_screenshot(self, x, y, button):
        """클릭 시 스크린샷 캡처"""
        if not config.SCREENSHOT_ON_CLICK or not self._running:
            return

        def _capture():
            sid, w, h = self._screenshot.capture(trigger="click")
            if sid:
                self._on_event({
                    "event_type": "screenshot",
                    "data": {"screenshot_id": sid, "trigger": "click", "click_x": x, "click_y": y}
                })
        threading.Thread(target=_capture, daemon=True).start()

    def _flush_buffer(self):
        """버퍼 → DB 배치 저장"""
        with self._buffer_lock:
            if not self._event_buffer:
                return
            batch = self._event_buffer[:]
            self._event_buffer.clear()

        try:
            db.insert_events_batch(batch)
        except Exception as e:
            print(f"[recorder] DB 저장 오류: {e}")

    def _schedule_flush(self):
        """주기적 버퍼 플러시"""
        if not self._running:
            return
        self._flush_buffer()

        # 활동 요약 전송 (5초마다)
        total = sum(self._activity_count.values())
        if total > 0 and total % 50 < 10:
            self._bridge.send_activity(self._session_id, {
                "counts": dict(self._activity_count),
                "total": total,
            })

        self._flush_timer = threading.Timer(config.BATCH_FLUSH_INTERVAL_SEC, self._schedule_flush)
        self._flush_timer.daemon = True
        self._flush_timer.start()

    def _emergency_stop(self):
        """F12 긴급 정지"""
        print("\n[recorder] ⚠ F12 긴급 정지!")
        self.stop()
