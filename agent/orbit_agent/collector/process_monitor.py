"""
collector/process_monitor.py
활성 창 + 프로세스 모니터링 — 어떤 앱에서 어떤 문서를 작업 중인지 추적

수집 데이터:
  - 활성 창 제목 (문서명, 웹 페이지 등)
  - 앱 이름 (Excel, Chrome, VS Code 등)
  - 앱 전환 시점 + 사용 시간
  - 실행 중인 프로세스 목록
"""
import time
import logging
from datetime import datetime

import psutil

from ..config import IS_WINDOWS, IS_MAC, IS_LINUX

logger = logging.getLogger('orbit.process')

# ── 기업용 앱 분류표 ─────────────────────────────────────────
APP_CATEGORIES = {
    # 문서 작업
    'WINWORD': '문서작성', 'EXCEL': '스프레드시트', 'POWERPNT': '프레젠테이션',
    'hwp': '문서작성', 'hwpx': '문서작성',
    'Microsoft Word': '문서작성', 'Microsoft Excel': '스프레드시트',
    'Microsoft PowerPoint': '프레젠테이션',
    'Google Docs': '문서작성', 'Google Sheets': '스프레드시트',
    'Google Slides': '프레젠테이션',
    'Notion': '문서작성', 'Obsidian': '문서작성',
    'Pages': '문서작성', 'Numbers': '스프레드시트', 'Keynote': '프레젠테이션',

    # 이메일
    'OUTLOOK': '이메일', 'Outlook': '이메일', 'Mail': '이메일',
    'Thunderbird': '이메일',

    # 메신저/커뮤니케이션
    'Slack': '메신저', 'Teams': '메신저', 'Discord': '메신저',
    'KakaoTalk': '메신저', 'Line': '메신저', 'Zoom': '화상회의',
    'Google Meet': '화상회의', 'Webex': '화상회의',

    # 개발
    'Code': '개발', 'code': '개발',  # VS Code
    'IntelliJ': '개발', 'PyCharm': '개발', 'WebStorm': '개발',
    'Xcode': '개발', 'Terminal': '터미널', 'iTerm': '터미널',
    'cmd': '터미널', 'powershell': '터미널', 'WindowsTerminal': '터미널',
    'Cursor': '개발',

    # 브라우저
    'chrome': '브라우저', 'Chrome': '브라우저',
    'firefox': '브라우저', 'Firefox': '브라우저',
    'Safari': '브라우저', 'Edge': '브라우저', 'msedge': '브라우저',
    'Arc': '브라우저', 'Brave': '브라우저',

    # 디자인
    'Figma': '디자인', 'Photoshop': '디자인', 'Illustrator': '디자인',
    'Canva': '디자인', 'Sketch': '디자인',

    # ERP/CRM
    'SAP': 'ERP', 'Salesforce': 'CRM',

    # 파일관리
    'explorer': '파일관리', 'Finder': '파일관리',
}


def _get_active_window_windows():
    """Windows: 활성 창 정보 가져오기"""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None, None

        # 창 제목
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value

        # 프로세스 이름
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        try:
            proc = psutil.Process(pid.value)
            app_name = proc.name().replace('.exe', '')
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            app_name = 'unknown'

        return app_name, title
    except Exception as e:
        logger.debug(f"Windows active window error: {e}")
        return None, None


def _get_active_window_mac():
    """macOS: 활성 창 정보 가져오기"""
    try:
        from AppKit import NSWorkspace
        active_app = NSWorkspace.sharedWorkspace().activeApplication()
        app_name = active_app.get('NSApplicationName', 'unknown')

        # 창 제목은 Accessibility API 필요 — 앱 이름만 반환
        # 추후 pyobjc-framework-Quartz로 확장 가능
        import subprocess
        result = subprocess.run(
            ['osascript', '-e',
             'tell application "System Events" to get name of first window of '
             '(first application process whose frontmost is true)'],
            capture_output=True, text=True, timeout=2
        )
        title = result.stdout.strip() if result.returncode == 0 else ''

        return app_name, title
    except Exception as e:
        logger.debug(f"macOS active window error: {e}")
        try:
            from AppKit import NSWorkspace
            active_app = NSWorkspace.sharedWorkspace().activeApplication()
            return active_app.get('NSApplicationName', 'unknown'), ''
        except Exception:
            return None, None


def _get_active_window_linux():
    """Linux: 활성 창 정보 가져오기"""
    try:
        import subprocess
        # xdotool 사용
        wid = subprocess.run(
            ['xdotool', 'getactivewindow'], capture_output=True, text=True, timeout=2
        )
        if wid.returncode != 0:
            return None, None

        title_result = subprocess.run(
            ['xdotool', 'getactivewindow', 'getwindowname'],
            capture_output=True, text=True, timeout=2
        )
        title = title_result.stdout.strip()

        pid_result = subprocess.run(
            ['xdotool', 'getactivewindow', 'getwindowpid'],
            capture_output=True, text=True, timeout=2
        )
        try:
            pid = int(pid_result.stdout.strip())
            proc = psutil.Process(pid)
            app_name = proc.name()
        except (ValueError, psutil.NoSuchProcess):
            app_name = 'unknown'

        return app_name, title
    except Exception as e:
        logger.debug(f"Linux active window error: {e}")
        return None, None


def get_active_window():
    """OS에 맞는 활성 창 정보 반환 → (app_name, window_title)"""
    if IS_WINDOWS:
        return _get_active_window_windows()
    elif IS_MAC:
        return _get_active_window_mac()
    elif IS_LINUX:
        return _get_active_window_linux()
    return None, None


def categorize_app(app_name):
    """앱 이름 → 업무 카테고리 분류"""
    if not app_name:
        return '기타'
    for key, category in APP_CATEGORIES.items():
        if key.lower() in app_name.lower():
            return category
    return '기타'


def get_running_processes():
    """현재 실행 중인 주요 프로세스 목록 (시스템 프로세스 제외)"""
    SYSTEM_PROCS = {
        'svchost', 'csrss', 'lsass', 'winlogon', 'services', 'smss',
        'conhost', 'dwm', 'fontdrvhost', 'sihost', 'taskhostw',
        'kernel_task', 'launchd', 'WindowServer', 'loginwindow',
        'systemd', 'kthreadd', 'init',
    }
    procs = []
    for proc in psutil.process_iter(['name', 'pid', 'cpu_percent', 'memory_percent']):
        try:
            info = proc.info
            name = info['name'] or ''
            if name.lower().replace('.exe', '') in SYSTEM_PROCS:
                continue
            if (info.get('cpu_percent', 0) or 0) > 0.1 or (info.get('memory_percent', 0) or 0) > 1.0:
                procs.append({
                    'name': name,
                    'pid': info['pid'],
                    'cpu': round(info.get('cpu_percent', 0) or 0, 1),
                    'mem': round(info.get('memory_percent', 0) or 0, 1),
                    'category': categorize_app(name),
                })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return procs


class ProcessMonitor:
    """프로세스 모니터 — 앱 전환 + 사용 시간 추적"""

    def __init__(self, on_event=None):
        self.on_event = on_event  # callback(event_dict)
        self._current_app = None
        self._current_title = None
        self._switch_time = None
        self._running = False

    def poll(self):
        """한 번 폴링 — 앱 전환 감지 시 이벤트 발생"""
        app_name, title = get_active_window()
        now = datetime.utcnow().isoformat() + 'Z'

        if app_name and (app_name != self._current_app or title != self._current_title):
            # 이전 앱 사용 시간 기록
            if self._current_app and self._switch_time:
                duration_sec = (datetime.utcnow() - self._switch_time).total_seconds()
                if duration_sec >= 2 and self.on_event:  # 2초 미만은 무시
                    self.on_event({
                        'type': 'app.usage',
                        'timestamp': self._switch_time.isoformat() + 'Z',
                        'app': self._current_app,
                        'title': self._current_title or '',
                        'category': categorize_app(self._current_app),
                        'duration_sec': round(duration_sec, 1),
                    })

            # 앱 전환 이벤트
            if self.on_event:
                self.on_event({
                    'type': 'app.switch',
                    'timestamp': now,
                    'from_app': self._current_app,
                    'to_app': app_name,
                    'to_title': title or '',
                    'to_category': categorize_app(app_name),
                })

            self._current_app = app_name
            self._current_title = title
            self._switch_time = datetime.utcnow()

        return app_name, title

    def get_context(self):
        """현재 활성 앱 컨텍스트 반환 (다른 모듈에서 참조)"""
        return {
            'app': self._current_app,
            'title': self._current_title,
            'category': categorize_app(self._current_app),
        }
