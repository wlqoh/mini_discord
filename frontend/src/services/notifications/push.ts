import API from "../../api";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/** Returns null when push is disabled server-side (404) or misconfigured — callers should fail silently. */
export async function getPushPublicKey(): Promise<string | null> {
    try {
        const res = await API.get<{ key?: string }>("/push/public-key");
        return res.data.key ?? null;
    } catch {
        return null;
    }
}

/**
 * Subscribes this browser to Web Push and registers the subscription with
 * the backend. No-ops (returns false) whenever any prerequisite is missing —
 * SW, PushManager, an active registration, or a server-side VAPID key —
 * since push is an enhancement on top of the always-available WS path.
 */
export async function subscribeToPush(): Promise<boolean> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;

    const publicKey = await getPushPublicKey();
    if (!publicKey) return false;

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
        try {
            subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        } catch {
            return false;
        }
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    try {
        await API.post("/push/subscribe", {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        });
        return true;
    } catch {
        return false;
    }
}

/** Best-effort: unsubscribes locally and tells the server, so the next account on this device doesn't inherit push. */
export async function unsubscribeFromPush(): Promise<void> {
    if (!("serviceWorker" in navigator)) return;

    try {
        const reg = await navigator.serviceWorker.getRegistration();
        const subscription = await reg?.pushManager.getSubscription();
        if (!subscription) return;

        const endpoint = subscription.endpoint;
        await subscription.unsubscribe().catch(() => {});
        await API.post("/push/unsubscribe", { endpoint }).catch(() => {});
    } catch {
        // best-effort cleanup only
    }
}
