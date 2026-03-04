/**
 * n8n-demo.js
 * n8n 워크플로우 시각화 데모
 *
 * 시나리오: "신규 가입 자동화 파이프라인"
 *   1. GitHub Webhook → 새 이슈 감지
 *   2. Slack 알림 전송
 *   3. DB에 이슈 저장
 *   4. AI로 이슈 분류 → 담당자 지정
 *   5. Jira 티켓 자동 생성
 *   6. 이메일 요약 발송
 *
 * 사용법:
 *   node n8n-demo.js
 *   node n8n-demo.js clear   ← 채널 데이터 초기화 후 실행
 */

const http = require('http');
const { randomUUID } = require('crypto');

const PORT    = parseInt(process.env.MINDMAP_PORT || '4747');
const CHANNEL = 'n8n-demo';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function post(type, data, sessionId, userId = 'n8n-bot', aiSource = 'n8n') {
  const body = JSON.stringify({
    id: randomUUID(), type, aiSource,
    sessionId, userId, channelId: CHANNEL,
    timestamp: new Date().toISOString(),
    data,
    metadata: { aiSource, agentName: 'n8n-workflow' },
  });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: PORT, path: '/api/ai-event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

async function runDemo() {
  console.log('\n🔄 n8n 워크플로우 데모 시작');
  console.log(`채널: ${CHANNEL} | http://localhost:${PORT}/?channel=${CHANNEL}\n`);

  // ── 워크플로우 1: GitHub 이슈 자동화 ──────────────────
  const wf1 = `wf1-${Date.now()}`;
  console.log('▶ 워크플로우 1: GitHub 이슈 자동화');

  await post('session.start', {
    source: 'n8n',
    memberName: 'n8n-bot',
    projectDir: 'GitHub Issue Automation',
    modelId: 'n8n-workflow',
  }, wf1, 'n8n-bot');

  await sleep(400);

  // Step 1: GitHub Webhook 트리거
  await post('tool.start', {
    toolName: 'GitHub Webhook',
    inputPreview: '새 이슈 감지 대기 중...',
  }, wf1, 'n8n-bot');
  await sleep(300);
  await post('tool.end', {
    toolName: 'GitHub Webhook',
    success: true,
    inputPreview: '#142 버그: 결제 모듈 오류',
    message: 'GitHub Issue #142 수신\n제목: [BUG] 결제 모듈에서 500 에러 발생\n우선순위: critical',
  }, wf1, 'n8n-bot');
  console.log('  ✅ GitHub Webhook 수신');

  await sleep(400);

  // Step 2: HTTP Request로 이슈 상세 조회
  await post('tool.start', {
    toolName: 'HTTP Request',
    inputPreview: 'GET github.com/api/issues/142',
  }, wf1, 'n8n-bot');
  await sleep(350);
  await post('tool.end', {
    toolName: 'HTTP Request',
    success: true,
    inputPreview: 'GET api.github.com/repos/.../issues/142',
    message: JSON.stringify({ number: 142, title: '[BUG] 결제 모듈 500 에러', labels: ['bug', 'critical'], assignee: null }),
  }, wf1, 'n8n-bot');
  console.log('  ✅ GitHub API 이슈 상세 조회');

  await sleep(350);

  // Step 3: AI로 이슈 분류
  await post('tool.start', {
    toolName: 'HTTP Request',
    inputPreview: 'POST openai.com/chat → 이슈 분류',
  }, wf1, 'n8n-bot', 'openai');
  await sleep(500);
  await post('assistant.message', {
    content: '이슈 분류 결과: 카테고리=결제, 심각도=critical, 담당팀=backend, 예상 해결시간=2h',
    contentPreview: '이슈 분류: 결제/critical → backend팀',
    aiLabel: 'GPT-4o',
  }, wf1, 'n8n-bot', 'openai');
  console.log('  ✅ AI 이슈 분류 완료');

  await sleep(400);

  // Step 4: Slack 알림
  await post('tool.start', {
    toolName: 'Slack Message',
    inputPreview: '#backend-alerts 채널에 알림 전송',
  }, wf1, 'n8n-bot');
  await sleep(300);
  await post('tool.end', {
    toolName: 'Slack Message',
    success: true,
    inputPreview: '#backend-alerts: [CRITICAL] 결제 모듈 500 에러',
    message: '🚨 *[CRITICAL]* 결제 모듈 500 에러 발생\n담당: @backend-team\n이슈: #142',
  }, wf1, 'n8n-bot');
  console.log('  ✅ Slack #backend-alerts 알림 전송');

  await sleep(350);

  // Step 5: DB 저장
  await post('tool.start', {
    toolName: 'Database',
    inputPreview: 'INSERT INTO issues VALUES ...',
  }, wf1, 'n8n-bot');
  await sleep(250);
  await post('tool.end', {
    toolName: 'Database',
    success: true,
    inputPreview: 'DB 저장 완료: issues #142',
    message: 'PostgreSQL INSERT 성공\nid=142, status=open, severity=critical',
  }, wf1, 'n8n-bot');
  console.log('  ✅ DB 이슈 저장');

  await sleep(350);

  // Step 6: 이메일 발송
  await post('tool.end', {
    toolName: 'Send Email',
    success: true,
    inputPreview: 'to: cto@company.com — 일간 이슈 요약',
    message: '수신: cto@company.com\n제목: [자동] Critical 이슈 발생 알림\n새 critical 이슈: 1건',
  }, wf1, 'n8n-bot');
  console.log('  ✅ CTO 이메일 발송');

  await sleep(400);
  await post('task.complete', {
    taskName: 'GitHub 이슈 자동화 완료',
    toolName: '이슈 #142 처리',
  }, wf1, 'n8n-bot');

  // ── 워크플로우 2: 신규 가입자 온보딩 ─────────────────
  await sleep(600);
  const wf2 = `wf2-${Date.now()}`;
  console.log('\n▶ 워크플로우 2: 신규 가입자 온보딩');

  await post('session.start', {
    source: 'n8n',
    memberName: 'onboarding-bot',
    projectDir: 'User Onboarding Pipeline',
    modelId: 'n8n-workflow',
  }, wf2, 'onboarding-bot');

  await sleep(400);

  // 스케줄 트리거
  await post('tool.end', {
    toolName: 'Schedule',
    success: true,
    inputPreview: '매 5분 실행 — 신규 가입자 확인',
    message: '스케줄 트리거: 2026-02-27 10:00\n신규 가입자 3명 발견',
  }, wf2, 'onboarding-bot');
  console.log('  ✅ 스케줄 트리거 (5분마다)');

  await sleep(350);

  // DB 조회
  await post('tool.end', {
    toolName: 'Database',
    success: true,
    inputPreview: 'SELECT * FROM users WHERE created_at > NOW() - 5min',
    message: '신규 가입자 조회: 3명\nusers: [alice@test.com, bob@test.com, carol@test.com]',
  }, wf2, 'onboarding-bot');
  console.log('  ✅ DB 신규 가입자 조회');

  await sleep(350);

  // 각 사용자별 처리 루프
  const users = ['alice', 'bob', 'carol'];
  for (const user of users) {
    await post('tool.start', {
      toolName: 'Code',
      inputPreview: `${user} 온보딩 처리 중`,
    }, wf2, 'onboarding-bot');
    await sleep(200);

    // 환영 이메일
    await post('tool.end', {
      toolName: 'Send Email',
      success: true,
      inputPreview: `to: ${user}@test.com — 환영합니다!`,
      message: `${user}에게 환영 이메일 발송 완료`,
    }, wf2, 'onboarding-bot');

    await sleep(200);

    // Google Sheets 기록
    await post('tool.end', {
      toolName: 'Google Sheets',
      success: true,
      inputPreview: `온보딩 시트에 ${user} 추가`,
      message: `온보딩 현황 시트 업데이트: ${user} → row 추가`,
    }, wf2, 'onboarding-bot');
    console.log(`  ✅ ${user} 온보딩 완료`);
    await sleep(250);
  }

  await post('task.complete', {
    taskName: '신규 가입자 온보딩 완료',
    toolName: `${users.length}명 처리`,
  }, wf2, 'onboarding-bot');

  // ── 워크플로우 3: Railway 배포 자동화 ─────────────────
  await sleep(600);
  const wf3 = `wf3-${Date.now()}`;
  console.log('\n▶ 워크플로우 3: Railway 배포 자동화');

  await post('session.start', {
    source: 'n8n',
    memberName: 'deploy-bot',
    projectDir: 'CI/CD Deploy Pipeline',
    modelId: 'n8n-workflow',
  }, wf3, 'deploy-bot');

  await sleep(400);

  // GitHub Actions 완료 감지
  await post('tool.end', {
    toolName: 'GitHub Webhook',
    success: true,
    inputPreview: 'workflow_run: CI 완료 (main branch)',
    message: 'GitHub Actions CI 통과\nbranch: main, commit: a3f9c12\n모든 테스트 통과',
  }, wf3, 'deploy-bot');
  console.log('  ✅ GitHub Actions CI 통과 감지');

  await sleep(400);

  // Railway 배포
  await post('tool.start', {
    toolName: 'Railway Deploy',
    inputPreview: 'Railway 배포 시작...',
  }, wf3, 'deploy-bot');
  await sleep(600);
  await post('tool.end', {
    toolName: 'Railway Deploy',
    success: true,
    inputPreview: 'Railway 배포 완료 — v2.4.1',
    message: '배포 성공\nURL: https://mindmap.railway.app\n버전: v2.4.1\n소요: 47초',
  }, wf3, 'deploy-bot');
  console.log('  ✅ Railway 배포 완료 (v2.4.1)');

  await sleep(350);

  // 헬스체크
  await post('tool.end', {
    toolName: 'HTTP Request',
    success: true,
    inputPreview: 'GET https://mindmap.railway.app/health',
    message: '헬스체크 통과\n{"status":"ok","version":"2.4.1"}',
  }, wf3, 'deploy-bot');
  console.log('  ✅ 헬스체크 통과');

  await sleep(300);

  // Slack 배포 완료 알림
  await post('tool.end', {
    toolName: 'Slack Message',
    success: true,
    inputPreview: '#deploy: ✅ v2.4.1 배포 완료',
    message: '✅ *v2.4.1* 배포 완료\n환경: production\nURL: https://mindmap.railway.app',
  }, wf3, 'deploy-bot');
  console.log('  ✅ Slack #deploy 알림 전송');

  await post('task.complete', {
    taskName: '프로덕션 배포 완료 v2.4.1',
    toolName: 'Railway Deploy',
  }, wf3, 'deploy-bot');

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ n8n 데모 완료!

브라우저에서 확인:
  http://localhost:${PORT}/?channel=${CHANNEL}
  http://localhost:${PORT}/orbit.html?channel=${CHANNEL}

실행된 워크플로우:
  1. GitHub 이슈 자동화 (6 단계)
  2. 신규 가입자 온보딩 (5 단계 × 3명)
  3. Railway 배포 자동화 (5 단계)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

runDemo().catch(console.error);
