'use strict';

/**
 * llm-gateway.js
 * 프로바이더별 API 차이를 추상화하는 통합 게이트웨이
 * generate({ provider, model, prompt, apiKey }) → Promise<string>
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

// ── CLIProxyAPI 설정 ──────────────────────────────────────────────────────────
// USE_MAX_PROXY=true → Claude Max 구독의 CLIProxyAPI를 통해 무료 API 호출
// USE_MAX_PROXY=false (기본) → 기존 프로바이더별 직접 API 호출
const USE_MAX_PROXY = process.env.USE_MAX_PROXY === 'true';
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'http://localhost:8080/v1';

// ── Ollama (로컬) ──────────────────────────────────────────────────────────────
function generateOllama({ model = 'orbit-insight:v1', prompt }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, prompt, stream: false,
      options: { temperature: 0.2, num_predict: 600 },
    });
    const req = http.request({
      hostname: 'localhost', port: 11434,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || ''); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────
async function generateAnthropic({ model, prompt, apiKey }) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const data = await httpsPost('api.anthropic.com', '/v1/messages', body, {
    'x-api-key':          apiKey,
    'anthropic-version':  '2023-06-01',
    'content-type':       'application/json',
    'content-length':     Buffer.byteLength(body),
  });
  return data.content?.[0]?.text || '';
}

// ── OpenAI (ChatGPT) ──────────────────────────────────────────────────────────
async function generateOpenAI({ model, prompt, apiKey }) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.2,
  });
  const data = await httpsPost('api.openai.com', '/v1/chat/completions', body, {
    'Authorization': `Bearer ${apiKey}`,
    'content-type':  'application/json',
    'content-length': Buffer.byteLength(body),
  });
  return data.choices?.[0]?.message?.content || '';
}

// ── Google (Gemini) ───────────────────────────────────────────────────────────
async function generateGemini({ model, prompt, apiKey }) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  });
  const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const data = await httpsPost('generativelanguage.googleapis.com', path, body, {
    'content-type':   'application/json',
    'content-length': Buffer.byteLength(body),
  });
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── xAI (Grok) — OpenAI 호환 API ────────────────────────────────────────────
async function generateXAI({ model, prompt, apiKey }) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.2,
  });
  const data = await httpsPost('api.x.ai', '/v1/chat/completions', body, {
    'Authorization':  `Bearer ${apiKey}`,
    'content-type':   'application/json',
    'content-length': Buffer.byteLength(body),
  });
  return data.choices?.[0]?.message?.content || '';
}

// ── CLIProxyAPI (OpenAI-compatible 포맷) ──────────────────────────────────────
function generateProxy({ model, prompt }) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1024,
    temperature: 0.2,
  });

  const parsed = new URL(`${PROXY_BASE_URL}/chat/completions`);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = parsed.port || (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsed.hostname,
      port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'Authorization':  'Bearer dummy',
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.error?.message || `Proxy HTTP ${res.statusCode}`;
            reject(new Error(msg));
          } else {
            resolve(parsed.choices?.[0]?.message?.content || '');
          }
        } catch {
          reject(new Error(`Proxy JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', e => {
      reject(new Error(`CLIProxyAPI 연결 실패 (${PROXY_BASE_URL}): ${e.message}`));
    });
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Proxy timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 공통 HTTPS POST ───────────────────────────────────────────────────────────
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.error?.message || parsed.message
              || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`;
            reject(new Error(msg));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 통합 진입점 ───────────────────────────────────────────────────────────────
async function generate({ provider = 'ollama', model, prompt, apiKey }) {
  // CLIProxyAPI 모드: 모든 요청을 프록시로 라우팅
  if (USE_MAX_PROXY && provider !== 'ollama') {
    const { PROVIDERS } = require('./llm-providers');
    const prov = PROVIDERS[provider];
    const m = model || (prov ? prov.defaultModel : 'claude-sonnet-4-5');
    return generateProxy({ model: m, prompt });
  }

  const { PROVIDERS } = require('./llm-providers');
  const prov = PROVIDERS[provider];
  if (!prov) throw new Error(`알 수 없는 프로바이더: ${provider}`);

  const m = model || prov.defaultModel;

  switch (provider) {
    case 'ollama':    return generateOllama({ model: m, prompt });
    case 'anthropic': return generateAnthropic({ model: m, prompt, apiKey });
    case 'openai':    return generateOpenAI({ model: m, prompt, apiKey });
    case 'google':    return generateGemini({ model: m, prompt, apiKey });
    case 'xai':       return generateXAI({ model: m, prompt, apiKey });
    default:          throw new Error(`미구현 프로바이더: ${provider}`);
  }
}

module.exports = { generate, USE_MAX_PROXY, PROXY_BASE_URL };
