/* =========================================================
   Service Worker：アプリ本体を端末にしまっておき、電波がなくても開けるようにする
   ・ページ（index.html）：まずネットから取る（更新をすぐ反映）。取れなければしまってあるもの
   ・js / css などと Firebase の部品：しまってあればそれを使う（ファイル名に版の番号が入っているので古くならない）
   ・Firestore やログインの通信には手を出さない
   ========================================================= */
const CACHE = 'canvas-note-v1';
const SDK_HOST = 'www.gstatic.com';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const cacheable = url => url.origin === self.location.origin || (url.host === SDK_HOST && url.pathname.startsWith('/firebasejs/'));
// ページは「…/」と「…/index.html」を同じものとしてしまう（? 以降は見ない）
const pageKey = url => url.origin + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);

// しまう。同じファイルの古い版（?v= 違い）は消す
async function put(req, res) {
  if (!res || !res.ok) return;
  const cache = await caches.open(CACHE), url = new URL(req.url);
  if (url.origin === self.location.origin && url.search) {
    for (const k of await cache.keys()) {
      const u = new URL(k.url);
      if (u.origin === url.origin && u.pathname === url.pathname && u.search !== url.search) await cache.delete(k);
    }
  }
  await cache.put(req, res);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;

  if (req.mode === 'navigate') {
    // ページ：ネット優先。3秒待っても来なければ、しまってあるものを出す
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const net = fetch(req).then(res => { if (res.ok) cache.put(pageKey(url), res.clone()); return res; });
      const timeout = new Promise(r => setTimeout(r, 3000));
      try {
        const res = await Promise.race([net, timeout]);
        if (res) return res;
      } catch {}
      const hit = await cache.match(pageKey(url));
      return hit || net;
    })());
    return;
  }
  // それ以外：しまってあればそれ、無ければネットから取ってしまう
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    e.waitUntil(put(req, res.clone()));
    return res;
  })());
});

// ページから「今読み込んだファイル」を教えてもらい、しまう（Service Worker が動く前に読んだ分）
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'cache') return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of e.data.urls) {
      try {
        const url = new URL(u);
        if (!cacheable(url)) continue;
        if (u === e.data.page) { // 今のページ
          const res = await fetch(url.origin + url.pathname);
          if (res.ok) await cache.put(pageKey(url), res);
          continue;
        }
        if (await cache.match(u)) continue;
        const res = await fetch(u, url.host === SDK_HOST ? { mode: 'cors' } : {});
        await put(new Request(u), res);
      } catch {}
    }
  })());
});
