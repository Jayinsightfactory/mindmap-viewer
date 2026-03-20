'use strict';
// clipboard-watcher.js — 클립보드 변경 감지 + 발주서 자동 파싱
// 2초마다 클립보드 체크, 발주서 포맷 감지 시 구조화 데이터 포함 전송

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
        { timeout: 1000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
      ).trim();
    }
  } catch {}
  return '';
}

// ── 발주서/주문 포맷 자동 감지 ──
function _detectOrderFormat(text) {
  if (/\[MEL\]/.test(text)) return 'mel_order';
  if (/^ROSE\s*\//.test(text)) return 'rose_order';
  if (/(취소|추가)/.test(text) && /\d+\s*(단|박스)/.test(text)) return 'change_order';
  if (/창고보관/.test(text)) return 'inventory';
  if (/출고일자|출고\s/.test(text) && /\t/.test(text)) return 'shipping';
  if (/발주서/.test(text)) return 'purchase_memo';
  if (/파손/.test(text) && /\d+/.test(text)) return 'damage_report';
  // 탭 구분 품목+수량 테이블 (Excel에서 복사)
  if (/\t/.test(text) && /\d+/.test(text) && text.split('\n').length >= 3) return 'table_data';
  return null;
}

// ── 간이 파서: 클립보드 텍스트 → 주문 아이템 추출 ──
function _quickParse(text, format) {
  const items = [];
  try {
    if (format === 'mel_order') {
      const m = text.match(/\[MEL\]\s*(.*?)\s*\/\s*(.*)/s);
      if (m) {
        const segments = m[2].split(/\s*\+\s*/);
        for (const seg of segments) {
          for (const item of seg.split(/,\s*/)) {
            const im = item.trim().match(/(.+?)\s*:\s*([\d.]+)/);
            if (im) items.push({ product: im[1].trim(), qty: parseFloat(im[2]) });
          }
        }
      }
    } else if (format === 'shipping' || format === 'inventory' || format === 'table_data') {
      // 탭 구분 데이터: "품종\t수량" 패턴
      for (const line of text.split('\n')) {
        const m = line.match(/\t([^\t]+)\t(\d+)/);
        if (m && !/합\s*계|색상|수량/.test(m[1])) {
          items.push({ product: m[1].trim(), qty: parseInt(m[2]) });
        }
      }
    } else if (format === 'change_order') {
      for (const line of text.split('\n')) {
        const m = line.trim().match(/(\S+)\s+(\S+)\s+(\d+)\s*(단|박스)?\s*(취소|추가)?/);
        if (m) items.push({ customer: m[1], product: m[2], qty: parseInt(m[3]), action: /취소/.test(line) ? 'cancel' : 'add' });
      }
    }
  } catch {}
  return items;
}

function start(onClipboardChange) {
  _callback = onClipboardChange;
  _timer = setInterval(_check, 2000);
  console.log('[clipboard-watcher] 시작 (2초 간격, 발주서 자동 감지 ON)');
}

function _check() {
  if (_paused) return;
  try {
    let text = '';
    if (process.platform === 'win32') {
      text = execSync('powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard"',
        { timeout: 2000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
    } else if (process.platform === 'darwin') {
      text = execSync('pbpaste', { timeout: 1000, encoding: 'utf8' }).trim();
    }

    if (text && text !== _lastClipboard && text.length > 0 && text.length < 5000) {
      const prev = _lastClipboard;
      _lastClipboard = text;
      if (_callback && prev) {
        const orderFormat = _detectOrderFormat(text);
        const parsed = orderFormat ? _quickParse(text, orderFormat) : [];

        _callback({
          type: 'clipboard.change',
          text: text.substring(0, 2000), // 확대: 500→2000자 (발주서 전체 포함)
          length: text.length,
          sourceApp: _getActiveApp(),
          // ── 발주서 자동 감지 결과 ──
          orderFormat: orderFormat, // null이면 비주문
          parsedItems: parsed.length > 0 ? parsed : undefined,
          parsedCount: parsed.length || undefined,
          timestamp: new Date().toISOString(),
        });

        if (orderFormat) {
          console.log(`[clipboard-watcher] 발주서 감지: ${orderFormat}, ${parsed.length}건 파싱`);
        }
      }
    }
  } catch {}
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
function pause() { _paused = true; }
function resume() { _paused = false; }
function isRunning() { return !!_timer; }

module.exports = { start, stop, pause, resume, isRunning };
