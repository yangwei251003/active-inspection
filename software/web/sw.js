/* 只缓存公开界面资源。API、WebSocket、视频、截图和凭据永不进入缓存。 */
const CACHE = 'fieldnote-shell-v1';
const SHELL = ['/', '/index.html', '/assets/styles.css', '/assets/app.js', '/assets/model.js', '/assets/api.js', '/assets/whep.js', '/assets/ble.js', '/assets/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fieldnote-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || Response.error())));
});
