@echo off
chcp 65001 >nul 2>&1
title MindMap DB Sync Push
cd /d "%~dp0"
echo.
echo  ========================================
echo   MindMap DB Sync Push
echo  ========================================
echo.

echo  [1/4] DB 민감정보 정리 중...
node sanitize-db.js
if errorlevel 1 (
    echo.
    echo  ❌ 민감정보 정리 실패. push를 중단합니다.
    pause
    exit /b 1
)

echo.
echo  [2/4] 변경사항 확인 중...
git status --short

echo.
echo  [3/4] DB 파일 스테이징...
git add data/mindmap.db data/mindmap.db-wal data/mindmap.db-shm 2>nul
git add -A

echo.
echo  [4/4] 커밋 & 푸시 중...
git commit -m "Sync: DB update %date% %time%"
git push

echo.
echo  ========================================
echo   ✅ 동기화 완료
echo  ========================================
pause
