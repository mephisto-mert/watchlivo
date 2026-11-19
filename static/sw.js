// Watchlivo Service Worker v20261119_v222
// Watchlivo Rave-Parity Service Worker (Zero-Cache Network-Only + Offline Fallback + Push & OS Notifications)
const OFFLINE_HTML = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Çevrimdışı — Watchlivo</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#070a10; color:#f8fafc; font-family:system-ui,-apple-system,sans-serif; padding:24px; text-align:center; }
    .card { max-width:420px; padding:28px; border-radius:20px; background:#0e1522; border:1px solid rgba(39,220,200,.28); }
    h1 { margin:0 0 10px; font-size:1.25rem; }
    p { margin:0 0 18px; font-size:.92rem; color:#94a3b8; line-height:1.55; }
    button { border:none; border-radius:12px; padding:12px 22px; background:#27dcc8; color:#041014; font-weight:800; font-size:.95rem; cursor:pointer; }
  </style>
</head>
<body>
  <main class="card">
    <h1>📡 İnternet Bağlantısı Yok</h1>
    <p>Watchlivo canlı senkronizasyon odalarına bağlanmak için internet bağlantınızı kontrol edip tekrar deneyin.</p>
    <a href="/" onclick="location.reload();return false" class="btn" style="display:inline-block;text-decoration:none;border-radius:12px;padding:12px 22px;background:#27dcc8;color:#041014;font-weight:800;font-size:.95rem;">Yeniden Dene</a>
  </main>
</body>
</html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => {})
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    }))
  );
});

function buildNotificationOptions(payload = {}) {
  const title = String(payload.title || 'Watchlivo — Birlikte İzle');
  const body = String(payload.body || 'Arkadaşın seni sinema odasına davet ediyor!');
  let fallbackRoomUrl = '/#/';
  if (payload.roomId) {
    const rawR = String(payload.roomId);
    const qIdx = rawR.indexOf('?');
    fallbackRoomUrl = qIdx >= 0
      ? `/#/mesh/${encodeURIComponent(rawR.slice(0, qIdx))}${rawR.slice(qIdx)}`
      : `/#/mesh/${encodeURIComponent(rawR)}`;
  }
  const roomUrl = String(payload.url || fallbackRoomUrl);
  return {
    title,
    options: {
      body,
      icon: payload.icon || '/static/watchlivo-icon-192.png',
      badge: payload.badge || '/static/watchlivo-icon-192.png',
      tag: payload.tag || `watchlivo-${payload.id || Date.now()}`,
      renotify: true,
      vibrate: [180, 80, 180],
      data: {
        url: roomUrl,
        roomId: payload.roomId || '',
        fromName: payload.fromName || '',
      },
      actions: [
        { action: 'join', title: '🎬 Odaya Katıl' },
        { action: 'dismiss', title: 'Kapat' },
      ],
    },
  };
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const { title, options } = buildNotificationOptions(data);
  event.waitUntil(self.registration.showNotification(title, options).catch(() => {}));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'WATCHLIVO_SHOW_NOTIFICATION') {
    const { title, options } = buildNotificationOptions(msg.payload || {});
    event.waitUntil(self.registration.showNotification(title, options).catch(() => {}));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  let targetUrl = '/#/';
  try {
    const parsed = new URL(String(event.notification.data?.url || '/#/'), self.location.origin);
    if (parsed.origin === self.location.origin) targetUrl = parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {}
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) {
          try { await client.focus(); } catch (_) {}
          if ('navigate' in client && targetUrl) {
            try { await client.navigate(targetUrl); } catch (_) {}
          }
          client.postMessage({ type: 'VORTEX_NAVIGATE', url: targetUrl });
          client.postMessage({ type: 'WATCHLIVO_NOTIFICATION_CLICK', url: targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })().catch(() => {})
  );
});
