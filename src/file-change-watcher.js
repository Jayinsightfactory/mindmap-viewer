'use strict';
// file-change-watcher.js — 사용자 파일 변경 감시
// 주요 폴더(문서, 다운로드, 바탕화면)의 파일 변경 감지

const fs = require('fs');
const path = require('path');
const os = require('os');

let _watchers = [];
let _changes = [];
let _callback = null;
const MAX_CHANGES = 100;

// 감시 대상 폴더
function _getWatchDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(home, 'Desktop'));
    dirs.push(path.join(home, 'Documents'));
    dirs.push(path.join(home, 'Downloads'));
  } else {
    dirs.push(path.join(home, 'Desktop'));
    dirs.push(path.join(home, 'Documents'));
    dirs.push(path.join(home, 'Downloads'));
  }
  return dirs.filter(d => { try { fs.accessSync(d); return true; } catch { return false; } });
}

function start(onFileChange) {
  _callback = onFileChange;
  const dirs = _getWatchDirs();

  dirs.forEach(dir => {
    try {
      const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        // 임시 파일, 시스템 파일 무시
        if (filename.startsWith('.') || filename.startsWith('~$') || filename.endsWith('.tmp')) return;

        // 알고리즘 B: 발주서 엑셀 파일 감지
        const isExcel = /\.(xlsx?|csv)$/i.test(filename);
        const isPurchaseOrder = isExcel && /발주|출고|내역|매출|주문|재고/i.test(filename);

        const change = {
          type: 'file.change',
          eventType, // 'rename' or 'change'
          filename,
          dir: path.basename(dir),
          fullPath: path.join(dir, filename),
          isExcel,
          isPurchaseOrder,
          timestamp: new Date().toISOString(),
        };

        _changes.push(change);
        if (_changes.length > MAX_CHANGES) _changes.shift();

        if (_callback) _callback(change);
      });
      _watchers.push(watcher);
    } catch {}
  });

  console.log(`[file-change-watcher] 시작 (${dirs.length}개 폴더 감시)`);
}

function stop() {
  _watchers.forEach(w => { try { w.close(); } catch {} });
  _watchers = [];
}

function getRecentChanges(count = 20) {
  return _changes.slice(-count);
}

function isRunning() { return _watchers.length > 0; }

module.exports = { start, stop, getRecentChanges, isRunning };
