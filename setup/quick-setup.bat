@echo off
chcp 65001 >nul 2>&1
echo.
echo ========================================
echo   Claude MindMap Viewer - Quick Setup
echo ========================================
echo.

:: Git clone (이미 있으면 pull)
if exist "%~dp0..\server.js" (
    echo [OK] 프로젝트 이미 존재
    cd /d "%~dp0.."
    git pull
) else (
    echo [..] 프로젝트 다운로드 중...
    git clone https://github.com/dlaww-wq/mindmap-viewer.git "%~dp0.."
    cd /d "%~dp0.."
)

:: npm install
if not exist "node_modules" (
    echo [..] 의존성 설치 중...
    call npm install
)

:: Import config
echo [..] Claude Code 설정 적용 중...
powershell -ExecutionPolicy Bypass -File setup\import-config.ps1

echo.
echo 완료! 브라우저에서 http://localhost:4747 을 열어보세요
pause
