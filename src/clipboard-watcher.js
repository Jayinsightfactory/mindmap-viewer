'use strict';
// clipboard-watcher.js — 클립보드 변경 감지
// 1초마다 클립보드 내용 체크, 변경 시 이벤트 전송

const { execSync } = require('child_process');
const os = require('os');

let _lastClipboard = '';
let _timer = null;
let _paused = false;
let _callback = null;

function _getActiveApp() {
  try {
    if (process.platform === 'win32') {
      return require('child_process').execSync(
        'powershell -NoProfile -Command "(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object CPU -Descending | Select-Object -First 1).ProcessName"',
        { timeout: 1000, encoding: 'utf8', windowsHide: true }
      ).trim();
    }
  } catch {}
  return '';
}

function start(onClipboardChange) {
  _callback = onClipboardChange;
  _timer = setInterval(_check, 2000); // 2초마다 체크
  console.log('[clipboard-watcher] 시작 (2초 간격)');
}

function _check() {
  if (_paused) return;
  try {
    let text = '';
    if (process.platform === 'win32') {
      text = execSync('powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard"',
        { timeout: 2000, encoding: 'utf8', windowsHide: true }).trim();
    } else if (process.platform === 'darwin') {
      text = execSync('pbpaste', { timeout: 1000, encoding: 'utf8' }).trim();
    }

    if (text && text !== _lastClipboard && text.length > 0 && text.length < 5000) {
      const prev = _lastClipboard;
      _lastClipboard = text;
      if (_callback && prev) { // 첫 번째는 스킵 (초기 로드)
        _callback({
          type: 'clipboard.change',
          text: text.substring(0, 500), // 최대 500자
          length: text.length,
          sourceApp: _getActiveApp(), // 복사 시점의 활성 앱
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch {}
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
function pause() { _paused = true; }
function resume() { _paused = false; }
function isRunning() { return !!_timer; }

module.exports = { start, stop, pause, resume, isRunning };
