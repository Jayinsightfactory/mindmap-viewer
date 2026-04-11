"""녹화 시스템 설정 상수"""
import os
from pathlib import Path

# ─── 경로 ──────────────────────────────────────────
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR.parent / "data"
DB_PATH = DATA_DIR / "recording.db"
SCREENSHOT_DIR = BASE_DIR / "screenshots"

# ─── 마우스 캡처 ──────────────────────────────────
MOUSE_SAMPLE_INTERVAL_MS = 50       # 마우스 이동 샘플링 간격
MOUSE_MIN_MOVE_PX = 5               # 최소 이동 거리 (px)

# ─── 스크린샷 ────────────────────────────────────
SCREENSHOT_ON_CLICK = True           # 클릭 시 자동 캡처
SCREENSHOT_INTERVAL_SEC = 0          # 주기적 캡처 (0=비활성)
SCREENSHOT_QUALITY = 60              # JPEG 품질 (1-100)
SCREENSHOT_MAX_WIDTH = 1920          # 최대 가로 해상도

# ─── 배치 저장 ───────────────────────────────────
BATCH_FLUSH_INTERVAL_SEC = 1.0       # DB 저장 주기

# ─── 긴급 정지 ───────────────────────────────────
EMERGENCY_STOP_KEY = "f12"           # 긴급 정지 키

# ─── Orbit 서버 ──────────────────────────────────
ORBIT_SERVER_URL = os.environ.get("ORBIT_SERVER_URL", "http://localhost:4747")
ORBIT_ENABLED = os.environ.get("ORBIT_RECORDER_BRIDGE", "true").lower() == "true"

# ─── 재생 ────────────────────────────────────────
PLAYBACK_DEFAULT_SPEED = 1.0
PLAYBACK_MIN_SPEED = 0.5
PLAYBACK_MAX_SPEED = 5.0
PYAUTOGUI_FAILSAFE = True           # 모서리 이동 = 정지

# 디렉토리 자동 생성
DATA_DIR.mkdir(parents=True, exist_ok=True)
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
