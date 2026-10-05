'use strict';
// excel-cell-context.js — 엑셀 화면의 "어디에 넣었나"(활성 시트·셀 주소·수식줄 값)를 가볍게 읽는다.
// 방식: Windows UI Automation(.NET 접근성 트리)으로 이름상자/수식입력줄/선택된 시트탭만 읽음.
//   - 엑셀 COM 자동화(Excel.Application) 사용 안 함. 엑셀 문서·프로세스를 건드리지 않는 읽기 전용.
//   - 비동기 1회 실행, 5초 타임아웃, 10초 스로틀. 실패하면 null(조용히 생략).
//   - 수식줄 값은 120자로 잘라 저장(키 입력 원문 대량 저장 금지).
const { execFile } = require('child_process');

const PS = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
  '$A=[System.Windows.Automation.AutomationElement]; $CT=[System.Windows.Automation.ControlType]',
  '$wk=[System.Windows.Automation.TreeWalker]::ControlViewWalker',
  '$e=$A::FocusedElement; $win=$null; $n=0',
  "while($e -ne $null -and $n -lt 60){ if($e.Current.ClassName -eq 'XLMAIN'){ $win=$e; break }; $e=$wk.GetParent($e); $n++ }",
  'if(-not $win){ exit 0 }',
  '$o=[ordered]@{}',
  '$sc=[System.Windows.Automation.TreeScope]::Descendants',
  '$ed=$win.FindAll($sc,[System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty,$CT::Edit))',
  'foreach($x in $ed){ $nm=$x.Current.Name; $p=$null',
  '  if(-not $x.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$p)){ continue }',
  "  if($nm -match 'Name Box|이름 상자'){ $o.cell=$p.Current.Value }",
  "  elseif($nm -match 'Formula Bar|수식 입력줄'){ $o.formula=$p.Current.Value } }",
  '$tb=$win.FindAll($sc,[System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty,$CT::TabItem))',
  'foreach($t in $tb){ $p=$null',
  '  if($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p) -and $p.Current.IsSelected){',
  "    $pn=''; try{ $pn=$wk.GetParent($t).Current.Name }catch{}",
  "    if($pn -match 'Sheet|시트'){ $o.sheet=$t.Current.Name } } }",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$o | ConvertTo-Json -Compress',
].join('\n');
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');

let _busy = false, _lastAt = 0, _last = null;

function _clean(s, max) {
  if (typeof s !== 'string') return undefined;
  const v = s.replace(/[\r\n\t]+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
}

// 창제목 파싱 — "매출현황.xlsx - Excel" → { workbook: '매출현황.xlsx' } (UIA 실패해도 파일명은 남김)
function parseExcelTitle(title) {
  const t = String(title || '');
  const m = t.match(/^(.*?\.(?:xlsx|xlsm|xlsb|xls|csv))\b/i) || t.match(/^(.+?)\s+-\s+(?:Microsoft\s+)?Excel\b/i);
  return m ? { workbook: _clean(m[1].replace(/\s*\[[^\]]*\]\s*$/, ''), 160) } : null;
}

function isExcel(app, title) {
  return /excel/i.test(String(app || '')) || /\s-\s(?:Microsoft\s+)?Excel\b/i.test(String(title || ''));
}

// cb(result|null). 결과: { workbook?, sheet?, cell?, formula? }
function probe(title, cb) {
  const base = parseExcelTitle(title);
  const done = (r) => { try { cb(r && Object.keys(r).length ? r : null); } catch {} };
  if (process.platform !== 'win32') return done(base);
  const now = Date.now();
  if (_busy || now - _lastAt < 10000) return done(_last && now - _lastAt < 10000 ? { ...base, ..._last } : base);
  _busy = true; _lastAt = now;
  try {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
        _busy = false;
        let r = null;
        if (!err) { try { const j = JSON.parse(String(stdout || '').trim() || 'null'); if (j) r = { sheet: _clean(j.sheet, 60), cell: _clean(j.cell, 40), formula: _clean(j.formula, 120) }; } catch {} }
        if (r) Object.keys(r).forEach((k) => r[k] === undefined && delete r[k]);
        _last = r;
        done({ ...base, ...(r || {}) });
      });
  } catch { _busy = false; done(base); }
}

module.exports = { probe, parseExcelTitle, isExcel };
