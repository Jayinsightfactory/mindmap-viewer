"""자동화 재생 엔진 (pyautogui)"""
import json
import time
import threading

import pyautogui

from . import config
from . import db_schema as db
from .exporter import export_session
from .orbit_bridge import OrbitBridge


# pyautogui 안전 설정
pyautogui.FAILSAFE = config.PYAUTOGUI_FAILSAFE
pyautogui.PAUSE = 0.01


class Player:
    def __init__(self):
        self._running = False
        self._step_mode = False
        self._step_event = threading.Event()
        self._speed = config.PLAYBACK_DEFAULT_SPEED
        self._bridge = OrbitBridge()
        self._current_index = 0
        self._total_actions = 0

    @property
    def is_running(self):
        return self._running

    def play(self, session_id, speed=None, step_mode=False):
        """세션 재생"""
        if self._running:
            print("[player] 이미 재생 중")
            return

        if speed is not None:
            self._speed = max(config.PLAYBACK_MIN_SPEED, min(config.PLAYBACK_MAX_SPEED, speed))

        self._step_mode = step_mode
        self._running = True

        # 세션 데이터 로드
        script = export_session(session_id)
        actions = script["actions"]
        self._total_actions = len(actions)

        session_name = script["session"]["name"]
        print(f"[player] 재생 시작: {session_name} ({self._total_actions}개 액션, {self._speed}x 속도)")
        if step_mode:
            print("[player] 스텝 모드: Enter로 다음 액션 실행")
        print("[player] F12 = 긴급 정지, 마우스 모서리 = failsafe")

        self._bridge.notify_playback("start", session_id, speed=self._speed)

        try:
            prev_time = 0
            for i, action in enumerate(actions):
                if not self._running:
                    break

                self._current_index = i

                # 스텝 모드: 대기
                if self._step_mode:
                    print(f"  [{i+1}/{self._total_actions}] {action['type']} ", end="", flush=True)
                    input()  # Enter 대기

                # 타이밍 대기
                action_time = action.get("timestamp_ms", 0)
                if prev_time > 0 and action_time > prev_time:
                    delay = (action_time - prev_time) / 1000.0 / self._speed
                    if delay > 0 and delay < 30:  # 30초 이상 갭은 스킵
                        time.sleep(delay)
                prev_time = action_time

                # 액션 실행
                self._execute_action(action)

        except pyautogui.FailSafeException:
            print("\n[player] Failsafe 트리거 (마우스 모서리)")
        except KeyboardInterrupt:
            print("\n[player] 사용자 중단")
        finally:
            self._running = False
            self._bridge.notify_playback("stop", session_id)
            print(f"[player] 재생 완료 ({self._current_index + 1}/{self._total_actions})")

    def stop(self):
        self._running = False

    def _execute_action(self, action):
        atype = action.get("type", "")
        data = action.get("data", {})

        if atype == "mouse_click":
            x, y = data.get("x", 0), data.get("y", 0)
            button = data.get("button", "left")
            pressed = data.get("pressed", True)
            if pressed:
                pyautogui.click(x, y, button=button)

        elif atype == "mouse_path":
            points = action.get("points", [])
            if not points:
                return
            duration = action.get("duration_ms", 0) / 1000.0 / self._speed
            # 시작점으로 이동 후 경로 따라 이동
            if len(points) >= 2:
                pyautogui.moveTo(points[0]["x"], points[0]["y"])
                for pt in points[1:]:
                    pyautogui.moveTo(pt["x"], pt["y"], duration=max(0.01, duration / len(points)))
            elif points:
                pyautogui.moveTo(points[0]["x"], points[0]["y"])

        elif atype == "mouse_move":
            x, y = data.get("x", 0), data.get("y", 0)
            pyautogui.moveTo(x, y, duration=0.05 / self._speed)

        elif atype == "mouse_scroll":
            x, y = data.get("x", 0), data.get("y", 0)
            dy = data.get("dy", 0)
            pyautogui.scroll(dy, x, y)

        elif atype == "keydown":
            key = data.get("key", "")
            if key and not data.get("is_special", False):
                pyautogui.press(key)
            elif key:
                key_mapped = _map_special_key(key)
                if key_mapped:
                    pyautogui.press(key_mapped)

        # keyup은 재생 시 무시 (press가 down+up 포함)
        # screenshot은 재생 시 스킵


def _map_special_key(key_name):
    """pynput 키 이름 → pyautogui 키 이름 변환"""
    mapping = {
        "space": "space", "enter": "enter", "return": "enter",
        "tab": "tab", "backspace": "backspace", "delete": "delete",
        "esc": "escape", "shift": "shift", "ctrl": "ctrl",
        "alt": "alt", "cmd": "win",
        "up": "up", "down": "down", "left": "left", "right": "right",
        "home": "home", "end": "end",
        "page_up": "pageup", "page_down": "pagedown",
        "caps_lock": "capslock", "insert": "insert",
        "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
        "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
        "f9": "f9", "f10": "f10", "f11": "f11",
    }
    return mapping.get(key_name)
