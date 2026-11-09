const CACHE = 'spend-v9';
const ASSETS = ['./', './index.html', './runtime.js', './calcs.js', './app.js', './loader.js', './main.js', './add.js', './push.js', './settings.js', './vendor/d3.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for this app's own files so updates arrive, with the saved copy as the offline fallback.
// Requests to GitHub's API are never touched here, so purchase data is never stored by the worker.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only good answers are saved, so a failed load never replaces the working offline copy.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

// Alerts from the spending job. Every push must show a notification.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Spending', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: data.url || './' }
    })
  );
});

// Tapping an alert opens the app, or brings it forward and asks it to load the newest purchases.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.indexOf(self.registration.scope) === 0);
      if (open) {
        open.postMessage('refresh');
        return open.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
