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

// 대상 폴더
// [2026-10-05] Google Drive/OneDrive 동기화 폴더 추가 — 엑셀을 드라이브에서 바로 열어 저장하는 PC는
// 바탕화면/문서/다운로드만 보면 파일 저장이 0건으로 잡혔다. 동기화 루트 + 바로 아래 하위폴더(최대 40개)만,
// 문서 확장자만 본다(깊은 재귀·대용량 스캔 금지). 폴더 목록은 10분마다 갱신, 새로 생긴 폴더는 조용히 기준점만 잡음.
const _DOC_EXT = /\.(xlsx|xlsm|xlsb|xls|csv|docx?|pptx?|pdf|hwpx?)$/i;
function _cloudRoots() {
  const home = os.homedir(); const out = [];
  const cands = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer,
    path.join(home, 'OneDrive'), path.join(home, 'Google Drive'), path.join(home, '내 드라이브'), path.join(home, 'My Drive')];
  for (const L of 'DEFGHI') { cands.push(L + ':\\내 드라이브', L + ':\\My Drive', L + ':\\공유 드라이브', L + ':\\Shared drives'); } // 구글드라이브 가상드라이브(기본 G:)
  try { for (const f of fs.readdirSync(home)) if (/^OneDrive - /i.test(f)) cands.push(path.join(home, f)); } catch {}
  for (const d of cands) { if (!d) continue; try { if (fs.statSync(d).isDirectory() && !out.some(o => o.toLowerCase() === d.toLowerCase())) out.push(d); } catch {} }
  return out;
}
let _dirCache = null, _dirCacheAt = 0, _cloudSet = new Set();
function _getWatchDirs() {
  if (_dirCache && Date.now() - _dirCacheAt < 10 * 60 * 1000) return _dirCache;
  const home = os.homedir();
  const base = [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')]
    .filter(d => { try { fs.accessSync(d); return true; } catch { return false; } });
  const cloud = [];
  try {
    for (const r of _cloudRoots()) {
      cloud.push(r);
      try { let n = 0; for (const e of fs.readdirSync(r, { withFileTypes: true })) { if (n >= 40) break; if (e.isDirectory() && !e.name.startsWith('.')) { cloud.push(path.join(r, e.name)); n++; } } } catch {}
    }
  } catch {}
  _cloudSet = new Set(cloud);
  const all = [...base, ...cloud.filter(c => !base.includes(c))];
  // 새로 추가된 폴더는 기존 파일을 '신규'로 쏟아내지 않도록 기준점만 저장
  if (_dirCache) for (const d of all) if (!_dirCache.includes(d)) _seed(d);
  _dirCache = all; _dirCacheAt = Date.now();
  return all;
}
function _skip(f, dir) { return f.startsWith('.') || f.startsWith('~$') || f.endsWith('.tmp') || (_cloudSet.has(dir) && !_DOC_EXT.test(f)); }
function _seed(dir) { for (const { f, full } of _scanDir(dir)) { if (_skip(f, dir)) continue; try { _snapshot[full] = fs.statSync(full).mtimeMs; } catch {} } }

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
      // 임시 파일·시스템 파일 무시 (동기화 폴더는 문서 확장자만)
      if (_skip(f, dir)) continue;
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
  for (const dir of dirs) _seed(dir);
  _pollTimer = setInterval(_poll, POLL_INTERVAL);
  console.log(`[file-change-watcher] 폴링 시작 (${dirs.length}개 폴더, 5초 간격) — 핸들 고정 없음`);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _snapshot = {}; _dirCache = null;
}

function getRecentChanges(count = 20) {
  return _changes.slice(-count);
}

function isRunning() { return _pollTimer !== null; }

module.exports = { start, stop, getRecentChanges, isRunning };
