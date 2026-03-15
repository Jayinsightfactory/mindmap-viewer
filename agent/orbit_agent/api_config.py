"""
orbit_agent/api_config.py
Orbit AI API Configuration — CLIProxyAPI / Anthropic 전환

사용법:
  USE_MAX_PROXY=true  → CLIProxyAPI (Claude Max 구독, $0 추가 비용)
  USE_MAX_PROXY=false → 공식 Anthropic API (별도 과금)

CLIProxyAPI란:
  Claude Max 구독($100/월)의 Claude Code CLI를 로컬 API 프록시로 변환.
  OpenAI-compatible 포맷으로 요청을 전달하므로 별도 API 키 불필요.
  https://github.com/nickspaargaren/CLIProxyAPI 참고.
"""
import os
import logging

logger = logging.getLogger('orbit.api_config')

# ── 프록시 모드 전환 ─────────────────────────────────────────
USE_MAX_PROXY = os.getenv("USE_MAX_PROXY", "true").lower() == "true"

if USE_MAX_PROXY:
    API_BASE_URL = os.getenv("PROXY_BASE_URL", "http://localhost:8080/v1")
    API_KEY = "dummy"  # proxy doesn't need real key
    API_FORMAT = "openai"  # CLIProxyAPI uses OpenAI-compatible format
else:
    API_BASE_URL = "https://api.anthropic.com"
    API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
    API_FORMAT = "anthropic"

# ── 모델 설정 ────────────────────────────────────────────────
VISION_MODEL = os.getenv("VISION_MODEL", "claude-haiku-4-5-20251001")
ANALYSIS_MODEL = os.getenv("ANALYSIS_MODEL", "claude-haiku-4-5-20251001")
SCRIPT_GEN_MODEL = os.getenv("SCRIPT_GEN_MODEL", "claude-sonnet-4-6")

# ── 캡처 설정 ────────────────────────────────────────────────
CAPTURE_ON_EVENT = True    # Only capture on app switch / significant change
CAPTURE_INTERVAL = 300     # Fallback: every 5 minutes
MAX_CAPTURES_PER_HOUR = 40


def get_api_config():
    """현재 API 설정을 딕셔너리로 반환"""
    return {
        'use_max_proxy': USE_MAX_PROXY,
        'api_base_url': API_BASE_URL,
        'api_key': API_KEY,
        'api_format': API_FORMAT,
        'vision_model': VISION_MODEL,
        'analysis_model': ANALYSIS_MODEL,
        'script_gen_model': SCRIPT_GEN_MODEL,
    }


def log_api_config():
    """현재 API 설정 로그 출력 (시작 시 1회)"""
    if USE_MAX_PROXY:
        logger.info(f"API 모드: CLIProxyAPI (Max 구독) → {API_BASE_URL}")
        logger.info("API 키: 프록시 모드 — 별도 키 불필요")
    else:
        logger.info("API 모드: Anthropic 공식 API")
        logger.info(f"API 키: {'설정됨' if API_KEY else '미설정'}")
    logger.info(f"분석 모델: {ANALYSIS_MODEL}")
    logger.info(f"비전 모델: {VISION_MODEL}")
    logger.info(f"스크립트 생성 모델: {SCRIPT_GEN_MODEL}")
