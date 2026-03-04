/**
 * src/mcp-server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit Personal Context MCP 서버
 *
 * 역할:
 *   Claude가 MCP 프로토콜로 Orbit에 접속해서 개인 작업 패턴, 이력, outcome을
 *   읽고 개인화 추론에 활용할 수 있도록 MCP Tools + Resources를 노출한다.
 *
 * 아키텍처:
 *   - HTTP transport (stateless) — Express 라우터로 POST /api/mcp 마운트
 *   - 요청마다 새 McpServer 인스턴스 생성 (stateless 방식)
 *   - MCP_AUTH_TOKEN 환경변수 없으면 localhost 전용으로 인증 없이 통과
 *
 * Tools (4개):
 *   get_work_context  — 최근 N일 작업 패턴 요약
 *   get_patterns      — 반복 패턴 + 자동화 제안
 *   search_events     — 키워드로 과거 이벤트 검색
 *   save_outcome      — 세션 결과 저장 (유일한 쓰기 tool)
 *
 * Resources (5개):
 *   orbit://stats           — 전체 통계
 *   orbit://insights        — 인사이트 목록
 *   orbit://sessions        — 세션 목록
 *   orbit://events/recent   — 최근 이벤트 50개
 *   orbit://context         — 작업 패턴 요약 (자연어)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const { McpServer }                      = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport }  = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

/**
 * @param {object} deps
 * @param {Function} deps.getAllEvents    - () → Event[]
 * @param {Function} deps.getStats        - () → Stats
 * @param {Function} deps.getSessions     - () → Session[]
 * @param {Function} deps.getInsights     - (limit?) → Insight[]
 * @param {Function} deps.getPatterns     - (opts?) → Pattern[]
 * @param {Function} deps.getSuggestions  - (opts?) → Suggestion[]
 * @param {Function} deps.getOutcomes     - (opts?) → Outcome[]
 * @param {Function} deps.saveOutcome     - (params) → { id }
 * @param {Function} deps.analyzeEvents   - (events) → Insight[]
 * @param {Function} deps.searchEvents    - (query) → Event[]
 * @returns {express.Router}
 */
function createMcpRouter(deps) {
  const {
    getAllEvents, getStats, getSessions, getInsights,
    getPatterns, getSuggestions, getOutcomes, saveOutcome,
    analyzeEvents, searchEvents,
  } = deps;

  const router = express.Router();

  // ── 인증 헬퍼 ───────────────────────────────────────────────────────────────
  function checkAuth(req) {
    const required = process.env.MCP_AUTH_TOKEN;
    if (!required) return true; // 토큰 미설정 = 로컬 전용 허용

    const header = req.headers.authorization || '';
    const token  = header.replace(/^Bearer\s+/i, '');
    if (!token) return false;

    // 타이밍 어택 방지
    try {
      const reqBuf = Buffer.from(token);
      const refBuf = Buffer.from(required);
      if (reqBuf.length !== refBuf.length) return false;
      return crypto.timingSafeEqual(reqBuf, refBuf);
    } catch {
      return false;
    }
  }

  // ── MCP 서버 팩토리 ──────────────────────────────────────────────────────────
  function buildMcpServer() {
    const server = new McpServer({
      name:    'orbit',
      version: '1.0.0',
    });

    // ────────────────────────────────────────────────────────────────────────
    // RESOURCES
    // ────────────────────────────────────────────────────────────────────────

    // orbit://stats — 전체 통계
    server.resource('stats', 'orbit://stats', async () => {
      const stats = getStats();
      return {
        contents: [{
          uri:      'orbit://stats',
          mimeType: 'application/json',
          text:     JSON.stringify(stats, null, 2),
        }],
      };
    });

    // orbit://insights — 최근 인사이트 목록
    server.resource('insights', 'orbit://insights', async () => {
      const insights = getInsights(20);
      return {
        contents: [{
          uri:      'orbit://insights',
          mimeType: 'application/json',
          text:     JSON.stringify(insights, null, 2),
        }],
      };
    });

    // orbit://sessions — 세션 목록
    server.resource('sessions', 'orbit://sessions', async () => {
      const sessions = getSessions();
      return {
        contents: [{
          uri:      'orbit://sessions',
          mimeType: 'application/json',
          text:     JSON.stringify(sessions.slice(0, 30), null, 2),
        }],
      };
    });

    // orbit://events/recent — 최근 이벤트 50개
    server.resource('events-recent', 'orbit://events/recent', async () => {
      const all    = getAllEvents();
      const recent = all.slice(-50).map(ev => ({
        id:        ev.id,
        type:      ev.type,
        sessionId: ev.sessionId,
        aiSource:  ev.aiSource,
        timestamp: ev.timestamp,
        label:     ev.data?.toolName || ev.data?.fileName || ev.type,
      }));
      return {
        contents: [{
          uri:      'orbit://events/recent',
          mimeType: 'application/json',
          text:     JSON.stringify(recent, null, 2),
        }],
      };
    });

    // orbit://context — 작업 패턴 요약 (자연어)
    server.resource('context', 'orbit://context', async () => {
      const text = buildContextSummary();
      return {
        contents: [{
          uri:      'orbit://context',
          mimeType: 'text/plain',
          text,
        }],
      };
    });

    // ────────────────────────────────────────────────────────────────────────
    // TOOLS
    // ────────────────────────────────────────────────────────────────────────

    // get_work_context — 최근 N일 작업 패턴 요약
    server.tool(
      'get_work_context',
      '최근 N일간의 작업 패턴, 인사이트, outcome을 요약해서 반환합니다. 개인화 추론에 활용하세요.',
      { days: z.number().min(1).max(90).optional().describe('분석 기간 (일). 기본값: 7') },
      async ({ days = 7 }) => {
        const cutoff  = Date.now() - days * 24 * 60 * 60 * 1000;
        const all     = getAllEvents();
        const recent  = all.filter(ev => {
          const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
          return ts >= cutoff;
        });

        const stats    = getStats();
        const insights = analyzeEvents(recent);
        const outcomes = getOutcomes({ limit: 10 });

        // 피크 시간대
        const peakHour = insights.find(i => i.type === 'peak_hour')?.data?.peakHour;

        // 핫 파일
        const hotFiles = (insights.find(i => i.type === 'hot_files')?.data?.hotFiles || [])
          .slice(0, 5)
          .map(([f]) => f.split('/').pop());

        // 상위 도구
        const toolCounts = {};
        recent.filter(e => e.type === 'tool.end').forEach(e => {
          const t = e.data?.toolName || 'unknown';
          toolCounts[t] = (toolCounts[t] || 0) + 1;
        });
        const topTools = Object.entries(toolCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([t]) => t);

        // 에러율
        const toolEvents  = recent.filter(e => e.type?.startsWith('tool.'));
        const errorEvents = recent.filter(e => e.type === 'tool.error');
        const errorRate   = toolEvents.length > 0
          ? Math.round(errorEvents.length / toolEvents.length * 100) + '%'
          : '0%';

        const context = {
          period:         `최근 ${days}일`,
          totalEvents:    recent.length,
          peakHour:       peakHour !== undefined ? `${peakHour}시` : null,
          hotFiles,
          topTools,
          errorRate,
          aiSourceStats:  stats.aiSourceStats,
          recentOutcomes: outcomes.slice(0, 5),
          insights:       insights.map(i => ({ type: i.type, title: i.title, body: i.body })),
        };

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(context, null, 2),
          }],
        };
      }
    );

    // get_patterns — 반복 패턴 + 제안 목록
    server.tool(
      'get_patterns',
      '반복적으로 감지된 작업 패턴과 자동화 제안을 반환합니다.',
      {
        limit: z.number().min(1).max(50).optional().describe('최대 반환 수. 기본값: 10'),
      },
      async ({ limit = 10 }) => {
        const patterns    = getPatterns({ limit });
        const suggestions = getSuggestions({ limit });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ patterns, suggestions }, null, 2),
          }],
        };
      }
    );

    // search_events — 키워드로 과거 이벤트 검색
    server.tool(
      'search_events',
      '키워드로 과거 작업 이벤트를 검색합니다. 특정 파일, 도구, 메시지를 기억하고 싶을 때 사용하세요.',
      {
        query: z.string().min(1).describe('검색 키워드'),
        limit: z.number().min(1).max(50).optional().describe('최대 반환 수. 기본값: 20'),
      },
      async ({ query, limit = 20 }) => {
        const results = searchEvents(query).slice(0, limit).map(ev => ({
          id:        ev.id,
          type:      ev.type,
          sessionId: ev.sessionId,
          timestamp: ev.timestamp,
          label:     ev.data?.toolName || ev.data?.fileName || ev.type,
          preview:   ev.data?.contentPreview || ev.data?.inputPreview || '',
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ query, count: results.length, results }, null, 2),
          }],
        };
      }
    );

    // save_outcome — 세션 결과 저장 (유일한 쓰기 tool)
    server.tool(
      'save_outcome',
      '현재 작업 세션의 목표와 결과를 기록합니다. "오늘 이 작업 성공했어" 같은 말을 들으면 이 tool을 호출하세요.',
      {
        goal:       z.string().min(1).describe('작업 목표 (예: "로그인 버그 수정")'),
        result:     z.enum(['success', 'partial', 'abandoned']).describe('결과: success(성공) / partial(부분성공) / abandoned(포기)'),
        sessionId:  z.string().optional().describe('연결할 세션 ID (선택)'),
        summary:    z.string().optional().describe('추가 메모 (선택)'),
        tags:       z.array(z.string()).optional().describe('태그 목록 (선택, 예: ["auth", "bugfix"])'),
        durationMin: z.number().optional().describe('소요 시간 (분, 선택)'),
      },
      async (args) => {
        const saved = saveOutcome({
          sessionId:   args.sessionId,
          userId:      'local',
          goal:        args.goal,
          result:      args.result,
          summary:     args.summary,
          tags:        args.tags || [],
          durationMin: args.durationMin,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok:      true,
              id:      saved.id,
              message: `결과가 저장됐습니다. (${args.result}: ${args.goal})`,
            }),
          }],
        };
      }
    );

    return server;
  }

  // ── 컨텍스트 요약 생성 ───────────────────────────────────────────────────────
  function buildContextSummary() {
    const stats    = getStats();
    const insights = getInsights(5);
    const outcomes = getOutcomes({ limit: 5 });
    const sessions = getSessions().slice(0, 5);

    const lines = [
      '# Orbit — 내 작업 컨텍스트 요약',
      '',
      `## 전체 통계`,
      `- 총 이벤트: ${stats.eventCount}개`,
      `- 세션 수: ${stats.sessionCount}개`,
      `- 파일 수: ${stats.fileCount}개`,
      `- AI 도구 사용: ${JSON.stringify(stats.aiSourceStats)}`,
      '',
    ];

    if (insights.length > 0) {
      lines.push('## 최근 인사이트');
      insights.forEach(i => lines.push(`- **${i.title}**: ${i.body}`));
      lines.push('');
    }

    if (outcomes.length > 0) {
      lines.push('## 최근 작업 결과');
      outcomes.forEach(o => {
        const emoji = o.result === 'success' ? '✅' : o.result === 'partial' ? '⚠️' : '❌';
        lines.push(`- ${emoji} ${o.goal} (${o.result}) — ${o.createdAt?.slice(0, 10) || '날짜 미상'}`);
      });
      lines.push('');
    }

    if (sessions.length > 0) {
      lines.push('## 최근 세션');
      sessions.forEach(s => {
        lines.push(`- 세션 ${s.id?.slice(0, 8)}... | 이벤트 ${s.event_count || 0}개 | ${s.started_at?.slice(0, 16) || ''}`);
      });
    }

    return lines.join('\n');
  }

  // ── POST /api/mcp ─────────────────────────────────────────────────────────
  router.post('/mcp', async (req, res) => {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: 'unauthorized', hint: 'MCP_AUTH_TOKEN을 Bearer 토큰으로 전달하세요' });
    }

    try {
      const server    = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] 처리 오류:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', message: err.message });
      }
    }
  });

  // GET /api/mcp — 연결 상태 확인 (curl 테스트용)
  router.get('/mcp', (req, res) => {
    res.json({
      name:      'orbit-mcp',
      version:   '1.0.0',
      transport: 'streamable-http',
      endpoint:  'POST /api/mcp',
      tools:     ['get_work_context', 'get_patterns', 'search_events', 'save_outcome'],
      resources: ['orbit://stats', 'orbit://insights', 'orbit://sessions', 'orbit://events/recent', 'orbit://context'],
      auth:      process.env.MCP_AUTH_TOKEN ? 'required' : 'none (localhost only)',
    });
  });

  return router;
}

module.exports = createMcpRouter;
