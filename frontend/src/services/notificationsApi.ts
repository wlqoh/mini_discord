import API from "../api";
import { extractApiError } from "./apiError.ts";
import type { NotificationLevel, NotificationSettings } from "../types/notifications.ts";

type RawOverride = {
    server_id?: number;
    channel_id?: number;
    level?: NotificationLevel | null;
    muted_until?: string | null;
};

type RawSettings = {
    default_level?: NotificationLevel;
    hide_message_preview?: boolean;
    dnd_until?: string | null;
    servers?: RawOverride[];
    channels?: RawOverride[];
};

function toSettings(raw: RawSettings): NotificationSettings {
    return {
        default_level: raw.default_level === "mentions" || raw.default_level === "none" ? raw.default_level : "all",
        hide_message_preview: raw.hide_message_preview === true,
        dnd_until: raw.dnd_until ?? null,
        servers: Array.isArray(raw.servers)
            ? raw.servers
                .filter((o): o is RawOverride & { server_id: number } => typeof o.server_id === "number")
                .map((o) => ({ server_id: o.server_id, level: o.level ?? null, muted_until: o.muted_until ?? null }))
            : [],
        channels: Array.isArray(raw.channels)
            ? raw.channels
                .filter((o): o is RawOverride & { channel_id: number } => typeof o.channel_id === "number")
                .map((o) => ({ channel_id: o.channel_id, level: o.level ?? null, muted_until: o.muted_until ?? null }))
            : [],
    };
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
    try {
        const res = await API.get<RawSettings>("/notifications/settings");
        return toSettings(res.data);
    } catch (err) {
        throw new Error(extractApiError(err, "Failed to load notification settings"));
    }
}

export type GlobalSettingsPatch = {
    default_level?: NotificationLevel;
    hide_message_preview?: boolean;
    dnd_until?: string | null;
};

export async function patchGlobalNotificationSettings(patch: GlobalSettingsPatch): Promise<NotificationSettings> {
    try {
        const res = await API.patch<RawSettings>("/notifications/settings", patch);
        return toSettings(res.data);
    } catch (err) {
        throw new Error(extractApiError(err, "Failed to update notification settings"));
    }
}

export type ScopedSettingPatch = {
    level: NotificationLevel | null;
    muted_until: string | null;
};

export async function putServerNotificationSetting(serverId: number, patch: ScopedSettingPatch): Promise<NotificationSettings> {
    try {
        const res = await API.put<RawSettings>(`/notifications/settings/server/${serverId}`, patch);
        return toSettings(res.data);
    } catch (err) {
        throw new Error(extractApiError(err, "Failed to update server notification setting"));
    }
}

export async function putChannelNotificationSetting(channelId: number, patch: ScopedSettingPatch): Promise<NotificationSettings> {
    try {
        const res = await API.put<RawSettings>(`/notifications/settings/channel/${channelId}`, patch);
        return toSettings(res.data);
    } catch (err) {
        throw new Error(extractApiError(err, "Failed to update channel notification setting"));
    }
}
