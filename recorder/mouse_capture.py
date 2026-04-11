"""마우스 이벤트 캡처 (pynput) - 클릭/이동/스크롤"""
import time
from pynput import mouse
from . import config


class MouseCapture:
    def __init__(self, event_callback, click_callback=None):
        """
        event_callback(event_dict) - 모든 마우스 이벤트
        click_callback(x, y, button) - 클릭 시 추가 콜백 (스크린샷용)
        """
        self._callback = event_callback
        self._click_callback = click_callback
        self._listener = None
        self._last_x = 0
        self._last_y = 0
        self._last_move_time = 0

    def start(self):
        self._listener = mouse.Listener(
            on_click=self._on_click,
            on_move=self._on_move,
            on_scroll=self._on_scroll
        )
        self._listener.start()

    def stop(self):
        if self._listener:
            self._listener.stop()
            self._listener = None

    def _on_click(self, x, y, button, pressed):
        btn_name = button.name if hasattr(button, 'name') else str(button)
        self._callback({
            "event_type": "mouse_click",
            "data": {
                "x": x, "y": y,
                "button": btn_name,
                "pressed": pressed,
            }
        })
        if pressed and self._click_callback:
            self._click_callback(x, y, btn_name)

    def _on_move(self, x, y):
        now = time.time() * 1000
        dx = x - self._last_x
        dy = y - self._last_y
        dist = (dx**2 + dy**2) ** 0.5

        # 샘플링: 최소 간격 + 최소 이동 거리 (거버너 동적 조정)
        if (now - self._last_move_time < config.get_mouse_sample_interval_ms() or
                dist < config.get_mouse_min_move_px()):
            return

        self._last_move_time = now
        self._last_x = x
        self._last_y = y

        self._callback({
            "event_type": "mouse_move",
            "data": {"x": x, "y": y, "dx": int(dx), "dy": int(dy)}
        })

    def _on_scroll(self, x, y, dx, dy):
        self._callback({
            "event_type": "mouse_scroll",
            "data": {"x": x, "y": y, "dx": dx, "dy": dy}
        })
