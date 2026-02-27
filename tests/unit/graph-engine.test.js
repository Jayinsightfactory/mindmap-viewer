/**
 * graph-engine.test.js
 * TDD: 마인드맵 그래프 빌드 + 노드 스타일 로직 테스트
 */

const { buildGraph, applyActivityVisualization } = require('../../graph-engine.js');

const makeEvent = (overrides = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`,
  type: 'tool.end',
  sessionId: 'sess_01',
  parentEventId: null,
  timestamp: new Date().toISOString(),
  data: { toolName: 'Read', files: [] },
  ...overrides,
});

// ── buildGraph ────────────────────────────────────────────
describe('buildGraph', () => {
  test('빈 이벤트 배열 → 빈 그래프 반환', () => {
    const { nodes, edges } = buildGraph([]);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  test('이벤트 1개 → 노드 1개, 엣지 0개', () => {
    const { nodes, edges } = buildGraph([makeEvent()]);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
  });

  test('부모-자식 이벤트 → 엣지 생성', () => {
    const parent = makeEvent({ id: 'parent', type: 'assistant.message' });
    const child = makeEvent({ id: 'child', type: 'tool.end', parentEventId: 'parent' });
    const { nodes, edges } = buildGraph([parent, child]);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe('parent');
    expect(edges[0].to).toBe('child');
  });

  test('파일 경로 있는 tool.end → 파일 노드 자동 생성', () => {
    const evt = makeEvent({
      type: 'tool.end',
      data: { toolName: 'Read', files: ['/src/server.js'] },
    });
    const { nodes } = buildGraph([evt]);
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode.label).toContain('server.js');
  });

  test('같은 파일 여러 번 접근 → 파일 노드 하나만 생성 (중복 제거)', () => {
    const evt1 = makeEvent({ id: 'e1', type: 'tool.end', data: { toolName: 'Read', files: ['/src/db.js'] } });
    const evt2 = makeEvent({ id: 'e2', type: 'tool.end', data: { toolName: 'Read', files: ['/src/db.js'] } });
    const { nodes } = buildGraph([evt1, evt2]);
    const fileNodes = nodes.filter(n => n.type === 'file');
    expect(fileNodes).toHaveLength(1);
  });

  test('같은 파일 여러 번 접근 → accessCount 증가', () => {
    const evt1 = makeEvent({ id: 'e1', data: { toolName: 'Read', files: ['/src/db.js'] } });
    const evt2 = makeEvent({ id: 'e2', data: { toolName: 'Read', files: ['/src/db.js'] } });
    const { nodes } = buildGraph([evt1, evt2]);
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode.accessCount).toBe(2);
  });

  test('session.start 노드 → hexagon 형태', () => {
    const evt = makeEvent({ type: 'session.start', data: {} });
    const { nodes } = buildGraph([evt]);
    expect(nodes[0].shape).toBe('hexagon');
  });

  test('user.message 노드 → 파란 색상 계열', () => {
    const evt = makeEvent({ type: 'user.message', data: { contentPreview: '질문' } });
    const { nodes } = buildGraph([evt]);
    expect(nodes[0].color.background).toMatch(/^#[0-9a-fA-F]{6}/);
    // 파란 계열 (#388bfd)
    expect(nodes[0].color.background.toLowerCase()).toContain('38');
  });

  test('부모가 아직 없는 parentEventId → 엣지 미생성', () => {
    const child = makeEvent({ parentEventId: 'nonexistent_parent' });
    const { edges } = buildGraph([child]);
    expect(edges).toHaveLength(0);
  });

  test('[cmd] 같은 glob 패턴 파일 → 파일 노드 생성 안 함', () => {
    const evt = makeEvent({
      data: { toolName: 'Glob', files: ['[*.js]', '/real/file.js'] },
    });
    const { nodes } = buildGraph([evt]);
    const fileNodes = nodes.filter(n => n.type === 'file');
    // [*.js]는 제외, /real/file.js만 포함
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0].label).toContain('file.js');
  });
});

// ── applyActivityVisualization ────────────────────────────
describe('applyActivityVisualization', () => {
  const makeNode = (score) => ({
    id: 'n1',
    type: 'tool.end',
    activityScore: score,
    size: 16,
    color: { background: '#d29922' },
    borderWidth: 2,
    shadow: false,
  });

  test('score 0 → shadow false 유지', () => {
    const nodes = [makeNode(0)];
    applyActivityVisualization(nodes);
    expect(nodes[0].shadow).toBeFalsy();
  });

  test('score 0.9 → shadow 활성화', () => {
    const nodes = [makeNode(0.9)];
    applyActivityVisualization(nodes);
    expect(nodes[0].shadow).toBeTruthy();
    expect(nodes[0].shadow.enabled).toBe(true);
  });

  test('score 높을수록 borderWidth 더 넓음', () => {
    const low = makeNode(0.2);
    const high = makeNode(0.9);
    applyActivityVisualization([low, high]);
    expect(high.borderWidth).toBeGreaterThan(low.borderWidth);
  });

  test('score 높을수록 노드 크기 더 큼', () => {
    const low = makeNode(0.1);
    const high = makeNode(0.8);
    applyActivityVisualization([low, high]);
    expect(high.size).toBeGreaterThan(low.size);
  });

  test('shadow.size는 score에 비례', () => {
    const node = makeNode(0.5);
    applyActivityVisualization([node]);
    expect(node.shadow.size).toBeGreaterThan(0);
  });
});
