import type { NotificationLevel, NotificationSettings } from "../../types/notifications.ts";

export type NotifyDecision = "none" | "message" | "mention";

export interface NotifiableMessage {
    id: number;
    channel_id: number;
    author_id: number;
    mentions?: number[];
    mentions_everyone?: boolean;
    reply_to?: { author_id: number } | null;
}

export interface NotifyContext {
    currentUserId: number | null;
    activeChannelId: number;
    isPageVisible: boolean;
    serverId: number;
    settings: NotificationSettings | null;
}

export function isMention(msg: NotifiableMessage, currentUserId: number | null): boolean {
    if (currentUserId === null) return false;
    return Boolean(
        msg.mentions?.includes(currentUserId) ||
        msg.reply_to?.author_id === currentUserId ||
        msg.mentions_everyone,
    );
}

function isTimeInFuture(iso: string | null, now: number): boolean {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t > now;
}

/** Resolves the effective level via channel → server → global inheritance (NOTIFICATIONS_PLAN.md §2 decision 4). */
export function resolveLevel(settings: NotificationSettings | null, serverId: number, channelId: number): NotificationLevel {
    if (!settings) return "all";

    const channelOverride = settings.channels.find((c) => c.channel_id === channelId);
    if (channelOverride?.level) return channelOverride.level;

    const serverOverride = settings.servers.find((s) => s.server_id === serverId);
    if (serverOverride?.level) return serverOverride.level;

    return settings.default_level;
}

export function isMuted(settings: NotificationSettings | null, serverId: number, channelId: number, now = Date.now()): boolean {
    if (!settings) return false;

    const channelOverride = settings.channels.find((c) => c.channel_id === channelId);
    if (isTimeInFuture(channelOverride?.muted_until ?? null, now)) return true;

    const serverOverride = settings.servers.find((s) => s.server_id === serverId);
    if (isTimeInFuture(serverOverride?.muted_until ?? null, now)) return true;

    return false;
}

export function isDoNotDisturb(settings: NotificationSettings | null, now = Date.now()): boolean {
    if (!settings) return false;
    return isTimeInFuture(settings.dnd_until, now);
}

/**
 * Base suppression + settings resolution shared by the WS-live path and
 * (mirrored server-side for push) — see NOTIFICATIONS_PLAN.md §5.3 and §4.5.
 * Any change here needs the same change in internal/service/push's send
 * policy, or a background tab and a closed tab will disagree about whether
 * to notify.
 */
export function shouldNotify(msg: NotifiableMessage, ctx: NotifyContext): NotifyDecision {
    if (ctx.currentUserId !== null && msg.author_id === ctx.currentUserId) return "none";
    if (msg.channel_id === ctx.activeChannelId && ctx.isPageVisible) return "none";
    if (isDoNotDisturb(ctx.settings)) return "none";

    const level = resolveLevel(ctx.settings, ctx.serverId, msg.channel_id);
    if (level === "none") return "none";
    if (isMuted(ctx.settings, ctx.serverId, msg.channel_id)) return "none";

    const mention = isMention(msg, ctx.currentUserId);
    if (level === "mentions" && !mention) return "none";

    return mention ? "mention" : "message";
}
