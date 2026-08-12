const CACHE = "app-shell-v2";
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

// Web Push arrives here when the tab is backgrounded or fully closed. The
// payload shape is produced by internal/service/push/payload.go — keep the
// two in sync (see NOTIFICATIONS_PLAN.md §4.6).
self.addEventListener("push", (e) => {
    let payload = {};
    try {
        payload = e.data ? e.data.json() : {};
    } catch {
        payload = {};
    }

    const title = payload.title || "MuArAb";
    const options = {
        body: payload.body || "",
        icon: payload.icon,
        badge: payload.badge || "/favicon-192x192.png",
        tag: payload.tag,
        renotify: true,
        data: payload.data || {},
    };

    e.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing tab and hand it the click's target channel/message via
// postMessage; if no tab is open, fall back to opening one with the target
// encoded in the query string (read on boot by ChatPage.tsx).
self.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const data = e.notification.data || {};

    e.waitUntil(
        (async () => {
            const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            const target = allClients.find((c) => {
                try {
                    return new URL(c.url).origin === self.location.origin;
                } catch {
                    return false;
                }
            });

            if (target) {
                await target.focus();
                target.postMessage({ type: "notification-click", ...data });
                return;
            }

            await self.clients.openWindow(data.url || "/");
        })(),
    );
});
