#!/usr/bin/env node
/**
 * bin/bulk-sync.js
 * 로컬 SQLite → 프로덕션 벌크 임포트 (rate limit 우회)
 *
 * 1단계: 로컬 users.db에서 유저+토큰 → 프로덕션 /api/auth/register로 생성
 * 2단계: 로컬 mindmap.db 이벤트 → /api/bulk-import 로 전송
 * 3단계: 세션 데이터도 전송
 */
'use strict';

const path    = require('path');
const https   = require('https');
const http    = require('http');

const DB_PATH    = path.join(__dirname, '..', 'src', 'data', 'mindmap.db');
const USERS_PATH = path.join(__dirname, '..', 'data', 'users.db');

// config 읽기
const fs = require('fs');
const os = require('os');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')); } catch {}
const SERVER_URL = process.env.ORBIT_SERVER_URL || cfg.serverUrl;
const TOKEN      = process.env.ORBIT_TOKEN || cfg.token || '';

if (!SERVER_URL) {
  console.error('❌ ORBIT_SERVER_URL 또는 ~/.orbit-config.json serverUrl 필요');
  process.exit(1);
}

function httpPost(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const jsonBody = JSON.stringify(body);
    const url = new URL(urlPath, SERVER_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(jsonBody);
    req.end();
  });
}

async function main() {
  console.log(`⬡ Orbit 벌크 동기화`);
  console.log(`  서버: ${SERVER_URL}`);
  console.log(`  토큰: ${TOKEN ? TOKEN.slice(0, 12) + '...' : '없음'}`);
  console.log();

  // Step 1: 토큰 검증
  console.log('1️⃣  토큰 검증...');
  const authCheck = await httpPost('/api/auth/me', {}, TOKEN).catch(() => null);
  if (!authCheck || authCheck.status === 401) {
    console.log('   토큰 미인증 — 프로덕션에서 Google OAuth 로그인 필요');
    console.log(`   → ${SERVER_URL}/orbit3d.html 에서 Google 로그인 후 재시도`);

    // users.db에서 유저 정보 복사 시도
    try {
      const Database = require('better-sqlite3');
      const usersDb = new Database(USERS_PATH, { readonly: true });
      const users = usersDb.prepare('SELECT id, email, name FROM users').all();
      const tokens = usersDb.prepare('SELECT token, userId FROM tokens').all();
      usersDb.close();
      console.log(`   로컬 users.db: ${users.length}명, ${tokens.length}토큰`);
    } catch (e) {
      console.log(`   users.db 읽기 실패: ${e.message}`);
    }
    // 토큰 없이도 벌크 임포트 시도 (hook과 달리 401 반환됨)
    // 프로덕션에 유저 등록 필요
  } else {
    console.log(`   ✅ 인증 성공: ${JSON.stringify(authCheck.data).slice(0, 80)}`);
  }

  // Step 2: 이벤트 로드
  console.log('\n2️⃣  이벤트 로드...');
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  const events = db.prepare(`
    SELECT id, type, source, session_id, user_id, channel_id,
           parent_event_id, timestamp, data_json, metadata_json
    FROM events ORDER BY timestamp ASC
  `).all();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at ASC').all();
  db.close();

  console.log(`   이벤트: ${events.length}개`);
  console.log(`   세션: ${sessions.length}개`);

  // Step 3: 벌크 업로드
  console.log('\n3️⃣  벌크 업로드...');
  const BATCH = 500;
  let uploaded = 0;

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH).map(r => ({
      id:            r.id,
      type:          r.type,
      source:        r.source,
      sessionId:     r.session_id,
      userId:        r.user_id,
      channelId:     r.channel_id,
      parentEventId: r.parent_event_id,
      timestamp:     r.timestamp,
      data:          JSON.parse(r.data_json || '{}'),
      metadata:      JSON.parse(r.metadata_json || '{}'),
    }));

    try {
      const res = await httpPost('/api/bulk-import', { events: batch }, TOKEN);
      if (res.status === 200 || res.status === 201) {
        uploaded += (res.data?.imported || batch.length);
        process.stdout.write(`\r   ✅ ${uploaded}/${events.length}개 완료`);
      } else {
        console.error(`\n   ❌ 배치 ${i}: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
        if (res.status === 401) {
          console.error('\n   ⚠️  인증 필요 — 프로덕션에서 Google 로그인 후 토큰 갱신하세요');
          break;
        }
      }
    } catch (e) {
      console.error(`\n   ❌ 배치 ${i}: ${e.message}`);
    }
  }

  console.log(`\n\n🚀 완료: ${uploaded}/${events.length}개 업로드`);

  // Step 4: 확인
  console.log('\n4️⃣  프로덕션 확인...');
  try {
    const statsRes = await httpPost('/api/stats', {}, '').catch(() => null);
    // stats는 GET이므로 직접 fetch
    const url = new URL('/api/stats', SERVER_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const statsCheck = await new Promise((resolve) => {
      mod.get(url.href, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      }).on('error', () => resolve(null));
    });
    console.log(`   프로덕션 stats:`, statsCheck);
  } catch {}
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
