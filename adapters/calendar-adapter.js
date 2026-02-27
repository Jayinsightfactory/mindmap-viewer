/**
 * calendar-adapter.js
 * Google Calendar → Orbit 연동
 *
 * 사용법:
 *   1. Google Cloud Console에서 OAuth 2.0 자격증명 생성
 *      https://console.cloud.google.com/apis/credentials
 *   2. Google Calendar API 활성화
 *   3. 최초 1회 인증:
 *      node adapters/calendar-adapter.js --auth
 *   4. 이후 실행:
 *      GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node adapters/calendar-adapter.js
 *
 * 환경변수:
 *   GOOGLE_CLIENT_ID      Google OAuth Client ID
 *   GOOGLE_CLIENT_SECRET  Google OAuth Client Secret
 *   GOOGLE_REFRESH_TOKEN  OAuth Refresh Token (--auth 실행 후 자동 저장)
 *   CALENDAR_IDS          캘린더 ID 목록 (기본: primary)
 *   CALENDAR_DAYS_AHEAD   몇 일 앞 일정 표시 (기본: 7)
 *   MINDMAP_CHANNEL       채널 ID
 *
 * 캡처 항목:
 *   - 오늘 ~ N일 후 일정 목록
 *   - 회의 참여자 (attendees)
 *   - 회의 시작 30분 전 알림 이벤트
 *   - 일정 변경/취소
 */
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const CLIENT_ID      = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET;
const CALENDAR_IDS   = (process.env.CALENDAR_IDS || 'primary').split(',').map(s => s.trim());
const DAYS_AHEAD     = parseInt(process.env.CALENDAR_DAYS_AHEAD || '7');
const CHANNEL_ID     = process.env.MINDMAP_CHANNEL || 'calendar';
const MEMBER_NAME    = process.env.MINDMAP_MEMBER  || 'Calendar';
const ORBIT_PORT     = process.env.MINDMAP_PORT    || 4747;
const POLL_INTERVAL  = 5 * 60 * 1000; // 5분

const TOKEN_FILE = path.join(__dirname, '.calendar-token.json');

// ─── 토큰 관리 ──────────────────────────────────────
function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return null; }
}
function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

let tokenCache = loadToken();

async function getAccessToken() {
  if (!tokenCache?.refresh_token) {
    throw new Error('GOOGLE_REFRESH_TOKEN 없음. --auth 플래그로 먼저 인증하세요.');
  }
  // 만료 5분 전이면 갱신
  if (tokenCache.expires_at && Date.now() < tokenCache.expires_at - 300000) {
    return tokenCache.access_token;
  }
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokenCache.refresh_token,
    grant_type:    'refresh_token',
  }).toString();

  const result = await httpsPost('oauth2.googleapis.com', '/token', body, 'application/x-www-form-urlencoded');
  tokenCache.access_token = result.access_token;
  tokenCache.expires_at   = Date.now() + (result.expires_in || 3600) * 1000;
  saveToken(tokenCache);
  return tokenCache.access_token;
}

// ─── 최초 인증 흐름 ─────────────────────────────────
async function runAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[Calendar] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 환경변수 필요');
    process.exit(1);
  }
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    new URLSearchParams({
      client_id:     CLIENT_ID,
      redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/calendar.readonly',
      access_type:   'offline',
      prompt:        'consent',
    });

  console.log('\n[Calendar] 브라우저에서 아래 URL을 열어 인증하세요:\n');
  console.log(authUrl);
  console.log('\n인증 후 표시되는 코드를 GOOGLE_AUTH_CODE 환경변수로 설정하고 다시 실행하세요:');
  console.log('GOOGLE_AUTH_CODE=xxx node adapters/calendar-adapter.js --auth\n');

  const code = process.env.GOOGLE_AUTH_CODE;
  if (!code) process.exit(0);

  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
    grant_type:    'authorization_code',
  }).toString();

  const result = await httpsPost('oauth2.googleapis.com', '/token', body, 'application/x-www-form-urlencoded');
  saveToken({ ...result, expires_at: Date.now() + (result.expires_in || 3600) * 1000 });
  console.log('[Calendar] 인증 완료! 토큰 저장됨:', TOKEN_FILE);
  process.exit(0);
}

// ─── Google Calendar API 호출 ────────────────────────
async function calendarRequest(calendarId, params) {
  const accessToken = await getAccessToken();
  const query = new URLSearchParams(params).toString();
  const encodedId = encodeURIComponent(calendarId);
  return httpsGet('www.googleapis.com', `/calendar/v3/calendars/${encodedId}/events?${query}`, accessToken);
}

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('parse error')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.end();
  });
}

function httpsPost(hostname, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('parse error')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ─── Google Calendar 이벤트 → Orbit 이벤트 ─────────
function gcalToEvent(gcalEvent, calendarId) {
  const { ulid } = require('ulid');
  const title     = gcalEvent.summary || '(제목 없음)';
  const startRaw  = gcalEvent.start?.dateTime || gcalEvent.start?.date;
  const endRaw    = gcalEvent.end?.dateTime   || gcalEvent.end?.date;
  const attendees = (gcalEvent.attendees || []).map(a => a.displayName || a.email).join(', ');
  const location  = gcalEvent.location || '';
  const isOnline  = location.includes('zoom') || location.includes('meet') || location.includes('teams') ||
                    gcalEvent.hangoutLink || gcalEvent.conferenceData;
  const isMeeting = (gcalEvent.attendees || []).length > 1 || isOnline;

  const startTs = startRaw ? new Date(startRaw).toISOString() : new Date().toISOString();
  const duration = startRaw && endRaw
    ? Math.round((new Date(endRaw) - new Date(startRaw)) / 60000) + '분'
    : '';

  const icon = isMeeting ? '🎥' : '📅';
  const preview = [
    `${icon} ${title}`,
    startRaw && `⏰ ${new Date(startRaw).toLocaleString('ko-KR')}`,
    duration  && `⏱ ${duration}`,
    attendees && `👥 ${attendees}`,
    location  && `📍 ${location.substring(0, 50)}`,
  ].filter(Boolean).join('\n');

  return {
    id:        ulid(),
    type:      'notification',
    source:    'google-calendar',
    aiSource:  'calendar',
    sessionId: `calendar-${CHANNEL_ID}`,
    userId:    'local',
    channelId: CHANNEL_ID,
    timestamp: startTs,
    data: {
      toolName:     'GoogleCalendar',
      message:      preview,
      title:        `${icon} ${title}`,
      inputPreview: preview,
      notificationType: isMeeting ? 'meeting' : 'event',
      // 회의 참여자 → Orbit 멤버 연결용
      attendees:    (gcalEvent.attendees || []).map(a => ({
        name:   a.displayName || a.email,
        email:  a.email,
        status: a.responseStatus,
      })),
      startAt:      startRaw,
      endAt:        endRaw,
      duration,
      location,
      isOnline:     !!isOnline,
      isMeeting,
      gcalEventId:  gcalEvent.id,
      gcalUrl:      gcalEvent.htmlLink,
      calendarId,
    },
    metadata: {
      source:   'calendar-adapter',
      aiSource: 'calendar',
      aiLabel:  'Calendar',
      aiIcon:   icon,
    },
  };
}

// ─── 이미 전송한 이벤트 ID 추적 ─────────────────────
const sentEventIds = new Set();

// ─── 캘린더 폴링 ────────────────────────────────────
async function pollCalendar() {
  const now      = new Date();
  const timeMin  = now.toISOString();
  const timeMax  = new Date(now.getTime() + DAYS_AHEAD * 24 * 3600 * 1000).toISOString();

  const allEvents = [];
  for (const calId of CALENDAR_IDS) {
    try {
      const result = await calendarRequest(calId, {
        timeMin, timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });
      if (result.items) {
        for (const item of result.items) {
          if (!sentEventIds.has(item.id)) {
            allEvents.push(gcalToEvent(item, calId));
            sentEventIds.add(item.id);
          }
        }
      }
    } catch (e) {
      console.warn(`[Calendar] 캘린더 ${calId} 폴링 실패:`, e.message);
    }
  }

  if (allEvents.length > 0) {
    postToOrbit(allEvents);
  } else {
    console.log(`[Calendar] 새 이벤트 없음`);
  }
}

// ─── Orbit 서버에 전송 ──────────────────────────────
function postToOrbit(events) {
  const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: MEMBER_NAME });
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
  console.log(`[Calendar] ${events.length}개 이벤트 전송`);
}

// ─── 진입점 ─────────────────────────────────────────
if (process.argv.includes('--auth')) {
  runAuth().catch(e => { console.error(e); process.exit(1); });
} else {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[Calendar] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 환경변수 필요');
    process.exit(1);
  }
  if (!tokenCache?.refresh_token) {
    console.error('[Calendar] 먼저 인증하세요: node adapters/calendar-adapter.js --auth');
    process.exit(1);
  }
  console.log(`[Calendar] 시작 - 향후 ${DAYS_AHEAD}일 일정 감시 중 (5분 간격)`);
  pollCalendar();
  setInterval(pollCalendar, POLL_INTERVAL);
}
