/**
 * click-rect — 클릭 지점의 전경 창 rect / 클라이언트 원점 / DPI (+ nenova.exe MDI 자식·
 *              클릭 컨트롤) 을 수집해 클릭 객체에 rel 로 붙인다.
 *
 * 목적: 직원 PC nenova.exe(화훼 관리 프로그램, .NET WinForms MDI) 의 화면 클릭 좌표를
 *       사장님 PC 디컴파일 버튼 지도(폼 클라이언트 좌표)에 겹치기 위한 기준값 확보.
 *
 * 설계 원칙:
 * - 새 네이티브 의존성 없음. 기존 src/win-shell.js(상주 PowerShell 1개, windowsHide)
 *   의 exec() 만 재사용. 클릭마다 프로세스 띄우지 않음.
 * - COM New-Object 금지(user32 P/Invoke 만). 다른 앱 실행·포커스 변경 없음(읽기만).
 * - 기능 플래그 clickRect(기본 false): env ORBIT_CLICK_RECT 또는
 *   ~/.orbit/capture-config.json 의 top-level clickRect.
 * - 좌표 변환은 순수함수(parseRelOutput / toClientPoint)로 분리 → 단위테스트.
 * - 실패·비활성 시 조용히 null (caller 는 기존 수집을 그대로 유지).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAB = '\t';
const CAPTURE_CONFIG_PATH = path.join(os.homedir(), '.orbit', 'capture-config.json');

// ── 기능 플래그 (env + capture-config, 5초 캐시) ─────────────────────────────
let _flagCache = null;
let _flagAt = 0;
function isEnabled() {
  const env = process.env.ORBIT_CLICK_RECT;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  const now = Date.now();
  if (now - _flagAt < 5000) return _flagCache === true;
  _flagAt = now;
  try {
    const cfg = JSON.parse(fs.readFileSync(CAPTURE_CONFIG_PATH, 'utf8'));
    _flagCache = cfg && cfg.clickRect === true;
  } catch { _flagCache = false; }
  return _flagCache === true;
}

// ── PowerShell: 전경 창 + 클릭 지점 컨트롤/MDI 조사 (user32 P/Invoke) ─────────
// 출력: tab 구분 13필드 고정 순서
//   winX winY winW winH cliX cliY dpi isNenova mdiCliX mdiCliY mdiCaption ctlClass ctlText
// 조사 실패/미해당 필드는 빈 문자열.
function buildPs(x, y) {
  const px = Math.round(Number(x) || 0);
  const py = Math.round(Number(y) || 0);
  return (
    "if (-not ('OrbitClickRect' -as [type])) { Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;" +
    "public static class OrbitClickRect{" +
    "[StructLayout(LayoutKind.Sequential)]public struct R{public int l;public int t;public int r;public int b;}" +
    "[StructLayout(LayoutKind.Sequential)]public struct P{public int x;public int y;}" +
    "[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();" +
    "[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);" +
    "[DllImport(\"user32.dll\")]public static extern bool ClientToScreen(IntPtr h,ref P p);" +
    "[DllImport(\"user32.dll\")]public static extern IntPtr WindowFromPoint(P p);" +
    "[DllImport(\"user32.dll\")]public static extern IntPtr GetParent(IntPtr h);" +
    "[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder s,int n);" +
    "[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);" +
    "[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);" +
    "[DllImport(\"user32.dll\")]public static extern uint GetDpiForWindow(IntPtr h);" +
    "public static string Cls(IntPtr h){var b=new StringBuilder(256);GetClassName(h,b,256);return b.ToString();}" +
    "public static string Txt(IntPtr h){var b=new StringBuilder(512);GetWindowText(h,b,512);return b.ToString();}" +
    "}' }" +
    "; $pt=New-Object OrbitClickRect+P; $pt.x=" + px + "; $pt.y=" + py + ";" +
    " $h=[OrbitClickRect]::GetForegroundWindow();" +
    " $r=New-Object OrbitClickRect+R; [void][OrbitClickRect]::GetWindowRect($h,[ref]$r);" +
    " $co=New-Object OrbitClickRect+P; [void][OrbitClickRect]::ClientToScreen($h,[ref]$co);" +
    " $dpi=0; try { $dpi=[OrbitClickRect]::GetDpiForWindow($h) } catch {}" +
    " [uint32]$fp=0; [void][OrbitClickRect]::GetWindowThreadProcessId($h,[ref]$fp);" +
    " $pn=''; try { $pn=(Get-Process -Id $fp -ErrorAction Stop).ProcessName } catch {}" +
    " $isN = ($pn -ieq 'nenova'); $mcx=''; $mcy=''; $mcap=''; $cls=''; $ctxt='';" +
    " $cw=[OrbitClickRect]::WindowFromPoint($pt);" +
    " if ($cw -ne [IntPtr]::Zero) { $cls=[OrbitClickRect]::Cls($cw); $ctxt=[OrbitClickRect]::Txt($cw) }" +
    " if ($isN -and $cw -ne [IntPtr]::Zero) {" +
    "   $node=$cw; $mdi=[IntPtr]::Zero;" +
    "   for ($i=0; $i -lt 30; $i++) { $par=[OrbitClickRect]::GetParent($node); if ($par -eq [IntPtr]::Zero) { break }; if ([OrbitClickRect]::Cls($par) -eq 'MDIClient') { $mdi=$node; break }; $node=$par }" +
    "   if ($mdi -ne [IntPtr]::Zero) { $mco=New-Object OrbitClickRect+P; [void][OrbitClickRect]::ClientToScreen($mdi,[ref]$mco); $mcx=$mco.x; $mcy=$mco.y; $mcap=[OrbitClickRect]::Txt($mdi) }" +
    " }" +
    " $f = @($r.l,$r.t,($r.r-$r.l),($r.b-$r.t),$co.x,$co.y,$dpi,([int]$isN),$mcx,$mcy,$mcap,$cls,$ctxt);" +
    " ($f | ForEach-Object { ([string]$_) -replace '[\\t\\r\\n]',' ' }) -join [char]9"
  );
}

// ── 순수함수: PS tab 출력 → rel 객체 (얻지 못한 값은 생략) ───────────────────
function _numOr(v, undef) {
  if (v === undefined || v === null || v === '') return undef;
  const n = Number(v);
  return Number.isFinite(n) ? n : undef;
}

/**
 * @param {string} out  buildPs 결과 tab 출력
 * @returns {object|null} rel { winX,winY,winW,winH,cliX,cliY,dpi,mdiCaption,mdiCliX,mdiCliY,ctlClass,ctlText }
 */
function parseRelOutput(out) {
  if (!out) return null;
  const p = String(out).split(TAB);
  if (p.length < 7) return null;
  const rel = {};
  const winX = _numOr(p[0]); const winY = _numOr(p[1]);
  const winW = _numOr(p[2]); const winH = _numOr(p[3]);
  const cliX = _numOr(p[4]); const cliY = _numOr(p[5]);
  const dpi = _numOr(p[6]);
  if (winX !== undefined) rel.winX = winX;
  if (winY !== undefined) rel.winY = winY;
  if (winW !== undefined) rel.winW = winW;
  if (winH !== undefined) rel.winH = winH;
  if (cliX !== undefined) rel.cliX = cliX;
  if (cliY !== undefined) rel.cliY = cliY;
  if (dpi !== undefined && dpi > 0) rel.dpi = dpi;
  // nenova MDI
  const mdiCliX = _numOr(p[8]); const mdiCliY = _numOr(p[9]);
  const mdiCaption = (p[10] || '').trim();
  if (mdiCliX !== undefined) rel.mdiCliX = mdiCliX;
  if (mdiCliY !== undefined) rel.mdiCliY = mdiCliY;
  if (mdiCaption) rel.mdiCaption = mdiCaption;
  // 클릭 컨트롤
  const ctlClass = (p[11] || '').trim();
  const ctlText = (p[12] || '').trim();
  if (ctlClass) rel.ctlClass = ctlClass;
  if (ctlText) rel.ctlText = ctlText;
  return Object.keys(rel).length ? rel : null;
}

/**
 * 순수함수: 클릭(스크린px) → 폼 클라이언트 논리좌표.
 * MDI 자식이 있으면 그 원점, 없으면 전경 창 클라이언트 원점 기준.
 * DPI 배율(dpi/96)로 논리px 환산 → 사장님 PC 디컴파일 좌표(96dpi 기준)에 정렬.
 * @param {{x:number,y:number}} click  스크린 px
 * @param {object} rel  parseRelOutput 결과
 * @returns {{cliX:number,cliY:number,logX:number,logY:number,basis:string}|null}
 */
function toClientPoint(click, rel) {
  if (!click || !rel) return null;
  let ox, oy, basis;
  if (rel.mdiCliX !== undefined && rel.mdiCliY !== undefined) {
    ox = rel.mdiCliX; oy = rel.mdiCliY; basis = 'mdi';
  } else if (rel.cliX !== undefined && rel.cliY !== undefined) {
    ox = rel.cliX; oy = rel.cliY; basis = 'client';
  } else {
    return null;
  }
  const px = click.x - ox;
  const py = click.y - oy;
  const scale = rel.dpi && rel.dpi > 0 ? rel.dpi / 96 : 1;
  return {
    cliX: px,
    cliY: py,
    logX: Math.round((px / scale) * 100) / 100,
    logY: Math.round((py / scale) * 100) / 100,
    basis,
  };
}

// ── 비동기 조회 (win-shell 재사용, in-flight 가드 + 1초 창-레벨 캐시) ─────────
let _ws = null;
let _wsTried = false;
function _winShell() {
  if (_wsTried) return _ws;
  _wsTried = true;
  try { _ws = require('./win-shell'); } catch { _ws = null; }
  return _ws;
}

let _inFlight = false;
let _lastQueryAt = 0;
const MIN_INTERVAL_MS = 150; // win-shell 큐 폭주 방지(사람 클릭 속도엔 충분)

/**
 * 클릭 지점 rel 을 비동기 조회해 콜백에 전달. 조회 못하면 콜백 미호출(조용히 포기).
 * 실패해도 throw 하지 않음 → caller 의 기존 수집에 무영향.
 */
function queryRel(x, y, cb) {
  if (process.platform !== 'win32') return;
  const ws = _winShell();
  if (!ws || !ws.isAvailable || !ws.isAvailable()) return;
  const now = Date.now();
  if (_inFlight) return;                       // 이미 조회 중이면 이 클릭은 생략
  if (now - _lastQueryAt < MIN_INTERVAL_MS) return;
  _inFlight = true;
  _lastQueryAt = now;
  Promise.resolve(ws.exec(buildPs(x, y), 4000))
    .then((out) => {
      const rel = parseRelOutput(out);
      if (rel) { try { cb(rel); } catch {} }
    })
    .catch(() => {})
    .then(() => { _inFlight = false; });
}

module.exports = {
  isEnabled,
  buildPs,
  parseRelOutput,
  toClientPoint,
  queryRel,
  CAPTURE_CONFIG_PATH,
};
