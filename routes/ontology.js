'use strict';
/**
 * routes/ontology.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Team Ontology Graph
 *
 * 파일 의존성 + 팀 오너십 + AI 히스토리를 하나의 그래프로 통합
 *
 * GET  /api/ontology                   — 전체 온톨로지 그래프
 * GET  /api/ontology/files             — 파일 의존성 서브그래프
 * GET  /api/ontology/ownership         — 팀 오너십 맵
 * GET  /api/ontology/ai-history/:file  — 파일별 AI 히스토리
 * GET  /api/ontology/hotspots          — 변경 빈도 핫스팟
 * GET  /api/ontology/clusters          — 자동 클러스터링
 * POST /api/ontology/ownership         — 오너십 수동 설정
 * GET  /api/ontology/search            — 온톨로지 검색
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const path    = require('path');

// ─── 오너십 저장소 (인메모리) ─────────────────────────────────────────────────
const ownershipMap = new Map(); // filePath → { owner, team, since }

// ─── 파일 확장자 → 언어 매핑 ─────────────────────────────────────────────────
const EXT_LANG = {
  '.js': 'JavaScript', '.ts': 'TypeScript', '.jsx': 'React JSX', '.tsx': 'React TSX',
  '.py': 'Python',     '.rb': 'Ruby',       '.go':  'Go',         '.rs':  'Rust',
  '.java': 'Java',     '.cs': 'C#',         '.cpp': 'C++',        '.c':   'C',
  '.html': 'HTML',     '.css': 'CSS',       '.scss': 'SCSS',      '.sql': 'SQL',
  '.json': 'JSON',     '.yaml': 'YAML',     '.yml': 'YAML',       '.md':  'Markdown',
  '.sh':  'Shell',     '.dockerfile': 'Docker',
};

function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_LANG[ext] || 'Other';
}

// ─── 이벤트에서 온톨로지 그래프 빌드 ─────────────────────────────────────────

function buildOntologyGraph(events = []) {
  const fileNodes  = new Map(); // filePath → node
  const fileEdges  = [];        // { source, target, type, weight }
  const toolNodes  = new Map(); // toolType → node
  const userNodes  = new Map(); // userId → node

  // 1회차: 파일 노드 수집
  for (const ev of events) {
    const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || '');

    // 파일 경로 추출 (간단한 패턴)
    const filePaths = [
      ...(dataStr.match(/["']([^"']+\.[a-zA-Z]{1,5})["']/g) || []),
      ...(dataStr.match(/(?:file|path|filename)["']?\s*[:=]\s*["']([^"']+)["']/gi) || []),
    ].map(m => m.replace(/["']/g, '').replace(/^(?:file|path|filename)\s*[:=]\s*/i, '').trim())
     .filter(p => p.includes('/') || p.includes('\\'))
     .filter(p => !p.startsWith('http'))
     .map(p => {
        // 경로 단순화: 마지막 3 컴포넌트만 유지
        const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts.slice(-3).join('/');
      })
     .filter(p => p.length > 0 && p.length < 100);

    for (const fp of filePaths) {
      if (!fileNodes.has(fp)) {
        fileNodes.set(fp, {
          id:        `file:${fp}`,
          label:     path.basename(fp),
          fullPath:  fp,
          type:      'file',
          language:  getLanguage(fp),
          events:    0,
          aiTouches: 0,
          lastSeen:  null,
          owner:     ownershipMap.get(fp)?.owner || null,
          team:      ownershipMap.get(fp)?.team  || null,
        });
      }
      const node = fileNodes.get(fp);
      node.events++;
      if (ev.source && ev.source !== 'user') node.aiTouches++;
      if (!node.lastSeen || ev.timestamp > node.lastSeen) node.lastSeen = ev.timestamp;
    }

    // 도구 노드
    if (ev.type) {
      if (!toolNodes.has(ev.type)) {
        toolNodes.set(ev.type, { id: `tool:${ev.type}`, label: ev.type, type: 'tool', uses: 0 });
      }
      toolNodes.get(ev.type).uses++;
    }

    // 사용자 노드
    if (ev.userId && ev.userId !== 'webhook') {
      if (!userNodes.has(ev.userId)) {
        userNodes.set(ev.userId, { id: `user:${ev.userId}`, label: ev.userId, type: 'user', events: 0 });
      }
      userNodes.get(ev.userId).events++;
    }
  }

  // 2회차: 파일 공동 편집 엣지 (같은 세션에 함께 등장하는 파일들)
  const sessionFiles = new Map(); // sessionId → Set<filePath>
  for (const ev of events) {
    const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || '');
    const filePaths = [...fileNodes.keys()].filter(fp => dataStr.includes(fp));
    if (filePaths.length > 0 && ev.sessionId) {
      if (!sessionFiles.has(ev.sessionId)) sessionFiles.set(ev.sessionId, new Set());
      filePaths.forEach(fp => sessionFiles.get(ev.sessionId).add(fp));
    }
  }

  const edgeWeights = new Map();
  for (const fps of sessionFiles.values()) {
    const arr = [...fps];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('||');
        edgeWeights.set(key, (edgeWeights.get(key) || 0) + 1);
      }
    }
  }

  for (const [key, weight] of edgeWeights) {
    if (weight < 2) continue; // 1회성 공동 편집은 노이즈
    const [src, tgt] = key.split('||');
    fileEdges.push({ source: `file:${src}`, target: `file:${tgt}`, type: 'co-edited', weight });
  }

  const nodes = [
    ...fileNodes.values(),
    ...toolNodes.values(),
    ...userNodes.values(),
  ];
  const edges = fileEdges;

  return { nodes, edges, summary: { files: fileNodes.size, tools: toolNodes.size, users: userNodes.size, edges: edges.length } };
}

// ─── 클러스터링 (간단한 커뮤니티 감지) ──────────────────────────────────────

function clusterNodes(nodes, edges) {
  // 언어 기반 1차 클러스터링
  const clusters = {};
  for (const node of nodes) {
    if (node.type !== 'file') continue;
    const key = node.language || 'Other';
    if (!clusters[key]) clusters[key] = { id: key, label: key, files: [], totalEvents: 0 };
    clusters[key].files.push(node.id);
    clusters[key].totalEvents += node.events;
  }

  // 에지 기반 서브 클러스터링 (연결 컴포넌트)
  const adj = new Map();
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    if (!adj.has(edge.target)) adj.set(edge.target, []);
    adj.get(edge.source).push(edge.target);
    adj.get(edge.target).push(edge.source);
  }

  return Object.values(clusters).sort((a, b) => b.totalEvents - a.totalEvents);
}

// ─── 핫스팟 계산 ──────────────────────────────────────────────────────────────

function computeHotspots(nodes) {
  return nodes
    .filter(n => n.type === 'file')
    .map(n => ({
      id:        n.id,
      label:     n.label,
      fullPath:  n.fullPath,
      language:  n.language,
      events:    n.events,
      aiTouches: n.aiTouches,
      score:     n.events * 1.0 + n.aiTouches * 1.5,
      owner:     n.owner,
      team:      n.team,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createOntologyRouter({ getAllEvents, getFiles, optionalAuth } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── 전체 온톨로지 그래프 ──────────────────────────────────────────────
  router.get('/ontology', (req, res) => {
    const { maxNodes = 200 } = req.query;
    const events = getAllEvents ? getAllEvents() : [];
    const { nodes, edges, summary } = buildOntologyGraph(events);

    // 이벤트 수 기준 상위 N개 파일만
    const fileNodes   = nodes.filter(n => n.type === 'file').sort((a, b) => b.events - a.events).slice(0, parseInt(maxNodes) || 200);
    const fileNodeIds = new Set(fileNodes.map(n => n.id));
    const otherNodes  = nodes.filter(n => n.type !== 'file');
    const filtEdges   = edges.filter(e => fileNodeIds.has(e.source) && fileNodeIds.has(e.target));

    res.json({
      nodes:   [...fileNodes, ...otherNodes],
      edges:   filtEdges,
      summary: { ...summary, showing: fileNodes.length },
    });
  });

  // ── 파일 의존성 서브그래프 ────────────────────────────────────────────
  router.get('/ontology/files', (req, res) => {
    const events = getAllEvents ? getAllEvents() : [];
    const { nodes, edges, summary } = buildOntologyGraph(events);
    const fileNodes  = nodes.filter(n => n.type === 'file');
    const fileEdges  = edges.filter(e => e.type === 'co-edited');
    res.json({ nodes: fileNodes, edges: fileEdges, summary });
  });

  // ── 팀 오너십 맵 ──────────────────────────────────────────────────────
  router.get('/ontology/ownership', (req, res) => {
    const events = getAllEvents ? getAllEvents() : [];
    const { nodes } = buildOntologyGraph(events);
    const fileNodes = nodes.filter(n => n.type === 'file');

    // 오너십이 없는 파일 자동 추론 (가장 많이 편집한 userId 기준)
    const fileUserMap = new Map(); // filePath → { userId: count }
    for (const ev of events) {
      if (!ev.userId || !ev.data) continue;
      const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
      for (const node of fileNodes) {
        if (dataStr.includes(node.fullPath) || dataStr.includes(node.label)) {
          const m = fileUserMap.get(node.fullPath) || {};
          m[ev.userId] = (m[ev.userId] || 0) + 1;
          fileUserMap.set(node.fullPath, m);
        }
      }
    }

    const ownership = fileNodes.map(n => {
      const explicit = ownershipMap.get(n.fullPath);
      const inferred = fileUserMap.get(n.fullPath);
      const inferredOwner = inferred
        ? Object.entries(inferred).sort((a, b) => b[1] - a[1])[0]?.[0]
        : null;

      return {
        file:          n.fullPath,
        label:         n.label,
        language:      n.language,
        explicitOwner: explicit?.owner  || null,
        explicitTeam:  explicit?.team   || null,
        inferredOwner: inferredOwner,
        since:         explicit?.since  || null,
        events:        n.events,
      };
    });

    res.json({ ownership, total: ownership.length });
  });

  // ── 파일별 AI 히스토리 ────────────────────────────────────────────────
  router.get('/ontology/ai-history/:file', (req, res) => {
    const fileName = decodeURIComponent(req.params.file);
    const events   = (getAllEvents ? getAllEvents() : []).filter(ev => {
      const dataStr = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || '');
      return dataStr.includes(fileName);
    }).slice(-100); // 최근 100개

    const timeline = events.map(ev => ({
      id:        ev.id,
      type:      ev.type,
      source:    ev.source,
      timestamp: ev.timestamp,
      sessionId: ev.sessionId,
      isAI:      ev.source && ev.source !== 'user',
    }));

    const aiStats = {
      totalEvents: timeline.length,
      aiEvents:    timeline.filter(e => e.isAI).length,
      humanEvents: timeline.filter(e => !e.isAI).length,
      sources:     [...new Set(events.map(e => e.source).filter(Boolean))],
      firstTouch:  timeline[0]?.timestamp,
      lastTouch:   timeline[timeline.length - 1]?.timestamp,
    };

    res.json({ file: fileName, timeline, stats: aiStats });
  });

  // ── 핫스팟 ────────────────────────────────────────────────────────────
  router.get('/ontology/hotspots', (req, res) => {
    const events = getAllEvents ? getAllEvents() : [];
    const { nodes } = buildOntologyGraph(events);
    res.json({ hotspots: computeHotspots(nodes) });
  });

  // ── 클러스터 ──────────────────────────────────────────────────────────
  router.get('/ontology/clusters', (req, res) => {
    const events = getAllEvents ? getAllEvents() : [];
    const { nodes, edges } = buildOntologyGraph(events);
    res.json({ clusters: clusterNodes(nodes, edges) });
  });

  // ── 오너십 수동 설정 ──────────────────────────────────────────────────
  router.post('/ontology/ownership', auth, (req, res) => {
    const { filePath, owner, team } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath 필드가 필요합니다.' });

    ownershipMap.set(filePath, {
      owner: owner || null,
      team:  team  || null,
      since: new Date().toISOString(),
      setBy: req.user?.id || 'local',
    });
    res.json({ success: true, filePath, owner, team });
  });

  // ── 온톨로지 검색 ─────────────────────────────────────────────────────
  router.get('/ontology/search', (req, res) => {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });

    const events = getAllEvents ? getAllEvents() : [];
    const { nodes } = buildOntologyGraph(events);

    const query   = q.toLowerCase();
    const results = nodes.filter(n => {
      if (type && n.type !== type) return false;
      return n.label.toLowerCase().includes(query) ||
             (n.fullPath || '').toLowerCase().includes(query);
    }).slice(0, 50);

    res.json({ results, total: results.length, query: q });
  });

  return router;
}

module.exports = createOntologyRouter;
