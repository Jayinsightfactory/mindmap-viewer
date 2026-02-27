/**
 * demo-seed.js
 * 모든 기능을 표현하는 실제 대화 시나리오 데모 데이터 생성
 *
 * 실행: node demo-seed.js
 *
 * 시나리오: "SaaS 랜딩페이지 개발" 프로젝트
 * - 3명의 팀원 (dlaww, joon, sara)
 * - Claude, Cursor, GPT, n8n 4개 AI 동시 작동
 * - 보안 스캔, 코드 분석, 멀티채널
 */

const http = require('http');

const BASE = 'http://localhost:4747';
const SESSION_A = 'session-dlaww-' + Date.now();
const SESSION_B = 'session-joon-'  + (Date.now() + 1);
const SESSION_C = 'session-sara-'  + (Date.now() + 2);

let seq = 0;
function id() { return `demo-${Date.now()}-${++seq}`; }
function ts(offsetSec = 0) {
  return new Date(Date.now() - (300 - offsetSec) * 1000).toISOString();
}

async function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 4747, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.write(data); req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 훅 이벤트 배치 전송 ────────────────────────────
async function hook(events, channelId = 'team-orbit', memberName = 'dlaww') {
  await post('/api/hook', { events, channelId, memberName });
}

// ─── AI 어댑터 이벤트 전송 ─────────────────────────
async function aiEvent(ev) {
  await post('/api/ai-event', ev);
}

// ═══════════════════════════════════════════════════
// 메인 시나리오
// ═══════════════════════════════════════════════════
async function seed() {
  console.log('🌌 Orbit 데모 데이터 생성 시작...\n');

  // ── 1. dlaww — Claude Code로 작업 시작 ──────────
  console.log('[1/8] dlaww: Claude Code 세션 시작');
  await hook([
    { id: id(), type: 'session.start', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(0),
      data: { source: 'claude', modelId: 'claude-sonnet-4-6', projectDir: '/project/saas-landing' },
      metadata: {} },
  ], 'team-orbit', 'dlaww');
  await sleep(300);

  // ── 2. 유저 메시지: 기획 질문 ──────────────────
  console.log('[2/8] dlaww: 기획 질문 입력');
  await hook([
    { id: id(), type: 'user.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(10),
      data: {
        content: 'SaaS 랜딩페이지에 필요한 섹션 구조를 알려줘. Hero, Features, Pricing, CTA 외에 뭐가 더 필요해?',
        contentPreview: 'SaaS 랜딩페이지에 필요한 섹션 구조를 알려줘.',
        wordCount: 28,
      }, metadata: {} },
  ], 'team-orbit', 'dlaww');
  await sleep(300);

  // ── 3. Claude 답변 + 파일 생성 ─────────────────
  console.log('[3/8] Claude: 답변 + 파일 작업');
  await hook([
    { id: id(), type: 'assistant.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(25),
      data: {
        content: 'SaaS 랜딩페이지 구조: Hero(가치 제안) → Social Proof(고객 수) → Features(핵심 기능 3가지) → How It Works(3단계) → Pricing(3 티어) → FAQ → CTA → Footer',
        contentPreview: 'SaaS 랜딩페이지 구조: Hero → Social Proof → Features → Pricing → FAQ → CTA',
        toolCalls: [{ name: 'Write' }, { name: 'Read' }],
      }, metadata: {} },

    { id: id(), type: 'tool.start', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(30),
      data: { toolName: 'Write', inputPreview: '/project/saas-landing/STRUCTURE.md' },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(32),
      data: { toolName: 'Write', filePath: '/project/saas-landing/STRUCTURE.md', success: true },
      metadata: {} },

    { id: id(), type: 'tool.start', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(33),
      data: { toolName: 'Bash', inputPreview: 'npm create next-app saas-landing' },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(45),
      data: { toolName: 'Bash', success: true, files: ['/project/saas-landing/package.json'] },
      metadata: {} },

    { id: id(), type: 'tool.start', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(46),
      data: { toolName: 'Write', inputPreview: '/project/saas-landing/src/app/page.tsx' },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(50),
      data: { toolName: 'Write', filePath: '/project/saas-landing/src/app/page.tsx', success: true },
      metadata: {} },
  ], 'team-orbit', 'dlaww');
  await sleep(400);

  // ── 4. joon — Cursor로 컴포넌트 작업 ───────────
  console.log('[4/8] joon: Cursor IDE 세션');
  await aiEvent({
    id: id(), type: 'assistant.message', aiSource: 'cursor',
    sessionId: SESSION_B, userId: 'joon', channelId: 'team-orbit',
    timestamp: ts(55),
    data: {
      aiLabel: 'Cursor',
      content: 'HeroSection 컴포넌트 작성 완료. Tailwind CSS로 반응형 레이아웃 구현.',
      contentPreview: 'HeroSection 컴포넌트 작성 완료.',
      model: 'gpt-4o',
    },
    metadata: {},
  });
  await sleep(200);

  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'cursor',
    sessionId: SESSION_B, userId: 'joon', channelId: 'team-orbit',
    timestamp: ts(60),
    data: {
      aiLabel: 'Cursor',
      toolName: 'Edit',
      filePath: '/project/saas-landing/src/components/HeroSection.tsx',
      success: true,
    },
    metadata: {},
  });
  await sleep(200);

  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'cursor',
    sessionId: SESSION_B, userId: 'joon', channelId: 'team-orbit',
    timestamp: ts(65),
    data: {
      aiLabel: 'Cursor',
      toolName: 'Edit',
      filePath: '/project/saas-landing/src/components/PricingSection.tsx',
      success: true,
    },
    metadata: {},
  });
  await sleep(300);

  // ── 5. sara — GPT로 카피라이팅 ─────────────────
  console.log('[5/8] sara: GPT 카피라이팅');
  await aiEvent({
    id: id(), type: 'user.message', aiSource: 'gpt',
    sessionId: SESSION_C, userId: 'sara', channelId: 'team-orbit',
    timestamp: ts(70),
    data: {
      aiLabel: 'ChatGPT',
      content: 'SaaS 랜딩페이지 헤드라인 카피 5개 버전 작성해줘. B2B 개발자 타겟.',
      contentPreview: 'SaaS 랜딩페이지 헤드라인 카피 5개 버전 작성.',
    },
    metadata: {},
  });
  await sleep(200);

  await aiEvent({
    id: id(), type: 'assistant.message', aiSource: 'gpt',
    sessionId: SESSION_C, userId: 'sara', channelId: 'team-orbit',
    timestamp: ts(80),
    data: {
      aiLabel: 'ChatGPT',
      content: '1. "AI 툴들의 혼돈을 지도로 만들어라" 2. "모든 AI가 하나의 행성계로" 3. "팀의 AI 작업을 실시간으로 시각화" 4. "코딩하는 동안 지도가 그려진다" 5. "AI 협업의 새로운 표준"',
      contentPreview: '"AI 툴들의 혼돈을 지도로 만들어라" 외 4개',
      model: 'gpt-4o',
    },
    metadata: {},
  });
  await sleep(300);

  // ── 6. n8n 자동화 워크플로우 ────────────────────
  console.log('[6/8] n8n: 자동화 워크플로우 실행');
  await aiEvent({
    id: id(), type: 'tool.start', aiSource: 'n8n',
    sessionId: 'session-n8n-automation', userId: 'n8n-bot', channelId: 'team-orbit',
    timestamp: ts(85),
    data: { aiLabel: 'n8n', toolName: 'HTTP Request', inputPreview: 'GET /api/github/commits' },
    metadata: {},
  });
  await sleep(200);

  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'n8n',
    sessionId: 'session-n8n-automation', userId: 'n8n-bot', channelId: 'team-orbit',
    timestamp: ts(88),
    data: { aiLabel: 'n8n', toolName: 'HTTP Request', success: true },
    metadata: {},
  });

  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'n8n',
    sessionId: 'session-n8n-automation', userId: 'n8n-bot', channelId: 'team-orbit',
    timestamp: ts(90),
    data: { aiLabel: 'n8n', toolName: 'Slack Message', success: true,
      inputPreview: '📦 새 커밋 3건 감지 → 자동 배포 시작' },
    metadata: {},
  });

  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'n8n',
    sessionId: 'session-n8n-automation', userId: 'n8n-bot', channelId: 'team-orbit',
    timestamp: ts(95),
    data: { aiLabel: 'n8n', toolName: 'Railway Deploy', success: true },
    metadata: {},
  });
  await sleep(300);

  // ── 7. dlaww — 더 많은 파일 작업 ───────────────
  console.log('[7/8] dlaww: 추가 파일 + 보안 스캔 트리거');
  await hook([
    { id: id(), type: 'user.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(100),
      data: {
        content: '환경변수 설정하고 Stripe 결제 연동해줘. API 키는 .env 파일에 넣어뒀어.',
        contentPreview: '환경변수 설정하고 Stripe 결제 연동해줘.',
        wordCount: 20,
      }, metadata: {} },

    // 보안 유출: Stripe 키 포함 메시지 → security-scanner가 감지
    { id: id(), type: 'assistant.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(115),
      data: {
        content: '.env 파일에 STRIPE_SECRET_KEY를 설정하겠습니다. 주의: 키를 코드에 직접 넣지 마세요.',
        contentPreview: '.env 파일에 STRIPE_SECRET_KEY를 설정하겠습니다.',
        toolCalls: [{ name: 'Write' }, { name: 'Bash' }],
      }, metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(120),
      data: { toolName: 'Write', filePath: '/project/saas-landing/.env.example', success: true },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(125),
      data: { toolName: 'Write', filePath: '/project/saas-landing/src/lib/stripe.ts', success: true },
      metadata: {} },

    { id: id(), type: 'tool.start', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(126),
      data: { toolName: 'Bash', inputPreview: 'npm install stripe @stripe/stripe-js' },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(135),
      data: { toolName: 'Bash', success: true },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(140),
      data: { toolName: 'Read',
        filePath: '/project/saas-landing/src/app/page.tsx',
        files: ['/project/saas-landing/src/app/page.tsx',
                '/project/saas-landing/src/app/api/checkout/route.ts'],
        success: true },
      metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(150),
      data: { toolName: 'Write',
        filePath: '/project/saas-landing/src/app/api/checkout/route.ts', success: true },
      metadata: {} },
  ], 'team-orbit', 'dlaww');
  await sleep(400);

  // ── 8. 마무리: 3명 동시 마무리 작업 ────────────
  console.log('[8/8] 팀 전체 마무리 작업');

  // joon: 테스트 실행
  await aiEvent({
    id: id(), type: 'tool.end', aiSource: 'cursor',
    sessionId: SESSION_B, userId: 'joon', channelId: 'team-orbit',
    timestamp: ts(160),
    data: { aiLabel: 'Cursor', toolName: 'Bash',
      inputPreview: 'npm run test -- --coverage', success: true },
    metadata: {},
  });

  // dlaww: 최종 확인 질문
  await hook([
    { id: id(), type: 'user.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(165),
      data: {
        content: 'Lighthouse 점수 확인해줘. Performance, SEO, Accessibility 기준으로.',
        contentPreview: 'Lighthouse 점수 확인해줘.',
        wordCount: 12,
      }, metadata: {} },

    { id: id(), type: 'assistant.message', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(180),
      data: {
        content: 'Lighthouse 결과: Performance 94, SEO 100, Accessibility 97, Best Practices 95. 이미지 최적화(next/image)와 메타태그가 잘 설정되어 있습니다.',
        contentPreview: 'Performance 94, SEO 100, Accessibility 97',
        toolCalls: [{ name: 'Bash' }],
      }, metadata: {} },

    { id: id(), type: 'tool.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(185),
      data: { toolName: 'Bash', inputPreview: 'npx lighthouse http://localhost:3000', success: true },
      metadata: {} },

    { id: id(), type: 'session.end', source: 'claude-hook', sessionId: SESSION_A,
      userId: 'dlaww', channelId: 'team-orbit', timestamp: ts(190),
      data: {}, metadata: {} },
  ], 'team-orbit', 'dlaww');

  await sleep(200);

  // sara: Perplexity로 경쟁사 리서치
  await aiEvent({
    id: id(), type: 'assistant.message', aiSource: 'perplexity',
    sessionId: 'session-sara-perplexity', userId: 'sara', channelId: 'team-orbit',
    timestamp: ts(192),
    data: {
      aiLabel: 'Perplexity',
      content: '경쟁사 분석 완료: Linear, Notion, Vercel의 랜딩페이지 패턴 분석. 공통점: 다크모드, 인터랙티브 데모, 소셜 프루프 강조.',
      contentPreview: '경쟁사 분석: Linear, Notion, Vercel 랜딩 패턴',
    },
    metadata: {},
  });

  await sleep(200);

  const stats = await new Promise(resolve => {
    http.get('http://localhost:4747/api/stats', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });

  console.log('\n✅ 데모 데이터 생성 완료!');
  console.log('─────────────────────────────────');
  console.log(`📊 총 이벤트: ${stats.eventCount}개`);
  console.log(`💬 세션: ${stats.sessionCount}개`);
  console.log(`📁 파일: ${stats.fileCount}개`);
  console.log(`🔧 도구 사용: ${stats.toolCount}번`);
  console.log('\n🤖 AI 소스별:');
  for (const [src, cnt] of Object.entries(stats.aiSourceStats || {})) {
    console.log(`   ${src}: ${cnt}건`);
  }
  console.log('\n🌐 브라우저에서 확인:');
  console.log('   기존 맵  → http://localhost:4747');
  console.log('   행성계   → http://localhost:4747/orbit.html');
}

seed().catch(console.error);
