'use strict';

/**
 * file-learner.js
 * 파일 저장 감지 → 텍스트 추출 → POST /api/personal/file-content
 *
 * - chokidar로 ~/Documents, ~/Desktop, ~/Downloads 감시
 * - 2MB 이상 파일도 처리 (4000자 청크로 분할, 최대 20청크 = 80,000자)
 * - .docx → mammoth / .xlsx → xlsx / .pdf → pdf-parse / 텍스트→ 직접 읽기
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const https   = require('https');
const http    = require('http');
const chokidar = require('chokidar');

// ── 감시 대상 경로 ────────────────────────────────────────────────────────────
const HOME = os.homedir();
const DEFAULT_WATCH_PATHS = [
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Downloads'),
];

// ── 지원 확장자 ──────────────────────────────────────────────────────────────
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.js', '.ts', '.py',
                           '.jsx', '.tsx', '.html', '.css', '.yaml', '.yml',
                           '.sh', '.env', '.xml', '.log', '.sql']);
const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.xls', '.pdf']);

const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...OFFICE_EXTS]);

// ── 청크 설정 ────────────────────────────────────────────────────────────────
const CHUNK_SIZE  = 4000;   // 글자 수
const MAX_CHUNKS  = 20;     // 청크 수 상한 (80,000자)

// ── 상태 ─────────────────────────────────────────────────────────────────────
let _watcher    = null;
let _running    = false;
let _orbitPort  = parseInt(process.env.ORBIT_PORT || '4747', 10);
let _orbitUrl   = `http://localhost:${_orbitPort}/api/personal/file-content`;
let _watchPaths = [...DEFAULT_WATCH_PATHS];

// ── 텍스트 청킹 ──────────────────────────────────────────────────────────────
function chunkText(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length && chunks.length < MAX_CHUNKS) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    i += CHUNK_SIZE;
  }
  return chunks;
}

// ── 파서: .docx ──────────────────────────────────────────────────────────────
async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

// ── 파서: .xlsx / .xls ───────────────────────────────────────────────────────
async function extractXlsx(filePath) {
  const XLSX  = require('xlsx');
  const wb    = XLSX.readFile(filePath, { sheetRows: 2000 });
  const lines = [];
  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    lines.push(`[시트: ${sheetName}]`);
    for (const row of rows) {
      const line = row.map(v => String(v ?? '')).join('\t');
      if (line.trim()) lines.push(line);
    }
  }
  return lines.join('\n');
}

// ── 파서: .pdf ───────────────────────────────────────────────────────────────
async function extractPdf(filePath) {
  const pdfParse = require('pdf-parse');
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return data.text || '';
}

// ── 파서: 텍스트 계열 ─────────────────────────────────────────────────────────
async function extractText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

// ── 통합 추출 ─────────────────────────────────────────────────────────────────
async function extractContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.docx')              return extractDocx(filePath);
  if (ext === '.xlsx' || ext === '.xls') return extractXlsx(filePath);
  if (ext === '.pdf')               return extractPdf(filePath);
  if (TEXT_EXTS.has(ext))          return extractText(filePath);
  return null;
}

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function postToOrbit(body) {
  try {
    const url = new URL(_orbitUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const str = JSON.stringify(body);
    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) },
    }, res => res.resume());
    req.on('error', () => {});
    req.write(str);
    req.end();
  } catch {}
}

// ── 파일 처리 ─────────────────────────────────────────────────────────────────
async function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }

  // 파일 크기 로그 (제한 없음, 청크로 처리)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`[file-learner] 처리: ${path.basename(filePath)} (${sizeMB}MB)`);

  let text;
  try {
    text = await extractContent(filePath);
  } catch (err) {
    console.error(`[file-learner] 추출 실패 ${filePath}:`, err.message);
    return;
  }

  if (!text || !text.trim()) return;

  const chunks      = chunkText(text);
  const totalChunks = chunks.length;
  const ts          = new Date().toISOString();

  console.log(`[file-learner] → ${totalChunks}청크 전송`);

  for (let i = 0; i < chunks.length; i++) {
    postToOrbit({
      type:        'file.content',
      filePath:    filePath.replace(HOME, '~'),
      fileName:    path.basename(filePath),
      ext,
      sizeMB:      parseFloat(sizeMB),
      chunkIndex:  i,
      totalChunks,
      text:        chunks[i],
      ts,
    });
    // 청크 간 간격 (서버 과부하 방지)
    if (i < chunks.length - 1) await sleep(100);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 공개 API ──────────────────────────────────────────────────────────────────
function start(opts = {}) {
  if (_running) return;
  if (opts.port)       { _orbitPort = opts.port; _orbitUrl = `http://localhost:${opts.port}/api/personal/file-content`; }
  if (opts.watchPaths) _watchPaths = opts.watchPaths;

  // 존재하는 경로만 감시
  const validPaths = _watchPaths.filter(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });

  if (!validPaths.length) {
    console.warn('[file-learner] 감시할 경로가 없습니다');
    return;
  }

  _watcher = chokidar.watch(validPaths, {
    ignored:          /(^|[/\\])\.|My Music|My Videos|My Pictures/, // 숨김 + Windows 특수폴더 제외
    persistent:       true,
    ignoreInitial:    true,
    ignorePermissionErrors: true, // Windows EPERM 무시
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  _watcher
    .on('add',    fp => processFile(fp).catch(() => {}))
    .on('change', fp => processFile(fp).catch(() => {}));

  _running = true;
  console.log(`[file-learner] 시작 — 감시 경로: ${validPaths.join(', ')}`);
}

function stop() {
  if (!_running) return;
  _watcher?.close();
  _watcher  = null;
  _running  = false;
  console.log('[file-learner] 종료');
}

function isRunning()    { return _running; }
function getWatchPaths(){ return [..._watchPaths]; }

module.exports = { start, stop, isRunning, getWatchPaths };
