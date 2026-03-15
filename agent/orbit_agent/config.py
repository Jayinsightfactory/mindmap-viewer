"""
orbit_agent/config.py
설정 관리 — OS 감지, 토큰, 서버 URL, 수집 간격 등
"""
import os
import sys
import json
import platform
from pathlib import Path

# ── OS 감지 ─────────────────────────────────────────────────
PLATFORM = platform.system().lower()  # 'windows', 'darwin', 'linux'
IS_WINDOWS = PLATFORM == 'windows'
IS_MAC = PLATFORM == 'darwin'
IS_LINUX = PLATFORM == 'linux'

# ── 경로 ────────────────────────────────────────────────────
HOME = Path.home()
CONFIG_DIR = HOME / '.orbit'
CONFIG_FILE = CONFIG_DIR / 'agent-config.json'
LOCAL_DB_PATH = CONFIG_DIR / 'agent-data.db'
LOG_DIR = CONFIG_DIR / 'logs'
CAPTURE_DIR = CONFIG_DIR / 'captures'  # 임시 스크린샷 (분석 후 삭제)

# ── 기본 설정 ───────────────────────────────────────────────
DEFAULTS = {
    # 서버 연결
    'server_url': 'https://sparkling-determination-production-c88b.up.railway.app',
    'api_token': '',
    'user_id': '',

    # Claude Haiku API
    'anthropic_api_key': '',

    # Google Drive
    'gdrive_enabled': False,
    'gdrive_folder': 'OrbitAI',

    # 수집 간격 (초)
    'keylog_batch_sec': 30,        # 30초마다 키로그 배치 저장
    'screen_capture_sec': 300,     # 5분마다 스크린 캡처
    'process_poll_sec': 5,         # 5초마다 활성 프로세스 확인
    'clipboard_poll_sec': 2,       # 2초마다 클립보드 확인
    'file_watch_dirs': [],         # 감시할 디렉토리 목록

    # AI 분석 간격
    'analysis_interval_sec': 3600, # 1시간마다 Haiku 분석
    'server_sync_sec': 1800,       # 30분마다 서버 동기화

    # 개인정보 필터
    'privacy_keywords': ['password', 'secret', 'token', 'credential', '비밀번호', '암호'],
    'exclude_apps': [],            # 트래킹 제외 앱 목록

    # 저장 제한
    'max_local_db_mb': 2048,       # 로컬 DB 최대 2GB
    'max_capture_mb': 2048,        # 캡처 파일 최대 2GB
    'purge_after_days': 30,        # 30일 후 원본 데이터 삭제 (분석 결과는 유지)
}


def load_config():
    """설정 파일 로드 (없으면 기본값)"""
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                saved = json.load(f)
            cfg.update(saved)
        except Exception:
            pass

    # 환경변수 우선
    if os.getenv('ORBIT_SERVER_URL'):
        cfg['server_url'] = os.environ['ORBIT_SERVER_URL']
    if os.getenv('ORBIT_TOKEN'):
        cfg['api_token'] = os.environ['ORBIT_TOKEN']
    if os.getenv('ORBIT_USER_ID'):
        cfg['user_id'] = os.environ['ORBIT_USER_ID']
    if os.getenv('ANTHROPIC_API_KEY'):
        cfg['anthropic_api_key'] = os.environ['ANTHROPIC_API_KEY']

    return cfg


def save_config(cfg):
    """설정 파일 저장"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def ensure_dirs():
    """필요한 디렉토리 생성"""
    for d in [CONFIG_DIR, LOG_DIR, CAPTURE_DIR]:
        d.mkdir(parents=True, exist_ok=True)
