// Watchlivo Service Worker v20261105_v118
// Watchlivo Rave-Parity Service Worker (Zero-Cache Network-Only + Push & Background OS Notifications)
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {})
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

function buildNotificationOptions(payload = {}) {
  const title = String(payload.title || 'Watchlivo — Birlikte İzle');
  const body = String(payload.body || 'Arkadaşın seni sinema odasına davet ediyor!');
  const roomUrl = String(payload.url || (payload.roomId ? `/#/mesh/${encodeURIComponent(payload.roomId)}` : '/#/'));
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
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'WATCHLIVO_SHOW_NOTIFICATION') {
    const { title, options } = buildNotificationOptions(msg.payload || {});
    event.waitUntil(self.registration.showNotification(title, options));
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
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'WATCHLIVO_NOTIFICATION_CLICK', url: targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
