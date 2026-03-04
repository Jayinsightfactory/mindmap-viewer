/**
 * notion-adapter.js
 * Notion → Orbit 연동
 *
 * 사용법:
 *   1. Notion Integration 생성 → API 키 발급
 *      https://www.notion.so/my-integrations
 *   2. 연동할 Database에 Integration 연결 (페이지 우측 상단 ··· → Connections)
 *   3. 환경변수 설정:
 *      NOTION_API_KEY=secret_xxx
 *      NOTION_DATABASE_IDS=db_id1,db_id2   (쉼표 구분)
 *      NOTION_POLL_INTERVAL=60             (초, 기본 60)
 *      MINDMAP_CHANNEL=my-project
 *   4. 실행: node adapters/notion-adapter.js
 *
 * 캡처 항목:
 *   - Database 행 생성/수정/삭제 (Task, Project 등)
 *   - 페이지 생성/수정
 *   - 담당자(Assignee), 상태(Status), 우선순위 필드 읽기
 */
const http  = require('http');
const https = require('https');

const NOTION_API_KEY     = process.env.NOTION_API_KEY;
const DATABASE_IDS       = (process.env.NOTION_DATABASE_IDS || '').split(',').filter(Boolean);
const POLL_INTERVAL      = parseInt(process.env.NOTION_POLL_INTERVAL || '60') * 1000;
const CHANNEL_ID         = process.env.MINDMAP_CHANNEL || 'notion';
const MEMBER_NAME        = process.env.MINDMAP_MEMBER  || 'Notion';
const ORBIT_PORT         = process.env.MINDMAP_PORT    || 4747;

if (!NOTION_API_KEY) {
  console.error('[Notion] NOTION_API_KEY 환경변수 필요');
  process.exit(1);
}
if (DATABASE_IDS.length === 0) {
  console.error('[Notion] NOTION_DATABASE_IDS 환경변수 필요 (쉼표 구분 DB ID)');
  process.exit(1);
}

// ─── 마지막 폴링 시각 추적 ──────────────────────────
const lastChecked = {}; // dbId → ISO timestamp

// ─── Notion API 호출 ────────────────────────────────
function notionRequest(path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method: body ? 'POST' : 'GET',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Notion 프로퍼티 → 텍스트 추출 ─────────────────
function extractText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || '';
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || '';
    case 'status':
      return prop.status?.name || '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return prop.multi_select?.map(s => s.name).join(', ') || '';
    case 'people':
      return prop.people?.map(p => p.name || p.id).join(', ') || '';
    case 'date':
      return prop.date?.start || '';
    case 'checkbox':
      return prop.checkbox ? '✅' : '☐';
    case 'number':
      return String(prop.number ?? '');
    case 'url':
      return prop.url || '';
    default:
      return '';
  }
}

// ─── 페이지 → 이벤트 변환 ───────────────────────────
function pageToEvent(page, dbName) {
  const { ulid } = require('ulid');
  const props = page.properties || {};

  // 제목 찾기 (title 타입 프로퍼티)
  const titleProp = Object.values(props).find(p => p.type === 'title');
  const title = titleProp ? extractText(titleProp) : '(제목 없음)';

  // 상태/담당자/우선순위 찾기
  const statusProp   = props['Status'] || props['상태'] || props['status'];
  const assigneeProp = props['Assignee'] || props['담당자'] || props['Person'];
  const priorityProp = props['Priority'] || props['우선순위'];
  const dueDateProp  = props['Due'] || props['마감'] || props['Date'];

  const status   = statusProp   ? extractText(statusProp)   : '';
  const assignee = assigneeProp ? extractText(assigneeProp) : '';
  const priority = priorityProp ? extractText(priorityProp) : '';
  const dueDate  = dueDateProp  ? extractText(dueDateProp)  : '';

  const isNew    = page.created_time === page.last_edited_time;
  const opIcon   = isNew ? '📄' : '✏️';
  const opLabel  = isNew ? '생성' : '수정';

  const preview = [
    status   && `상태: ${status}`,
    assignee && `담당: ${assignee}`,
    priority && `우선순위: ${priority}`,
    dueDate  && `마감: ${dueDate}`,
  ].filter(Boolean).join(' · ');

  return {
    id:        ulid(),
    type:      isNew ? 'file.create' : 'file.write',
    source:    'notion',
    aiSource:  'notion',
    sessionId: `notion-${CHANNEL_ID}`,
    userId:    'local',
    channelId: CHANNEL_ID,
    timestamp: page.last_edited_time,
    data: {
      toolName:     'Notion',
      filePath:     `[Notion] ${dbName || 'DB'} / ${title}`,
      fileName:     title,
      language:     'notion',
      operation:    isNew ? 'create' : 'write',
      inputPreview: `${opIcon} ${opLabel}: ${title}${preview ? ' — ' + preview : ''}`,
      notionPageId: page.id,
      notionUrl:    page.url,
      status,
      assignee,
      priority,
      dueDate,
      dbName,
    },
    metadata: {
      source:    'notion-adapter',
      aiSource:  'notion',
      aiLabel:   'Notion',
      aiIcon:    '📋',
    },
  };
}

// ─── DB 폴링 ────────────────────────────────────────
async function pollDatabase(dbId) {
  const since = lastChecked[dbId];
  const body = {
    page_size: 20,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    ...(since ? {
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { after: since },
      },
    } : {}),
  };

  const result = await notionRequest(`/v1/databases/${dbId}/query`, body);
  if (!result.results) return [];

  // DB 이름 가져오기 (첫 폴링 시)
  let dbName = dbId.slice(0, 8);
  try {
    const dbInfo = await notionRequest(`/v1/databases/${dbId}`);
    dbName = dbInfo.title?.map(t => t.plain_text).join('') || dbName;
  } catch {}

  lastChecked[dbId] = new Date().toISOString();
  return result.results.map(p => pageToEvent(p, dbName));
}

// ─── Orbit 서버에 이벤트 전송 ───────────────────────
function postToOrbit(events) {
  if (events.length === 0) return;
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
  console.log(`[Notion] ${events.length}개 이벤트 전송 (채널: ${CHANNEL_ID})`);
}

// ─── 메인 폴링 루프 ─────────────────────────────────
async function poll() {
  for (const dbId of DATABASE_IDS) {
    try {
      const events = await pollDatabase(dbId.trim());
      postToOrbit(events);
    } catch (e) {
      console.warn(`[Notion] DB ${dbId} 폴링 실패:`, e.message);
    }
  }
}

console.log(`[Notion] 시작 - DB ${DATABASE_IDS.length}개 감시 중 (${POLL_INTERVAL / 1000}초 간격)`);
poll(); // 즉시 1회 실행
setInterval(poll, POLL_INTERVAL);
