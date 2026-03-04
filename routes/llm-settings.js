'use strict';

/**
 * routes/llm-settings.js
 * LLM 프로바이더 API 키 관리 + 연결 테스트 + 모델 목록
 *
 * GET    /api/llm-settings/providers         → 전체 프로바이더 목록 (등록 여부 포함)
 * GET    /api/llm-settings/ollama-models     → 로컬 Ollama 모델 목록
 * GET    /api/llm-settings/keys              → 등록된 키 목록 (마스킹)
 * POST   /api/llm-settings/keys              → API 키 저장/갱신
 * DELETE /api/llm-settings/keys/:provider    → API 키 삭제
 * PATCH  /api/llm-settings/keys/:provider/toggle → 활성/비활성 토글
 * POST   /api/llm-settings/test              → 연결 테스트
 * POST   /api/llm-settings/generate          → LLM 호출 (exec 패널에서 사용)
 */

const { Router } = require('express');
const crypto     = require('crypto');
const http       = require('http');
const { PROVIDERS } = require('../src/llm-providers');
const { generate }  = require('../src/llm-gateway');

// ── AES-256 암호화 (API 키 at-rest 보호) ──────────────────────────────────────
const RAW_KEY = (process.env.ORBIT_ENCRYPTION_KEY || 'orbit-llm-encryption-key-32chars!').slice(0, 32).padEnd(32, '0');
const KEY_BUF = Buffer.from(RAW_KEY, 'utf8');

function encryptKey(text) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY_BUF, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptKey(enc) {
  try {
    const [ivHex, dataHex] = enc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', KEY_BUF, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.slice(0, 6) + '••••••••' + key.slice(-4);
}

// ── DB 초기화 ──────────────────────────────────────────────────────────────────
function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_api_configs (
      id           TEXT PRIMARY KEY,
      userId       TEXT NOT NULL DEFAULT 'local',
      provider     TEXT NOT NULL,
      apiKeyEnc    TEXT NOT NULL,
      defaultModel TEXT,
      enabled      INTEGER DEFAULT 1,
      createdAt    TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_provider
      ON user_api_configs(userId, provider);
  `);
}

// ── 라우터 ────────────────────────────────────────────────────────────────────
module.exports = function createLlmSettingsRouter({ getDb }) {
  const router = Router();

  // GET /api/llm-settings/providers
  router.get('/llm-settings/providers', (req, res) => {
    try {
      const db = getDb();
      ensureTable(db);
      const rows = db.prepare(
        `SELECT provider, defaultModel, enabled FROM user_api_configs WHERE userId='local'`
      ).all();
      const cfgMap = {};
      rows.forEach(r => (cfgMap[r.provider] = r));

      const providers = Object.entries(PROVIDERS).map(([key, prov]) => ({
        provider:     key,
        icon:         prov.icon,
        name:         prov.name,
        requiresKey:  prov.requiresKey,
        description:  prov.description,
        keyHint:      prov.keyHint || '',
        models:       prov.models === 'dynamic' ? [] : prov.models,
        isDynamic:    prov.models === 'dynamic',
        defaultModel: cfgMap[key]?.defaultModel || prov.defaultModel || '',
        enabled:      key === 'ollama' ? true : Boolean(cfgMap[key]?.enabled),
        configured:   key === 'ollama' ? true : Boolean(cfgMap[key]),
      }));

      res.json({ providers });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/llm-settings/ollama-models
  router.get('/llm-settings/ollama-models', async (req, res) => {
    try {
      const data = await new Promise((resolve, reject) => {
        const r = http.get('http://localhost:11434/api/tags', resp => {
          let d = '';
          resp.on('data', c => (d += c));
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
        });
        r.on('error', reject);
        r.setTimeout(3000, () => { r.destroy(); reject(new Error('Ollama not running')); });
      });
      const models = (data.models || []).map(m => ({
        id: m.name, label: m.name,
        size: m.size ? `${(m.size / 1e9).toFixed(1)}GB` : '',
      }));
      res.json({ models, running: true });
    } catch (e) {
      res.json({ models: [], running: false, error: e.message });
    }
  });

  // GET /api/llm-settings/keys
  router.get('/llm-settings/keys', (req, res) => {
    try {
      const db = getDb();
      ensureTable(db);
      const rows = db.prepare(
        `SELECT id, provider, apiKeyEnc, defaultModel, enabled, createdAt
         FROM user_api_configs WHERE userId='local'`
      ).all();
      const result = rows.map(r => ({
        ...r,
        apiKeyMasked: maskKey(decryptKey(r.apiKeyEnc)),
        apiKeyEnc:    undefined,
      }));
      res.json({ keys: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/llm-settings/keys
  router.post('/llm-settings/keys', (req, res) => {
    const { provider, apiKey, defaultModel } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: 'provider, apiKey 필수' });
    if (!PROVIDERS[provider]) return res.status(400).json({ error: `알 수 없는 provider: ${provider}` });
    try {
      const db  = getDb();
      ensureTable(db);
      const enc  = encryptKey(apiKey.trim());
      const dMod = defaultModel || PROVIDERS[provider].defaultModel || '';
      db.prepare(`
        INSERT INTO user_api_configs(id, userId, provider, apiKeyEnc, defaultModel, enabled)
        VALUES(?, 'local', ?, ?, ?, 1)
        ON CONFLICT(userId, provider) DO UPDATE SET
          apiKeyEnc=excluded.apiKeyEnc,
          defaultModel=excluded.defaultModel,
          enabled=1
      `).run(`${provider}-local`, provider, enc, dMod);
      res.json({ ok: true, provider });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/llm-settings/keys/:provider
  router.delete('/llm-settings/keys/:provider', (req, res) => {
    try {
      const db = getDb();
      ensureTable(db);
      db.prepare(`DELETE FROM user_api_configs WHERE userId='local' AND provider=?`)
        .run(req.params.provider);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/llm-settings/keys/:provider/toggle
  router.patch('/llm-settings/keys/:provider/toggle', (req, res) => {
    try {
      const db = getDb();
      ensureTable(db);
      db.prepare(`UPDATE user_api_configs SET enabled = 1 - enabled WHERE userId='local' AND provider=?`)
        .run(req.params.provider);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/llm-settings/test
  router.post('/llm-settings/test', async (req, res) => {
    const { provider, apiKey: rawKey, model } = req.body;
    if (!provider) return res.status(400).json({ error: 'provider 필수' });

    let apiKey = rawKey || '';
    if (!apiKey && provider !== 'ollama') {
      const db  = getDb();
      ensureTable(db);
      const row = db.prepare(
        `SELECT apiKeyEnc FROM user_api_configs WHERE userId='local' AND provider=?`
      ).get(provider);
      if (!row) return res.status(404).json({ ok: false, error: 'API 키가 등록되지 않았습니다' });
      apiKey = decryptKey(row.apiKeyEnc);
    }

    const testModel = model || PROVIDERS[provider]?.defaultModel || '';
    try {
      const text = await generate({
        provider, model: testModel,
        prompt: '연결 테스트입니다. "OK"라고만 답하세요.',
        apiKey,
      });
      res.json({ ok: true, response: text.slice(0, 120), model: testModel });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/llm-settings/generate  (exec 패널 → LLM 호출)
  router.post('/llm-settings/generate', async (req, res) => {
    const { provider = 'ollama', model, prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt 필수' });

    let apiKey = '';
    if (provider !== 'ollama') {
      const db  = getDb();
      ensureTable(db);
      const row = db.prepare(
        `SELECT apiKeyEnc FROM user_api_configs WHERE userId='local' AND provider=? AND enabled=1`
      ).get(provider);
      if (!row) return res.status(403).json({ error: `${provider} API 키가 없거나 비활성 상태입니다` });
      apiKey = decryptKey(row.apiKeyEnc);
    }

    const m = model || PROVIDERS[provider]?.defaultModel || '';
    try {
      const text = await generate({ provider, model: m, prompt, apiKey });
      res.json({ ok: true, text, provider, model: m });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
