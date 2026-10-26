// オフラインでも開けるようにする Service Worker。
// 方針: ネットワークを先に試し（常に最新）、つながらないときだけ保存済みの内容を返す。
// VERSION は tools/bump-version.py が更新する。
const VERSION = '202610262004';
const CACHE = 'yokattana-' + VERSION;
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'theme.js',
  'supabase-config.js',
  'tmdb-config.js',
  'tmdb-logo.svg',
  'manifest.webmanifest',
  'icon.svg',
  'privacy.html',
  'share.html',
  'share.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(asset => cache.add(new Request(asset, { cache: 'reload' })).catch(() => {})));
    await cache.add(new Request(SUPABASE_JS, { mode: 'cors', cache: 'reload' })).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('yokattana-') && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 自分のサイトと、固定した supabase-js だけを扱う（Supabase への通信などには触れない）
  if (url.origin !== self.location.origin && url.href !== SUPABASE_JS) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok) cache.put(request, response.clone());
      return response;
    }
    catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
