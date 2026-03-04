'use strict';

/**
 * llm-gateway.js
 * 프로바이더별 API 차이를 추상화하는 통합 게이트웨이
 * generate({ provider, model, prompt, apiKey }) → Promise<string>
 */

const http  = require('http');
const https = require('https');

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

module.exports = { generate };
