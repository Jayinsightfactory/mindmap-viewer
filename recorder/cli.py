"""CLI 인터페이스 - python -m recorder <command>"""
import argparse
import sys
import signal

from . import db_schema as db
from .recorder import Recorder
from .player import Player
from .exporter import export_session


def main():
    parser = argparse.ArgumentParser(
        prog="recorder",
        description="PC Activity Recorder & Automation System"
    )
    sub = parser.add_subparsers(dest="command", help="명령어")

    # record
    p_rec = sub.add_parser("record", help="녹화 시작")
    p_rec.add_argument("--name", "-n", default="unnamed", help="세션 이름")

    # stop (별도 프로세스에서 실행 - 현재 세션 종료)
    sub.add_parser("stop", help="현재 녹화 중지 (Ctrl+C 또는 F12 사용)")

    # list
    p_list = sub.add_parser("list", help="세션 목록")
    p_list.add_argument("--limit", "-l", type=int, default=20, help="표시 개수")

    # play
    p_play = sub.add_parser("play", help="세션 재생")
    p_play.add_argument("session_id", help="재생할 세션 ID")
    p_play.add_argument("--speed", "-s", type=float, default=1.0, help="재생 속도 (0.5~5.0)")
    p_play.add_argument("--step", action="store_true", help="스텝 모드 (Enter로 하나씩)")

    # export
    p_exp = sub.add_parser("export", help="세션 내보내기 (JSON)")
    p_exp.add_argument("session_id", help="내보낼 세션 ID")
    p_exp.add_argument("--output", "-o", default=None, help="출력 파일 경로")
    p_exp.add_argument("--filter", "-f", nargs="*", choices=["keyboard", "mouse", "screenshot"], help="이벤트 필터")

    # info
    p_info = sub.add_parser("info", help="세션 상세 정보")
    p_info.add_argument("session_id", help="세션 ID")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    if args.command == "record":
        cmd_record(args)
    elif args.command == "stop":
        cmd_stop()
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "play":
        cmd_play(args)
    elif args.command == "export":
        cmd_export(args)
    elif args.command == "info":
        cmd_info(args)


def cmd_record(args):
    """녹화 시작 - Ctrl+C 또는 F12로 종료"""
    rec = Recorder(name=args.name)

    def on_signal(sig, frame):
        print("\n[cli] Ctrl+C 감지 - 녹화 종료 중...")
        rec.stop()
        db.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, on_signal)

    rec.start()

    # 메인 스레드 유지
    try:
        while rec.is_running:
            signal.pause() if hasattr(signal, 'pause') else __import__('time').sleep(0.5)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if rec.is_running:
            rec.stop()
        db.close()


def cmd_stop():
    print("[cli] 녹화 중지는 녹화 프로세스에서 F12 또는 Ctrl+C를 사용하세요.")


def cmd_list(args):
    """세션 목록"""
    sessions = db.list_sessions(limit=args.limit)
    if not sessions:
        print("녹화된 세션이 없습니다.")
        return

    print(f"{'ID':<20} {'이름':<20} {'상태':<12} {'이벤트':<8} {'시작 시간'}")
    print("-" * 85)
    for s in sessions:
        started = s["started_at"][:19] if s["started_at"] else "?"
        print(f"{s['id']:<20} {s['name']:<20} {s['status']:<12} {s['total_events']:<8} {started}")
    db.close()


def cmd_play(args):
    """세션 재생"""
    player = Player()

    def on_signal(sig, frame):
        player.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, on_signal)

    try:
        player.play(args.session_id, speed=args.speed, step_mode=args.step)
    finally:
        db.close()


def cmd_export(args):
    """세션 내보내기"""
    output = args.output or f"recording_{args.session_id}.json"
    try:
        export_session(args.session_id, output_path=output, filter_types=args.filter)
    finally:
        db.close()


def cmd_info(args):
    """세션 상세"""
    session = db.get_session(args.session_id)
    if not session:
        print(f"세션을 찾을 수 없음: {args.session_id}")
        db.close()
        return

    print(f"세션 ID:    {session['id']}")
    print(f"이름:       {session['name']}")
    print(f"상태:       {session['status']}")
    print(f"시작:       {session['started_at']}")
    print(f"종료:       {session.get('ended_at', '-')}")
    print(f"총 이벤트:  {session['total_events']}")

    # 이벤트 타입별 카운트
    events = db.get_events(args.session_id)
    type_counts = {}
    for e in events:
        t = e["event_type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    if type_counts:
        print("\n이벤트 분포:")
        for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
            print(f"  {t:<16} {c}개")

    # 스크린샷 수
    screenshots = db.get_screenshots_by_session(args.session_id)
    if screenshots:
        print(f"\n스크린샷:   {len(screenshots)}장")

    db.close()


if __name__ == "__main__":
    main()
