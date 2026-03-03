/**
 * slack-adapter.js
 * Slack (& Discord) → Orbit 연동
 *
 * ── Slack 설정 방법 ──────────────────────────────────
 * 1. https://api.slack.com/apps → Create New App → From scratch
 * 2. Features → Event Subscriptions → Enable → Request URL:
 *    https://your-domain/api/webhooks/slack
 *    (로컬 테스트 시 ngrok 사용: ngrok http 4747)
 * 3. Subscribe to bot events:
 *    - message.channels  (공개 채널 메시지)
 *    - message.groups    (비공개 채널)
 *    - message.im        (DM)
 * 4. OAuth & Permissions → Bot Token Scopes:
 *    channels:read, groups:read, users:read
 * 5. Install App → Bot User OAuth Token (xoxb-...)
 *
 * ── Discord 설정 방법 ─────────────────────────────────
 * 1. Discord Developer Portal → New Application → Bot
 * 2. Webhook URL 복사
 * 3. DISCORD_WEBHOOK_SECRET 환경변수 설정 (선택)
 *
 * 환경변수:
 *   SLACK_SIGNING_SECRET   Slack 앱 서명 시크릿
 *   SLACK_BOT_TOKEN        xoxb-... (사용자 이름 조회용)
 *   DISCORD_WEBHOOK_SECRET Discord 웹훅 시크릿 (선택)
 *   MINDMAP_CHANNEL        채널 ID
 *   MINDMAP_PORT           Orbit 서버 포트 (기본 4747)
 *
 * 이 어댑터는 독립 Express 서버로 실행됩니다.
 * 포트: process.env.WEBHOOK_PORT || 4748
 */
const express  = require('express');
const http     = require('http');
const crypto   = require('crypto');

const SLACK_SIGNING_SECRET  = process.env.SLACK_SIGNING_SECRET  || '';
const SLACK_BOT_TOKEN       = process.env.SLACK_BOT_TOKEN       || '';
const DISCORD_WEBHOOK_SECRET = process.env.DISCORD_WEBHOOK_SECRET || '';
const CHANNEL_ID            = process.env.MINDMAP_CHANNEL || 'slack';
const ORBIT_PORT            = parseInt(process.env.MINDMAP_PORT    || '4747');
const WEBHOOK_PORT          = parseInt(process.env.WEBHOOK_PORT    || '4748');

const app = express();

// ─── Slack 서명 검증 ────────────────────────────────
function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) return true; // 미설정 시 스킵
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) return false; // 5분 초과 거부

  const base = `v0:${ts}:${req.rawBody || ''}`;
  const expected = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// rawBody 보존 미들웨어
app.use((req, res, next) => {
  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); }
    catch { req.body = {}; }
    next();
  });
});

// ─── Slack 사용자 이름 캐시 ──────────────────────────
const userCache = {};
async function getSlackUserName(userId) {
  if (userCache[userId]) return userCache[userId];
  if (!SLACK_BOT_TOKEN) return userId;
  try {
    const https = require('https');
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'slack.com',
        path: `/api/users.info?user=${userId}`,
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy());
      req.end();
    });
    const name = result.user?.profile?.display_name || result.user?.real_name || userId;
    userCache[userId] = name;
    return name;
  } catch { return userId; }
}

// ─── Slack 메시지 → Orbit 이벤트 ────────────────────
function slackMsgToEvent(event, channelName) {
  const { ulid } = require('ulid');
  const text    = event.text || '';
  const preview = text.substring(0, 200).replace(/\n/g, ' ');
  const ts      = event.ts ? new Date(parseFloat(event.ts) * 1000).toISOString() : new Date().toISOString();

  // 멘션 추출 (@user)
  const mentions = (text.match(/<@(\w+)>/g) || []).map(m => m.slice(2, -1));

  return {
    id:        ulid(),
    type:      'user.message',
    source:    'slack',
    aiSource:  'slack',
    sessionId: `slack-${CHANNEL_ID}`,
    userId:    event.user || 'slack-bot',
    channelId: CHANNEL_ID,
    timestamp: ts,
    data: {
      toolName:     'Slack',
      content:      text.substring(0, 2000),
      contentPreview: preview,
      wordCount:    text.split(/\s+/).filter(Boolean).length,
      inputPreview: `💬 #${channelName}: ${preview}`,
      slackChannel: channelName,
      slackUser:    event.user,
      slackTs:      event.ts,
      mentions,
      threadTs:     event.thread_ts || null,
      isReply:      !!event.thread_ts,
      hasFiles:     !!(event.files && event.files.length > 0),
    },
    metadata: {
      source:   'slack-adapter',
      aiSource: 'slack',
      aiLabel:  'Slack',
      aiIcon:   '💬',
    },
  };
}

// ─── Discord 메시지 → Orbit 이벤트 ──────────────────
function discordMsgToEvent(payload) {
  const { ulid } = require('ulid');
  const msg = payload.data || payload;
  const text = msg.content || '';

  return {
    id:        ulid(),
    type:      'user.message',
    source:    'discord',
    aiSource:  'discord',
    sessionId: `discord-${CHANNEL_ID}`,
    userId:    msg.author?.username || 'discord',
    channelId: CHANNEL_ID,
    timestamp: msg.timestamp || new Date().toISOString(),
    data: {
      toolName:     'Discord',
      content:      text.substring(0, 2000),
      contentPreview: text.substring(0, 200),
      wordCount:    text.split(/\s+/).filter(Boolean).length,
      inputPreview: `🎮 Discord #${msg.channel_id || 'channel'}: ${text.substring(0, 100)}`,
      discordChannel: msg.channel_id,
      discordUser:    msg.author?.username,
    },
    metadata: { source: 'discord-adapter', aiSource: 'discord', aiLabel: 'Discord', aiIcon: '🎮' },
  };
}

// ─── Orbit 서버에 전송 ──────────────────────────────
function postToOrbit(events, memberName) {
  const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: memberName || 'Slack' });
  const req = http.request({
    hostname: '127.0.0.1',
    port: ORBIT_PORT,
    path: '/api/hook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => res.resume());
  req.on('error', () => {});
  req.setTimeout(3000, () => req.destroy());
  req.write(body);
  req.end();
}

// ─── Slack Events API 웹훅 ──────────────────────────
app.post('/api/webhooks/slack', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body = req.body;

  // URL 검증 (Slack 앱 등록 시 1회 발생)
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // 이벤트 처리
  if (body.type === 'event_callback') {
    const event = body.event;
    if (event.type === 'message' && !event.subtype && event.text) {
      const channelName = event.channel_name || event.channel || 'unknown';
      const orbitEvent  = slackMsgToEvent(event, channelName);

      // 사용자 이름 비동기 조회 (실패해도 계속 진행)
      getSlackUserName(event.user).then(name => {
        orbitEvent.data.inputPreview = `💬 #${channelName} · ${name}: ${event.text.substring(0, 100)}`;
        postToOrbit([orbitEvent], name);
      }).catch(() => postToOrbit([orbitEvent]));

      console.log(`[Slack] 메시지: #${channelName} - ${event.text.substring(0, 50)}`);
    }
  }

  res.json({ ok: true });
});

// ─── Discord 웹훅 ────────────────────────────────────
app.post('/api/webhooks/discord', (req, res) => {
  // Discord 서명 검증 (Ed25519) — 간략화
  const body = req.body;

  // 핑 응답
  if (body.type === 1) {
    return res.json({ type: 1 });
  }

  // 메시지 이벤트
  if (body.type === 0 && body.content) {
    const orbitEvent = discordMsgToEvent(body);
    postToOrbit([orbitEvent], body.author?.username || 'Discord');
    console.log(`[Discord] 메시지: ${body.content.substring(0, 50)}`);
  }

  res.json({ ok: true });
});

// ─── 상태 확인 ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    adapters: ['slack', 'discord'],
    channel: CHANNEL_ID,
    orbitPort: ORBIT_PORT,
  });
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`[Slack/Discord Adapter] 웹훅 서버 시작: http://localhost:${WEBHOOK_PORT}`);
  console.log(`  Slack    → POST http://localhost:${WEBHOOK_PORT}/api/webhooks/slack`);
  console.log(`  Discord  → POST http://localhost:${WEBHOOK_PORT}/api/webhooks/discord`);
  console.log(`  Orbit 전송 포트: ${ORBIT_PORT} (채널: ${CHANNEL_ID})`);
  if (!SLACK_SIGNING_SECRET) console.warn('  [경고] SLACK_SIGNING_SECRET 미설정 — 서명 검증 비활성화');
});
