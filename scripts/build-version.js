#!/usr/bin/env node
/* build-version.js — 모든 스크립트 태그에 단일 캐시 버스터 적용 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HTML_PATH = path.join(__dirname, '..', 'public', 'orbit3d.html');

// 버전 생성: YYYYMMDD-gitshorthash
function generateVersion() {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim();
    return `${date}-${hash}`;
  } catch {
    return `${date}-manual`;
  }
}

const version = generateVersion();
console.log(`[build-version] 버전: ${version}`);

let html = fs.readFileSync(HTML_PATH, 'utf8');

// 로컬 JS 파일의 캐시 버스터를 모두 통일
// 패턴: src="js/xxx.js?v=..." 또는 src="js/xxx.js" (버전 없는 것)
const replaced = html.replace(
  /(<script\s+src="js\/[^"]+\.js)(\?v=[^"]*)?(")/g,
  (match, prefix, oldVersion, suffix) => `${prefix}?v=${version}${suffix}`
);

if (replaced === html) {
  console.log('[build-version] 변경 없음');
} else {
  fs.writeFileSync(HTML_PATH, replaced, 'utf8');
  // 변경된 버전 수 계산
  const oldVersions = new Set();
  html.replace(/src="js\/[^"]+\.js\?v=([^"]*)"/g, (_, v) => oldVersions.add(v));
  html.replace(/src="js\/[^"]+\.js"/g, () => oldVersions.add('(none)'));
  console.log(`[build-version] ${oldVersions.size}개 버전 → 단일 버전 ${version} 으로 통일`);
  console.log(`[build-version] 이전 버전들: ${[...oldVersions].join(', ')}`);
}
