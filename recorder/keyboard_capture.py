"""키보드 이벤트 캡처 (pynput)"""
import time
from pynput import keyboard


# 특수키 이름 매핑
_SPECIAL_KEYS = {
    keyboard.Key.space: "space", keyboard.Key.enter: "enter",
    keyboard.Key.tab: "tab", keyboard.Key.backspace: "backspace",
    keyboard.Key.delete: "delete", keyboard.Key.esc: "esc",
    keyboard.Key.shift: "shift", keyboard.Key.shift_r: "shift_r",
    keyboard.Key.ctrl_l: "ctrl", keyboard.Key.ctrl_r: "ctrl_r",
    keyboard.Key.alt_l: "alt", keyboard.Key.alt_r: "alt_r",
    keyboard.Key.cmd: "cmd", keyboard.Key.cmd_r: "cmd_r",
    keyboard.Key.caps_lock: "caps_lock",
    keyboard.Key.f1: "f1", keyboard.Key.f2: "f2", keyboard.Key.f3: "f3",
    keyboard.Key.f4: "f4", keyboard.Key.f5: "f5", keyboard.Key.f6: "f6",
    keyboard.Key.f7: "f7", keyboard.Key.f8: "f8", keyboard.Key.f9: "f9",
    keyboard.Key.f10: "f10", keyboard.Key.f11: "f11", keyboard.Key.f12: "f12",
    keyboard.Key.up: "up", keyboard.Key.down: "down",
    keyboard.Key.left: "left", keyboard.Key.right: "right",
    keyboard.Key.home: "home", keyboard.Key.end: "end",
    keyboard.Key.page_up: "page_up", keyboard.Key.page_down: "page_down",
    keyboard.Key.insert: "insert",
}


class KeyboardCapture:
    def __init__(self, event_callback, emergency_stop_callback=None):
        """
        event_callback(event_dict) - 이벤트 발생 시 호출
        emergency_stop_callback()  - F12 시 호출
        """
        self._callback = event_callback
        self._emergency_stop = emergency_stop_callback
        self._listener = None
        self._modifiers = set()  # 현재 눌린 수정키

    def start(self):
        self._listener = keyboard.Listener(
            on_press=self._on_press,
            on_release=self._on_release
        )
        self._listener.start()

    def stop(self):
        if self._listener:
            self._listener.stop()
            self._listener = None

    def _key_info(self, key):
        is_special = isinstance(key, keyboard.Key)
        if is_special:
            key_name = _SPECIAL_KEYS.get(key, str(key).replace("Key.", ""))
            key_code = key.value.vk if hasattr(key, 'value') and hasattr(key.value, 'vk') else 0
        else:
            key_name = key.char if hasattr(key, 'char') and key.char else str(key)
            key_code = key.vk if hasattr(key, 'vk') else ord(key_name) if len(key_name) == 1 else 0
        return key_name, key_code, is_special

    def _on_press(self, key):
        key_name, key_code, is_special = self._key_info(key)

        # 수정키 추적
        if key_name in ("shift", "shift_r", "ctrl", "ctrl_r", "alt", "alt_r", "cmd", "cmd_r"):
            self._modifiers.add(key_name.replace("_r", "").replace("_l", ""))

        # F12 = 긴급 정지
        if key_name == "f12" and self._emergency_stop:
            self._emergency_stop()
            return False

        self._callback({
            "event_type": "keydown",
            "data": {
                "key": key_name,
                "key_code": key_code,
                "modifiers": list(self._modifiers),
                "is_special": is_special,
            }
        })

    def _on_release(self, key):
        key_name, key_code, is_special = self._key_info(key)

        # 수정키 해제
        base = key_name.replace("_r", "").replace("_l", "")
        self._modifiers.discard(base)

        self._callback({
            "event_type": "keyup",
            "data": {
                "key": key_name,
                "key_code": key_code,
                "modifiers": list(self._modifiers),
                "is_special": is_special,
            }
        })
