'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ORBIT_PRIVACY_NOIO = '1';

const sc = require('../../src/screen-capture');
const fcw = require('../../src/file-change-watcher');
const vw = require('../../bin/vision-worker');
const comp = require('../../src/completeness');

describe('work-data-inflow-boost (업무데이터 유입·수집 보강 회귀 테스트)', () => {
  test('screen-capture._spoolWorthUploading: 전환·폴백·업무카톡 트리거는 idle이어도 스풀 유지, startup/저품질/cooldown은 제외', () => {
    expect(sc._spoolWorthUploading('app_switch', 'idle')).toBe(true);
    expect(sc._spoolWorthUploading('title_change', 'idle')).toBe(true);
    expect(sc._spoolWorthUploading('fallback-appchange', 'idle')).toBe(true);
    expect(sc._spoolWorthUploading('fallback-timer', 'idle')).toBe(true);
    expect(sc._spoolWorthUploading('kakao_periodic', 'idle')).toBe(true);
    expect(sc._spoolWorthUploading('kakao_periodic', 'focused')).toBe(true);
    expect(sc._spoolWorthUploading('kakao_periodic', 'cooldown')).toBe(false);
    expect(sc._spoolWorthUploading('startup', 'idle')).toBe(false);
    expect(sc._spoolWorthUploading('low_quality_click_burst', 'focused')).toBe(false);
  });

  test('vision-worker._parseLocalCaptureName: 하이픈 포함 트리거(fallback-appchange/timer) 및 일반 트리거 파싱', () => {
    expect(vw._parseLocalCaptureName('screen-1795104756711-fallback-appchange-active.png')).toEqual({
      f: 'screen-1795104756711-fallback-appchange-active.png',
      epoch: 1795104756711,
      trigger: 'fallback-appchange',
      focus: 'active',
    });
    expect(vw._parseLocalCaptureName('screen-1795104756712-fallback-timer-idle.png')).toEqual({
      f: 'screen-1795104756712-fallback-timer-idle.png',
      epoch: 1795104756712,
      trigger: 'fallback-timer',
      focus: 'idle',
    });
    expect(vw._parseLocalCaptureName('screen-1795104756713-keyboard_flush-focused.png')).toEqual({
      f: 'screen-1795104756713-keyboard_flush-focused.png',
      epoch: 1795104756713,
      trigger: 'keyboard_flush',
      focus: 'focused',
    });
    expect(vw._parseLocalCaptureName('not-a-capture.png')).toBeNull();
  });

  test('file-change-watcher: 1단계 업무 하위폴더 포함 + 카톡받은파일/kakao files/숨김폴더 제외', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fcw-'));
    try {
      fs.mkdirSync(path.join(tmp, '주차별 매출이익 보고서'));
      fs.mkdirSync(path.join(tmp, '운임비 정산'));
      fs.mkdirSync(path.join(tmp, '카카오톡 받은 파일'));
      fs.mkdirSync(path.join(tmp, 'kakao files'));
      fs.mkdirSync(path.join(tmp, 'node_modules'));
      fs.mkdirSync(path.join(tmp, '.hidden'));
      const subs = fcw._collectSubdirs([tmp], 40).map(d => path.basename(d)).sort();
      expect(subs).toEqual(['운임비 정산', '주차별 매출이익 보고서']);
      expect(fcw._isSkippedSubdir('kakao files')).toBe(true);
      expect(fcw._isSkippedSubdir('카카오톡 받은 파일')).toBe(true);
      expect(fcw._isSkippedSubdir('주차별 매출이익 보고서')).toBe(false);
      expect(fcw._DOC_EXT.test('46차_원가.xlsx')).toBe(true);
      expect(fcw._DOC_EXT.test('invoice.pdf')).toBe(true);
      expect(fcw._DOC_EXT.test('photo.png')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('completeness.buildReport: 09:00 KST 출근 전(07:00 KST)에는 오늘 expected=0, status=none으로 전원 pc-off 오탐 방지', () => {
    // 2026-11-20 07:00 KST = 2026-11-19T22:00:00Z (금요일)
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-19T22:00:00Z'));
    try {
      const byDay = {};
      const today = '2026-11-20';
      for (let w = 1; w <= 4; w++) {
        for (let i = 0; i < 7; i++) {
          const d = new Date(Date.parse(today + 'T00:00:00Z') - (w * 7 + i) * 864e5).toISOString().slice(0, 10);
          byDay[d] = { capture: 300, analyzed: 150, keyboard: 100, mouse: 100, heartbeat: 500 };
        }
      }
      for (let i = 1; i < 7; i++) {
        const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10);
        byDay[d] = { capture: 300, analyzed: 150, keyboard: 100, mouse: 100, heartbeat: 500 };
      }
      // 07:00 KST — 아직 출근 전이라 오늘 캡처 0
      const rep = comp.buildReport({
        byUser: { 설연주: byDay },
        lastHb: { 설연주: { at: '2026-11-19T09:00:00Z', hostname: 'NEONVA', userId: 'U1' } },
        liveKeys: [],
        names: { U1: '설연주' },
        uids: { 설연주: ['U1'] },
      }, 7);
      const e = rep.employees.find(x => x.name === '설연주');
      const t = e.days.find(d => d.date === today);
      expect(t.expected).toBe(0);
      expect(t.status).toBe('none');
      expect(t.cause).toBeNull();
      expect(e.overallPct).toBe(100);
      expect(e.lostDays).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('personal-agent.js 부팅·시간별 복구는 중복 /api/hook 대신 uploadPendingToSpool 사용', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../daemon/personal-agent.js'), 'utf8');
    expect(src).toContain('screenCapture?.uploadPendingToSpool?.(45)');
    expect(src).not.toContain('screenCapture?.uploadPendingToServer?.(20)');
  });

  test('completeness.aggregate: daily 이력이 7일+ 있으면 events 스캔을 48h로 축소 + 동시요청 single-flight 공유', async () => {
    jest.resetModules();
    const freshComp = require('../../src/completeness');
    const calls = [];
    const warmRows = Array.from({ length: 10 }, (_, i) => ({
      name: '설연주',
      kst_date: `2026-11-${String(10 + i).padStart(2, '0')}`,
      capture: 300, analyzed: 150, keyboard: 100, mouse: 100, heartbeat: 500,
    }));
    const mockPool = {
      query: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('FROM orbit_completeness_daily')) return { rows: warmRows };
        if (sql.includes('FROM events')) {
          await new Promise(r => setTimeout(r, 20));
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const [r1, r2] = await Promise.all([freshComp.aggregate(mockPool), freshComp.aggregate(mockPool)]);
    expect(r1).toBe(r2); // single-flight 공유
    const evCall = calls.find(c => c.sql.includes('GROUP BY 1, 2, 3'));
    expect(evCall).toBeTruthy();
    const spanMs = Date.now() - Date.parse(evCall.params[1]);
    expect(spanMs).toBeLessThan(3 * 864e5); // 35일이 아니라 2일(48h) 증분 스캔
  });
});
