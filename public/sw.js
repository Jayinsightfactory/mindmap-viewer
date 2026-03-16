const CACHE_NAME = 'orbit-ai-v2';
const STATIC_ASSETS = [
  '/',
  '/orbit3d.html',
  '/css/orbit3d.css',
  '/favicon.svg',
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: only handle same-origin GET requests
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 외부 도메인: 바이패스 (CDN, 폰트, OAuth 등)
  if (url.origin !== self.location.origin) return;

  // API/WebSocket: 바이패스
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.url.startsWith('ws')) return;

  // POST 등: 바이패스
  if (event.request.method !== 'GET') return;

  // 동일 도메인 GET만: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
