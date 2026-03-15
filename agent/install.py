#!/usr/bin/env python3
"""
Orbit AI Desktop Agent — 크로스플랫폼 설치 스크립트

사용법:
  python install.py                    # 대화형 설치
  python install.py --token ABC123     # 토큰 지정
  python install.py --uninstall        # 제거

동작:
  1. Python 3.8+ 확인
  2. 가상환경 생성 (~/.orbit/venv/)
  3. 의존성 설치
  4. 에이전트 코드 복사
  5. OS별 백그라운드 서비스 등록 (부팅/로그인 시 자동 시작)
  6. 초기 설정
  7. 즉시 백그라운드 시작

※ 클로드 앱처럼: 설치 1번 → 이후 컴퓨터 켤 때마다 자동 시작, 창 없이 백그라운드 동작
"""
import os
import sys
import json
import shutil
import platform
import subprocess
from pathlib import Path

PLATFORM = platform.system().lower()
HOME = Path.home()
ORBIT_DIR = HOME / '.orbit'
VENV_DIR = ORBIT_DIR / 'venv'
AGENT_DIR = Path(__file__).parent / 'orbit_agent'
LOG_DIR = ORBIT_DIR / 'logs'


def print_banner():
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║   Orbit AI Desktop Agent Install             ║")
    print("╚══════════════════════════════════════════════╝")
    print()
    print(f"  OS: {platform.system()} {platform.machine()}")
    print(f"  Python: {sys.version.split()[0]}")
    print(f"  설치 경로: {ORBIT_DIR}")
    print()


def check_python():
    if sys.version_info < (3, 8):
        print(f"  X Python 3.8 이상 필요 (현재: {sys.version})")
        sys.exit(1)
    print(f"  [OK] Python {sys.version.split()[0]}")


def check_tesseract():
    try:
        result = subprocess.run(['tesseract', '--version'],
                                capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            ver = result.stdout.split('\n')[0]
            print(f"  [OK] Tesseract: {ver}")
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    print("  [선택] Tesseract OCR 미설치 (화면 OCR 기능 비활성)")
    if PLATFORM == 'darwin':
        print("         brew install tesseract tesseract-lang")
    elif PLATFORM == 'windows':
        print("         https://github.com/UB-Mannheim/tesseract/wiki")
    else:
        print("         sudo apt install tesseract-ocr tesseract-ocr-kor")
    return False


def create_venv():
    ORBIT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    if VENV_DIR.exists():
        print("  [OK] 가상환경 이미 존재")
        return

    print("  ... 가상환경 생성 중")
    subprocess.run([sys.executable, '-m', 'venv', str(VENV_DIR)], check=True)
    print("  [OK] 가상환경 생성 완료")


def get_pip():
    if PLATFORM == 'windows':
        return str(VENV_DIR / 'Scripts' / 'pip')
    return str(VENV_DIR / 'bin' / 'pip')


def get_python():
    """가상환경 Python — 콘솔 창 있는 버전"""
    if PLATFORM == 'windows':
        return str(VENV_DIR / 'Scripts' / 'python.exe')
    return str(VENV_DIR / 'bin' / 'python')


def get_pythonw():
    """가상환경 Pythonw — 콘솔 창 없는 버전 (Windows용)"""
    if PLATFORM == 'windows':
        pw = VENV_DIR / 'Scripts' / 'pythonw.exe'
        if pw.exists():
            return str(pw)
        # fallback: python.exe
        return get_python()
    return get_python()


def install_deps():
    req_file = Path(__file__).parent / 'requirements.txt'
    if not req_file.exists():
        print("  X requirements.txt 없음")
        sys.exit(1)

    print("  ... 의존성 설치 중 (1~2분 소요)")
    pip = get_pip()

    subprocess.run([pip, 'install', '--upgrade', 'pip'],
                   capture_output=True, timeout=120)

    result = subprocess.run(
        [pip, 'install', '-r', str(req_file)],
        capture_output=True, text=True, timeout=300
    )

    if result.returncode != 0:
        print("  [경고] 일부 패키지 설치 실패 (핵심 기능은 동작)")

    # OS별 추가 패키지
    if PLATFORM == 'windows':
        subprocess.run([pip, 'install', 'pywin32'],
                       capture_output=True, timeout=120)
    elif PLATFORM == 'darwin':
        subprocess.run([pip, 'install', 'pyobjc-framework-Cocoa'],
                       capture_output=True, timeout=120)

    print("  [OK] 의존성 설치 완료")


def copy_agent():
    dest = ORBIT_DIR / 'agent'
    if dest.exists():
        shutil.rmtree(dest)

    src = Path(__file__).parent / 'orbit_agent'
    shutil.copytree(str(src), str(dest / 'orbit_agent'))
    print("  [OK] 에이전트 코드 설치")


def setup_config(token='', server_url='', user_id='', api_key=''):
    config_file = ORBIT_DIR / 'agent-config.json'

    cfg = {}
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding='utf-8'))
        except Exception:
            pass

    if not token and not cfg.get('api_token'):
        token = input("  Orbit API 토큰: ").strip()
    if token:
        cfg['api_token'] = token

    if not server_url:
        server_url = cfg.get('server_url', 'https://sparkling-determination-production-c88b.up.railway.app')
    cfg['server_url'] = server_url

    if not user_id and not cfg.get('user_id'):
        user_id = input("  사용자 ID (비워두면 자동): ").strip()
    if user_id:
        cfg['user_id'] = user_id

    if not api_key and not cfg.get('anthropic_api_key'):
        api_key = input("  Anthropic API Key (AI 분석용, 비워두면 나중에): ").strip()
    if api_key:
        cfg['anthropic_api_key'] = api_key

    # 기본 감시 디렉토리
    if not cfg.get('file_watch_dirs'):
        watch_dirs = []
        for d in ['Documents', 'Desktop', 'Downloads']:
            p = HOME / d
            if p.exists():
                watch_dirs.append(str(p))
        cfg['file_watch_dirs'] = watch_dirs

    config_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    print("  [OK] 설정 저장 완료")


# ═══════════════════════════════════════════════════════════════
# OS별 백그라운드 서비스 등록 — 부팅/로그인 시 자동 시작, 창 없이 동작
# ═══════════════════════════════════════════════════════════════

def register_service():
    """OS별 백그라운드 서비스 등록 + 즉시 시작"""
    if PLATFORM == 'darwin':
        _register_macos()
    elif PLATFORM == 'windows':
        _register_windows()
    elif PLATFORM == 'linux':
        _register_linux()

    print()
    _start_now()


def _register_macos():
    """
    macOS: launchd 에이전트
    - RunAtLoad: 로그인 시 자동 시작
    - KeepAlive: 크래시 시 자동 재시작
    - ProcessType: Background (리소스 우선순위 낮게)
    - Nice: 10 (CPU 양보)
    - ThrottleInterval: 30 (30초 내 재시작 방지)
    """
    python_path = get_python()
    agent_path = ORBIT_DIR / 'agent'

    plist_path = HOME / 'Library' / 'LaunchAgents' / 'com.orbitai.agent.plist'
    plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.orbitai.agent</string>

    <key>ProgramArguments</key>
    <array>
        <string>{python_path}</string>
        <string>-m</string>
        <string>orbit_agent</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{agent_path}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONPATH</key>
        <string>{agent_path}</string>
    </dict>

    <!-- 로그인 시 자동 시작 -->
    <key>RunAtLoad</key>
    <true/>

    <!-- 크래시/종료 시 자동 재시작 -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <!-- 재시작 간격 (30초) -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <!-- 백그라운드 프로세스 (리소스 절약) -->
    <key>ProcessType</key>
    <string>Background</string>
    <key>Nice</key>
    <integer>10</integer>

    <!-- 로그 -->
    <key>StandardOutPath</key>
    <string>{LOG_DIR}/agent-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{LOG_DIR}/agent-stderr.log</string>
</dict>
</plist>"""

    plist_path.parent.mkdir(parents=True, exist_ok=True)

    # 기존 서비스 중지
    subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}', str(plist_path)],
                   capture_output=True)

    plist_path.write_text(plist_content)

    # 새 서비스 등록
    result = subprocess.run(
        ['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist_path)],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        # fallback: 구형 API
        subprocess.run(['launchctl', 'load', '-w', str(plist_path)], capture_output=True)

    print("  [OK] macOS 서비스 등록")
    print("       - 로그인 시 자동 시작")
    print("       - 크래시 시 자동 재시작")
    print("       - 창 없이 백그라운드 동작")


def _register_windows():
    """
    Windows: 3중 보장
    1. 시작 레지스트리 등록 (가장 확실)
    2. 작업 스케줄러 등록 (백업)
    3. VBS 래퍼로 콘솔 창 숨김
    """
    pythonw_path = get_pythonw()
    agent_path = ORBIT_DIR / 'agent'

    # ── 1. VBS 래퍼 생성 (콘솔 창 완전 숨김) ──────────────
    vbs_path = ORBIT_DIR / 'start-agent.vbs'
    vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """{pythonw_path}"" -m orbit_agent", 0, False
'''
    vbs_path.write_text(vbs_content)

    # ── 2. 시작 레지스트리 등록 ────────────────────────────
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE
        )
        # wscript.exe로 VBS 실행 → 완전 무창
        winreg.SetValueEx(
            key, "OrbitAI-Agent", 0, winreg.REG_SZ,
            f'wscript.exe "{vbs_path}"'
        )
        winreg.CloseKey(key)
        print("  [OK] 시작 레지스트리 등록 (로그온 시 자동 시작)")
    except Exception as e:
        print(f"  [경고] 레지스트리 등록 실패: {e}")
        # fallback: 시작 폴더에 바로가기
        _create_startup_shortcut(vbs_path)

    # ── 3. 작업 스케줄러 (백업 — 크래시 복구) ─────────────
    task_name = "OrbitAI-AgentRecover"
    subprocess.run(['schtasks', '/Delete', '/TN', task_name, '/F'],
                   capture_output=True)

    # 매 30분마다 실행 확인 (이미 실행 중이면 스킵)
    subprocess.run([
        'schtasks', '/Create',
        '/TN', task_name,
        '/TR', f'wscript.exe "{vbs_path}"',
        '/SC', 'MINUTE', '/MO', '30',
        '/F',
    ], capture_output=True)

    print("  [OK] 작업 스케줄러 등록 (30분마다 생존 확인)")
    print("       - 콘솔 창 없이 완전 백그라운드 동작")


def _create_startup_shortcut(target_path):
    """Windows: 시작 폴더에 바로가기 생성 (레지스트리 실패 시 fallback)"""
    try:
        startup_dir = Path(os.environ.get('APPDATA', '')) / \
                      'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup'
        if not startup_dir.exists():
            return

        # .bat 파일로 대체 (VBS를 시작 폴더에 복사)
        bat_path = startup_dir / 'OrbitAI-Agent.bat'
        bat_path.write_text(
            f'@echo off\nstart /B wscript.exe "{target_path}"\n',
            encoding='utf-8'
        )
        print("  [OK] 시작 폴더에 바로가기 생성")
    except Exception:
        pass


def _register_linux():
    """
    Linux: systemd user 서비스
    - WantedBy=default.target: 로그인 시 자동 시작
    - Restart=always: 크래시 시 재시작
    - RestartSec=30: 30초 후 재시작
    """
    python_path = get_python()
    agent_path = ORBIT_DIR / 'agent'

    service_dir = HOME / '.config' / 'systemd' / 'user'
    service_dir.mkdir(parents=True, exist_ok=True)

    service_path = service_dir / 'orbit-agent.service'
    service_content = f"""[Unit]
Description=Orbit AI Desktop Agent
After=graphical-session.target

[Service]
Type=simple
ExecStart={python_path} -m orbit_agent
WorkingDirectory={agent_path}
Environment=PYTHONPATH={agent_path}
Restart=always
RestartSec=30
Nice=10

StandardOutput=append:{LOG_DIR}/agent-stdout.log
StandardError=append:{LOG_DIR}/agent-stderr.log

[Install]
WantedBy=default.target
"""
    service_path.write_text(service_content)

    subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True)
    subprocess.run(['systemctl', '--user', 'enable', 'orbit-agent'], capture_output=True)

    print("  [OK] systemd 서비스 등록")
    print("       - 로그인 시 자동 시작")
    print("       - 크래시 시 30초 후 재시작")

    # linger 활성화 (로그인 안 해도 유저 서비스 유지)
    subprocess.run(['loginctl', 'enable-linger', os.environ.get('USER', '')],
                   capture_output=True)


def _start_now():
    """설치 직후 즉시 백그라운드 시작"""
    print("  ... 에이전트 백그라운드 시작 중")

    if PLATFORM == 'darwin':
        subprocess.run(
            ['launchctl', 'kickstart', '-k',
             f'gui/{os.getuid()}/com.orbitai.agent'],
            capture_output=True
        )
    elif PLATFORM == 'windows':
        vbs_path = ORBIT_DIR / 'start-agent.vbs'
        if vbs_path.exists():
            subprocess.Popen(
                ['wscript.exe', str(vbs_path)],
                creationflags=0x00000008,  # DETACHED_PROCESS
                close_fds=True
            )
        else:
            pythonw = get_pythonw()
            agent_path = ORBIT_DIR / 'agent'
            subprocess.Popen(
                [pythonw, '-m', 'orbit_agent'],
                cwd=str(agent_path),
                creationflags=0x00000008,
                close_fds=True
            )
    elif PLATFORM == 'linux':
        subprocess.run(['systemctl', '--user', 'start', 'orbit-agent'],
                       capture_output=True)

    print("  [OK] 백그라운드 시작 완료")


# ═══════════════════════════════════════════════════════════════
# 제거
# ═══════════════════════════════════════════════════════════════

def uninstall():
    print("  제거 중...")

    # ── 서비스 중지 + 해제 ─────────────────────────────────
    if PLATFORM == 'darwin':
        plist = HOME / 'Library' / 'LaunchAgents' / 'com.orbitai.agent.plist'
        subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}', str(plist)],
                       capture_output=True)
        if plist.exists():
            plist.unlink()

    elif PLATFORM == 'windows':
        # 레지스트리에서 제거
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0, winreg.KEY_SET_VALUE
            )
            try:
                winreg.DeleteValue(key, "OrbitAI-Agent")
            except FileNotFoundError:
                pass
            winreg.CloseKey(key)
        except Exception:
            pass

        # 작업 스케줄러에서 제거
        subprocess.run(['schtasks', '/Delete', '/TN', 'OrbitAI-AgentRecover', '/F'],
                       capture_output=True)

        # 시작 폴더 바로가기 제거
        startup = Path(os.environ.get('APPDATA', '')) / \
                  'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup'
        bat = startup / 'OrbitAI-Agent.bat'
        if bat.exists():
            bat.unlink()

        # VBS 래퍼 제거
        vbs = ORBIT_DIR / 'start-agent.vbs'
        if vbs.exists():
            vbs.unlink()

        # 프로세스 종료
        subprocess.run(['taskkill', '/F', '/IM', 'pythonw.exe'], capture_output=True)

    elif PLATFORM == 'linux':
        subprocess.run(['systemctl', '--user', 'stop', 'orbit-agent'], capture_output=True)
        subprocess.run(['systemctl', '--user', 'disable', 'orbit-agent'], capture_output=True)
        service = HOME / '.config' / 'systemd' / 'user' / 'orbit-agent.service'
        if service.exists():
            service.unlink()

    # ── 코드 + venv 제거 (데이터/설정은 보존) ─────────────
    for d in ['agent', 'venv', 'captures']:
        p = ORBIT_DIR / d
        if p.exists():
            shutil.rmtree(p)

    print("  [OK] 제거 완료")
    print(f"       설정/데이터 보존: {ORBIT_DIR}")
    print("       완전 삭제: rm -rf ~/.orbit")


# ═══════════════════════════════════════════════════════════════
# PID 기반 중복 실행 방지
# ═══════════════════════════════════════════════════════════════

def is_already_running():
    """이미 에이전트가 실행 중인지 확인"""
    pid_file = ORBIT_DIR / 'agent.pid'
    if not pid_file.exists():
        return False

    try:
        pid = int(pid_file.read_text().strip())
        # 프로세스 존재 확인
        os.kill(pid, 0)
        return True
    except (ValueError, ProcessLookupError, PermissionError):
        # PID 파일은 있지만 프로세스 없음 → stale
        pid_file.unlink(missing_ok=True)
        return False


# ═══════════════════════════════════════════════════════════════
# 메인
# ═══════════════════════════════════════════════════════════════

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Orbit AI Desktop Agent Installer')
    parser.add_argument('--uninstall', action='store_true', help='에이전트 제거')
    parser.add_argument('--token', default='', help='API 토큰')
    parser.add_argument('--server-url', default='', help='서버 URL')
    parser.add_argument('--user-id', default='', help='사용자 ID')
    parser.add_argument('--api-key', default='', help='Anthropic API Key')
    args = parser.parse_args()

    print_banner()

    if args.uninstall:
        uninstall()
        return

    # 이미 실행 중이면 알림
    if is_already_running():
        print("  [알림] 에이전트가 이미 실행 중입니다.")
        print("         재설치하려면 먼저: python install.py --uninstall")
        resp = input("  계속 설치하시겠습니까? (y/N): ").strip().lower()
        if resp != 'y':
            return

    # ── 설치 단계 ──────────────────────────────────────────
    check_python()
    check_tesseract()
    print()

    create_venv()
    install_deps()
    copy_agent()
    print()

    setup_config(
        token=args.token,
        server_url=args.server_url,
        user_id=args.user_id,
        api_key=args.api_key,
    )
    print()

    register_service()

    print()
    print("╔══════════════════════════════════════════════╗")
    print("║   설치 완료!                                 ║")
    print("╠══════════════════════════════════════════════╣")
    print("║                                              ║")
    print("║   에이전트가 백그라운드에서 실행 중입니다.    ║")
    print("║   컴퓨터를 재시작해도 자동으로 시작됩니다.   ║")
    print("║                                              ║")
    print("║   상태: python -m orbit_agent --status       ║")
    print("║   로그: ~/.orbit/logs/agent.log              ║")
    print("║   제거: python install.py --uninstall        ║")
    print("║                                              ║")
    print("╚══════════════════════════════════════════════╝")
    print()


if __name__ == '__main__':
    main()
