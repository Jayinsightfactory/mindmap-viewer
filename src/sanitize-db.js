#!/usr/bin/env node
/**
 * sanitize-db.js
 * DB에서 민감한 정보를 제거합니다.
 * git push 전에 실행하세요.
 *
 * Usage: node sanitize-db.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'mindmap.db');

// 민감 패턴 목록 (정규식)
const SENSITIVE_PATTERNS = [
  { regex: /ghp_[A-Za-z0-9]{30,}/g, label: 'GitHub PAT' },
  { regex: /gho_[A-Za-z0-9]{30,}/g, label: 'GitHub OAuth' },
  { regex: /github_pat_[A-Za-z0-9_]{30,}/g, label: 'GitHub Fine-grained PAT' },
  { regex: /sk-[A-Za-z0-9]{30,}/g, label: 'API Key (sk-)' },
  { regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g, label: 'Bearer Token' },
  { regex: /eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{50,}/g, label: 'JWT Token' },
  { regex: /AKIA[A-Z0-9]{16}/g, label: 'AWS Access Key' },
  { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END/g, label: 'Private Key' },
];

function sanitize(text) {
  if (!text) return { text, count: 0 };
  let count = 0;
  let result = text;
  for (const { regex, label } of SENSITIVE_PATTERNS) {
    result = result.replace(regex, (match) => {
      count++;
      return `[REDACTED:${label}]`;
    });
  }
  return { text: result, count };
}

function main() {
  console.log('🔒 DB 민감정보 정리 시작...');
  console.log(`   DB: ${DB_PATH}`);

  let db;
  try {
    db = new Database(DB_PATH);
  } catch (e) {
    console.log('❌ DB를 열 수 없습니다:', e.message);
    process.exit(1);
  }

  // WAL 체크포인트
  db.pragma('wal_checkpoint(TRUNCATE)');

  // events 테이블 정리
  const rows = db.prepare('SELECT id, data_json, metadata_json FROM events').all();
  const update = db.prepare('UPDATE events SET data_json = ?, metadata_json = ? WHERE id = ?');

  let totalCleaned = 0;
  const txn = db.transaction(() => {
    for (const row of rows) {
      const d = sanitize(row.data_json);
      const m = sanitize(row.metadata_json);
      if (d.count > 0 || m.count > 0) {
        update.run(d.text, m.text, row.id);
        totalCleaned += d.count + m.count;
      }
    }
  });
  txn();

  // 최종 WAL 체크포인트
  db.pragma('wal_checkpoint(TRUNCATE)');

  // 검증
  let remaining = 0;
  const verify = db.prepare('SELECT data_json, metadata_json FROM events').all();
  for (const row of verify) {
    for (const { regex } of SENSITIVE_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(row.data_json || '')) remaining++;
      regex.lastIndex = 0;
      if (regex.test(row.metadata_json || '')) remaining++;
    }
  }

  db.close();

  console.log(`✅ 정리 완료: ${totalCleaned}건 제거`);
  if (remaining > 0) {
    console.log(`⚠️  아직 ${remaining}건 남아있습니다. 다시 실행하세요.`);
    process.exit(1);
  } else {
    console.log('🟢 민감정보 없음 — push 안전');
  }
}

main();
