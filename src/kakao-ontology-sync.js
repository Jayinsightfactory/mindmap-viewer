'use strict';
/**
 * kakao-ontology-sync.js — 카카오 구글시트(kakaoagent/nenovakakao 기록분) → 온톨로지 연결
 * ─────────────────────────────────────────────────────────────────────────────
 * 재사용: routes/process-mining.js 의 _fetchKakaoSheetData (동일 시트·동일 서비스계정,
 * createProcessMining._fetchKakaoSheetData 로 노출됨 — 새 시트 리더 재구현 금지).
 *
 * "비즈니스이벤트"·"의사결정추적" 탭(구조화된 업무 신호)만 온톨로지에 연결한다.
 * "메시지분류"(원문 대화)는 대상 아님 — PC 데몬이 이미 화면/입력으로 캡처하고
 * 있고, 원문 카톡 대화를 여기서 별도 저장하면 프라이버시 범위가 늘어난다.
 *
 * 결과: unified_events(source='nenova-agent', type='kakao.business_event'|'kakao.decision')
 *       + ops_relation(kakao_event_in_room, kakao_event_mentions_customer).
 * 시트에 거래처 컬럼이 이미 있어 PC 캡처 추론보다 신뢰도가 높다(confidence 0.85).
 * 부수효과: entity-resolution 스케줄러(hourly, match-customer-fuzzy._scanAgent)가
 *          source='nenova-agent'+room_name 이벤트를 그대로 스캔 — 별도 연동 불필요.
 * 멱등: id = 핵심필드 해시. 재동기화해도 중복 없음. 대량은 UNNEST 벌크 insert(왕복 2회).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');

function pick(row, keys) { for (const k of keys) if (row[k]) return row[k]; return ''; }
function parseSheetTs(row) {
  const raw = pick(row, ['일시', '날짜', '시간', 'timestamp']);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
function hashId(prefix, parts) {
  return prefix + ':' + crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 24);
}

async function bulkInsertEvents(pool, rows) {
  if (!rows.length) return;
  const ids = [], types = [], tss = [], wss = [], datas = [];
  for (const r of rows) { ids.push(r.id); types.push(r.type); tss.push(r.ts.toISOString()); wss.push(r.workspaceId); datas.push(JSON.stringify(r.data)); }
  await pool.query(
    `INSERT INTO unified_events (id, type, source, timestamp, user_id, workspace_id, data)
     SELECT id, type, 'nenova-agent', ts::timestamptz, 'kakao-agent', ws, data::jsonb
     FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(id, type, ts, ws, data)
     ON CONFLICT (id) DO NOTHING`,
    [ids, types, tss, wss, datas]
  );
}

async function bulkInsertRelations(pool, rels) {
  if (!rels.length) return;
  const ids = [], rts = [], fts = [], frs = [], tts = [], trs = [], confs = [], evs = [], tss = [], wss = [];
  for (const r of rels) {
    ids.push(r.id); rts.push(r.relType); fts.push(r.fromType); frs.push(r.fromRef);
    tts.push(r.toType); trs.push(r.toRef); confs.push(r.confidence);
    evs.push(JSON.stringify(r.evidence || {})); tss.push(r.ts.toISOString()); wss.push(r.workspaceId);
  }
  await pool.query(
    `INSERT INTO ops_relation (id, rel_type, from_type, from_ref, to_type, to_ref, source, confidence, evidence, ts, workspace_id)
     SELECT id, rel_type, from_type, from_ref, to_type, to_ref, 'nenova-agent', confidence, evidence::jsonb, ts::timestamptz, ws
     FROM UNNEST($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::numeric[],$8::text[],$9::text[],$10::text[])
       AS t(id, rel_type, from_type, from_ref, to_type, to_ref, confidence, evidence, ts, ws)
     ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, confidence = EXCLUDED.confidence`,
    [ids, rts, fts, frs, tts, trs, confs, evs, tss, wss]
  );
}

/**
 * @param {import('pg').Pool} pool
 * @param {Function} fetchFn  createProcessMining._fetchKakaoSheetData (호출측에서 주입)
 * @param {string} workspaceId  테넌트 (기본 nenova)
 */
async function syncKakaoToOntology(pool, fetchFn, workspaceId = 'nenova') {
  if (typeof fetchFn !== 'function') return { synced: 0, mentions: 0, error: 'fetch fn missing' };
  const rows = await fetchFn().catch(() => []);
  if (!rows.length) return { synced: 0, mentions: 0, rows: 0 };

  const now = new Date();
  const events = [], relations = [];

  for (const r of rows.filter(r => r._tab === '비즈니스이벤트')) {
    const eventType = pick(r, ['이벤트타입', 'event_type', '타입']);
    const room = pick(r, ['방이름', '방', 'room', '채팅방']);
    const cust = pick(r, ['거래처', 'customer']);
    const prod = pick(r, ['품목', 'product', '상품']);
    if (!eventType && !room) continue;
    const ts = parseSheetTs(r) || now;
    const id = hashId('kakao:biz', [eventType, room, cust, prod, ts.toISOString().slice(0, 16)]);
    events.push({ id, type: 'kakao.business_event', ts, workspaceId, data: { room_name: room, event_type: eventType, customer: cust, product: prod, tab: '비즈니스이벤트' } });
    if (room) relations.push({ id: `rel:kakao_event_in_room:${id}:${room}`.slice(0, 200), relType: 'kakao_event_in_room', fromType: 'KakaoEvent', fromRef: id, toType: 'Room', toRef: room.slice(0, 60), confidence: 0.67, evidence: { eventType, product: prod }, ts, workspaceId });
    if (cust) relations.push({ id: `rel:kakao_event_mentions_customer:${id}:${cust}`.slice(0, 200), relType: 'kakao_event_mentions_customer', fromType: 'KakaoEvent', fromRef: id, toType: 'CustomerName', toRef: cust.slice(0, 60), confidence: 0.85, evidence: { eventType, product: prod, room }, ts, workspaceId });
  }

  for (const r of rows.filter(r => r._tab === '의사결정추적')) {
    const room = pick(r, ['발생방', '방이름', 'room']);
    const result = pick(r, ['결과', 'status']);
    if (!room) continue;
    const ts = parseSheetTs(r) || now;
    const unresolved = !result || result === '미해결';
    const id = hashId('kakao:dec', ['dec', room, result, ts.toISOString().slice(0, 16)]);
    events.push({ id, type: 'kakao.decision', ts, workspaceId, data: { room_name: room, result: result || '미해결', unresolved, tab: '의사결정추적' } });
    relations.push({ id: `rel:kakao_event_in_room:${id}:${room}`.slice(0, 200), relType: 'kakao_event_in_room', fromType: 'KakaoEvent', fromRef: id, toType: 'Room', toRef: room.slice(0, 60), confidence: 0.67, evidence: { unresolved }, ts, workspaceId });
  }

  await bulkInsertEvents(pool, events);
  await bulkInsertRelations(pool, relations);

  return {
    synced: events.length,
    mentions: relations.filter(r => r.relType === 'kakao_event_mentions_customer').length,
    rooms: relations.filter(r => r.relType === 'kakao_event_in_room').length,
    rows: rows.length,
  };
}

module.exports = { syncKakaoToOntology };
