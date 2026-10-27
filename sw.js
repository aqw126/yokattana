// オフラインでも開けて、2回目からはすぐに表示できるようにする Service Worker。
// 方針: 保存済みの内容をすぐに返し、裏でネットワークから取り直して保存し直す（次に開いたときに最新になる）。
// 保存済みの内容がないときだけ、ネットワークを待つ。
// 公開した新しい版は、この sw.js が変わることで届く（新しい版を保存し直し、app.js がトーストで知らせる）。
// VERSION は tools/bump-version.py が更新する。
const VERSION = '202610271818';
const CACHE = 'yokattana-' + VERSION;
// 版を固定しているので、中身は変わらない。保存済みならネットワークに問い合わせない
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const ASSETS = [
  './',
  'index.html',
  'theme.js',
  'tmdb-logo.svg',
  'manifest.webmanifest',
  'icon.svg',
  'privacy.html',
  'guide.html',
  'share.html'
];
// 各ページが ?v= を付けて読むもの。読むときと同じ URL で保存しておく
const VERSIONED = ['styles.css', 'app.js', 'store.js', 'supabase-config.js', 'tmdb-config.js', 'share.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = [...ASSETS, ...VERSIONED, ...VERSIONED.map(name => `${name}?v=${VERSION}`)];
    await Promise.all(urls.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
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
  const navigate = request.mode === 'navigate';
  // ページは ?code=（ログインの戻り）や ?id=（共有リンク）を除いた URL で保存する
  const key = navigate ? url.origin + url.pathname : request;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ページ以外は、?v= まで一致したものだけを使う（古い版の app.js を新しい版のページと組み合わせない）
    const cached = await cache.match(key);
    if (cached && url.href === SUPABASE_JS) return cached;
    const network = fetch(request, { cache: 'no-cache' }).then(async response => {
      if (response.ok) await cache.put(key, response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try { return await network; }
    catch {
      const fallback = await cache.match(request, { ignoreSearch: true });
      if (fallback) return fallback;
      if (navigate) return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
