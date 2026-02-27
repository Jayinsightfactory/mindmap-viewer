/**
 * Orbit Chrome Extension — background.js
 * 브라우저 탭 전환/방문을 Orbit에 전송
 */

const ORBIT_BROWSER_PORT = 4750;
const DEBOUNCE_MS = 3000;
const MIN_STAY_MS = 5000; // 5초 이상 머문 페이지만

let lastUrl    = '';
let lastSentTs = 0;
let lastTabId  = null;
let tabTimes   = {}; // tabId → enterTime

// ─── 탭 방문 감지 ──────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (lastTabId !== null && tabTimes[lastTabId]) {
    const stayed = Date.now() - tabTimes[lastTabId];
    if (stayed >= MIN_STAY_MS) {
      try {
        const tab = await chrome.tabs.get(lastTabId);
        if (tab.url && !tab.url.startsWith('chrome://')) {
          await sendActivity(tab.url, tab.title, stayed);
        }
      } catch {}
    }
  }
  lastTabId = tabId;
  tabTimes[tabId] = Date.now();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://')) return;
  if (tab.url === lastUrl && Date.now() - lastSentTs < DEBOUNCE_MS) return;

  tabTimes[tabId] = Date.now();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTimes[tabId];
});

// ─── Orbit 서버로 전송 ──────────────────────────
async function sendActivity(url, title, stayMs) {
  if (!url || url === lastUrl) return;

  const settings = await chrome.storage.local.get(['enabled', 'private_mode']);
  if (settings.enabled === false) return; // 비활성화

  lastUrl    = url;
  lastSentTs = Date.now();

  try {
    await fetch(`http://localhost:${ORBIT_BROWSER_PORT}/browser-activity`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        title,
        stayMs,
        privateMode: settings.private_mode || false,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Orbit 서버 미실행 시 무시
  }
}
