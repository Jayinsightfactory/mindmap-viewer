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

// [2026-09-10] 앵커 검증용 행 문맥 수집 설정
const MAX_COLS = 30;      // 행에서 담을 최대 열 수(발주/판매입력 양식이 22열이라 충분)
const MAX_CELL_LEN = 100; // 셀 하나의 최대 길이

/** 셀 값 개인정보 마스킹 — 선택 셀과 이웃 셀에 같은 기준을 적용한다. */
function _maskCell(v) {
  let s = String(v == null ? '' : v);
  if (!s) return '';
  if (/\d{3}[-.]?\d{3,4}[-.]?\d{4}/.test(s)) return '[전화번호]';
  if (/@/.test(s)) return '[이메일]';
  if (/\d{6}[-\s]?[1-4]\d{6}/.test(s)) return '[주민번호]';        // 이웃 칸까지 담게 됐으니 강화
  if (/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/.test(s)) return '[카드번호]';
  if (s.length > MAX_CELL_LEN) s = s.slice(0, MAX_CELL_LEN) + '…';
  return s;
}
/** 행 배열 마스킹. 배열이 아니거나 비면 빈 배열. */
function _maskRow(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_COLS).map(_maskCell);
}

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
    // [2026-09-10] 선택 셀 하나만 담으면 검증 앵커를 만들 수 없다.
    //   앵커 = "독립된 두 경로가 같은 값을 지목하는가"(예: 공급가액 ÷ 수량 == 단가 ÷ 1.1).
    //   그런데 기존 캡처는 현재 셀의 값/수식만 저장해서 비교 상대(같은 행의 수량·단가 칸)가
    //   없었고, 그 탓에 강명훈·사장님·조현욱 영역이 전부 "정량 검증 불가"로 막혀 있었다.
    //   → 같은 행(rowValues)과 머리글 행(headerValues)을 함께 담는다.
    // 성능: 셀마다 COM 호출하면 엑셀이 느려지므로 Range 한 번으로 2차원 배열을 받아 인덱싱한다.
    // 수집량: 열 상한 MAX_COLS 로 제한(발주/판매입력 양식이 22열이라 30이면 충분).
    const ps = `try { $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application'); if ($xl) { $wb = $xl.ActiveWorkbook; $ws = $xl.ActiveSheet; $sel = $xl.Selection; $wbn = ''; if($wb){$wbn=$wb.Name}; $wsn = ''; if($ws){$wsn=$ws.Name}; $caddr = ''; if($sel){$caddr=$sel.Address($false,$false)}; $cval = ''; if($sel -and $sel.Count -eq 1 -and $sel.Value2){$cval=[string]$sel.Value2}; $cfor = ''; if($sel -and $sel.Count -eq 1 -and $sel.HasFormula){$cfor=$sel.Formula}; $sc = 0; if($wb){$sc=$wb.Sheets.Count}; $rc = 0; if($ws){$rc=$ws.UsedRange.Rows.Count}; $rowNo = 0; $rowv = @(); $hdrv = @(); if($ws -and $sel -and $sel.Count -eq 1){ try { $rowNo = $sel.Row; $maxc = ${MAX_COLS}; $uc = $ws.UsedRange.Columns.Count; if($uc -gt 0 -and $uc -lt $maxc){ $maxc = $uc }; if($maxc -ge 1){ $rr = $ws.Range($ws.Cells($rowNo,1), $ws.Cells($rowNo,$maxc)).Value2; $hr = $ws.Range($ws.Cells(1,1), $ws.Cells(1,$maxc)).Value2; if($maxc -eq 1){ $rowv = @([string]$rr); $hdrv = @([string]$hr) } else { for($c=1; $c -le $maxc; $c++){ $a = $rr[1,$c]; if($a -eq $null){$a=''}; $rowv += [string]$a; $b = $hr[1,$c]; if($b -eq $null){$b=''}; $hdrv += [string]$b } } } } catch { $rowv = @(); $hdrv = @() } }; $info = @{workbook=$wbn;sheet=$wsn;cell=$caddr;value=$cval;formula=$cfor;sheetCount=$sc;rowCount=$rc;row=$rowNo;rowValues=$rowv;headerValues=$hdrv}; $info | ConvertTo-Json -Compress } else { Write-Output '{}' } } catch { Write-Output '{}' }`;

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
      if (data.value) data.value = _maskCell(data.value);
      // [2026-09-10] 행/머리글도 같은 기준으로 마스킹한다.
      // 이웃 칸을 담기 시작했으므로 마스킹을 여기에도 반드시 적용해야 개인정보가 새지 않는다.
      const rowValues = _maskRow(data.rowValues);
      const headerValues = _maskRow(data.headerValues);

      _callback({
        type: 'excel.activity',
        workbook: data.workbook,
        sheet: data.sheet,
        cell: data.cell,
        value: data.value || '',
        formula: data.formula || '',
        sheetCount: data.sheetCount || 0,
        rowCount: data.rowCount || 0,
        // 앵커 검증용 문맥: 현재 셀이 속한 행 전체 + 머리글 행.
        // 이 둘이 있어야 "수량×단가==공급가액" 같은 산술 앵커를 서버에서 재계산해 검증할 수 있다.
        row: data.row || 0,
        rowValues,
        headerValues,
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
