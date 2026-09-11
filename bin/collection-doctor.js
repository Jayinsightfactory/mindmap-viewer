#!/usr/bin/env node
/**
 * collection-doctor.js — 수집 건강검진 (읽기 전용)
 *
 * 왜 만들었나:
 *   2026-09-10~11 점검에서 수집 결함 3건(박성수 화면라벨 파편화, 김빛나 키보드 후킹 차단,
 *   조현욱 PC 계정 분열)을 찾았는데, 전부 사람이 SQL을 손으로 뒤져서 찾았다.
 *   시스템은 아무것도 몰랐고 아무 말도 하지 않았다.
 *   고객사에 파는 솔루션이라면 이럴 수 없다 — 망가지면 시스템이 먼저 말해야 한다.
 *   그날 찾아낸 판별식을 그대로 규칙으로 굳힌 것이 이 파일이다.
 *
 * 원칙:
 *   - 읽기 전용(SELECT만). 아무것도 고치지 않는다.
 *   - "이벤트 수가 적다"로 경고하지 않는다. 적은 건 업무량 차이일 수 있다.
 *     반드시 "이 조합이면 고장"이라는 판별식으로만 판정한다(오탐이 신뢰를 깎는다).
 *   - 사람이 읽는 문장으로 출력한다. 조치까지 적는다.
 *
 * 사용:
 *   node bin/collection-doctor.js [--days 14] [--json] [--quiet]
 *   종료코드: 0=정상/정보만, 1=주의 있음, 2=치명 있음 (모니터링 연동용)
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DAYS = parseInt(argv('--days', '14'), 10);
const AS_JSON = args.includes('--json');
const QUIET = args.includes('--quiet');

// DB 연결: 서버와 같은 환경변수 우선, 없으면 로컬 진단용 파일
function _conn() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.DATABASE_PUBLIC_URL) return process.env.DATABASE_PUBLIC_URL;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(process.env.TEMP || '/tmp', 'pgvars.json'), 'utf8'));
    return v.DATABASE_PUBLIC_URL || v.DATABASE_URL;
  } catch { return null; }
}
const CONN = _conn();
if (!CONN) { console.error('DB 연결 정보 없음 (DATABASE_URL 또는 DATABASE_PUBLIC_URL)'); process.exit(3); }
const { Client } = require('pg');

// ── 심각도 ──────────────────────────────────────────────────────────────────
const CRIT = '치명', WARN = '주의', INFO = '정보';
const findings = [];
function add(sev, who, title, evidence, action, scope) {
  findings.push({ sev, who, title, evidence, action, scope: scope || 'person' });
}

// ── 검사 규칙 ───────────────────────────────────────────────────────────────
// 각 규칙은 2026-09-10~11 실측에서 도출된 판별식이다. 주석에 그 근거를 남긴다.

async function checkPerPerson(c) {
  // 사람별 수집 지표를 한 번에 모은다.
  const { rows } = await c.query(`
    SELECT u.name,
      COUNT(*) FILTER (WHERE e.type='keyboard.chunk')  kb,
      COUNT(*) FILTER (WHERE e.type='mouse.chunk')     mouse,
      COUNT(*) FILTER (WHERE e.type='screen.capture')  cap,
      COUNT(*) FILTER (WHERE e.type='screen.analyzed') ana,
      COUNT(DISTINCT e.data_json->>'trigger') FILTER (WHERE e.type='screen.capture') trig,
      COUNT(DISTINCT e.data_json->>'screen')  FILTER (WHERE e.type='screen.analyzed') scr_uniq,
      MAX(e.timestamp::timestamptz) last_seen
    FROM events e JOIN orbit_auth_users u ON u.id = e.user_id
    WHERE e.timestamp::timestamptz > NOW() - ($1 || ' days')::interval
      AND e.type IN ('keyboard.chunk','mouse.chunk','screen.capture','screen.analyzed')
    GROUP BY u.name`, [String(DAYS)]);

  for (const r of rows) {
    const kb = +r.kb, mouse = +r.mouse, cap = +r.cap, ana = +r.ana;
    const trig = +r.trig, uniq = +r.scr_uniq;
    if (kb + mouse + cap === 0) continue;   // 이 기간 활동 없음 — 고장이 아니라 부재

    // [규칙1] 키보드 후킹 차단 — 실측: 김빛나 kb=0, mouse=3,638
    // 마우스가 충분히 들어오는데 키보드만 0이면 사람이 안 친 게 아니라 후킹이 막힌 것이다.
    // (보안SW 안티키로거가 키보드만 차단하고 마우스는 통과시킨다)
    if (kb === 0 && mouse >= 500) {
      add(CRIT, r.name, '키보드 입력이 하나도 안 들어옵니다',
        `키보드 0건인데 마우스는 ${mouse.toLocaleString()}건 — 사람은 PC를 쓰고 있습니다`,
        '보안 프로그램(안티 키로거)이 키보드 후킹을 막는 경우입니다. 키 입력은 포기하더라도 창·앱 추적 폴백이 켜져야 합니다.');
    }

    // [규칙2] 캡처 트리거 단일 — 실측: 김빛나 151건 전부 trigger=startup
    // 정상 PC는 트리거가 6~10종. 1종뿐이면 업무 중 캡처가 한 번도 안 걸린 것이다.
    if (cap >= 20 && trig === 1) {
      add(CRIT, r.name, '업무 중 화면이 한 번도 안 찍힙니다',
        `캡처 ${cap}건이 모두 같은 트리거 한 종류 — 정상 PC는 6~10종`,
        '캡처 트리거가 죽었습니다. 부팅 직후 한 장만 남고 실제 업무 화면은 수집되지 않습니다.');
    }

    // [규칙4] 캡처는 되는데 해독 0 — 실측: hoon J cap=117, ana=0 (계정 분열 아티팩트)
    // 규칙3보다 먼저 본다. 원인을 특정하는 진단이 "원인 불명" 진단을 이겨야 한다.
    if (cap >= 30 && ana === 0) {
      add(WARN, r.name, '화면은 찍히는데 결과가 이 사람에게 안 붙습니다',
        `캡처 ${cap}건인데 해독 0건`,
        '한 PC에 계정이 여러 개 붙어 캡처는 갈리고 해독은 주 계정으로 몰리는 경우입니다. 계정 정리가 필요합니다.');
    }
    // [규칙3] 해독률 붕괴 — 실측: 김빛나 8.1%(정상 26~46%)
    // 규칙4가 이미 원인을 짚었으면 중복 경고하지 않는다(ana>0 조건).
    else if (cap >= 50 && ana > 0 && ana / cap < 0.15) {
      add(WARN, r.name, '찍은 화면을 거의 못 읽습니다',
        `해독 ${ana}/${cap}건 = ${(ana / cap * 100).toFixed(1)}% (정상 26~46%)`,
        '빈 화면이 찍히고 있거나 분석 워커가 이 PC 몫을 처리하지 못하고 있습니다.');
    }

    // [규칙5] 화면 이름 파편화 — 실측: 박성수 화면전이 896건 전부 frequency=1
    // 같은 화면이 매번 다른 이름으로 적히면 "무엇을 반복하는가"를 영영 알 수 없다.
    if (ana >= 50 && uniq / ana > 0.9) {
      add(WARN, r.name, '같은 화면이 매번 다른 이름으로 기록됩니다',
        `해독 ${ana}건에 화면 이름이 ${uniq}종 — 거의 전부가 새 이름`,
        '반복 패턴을 찾을 수 없습니다. 화면 이름을 통일하는 규칙이 필요합니다.');
    }

    // [규칙6] 수집 중단 — 최근 며칠간 아무것도 없음
    const quietDays = (Date.now() - new Date(r.last_seen).getTime()) / 86400000;
    if (quietDays >= 3) {
      add(WARN, r.name, '수집이 멈췄습니다',
        `마지막 수집이 ${quietDays.toFixed(1)}일 전`,
        'PC가 꺼져 있거나 데몬이 죽었습니다. 휴가/출장이면 정상입니다.');
    }
  }
}

async function checkHosts(c) {
  // [규칙7] 호스트명 대소문자 분열 — 실측: 같은 PC가 NEONVA/neonva/nenova 등 6키로 갈림.
  // 명령 큐가 정확일치라 잘못된 키에 넣으면 "소비는 되는데 실행 안 됨"으로 보인다(워커 좀비 오진의 원인).
  const { rows } = await c.query(`
    SELECT LOWER(hostname) k, COUNT(DISTINCT hostname) variants,
           STRING_AGG(DISTINCT hostname, ', ') names
    FROM orbit_daemon_commands GROUP BY 1 HAVING COUNT(DISTINCT hostname) > 1`);
  for (const r of rows) {
    add(WARN, r.names.split(',')[0].trim(), 'PC 이름이 여러 형태로 갈라져 있습니다',
      `같은 PC가 ${r.variants}가지 이름으로 기록됨: ${r.names}`,
      '원격 명령을 잘못된 이름으로 보내면 소비만 되고 실행되지 않습니다. 살아있는 이름을 확인하고 나머지는 정리해야 합니다.', 'host');
  }

  // [규칙8] 미소비 명령 적체 — 실측: NENOVA(대문자) 864건 방치.
  // 그 PC가 되살아나면 쌓인 명령이 한꺼번에 쏟아져 CPU가 튄다.
  const { rows: back } = await c.query(`
    SELECT hostname, COUNT(*) n, MIN(ts)::date oldest
    FROM orbit_daemon_commands WHERE consumed_at IS NULL
    GROUP BY 1 HAVING COUNT(*) >= 100 ORDER BY 2 DESC`);
  for (const r of back) {
    add(WARN, r.hostname, '보내둔 명령이 쌓여만 있습니다',
      `미처리 ${r.n}건, 가장 오래된 것이 ${r.oldest}`,
      '그 PC가 다시 켜지면 쌓인 명령이 한꺼번에 실행돼 컴퓨터가 버벅일 수 있습니다. 미리 정리하는 게 안전합니다.', 'host');
  }

  // [규칙9] 워커 침묵 — capture-config 실행 보고가 끊긴 PC.
  // 살아있는 PC는 이 보고가 주기적으로 올라온다. 없으면 명령을 받아도 실행하지 못하는 상태다.
  const { rows: mute } = await c.query(`
    WITH alive AS (
      SELECT DISTINCT data_json->>'hostname' h
      FROM events WHERE type='daemon.heartbeat'
        AND timestamp::timestamptz > NOW() - INTERVAL '1 day'
    ), exec AS (
      SELECT DISTINCT data_json->>'hostname' h
      FROM events WHERE data_json->>'status' = 'command_executed'
        AND timestamp::timestamptz > NOW() - INTERVAL '1 day'
    )
    SELECT a.h FROM alive a LEFT JOIN exec x ON LOWER(x.h)=LOWER(a.h) WHERE x.h IS NULL AND a.h IS NOT NULL`);
  for (const r of mute) {
    add(WARN, r.h, '켜져 있는데 명령을 실행하지 않습니다',
      '하루 동안 살아있다는 신호는 오는데 명령 실행 보고가 한 건도 없음',
      '원격으로 무엇을 시켜도 듣지 않는 상태입니다. 명령을 보내는 이름이 맞는지부터 확인해야 합니다.', 'host');
  }
}

async function checkPipeline(c) {
  // [규칙10] 엑셀 행 문맥 — 2026-09-10 추가된 rowValues가 실제로 들어오는지.
  // 이게 없으면 금액 검산(앵커)이 불가능하다.
  const { rows } = await c.query(`
    SELECT COUNT(*) n, COUNT(*) FILTER (WHERE data_json ? 'rowValues') withrow
    FROM events WHERE type='excel.activity'
      AND timestamp::timestamptz > NOW() - INTERVAL '2 days'`);
  const n = +rows[0].n, w = +rows[0].withrow;
  if (n >= 20 && w === 0) {
    add(INFO, '전체', '엑셀 옆칸 정보가 아직 안 들어옵니다',
      `최근 이틀 엑셀 기록 ${n}건 중 행 문맥 0건`,
      '각 PC가 새 코드를 받으면 들어오기 시작합니다. 며칠 지나도 0이면 배포가 안 된 것입니다.');
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
(async () => {
  const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await checkPerPerson(c);
    await checkHosts(c);
    await checkPipeline(c);
  } finally { await c.end(); }

  // [노이즈 억제] 같은 증상이 대부분에게 걸리면 그건 개인 문제가 아니라 시스템 문제다.
  // 사람마다 같은 경고를 반복하면 읽는 사람이 경고 자체를 무시하게 된다(제품에서는 치명적).
  // 실측 사례: "화면 이름 파편화"가 8명 전원에게 떴다 — 개인이 아니라 분석 규칙의 문제였다.
  collapseSystemWide();
  function collapseSystemWide() {
    const people = new Set(findings.filter(f => f.scope !== 'host').map(f => f.who));
    const byTitle = new Map();
    for (const f of findings) {
      if (f.scope === 'host') continue;
      if (!byTitle.has(f.title)) byTitle.set(f.title, []);
      byTitle.get(f.title).push(f);
    }
    for (const [title, list] of byTitle) {
      if (list.length < 3) continue;
      const ratio = list.length / Math.max(people.size, 1);
      if (ratio < 0.7) continue;                     // 대다수에게 걸릴 때만 묶는다
      const names = list.map(f => f.who).join(', ');
      const sev = list[0].sev;
      for (const f of list) f._drop = true;
      findings.push({
        sev, who: '시스템 전체', title: title + ' (개인 문제 아님)',
        evidence: `${list.length}명 전원에게 동일 증상 — ${names}`,
        action: list[0].action + ' 특정인 조치가 아니라 수집·분석 규칙 자체를 고쳐야 합니다.',
      });
    }
    for (let i = findings.length - 1; i >= 0; i--) if (findings[i]._drop) findings.splice(i, 1);
  }

  const order = { [CRIT]: 0, [WARN]: 1, [INFO]: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev] || String(a.who).localeCompare(String(b.who)));
  const nCrit = findings.filter(f => f.sev === CRIT).length;
  const nWarn = findings.filter(f => f.sev === WARN).length;

  if (AS_JSON) {
    console.log(JSON.stringify({ days: DAYS, checkedAt: new Date().toISOString(), crit: nCrit, warn: nWarn, findings }, null, 1));
  } else if (!QUIET) {
    console.log(`\n수집 건강검진 — 최근 ${DAYS}일\n${'─'.repeat(58)}`);
    if (!findings.length) console.log('발견된 문제 없음.');
    for (const f of findings) {
      const mark = f.sev === CRIT ? '■' : f.sev === WARN ? '▲' : '·';
      console.log(`\n${mark} [${f.sev}] ${f.who} — ${f.title}`);
      console.log(`   근거: ${f.evidence}`);
      console.log(`   조치: ${f.action}`);
    }
    console.log(`\n${'─'.repeat(58)}\n치명 ${nCrit}건 · 주의 ${nWarn}건 · 정보 ${findings.length - nCrit - nWarn}건`);
    if (nCrit) console.log('치명 항목은 그 사람 데이터가 사실상 수집되지 않는 상태입니다.');
  }
  process.exit(nCrit ? 2 : nWarn ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(3); });
