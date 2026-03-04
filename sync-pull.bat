@echo off
chcp 65001 >nul 2>&1
title MindMap DB Sync Pull
cd /d "%~dp0"
echo.
echo  ========================================
echo   MindMap DB Sync Pull
echo  ========================================
echo.

echo  최신 데이터 가져오는 중...
git pull --rebase

echo.
echo  ========================================
echo   ✅ 동기화 완료
echo  ========================================
echo.
echo  서버 시작하려면 start-local.bat 을 실행하세요.
pause
