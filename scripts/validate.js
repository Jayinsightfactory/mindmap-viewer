#!/usr/bin/env node
/* validate.js — 배포 전 검증: DB 동기화, 캐시 버스터, 에러 핸들링 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = 0;
let warnings = 0;

function error(msg) { console.error(`❌ ERROR: ${msg}`); errors++; }
function warn(msg)  { console.warn(`⚠️  WARN: ${msg}`); warnings++; }
function ok(msg)    { console.log(`✅ OK: ${msg}`); }

// ─── Check 1: DB 함수 동기화 ──────────────────────────────────────────────────
function checkDbParity() {
  console.log('\n── DB 함수 동기화 검증 ──');
  const dbPath   = path.join(ROOT, 'src', 'db.js');
  const pgPath   = path.join(ROOT, 'src', 'db-pg.js');

  if (!fs.existsSync(dbPath) || !fs.existsSync(pgPath)) {
    warn('db.js 또는 db-pg.js 없음 — 건너뜀');
    return;
  }

  function extractExports(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const match = src.match(/module\.exports\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s);
    if (!match) return new Set();
    const block = match[1];
    const names = new Set();
    // 함수명 추출: identifier 또는 identifier: value
    block.replace(/\b([a-zA-Z_]\w*)\b(?:\s*[:,]|\s*$)/gm, (_, name) => {
      if (!['module', 'exports', 'require', 'const', 'let', 'var', 'function', 'async', 'true', 'false'].includes(name)) {
        names.add(name);
      }
    });
    return names;
  }

  const dbExports = extractExports(dbPath);
  const pgExports = extractExports(pgPath);

  const onlyDb = [...dbExports].filter(n => !pgExports.has(n));
  const onlyPg = [...pgExports].filter(n => !dbExports.has(n));

  if (onlyDb.length > 0) warn(`db.js에만 있는 함수 (${onlyDb.length}): ${onlyDb.join(', ')}`);
  if (onlyPg.length > 0) warn(`db-pg.js에만 있는 함수 (${onlyPg.length}): ${onlyPg.join(', ')}`);
  if (onlyDb.length === 0 && onlyPg.length === 0) ok(`DB 함수 동기화 OK (${dbExports.size}개)`);
}

// ─── Check 2: 캐시 버스터 일관성 ──────────────────────────────────────────────
function checkCacheBusters() {
  console.log('\n── 캐시 버스터 일관성 검증 ──');
  const htmlPath = path.join(ROOT, 'public', 'orbit3d.html');
  if (!fs.existsSync(htmlPath)) { warn('orbit3d.html 없음'); return; }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const versions = new Map(); // version → [files]
  const noVersion = [];

  // 로컬 js 파일만 (CDN 제외)
  html.replace(/<script\s+src="js\/([^"]+\.js)(?:\?v=([^"]*))?"/g, (_, file, ver) => {
    if (ver) {
      if (!versions.has(ver)) versions.set(ver, []);
      versions.get(ver).push(file);
    } else {
      noVersion.push(file);
    }
  });

  if (noVersion.length > 0) warn(`버전 없는 스크립트 (${noVersion.length}): ${noVersion.join(', ')}`);
  if (versions.size > 1) {
    error(`캐시 버스터 불일치 — ${versions.size}개 버전 존재:`);
    for (const [ver, files] of versions) {
      console.log(`   v=${ver}: ${files.length}개 파일`);
    }
  } else if (versions.size === 1) {
    ok(`캐시 버스터 통일 (v=${[...versions.keys()][0]}, ${[...versions.values()][0].length}개 파일)`);
  }
}

// ─── Check 3: 사일런트 에러 핸들러 ────────────────────────────────────────────
function checkSilentCatch() {
  console.log('\n── 사일런트 에러 핸들러 검사 ──');
  const jsDir = path.join(ROOT, 'public', 'js');
  if (!fs.existsSync(jsDir)) { warn('public/js/ 없음'); return; }

  const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
  let totalSilent = 0;
  const silentFiles = [];

  for (const file of files) {
    const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
    const matches = src.match(/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g);
    if (matches) {
      totalSilent += matches.length;
      silentFiles.push(`${file} (${matches.length})`);
    }
  }

  if (totalSilent > 0) {
    warn(`사일런트 .catch(() => {}) ${totalSilent}개: ${silentFiles.join(', ')}`);
  } else {
    ok('사일런트 에러 핸들러 없음');
  }
}

// ─── Check 4: 파일 크기 검사 ──────────────────────────────────────────────────
function checkFileSizes() {
  console.log('\n── 파일 크기 검사 ──');
  const jsDir = path.join(ROOT, 'public', 'js');
  if (!fs.existsSync(jsDir)) return;

  const MAX_LINES = 800;
  const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
  const oversized = [];

  for (const file of files) {
    const lines = fs.readFileSync(path.join(jsDir, file), 'utf8').split('\n').length;
    if (lines > MAX_LINES) oversized.push({ file, lines });
  }

  if (oversized.length > 0) {
    warn(`${MAX_LINES}줄 초과 파일 ${oversized.length}개:`);
    oversized.sort((a, b) => b.lines - a.lines);
    for (const { file, lines } of oversized) {
      console.log(`   ${file}: ${lines}줄`);
    }
  } else {
    ok(`모든 JS 파일 ${MAX_LINES}줄 이하`);
  }
}

// ─── 실행 ──────────────────────────────────────────────────────────────────────
console.log('🔍 배포 전 검증 시작...');
checkDbParity();
checkCacheBusters();
checkSilentCatch();
checkFileSizes();

console.log(`\n${'─'.repeat(50)}`);
console.log(`결과: ${errors} 에러, ${warnings} 경고`);
if (errors > 0) {
  console.log('🚫 에러가 있어 배포를 중단합니다.');
  process.exit(1);
} else if (warnings > 0) {
  console.log('⚠️  경고가 있지만 배포 가능합니다.');
} else {
  console.log('🎉 모든 검증 통과!');
}
