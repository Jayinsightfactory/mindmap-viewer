/**
 * Orbit Chrome Extension — background.js (v3 — Hybrid Cloud)
 * ─────────────────────────────────────────────────────────────────────────────
 * 역할:
 *   1. content-ai.js에서 AI 대화 수신 → chrome.storage.local 저장
 *   2. 설정된 서버(localhost 또는 클라우드)로 전달
 *   3. 30분마다 미전송 데이터 재시도
 *   4. 탭 방문 시간 추적 (기존 기능 유지)
 *
 * 서버 설정:
 *   - orbit_server_url: 서버 URL (기본 http://localhost:4747)
 *   - orbit_token: 클라우드 서버 인증 토큰
 *   - 클라우드 전송 시 fromRemote: true 추가 (서버 재포워딩 방지)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DEFAULT_SERVER_URL = 'https://mindmap-viewer-production.up.railway.app';
const MAX_STORED   = 500;        // chrome.storage에 최대 보관 대화 수
const RETRY_ALARM  = 'orbit-retry';
const MIN_STAY_MS  = 5000;       // 탭 방문: 5초 이상 머문 페이지만

// ── 서버 설정 (URL + 인증 토큰) ──────────────────────────────────────────────
async function getServerConfig() {
  const { orbit_server_url, orbit_token } = await chrome.storage.local.get(['orbit_server_url', 'orbit_token']);
  return {
    url:   (orbit_server_url || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    token: orbit_token || '',
  };
}

// ── 탭 방문 추적 (기존 기능) ──────────────────────────────────────────────────
let lastTabId = null;
const tabTimes = {};

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (lastTabId !== null && tabTimes[lastTabId]) {
    const stayed = Date.now() - tabTimes[lastTabId];
    if (stayed >= MIN_STAY_MS) {
      try {
        const tab = await chrome.tabs.get(lastTabId);
        if (tab.url && !tab.url.startsWith('chrome://')) {
          await sendBrowserActivity(tab.url, tab.title, stayed);
        }
      } catch {}
    }
  }
  lastTabId = tabId;
  tabTimes[tabId] = Date.now();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') tabTimes[tabId] = Date.now();
});
chrome.tabs.onRemoved.addListener((tabId) => { delete tabTimes[tabId]; });

async function sendBrowserActivity(url, title, stayMs) {
  const { enabled, private_mode } = await chrome.storage.local.get(['enabled', 'private_mode']);
  if (enabled === false) return;
  const config = await getServerConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
  const isRemote = !config.url.includes('localhost') && !config.url.includes('127.0.0.1');
  try {
    await fetch(`${config.url}/api/browser-activity`, {
      method: 'POST', headers,
      body: JSON.stringify({ url: private_mode ? '(private)' : url, title, stayMs, timestamp: new Date().toISOString(), ...(isRemote ? { fromRemote: true } : {}) }),
    });
  } catch {}
}

// ── content-ai.js 메시지 수신 ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ai_conversation') {
    handleConversation(msg).then(() => sendResponse({ ok: true })).catch(console.error);
    return true; // 비동기 응답 필수
  }
  if (msg.type === 'get_conversations') {
    getStoredConversations().then(sendResponse);
    return true;
  }
  if (msg.type === 'get_stats') {
    getStats().then(sendResponse);
    return true;
  }
  if (msg.type === 'toggle_shared') {
    toggleShared(msg.id, msg.shared).then(sendResponse);
    return true;
  }
  if (msg.type === 'delete_conversation') {
    deleteConversation(msg.id).then(sendResponse);
    return true;
  }
});

// ── 대화 처리 메인 ────────────────────────────────────────────────────────────
async function handleConversation(conv) {
  const { enabled } = await chrome.storage.local.get(['enabled']);
  if (enabled === false) return;

  // 1. chrome.storage에 원문 저장 (항상 로컬)
  const id = await saveConversation(conv);

  // 2. 서버로 전달 (configurable URL)
  await sendToServer({ ...conv, id });
}

// ── chrome.storage.local 저장 ─────────────────────────────────────────────────
async function saveConversation(conv) {
  const { conversations = [] } = await chrome.storage.local.get('conversations');

  // 같은 URL 대화 업데이트 (새 메시지 추가)
  const existIdx = conversations.findIndex(c => c.url === conv.url);
  const id = existIdx >= 0
    ? conversations[existIdx].id
    : `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const record = {
    id,
    site:       conv.site,
    url:        conv.url,
    title:      conv.title || conv.site,
    messages:   conv.messages,   // 원문 — 로컬에만
    msgCount:   conv.messages.length,
    shared:     false,           // 기본: 비공개
    capturedAt: conv.capturedAt || new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
    synced:     false,
  };

  if (existIdx >= 0) {
    conversations[existIdx] = { ...conversations[existIdx], ...record };
  } else {
    conversations.unshift(record);
    if (conversations.length > MAX_STORED) conversations.splice(MAX_STORED);
  }

  await chrome.storage.local.set({ conversations });
  return id;
}

// ── Orbit 서버로 전송 (로컬 또는 클라우드) ────────────────────────────────────
async function sendToServer(conv) {
  try {
    const config = await getServerConfig();
    const headers = { 'Content-Type': 'application/json' };
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
    const isRemote = !config.url.includes('localhost') && !config.url.includes('127.0.0.1');
    const res = await fetch(`${config.url}/api/ai-conversation`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ ...conv, ...(isRemote ? { fromRemote: true } : {}) }),
      signal:  AbortSignal.timeout(5000),
    });
    if (res.ok) await markSynced(conv.id);
  } catch {
    // 서버 미실행 → 나중에 retry
  }
}

async function markSynced(id) {
  const { conversations = [] } = await chrome.storage.local.get('conversations');
  const idx = conversations.findIndex(c => c.id === id);
  if (idx >= 0) {
    conversations[idx].synced = true;
    await chrome.storage.local.set({ conversations });
  }
}

// ── 미전송 재시도 (30분 알람) ─────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  const { conversations = [] } = await chrome.storage.local.get(['conversations']);
  const unsynced = conversations.filter(c => !c.synced).slice(0, 20);
  for (const conv of unsynced) await sendToServer(conv);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 30 });
});

// ── 팝업용 헬퍼 ──────────────────────────────────────────────────────────────
async function getStoredConversations() {
  const { conversations = [] } = await chrome.storage.local.get('conversations');
  // 팝업에는 messages 원문 제외하고 메타데이터만 반환 (보안)
  return conversations.map(({ messages: _, ...meta }) => meta);
}

async function getStats() {
  const { conversations = [] } = await chrome.storage.local.get('conversations');
  const bySite = {};
  for (const c of conversations) {
    if (!bySite[c.site]) bySite[c.site] = { count: 0, msgs: 0 };
    bySite[c.site].count++;
    bySite[c.site].msgs += c.msgCount || 0;
  }
  return { total: conversations.length, bySite, synced: conversations.filter(c => c.synced).length };
}

async function toggleShared(id, shared) {
  const { conversations = [] } = await chrome.storage.local.get('conversations');
  const idx = conversations.findIndex(c => c.id === id);
  if (idx >= 0) { conversations[idx].shared = shared; await chrome.storage.local.set({ conversations }); }
  return { ok: true };
}

async function deleteConversation(id) {
  const { conversations = [] } = await chrome.storage.local.get('conversations');
  await chrome.storage.local.set({ conversations: conversations.filter(c => c.id !== id) });
  return { ok: true };
}
