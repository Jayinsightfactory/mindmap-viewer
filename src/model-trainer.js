/**
 * src/model-trainer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI — Ollama 커스텀 모델 학습 관리자
 *
 * 역할:
 *   1. DB 이벤트 → JSONL 학습 데이터 자동 생성 (ground-truth: analyzeEvents 결과)
 *   2. Modelfile 자동 생성 (FROM llama3.2 + SYSTEM 프롬프트 + LoRA 어댑터)
 *   3. `ollama create` 실행 → orbit-insight:v{timestamp} 모델 등록
 *   4. 활성 모델 영구 저장 (data/model-config.json)
 *   5. 버전 관리 (매 학습마다 새 태그 → 롤백 가능)
 *
 * 사용:
 *   const trainer = require('./model-trainer');
 *   trainer.getActiveModel()          // 현재 활성 모델명
 *   trainer.setActiveModel('orbit-insight:v123')
 *   trainer.exportTrainingData(events) // JSONL 생성
 *   trainer.trainModel(events, onProgress) // 전체 파이프라인
 *   trainer.listAvailableModels()     // orbit-* 모델 목록
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// insight-engine의 analyzeEvents를 ground-truth로 재사용 (순환참조 없음)
const { analyzeEvents } = require('./insight-engine');

// ─── 경로 상수 ───────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, '..', 'data');
const TRAINING_DIR  = path.join(DATA_DIR, 'training');
const CONFIG_FILE   = path.join(DATA_DIR, 'model-config.json');
const MODELFILE_PATH = path.join(DATA_DIR, 'Modelfile');

// ─── 설정 조회 / 저장 ─────────────────────────────────────────────────────
/**
 * 활성 모델명을 반환합니다.
 * 우선순위: data/model-config.json → OLLAMA_MODEL env → 'llama3.2'
 */
function getActiveModel() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.activeModel) return cfg.activeModel;
  } catch {
    // 파일 없거나 파싱 실패 → 폴백
  }
  return process.env.OLLAMA_MODEL || 'llama3.2';
}

/**
 * 활성 모델을 data/model-config.json에 영구 저장합니다.
 * @param {string} modelName - 예: 'orbit-insight:v1234567890'
 */
function setActiveModel(modelName) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* 신규 파일 */ }

  cfg.activeModel = modelName;
  cfg.updatedAt   = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ─── 학습 데이터 생성 ────────────────────────────────────────────────────────

/**
 * 세션별로 이벤트를 그룹화합니다.
 * @param {object[]} events
 * @returns {Map<string, object[]>}
 */
function groupBySession(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.sessionId || e.session_id || 'default';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

/**
 * 세션 이벤트 배열을 텍스트 요약으로 변환합니다.
 * @param {object[]} sessionEvents
 * @returns {string}
 */
function summarizeSession(sessionEvents) {
  const types   = {};
  const files   = {};
  const hours   = new Array(24).fill(0);
  let   errors  = 0;

  for (const e of sessionEvents) {
    // 타입 집계
    const t = e.type || 'unknown';
    types[t] = (types[t] || 0) + 1;

    // 파일 집계
    const f = e.data?.file_path || e.data?.filePath || e.data?.path;
    if (f) files[f] = (files[f] || 0) + 1;

    // 시간대 집계
    const h = new Date(e.timestamp).getHours();
    if (!isNaN(h)) hours[h]++;

    // 에러 집계
    if (t === 'tool.error') errors++;
  }

  const topTypes = Object.entries(types)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

  const topFiles = Object.entries(files)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => `${path.basename(k)}:${v}`)
    .join(', ');

  const peakHour = hours.indexOf(Math.max(...hours));
  const errorRate = sessionEvents.length > 0
    ? Math.round(errors / sessionEvents.length * 100) : 0;

  return [
    `이벤트 수: ${sessionEvents.length}`,
    topTypes   ? `이벤트 유형: ${topTypes}`         : null,
    topFiles   ? `주요 파일: ${topFiles}`           : null,
    `피크 시간: ${peakHour}시`,
    `오류율: ${errorRate}%`,
  ].filter(Boolean).join(' | ');
}

/**
 * 이벤트 배열로부터 prompt/response JSONL 학습 쌍을 생성합니다.
 * insight-engine.analyzeEvents() 결과를 ground-truth response로 재사용합니다.
 *
 * @param {object[]} events
 * @returns {{ prompt: string, response: string }[]}
 */
function generateTrainingPairs(events) {
  const pairs    = [];
  const sessions = groupBySession(events);

  for (const [sessionId, sessionEvents] of sessions) {
    if (sessionEvents.length < 5) continue; // 너무 적은 이벤트는 학습에 의미 없음

    const prompt   = `세션 [${sessionId}] 개발 데이터:\n${summarizeSession(sessionEvents)}`;
    const insights = analyzeEvents(sessionEvents);

    if (insights.length === 0) continue;

    const response = insights
      .map(i => `[${i.type}] ${i.title}: ${i.body}`)
      .join('\n');

    pairs.push({ prompt, response });
  }

  // 전체 이벤트 패턴 요약 쌍 (하나 더 추가)
  if (events.length >= 20) {
    const globalInsights = analyzeEvents(events);
    if (globalInsights.length > 0) {
      pairs.push({
        prompt:   `전체 개발 패턴 분석:\n${summarizeSession(events)}`,
        response: globalInsights.map(i => `[${i.type}] ${i.title}: ${i.body}`).join('\n'),
      });
    }
  }

  return pairs;
}

/**
 * DB 이벤트를 JSONL 학습 파일로 내보냅니다.
 *
 * @param {object[]} events - getAllEvents() 결과
 * @returns {{ filePath: string, count: number }}
 */
function exportTrainingData(events) {
  if (!fs.existsSync(TRAINING_DIR)) {
    fs.mkdirSync(TRAINING_DIR, { recursive: true });
  }

  const pairs    = generateTrainingPairs(events);
  const dateStr  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filePath = path.join(TRAINING_DIR, `orbit-${dateStr}.jsonl`);

  const content = pairs.map(p => JSON.stringify(p)).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');

  return { filePath, count: pairs.length };
}

// ─── Modelfile 생성 ──────────────────────────────────────────────────────────

/**
 * Ollama Modelfile을 생성합니다.
 *
 * @param {string} baseModel  - 베이스 모델 (예: 'llama3.2')
 * @param {string} trainingFile - JSONL 학습 파일 경로 (count > 10이면 ADAPTER 포함)
 * @param {number} pairCount  - 학습 쌍 개수
 * @returns {string} 생성된 Modelfile 경로
 */
function buildModelfile(baseModel, trainingFile, pairCount) {
  const lines = [
    `FROM ${baseModel}`,
    '',
    'SYSTEM """',
    '당신은 Orbit AI 개발 인사이트 전문가입니다.',
    '개발자의 AI 도구 사용 패턴(Claude Code, Cursor, Windsurf 등)을 분석하고',
    '실용적인 인사이트를 제공합니다.',
    '',
    '분석 시 다음 형식으로 JSON 배열을 반환하세요:',
    '[',
    '  {',
    '    "title": "인사이트 제목",',
    '    "body": "구체적인 설명 (수치 포함)",',
    '    "type": "ollama_insight",',
    '    "confidence": 0.7',
    '  }',
    ']',
    '"""',
  ];

  // 학습 데이터가 충분하면 LoRA 어댑터 포함 (Ollama 0.3+)
  if (pairCount > 10 && trainingFile && fs.existsSync(trainingFile)) {
    lines.push('');
    lines.push(`ADAPTER ${trainingFile}`);
  }

  const content = lines.join('\n');
  fs.writeFileSync(MODELFILE_PATH, content, 'utf8');
  return MODELFILE_PATH;
}

// ─── 모델 학습 (메인 파이프라인) ─────────────────────────────────────────────

/**
 * 전체 학습 파이프라인을 실행합니다.
 *
 * 1. 이벤트 → JSONL 학습 데이터 추출
 * 2. Modelfile 생성
 * 3. `ollama create` 실행
 * 4. 성공 시 활성 모델로 설정
 *
 * @param {object[]} events      - getAllEvents() 결과
 * @param {Function} [onProgress] - ({ step, count?, modelName?, log?, error? }) => void
 * @returns {Promise<{ modelName: string, pairCount: number }>}
 */
async function trainModel(events, onProgress) {
  // Step 1: 학습 데이터 추출
  const { filePath, count: pairCount } = exportTrainingData(events);
  onProgress?.({ step: 'data_exported', count: pairCount, filePath });

  if (pairCount === 0) {
    throw new Error('학습 데이터가 없습니다. 이벤트를 더 수집한 후 시도하세요.');
  }

  // Step 2: Modelfile 생성
  const baseModel  = process.env.OLLAMA_BASE_MODEL || 'llama3.2';
  const modelName  = `orbit-insight:v${Date.now()}`;
  const modelfile  = buildModelfile(baseModel, filePath, pairCount);
  onProgress?.({ step: 'modelfile_created', modelName, baseModel, pairCount });

  // Step 3: ollama create 실행 (비동기, 스트리밍 로그)
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('ollama', ['create', modelName, '-f', modelfile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`Ollama를 찾을 수 없습니다. 설치 여부를 확인하세요: ${err.message}`));
      return;
    }

    const logBuffer = [];

    proc.stdout.on('data', data => {
      const log = data.toString().trim();
      if (log) {
        logBuffer.push(log);
        onProgress?.({ step: 'training', log });
      }
    });

    proc.stderr.on('data', data => {
      const log = data.toString().trim();
      if (log) {
        logBuffer.push(`[stderr] ${log}`);
        onProgress?.({ step: 'training', log });
      }
    });

    proc.on('error', err => {
      reject(new Error(`Ollama 실행 오류: ${err.message}`));
    });

    proc.on('close', code => {
      if (code === 0) {
        // Step 4: 활성 모델 설정
        setActiveModel(modelName);
        onProgress?.({ step: 'completed', modelName, pairCount });
        resolve({ modelName, pairCount });
      } else {
        const lastLog = logBuffer.slice(-5).join('\n');
        reject(new Error(`ollama create 실패 (exit ${code})\n${lastLog}`));
      }
    });
  });
}

// ─── 모델 목록 조회 ──────────────────────────────────────────────────────────

/**
 * Ollama에서 orbit-* 모델만 필터링해 반환합니다.
 * @returns {{ name: string, size: string, modified: string }[]}
 */
function listAvailableModels() {
  try {
    const out = execSync('ollama list', {
      encoding: 'utf8',
      timeout:  5000,
    });

    const lines = out.split('\n').slice(1); // 헤더 제거
    const models = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;

      const name = parts[0];
      if (!name || !name.startsWith('orbit-')) continue;

      models.push({
        name,
        id:       parts[1] || '',
        size:     parts[2] || '',
        modified: parts.slice(3).join(' ') || '',
      });
    }

    return models;
  } catch {
    return [];
  }
}

/**
 * Ollama 서버 연결 상태를 확인합니다.
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
async function checkOllamaStatus() {
  const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, version: data.version, url: baseUrl };
    }
    return { ok: false, error: `HTTP ${res.status}`, url: baseUrl };
  } catch (err) {
    return { ok: false, error: err.message, url: baseUrl };
  }
}

/**
 * 특정 모델을 Ollama에서 삭제합니다.
 * @param {string} modelName
 * @returns {{ ok: boolean, error?: string }}
 */
function deleteModel(modelName) {
  if (!modelName.startsWith('orbit-')) {
    return { ok: false, error: 'orbit-* 모델만 삭제할 수 있습니다.' };
  }
  try {
    execSync(`ollama rm ${modelName}`, { encoding: 'utf8', timeout: 10000 });

    // 삭제된 모델이 활성 모델이었다면 기본값으로 복원
    if (getActiveModel() === modelName) {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
      delete cfg.activeModel;
      cfg.updatedAt = new Date().toISOString();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 학습 데이터 파일 목록을 반환합니다.
 * @returns {{ filename: string, date: string, size: number, path: string }[]}
 */
function listTrainingFiles() {
  if (!fs.existsSync(TRAINING_DIR)) return [];

  return fs.readdirSync(TRAINING_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fullPath = path.join(TRAINING_DIR, f);
      const stat = fs.statSync(fullPath);
      return {
        filename: f,
        date:     stat.mtime.toISOString(),
        size:     stat.size,
        path:     fullPath,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 최근 학습 데이터 파일에서 샘플 쌍을 미리보기로 반환합니다.
 * @param {number} [limit=5]
 * @returns {{ prompt: string, response: string }[]}
 */
function previewTrainingData(limit = 5) {
  const files = listTrainingFiles();
  if (files.length === 0) return [];

  try {
    const content = fs.readFileSync(files[0].path, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .slice(0, limit)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  getActiveModel,
  setActiveModel,
  exportTrainingData,
  buildModelfile,
  trainModel,
  listAvailableModels,
  checkOllamaStatus,
  deleteModel,
  listTrainingFiles,
  previewTrainingData,
  generateTrainingPairs,
};
