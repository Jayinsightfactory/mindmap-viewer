/**
 * orbit-agent.js
 * Orbit Agent SDK — 어떤 봇/스크립트든 Orbit 맵에 이벤트를 리포트
 *
 * 사용법:
 *   const orbit = require('./sdk/orbit-agent');
 *   const agent = orbit.createAgent({ name: 'my-bot', source: 'custom' });
 *   await agent.event('tool.end', { toolName: 'fetch', success: true });
 *
 * npm 패키지 사용 (미래):
 *   const { createAgent } = require('orbit-agent-sdk');
 */

const http  = require('http');
const https = require('https');
const { randomUUID } = require('crypto');

// ── 기본 설정 ────────────────────────────────────────
const DEFAULTS = {
  host:      'localhost',
  port:      4747,
  secure:    false,
  channel:   'default',
  source:    'custom',
  sessionId: null,   // null이면 자동 생성
};

// ── Agent 생성 ───────────────────────────────────────
function createAgent(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const sessionId = cfg.sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const memberId  = cfg.memberId  || randomUUID();

  // ── HTTP 이벤트 전송 ─────────────────────────────
  async function send(type, data = {}) {
    const payload = JSON.stringify({
      id:        randomUUID(),
      type,
      source:    cfg.source,
      sessionId,
      userId:    cfg.name || 'orbit-agent',
      channelId: cfg.channel,
      timestamp: new Date().toISOString(),
      data,
      metadata:  { aiSource: cfg.source, agentName: cfg.name },
    });

    return new Promise((resolve, reject) => {
      const lib  = cfg.secure ? https : http;
      const req  = lib.request({
        hostname: cfg.host,
        port:     cfg.port,
        path:     '/api/ai-event',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ── 공개 API ────────────────────────────────────
  return {
    sessionId,

    /** 임의 이벤트 전송 */
    async event(type, data = {}) {
      try { await send(type, data); } catch { /* silent fail */ }
    },

    /** 작업 시작 */
    async start(taskName, meta = {}) {
      await this.event('tool.start', { toolName: taskName, ...meta });
    },

    /** 작업 완료 */
    async done(taskName, meta = {}) {
      await this.event('tool.end', { toolName: taskName, success: true, ...meta });
    },

    /** 작업 실패 */
    async fail(taskName, error, meta = {}) {
      await this.event('tool.end', {
        toolName: taskName, success: false,
        error: error?.message || String(error), ...meta,
      });
    },

    /** 메시지 전송 */
    async message(content, meta = {}) {
      await this.event('assistant.message', { content, contentPreview: content.slice(0, 200), ...meta });
    },

    /** 파일 읽기 기록 */
    async readFile(filePath) {
      await this.event('file.read', { filePath, fileName: filePath.split('/').pop() });
    },

    /** 파일 쓰기 기록 */
    async writeFile(filePath) {
      await this.event('file.write', { filePath, fileName: filePath.split('/').pop() });
    },

    /** 세션 종료 */
    async end() {
      await this.event('session.end', {});
    },

    /**
     * 함수 래핑 — 자동으로 start/done/fail 이벤트 전송
     * @example
     *   const result = await agent.wrap('fetchData', async () => fetch(url));
     */
    async wrap(taskName, fn) {
      await this.start(taskName);
      try {
        const result = await fn();
        await this.done(taskName);
        return result;
      } catch (err) {
        await this.fail(taskName, err);
        throw err;
      }
    },
  };
}

// ── 전역 싱글톤 (간단한 사용) ────────────────────────
let _global = null;
function init(options = {}) {
  _global = createAgent(options);
  return _global;
}
function getAgent() {
  if (!_global) _global = createAgent();
  return _global;
}

module.exports = { createAgent, init, getAgent };
