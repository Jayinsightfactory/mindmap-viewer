@echo off
chcp 65001 >nul 2>&1
title Claude MindMap Viewer (Local)
cd /d "%~dp0"
echo.
echo  MindMap: http://localhost:4747
echo.
node server.js
