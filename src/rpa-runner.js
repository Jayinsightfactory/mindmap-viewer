'use strict';

/**
 * rpa-runner.js — 승인 기반 RPA 실행기
 *
 * 서버에서 내려온 자동화 스크립트를 바로 임의 실행하지 않고,
 * 기본 dry-run으로 저장/검증한 뒤 approved=true인 명령만 실행한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RPA_DIR = path.join(os.homedir(), '.orbit', 'rpa');
const MAX_SCRIPT_BYTES = 200 * 1024;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

const EXT_BY_TYPE = {
  pyautogui: 'py',
  python: 'py',
  powershell: 'ps1',
  ahk: 'ahk',
  autohotkey: 'ahk',
  pad: 'robin',
};

const BLOCK_PATTERNS = [
  /\bRemove-Item\b/i,
  /\bStop-Process\b/i,
  /\btaskkill\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bschtasks\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bformat\b/i,
  /\bdel\s+\/[fsq]/i,
  /\brmdir\b/i,
  /\bInvoke-WebRequest\b/i,
  /\biwr\b/i,
  /\bInvoke-RestMethod\b/i,
  /\birm\b/i,
  /\bgit\s+(pull|reset|checkout|clean|push)\b/i,
];

function ensureDir() {
  fs.mkdirSync(RPA_DIR, { recursive: true });
}

function safeName(value) {
  return String(value || 'rpa')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'rpa';
}

function validateJob(job = {}) {
  const script = String(job.script || '');
  const scriptType = String(job.scriptType || job.type || 'pyautogui').toLowerCase();
  const errors = [];

  if (!script.trim()) errors.push('script is empty');
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) errors.push('script too large');
  if (!EXT_BY_TYPE[scriptType]) errors.push(`unsupported scriptType: ${scriptType}`);
  for (const re of BLOCK_PATTERNS) {
    if (re.test(script)) errors.push(`blocked pattern: ${re}`);
  }

  return { ok: errors.length === 0, errors, scriptType, script };
}

function saveScript(job, scriptType, script) {
  ensureDir();
  const id = safeName(job.scriptId || job.actionType || job.name || Date.now());
  const ext = EXT_BY_TYPE[scriptType] || 'txt';
  const file = path.join(RPA_DIR, `${Date.now()}-${id}.${ext}`);
  fs.writeFileSync(file, script, 'utf8');
  return file;
}

function buildCommand(scriptType, file) {
  if (scriptType === 'pyautogui' || scriptType === 'python') {
    return { command: 'python', args: [file], windowsHide: true };
  }
  if (scriptType === 'powershell') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      windowsHide: true,
    };
  }
  if (scriptType === 'ahk' || scriptType === 'autohotkey') {
    return { command: 'AutoHotkey.exe', args: [file], windowsHide: false };
  }
  return null;
}

function runChild(command, args, opts) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch {}
      resolve({ ...result, durationMs: Date.now() - startedAt, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
    };

    try {
      child = spawn(command, args, {
        cwd: RPA_DIR,
        windowsHide: opts.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return done({ ok: false, code: null, error: e.message });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, code: null, error: 'timeout' });
    }, opts.timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => done({ ok: false, code: null, error: e.message }));
    child.on('close', code => done({ ok: code === 0, code, error: code === 0 ? null : `exit ${code}` }));
  });
}

async function run(job = {}) {
  const validation = validateJob(job);
  if (!validation.ok) {
    return { ok: false, mode: 'rejected', errors: validation.errors };
  }

  const file = saveScript(job, validation.scriptType, validation.script);
  const approved = job.approved === true || job.mode === 'execute';
  const dryRun = job.dryRun !== false && !approved;

  const base = {
    ok: true,
    mode: dryRun ? 'dry-run' : 'execute',
    scriptType: validation.scriptType,
    scriptPath: file,
    actionType: job.actionType || '',
    scriptId: job.scriptId || null,
  };

  if (dryRun) return { ...base, executed: false };
  if (validation.scriptType === 'pad') return { ...base, ok: false, executed: false, error: 'PAD scripts require manual import/approval' };

  const cmd = buildCommand(validation.scriptType, file);
  if (!cmd) return { ...base, ok: false, executed: false, error: 'unsupported runner' };

  const timeoutMs = Math.min(Math.max(Number(job.timeoutMs) || 120000, 10000), MAX_TIMEOUT_MS);
  const result = await runChild(cmd.command, cmd.args, { windowsHide: cmd.windowsHide, timeoutMs });
  return { ...base, executed: true, ...result };
}

module.exports = { run, validateJob, RPA_DIR };
