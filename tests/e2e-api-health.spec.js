// @ts-check
const { test, expect } = require('@playwright/test');

const BASE  = 'https://mindmap-viewer-production-adb2.up.railway.app';
const EMAIL = 'dlaww584@gmail.com';
const PW    = 'orbit2024';

let TOKEN = '';

// ═══════════════════════════════════════════════
test.describe.serial('Orbit AI API 헬스체크 + 기능 테스트', () => {

  // ─── 0. 인증 ──────────────────────────────────
  test('0. 로그인 → 토큰 발급', async ({ request }) => {
    const resp = await request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL, password: PW },
    });
    const json = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.token).toBeTruthy();
    TOKEN = json.token;
    console.log(`토큰 발급 OK (user: ${json.user?.name || json.user?.email})`);
  });

  // ─── 1. 서버 기본 ──────────────────────────────
  test('1-1. 메인 페이지 200', async ({ request }) => {
    const resp = await request.get(`${BASE}/`);
    expect(resp.status()).toBe(200);
  });

  test('1-2. 그래프 API', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/graph`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    expect(json.nodes).toBeDefined();
    console.log(`그래프: 노드 ${json.nodes?.length}개, 엣지 ${json.edges?.length}개`);
  });

  test('1-3. 통계 API', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log(`이벤트: ${json.eventCount}, 세션: ${json.sessionCount}`);
    expect(json.eventCount).toBeGreaterThan(0);
  });

  // ─── 2. 에이전트 API ──────────────────────────
  test('2-1. Think Engine — 전이 모델', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/think/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('Think Engine:', resp.status());
  });

  test('2-2. Think Engine — RAG 예측', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/think/rag-predict?currentState=nenova 주문&userId=MMONWUCHC96FB6029B`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 예측:', json.ok, `컨텍스트: ${json.ragContext?.length || 0}건`);
    expect(resp.status()).toBeLessThan(500);
  });

  test('2-3. Idea Engine — 목록', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/ideas`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('Idea Engine:', resp.status());
  });

  test('2-4. Idea Engine — RAG 발견', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/ideas/rag-discover?topic=주문 자동화`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 발견:', json.ok, `문서: ${json.totalDocs || 0}건`);
    expect(resp.status()).toBeLessThan(500);
  });

  test('2-5. Deep Investigator — 워크플로우 자동 발견', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/investigate/hidden-workflows?days=14`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    expect(json.ok).toBe(true);
    console.log(`워크플로우: ${json.summary?.totalWorkflows}개, 카테고리: ${json.summary?.categorized}개`);
    expect(json.workflows).toBeDefined();
  });

  test('2-6. Deep Investigator — RAG 맥락', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/investigate/rag-context?query=nenova 주문 등록`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 맥락:', json.ok, `문서: ${json.count || 0}건`);
    expect(resp.status()).toBeLessThan(500);
  });

  test('2-7. BI — 건강도', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/bi/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    const json = await resp.json();
    console.log('BI 건강도:', json.score, json.grade);
  });

  test('2-8. Activity Classifier', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/activity/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('Activity Classifier:', resp.status());
  });

  // ─── 3. RAG API ──────────────────────────────
  test('3-1. RAG 통계', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/rag/stats`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 통계:', JSON.stringify(json));
    expect(json.ok).toBe(true);
  });

  test('3-2. RAG 검색', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/rag/search?q=주문`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 검색:', json.ok, `결과: ${json.count || 0}건`);
    expect(json.ok).toBe(true);
  });

  test('3-3. RAG 맥락 검색', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/rag/context?currentState=화훼 관리 주문`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log('RAG 맥락:', json.ok, `결과: ${json.count || 0}건`);
    expect(json.ok).toBe(true);
  });

  // ─── 4. 데이터 파이프라인 ──────────────────────
  test('4-1. 학습 로그', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/learning/logs?limit=5`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json();
    console.log(`학습 로그: ${json.total || json.logs?.length || 0}건`);
    expect(resp.status()).toBeLessThan(500);
  });

  test('4-2. 자동화 마스터', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/automation/master`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('자동화 마스터:', resp.status());
  });

  test('4-3. 워크플로우 목록', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/workflows`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('워크플로우:', resp.status());
  });

  // ─── 5. 인프라 ──────────────────────────────
  test('5-1. 트래커 상태', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/tracker/status?token=${TOKEN}`);
    expect(resp.status()).toBeLessThan(500);
    const json = await resp.json();
    console.log('트래커 상태:', json.trackers?.length || 0, '대 연결');
  });

  test('5-2. 워크스페이스 목록', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/workspace`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('워크스페이스:', resp.status());
  });

  // ─── 6. nenova 연동 ──────────────────────────
  test('6-1. nenova 상태', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/nenova/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('nenova 상태:', resp.status());
  });

  test('6-2. 교차 분석', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/cross/summary`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status()).toBeLessThan(500);
    console.log('교차 분석:', resp.status());
  });

  // ─── 7. 결과 요약 ──────────────────────────────
  test('7. 전체 결과 요약', async () => {
    console.log('\n══════════════════════════════════════');
    console.log('Orbit AI API 헬스체크 완료');
    console.log('══════════════════════════════════════\n');
  });
});
