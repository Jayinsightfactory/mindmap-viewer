"""녹화 시스템 설정 — 기본값 + 리소스 거버너 동적 오버라이드"""
import os
import json
import time
from pathlib import Path

# ─── 경로 ──────────────────────────────────────────
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR.parent / "data"
DB_PATH = DATA_DIR / "recording.db"
SCREENSHOT_DIR = BASE_DIR / "screenshots"

# ─── 거버너 오버라이드 (~/.orbit/recorder-config.json) ────
_GOVERNOR_CONFIG_PATH = Path.home() / ".orbit" / "recorder-config.json"
_governor_cache = None
_governor_cache_ts = 0
_GOVERNOR_CACHE_SEC = 10  # 10초마다 재로드

def _load_governor():
    """거버너가 쓴 recorder-config.json 읽기 (10초 캐시)"""
    global _governor_cache, _governor_cache_ts
    now = time.time()
    if _governor_cache is not None and (now - _governor_cache_ts) < _GOVERNOR_CACHE_SEC:
        return _governor_cache
    try:
        with open(_GOVERNOR_CONFIG_PATH, "r", encoding="utf-8") as f:
            _governor_cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _governor_cache = {}
    _governor_cache_ts = now
    return _governor_cache

def _gov(key, default):
    """거버너 값 우선, 없으면 기본값"""
    return _load_governor().get(key, default)

# ─── 마우스 캡처 (동적) ──────────────────────────
def get_mouse_sample_interval_ms():
    return _gov("mouseSampleMs", 50)

def get_mouse_min_move_px():
    return _gov("mouseMinMovePx", 5)

# ─── 스크린샷 (동적) ────────────────────────────
def get_screenshot_on_click():
    return _gov("screenshotOnClick", True)

def get_screenshot_interval_sec():
    return _gov("screenshotIntervalSec", 0)

def get_screenshot_quality():
    return _gov("screenshotQuality", 60)

def get_screenshot_max_width():
    return _gov("screenshotMaxWidth", 1920)

# ─── 배치 저장 (동적) ───────────────────────────
def get_batch_flush_interval_sec():
    return _gov("batchFlushSec", 1.0)

# ─── 정적 기본값 (하위 호환) ────────────────────
MOUSE_SAMPLE_INTERVAL_MS = 50
MOUSE_MIN_MOVE_PX = 5
SCREENSHOT_ON_CLICK = True
SCREENSHOT_INTERVAL_SEC = 0
SCREENSHOT_QUALITY = 60
SCREENSHOT_MAX_WIDTH = 1920
BATCH_FLUSH_INTERVAL_SEC = 1.0

# ─── 긴급 정지 ───────────────────────────────────
EMERGENCY_STOP_KEY = "f12"

# ─── Orbit 서버 ──────────────────────────────────
ORBIT_SERVER_URL = os.environ.get("ORBIT_SERVER_URL", "http://localhost:4747")
ORBIT_ENABLED = os.environ.get("ORBIT_RECORDER_BRIDGE", "true").lower() == "true"

# ─── 재생 ────────────────────────────────────────
PLAYBACK_DEFAULT_SPEED = 1.0
PLAYBACK_MIN_SPEED = 0.5
PLAYBACK_MAX_SPEED = 5.0
PYAUTOGUI_FAILSAFE = True

# 디렉토리 자동 생성
DATA_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
