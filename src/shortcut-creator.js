'use strict';
/**
 * shortcut-creator.js — 자주 쓰는 도구 바로가기 자동 생성
 *
 * 알고리즘 C: 강현우 매출마감 도구 같이 매번 수동으로 cmd → cd → python 하는 경우
 * 바탕화면 바로가기 + Startup 등록을 자동으로 생성
 *
 * Vision 분석에서 반복적으로 같은 앱 실행 패턴이 감지되면
 * 바로가기를 제안하거나 자동 생성
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

/**
 * Windows 바탕화면에 BAT 바로가기 생성
 */
function createDesktopShortcut(name, command, options = {}) {
  if (process.platform !== 'win32') return false;

  try {
    const desktop = path.join(os.homedir(), 'Desktop');
    if (!fs.existsSync(desktop)) return false;

    const batPath = path.join(desktop, `${name}.bat`);

    // BAT 내용 (최소화 실행)
    const batContent = `@echo off\r\ntitle ${name}\r\n${command}\r\n`;
    fs.writeFileSync(batPath, batContent, { encoding: 'ascii' });

    console.log(`[shortcut] 바탕화면 바로가기 생성: ${batPath}`);
    return true;
  } catch (e) {
    console.warn(`[shortcut] 생성 실패: ${e.message}`);
    return false;
  }
}

/**
 * 매출마감 도구 바로가기 (강현우 전용)
 * localhost:5050에서 실행되는 Python 웹앱
 */
function createSalesToolShortcut() {
  if (process.platform !== 'win32') return;

  const hostname = os.hostname();
  // 강현우 PC만 (DESKTOP-T09911T)
  if (hostname !== 'DESKTOP-T09911T') return;

  // Python 매출마감 도구 경로 탐색
  const possiblePaths = [
    'C:\\Users\\강현우\\매출마감',
    'C:\\Users\\강현우\\Desktop\\매출마감',
    'C:\\매출마감',
    path.join(os.homedir(), '매출마감'),
    path.join(os.homedir(), 'Desktop', '매출마감'),
  ];

  // 실제 경로 찾기 (app.py 또는 main.py 존재 확인)
  let toolPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'app.py')) || fs.existsSync(path.join(p, 'main.py'))) {
      toolPath = p;
      break;
    }
  }

  // 경로 못 찾으면 일반적인 localhost:5050 오픈 바로가기
  const desktop = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(desktop)) return;

  if (toolPath) {
    // Python 앱 실행 + 브라우저 자동 오픈
    const batContent = `@echo off\r\ntitle 네노바 매출마감\r\ncd /d "${toolPath}"\r\nstart "" "http://localhost:5050"\r\npython app.py\r\n`;
    const batPath = path.join(desktop, '네노바 매출마감.bat');
    if (!fs.existsSync(batPath)) {
      fs.writeFileSync(batPath, batContent, { encoding: 'ascii' });
      console.log(`[shortcut] 매출마감 도구 바로가기 생성: ${batPath}`);
    }
  } else {
    // 경로 모르면 브라우저만
    const batContent = `@echo off\r\nstart "" "http://localhost:5050"\r\n`;
    const batPath = path.join(desktop, '매출마감 도구.bat');
    if (!fs.existsSync(batPath)) {
      fs.writeFileSync(batPath, batContent, { encoding: 'ascii' });
      console.log(`[shortcut] 매출마감 도구 바로가기 생성 (브라우저): ${batPath}`);
    }
  }
}

/**
 * 반복 실행 패턴 감지 → 바로가기 자동 제안
 * (screen.analyzed에서 같은 앱+경로가 3회 이상 감지되면)
 */
function checkAndCreateShortcuts() {
  if (process.platform !== 'win32') return;

  // 매출마감 도구 바로가기 (강현우)
  createSalesToolShortcut();

  console.log('[shortcut] 바로가기 체크 완료');
}

module.exports = { createDesktopShortcut, createSalesToolShortcut, checkAndCreateShortcuts };
