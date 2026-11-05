/* =====================================================================
   Planner — service-worker.js
   Offline-first caching:
   - the app shell (all local files) is precached on install, so after
     the first visit the whole app works with no connection at all
   - Google Fonts are cached at runtime (stale-while-revalidate), so
     typography also survives offline; until then the system fallback
     fonts are used
   All paths are relative, so this works from a subfolder on GitHub
   Pages / Cloudflare Pages / Netlify.
   ===================================================================== */
'use strict';

var VERSION = 'planner-v1.0.0';
var SHELL_CACHE = VERSION + '-shell';
var RUNTIME_CACHE = VERSION + '-runtime';

var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/core.js',
  './js/data.js',
  './js/scheduling.js',
  './js/calendar-links.js',
  './js/ui.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(VERSION) !== 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  var isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  // Navigations → the cached shell (so the app opens offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(function (hit) {
        return hit || fetch(req);
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // Fonts → stale-while-revalidate in the runtime cache
  if (isFont) {
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          var refetch = fetch(req).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
          }).catch(function () { return hit; });
          return hit || refetch;
        });
      })
    );
    return;
  }

  // Same-origin assets → cache-first, then network (and cache the result)
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
  }
  // Anything else (there shouldn't be anything else) goes to the network.
});
