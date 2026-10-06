// 離線支援：App 畫面與照片（票券）快取。
// 畫面檔案走「網路優先」：有網路一定拿最新版（更新馬上生效），沒網路才用快取。
// 照片走「快取優先」：照片網址不會變，看過一次就存起來，離線也能看票券。
const SHELL_CACHE = "tta-shell-v1";
const PHOTO_CACHE = "tta-photos-v1";
const SHELL = ["/", "/index.html", "/app.js", "/photos.js", "/style.css", "/manifest.webmanifest", "/icon.svg", "/vendor/marked.min.js", "/vendor/purify.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/photo/")) {
    e.respondWith(
      caches.open(PHOTO_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // 其他 API 與 WebSocket 不快取
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (await caches.match("/")) || Response.error()),
  );
});
