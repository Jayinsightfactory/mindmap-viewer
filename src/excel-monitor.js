'use strict';
/**
 * excel-monitor.js — Excel COM 모니터
 *
 * Windows PowerShell COM을 통해 활성 Excel 정보 수집:
 * - 현재 열린 워크북 이름
 * - 활성 시트명
 * - 선택 셀 범위
 * - 최근 편집 셀 값 (개인정보 제외)
 *
 * 10초마다 체크, 변경 시에만 이벤트 전송
 */

const { execSync } = require('child_process');
const os = require('os');

let _timer = null;
let _callback = null;
let _lastState = '';
let _paused = false;

const CHECK_INTERVAL = 10000; // 10초

function start(onExcelChange) {
  if (process.platform !== 'win32') {
    console.log('[excel-monitor] Windows 전용 — 건너뜀');
    return;
  }
  _callback = onExcelChange;
  _timer = setInterval(_check, CHECK_INTERVAL);
  console.log('[excel-monitor] Excel COM 모니터 시작 (10초 간격)');
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
  if (_paused || !_callback) return;
  try {
    const ws = _loadWinShell();
    if (!ws || !ws.isAvailable()) return; // win-shell 없으면 skip (cmd창 폴백 금지)

    // PowerShell COM으로 Excel 상태 읽기 (single-line)
    const ps = `try { $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application'); if ($xl) { $wb = $xl.ActiveWorkbook; $ws = $xl.ActiveSheet; $sel = $xl.Selection; $wbn = ''; if($wb){$wbn=$wb.Name}; $wsn = ''; if($ws){$wsn=$ws.Name}; $caddr = ''; if($sel){$caddr=$sel.Address($false,$false)}; $cval = ''; if($sel -and $sel.Count -eq 1 -and $sel.Value2){$cval=[string]$sel.Value2}; $cfor = ''; if($sel -and $sel.Count -eq 1 -and $sel.HasFormula){$cfor=$sel.Formula}; $sc = 0; if($wb){$sc=$wb.Sheets.Count}; $rc = 0; if($ws){$rc=$ws.UsedRange.Rows.Count}; $info = @{workbook=$wbn;sheet=$wsn;cell=$caddr;value=$cval;formula=$cfor;sheetCount=$sc;rowCount=$rc}; $info | ConvertTo-Json -Compress } else { Write-Output '{}' } } catch { Write-Output '{}' }`;

    let result = '';
    try { result = (await ws.exec(ps, 5000) || '').trim(); }
    catch { return; }

    if (!result || result === '{}') return;

    const state = JSON.stringify(result);
    if (state === _lastState) return; // 변경 없음
    _lastState = state;

    try {
      const data = JSON.parse(result);
      if (!data.workbook) return;

      // 개인정보 필터 (셀 값이 전화번호/이메일이면 마스킹)
      if (data.value) {
        if (/\d{3}[-.]?\d{3,4}[-.]?\d{4}/.test(data.value)) data.value = '[전화번호]';
        if (/@/.test(data.value)) data.value = '[이메일]';
        if (data.value.length > 100) data.value = data.value.substring(0, 100) + '…';
      }

      _callback({
        type: 'excel.activity',
        workbook: data.workbook,
        sheet: data.sheet,
        cell: data.cell,
        value: data.value || '',
        formula: data.formula || '',
        sheetCount: data.sheetCount || 0,
        rowCount: data.rowCount || 0,
        hostname: os.hostname(),
        timestamp: new Date().toISOString(),
      });
    } catch {}
  } catch {} // Excel 미실행 시 무시
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
function pause() { _paused = true; }
function resume() { _paused = false; }
function isRunning() { return !!_timer; }

module.exports = { start, stop, pause, resume, isRunning };
