#!/usr/bin/env node
/**
 * bin/sync-to-railway.js
 * ──────────────────────────────────────────────────────────────────────────
 * 로컬 SQLite에 쌓인 이벤트를 Railway 서버로 일괄 업로드합니다.
 *
 * 사용:
 *   node bin/sync-to-railway.js
 *   node bin/sync-to-railway.js --limit 500     (최근 500개만)
 *   node bin/sync-to-railway.js --from 2026-03  (날짜 이후만)
 *
 * Railway URL 우선순위:
 *   1. ORBIT_SERVER_URL 환경변수
 *   2. ~/.orbit-config.json의 serverUrl
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const os    = require('os');

// ── 설정 읽기 ────────────────────────────────────────────────────────────────
function readOrbitConfig() {
  try {
    const p = path.join(os.homedir(), '.orbit-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}

const cfg = readOrbitConfig();
const SERVER_URL = process.env.ORBIT_SERVER_URL || cfg.serverUrl || null;
const TOKEN      = process.env.ORBIT_TOKEN       || cfg.token      || '';
const USER_ID    = process.env.ORBIT_USER_ID     || cfg.userId     || null; // config에서 유저 ID 읽기
const DB_PATH    = path.join(__dirname, '..', 'src', 'data', 'mindmap.db');

// ── CLI 인수 파싱 ────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '--limit=2000').split('=')[1]);
const from  = (args.find(a => a.startsWith('--from=')) || '').split('=')[1] || null;

if (!SERVER_URL) {
  console.error('❌ Railway 서버 URL이 설정되지 않았습니다.');
  console.error('   방법 1: ORBIT_SERVER_URL 환경변수 설정');
  console.error('   방법 2: ~/.orbit-config.json 에 serverUrl 설정');
  console.error('   방법 3: 설치 스크립트 다시 실행 (irm [URL]/orbit-setup.ps1 | iex)');
  process.exit(1);
}

// ── 이벤트 로드 ──────────────────────────────────────────────────────────────
function loadEvents() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });

    let query = 'SELECT id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json FROM events';
    const params = [];

    if (from) {
      query += ' WHERE timestamp >= ?';
      params.push(from);
    }

    query += ' ORDER BY timestamp ASC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    db.close();

    // DB 컬럼 → 이벤트 객체로 변환 (userId를 config에서 읽은 값으로 덮어쓰기)
    return rows.map(r => ({
      id:            r.id,
      type:          r.type,
      source:        r.source,
      sessionId:     r.session_id,
      userId:        USER_ID || r.user_id,                         // config userId 우선 사용
      channelId:     r.channel_id,
      parentEventId: r.parent_event_id,
      timestamp:     r.timestamp,
      data:          JSON.parse(r.data_json || '{}'),
      metadata:      JSON.parse(r.metadata_json || '{}'),
    }));
  } catch (e) {
    console.error('❌ DB 읽기 오류:', e.message);
    process.exit(1);
  }
}

// ── Railway 업로드 ─────────────────────────────────────────────────────────
function uploadBatch(events) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      events,
      channelId:  'sync-upload',
      memberName: require('os').hostname(),
    });

    const url     = new URL('/api/hook', SERVER_URL);
    const isHttps = url.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 메인 ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`⬡ Orbit 로컬→Railway 동기화`);
  console.log(`  서버: ${SERVER_URL}`);
  console.log(`  DB:   ${DB_PATH}`);
  if (from) console.log(`  기간: ${from} 이후`);
  console.log();

  const events = loadEvents();
  if (events.length === 0) {
    console.log('ℹ️  업로드할 이벤트가 없습니다.');
    return;
  }

  console.log(`📦 이벤트 ${events.length}개 발견 → 배치 업로드 중...`);

  // 100개씩 배치 전송
  const BATCH_SIZE = 100;
  let uploaded = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    try {
      const { status } = await uploadBatch(batch);
      if (status === 200 || status === 201) {
        uploaded += batch.length;
        process.stdout.write(`\r  ✅ ${uploaded}/${events.length}개 완료`);
      } else {
        console.error(`\n  ❌ 배치 ${i}-${i+batch.length} 실패 (HTTP ${status})`);
      }
    } catch (e) {
      console.error(`\n  ❌ 배치 ${i}-${i+batch.length} 오류: ${e.message}`);
    }
  }

  console.log(`\n\n🚀 동기화 완료: ${uploaded}/${events.length}개 업로드됨`);
  console.log(`   Railway에서 확인: ${SERVER_URL}/orbit3d.html`);
}

main().catch(e => {
  console.error('❌ 오류:', e.message);
  process.exit(1);
});
