/**
 * click-rect.test.js
 * 좌표 변환 순수함수(parseRelOutput / toClientPoint) 단위테스트.
 * PowerShell/Win32 없이 검증 가능하도록 PS 출력 문자열을 고정 입력으로 사용.
 */

const { parseRelOutput, toClientPoint, buildPs, isEnabled } = require('../../src/click-rect.js');

const TAB = '\t';
// 필드 순서: winX winY winW winH cliX cliY dpi isNenova mdiCliX mdiCliY mdiCaption ctlClass ctlText
function line(fields) { return fields.join(TAB); }

describe('parseRelOutput', () => {
  test('일반 창(nenova 아님): 창 rect/클라이언트/DPI만, MDI·컨트롤 일부', () => {
    const out = line(['100', '50', '1280', '720', '108', '81', '144', '0', '', '', '', 'Edit', '홍길동']);
    const rel = parseRelOutput(out);
    expect(rel).toEqual({
      winX: 100, winY: 50, winW: 1280, winH: 720,
      cliX: 108, cliY: 81, dpi: 144,
      ctlClass: 'Edit', ctlText: '홍길동',
    });
    expect(rel.mdiCliX).toBeUndefined();
    expect(rel.mdiCaption).toBeUndefined();
  });

  test('nenova MDI 자식: mdi 원점/캡션 포함', () => {
    const out = line(['0', '0', '1920', '1040', '8', '31', '96', '1', '18', '120', '주문관리', 'WindowsForms10.EDIT', '']);
    const rel = parseRelOutput(out);
    expect(rel.mdiCliX).toBe(18);
    expect(rel.mdiCliY).toBe(120);
    expect(rel.mdiCaption).toBe('주문관리');
    expect(rel.ctlClass).toBe('WindowsForms10.EDIT');
    expect(rel.ctlText).toBeUndefined(); // 빈 텍스트는 생략
    expect(rel.dpi).toBe(96);
  });

  test('dpi 0 은 생략', () => {
    const rel = parseRelOutput(line(['0', '0', '800', '600', '0', '0', '0', '0', '', '', '', '', '']));
    expect(rel.dpi).toBeUndefined();
    expect(rel.winW).toBe(800);
  });

  test('빈/짧은 출력은 null', () => {
    expect(parseRelOutput('')).toBeNull();
    expect(parseRelOutput(null)).toBeNull();
    expect(parseRelOutput(line(['1', '2', '3']))).toBeNull();
  });

  test('모든 필드 빈 값이면 null', () => {
    expect(parseRelOutput(line(['', '', '', '', '', '', '', '', '', '', '', '', '']))).toBeNull();
  });
});

describe('toClientPoint', () => {
  test('MDI 원점 기준 우선 + DPI 144 → 논리좌표 환산', () => {
    const rel = { cliX: 8, cliY: 31, dpi: 144, mdiCliX: 108, mdiCliY: 231 };
    const r = toClientPoint({ x: 300, y: 519 }, rel);
    expect(r.basis).toBe('mdi');
    expect(r.cliX).toBe(192);  // 300 - 108
    expect(r.cliY).toBe(288);  // 519 - 231
    // scale = 144/96 = 1.5
    expect(r.logX).toBe(128);  // 192 / 1.5
    expect(r.logY).toBe(192);  // 288 / 1.5
  });

  test('MDI 없으면 전경 창 클라이언트 원점 기준', () => {
    const rel = { cliX: 10, cliY: 40, dpi: 96 };
    const r = toClientPoint({ x: 110, y: 140 }, rel);
    expect(r.basis).toBe('client');
    expect(r.cliX).toBe(100);
    expect(r.cliY).toBe(100);
    expect(r.logX).toBe(100); // 96dpi → scale 1
  });

  test('dpi 없으면 scale 1', () => {
    const r = toClientPoint({ x: 50, y: 60 }, { cliX: 0, cliY: 0 });
    expect(r.logX).toBe(50);
    expect(r.logY).toBe(60);
  });

  test('원점 정보 없으면 null', () => {
    expect(toClientPoint({ x: 1, y: 1 }, { dpi: 96 })).toBeNull();
    expect(toClientPoint(null, { cliX: 0, cliY: 0 })).toBeNull();
    expect(toClientPoint({ x: 1, y: 1 }, null)).toBeNull();
  });
});

describe('buildPs', () => {
  test('클릭 좌표를 PS 스크립트에 주입, user32 P/Invoke 사용, COM New-Object 없음', () => {
    const ps = buildPs(640, 480);
    expect(ps).toContain('$pt.x=640');
    expect(ps).toContain('$pt.y=480');
    expect(ps).toContain('GetForegroundWindow');
    expect(ps).toContain('GetDpiForWindow');
    expect(ps).toContain('MDIClient');
    // COM 자동화 객체 생성 금지 (New-Object -ComObject)
    expect(ps).not.toMatch(/New-Object\s+-ComObject/i);
  });

  test('비정상 좌표는 0 으로 정규화', () => {
    const ps = buildPs(undefined, NaN);
    expect(ps).toContain('$pt.x=0');
    expect(ps).toContain('$pt.y=0');
  });
});

describe('isEnabled', () => {
  const ORIG = process.env.ORBIT_CLICK_RECT;
  afterEach(() => { if (ORIG === undefined) delete process.env.ORBIT_CLICK_RECT; else process.env.ORBIT_CLICK_RECT = ORIG; });

  test('env=1 이면 true, env=0 이면 false', () => {
    process.env.ORBIT_CLICK_RECT = '1';
    expect(isEnabled()).toBe(true);
    process.env.ORBIT_CLICK_RECT = '0';
    expect(isEnabled()).toBe(false);
  });
});
