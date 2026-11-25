/* 培训考试系统 v3.0 · Service Worker
 * 只缓存页面外壳（HTML/CSS/二维码/offline.js），API 请求一律不拦截、不缓存。
 * 导航请求 network-first：断网时回退到已缓存的考试页面，配合 outbox 继续作答。
 * /api/stream (SSE) 与所有 /api/* 直接放行，避免干扰大屏实时通道。
 */
var CACHE = 'exam-shell-v3';
var SHELL = ['/', '/index.html', '/student.css', '/share.html', '/qr_student.png', '/qr_admin.png', '/offline.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, u;
  try { u = new URL(req.url); } catch (_) { return; }
  if (req.method !== 'GET' || u.origin !== self.location.origin) return;
  if (u.pathname.indexOf('/api/') === 0 || u.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (r) {
      if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { return c.put('/index.html', cp); }); }
      return r;
    }).catch(function () {
      return caches.match('/index.html').then(function (hit) {
        return hit || new Response('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">离线中，请恢复网络后刷新页面。</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      });
    }));
    return;
  }

  e.respondWith(caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (r) {
      if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { return c.put(req, cp); }); }
      return r;
    }).catch(function () { return caches.match('/index.html'); });
  }));
});
