/**
 * routes/nodes.js
 * 다계층 노드 드릴다운 API
 * 6단계 계층 시스템 (Level 0-5)
 */

const { Router } = require('express');
const multiLevelSystem = require('../src/multilevel-node-system');

module.exports = function createNodesRouter({ getDb }) {
  const router = Router();

  // 세션별 현재 드릴 레벨 추적
  const sessionState = new Map();

  /**
   * GET /api/nodes/structure
   * 현재 구조(기본 Level 0) 조회
   */
  router.get('/nodes/structure', (req, res) => {
    // 기존 호환성을 위해 기본 API는 계속 유지
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    try {
      const classificationEngine = require('../src/node-classification-engine');
      const orbitalLayout = require('../src/orbital-layout');

      const domainStats = classificationEngine.aggregateByDomain(db);
      const layout = orbitalLayout.generateOrbitalLayout(domainStats);

      return res.json({
        ok: true,
        planets: layout.planets,
        moons: layout.moons,
        summary: {
          totalPlanets: layout.planets.length,
          totalMoons: layout.moons.length,
          totalEvents: Object.values(domainStats).reduce((sum, d) => sum + d.count, 0)
        }
      });
    } catch (e) {
      console.error('[nodes/structure]', e);
      return res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/multilevel/structure
   * 현재 구조(기본 Level 0) 조회 (다계층)
   */
  router.get('/multilevel/structure', (req, res) => {
    try {
      const sessionId = req.query.sessionId || 'default';

      // 세션 초기화
      if (!sessionState.has(sessionId)) {
        sessionState.set(sessionId, {
          level: 0,
          selectedNode: null,
          nodeStack: []
        });
      }

      const state = sessionState.get(sessionId);
      const currentView = multiLevelSystem.initializeCompactView();

      res.json({
        ok: true,
        level: state.level,
        nodes: currentView.nodes,
        levelConfig: multiLevelSystem.MULTILEVEL_CONFIG.levels[0],
        navigation: {
          canDrillDown: true,
          canDrillUp: false,
          currentLevel: 'Compact'
        },
        summary: {
          totalNodes: currentView.nodes.length,
          shapes: currentView.nodes.map(n => n.shape)
        }
      });
    } catch (e) {
      console.error('[nodes/structure]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/multilevel/drill/down
   * 특정 노드로 드릴다운
   * Body: { sessionId, nodeId, level }
   */
  router.post('/multilevel/drill/down', (req, res) => {
    try {
      const { sessionId = 'default', nodeId, level } = req.body;

      if (!sessionState.has(sessionId)) {
        sessionState.set(sessionId, {
          level: 0,
          selectedNode: null,
          nodeStack: []
        });
      }

      const state = sessionState.get(sessionId);
      const currentLevel = state.level || 0;

      // 레벨 검증
      if (level <= currentLevel || level > 5) {
        return res.status(400).json({
          error: 'Invalid drill level',
          currentLevel,
          requestedLevel: level
        });
      }

      // 현재 레벨 노드 조회
      const currentNodes = multiLevelSystem.generateNodesForLevel(currentLevel);
      const selectedNode = currentNodes.find(n => n.id === nodeId);

      if (!selectedNode) {
        return res.status(400).json({ error: 'Node not found' });
      }

      // 드릴다운 실행
      const drillResult = multiLevelSystem.drillToLevel(selectedNode, level);

      // 상태 업데이트
      state.level = level;
      state.selectedNode = selectedNode;
      state.nodeStack.push({
        level: currentLevel,
        nodes: currentNodes,
        selectedId: nodeId
      });

      // 연결선 생성
      const connections = multiLevelSystem.generateConnectionLines(
        [selectedNode],
        drillResult.nodes,
        0
      );

      res.json({
        ok: true,
        level,
        nodes: drillResult.nodes,
        levelConfig: multiLevelSystem.MULTILEVEL_CONFIG.levels[level],
        parent: selectedNode,
        animation: drillResult.animation,
        connections,
        navigation: {
          canDrillDown: level < 5,
          canDrillUp: true,
          currentLevel: multiLevelSystem.MULTILEVEL_CONFIG.levels[level].name
        },
        summary: {
          totalNodes: drillResult.nodes.length,
          parentNode: selectedNode.name,
          shapes: drillResult.nodes.map(n => n.shape)
        }
      });
    } catch (e) {
      console.error('[nodes/drill/down]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/multilevel/drill/up
   * 상위 레벨로 돌아가기
   * Body: { sessionId }
   */
  router.post('/multilevel/drill/up', (req, res) => {
    try {
      const { sessionId = 'default' } = req.body;

      if (!sessionState.has(sessionId)) {
        return res.status(400).json({ error: 'Session not found' });
      }

      const state = sessionState.get(sessionId);
      const currentLevel = state.level || 0;

      if (currentLevel === 0) {
        return res.json({
          ok: true,
          level: 0,
          message: 'Already at top level',
          nodes: multiLevelSystem.generateNodesForLevel(0)
        });
      }

      // 스택에서 이전 상태 복원
      if (state.nodeStack.length > 0) {
        const previous = state.nodeStack.pop();
        state.level = previous.level;
        state.selectedNode = previous.nodes.find(n => n.id === previous.selectedId);

        res.json({
          ok: true,
          level: previous.level,
          nodes: previous.nodes,
          levelConfig: multiLevelSystem.MULTILEVEL_CONFIG.levels[previous.level],
          navigation: {
            canDrillDown: previous.level < 5,
            canDrillUp: previous.level > 0,
            currentLevel: multiLevelSystem.MULTILEVEL_CONFIG.levels[previous.level].name
          }
        });
      } else {
        // 스택 비어있으면 Level 0으로 리셋
        state.level = 0;
        res.json({
          ok: true,
          level: 0,
          nodes: multiLevelSystem.generateNodesForLevel(0)
        });
      }
    } catch (e) {
      console.error('[nodes/drill/up]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/multilevel/level/:level
   * 특정 레벨의 노드 조회 (드릴다운 없이 직접 접근)
   */
  router.get('/multilevel/level/:level', (req, res) => {
    try {
      const level = parseInt(req.params.level, 10);

      if (level < 0 || level > 5) {
        return res.status(400).json({ error: 'Level must be 0-5' });
      }

      const nodes = multiLevelSystem.generateNodesForLevel(level);
      const config = multiLevelSystem.MULTILEVEL_CONFIG.levels[level];

      res.json({
        ok: true,
        level,
        nodes,
        levelConfig: config,
        navigation: {
          canDrillDown: level < 5,
          canDrillUp: level > 0,
          currentLevel: config.name
        }
      });
    } catch (e) {
      console.error('[nodes/level/:level]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/multilevel/all-levels
   * 모든 레벨의 구조를 한 번에 조회 (성능 최적화용)
   */
  router.get('/multilevel/all-levels', (req, res) => {
    try {
      const allLevels = {};

      for (let level = 0; level <= 5; level++) {
        const nodes = multiLevelSystem.generateNodesForLevel(level);
        allLevels[level] = {
          name: multiLevelSystem.MULTILEVEL_CONFIG.levels[level].name,
          nodes,
          config: multiLevelSystem.MULTILEVEL_CONFIG.levels[level]
        };
      }

      res.json({
        ok: true,
        allLevels,
        summary: {
          totalLevels: 6,
          totalNodes: Object.values(allLevels).reduce((sum, l) => sum + l.nodes.length, 0),
          levelNames: Object.values(allLevels).map((l, i) => `${i}: ${l.name}`)
        }
      });
    } catch (e) {
      console.error('[nodes/all-levels]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/multilevel/reset
   * 세션 상태 초기화
   */
  router.get('/multilevel/reset', (req, res) => {
    const sessionId = req.query.sessionId || 'default';
    sessionState.delete(sessionId);
    res.json({ ok: true, message: 'Session reset' });
  });

  // ───────────────────────────────────────────────────────────
  // 워크스페이스 다계층 노드 시스템 (역할 기반 권한 제어)
  // ───────────────────────────────────────────────────────────

  const {
    authWorkspaceLevel,
    requireLevelAccess,
    requireLevelModify,
    getPermissionsResponse
  } = require('./multilevel-auth');
  const multiLevelWorkspaceNodes = require('../src/multilevel-workspace-nodes');

  /**
   * POST /api/multilevel/workspace/:workspaceId/structure
   * 워크스페이스 기반 Level 0 로드
   */
  router.post('/multilevel/workspace/:workspaceId/structure',
    authWorkspaceLevel,
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const { sessionId = 'default' } = req.body;
        const { userId, role } = req.wsContext;

        // sessionState에 워크스페이스 정보 저장
        if (!sessionState.has(sessionId)) {
          sessionState.set(sessionId, {
            workspaceId,
            userId,
            role,
            level: 0,
            selectedNode: null,
            nodeStack: []
          });
        }

        const state = sessionState.get(sessionId);
        state.workspaceId = workspaceId;
        state.userId = userId;
        state.role = role;

        // 워크스페이스 기반 Level 0 노드 생성
        const nodes = await multiLevelWorkspaceNodes.generateNodesForWorkspace(
          workspaceId, userId, 0, role
        );

        res.json({
          ok: true,
          workspaceId,
          level: 0,
          role,
          nodes,
          permissions: getPermissionsResponse(role),
          navigation: {
            canDrillDown: true,
            canDrillUp: false,
            currentLevel: 'Compact'
          }
        });
      } catch (e) {
        console.error('[multilevel/workspace/structure]', e);
        res.status(403).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/multilevel/workspace/:workspaceId/drill/down
   * 워크스페이스 권한 기반 드릴다운
   */
  router.post('/multilevel/workspace/:workspaceId/drill/down',
    authWorkspaceLevel,
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const { sessionId = 'default', nodeId, level } = req.body;
        const { userId, role, permissions } = req.wsContext;

        // 레벨 권한 검증
        if (!permissions.canViewLevels.includes(level)) {
          return res.status(403).json({
            error: 'access_denied',
            message: `Role '${role}' cannot access level ${level}`
          });
        }

        const state = sessionState.get(sessionId) || {
          workspaceId,
          userId,
          role,
          level: 0,
          selectedNode: null,
          nodeStack: []
        };
        sessionState.set(sessionId, state);

        // 현재 노드 조회 (선택 노드 위치 파악용)
        const currentNodes = await multiLevelWorkspaceNodes.generateNodesForWorkspace(
          workspaceId, userId, state.level || 0, role
        );

        const selectedNode = currentNodes.find(n => n.id === nodeId);
        if (!selectedNode) {
          return res.status(400).json({ error: 'Node not found' });
        }

        // 드릴다운: 선택된 노드 위치를 새 중심으로 하위 노드 생성
        const parentNodePos = selectedNode.position || { x: 0, y: 0, z: 0 };
        const toNodes = await multiLevelWorkspaceNodes.generateNodesForWorkspace(
          workspaceId, userId, level, role, nodeId, parentNodePos
        );

        // 연결선 생성
        const connections = await multiLevelWorkspaceNodes.generateConnectionsForLevel(
          currentNodes, level, toNodes
        );

        // 상태 업데이트
        state.level = level;
        state.selectedNode = selectedNode;
        state.nodeStack.push({
          level: state.level - 1,
          nodes: currentNodes,
          nodeId
        });

        res.json({
          ok: true,
          workspaceId,
          level,
          role,
          nodes: toNodes,
          connections,
          parent: selectedNode,
          permissions,
          navigation: {
            canDrillDown: level < 5 && permissions.canViewLevels.includes(level + 1),
            canDrillUp: level > 0,
            currentLevel: multiLevelWorkspaceNodes.LEVEL_STYLES[level].name
          }
        });
      } catch (e) {
        console.error('[multilevel/workspace/drill/down]', e);
        res.status(403).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/multilevel/workspace/:workspaceId/drill/up
   * 워크스페이스 권한 기반 드릴업
   */
  router.post('/multilevel/workspace/:workspaceId/drill/up',
    authWorkspaceLevel,
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const { sessionId = 'default' } = req.body;
        const { userId, role } = req.wsContext;

        const state = sessionState.get(sessionId);
        if (!state || state.level === 0) {
          return res.json({
            ok: true,
            level: 0,
            message: 'Already at top level',
            nodes: await multiLevelWorkspaceNodes.generateNodesForWorkspace(
              workspaceId, userId, 0, role
            )
          });
        }

        // 스택에서 이전 상태 복원
        if (state.nodeStack.length > 0) {
          const previous = state.nodeStack.pop();
          state.level = previous.level;

          const nodes = await multiLevelWorkspaceNodes.generateNodesForWorkspace(
            workspaceId, userId, previous.level, role
          );

          res.json({
            ok: true,
            level: previous.level,
            role,
            nodes,
            permissions: getPermissionsResponse(role),
            navigation: {
              canDrillDown: previous.level < 5,
              canDrillUp: previous.level > 0,
              currentLevel: multiLevelWorkspaceNodes.LEVEL_STYLES[previous.level].name
            }
          });
        } else {
          // 스택 비어있으면 Level 0으로 리셋
          state.level = 0;
          const nodes = await multiLevelWorkspaceNodes.generateNodesForWorkspace(
            workspaceId, userId, 0, role
          );

          res.json({
            ok: true,
            level: 0,
            role,
            nodes,
            permissions: getPermissionsResponse(role),
            navigation: {
              canDrillDown: true,
              canDrillUp: false,
              currentLevel: 'Compact'
            }
          });
        }
      } catch (e) {
        console.error('[multilevel/workspace/drill/up]', e);
        res.status(403).json({ error: e.message });
      }
    }
  );

  /**
   * POST /api/multilevel/workspace/:workspaceId/reset
   * 워크스페이스 세션 초기화
   */
  router.post('/multilevel/workspace/:workspaceId/reset',
    authWorkspaceLevel,
    (req, res) => {
      const { sessionId = 'default' } = req.body;
      sessionState.delete(sessionId);
      res.json({ ok: true, message: 'Workspace session reset' });
    }
  );

  return router;
};
