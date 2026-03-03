/**
 * orbit-client.js — 직원 PC에서 실행되는 로컬 에이전트
 *
 * 역할:
 *  1. 파일 변경 감지 (chokidar)
 *  2. 시스템 전반 작업 감지 (system-monitor: 앱전환/클립보드/브라우저)
 *  3. 두 Ollama 모델 동시 분석 (앙상블 신뢰도)
 *  4. 구조화된 인사이트만 서버 전송 (원본 코드 절대 미전송)
 *  5. 서버 피드백 폴링 → 스킬/에이전트 자동 제안 수락
 *
 * 실행: node src/orbit-client.js
 * 설정: orbit.config.json
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const os      = require('os');
const { getInstance: getMonitor } = require('./system-monitor');

// ── 설정 로드 ──────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(process.cwd(), 'orbit.config.json');

function loadConfig() {
  const defaults = {
    serverUrl:      'http://localhost:4747',
    ollamaUrl:      'http://localhost:11434',
    ollamaModel:    'llama3.2',    // 기본 모델 (파일/문서 분석)
    ollamaModel2:   'codellama',   // 보조 모델 (코드 특화)
    watchPaths:     [process.cwd()],
    ignorePatterns: ['node_modules', '.git', 'dist', 'build', '*.log', 'data/'],
    clientId:       crypto.createHash('md5').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 12),
    userName:       os.userInfo().username,
    sendInterval:   5000,    // 5초 배치 전송
    feedbackInterval: 30000, // 30초 피드백 폴링
    systemMonitor:  true,    // 시스템 모니터 활성화
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaults, ...cfg };
    }
  } catch {}

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  console.log(`[OrbitClient] ⚙️  설정 파일 생성됨: ${CONFIG_PATH}`);
  return defaults;
}

const CONFIG = loadConfig();

// ── fetch 폴리필 ───────────────────────────────────────────────────────────
const _fetch = (() => {
  try { return require('node-fetch'); } catch { return globalThis.fetch; }
})();

// ── 스냅샷 캐시 / 전송 큐 ──────────────────────────────────────────────────
const _snapshots = new Map();
const _sendQueue = [];

// ── 파일 감시 시작 ──────────────────────────────────────────────────────────
async function startWatcher() {
  let chokidar;
  try { chokidar = require('chokidar'); }
  catch { console.error('[OrbitClient] chokidar 없음. npm install chokidar'); return; }

  const ignored = CONFIG.ignorePatterns.map(p =>
    p.startsWith('*') ? new RegExp(p.replace('*', '.*')) : new RegExp(p)
  );

  const watcher = chokidar.watch(CONFIG.watchPaths, {
    ignored:          (p) => ignored.some(r => r.test(p)),
    persistent:       true,
    ignoreInitial:    true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });

  watcher
    .on('change', async (filePath) => {
      const insight = await processFileChange(filePath);
      if (insight) _sendQueue.push(insight);
    })
    .on('add',  (filePath) => takeSnapshot(filePath))
    .on('ready', () => {
      console.log(`[OrbitClient] 👀 파일 감시 중: ${CONFIG.watchPaths.join(', ')}`);
    });
}

// ── 시스템 모니터 시작 ─────────────────────────────────────────────────────
function startSystemMonitor() {
  if (!CONFIG.systemMonitor) return;

  const monitor = getMonitor({ cdp: true });
  monitor.start();

  monitor.on('activity', async (ev) => {
    if (ev.type === 'idle') return; // idle은 통계 목적으로 전송 안 함

    // 시스템 활동을 Ollama 분석 없이 카테고리 메타데이터로 바로 큐에 추가
    const insight = {
      clientId:     CONFIG.clientId,
      userName:     CONFIG.userName,
      fileName:     ev.title  || ev.url || 'system-activity',
      ext:          ev.type   === 'browse' ? '.url' : '.app',
      timestamp:    ev.timestamp,
      activityType: ev.activityType || ev.type,
      addedLines:   0,
      removedLines: 0,
      changeRatio:  0,
      category:     ev.category,
      pattern:      buildSystemPattern(ev),
      suggestion:   null,
      automatable:  false,
      // 듀얼 분석 없이 단일 시스템 이벤트로 표시
      dualAnalysis: null,
      sourceType:   'system',
    };

    // 앱 전환 → Ollama 추가 분석 (앱 타입별 작업 패턴 학습)
    if (ev.type === 'app_switch' && ev.category !== 'unknown') {
      const dual = await analyzeSystemEvent(ev);
      if (dual) {
        insight.dualAnalysis  = dual;
        insight.pattern       = dual.merged?.pattern    || insight.pattern;
        insight.suggestion    = dual.merged?.suggestion || null;
        insight.automatable   = dual.merged?.automatable ?? false;
      }
    }

    _sendQueue.push(insight);
  });

  console.log('[OrbitClient] 🖥️  시스템 모니터 활성화 (앱전환/클립보드/브라우저)');
}

function buildSystemPattern(ev) {
  if (ev.type === 'browse' && ev.url)
    return `브라우저: ${ev.url.slice(0, 80)}`;
  if (ev.type === 'app_switch')
    return `${ev.app} 사용 — ${(ev.title || '').slice(0, 60)}`;
  if (ev.type === 'clipboard')
    return `클립보드: ${(ev.text || '').slice(0, 60)}`;
  return ev.type;
}

// ── 스냅샷 (변경 전 저장) ──────────────────────────────────────────────────
function takeSnapshot(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash    = crypto.createHash('md5').update(content).digest('hex');
    _snapshots.set(filePath, { content, hash });
  } catch {}
}

// ── 파일 변경 처리 ─────────────────────────────────────────────────────────
async function processFileChange(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > 500 * 1024) return null;

    const afterContent = fs.readFileSync(filePath, 'utf-8');
    const afterHash    = crypto.createHash('md5').update(afterContent).digest('hex');
    const before       = _snapshots.get(filePath);

    if (before?.hash === afterHash) return null;

    const beforeContent = before?.content || '';
    const diff          = computeDiff(beforeContent, afterContent);
    if (!diff.changed) return null;

    _snapshots.set(filePath, { content: afterContent, hash: afterHash });

    // ★ 두 Ollama 모델 병렬 분석
    const dual = await analyzeWithDualModels(path.basename(filePath), diff);

    const insight = {
      clientId:     CONFIG.clientId,
      userName:     CONFIG.userName,
      fileName:     path.basename(filePath),
      ext:          path.extname(filePath),
      timestamp:    Date.now(),
      activityType: 'file',
      addedLines:   diff.added,
      removedLines: diff.removed,
      changeRatio:  diff.ratio,
      pattern:      dual.merged?.pattern     || null,
      suggestion:   dual.merged?.suggestion  || null,
      automatable:  dual.merged?.automatable || false,
      category:     dual.merged?.category    || 'unknown',
      dualAnalysis: dual,     // 서버가 앙상블 신뢰도 재계산에 사용
      sourceType:   'file',
    };

    console.log(`[OrbitClient] 📦 분석 완료: ${insight.fileName} → [${insight.category}] 신뢰도:${dual.confidence}`);
    return insight;

  } catch (e) {
    console.error('[OrbitClient] 처리 오류:', e.message);
    return null;
  }
}

// ── 두 Ollama 모델 병렬 분석 ──────────────────────────────────────────────
async function analyzeWithDualModels(fileName, diff) {
  const [primary, secondary] = await Promise.all([
    analyzeLocally(fileName, diff, CONFIG.ollamaModel),
    analyzeLocally(fileName, diff, CONFIG.ollamaModel2),
  ]);

  const confidence = calcClientConfidence(primary, secondary);

  // 병합: 더 구체적인 결과 우선
  const merged = mergeClientResults(primary, secondary, confidence);

  return {
    primary:    primary   ? { ...primary,   model: CONFIG.ollamaModel  } : null,
    secondary:  secondary ? { ...secondary, model: CONFIG.ollamaModel2 } : null,
    confidence,
    merged,
  };
}

// ── 시스템 이벤트 Ollama 분석 ─────────────────────────────────────────────
async function analyzeSystemEvent(ev) {
  const prompt = `
사용자의 현재 작업을 분석합니다.
앱: ${ev.app || ''}
창 제목: ${ev.title || ''}
${ev.url ? `URL: ${ev.url}` : ''}

이 작업의 카테고리와 자동화 가능성을 분석하세요.
JSON: {"pattern":"...","category":"refactor/feature/bugfix/docs/report/browse/meeting/analysis/unknown","suggestion":"...","automatable":true/false}
`.trim();

  const [primary, secondary] = await Promise.all([
    callOllama(CONFIG.ollamaModel,  prompt),
    callOllama(CONFIG.ollamaModel2, prompt),
  ]);

  if (!primary && !secondary) return null;
  const confidence = calcClientConfidence(primary, secondary);
  return {
    primary:   primary   ? { ...primary,   model: CONFIG.ollamaModel  } : null,
    secondary: secondary ? { ...secondary, model: CONFIG.ollamaModel2 } : null,
    confidence,
    merged: mergeClientResults(primary, secondary, confidence),
  };
}

// ── 로컬 Ollama 단일 분석 ──────────────────────────────────────────────────
async function analyzeLocally(fileName, diff, model) {
  const prompt = `
개발자의 코드 변경을 분석합니다.

파일: ${fileName}
추가된 줄: ${diff.added}개
삭제된 줄: ${diff.removed}개
변경 비율: ${(diff.ratio * 100).toFixed(0)}%
변경 샘플:
${diff.snippet}

JSON: {"pattern":"...","category":"refactor/feature/bugfix/config/docs/test","suggestion":"...","automatable":true/false}
`.trim();

  return callOllama(model, prompt);
}

// ── Ollama HTTP 호출 ───────────────────────────────────────────────────────
async function callOllama(model, prompt) {
  try {
    const res = await _fetch(`${CONFIG.ollamaUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model,
        prompt,
        stream:  false,
        options: { temperature: 0.2, num_predict: 200 },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) return null;
    const data  = await res.json();
    const match = (data.response || '').match(/\{[\s\S]*?\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ── 클라이언트 측 신뢰도 계산 (서버 dual-skill-engine과 동일 로직) ─────────
function calcClientConfidence(primary, secondary) {
  if (!primary && !secondary) return 0;
  if (!primary || !secondary) return 0.45;
  let score = 0.40;
  if (primary.category === secondary.category) score += 0.30;
  if (primary.automatable && secondary.automatable) score += 0.20;
  if (primary.pattern && secondary.pattern) {
    const w1 = new Set((primary.pattern  || '').split(/\s+/));
    const w2 = new Set((secondary.pattern || '').split(/\s+/));
    const inter = [...w1].filter(w => w2.has(w) && w.length > 1).length;
    const union = new Set([...w1, ...w2]).size;
    if (union > 0) score += 0.10 * (inter / union);
  }
  return Math.min(Math.round(score * 100) / 100, 0.95);
}

function mergeClientResults(primary, secondary, confidence) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  const suggestion = (primary.suggestion?.length || 0) >= (secondary.suggestion?.length || 0)
    ? primary.suggestion : secondary.suggestion;
  return {
    pattern:     primary.pattern || secondary.pattern,
    category:    confidence >= 0.70 ? primary.category : (primary.category || secondary.category),
    suggestion,
    automatable: primary.automatable && secondary.automatable,
    confidence,
  };
}

// ── 서버 전송 (배치) ────────────────────────────────────────────────────────
async function flushQueue() {
  if (_sendQueue.length === 0) return;

  const batch = _sendQueue.splice(0, 20);
  try {
    const res = await _fetch(`${CONFIG.serverUrl}/api/insights`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ insights: batch }),
      signal:  AbortSignal.timeout(10000),
    });

    if (res.ok) {
      console.log(`[OrbitClient] ✅ 서버 전송: ${batch.length}개`);
    } else {
      _sendQueue.unshift(...batch);
    }
  } catch {
    _sendQueue.unshift(...batch);
    if (_sendQueue.length > 200) _sendQueue.splice(100);
  }
}

// ── 서버 피드백 폴링 (스킬/에이전트 자동 제안) ───────────────────────────────
async function pollFeedback() {
  try {
    const res = await _fetch(
      `${CONFIG.serverUrl}/api/insights/feedback?clientId=${CONFIG.clientId}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return;

    const { suggestions } = await res.json();
    if (!suggestions?.length) return;

    for (const s of suggestions) {
      console.log(`\n[OrbitClient] 🎯 새 제안 도착!`);
      console.log(`  타입:    ${s.type === 'skill' ? '📌 스킬' : '🤖 에이전트'}`);
      console.log(`  이름:    ${s.alias}`);
      console.log(`  트리거:  ${s.trigger}`);
      console.log(`  근거:    ${s.evidence.patternCount}회 패턴 (신뢰도 ${s.evidence.avgConfidence})`);
      console.log(`  카테고리: ${s.evidence.category}`);
      console.log('');

      // orbit.config.json에 자동 저장 (수동 수락 없이 바로 적용)
      await applySkillSuggestion(s);
    }
  } catch { /* 서버 오프라인 시 조용히 무시 */ }
}

// ── 제안 → orbit.config.json 반영 ─────────────────────────────────────────
async function applySkillSuggestion(suggestion) {
  try {
    // 서버에 수락 알림
    await _fetch(`${CONFIG.serverUrl}/api/insights/feedback/apply`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: CONFIG.clientId, suggestionId: suggestion.id }),
      signal:  AbortSignal.timeout(5000),
    });

    // 로컬 config에 스킬/에이전트 항목 추가
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}

    if (!cfg.skills) cfg.skills = [];
    // 동일 트리거 중복 방지
    if (!cfg.skills.find(s => s.trigger === suggestion.trigger)) {
      cfg.skills.push({
        trigger:      suggestion.trigger,
        type:         suggestion.type,
        alias:        suggestion.alias,
        model:        suggestion.model,
        systemPrompt: suggestion.systemPrompt,
        autoRun:      suggestion.autoRun,
        addedAt:      Date.now(),
      });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log(`[OrbitClient] 💾 ${suggestion.type} "${suggestion.alias}" → orbit.config.json 저장`);
    }
  } catch (e) {
    console.error('[OrbitClient] 제안 수락 오류:', e.message);
  }
}

// ── diff 계산 ─────────────────────────────────────────────────────────────
function computeDiff(before, after) {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const bSet   = new Set(bLines);
  const aSet   = new Set(aLines);

  const added   = aLines.filter(l => l.trim() && !bSet.has(l));
  const removed = bLines.filter(l => l.trim() && !aSet.has(l));
  const changed = added.length > 0 || removed.length > 0;
  const total   = Math.max(bLines.length, aLines.length);
  const ratio   = total > 0 ? (added.length + removed.length) / total : 0;

  const snippet = [
    ...added.slice(0, 2).map(l => `+ ${l.trim().slice(0, 60)}`),
    ...removed.slice(0, 1).map(l => `- ${l.trim().slice(0, 60)}`),
  ].join('\n');

  return { changed, added: added.length, removed: removed.length, ratio, snippet };
}

// ── 서버 연결 확인 ─────────────────────────────────────────────────────────
async function checkServer() {
  try {
    const res = await _fetch(`${CONFIG.serverUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`[OrbitClient] 🟢 서버 연결됨: ${CONFIG.serverUrl}`);
      return true;
    }
  } catch {}
  console.warn(`[OrbitClient] 🔴 서버 연결 실패 (로컬 큐에 저장)`);
  return false;
}

// ── 진입점 ────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Orbit AI — 로컬 듀얼 에이전트         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  클라이언트 ID:  ${CONFIG.clientId}`);
  console.log(`  사용자:         ${CONFIG.userName}`);
  console.log(`  Orbit 서버:     ${CONFIG.serverUrl}`);
  console.log(`  모델1 (기본):   ${CONFIG.ollamaModel}`);
  console.log(`  모델2 (코드):   ${CONFIG.ollamaModel2}`);
  console.log(`  시스템 모니터:  ${CONFIG.systemMonitor ? '활성' : '비활성'}`);
  console.log('');

  await checkServer();
  await startWatcher();
  startSystemMonitor();

  // 배치 전송
  setInterval(flushQueue, CONFIG.sendInterval);
  // 피드백 폴링
  setInterval(pollFeedback, CONFIG.feedbackInterval);
  // 시작 직후 첫 폴링
  setTimeout(pollFeedback, 10000);

  console.log('[OrbitClient] ✨ 실행 중. Ctrl+C로 종료\n');
}

main().catch(console.error);
