/**
 * routes/exec.js
 * Orbit 실행 패널 — 명령 생성(generate) + 실행(execute)
 *
 * POST /api/orbit-cmd/generate  → diff 미리보기 생성 (실행 X)
 * POST /api/orbit-cmd/execute   → 승인된 명령 실제 실행
 * GET  /api/orbit-cmd/ai-status → AI 연결 상태 확인
 */

'use strict';

const { Router }     = require('express');
const { execSync, spawn } = require('child_process');
const http           = require('http');
const crypto         = require('crypto');
const path           = require('path');

// 승인 대기 중인 명령 임시 저장 (메모리)
const pendingCmds = new Map(); // id → { type, hash, projectDir, cmds, createdAt }

// ── 유틸 ──────────────────────────────────────────────────────────────────────

/** 최근 N초 이내 이벤트가 있으면 AI 연결됨으로 판단 */
function checkAiConnected(getAllEvents, thresholdMs = 90_000) {
  try {
    const events = getAllEvents(1);
    if (!events.length) return false;
    const last = events[0];
    const ts   = last.ts || last.timestamp || last.created_at || 0;
    return (Date.now() - new Date(ts).getTime()) < thresholdMs;
  } catch { return false; }
}

/** git diff / show 로 변경사항 파싱 */
function getGitDiff(projectDir, hash) {
  try {
    // 롤백 시 현재 HEAD와 대상 커밋 사이의 diff
    const diff = execSync(
      `git diff ${hash} HEAD --stat`,
      { cwd: projectDir, encoding: 'utf8', timeout: 8000 }
    ).trim();
    const show = execSync(
      `git show --stat ${hash}`,
      { cwd: projectDir, encoding: 'utf8', timeout: 8000 }
    ).trim().slice(0, 2000); // 너무 길면 자름
    return { diff, show };
  } catch (e) {
    return { diff: '', show: e.message };
  }
}

/** Ollama에 프롬프트 전송 → 응답 텍스트 반환 */
function askOllama(prompt, model = 'orbit-insight:v1') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 400 },
    });
    const req = http.request(
      { hostname: 'localhost', port: 11434, path: '/api/generate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data).response || ''); }
          catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

/** 화이트리스트 검증 — git / npm / node 계열만 허용 */
const CMD_WHITELIST = /^(git\s|npm\s|npx\s|node\s|ls\s|cat\s)/i;
function isSafeCmd(cmd) {
  return cmd.trim().split('\n').every(line => {
    const l = line.trim();
    return !l || l.startsWith('#') || CMD_WHITELIST.test(l);
  });
}

// ── 라우터 ────────────────────────────────────────────────────────────────────

module.exports = function createExecRouter({ getAllEvents, broadcastAll }) {
  const router = Router();

  // ── AI 연결 상태 ────────────────────────────────────────────────────────────
  router.get('/orbit-cmd/ai-status', (req, res) => {
    const connected = checkAiConnected(getAllEvents);
    res.json({ connected, ts: Date.now() });
  });

  // ── 명령 생성 (실행 X) ──────────────────────────────────────────────────────
  router.post('/orbit-cmd/generate', async (req, res) => {
    const { type, hash, projectDir, instruction, model = 'orbit-insight:v1' } = req.body;

    if (!type) return res.status(400).json({ error: 'type 필드 필수' });

    const id      = crypto.randomUUID();
    const safeDir = projectDir || process.cwd();
    let   preview = '';
    let   cmds    = [];

    try {
      // ── rollback 타입 ─────────────────────────────────────────────────────
      if (type === 'rollback') {
        if (!hash) return res.status(400).json({ error: 'hash 필드 필수' });
        const { diff, show } = getGitDiff(safeDir, hash);
        preview = `롤백 대상: ${hash.slice(0,7)}\n\n${show}\n\n[현재→대상 diff]\n${diff || '(변경 없음)'}`;
        cmds    = [`git reset --hard ${hash}`];
      }

      // ── file-edit 타입 ────────────────────────────────────────────────────
      else if (type === 'file-edit') {
        if (!instruction) return res.status(400).json({ error: 'instruction 필드 필수' });
        const aiConnected = checkAiConnected(getAllEvents);

        if (aiConnected) {
          // AI가 연결 중이면 pending 파일에 기록 (Mode 1)
          const pendingPath = path.join(safeDir, '.orbit', 'pending.json');
          require('fs').mkdirSync(path.join(safeDir, '.orbit'), { recursive: true });
          require('fs').writeFileSync(pendingPath, JSON.stringify({
            id, type, instruction, ts: Date.now(),
          }));
          return res.json({ id, mode: 'ai', status: 'queued',
            preview: `✅ AI 에이전트에 전달됨\n\n"${instruction}"\n\n다음 Claude 작업 시작 전 자동 처리됩니다.`,
            cmds: [] });
        }

        // Ollama 모드 (Mode 2)
        const prompt =
          `다음 파일 수정 요청에 대해 실행 가능한 bash 명령어만 출력하세요.\n` +
          `요청: "${instruction}"\n프로젝트: ${safeDir}\n` +
          `규칙: git, npm, node 명령만 사용. 한 줄씩 출력. 설명 없이 명령만.`;
        const ollamaResp = await askOllama(prompt, model);
        cmds    = ollamaResp.split('\n').map(l => l.trim()).filter(Boolean);
        preview = `[Ollama ${model}]\n\n${ollamaResp}`;
      }

      // ── 기타 타입 ─────────────────────────────────────────────────────────
      else {
        return res.status(400).json({ error: `지원하지 않는 type: ${type}` });
      }

      // pending 저장
      pendingCmds.set(id, { id, type, hash, projectDir: safeDir, cmds, createdAt: Date.now() });

      // 5분 후 만료
      setTimeout(() => pendingCmds.delete(id), 5 * 60 * 1000);

      return res.json({ id, mode: 'ollama', status: 'preview', preview, cmds });

    } catch (err) {
      console.error('[exec/generate]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── 명령 실행 (승인 후) ─────────────────────────────────────────────────────
  router.post('/orbit-cmd/execute', (req, res) => {
    const { id } = req.body;
    const pending = pendingCmds.get(id);
    if (!pending) return res.status(404).json({ error: '만료되었거나 존재하지 않는 명령입니다' });

    // 화이트리스트 검증
    const allCmds = pending.cmds.join('\n');
    if (!isSafeCmd(allCmds)) {
      pendingCmds.delete(id);
      return res.status(403).json({ error: '허용되지 않는 명령어입니다', cmds: pending.cmds });
    }

    // SSE 스트리밍 응답
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'start', id, cmds: pending.cmds });

    pendingCmds.delete(id); // 한 번만 실행

    let cmdIdx = 0;
    const runNext = () => {
      if (cmdIdx >= pending.cmds.length) {
        send({ type: 'done', exitCode: 0 });
        broadcastAll({ type: 'orbit.exec.done', cmdId: id, status: 'success' });
        return res.end();
      }
      const cmd = pending.cmds[cmdIdx++];
      send({ type: 'cmd', cmd });

      const proc = spawn('sh', ['-c', cmd], {
        cwd:   pending.projectDir,
        env:   { ...process.env },
        shell: false,
      });

      proc.stdout.on('data', d => send({ type: 'stdout', text: d.toString() }));
      proc.stderr.on('data', d => send({ type: 'stderr', text: d.toString() }));
      proc.on('close', code => {
        send({ type: 'cmd_done', cmd, exitCode: code });
        if (code !== 0) {
          send({ type: 'error', exitCode: code, msg: `명령 실패: ${cmd}` });
          broadcastAll({ type: 'orbit.exec.done', cmdId: id, status: 'error', cmd });
          return res.end();
        }
        runNext();
      });
      proc.on('error', err => {
        send({ type: 'error', msg: err.message });
        res.end();
      });
    };
    runNext();
  });

  return router;
};
