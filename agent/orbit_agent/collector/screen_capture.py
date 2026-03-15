"""
collector/screen_capture.py
화면 캡처 + OCR — 시각적 작업 컨텍스트 수집

수집 데이터:
  - 활성 창 스크린샷 (JPEG 압축)
  - OCR 텍스트 추출
  - 화면 내 UI 요소 인식 (메뉴, 버튼, 텍스트)

처리 흐름:
  캡처 → OCR → 텍스트 저장 → Haiku 분석 → 이미지 삭제
"""
import os
import io
import logging
from datetime import datetime
from pathlib import Path

from ..config import CAPTURE_DIR

logger = logging.getLogger('orbit.screen')


def capture_screen(region=None):
    """전체 화면 또는 영역 캡처 → PIL Image"""
    try:
        import mss
        from PIL import Image

        with mss.mss() as sct:
            if region:
                shot = sct.grab(region)
            else:
                # 기본 모니터 (첫 번째)
                monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                shot = sct.grab(monitor)

            img = Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')
            return img
    except Exception as e:
        logger.error(f"화면 캡처 실패: {e}")
        return None


def capture_active_window():
    """활성 창만 캡처 (OS별)"""
    from ..config import IS_WINDOWS, IS_MAC

    if IS_WINDOWS:
        return _capture_active_window_windows()
    elif IS_MAC:
        return _capture_active_window_mac()
    else:
        # Linux: 전체 화면 캡처 fallback
        return capture_screen()


def _capture_active_window_windows():
    """Windows: 활성 창 캡처"""
    try:
        import ctypes
        from ctypes import wintypes
        import mss
        from PIL import Image

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return capture_screen()

        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))

        region = {
            'left': rect.left,
            'top': rect.top,
            'width': rect.right - rect.left,
            'height': rect.bottom - rect.top,
        }

        if region['width'] <= 0 or region['height'] <= 0:
            return capture_screen()

        return capture_screen(region)
    except Exception:
        return capture_screen()


def _capture_active_window_mac():
    """macOS: 활성 창 캡처 (screencapture 명령)"""
    try:
        import subprocess
        import tempfile
        from PIL import Image

        tmp = tempfile.mktemp(suffix='.png')
        # -l: window ID 기반 캡처, -x: 소리 없이
        result = subprocess.run(
            ['screencapture', '-x', '-o', tmp],
            capture_output=True, timeout=5
        )
        if result.returncode == 0 and os.path.exists(tmp):
            img = Image.open(tmp)
            img.load()
            os.unlink(tmp)
            return img
        if os.path.exists(tmp):
            os.unlink(tmp)
    except Exception:
        pass
    return capture_screen()


def ocr_image(img):
    """이미지에서 텍스트 추출 (Tesseract OCR)"""
    try:
        import pytesseract
        # 한국어 + 영어 + 일본어 지원
        text = pytesseract.image_to_string(img, lang='kor+eng', config='--psm 6')
        return text.strip()
    except Exception as e:
        logger.debug(f"OCR 실패 (tesseract 미설치?): {e}")
        # fallback: 없으면 빈 문자열
        return ''


def save_capture(img, prefix='screen'):
    """캡처 이미지를 JPEG로 저장 (압축)"""
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    filepath = CAPTURE_DIR / f'{prefix}_{ts}.jpg'

    try:
        # 리사이즈 (가로 1280px로 축소) + JPEG 압축
        max_width = 1280
        if img.width > max_width:
            ratio = max_width / img.width
            new_size = (max_width, int(img.height * ratio))
            img = img.resize(new_size)

        img.save(str(filepath), 'JPEG', quality=60, optimize=True)
        return str(filepath)
    except Exception as e:
        logger.error(f"캡처 저장 실패: {e}")
        return None


class ScreenCapture:
    """화면 캡처 + OCR 관리"""

    def __init__(self, process_monitor=None, on_event=None):
        self._process_monitor = process_monitor
        self._on_event = on_event

    def capture_and_analyze(self):
        """캡처 → OCR → 이벤트 생성"""
        img = capture_active_window()
        if not img:
            return None

        # OCR
        ocr_text = ocr_image(img)

        # 저장 (임시 — 분석 후 삭제)
        filepath = save_capture(img)
        file_size = os.path.getsize(filepath) if filepath else 0

        ctx = {}
        if self._process_monitor:
            ctx = self._process_monitor.get_context()

        event = {
            'type': 'screen.capture',
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'app': ctx.get('app', ''),
            'title': ctx.get('title', ''),
            'category': ctx.get('category', ''),
            'ocr_text': ocr_text[:5000],  # OCR 텍스트 (5KB 제한)
            'image_path': filepath,        # 로컬 경로 (분석 후 삭제)
            'image_size': file_size,
            'resolution': f'{img.width}x{img.height}' if img else '',
        }

        if self._on_event:
            self._on_event(event)

        return event

    @staticmethod
    def cleanup_old_captures(max_age_hours=24):
        """오래된 캡처 파일 삭제"""
        if not CAPTURE_DIR.exists():
            return 0

        count = 0
        now = datetime.utcnow().timestamp()
        for f in CAPTURE_DIR.glob('*.jpg'):
            age_hours = (now - f.stat().st_mtime) / 3600
            if age_hours > max_age_hours:
                f.unlink()
                count += 1
        return count
