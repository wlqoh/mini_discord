import type { NotificationClickData } from "../../types/notifications.ts";
import { isLeader } from "./leader.ts";
import { markMessageMissed, getPermissionState } from "./permission.ts";
import { type NotifiableMessage, type NotifyContext, shouldNotify } from "./rules.ts";
import { playSound } from "./sound.ts";

export { initSoundUnlock, isSoundUnlocked, getVolume, setVolume, isSoundEnabled, setSoundEnabled, playSound } from "./sound.ts";
export { initLeaderElection, isLeader } from "./leader.ts";
export { getPushPublicKey, subscribeToPush, unsubscribeFromPush } from "./push.ts";
export * from "./permission.ts";
export * from "./rules.ts";

const MAX_BODY_LENGTH = 120;

function truncate(text: string): string {
    return text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH - 1)}…` : text;
}

export interface NotifyInput {
    message: NotifiableMessage;
    ctx: NotifyContext;
    title: string;
    body: string;
    icon?: string;
    tag: string;
    data: NotificationClickData;
}

export type NotifyOutcome = "shown" | "skipped" | "blocked-by-permission";

/**
 * Single entry point used by useNotifications: decides whether to notify at
 * all, plays sound (leader tab only), and shows the browser notification via
 * the Service Worker registration (never `new Notification()` — that throws
 * on Android Chrome). Returns "blocked-by-permission" so callers can decide
 * whether to surface the soft pre-prompt banner (NOTIFICATIONS_PLAN.md §2 decision 11).
 */
export async function notify(input: NotifyInput): Promise<NotifyOutcome> {
    const decision = shouldNotify(input.message, input.ctx);
    if (decision === "none") return "skipped";

    if (isLeader()) {
        playSound(decision === "mention" ? "mention" : "message", {
            channelId: input.message.channel_id,
            bypassChannelLimit: decision === "mention",
        });
    }

    if (getPermissionState() !== "granted") {
        markMessageMissed();
        return "blocked-by-permission";
    }

    await showBrowserNotification(input.title, truncate(input.body), input.icon, input.tag, input.data);
    return "shown";
}

/** Used by the settings modal's "Test notification" / "Test sound" buttons — bypasses shouldNotify entirely. */
export async function sendTestNotification(): Promise<{ shown: boolean; reason?: string }> {
    playSound("message", { channelId: -1, bypassChannelLimit: true });

    if (getPermissionState() !== "granted") {
        return { shown: false, reason: "Notifications are not enabled in this browser yet." };
    }

    if (!("serviceWorker" in navigator)) {
        return { shown: false, reason: "This browser has no Service Worker support." };
    }

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
        return { shown: false, reason: "No Service Worker is registered for this page yet." };
    }

    try {
        const options: NotificationOptionsWithRenotify = {
            body: "This is what a new message notification looks like.",
            badge: "/favicon-192x192.png",
            tag: "test-notification",
            renotify: true,
            data: {},
        };
        await reg.showNotification("MuArAb — Test notification", options);
        return { shown: true };
    } catch {
        return { shown: false, reason: "Failed to display the notification." };
    }
}

// `renotify` is part of the Notification spec (re-alerts the user when a
// notification with the same `tag` replaces an existing one) but is missing
// from this project's TS DOM lib version.
type NotificationOptionsWithRenotify = NotificationOptions & { renotify?: boolean };

async function showBrowserNotification(
    title: string,
    body: string,
    icon: string | undefined,
    tag: string,
    data: NotificationClickData,
): Promise<void> {
    if (!("serviceWorker" in navigator)) return;

    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return;
        const options: NotificationOptionsWithRenotify = {
            body,
            icon,
            badge: "/favicon-192x192.png",
            tag,
            renotify: true,
            data,
        };
        await reg.showNotification(title, options);
    } catch {
        // Sound (if any) already played above — treat display failure as best-effort.
    }
}
