"""
collector/keylogger.py
키보드 입력 수집 — 어떤 앱에서 무엇을 타이핑하는지 전체 기록

수집 데이터:
  - 키 입력 내용 (앱별 컨텍스트 포함)
  - 입력 속도 (WPM)
  - 특수키 패턴 (Ctrl+C, Ctrl+V 등 → 복사/붙여넣기 감지)
  - 앱별 입력 배치

개인정보 보호:
  - 로컬에서만 원본 저장
  - Haiku 분석 후 업무 데이터만 추출
  - 비밀번호 필드 감지 시 수집 중단
"""
import time
import threading
import logging
from datetime import datetime
from collections import deque

logger = logging.getLogger('orbit.keylogger')

# 비밀번호 입력 감지 키워드 (창 제목에 포함 시 수집 중단)
PASSWORD_HINTS = [
    'password', 'passwd', 'login', 'sign in', 'credential',
    '비밀번호', '암호', '로그인', 'パスワード', '密码',
]


class KeyLogger:
    """키보드 입력 수집기"""

    def __init__(self, process_monitor=None, on_batch=None, batch_interval=30):
        """
        Args:
            process_monitor: ProcessMonitor 인스턴스 (현재 앱 컨텍스트)
            on_batch: 배치 콜백 (batch_data_dict)
            batch_interval: 배치 저장 간격 (초)
        """
        self._process_monitor = process_monitor
        self._on_batch = on_batch
        self._batch_interval = batch_interval

        self._buffer = []           # 현재 배치 버퍼
        self._buffer_lock = threading.Lock()
        self._listener = None
        self._running = False
        self._paused = False        # 비밀번호 필드 감지 시 일시 정지

        # 특수키 추적
        self._modifier_state = set()  # 현재 눌린 modifier 키
        self._shortcuts = deque(maxlen=100)  # 최근 단축키

        # 통계
        self._keystroke_count = 0
        self._batch_start = None

    def start(self):
        """키 캡처 시작"""
        if self._running:
            return

        try:
            from pynput import keyboard
        except ImportError:
            logger.error("pynput 패키지가 필요합니다: pip install pynput")
            return

        self._running = True
        self._batch_start = datetime.utcnow()

        def on_press(key):
            if not self._running:
                return False

            # 비밀번호 필드 체크
            if self._process_monitor:
                ctx = self._process_monitor.get_context()
                title = (ctx.get('title') or '').lower()
                if any(hint in title for hint in PASSWORD_HINTS):
                    self._paused = True
                    return
                else:
                    self._paused = False

            if self._paused:
                return

            now = datetime.utcnow()
            ctx = {}
            if self._process_monitor:
                ctx = self._process_monitor.get_context()

            # Modifier 키 추적
            try:
                if key in (keyboard.Key.ctrl_l, keyboard.Key.ctrl_r,
                           keyboard.Key.cmd, keyboard.Key.cmd_r):
                    self._modifier_state.add('ctrl')
                    return
                elif key in (keyboard.Key.alt_l, keyboard.Key.alt_r):
                    self._modifier_state.add('alt')
                    return
                elif key in (keyboard.Key.shift, keyboard.Key.shift_r):
                    self._modifier_state.add('shift')
                    return
            except AttributeError:
                pass

            # 키 값 추출
            key_char = None
            key_name = None
            try:
                key_char = key.char
            except AttributeError:
                key_name = str(key).replace('Key.', '')

            # 단축키 감지 (Ctrl+C, Ctrl+V 등)
            if self._modifier_state and (key_char or key_name):
                shortcut = '+'.join(sorted(self._modifier_state)) + '+' + (key_char or key_name)
                self._shortcuts.append({
                    'shortcut': shortcut,
                    'timestamp': now.isoformat() + 'Z',
                    'app': ctx.get('app', ''),
                })

            # 버퍼에 추가
            entry = {
                'ts': now.isoformat() + 'Z',
                'app': ctx.get('app', ''),
                'title': ctx.get('title', ''),
                'category': ctx.get('category', ''),
            }

            if key_char:
                entry['char'] = key_char
            elif key_name:
                entry['key'] = key_name
                # Enter/Tab은 구조적으로 중요
                if key_name in ('enter', 'return'):
                    entry['char'] = '\n'
                elif key_name == 'tab':
                    entry['char'] = '\t'
                elif key_name == 'space':
                    entry['char'] = ' '
                elif key_name == 'backspace':
                    entry['char'] = '<BS>'

            with self._buffer_lock:
                self._buffer.append(entry)
                self._keystroke_count += 1

            # 배치 간격 체크
            if self._batch_start and (now - self._batch_start).total_seconds() >= self._batch_interval:
                self._flush_batch()

        def on_release(key):
            try:
                if key in (keyboard.Key.ctrl_l, keyboard.Key.ctrl_r,
                           keyboard.Key.cmd, keyboard.Key.cmd_r):
                    self._modifier_state.discard('ctrl')
                elif key in (keyboard.Key.alt_l, keyboard.Key.alt_r):
                    self._modifier_state.discard('alt')
                elif key in (keyboard.Key.shift, keyboard.Key.shift_r):
                    self._modifier_state.discard('shift')
            except AttributeError:
                pass

        self._listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._listener.daemon = True
        self._listener.start()
        logger.info("키보드 캡처 시작")

    def stop(self):
        """키 캡처 중지"""
        self._running = False
        if self._listener:
            self._listener.stop()
            self._listener = None
        self._flush_batch()
        logger.info("키보드 캡처 중지")

    def _flush_batch(self):
        """현재 버퍼를 배치로 플러시"""
        with self._buffer_lock:
            if not self._buffer:
                self._batch_start = datetime.utcnow()
                return

            entries = list(self._buffer)
            self._buffer.clear()
            shortcuts = list(self._shortcuts)
            self._shortcuts.clear()
            count = self._keystroke_count
            self._keystroke_count = 0
            batch_start = self._batch_start
            self._batch_start = datetime.utcnow()

        # 앱별로 텍스트 재구성
        app_texts = {}
        for e in entries:
            app = e.get('app', 'unknown')
            if app not in app_texts:
                app_texts[app] = {
                    'app': app,
                    'title': e.get('title', ''),
                    'category': e.get('category', ''),
                    'chars': [],
                    'first_ts': e['ts'],
                    'last_ts': e['ts'],
                }
            ch = e.get('char')
            if ch:
                app_texts[app]['chars'].append(ch)
            app_texts[app]['last_ts'] = e['ts']

        # 텍스트 조합
        app_data = []
        for app, data in app_texts.items():
            text = ''.join(data['chars'])
            # 빈 텍스트나 백스페이스만 있는 경우 스킵
            clean = text.replace('<BS>', '')
            if not clean.strip():
                continue
            app_data.append({
                'app': data['app'],
                'title': data['title'],
                'category': data['category'],
                'text': text,
                'char_count': len(clean),
                'first_ts': data['first_ts'],
                'last_ts': data['last_ts'],
            })

        if not app_data:
            return

        # 배치 이벤트 생성
        duration = (datetime.utcnow() - batch_start).total_seconds() if batch_start else self._batch_interval
        wpm = round(count / max(duration / 60, 0.5))  # 분당 타수

        batch = {
            'type': 'keyboard.batch',
            'timestamp': (batch_start or datetime.utcnow()).isoformat() + 'Z',
            'duration_sec': round(duration, 1),
            'total_keystrokes': count,
            'wpm': wpm,
            'apps': app_data,
            'shortcuts': shortcuts,
        }

        if self._on_batch:
            self._on_batch(batch)

    def force_flush(self):
        """강제 플러시 (분석 전 호출)"""
        self._flush_batch()
