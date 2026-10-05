/**
 * file-skiplist.test.js
 * poison 파일 격리기: in-flight 마커가 "처리 중 네이티브 크래시"를 재시작 간에 기억해
 * MAX_ATTEMPTS 누적 후 영구 스킵하는지 검증. (crash-loop 차단 핵심 로직)
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// 실제 ~/.orbit 을 건드리지 않도록 임시 HOME 으로 격리
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skiplist-test-'));
const origHome = os.homedir;
os.homedir = () => TMP_HOME;

// os.homedir 패치 후에 모듈 로드 (경로가 로드시 고정됨)
function freshModule() {
  // 데몬 재시작 모사: 모듈 내부 _map 싱글톤을 완전히 새로 로드해야 in-flight 승격이 재실행된다.
  jest.resetModules();
  return require('../../src/file-skiplist.js');
}

afterAll(() => {
  os.homedir = origHome;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

const F = path.join(TMP_HOME, 'order_4003.xlsx');

describe('file-skiplist in-flight 격리', () => {
  beforeEach(() => {
    const p = path.join(TMP_HOME, '.orbit', 'file-skiplist.json');
    try { fs.unlinkSync(p); } catch {}
  });

  test('새 파일은 스킵되지 않고 beginFile 통과', () => {
    const sk = freshModule();
    expect(sk.isSkipped(F)).toBe(false);
    expect(sk.beginFile(F)).toBe(true);
  });

  test('정상 완료(endFileOk) 후 마커 제거 — 재시작해도 스킵 아님', () => {
    let sk = freshModule();
    sk.beginFile(F);
    sk.endFileOk(F);
    sk = freshModule(); // 재시작 모사
    expect(sk.isSkipped(F)).toBe(false);
  });

  test('처리 중 네이티브 크래시(마커 잔존)가 MAX_ATTEMPTS회 누적되면 영구 스킵', () => {
    // 1회차: beginFile 후 endFile* 호출 없이 "크래시"(프로세스 종료) 모사
    let sk = freshModule();
    sk.beginFile(F);
    // 재시작: 로드 시 in-flight 감지 → attempts=1
    sk = freshModule();
    sk.beginFile(F); // 2회차 시도 (아직 영구 스킵 아님)
    expect(sk.isSkipped(F)).toBe(false);
    // 2회차도 크래시 → 재시작 로드 시 attempts=2 >= MAX(2) → 영구 스킵
    sk = freshModule();
    expect(sk.isSkipped(F)).toBe(true);
    expect(sk.beginFile(F)).toBe(false); // 영구 스킵이면 처리 거부
  });

  test('endFileErr(JS에서 잡힌 실패)는 영구 스킵으로 누적되지 않음', () => {
    let sk = freshModule();
    for (let i = 0; i < 5; i++) {
      sk.beginFile(F);
      sk.endFileErr(F);     // JS 레벨 실패 — 네이티브 크래시 아님
      sk = freshModule();   // 재시작 모사: in-flight 없음 → attempts 증가 없음
    }
    expect(sk.isSkipped(F)).toBe(false);
  });
});
