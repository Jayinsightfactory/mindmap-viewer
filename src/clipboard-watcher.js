'use strict';
// clipboard-watcher.js — 클립보드 변경 감지 + 발주서 자동 파싱
// 2초마다 클립보드 체크, 발주서 포맷 감지 시 구조화 데이터 포함 전송

const { execSync } = require('child_process');
const os = require('os');

let _lastClipboard = '';
let _timer = null;
let _paused = false;
let _callback = null;
let _clipboardFreqByApp = {};  // 앱별 클립보드 변경 횟수
let _lastCopyApp = '';         // 마지막 복사가 발생한 앱
let _lastCopyTime = 0;        // 마지막 복사 시간

function _getActiveApp() {
  try {
    if (process.platform === 'win32') {
      return require('child_process').execSync(
        'powershell.exe -NoProfile -WindowStyle Hidden -Command "(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Sort-Object CPU -Descending | Select-Object -First 1).ProcessName"',
        { timeout: 1000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
      ).trim();
    }
    if (process.platform === 'darwin') {
      const script = 'tell application "System Events" to get name of first process where frontmost is true';
      return require('child_process').execSync(`osascript -e '${script}'`, { timeout: 1000, encoding: 'utf8' }).trim();
    }
  } catch {}
  return '';
}

function _getActiveWindowTitle() {
  try {
    if (process.platform === 'win32') {
      return require('child_process').execSync(
        'powershell.exe -NoProfile -WindowStyle Hidden -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); }\'; $h=[WinAPI]::GetForegroundWindow(); $b=New-Object System.Text.StringBuilder 512; [void][WinAPI]::GetWindowText($h,$b,512); $b.ToString()"',
        { timeout: 3000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
      ).trim();
    }
    if (process.platform === 'darwin') {
      const script = 'tell application "System Events" to tell (first process where frontmost is true) to get name of front window';
      return require('child_process').execSync(`osascript -e '${script}'`, { timeout: 1000, encoding: 'utf8' }).trim();
    }
  } catch {}
  return '';
}

// ── 발주서/주문 포맷 자동 감지 (confidence 포함) ──
function _detectOrderFormat(text) {
  if (/\[MEL\]/.test(text)) return { format: 'mel_order', confidence: 0.95 };
  if (/^ROSE\s*\//.test(text)) return { format: 'rose_order', confidence: 0.95 };
  if (/(취소|추가)/.test(text) && /\d+\s*(단|박스)/.test(text)) return { format: 'change_order', confidence: 0.9 };
  if (/창고보관/.test(text)) return { format: 'inventory', confidence: 0.85 };
  if (/출고일자|출고\s/.test(text) && /\t/.test(text)) return { format: 'shipping', confidence: 0.9 };
  if (/발주서/.test(text)) return { format: 'purchase_memo', confidence: 0.85 };
  if (/파손/.test(text) && /\d+/.test(text)) return { format: 'damage_report', confidence: 0.8 };
  // 가격/금액 포함 테이블 (견적서, 정산서)
  if (/\t/.test(text) && /[\d,]+원|₩[\d,]+|\$[\d,.]+/.test(text)) return { format: 'price_table', confidence: 0.8 };
  // 전화번호/주소 포함 (고객 정보)
  if (/\d{2,3}-\d{3,4}-\d{4}/.test(text) && text.split('\n').length >= 2) return { format: 'contact_info', confidence: 0.75 };
  // 탭 구분 품목+수량 테이블 (Excel에서 복사)
  if (/\t/.test(text) && /\d+/.test(text) && text.split('\n').length >= 3) return { format: 'table_data', confidence: 0.7 };
  return null;
}

// 하위 호환: 이전 format string만 반환하던 코드와 호환
function _getOrderFormatString(detected) {
  return detected ? detected.format : null;
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

// Windows: long-running PowerShell으로 cmd창 깜빡임 방지
let _winShell = null, _winShellFailed = false;
function _loadWinShell() {
  if (_winShell || _winShellFailed) return _winShell;
  try { _winShell = require('./win-shell'); }
  catch (e) { _winShellFailed = true; }
  return _winShell;
}

async function _check() {
  if (_paused) return;
  try {
    let text = '';
    if (process.platform === 'win32') {
      const ws = _loadWinShell();
      if (ws && ws.isAvailable()) {
        try { text = (await ws.exec('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard', 2000) || '').trim(); }
        catch { return; } // win-shell 일시 실패 → 다음 사이클에 재시도 (cmd창 폴백 금지)
      } else {
        // win-shell 사용 불가 시에도 execSync 폴백 금지 (cmd창 깜빡임 방지)
        return;
      }
    } else if (process.platform === 'darwin') {
      text = execSync('pbpaste', { timeout: 1000, encoding: 'utf8' }).trim();
    }

    if (text && text !== _lastClipboard && text.length > 0 && text.length < 5000) {
      const prev = _lastClipboard;
      _lastClipboard = text;
      if (_callback && prev) {
        const orderDetected = _detectOrderFormat(text);
        const orderFormat = _getOrderFormatString(orderDetected);
        const parsed = orderFormat ? _quickParse(text, orderFormat) : [];

        // 활성 앱/윈도우 컨텍스트 수집
        const sourceApp = _getActiveApp();
        const sourceWindow = _getActiveWindowTitle();

        // 앱별 클립보드 변경 빈도 추적
        if (sourceApp) {
          _clipboardFreqByApp[sourceApp] = (_clipboardFreqByApp[sourceApp] || 0) + 1;
        }

        // 복사→붙여넣기 시퀀스 추적
        const now = Date.now();
        const copyPasteGap = _lastCopyTime > 0 ? now - _lastCopyTime : null;
        const copySourceApp = _lastCopyApp;
        _lastCopyApp = sourceApp;
        _lastCopyTime = now;

        _callback({
          type: 'clipboard.change',
          text: text.substring(0, 2000), // 확대: 500→2000자 (발주서 전체 포함)
          length: text.length,
          sourceApp,
          // ── 윈도우 컨텍스트 (어떤 화면에서 복사했는지) ──
          windowTitle: sourceWindow,
          // ── 복사→붙여넣기 시퀀스 ──
          copySequence: copySourceApp && copySourceApp !== sourceApp ? {
            fromApp: copySourceApp,
            toApp: sourceApp,
            gapMs: copyPasteGap,
          } : undefined,
          // ── 앱별 클립보드 사용 빈도 ──
          clipboardFreqByApp: { ..._clipboardFreqByApp },
          // ── 발주서 자동 감지 결과 ──
          orderFormat: orderFormat, // null이면 비주문
          orderConfidence: orderDetected ? orderDetected.confidence : undefined,
          parsedItems: parsed.length > 0 ? parsed : undefined,
          parsedCount: parsed.length || undefined,
          timestamp: new Date().toISOString(),
        });

        if (orderFormat) {
          console.log(`[clipboard-watcher] 발주서 감지: ${orderFormat} (신뢰도: ${orderDetected.confidence}), ${parsed.length}건 파싱, 앱: ${sourceApp}/${sourceWindow}`);
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
