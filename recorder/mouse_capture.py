"""마우스 이벤트 캡처 (pynput) - 클릭/이동/스크롤"""
import time
import platform
from pynput import mouse
from . import config

# ── 활성 윈도우 타이틀 (Windows ctypes) ─────────────────
_get_window_title = None

if platform.system() == "Windows":
    try:
        import ctypes
        from ctypes import wintypes

        _user32 = ctypes.windll.user32
        _user32.GetForegroundWindow.restype = wintypes.HWND
        _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        _user32.GetWindowTextW.restype = ctypes.c_int
        _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        _user32.GetWindowTextLengthW.restype = ctypes.c_int

        # GetWindowThreadProcessId → 프로세스명
        _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        _user32.GetWindowThreadProcessId.restype = wintypes.DWORD

        _psapi = ctypes.windll.psapi
        _kernel32 = ctypes.windll.kernel32

        def _win_get_title():
            """활성 윈도우 타이틀 + 프로세스명 반환"""
            try:
                hwnd = _user32.GetForegroundWindow()
                length = _user32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(length + 1)
                _user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value

                # 프로세스명 추출
                pid = wintypes.DWORD()
                _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                proc_name = ""
                try:
                    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
                    h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
                    if h:
                        buf2 = ctypes.create_unicode_buffer(260)
                        _psapi.GetModuleFileNameExW(h, None, buf2, 260)
                        _kernel32.CloseHandle(h)
                        proc_name = buf2.value.split("\\")[-1].lower().replace(".exe", "")
                except Exception:
                    pass

                return title, proc_name
            except Exception:
                return "", ""

        _get_window_title = _win_get_title
    except Exception:
        pass


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
        data = {
            "x": x, "y": y,
            "button": btn_name,
            "pressed": pressed,
        }
        # 클릭 시 활성 윈도우 타이틀 + 프로세스명 캡처
        if pressed and _get_window_title:
            title, proc = _get_window_title()
            data["windowTitle"] = title
            data["processName"] = proc
        self._callback({
            "event_type": "mouse_click",
            "data": data,
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
