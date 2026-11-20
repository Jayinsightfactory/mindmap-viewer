'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const INTERVAL_MS = 60000;
const SETTLE_MS = 8000;
const MAX_FILES = 12000;
const MAX_UPLOADS = 20;
const skip = name => /^\.|^~\$|^(?:node_modules|AppData)$/i.test(name);
const keyOf = text => createHash('sha256').update(text).digest('hex');

function relativeParts(value) {
  if (typeof value !== 'string' || value.length > 180 || /[:\x00-\x1f]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  return parts.length >= 2 && parts.every(part => part && !skip(part) && !/[ .]$/.test(part)) ? parts : null;
}

async function resolveWorkRoot(base, relative) {
  const parts = relativeParts(relative);
  if (!path.isAbsolute(base) || !parts) return null;
  const canon = await fs.realpath(base);
  const root = path.join(canon, ...parts);
  const real = await fs.realpath(root);
  if (path.relative(root, real) !== '' || !(await fs.stat(real)).isDirectory()) return null;
  return real;
}

async function locallyAvailable(file) {
  if (process.platform !== 'win32') return false;
  const script = '$a=[int64](Get-Item -LiteralPath $env:NENOVA_FILE_READINESS -Force -ErrorAction Stop).Attributes; if (($a -band 0x00441006) -eq 0) {"ready"}';
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024, env: { ...process.env, NENOVA_FILE_READINESS: file },
    });
    return stdout.trim() === 'ready';
  } catch { return false; }
}

async function scan(root, decide) {
  const stack = [root];
  const files = new Map();
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      if (path.relative(dir, await fs.realpath(dir)) !== '') continue;
      entries = await fs.opendir(dir);
    } catch (error) {
      if (dir === root || error.code !== 'ENOENT') throw error;
      continue;
    }
    for await (const entry of entries) {
      if (++visited > MAX_FILES) throw Error('approved-root-limit');
      if (skip(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(file); continue; }
      if (!entry.isFile() || decide({ filename: entry.name, approvedOneDrive: true }) !== 'ok') continue;
      let stat;
      try { stat = await fs.stat(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      files.set(keyOf(path.relative(root, file)), { file, filename: entry.name, size: stat.size, modified: stat.mtimeMs, fingerprint: [stat.size, stat.mtimeMs, stat.birthtimeMs, stat.ino].join(':') });
    }
  }
  return files;
}

function createApprovedPoll({ root, stateFile, ownerId, getConfig, upload, decide, ready = locallyAvailable, now = Date.now }) {
  const identity = keyOf(root + '\0' + ownerId);
  let previous;
  let busy = false;
  return async function poll() {
    if (busy) return;
    busy = true;
    try {
      const cfg = await getConfig();
      if (!cfg?.enabled || cfg.userId !== ownerId || !cfg.userName) return;
      if (previous === undefined) {
        try {
          const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          previous = saved.identity === identity && saved.files && typeof saved.files === 'object' ? saved.files : null;
        } catch (e) { if (e.code !== 'ENOENT') throw e; previous = null; }
      }
      const current = await scan(root, decide);
      const next = {};
      let submissions = 0;
      for (const [key, value] of current) {
        if (previous === null || previous[key] === value.fingerprint) { next[key] = value.fingerprint; continue; }
        const stable = now() - value.modified >= SETTLE_MS && value.size > 0 && value.size <= 25 * 1024 * 1024;
        const real = stable && submissions < MAX_UPLOADS ? await fs.realpath(value.file).catch(() => null) : null;
        if (real && path.relative(value.file, real) === '' && await ready(value.file)) {
          submissions++;
          if (await upload({ ...value, root, ownerId })) { next[key] = value.fingerprint; continue; }
        }
        if (previous[key]) next[key] = previous[key];
      }
      const pending = stateFile + '.tmp';
      await fs.writeFile(pending, JSON.stringify({ identity, files: next }), { mode: 0o600 });
      await fs.rename(pending, stateFile);
      previous = next;
    } finally { busy = false; }
  };
}

async function startApprovedOneDrive(options, { home = os.homedir(), env = process.env } = {}) {
  if (process.platform !== 'win32') return false;
  const dir = path.join(home, '.orbit');
  let approval;
  try { approval = JSON.parse(await fs.readFile(path.join(dir, 'work-drive-onedrive-approved.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (approval?.enabled !== true) return false;
  if (typeof approval.userId !== 'string' || !approval.userId || !relativeParts(approval.relativeRoot)) return true;
  const base = env.OneDriveCommercial;
  if (!base) return true;
  const root = await resolveWorkRoot(base, approval.relativeRoot);
  if (!root) return true;
  const poll = createApprovedPoll({ ...options, root, ownerId: approval.userId, stateFile: path.join(dir, 'work-drive-onedrive-checkpoint.json') });
  const tick = () => poll().catch(() => console.warn('[work-file-uploader] approved OneDrive scan unavailable'));
  void tick();
  setInterval(tick, INTERVAL_MS).unref?.();
  return true;
}

module.exports = { createApprovedPoll, locallyAvailable, resolveWorkRoot, startApprovedOneDrive };
