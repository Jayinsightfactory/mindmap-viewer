'use strict';
/**
 * src/mcp-watcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * MCP Market Watcher
 *
 * 역할:
 *   1. Smithery.ai / MCP Hub 에서 신규 MCP 서버 자동 감지
 *   2. 로컬 ~/.config/claude/claude_desktop_config.json 설치 목록 파싱
 *   3. 인기도(stars/downloads) 기준 추천 생성
 *   4. 신규 서버 발견 시 broadcastAll 이벤트 발생
 *
 * 주요 API:
 *   GET /api/mcp-market/trending       — 인기 MCP 서버 목록
 *   GET /api/mcp-market/installed      — 로컬 설치 목록
 *   GET /api/mcp-market/recommend      — 사용 패턴 기반 추천
 *   POST /api/mcp-market/watch         — 특정 서버 watch 등록
 *   GET /api/mcp-market/watched        — watch 목록 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── 인메모리 상태 ─────────────────────────────────────────────────────────
const watchedServers  = new Map(); // serverId → { name, url, notifyOnUpdate }
const discoveredCache = new Map(); // serverId → serverInfo
let   _pollInterval   = null;
let   _broadcastAll   = null;

// ─── 알려진 MCP 서버 카탈로그 (오프라인 폴백 + 기본 데이터) ─────────────────
const KNOWN_MCP_SERVERS = [
  {
    id:          'filesystem',
    name:        'Filesystem',
    description: '로컬 파일 시스템 읽기/쓰기/검색',
    author:      'anthropics',
    category:    'utility',
    stars:       2800,
    downloads:   45000,
    npmPackage:  '@modelcontextprotocol/server-filesystem',
    tags:        ['files', 'read', 'write', 'search'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    true,
  },
  {
    id:          'github',
    name:        'GitHub',
    description: 'GitHub 이슈, PR, 코드 검색, 리포지토리 관리',
    author:      'anthropics',
    category:    'vcs',
    stars:       2100,
    downloads:   38000,
    npmPackage:  '@modelcontextprotocol/server-github',
    tags:        ['git', 'github', 'pr', 'issues'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    true,
  },
  {
    id:          'postgres',
    name:        'PostgreSQL',
    description: 'PostgreSQL DB 스키마 탐색 및 쿼리 실행',
    author:      'anthropics',
    category:    'database',
    stars:       1650,
    downloads:   28000,
    npmPackage:  '@modelcontextprotocol/server-postgres',
    tags:        ['database', 'sql', 'postgres'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    true,
  },
  {
    id:          'brave-search',
    name:        'Brave Search',
    description: 'Brave Search API를 통한 웹 검색',
    author:      'anthropics',
    category:    'search',
    stars:       1200,
    downloads:   22000,
    npmPackage:  '@modelcontextprotocol/server-brave-search',
    tags:        ['search', 'web', 'brave'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  {
    id:          'slack',
    name:        'Slack',
    description: 'Slack 채널 메시지 읽기 및 전송',
    author:      'anthropics',
    category:    'communication',
    stars:       980,
    downloads:   17000,
    npmPackage:  '@modelcontextprotocol/server-slack',
    tags:        ['slack', 'messaging', 'team'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  {
    id:          'memory',
    name:        'Memory',
    description: 'Knowledge graph 기반 AI 장기 기억 저장소',
    author:      'anthropics',
    category:    'memory',
    stars:       1800,
    downloads:   31000,
    npmPackage:  '@modelcontextprotocol/server-memory',
    tags:        ['memory', 'knowledge', 'graph', 'persistence'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    true,
  },
  {
    id:          'puppeteer',
    name:        'Puppeteer',
    description: '헤드리스 브라우저 자동화 (스크린샷, PDF, 크롤링)',
    author:      'anthropics',
    category:    'browser',
    stars:       1450,
    downloads:   25000,
    npmPackage:  '@modelcontextprotocol/server-puppeteer',
    tags:        ['browser', 'automation', 'screenshot', 'scraping'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  {
    id:          'sqlite',
    name:        'SQLite',
    description: 'SQLite DB 쿼리 및 분석 도구',
    author:      'anthropics',
    category:    'database',
    stars:       890,
    downloads:   16000,
    npmPackage:  '@modelcontextprotocol/server-sqlite',
    tags:        ['database', 'sqlite', 'sql'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  {
    id:          'google-maps',
    name:        'Google Maps',
    description: '지도 검색, 경로 안내, 장소 정보 조회',
    author:      'anthropics',
    category:    'geo',
    stars:       760,
    downloads:   13000,
    npmPackage:  '@modelcontextprotocol/server-google-maps',
    tags:        ['maps', 'geo', 'places', 'directions'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  {
    id:          'everything',
    name:        'Everything (Windows)',
    description: 'Everything 파일 검색 엔진 통합 (Windows)',
    author:      'anthropics',
    category:    'utility',
    stars:       540,
    downloads:   9000,
    npmPackage:  '@modelcontextprotocol/server-everything',
    tags:        ['search', 'files', 'windows'],
    githubUrl:   'https://github.com/modelcontextprotocol/servers',
    featured:    false,
  },
  // ── 커뮤니티 인기 서버 ──
  {
    id:          'mcp-obsidian',
    name:        'Obsidian Notes',
    description: 'Obsidian 볼트 읽기/쓰기, 노트 검색',
    author:      'community',
    category:    'notes',
    stars:       680,
    downloads:   12000,
    npmPackage:  'mcp-obsidian',
    tags:        ['notes', 'obsidian', 'markdown', 'pkm'],
    githubUrl:   'https://github.com/calclavia/mcp-obsidian',
    featured:    false,
  },
  {
    id:          'mcp-notion',
    name:        'Notion',
    description: 'Notion 페이지/DB 읽기, 생성, 업데이트',
    author:      'community',
    category:    'productivity',
    stars:       590,
    downloads:   10500,
    npmPackage:  '@suekou/mcp-notion-server',
    tags:        ['notion', 'notes', 'database', 'productivity'],
    githubUrl:   'https://github.com/suekou/mcp-notion-server',
    featured:    false,
  },
  {
    id:          'mcp-linear',
    name:        'Linear',
    description: 'Linear 이슈 트래커 통합 (이슈 생성, 업데이트)',
    author:      'community',
    category:    'project-management',
    stars:       420,
    downloads:   7800,
    npmPackage:  '@linear/mcp-server-linear',
    tags:        ['linear', 'issues', 'project', 'agile'],
    githubUrl:   'https://github.com/linear/linear',
    featured:    false,
  },
  {
    id:          'mcp-sentry',
    name:        'Sentry',
    description: 'Sentry 오류 추적 및 이슈 분석',
    author:      'community',
    category:    'monitoring',
    stars:       380,
    downloads:   6900,
    npmPackage:  'mcp-server-sentry',
    tags:        ['sentry', 'errors', 'monitoring', 'debug'],
    githubUrl:   'https://github.com/mcp-servers/sentry',
    featured:    false,
  },
  {
    id:          'mcp-redis',
    name:        'Redis',
    description: 'Redis 캐시 읽기/쓰기, 키 조회',
    author:      'community',
    category:    'database',
    stars:       310,
    downloads:   5700,
    npmPackage:  'mcp-redis',
    tags:        ['redis', 'cache', 'database', 'keyvalue'],
    githubUrl:   'https://github.com/redis/mcp-redis',
    featured:    false,
  },
];

// 캐시 초기화
KNOWN_MCP_SERVERS.forEach(s => discoveredCache.set(s.id, { ...s, source: 'catalog', fetchedAt: new Date().toISOString() }));

// ─── 로컬 설치 목록 파싱 ───────────────────────────────────────────────────

/**
 * Claude Desktop 설정 파일에서 설치된 MCP 서버 목록 파싱
 */
function getInstalledServers() {
  const configPaths = [
    // macOS
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    // Linux
    path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json'),
    // Windows
    path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
  ];

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw    = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      const mcpServers = config.mcpServers || {};

      return Object.entries(mcpServers).map(([name, cfg]) => ({
        name,
        command: cfg.command || '',
        args:    cfg.args    || [],
        env:     cfg.env ? Object.keys(cfg.env) : [],
        configPath,
      }));
    } catch {
      continue;
    }
  }
  return [];
}

// ─── 추천 엔진 ────────────────────────────────────────────────────────────

/**
 * 사용 이벤트 기반 MCP 서버 추천
 * @param {Function} getAllEvents
 * @returns {Array}
 */
function getRecommendations(getAllEvents) {
  const events   = getAllEvents ? getAllEvents() : [];
  const installed = new Set(getInstalledServers().map(s => s.name));

  // 이벤트 소스/타입 분석
  const sourceCount = {};
  const toolCount   = {};
  for (const ev of events) {
    if (ev.source) sourceCount[ev.source] = (sourceCount[ev.source] || 0) + 1;
    if (ev.type)   toolCount[ev.type]     = (toolCount[ev.type]   || 0) + 1;
  }

  // 추천 로직: 사용 패턴과 카테고리 매칭
  const scored = [];
  for (const server of discoveredCache.values()) {
    if (installed.has(server.id) || installed.has(server.npmPackage)) continue;

    let score = server.stars / 100; // 기본 인기도

    // 패턴 매칭 보너스
    if (server.tags.includes('github')   && (sourceCount['cursor'] || sourceCount['vscode'])) score += 30;
    if (server.tags.includes('database') && events.some(e => e.data?.includes?.('sql')))       score += 20;
    if (server.tags.includes('search')   && toolCount['web_search'])                           score += 25;
    if (server.tags.includes('files')    && toolCount['Read'])                                 score += 20;
    if (server.tags.includes('slack')    && sourceCount['slack'])                              score += 40;
    if (server.tags.includes('notion')   && sourceCount['notion'])                             score += 40;
    if (server.featured)                                                                       score += 15;

    scored.push({ ...server, recommendScore: Math.round(score) });
  }

  return scored
    .sort((a, b) => b.recommendScore - a.recommendScore)
    .slice(0, 10);
}

// ─── Smithery API 폴링 (가능한 경우) ─────────────────────────────────────

async function fetchSmitheryTrending() {
  try {
    const res = await fetch('https://smithery.ai/api/servers?sort=trending&limit=20', {
      signal:  AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'OrbitAI/2.0 MCP-Watcher' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.servers || data.items || data || null;
  } catch {
    return null; // 오프라인 또는 API 변경 시 조용히 폴백
  }
}

async function pollMarket(broadcastAllFn) {
  const remote = await fetchSmitheryTrending();
  if (!remote || !Array.isArray(remote)) return;

  let newCount = 0;
  for (const item of remote) {
    const id   = item.id || item.name || item.slug;
    const isNew = !discoveredCache.has(id);

    discoveredCache.set(id, {
      id,
      name:        item.name        || id,
      description: item.description || '',
      author:      item.author      || 'community',
      category:    item.category    || 'other',
      stars:       item.stars       || item.starCount || 0,
      downloads:   item.downloads   || item.installCount || 0,
      npmPackage:  item.npmPackage  || item.package || '',
      tags:        item.tags        || [],
      githubUrl:   item.githubUrl   || item.url || '',
      featured:    item.featured    || false,
      source:      'smithery',
      fetchedAt:   new Date().toISOString(),
    });

    if (isNew) newCount++;
  }

  if (newCount > 0 && broadcastAllFn) {
    broadcastAllFn({ type: 'mcp_market_update', newServers: newCount, totalServers: discoveredCache.size });
    console.log(`[MCPWatcher] 신규 MCP 서버 ${newCount}개 발견 (총 ${discoveredCache.size}개)`);
  }
}

// ─── 스케줄러 ─────────────────────────────────────────────────────────────

function start({ broadcastAll, pollIntervalMs = 3600000 } = {}) {
  if (_pollInterval) return;
  _broadcastAll = broadcastAll;

  // 즉시 1회 실행
  pollMarket(broadcastAll).catch(() => {});

  // 이후 1시간마다 실행
  _pollInterval = setInterval(() => pollMarket(broadcastAll), pollIntervalMs);
  _pollInterval.unref?.();

  console.log('[MCPWatcher] MCP 마켓 감시 시작 (1시간 간격)');
}

function stop() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

// ─── Express 라우터 팩토리 ────────────────────────────────────────────────

const express = require('express');

function createMcpWatcherRouter({ getAllEvents } = {}) {
  const router = express.Router();

  // ── 트렌딩 MCP 서버 목록 ──────────────────────────────────────────────
  router.get('/mcp-market/trending', (req, res) => {
    const { category, limit = 20, search } = req.query;
    let servers = [...discoveredCache.values()];

    if (category) servers = servers.filter(s => s.category === category);
    if (search) {
      const q = search.toLowerCase();
      servers = servers.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.tags || []).some(t => t.includes(q))
      );
    }

    servers.sort((a, b) => (b.stars + b.downloads / 10) - (a.stars + a.downloads / 10));

    res.json({
      servers:     servers.slice(0, Math.min(parseInt(limit) || 20, 100)),
      total:       servers.length,
      lastUpdated: new Date().toISOString(),
      categories:  [...new Set(servers.map(s => s.category))].sort(),
    });
  });

  // ── 로컬 설치 목록 ────────────────────────────────────────────────────
  router.get('/mcp-market/installed', (req, res) => {
    const installed = getInstalledServers();
    // 카탈로그 정보 병합
    const enriched = installed.map(s => ({
      ...s,
      catalogInfo: discoveredCache.get(s.name) || discoveredCache.get(s.args?.[0]) || null,
    }));
    res.json({ installed: enriched, count: enriched.length });
  });

  // ── 추천 서버 ─────────────────────────────────────────────────────────
  router.get('/mcp-market/recommend', (req, res) => {
    const recommendations = getRecommendations(getAllEvents);
    res.json({ recommendations, count: recommendations.length });
  });

  // ── 서버 상세 정보 ────────────────────────────────────────────────────
  router.get('/mcp-market/server/:id', (req, res) => {
    const server = discoveredCache.get(req.params.id);
    if (!server) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
    res.json(server);
  });

  // ── Watch 등록 ────────────────────────────────────────────────────────
  router.post('/mcp-market/watch', (req, res) => {
    const { serverId, notifyOnUpdate = true } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId 필드가 필요합니다.' });

    const server = discoveredCache.get(serverId);
    watchedServers.set(serverId, {
      serverId,
      name:           server?.name || serverId,
      notifyOnUpdate,
      watchedAt:      new Date().toISOString(),
    });
    res.json({ success: true, watched: watchedServers.size });
  });

  // ── Watch 해제 ────────────────────────────────────────────────────────
  router.delete('/mcp-market/watch/:id', (req, res) => {
    watchedServers.delete(req.params.id);
    res.json({ success: true });
  });

  // ── Watch 목록 ────────────────────────────────────────────────────────
  router.get('/mcp-market/watched', (req, res) => {
    const list = [...watchedServers.values()].map(w => ({
      ...w,
      serverInfo: discoveredCache.get(w.serverId) || null,
    }));
    res.json({ watched: list, count: list.length });
  });

  // ── 수동 폴링 트리거 ──────────────────────────────────────────────────
  router.post('/mcp-market/refresh', async (req, res) => {
    try {
      await pollMarket(_broadcastAll);
      res.json({ success: true, totalServers: discoveredCache.size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 카탈로그 통계 ─────────────────────────────────────────────────────
  router.get('/mcp-market/stats', (req, res) => {
    const servers    = [...discoveredCache.values()];
    const categories = {};
    let   totalStars = 0;

    for (const s of servers) {
      categories[s.category] = (categories[s.category] || 0) + 1;
      totalStars += (s.stars || 0);
    }

    res.json({
      total:         servers.length,
      watched:       watchedServers.size,
      installed:     getInstalledServers().length,
      totalStars,
      categories,
      sources:       [...new Set(servers.map(s => s.source))],
    });
  });

  return router;
}

module.exports = {
  start,
  stop,
  getInstalledServers,
  getRecommendations,
  createMcpWatcherRouter,
};
