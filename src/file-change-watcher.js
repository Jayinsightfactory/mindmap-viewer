'use strict';
// file-change-watcher.js — 사용자 파일 변경 감시 (폴링 방식)
// fs.watch() 대신 주기적 readdir+stat 비교 → Windows 디렉토리 핸들 고정 없음
// → 엑셀/파일 삭제·수정 차단 문제 해결

const fs = require('fs');
const path = require('path');
const os = require('os');

let _pollTimer = null;
let _snapshot = {};       // { 'fullPath': mtime }
let _changes = [];
let _callback = null;
const MAX_CHANGES = 100;
const POLL_INTERVAL = 5000; // 5초마다 체크 (fs.watch 대체)

// 감시 대상 폴더
function _getWatchDirs() {
  const home = os.homedir();
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ].filter(d => { try { fs.accessSync(d); return true; } catch { return false; } });
}

function _scanDir(dir) {
  try {
    return fs.readdirSync(dir).map(f => ({ f, full: path.join(dir, f) }));
  } catch { return []; }
}

function _poll() {
  const dirs = _getWatchDirs();
  const next = {};

  for (const dir of dirs) {
    for (const { f, full } of _scanDir(dir)) {
      // 임시 파일·시스템 파일 무시
      if (f.startsWith('.') || f.startsWith('~$') || f.endsWith('.tmp')) continue;
      try {
        const stat = fs.statSync(full);
        next[full] = stat.mtimeMs;

        const prev = _snapshot[full];
        if (prev === undefined) {
          // 신규 파일
          _emit('rename', f, dir, full);
        } else if (prev !== stat.mtimeMs) {
          // 수정됨
          _emit('change', f, dir, full);
        }
      } catch {}
    }
  }

  // 삭제된 파일 감지
  for (const full of Object.keys(_snapshot)) {
    if (!(full in next)) {
      const f = path.basename(full);
      const dir = path.dirname(full);
      _emit('rename', f, dir, full); // rename = 삭제 or 이름변경
    }
  }

  _snapshot = next;
}

function _emit(eventType, filename, dir, fullPath) {
  const isExcel = /\.(xlsx?|csv)$/i.test(filename);
  const isPurchaseOrder = isExcel && /발주|출고|내역|매출|주문|재고/i.test(filename);

  const change = {
    type: 'file.change',
    eventType,
    filename,
    dir: path.basename(dir),
    fullPath,
    isExcel,
    isPurchaseOrder,
    timestamp: new Date().toISOString(),
  };

  _changes.push(change);
  if (_changes.length > MAX_CHANGES) _changes.shift();
  if (_callback) _callback(change);
}

function start(onFileChange) {
  _callback = onFileChange;
  // 초기 스냅샷 (기준점)
  const dirs = _getWatchDirs();
  for (const dir of dirs) {
    for (const { f, full } of _scanDir(dir)) {
      if (f.startsWith('.') || f.startsWith('~$') || f.endsWith('.tmp')) continue;
      try { _snapshot[full] = fs.statSync(full).mtimeMs; } catch {}
    }
  }
  _pollTimer = setInterval(_poll, POLL_INTERVAL);
  console.log(`[file-change-watcher] 폴링 시작 (${dirs.length}개 폴더, 5초 간격) — 핸들 고정 없음`);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _snapshot = {};
}

function getRecentChanges(count = 20) {
  return _changes.slice(-count);
}

function isRunning() { return _pollTimer !== null; }

module.exports = { start, stop, getRecentChanges, isRunning };
