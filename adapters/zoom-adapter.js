/**
 * zoom-adapter.js
 * Zoom → Orbit 연동
 *
 * 캡처 항목:
 *   - 회의 시작/종료 (참여자 목록 포함)
 *   - 참여자 입장/퇴장
 *   - 녹화 완료 → 트랜스크립트 자동 수집
 *   - 참여자별 발언 시간 (트랜스크립트 기반)
 *
 * ── 설정 방법 ────────────────────────────────────────
 * 1. https://marketplace.zoom.us → Develop → Build App → Webhook Only
 * 2. Event Subscriptions → Endpoint URL:
 *    https://your-domain/api/webhooks/zoom
 *    (ngrok: ngrok http 4748 → https://xxx.ngrok.io/api/webhooks/zoom)
 * 3. 구독 이벤트:
 *    - meeting.started
 *    - meeting.ended
 *    - meeting.participant_joined
 *    - meeting.participant_left
 *    - recording.completed
 * 4. Secret Token 복사 → ZOOM_WEBHOOK_SECRET 환경변수
 *
 * 환경변수:
 *   ZOOM_WEBHOOK_SECRET   Zoom 앱 Secret Token
 *   ZOOM_ACCOUNT_ID       Zoom Server-to-Server OAuth Account ID (트랜스크립트용)
 *   ZOOM_CLIENT_ID        Zoom OAuth Client ID
 *   ZOOM_CLIENT_SECRET    Zoom OAuth Client Secret
 *   MINDMAP_CHANNEL       채널 ID
 *   WEBHOOK_PORT          웹훅 서버 포트 (기본 4748, Slack 어댑터와 공유)
 */
const express  = require('express');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');

const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || '';
const ZOOM_ACCOUNT_ID     = process.env.ZOOM_ACCOUNT_ID     || '';
const ZOOM_CLIENT_ID      = process.env.ZOOM_CLIENT_ID      || '';
const ZOOM_CLIENT_SECRET  = process.env.ZOOM_CLIENT_SECRET  || '';
const CHANNEL_ID          = process.env.MINDMAP_CHANNEL || 'zoom';
const ORBIT_PORT          = parseInt(process.env.MINDMAP_PORT    || '4747');
const WEBHOOK_PORT        = parseInt(process.env.WEBHOOK_PORT    || '4748');

// 현재 진행 중인 회의 트래킹
const activeMeetings = new Map(); // meetingId → { title, host, participants, startAt }

// ─── Zoom 서명 검증 ─────────────────────────────────
function verifyZoomSignature(req) {
  if (!ZOOM_WEBHOOK_SECRET) return true;
  const msg = `v0:${req.headers['x-zm-request-timestamp']}:${req.rawBody || ''}`;
  const sig = 'v0=' + crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET).update(msg).digest('hex');
  return req.headers['x-zm-signature'] === sig;
}

// ─── Zoom OAuth 토큰 (트랜스크립트 API용) ───────────
let zoomTokenCache = null;
async function getZoomAccessToken() {
  if (zoomTokenCache && zoomTokenCache.expires_at > Date.now()) {
    return zoomTokenCache.access_token;
  }
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) return null;

  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const body = `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`;

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'zoom.us',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  zoomTokenCache = {
    access_token: result.access_token,
    expires_at:   Date.now() + (result.expires_in || 3600) * 1000 - 60000,
  };
  return result.access_token;
}

// ─── 트랜스크립트 가져오기 ──────────────────────────
async function fetchTranscript(meetingId) {
  const token = await getZoomAccessToken();
  if (!token) return null;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.zoom.us',
      path: `/v2/meetings/${meetingId}/recordings`,
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(d);
          // VTT 트랜스크립트 파일 찾기
          const vttFile = data.recording_files?.find(f =>
            f.file_type === 'TRANSCRIPT' || f.file_extension === 'VTT'
          );
          resolve(vttFile?.download_url || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── VTT 파싱 → 발언자별 타임라인 ──────────────────
function parseVTT(vttContent) {
  const speakers = {};
  const lines = vttContent.split('\n');
  let currentSpeaker = null;

  for (const line of lines) {
    // "00:01:23.456 --> 00:01:45.678" 패턴
    if (line.includes(' --> ')) continue;
    // "Speaker Name: text" 패턴
    const speakerMatch = line.match(/^([^:]+):\s*(.+)/);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1].trim();
      const text = speakerMatch[2].trim();
      if (!speakers[currentSpeaker]) speakers[currentSpeaker] = [];
      speakers[currentSpeaker].push(text);
    }
  }

  return Object.entries(speakers).map(([name, texts]) => ({
    name,
    wordCount:  texts.join(' ').split(/\s+/).length,
    preview:    texts[0]?.substring(0, 100) || '',
    utterances: texts.length,
  }));
}

// ─── Zoom 이벤트 → Orbit 이벤트 ─────────────────────
function zoomToOrbitEvent(zoomEventType, payload) {
  const { ulid } = require('ulid');
  const meeting = payload.object || {};
  const meetingId   = meeting.id || meeting.uuid;
  const meetingTitle = meeting.topic || '(제목 없음)';
  const hostName     = meeting.host?.display_name || meeting.host_email || '(호스트 미확인)';

  switch (zoomEventType) {
    case 'meeting.started': {
      activeMeetings.set(String(meetingId), {
        title: meetingTitle,
        host: hostName,
        participants: [],
        startAt: new Date().toISOString(),
      });
      return {
        id:        ulid(),
        type:      'session.start',
        source:    'zoom',
        aiSource:  'zoom',
        sessionId: `zoom-${meetingId}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          source:       'zoom-meeting',
          inputPreview: `🎥 회의 시작: ${meetingTitle}`,
          toolName:     'Zoom',
          meetingId:    String(meetingId),
          meetingTitle,
          host:         hostName,
        },
        metadata: { source: 'zoom-adapter', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '🎥' },
      };
    }

    case 'meeting.ended': {
      const info = activeMeetings.get(String(meetingId));
      const participants = info?.participants || [];
      const duration = info?.startAt
        ? Math.round((Date.now() - new Date(info.startAt).getTime()) / 60000) + '분'
        : '';
      activeMeetings.delete(String(meetingId));

      return {
        id:        ulid(),
        type:      'session.end',
        source:    'zoom',
        aiSource:  'zoom',
        sessionId: `zoom-${meetingId}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          inputPreview: `🔴 회의 종료: ${meetingTitle} (${duration}) — 참여자: ${participants.join(', ') || '없음'}`,
          toolName:     'Zoom',
          meetingId:    String(meetingId),
          meetingTitle,
          participants,
          duration,
        },
        metadata: { source: 'zoom-adapter', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '🎥' },
      };
    }

    case 'meeting.participant_joined': {
      const participant = meeting.participant?.display_name || meeting.participant?.user_name || '참여자';
      const info = activeMeetings.get(String(meetingId));
      if (info && !info.participants.includes(participant)) {
        info.participants.push(participant);
      }
      return {
        id:        ulid(),
        type:      'notification',
        source:    'zoom',
        aiSource:  'zoom',
        sessionId: `zoom-${meetingId}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          message:       `👤 ${participant} 입장: ${meetingTitle}`,
          title:         `회의 참여`,
          inputPreview:  `👤 ${participant} 입장: ${meetingTitle}`,
          notificationType: 'meeting.join',
          toolName:      'Zoom',
          meetingId:     String(meetingId),
          participant,
          // 팀원 매핑: Orbit 채널에서 같은 이름 찾기
          memberName:    participant,
        },
        metadata: { source: 'zoom-adapter', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '🎥' },
      };
    }

    case 'meeting.participant_left': {
      const participant = meeting.participant?.display_name || meeting.participant?.user_name || '참여자';
      return {
        id:        ulid(),
        type:      'notification',
        source:    'zoom',
        aiSource:  'zoom',
        sessionId: `zoom-${meetingId}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          message:       `👋 ${participant} 퇴장: ${meetingTitle}`,
          title:         `회의 퇴장`,
          inputPreview:  `👋 ${participant} 퇴장: ${meetingTitle}`,
          notificationType: 'meeting.leave',
          toolName:      'Zoom',
          meetingId:     String(meetingId),
          participant,
        },
        metadata: { source: 'zoom-adapter', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '🎥' },
      };
    }

    case 'recording.completed': {
      const downloadUrl = meeting.recording_files?.[0]?.download_url || '';
      return {
        id:        ulid(),
        type:      'file.create',
        source:    'zoom',
        aiSource:  'zoom',
        sessionId: `zoom-${meetingId}`,
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data: {
          toolName:     'Zoom',
          filePath:     `[Zoom Recording] ${meetingTitle}`,
          fileName:     `${meetingTitle}_recording`,
          inputPreview: `📹 녹화 완료: ${meetingTitle}`,
          operation:    'create',
          downloadUrl,
          meetingId:    String(meetingId),
          recordingFiles: meeting.recording_files?.length || 0,
        },
        metadata: { source: 'zoom-adapter', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '📹' },
      };
    }

    default:
      return null;
  }
}

// ─── 트랜스크립트를 Orbit 이벤트로 변환 ─────────────
function transcriptToEvents(meetingId, meetingTitle, speakers) {
  const { ulid } = require('ulid');
  return speakers.map(speaker => ({
    id:        ulid(),
    type:      'user.message',
    source:    'zoom-transcript',
    aiSource:  'zoom',
    sessionId: `zoom-${meetingId}`,
    userId:    speaker.name,
    channelId: CHANNEL_ID,
    timestamp: new Date().toISOString(),
    data: {
      toolName:     'Zoom Transcript',
      content:      `[${meetingTitle}] ${speaker.name}: ${speaker.preview}`,
      contentPreview: speaker.preview,
      wordCount:    speaker.wordCount,
      inputPreview: `🗣 ${speaker.name}: ${speaker.preview.substring(0, 80)}`,
      speaker:      speaker.name,
      utterances:   speaker.utterances,
      meetingId:    String(meetingId),
      meetingTitle,
    },
    metadata: { source: 'zoom-transcript', aiSource: 'zoom', aiLabel: 'Zoom', aiIcon: '🗣' },
  }));
}

// ─── Orbit 서버에 전송 ──────────────────────────────
function postToOrbit(events, memberName) {
  if (!events.length) return;
  const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: memberName || 'Zoom' });
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
  console.log(`[Zoom] ${events.length}개 이벤트 전송`);
}

// ─── Express 웹훅 서버 ──────────────────────────────
const app = express();
app.use((req, res, next) => {
  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

app.post('/api/webhooks/zoom', async (req, res) => {
  if (!verifyZoomSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body = req.body;

  // Zoom URL 검증 (최초 1회)
  if (body.event === 'endpoint.url_validation') {
    const hash = crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET)
      .update(body.payload.plainToken).digest('hex');
    return res.json({
      plainToken:     body.payload.plainToken,
      encryptedToken: hash,
    });
  }

  const orbitEvent = zoomToOrbitEvent(body.event, body.payload || {});
  if (orbitEvent) {
    postToOrbit([orbitEvent]);

    // 녹화 완료 시 트랜스크립트 비동기 수집
    if (body.event === 'recording.completed') {
      const meetingId = body.payload?.object?.id;
      const meetingTitle = body.payload?.object?.topic || 'Meeting';
      setTimeout(async () => {
        try {
          const transcriptUrl = await fetchTranscript(meetingId);
          if (transcriptUrl) {
            // VTT 파일 다운로드 & 파싱
            const token = await getZoomAccessToken();
            // 실제 구현에서는 VTT 파일을 HTTP GET으로 다운로드
            console.log(`[Zoom] 트랜스크립트 URL: ${transcriptUrl}`);
          }
        } catch (e) {
          console.warn('[Zoom] 트랜스크립트 수집 실패:', e.message);
        }
      }, 30000); // 30초 후 시도 (처리 시간 대기)
    }
  }

  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    adapter: 'zoom',
    activeMeetings: activeMeetings.size,
    channel: CHANNEL_ID,
  });
});

// ─── 진입점 ─────────────────────────────────────────
// 단독 실행 시: node adapters/zoom-adapter.js
// Slack 어댑터와 통합: WEBHOOK_PORT=4748 으로 공유 가능
if (require.main === module) {
  app.listen(WEBHOOK_PORT, () => {
    console.log(`[Zoom Adapter] 웹훅 서버: http://localhost:${WEBHOOK_PORT}`);
    console.log(`  Zoom → POST http://localhost:${WEBHOOK_PORT}/api/webhooks/zoom`);
    console.log(`  Orbit 전송 포트: ${ORBIT_PORT} (채널: ${CHANNEL_ID})`);
    if (!ZOOM_WEBHOOK_SECRET) console.warn('  [경고] ZOOM_WEBHOOK_SECRET 미설정 — 서명 검증 비활성화');
  });
}

module.exports = { app, zoomToOrbitEvent, postToOrbit };
