#!/usr/bin/env python3
"""
orbit_agent/main.py
Orbit AI 데스크톱 에이전트 — 메인 엔트리포인트

사용법:
  python -m orbit_agent                  # 기본 실행
  python -m orbit_agent --setup          # 초기 설정
  python -m orbit_agent --status         # 상태 확인
  python -m orbit_agent --gdrive-auth    # Google Drive 인증
  python -m orbit_agent --analyze-now    # 즉시 분석 실행

실행 흐름:
  1. OS 감지 + 설정 로드
  2. 모듈 초기화 (키로거, 화면, 클립보드, 파일, 프로세스)
  3. 수집 루프 시작 (백그라운드 스레드)
  4. 분석 스케줄러 시작 (1시간 간격)
  5. 동기화 스케줄러 시작 (30분 간격)
"""
import os
import sys
import time
import signal
import asyncio
import logging
import logging.handlers
import argparse
import atexit
import threading
from datetime import datetime, timedelta
from pathlib import Path

from . import __version__
from .config import (
    load_config, save_config, ensure_dirs,
    PLATFORM, IS_WINDOWS, IS_MAC, IS_LINUX,
    CONFIG_DIR, LOG_DIR,
)

# ── PID 파일 관리 (중복 실행 방지) ──────────────────────────
PID_FILE = CONFIG_DIR / 'agent.pid'


def _write_pid():
    """PID 파일 작성"""
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))


def _remove_pid():
    """PID 파일 제거"""
    try:
        if PID_FILE.exists():
            PID_FILE.unlink()
    except Exception:
        pass


def _check_already_running():
    """이미 실행 중이면 True"""
    if not PID_FILE.exists():
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, 0)  # 프로세스 존재 확인 (시그널 안 보냄)
        return True
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        _remove_pid()
        return False


def _stop_running():
    """실행 중인 에이전트 중지"""
    if not PID_FILE.exists():
        print("  에이전트가 실행 중이 아닙니다.")
        return

    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"  에이전트 중지 신호 전송 (PID: {pid})")
        # 종료 대기 (최대 5초)
        for _ in range(10):
            time.sleep(0.5)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                print("  에이전트 종료 완료")
                _remove_pid()
                return
        print("  에이전트가 아직 실행 중 — 강제 종료")
        os.kill(pid, signal.SIGKILL)
        _remove_pid()
    except ProcessLookupError:
        print("  프로세스가 이미 종료됨")
        _remove_pid()
    except Exception as e:
        print(f"  중지 실패: {e}")


# ── 로깅 설정 ───────────────────────────────────────────────
def setup_logging(verbose=False, daemon=False):
    ensure_dirs()
    log_file = LOG_DIR / 'agent.log'
    level = logging.DEBUG if verbose else logging.INFO

    handlers = [
        logging.handlers.RotatingFileHandler(
            str(log_file), maxBytes=5*1024*1024, backupCount=3, encoding='utf-8'
        ),
    ]
    # 데몬 모드가 아닐 때만 콘솔 출력
    if not daemon:
        handlers.append(logging.StreamHandler(sys.stdout))

    logging.basicConfig(
        level=level,
        format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
        handlers=handlers,
    )

logger = logging.getLogger('orbit.main')


# ── 메인 에이전트 클래스 ────────────────────────────────────
class OrbitAgent:
    """데스크톱 에이전트 메인 컨트롤러"""

    def __init__(self, config):
        self.cfg = config
        self._running = False
        self._event_buffer = []
        self._buffer_lock = threading.Lock()

        # 모듈 인스턴스
        self._process_monitor = None
        self._keylogger = None
        self._clipboard = None
        self._file_watcher = None
        self._screen_capture = None

    def _on_event(self, event):
        """이벤트 콜백 — 로컬 DB에 저장"""
        from .storage import local_db
        try:
            local_db.insert_event(event)
        except Exception as e:
            logger.error(f"이벤트 저장 실패: {e}")

    def _on_batch(self, batch):
        """키보드 배치 콜백"""
        self._on_event(batch)

    def start(self):
        """에이전트 시작"""
        # PID 관리
        _write_pid()
        atexit.register(_remove_pid)

        logger.info(f"Orbit AI Agent v{__version__} 시작 (PID: {os.getpid()})")
        logger.info(f"OS: {PLATFORM} | 설정: {CONFIG_DIR}")

        self._running = True

        # 1. 프로세스 모니터 (모든 모듈의 컨텍스트 제공)
        from .collector.process_monitor import ProcessMonitor
        self._process_monitor = ProcessMonitor(on_event=self._on_event)
        logger.info("프로세스 모니터 초기화")

        # 2. 키로거
        from .collector.keylogger import KeyLogger
        self._keylogger = KeyLogger(
            process_monitor=self._process_monitor,
            on_batch=self._on_batch,
            batch_interval=self.cfg.get('keylog_batch_sec', 30),
        )
        self._keylogger.start()
        logger.info("키보드 캡처 시작")

        # 3. 클립보드 모니터
        from .collector.clipboard_monitor import ClipboardMonitor
        self._clipboard = ClipboardMonitor(
            process_monitor=self._process_monitor,
            on_event=self._on_event,
        )
        logger.info("클립보드 모니터 초기화")

        # 4. 파일 감시
        watch_dirs = self.cfg.get('file_watch_dirs', [])
        if watch_dirs:
            from .collector.file_watcher import FileWatcher
            self._file_watcher = FileWatcher(
                watch_dirs=watch_dirs,
                on_event=self._on_event,
            )
            self._file_watcher.start()
            logger.info(f"파일 감시 시작: {len(watch_dirs)}개 디렉토리")

        # 5. 화면 캡처
        from .collector.screen_capture import ScreenCapture
        self._screen_capture = ScreenCapture(
            process_monitor=self._process_monitor,
            on_event=self._on_event,
        )
        logger.info("화면 캡처 초기화")

        # ── 메인 수집 루프 ──────────────────────────────────
        process_interval = self.cfg.get('process_poll_sec', 5)
        clipboard_interval = self.cfg.get('clipboard_poll_sec', 2)
        screen_interval = self.cfg.get('screen_capture_sec', 300)

        last_screen = 0
        last_clipboard = 0
        last_analysis = 0
        last_sync = 0
        last_purge = 0

        analysis_interval = self.cfg.get('analysis_interval_sec', 3600)
        sync_interval = self.cfg.get('server_sync_sec', 1800)

        logger.info("=" * 50)
        logger.info("수집 루프 시작")
        logger.info(f"  프로세스: {process_interval}초")
        logger.info(f"  클립보드: {clipboard_interval}초")
        logger.info(f"  화면캡처: {screen_interval}초")
        logger.info(f"  AI 분석: {analysis_interval}초")
        logger.info(f"  서버동기화: {sync_interval}초")
        logger.info("=" * 50)

        while self._running:
            try:
                now = time.time()

                # 프로세스 모니터 (매 5초)
                self._process_monitor.poll()

                # 클립보드 (매 2초)
                if now - last_clipboard >= clipboard_interval:
                    self._clipboard.poll()
                    last_clipboard = now

                # 화면 캡처 (매 5분)
                if now - last_screen >= screen_interval:
                    self._screen_capture.capture_and_analyze()
                    last_screen = now

                # AI 분석 (매 1시간)
                if now - last_analysis >= analysis_interval:
                    self._run_analysis()
                    last_analysis = now

                # 서버 동기화 (매 30분)
                if now - last_sync >= sync_interval:
                    self._run_sync()
                    last_sync = now

                # 데이터 정리 (매 24시간)
                if now - last_purge >= 86400:
                    self._run_cleanup()
                    last_purge = now

                time.sleep(process_interval)

            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"수집 루프 오류: {e}", exc_info=True)
                time.sleep(10)

        self.stop()

    def stop(self):
        """에이전트 중지"""
        logger.info("에이전트 종료 중...")
        self._running = False

        if self._keylogger:
            self._keylogger.stop()
        if self._file_watcher:
            self._file_watcher.stop()

        _remove_pid()

        # 마지막 분석 + 동기화
        self._run_analysis()
        self._run_sync()

        logger.info("에이전트 종료 완료")

    def _run_analysis(self):
        """Haiku로 수집 데이터 분석"""
        api_key = self.cfg.get('anthropic_api_key', '')
        if not api_key:
            return

        try:
            from .storage import local_db
            from .analyzer.task_classifier import analyze_with_haiku
            from .storage.server_sync import enqueue_analysis_result

            # 최근 1시간 이벤트
            since = (datetime.utcnow() - timedelta(hours=1)).isoformat()
            events = local_db.get_events_since(since)

            if len(events) < 5:
                logger.debug("분석할 이벤트 부족 (5개 미만)")
                return

            logger.info(f"AI 분석 시작: {len(events)}개 이벤트")

            # asyncio로 Haiku 호출
            result = asyncio.run(analyze_with_haiku(events, api_key))

            if result:
                # 분석 결과 저장
                period_end = datetime.utcnow().isoformat()
                local_db.save_analysis(result, since, period_end, len(events))

                # 작업 그래프 업데이트
                for task in result.get('tasks', []):
                    local_db.upsert_task_graph(task)

                # 동기화 대기열에 추가
                enqueue_analysis_result(result)

                logger.info(f"분석 완료: {len(result.get('tasks', []))}개 작업 식별")

                # 피드백 확인
                feedback = result.get('feedback', {})
                if feedback.get('actionable'):
                    logger.info(f"피드백: {feedback.get('message', '')[:100]}")

        except Exception as e:
            logger.error(f"분석 실패: {e}", exc_info=True)

    def _run_sync(self):
        """서버 + Google Drive 동기화"""
        try:
            from .storage.server_sync import sync_to_server

            count = sync_to_server(
                self.cfg.get('server_url', ''),
                self.cfg.get('api_token', ''),
                self.cfg.get('user_id', ''),
            )
            if count:
                logger.info(f"서버 동기화: {count}건 전송")

        except Exception as e:
            logger.error(f"동기화 실패: {e}")

    def _run_cleanup(self):
        """오래된 데이터 정리"""
        try:
            from .storage import local_db
            from .collector.screen_capture import ScreenCapture

            purge_days = self.cfg.get('purge_after_days', 30)
            local_db.purge_old_events(purge_days)
            ScreenCapture.cleanup_old_captures(max_age_hours=24)

            db_mb = local_db.get_db_size_mb()
            max_mb = self.cfg.get('max_local_db_mb', 2048)
            if db_mb > max_mb * 0.9:
                logger.warning(f"DB 용량 경고: {db_mb:.0f}MB / {max_mb}MB")
                local_db.purge_old_events(days=7)

        except Exception as e:
            logger.error(f"정리 실패: {e}")


# ── CLI ──────────────────────────────────────────────────────
def run_setup():
    """초기 설정 대화형"""
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║   Orbit AI 데스크톱 에이전트 설정            ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    cfg = load_config()

    # 서버 URL
    url = input(f"  Orbit 서버 URL [{cfg['server_url']}]: ").strip()
    if url:
        cfg['server_url'] = url

    # API 토큰
    token = input(f"  API 토큰 [{cfg['api_token'][:8]}...]: ").strip()
    if token:
        cfg['api_token'] = token

    # 사용자 ID
    uid = input(f"  사용자 ID [{cfg['user_id']}]: ").strip()
    if uid:
        cfg['user_id'] = uid

    # Anthropic API Key
    akey = input(f"  Anthropic API Key [{cfg['anthropic_api_key'][:8]}...]: ").strip()
    if akey:
        cfg['anthropic_api_key'] = akey

    # 파일 감시 디렉토리
    dirs_str = input("  감시할 디렉토리 (콤마 구분, 비워두면 건너뜀): ").strip()
    if dirs_str:
        cfg['file_watch_dirs'] = [d.strip() for d in dirs_str.split(',') if d.strip()]

    save_config(cfg)
    print()
    print("  ✅ 설정 저장 완료!")
    print(f"  설정 파일: {CONFIG_DIR / 'agent-config.json'}")
    print()
    print("  에이전트 시작: python -m orbit_agent")
    print()


def show_status():
    """현재 상태 표시"""
    from .storage import local_db
    from .config import LOCAL_DB_PATH

    cfg = load_config()
    running = _check_already_running()

    print()
    print("╔══════════════════════════════════════════════╗")
    print(f"║   Orbit AI Agent v{__version__}                     ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    # 실행 상태
    if running:
        pid = PID_FILE.read_text().strip()
        print(f"  상태: 실행 중 (PID: {pid})")
    else:
        print("  상태: 중지됨")

    print(f"  OS: {PLATFORM}")
    print(f"  설정: {CONFIG_DIR}")
    print(f"  DB: {LOCAL_DB_PATH}")

    if LOCAL_DB_PATH.exists():
        db_mb = local_db.get_db_size_mb()
        print(f"  DB 크기: {db_mb:.1f} MB")

        db = local_db.get_db()
        count = db.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]
        print(f"  총 이벤트: {count:,}개")

        analyses = db.execute("SELECT COUNT(*) FROM analysis_results").fetchone()[0]
        print(f"  분석 결과: {analyses}개")

        tasks = db.execute("SELECT COUNT(*) FROM task_graphs").fetchone()[0]
        print(f"  학습된 작업: {tasks}개")

        pending = db.execute("SELECT COUNT(*) FROM sync_queue").fetchone()[0]
        print(f"  동기화 대기: {pending}건")

    print()
    print(f"  서버: {cfg.get('server_url', '미설정')}")
    print(f"  토큰: {'설정됨' if cfg.get('api_token') else '미설정'}")
    print(f"  Haiku: {'설정됨' if cfg.get('anthropic_api_key') else '미설정'}")
    print(f"  Drive: {'활성' if cfg.get('gdrive_enabled') else '비활성'}")

    # 서비스 등록 상태
    print()
    if IS_MAC:
        plist = Path.home() / 'Library' / 'LaunchAgents' / 'com.orbitai.agent.plist'
        print(f"  자동시작: {'등록됨' if plist.exists() else '미등록'} (launchd)")
    elif IS_WINDOWS:
        print("  자동시작: 레지스트리 확인 필요")
    elif IS_LINUX:
        svc = Path.home() / '.config' / 'systemd' / 'user' / 'orbit-agent.service'
        print(f"  자동시작: {'등록됨' if svc.exists() else '미등록'} (systemd)")
    print()


def main():
    parser = argparse.ArgumentParser(description='Orbit AI Desktop Agent')
    parser.add_argument('--setup', action='store_true', help='초기 설정')
    parser.add_argument('--status', action='store_true', help='상태 확인')
    parser.add_argument('--stop', action='store_true', help='에이전트 중지')
    parser.add_argument('--verbose', '-v', action='store_true', help='디버그 로깅')
    parser.add_argument('--analyze-now', action='store_true', help='즉시 분석')
    args = parser.parse_args()

    # ── 서비스 명령어 (로깅 불필요) ─────────────────────────
    if args.setup:
        run_setup()
        return

    if args.status:
        show_status()
        return

    if args.stop:
        _stop_running()
        return

    # ── 중복 실행 방지 ──────────────────────────────────────
    if _check_already_running():
        pid = PID_FILE.read_text().strip()
        # 서비스 매니저가 재시작 시도 시 조용히 종료
        sys.exit(0)

    # ── 데몬 모드 감지 (stdin이 없으면 데몬) ────────────────
    is_daemon = not sys.stdin or not sys.stdin.isatty()
    setup_logging(verbose=args.verbose, daemon=is_daemon)

    # 설정 로드
    cfg = load_config()
    if not cfg.get('api_token') and not cfg.get('anthropic_api_key'):
        if not is_daemon:
            print("  설정이 필요합니다. 먼저 실행:")
            print("     python -m orbit_agent --setup")
        return

    # 에이전트 시작
    agent = OrbitAgent(cfg)

    # 종료 시그널 핸들링
    def handle_signal(sig, frame):
        logger.info(f"종료 신호 수신: {sig}")
        agent.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    if args.analyze_now:
        agent._run_analysis()
        return

    agent.start()


if __name__ == '__main__':
    main()
