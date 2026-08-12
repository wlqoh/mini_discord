export type PermissionState = "default" | "granted" | "denied" | "unsupported";

const SOFT_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DISMISSED_UNTIL_KEY = "notif.softPromptDismissedUntil";
const MISSED_MESSAGE_KEY = "notif.hasMissedMessage";

export function getPermissionState(): PermissionState {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
    if (typeof Notification === "undefined") return "unsupported";
    try {
        return await Notification.requestPermission();
    } catch {
        return getPermissionState();
    }
}

/** Call whenever a message would have notified the user but permission isn't granted yet. */
export function markMessageMissed(): void {
    try {
        localStorage.setItem(MISSED_MESSAGE_KEY, "true");
    } catch {
        // ignore storage errors
    }
}

export function clearMissedMessageFlag(): void {
    try {
        localStorage.removeItem(MISSED_MESSAGE_KEY);
    } catch {
        // ignore storage errors
    }
}

/**
 * The soft pre-prompt banner should appear only after a genuine missed
 * message, never on first load, and not again until the cooldown elapses
 * after being dismissed.
 */
export function shouldShowSoftPrompt(): boolean {
    if (getPermissionState() !== "default") return false;
    try {
        if (localStorage.getItem(MISSED_MESSAGE_KEY) !== "true") return false;
        const dismissedUntil = Number(localStorage.getItem(DISMISSED_UNTIL_KEY) ?? "0");
        return Date.now() >= dismissedUntil;
    } catch {
        return false;
    }
}

export function dismissSoftPrompt(): void {
    try {
        localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + SOFT_PROMPT_COOLDOWN_MS));
    } catch {
        // ignore storage errors
    }
}
