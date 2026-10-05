'use strict';
// boot-diag 단위 테스트 — 네트워크/실파일(.orbit) 없이 temp 디렉터리로 격리.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const boot = require('../../src/boot-diag');

let TMP;
beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bootdiag-'));
  boot._setOrbitDir(TMP);
});
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const P = () => boot._paths;

test('beginRun: 이전 런 boot-stage.log를 .prev로 보존하고 새 로그를 연다', () => {
  // 이전 런 흔적
  fs.writeFileSync(P().BOOT_STAGE_LOG, '2026-10-05T00:00:00.000Z keyboard-watcher(uiohook)\n', 'utf8');
  boot.beginRun();
  // .prev 에 이전 런 보존
  const prev = fs.readFileSync(P().BOOT_STAGE_PREV, 'utf8');
  expect(prev).toContain('keyboard-watcher(uiohook)');
  // 새 로그엔 process-start 만
  const cur = fs.readFileSync(P().BOOT_STAGE_LOG, 'utf8').trim().split('\n');
  expect(cur.length).toBe(1);
  expect(cur[0]).toMatch(/ process-start$/);
});

test('boot-stage ordering: 마지막 줄 = 마지막으로 진입한 단계(죽은 모듈)', () => {
  boot.beginRun();
  boot.stage('crash-reporter');
  boot.stage('daemon-updater');
  boot.stage('keyboard-watcher(uiohook)');
  const lines = fs.readFileSync(P().BOOT_STAGE_LOG, 'utf8').trim().split('\n');
  const names = lines.map(l => l.split(' ').slice(1).join(' '));
  expect(names).toEqual(['process-start', 'crash-reporter', 'daemon-updater', 'keyboard-watcher(uiohook)']);
  // 타임스탬프가 각 줄 앞에 (동기 flush 순서 보존)
  expect(lines[lines.length - 1]).toMatch(/keyboard-watcher\(uiohook\)$/);
});

test('_tailFile: 마지막 N줄만 반환', () => {
  const f = path.join(TMP, 't.log');
  fs.writeFileSync(f, Array.from({ length: 500 }, (_, i) => 'line' + i).join('\n') + '\n');
  const tail = boot._tailFile(f, 10);
  const got = tail.trim().split('\n');
  expect(got[got.length - 1]).toBe('line499');
  expect(got.length).toBeLessThanOrEqual(10);
});

test('flushOnBoot: 데이터 있으면 업로드하고 성공 시 crash-moment만 비운다', async () => {
  // 수퍼바이저가 남긴 세 파일 모사
  fs.writeFileSync(P().CRASH_MOMENT, '[exit] code=3221225477 ts=2026-10-05T07:23:00Z ranMs=9000 lastStage=keyboard-watcher(uiohook)\n', 'utf8');
  fs.writeFileSync(P().BOOT_STAGE_PREV, '...\nkeyboard-watcher(uiohook)\n', 'utf8');
  fs.writeFileSync(P().WORKER_STDERR, 'native abort\n', 'utf8');

  let sent = null;
  const postFn = (ev) => { sent = ev; return Promise.resolve(true); };
  const r = await boot.flushOnBoot(postFn);

  expect(r).toEqual({ uploaded: true, hadData: true });
  // 이벤트 형태 검증
  expect(sent.type).toBe('daemon.crashmoment');
  expect(sent.data.crashMoment).toContain('code=3221225477');
  expect(sent.data.bootStagePrev).toContain('keyboard-watcher(uiohook)');
  expect(sent.data.workerStderr).toContain('native abort');
  // crash-moment 는 비워지고, prev/stderr 는 보존(다음 종료에 덮어씀/오프라인 보존)
  expect(fs.readFileSync(P().CRASH_MOMENT, 'utf8')).toBe('');
  expect(fs.readFileSync(P().BOOT_STAGE_PREV, 'utf8')).not.toBe('');
  expect(fs.readFileSync(P().WORKER_STDERR, 'utf8')).not.toBe('');
});

test('flushOnBoot: 업로드 실패 시 crash-moment를 비우지 않는다(재시도 보존)', async () => {
  fs.writeFileSync(P().CRASH_MOMENT, '[exit] code=1 ts=x ranMs=5 lastStage=screen-capture\n', 'utf8');
  const r = await boot.flushOnBoot(() => Promise.resolve(false));
  expect(r).toEqual({ uploaded: false, hadData: true });
  expect(fs.readFileSync(P().CRASH_MOMENT, 'utf8')).toContain('code=1');
});

test('flushOnBoot: 데이터 없으면 post를 호출하지 않고 no-op', async () => {
  let called = false;
  const r = await boot.flushOnBoot(() => { called = true; return Promise.resolve(true); });
  expect(called).toBe(false);
  expect(r).toEqual({ uploaded: false, hadData: false });
});
