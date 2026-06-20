const CACHE = "app-shell-v1";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
        ).then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== "GET") return;
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
    if (url.origin !== self.location.origin) return;

    // Network-first for navigations so new deploys aren't broken by stale
    // index.html referencing purged hashed chunks.
    if (e.request.mode === "navigate") {
        e.respondWith(
            fetch(e.request)
                .then((res) => {
                    if (res.ok && res.type === "basic") {
                        const clone = res.clone();
                        caches.open(CACHE).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request).then((c) => c ?? caches.match("/index.html"))),
        );
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cached) => {
            const network = fetch(e.request).then((res) => {
                if (res.ok && res.type === "basic") {
                    const clone = res.clone();
                    caches.open(CACHE).then((c) => c.put(e.request, clone));
                }
                return res;
            });
            return cached ?? network;
        }),
    );
});
