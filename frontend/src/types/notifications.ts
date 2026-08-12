export type NotificationLevel = "all" | "mentions" | "none";

export type SoundName = "message" | "mention" | "join" | "leave";

export type NotificationKind = "message" | "mention";

export interface ServerNotificationOverride {
    server_id: number;
    level: NotificationLevel | null;
    muted_until: string | null;
}

export interface ChannelNotificationOverride {
    channel_id: number;
    level: NotificationLevel | null;
    muted_until: string | null;
}

export interface NotificationSettings {
    default_level: NotificationLevel;
    hide_message_preview: boolean;
    dnd_until: string | null;
    servers: ServerNotificationOverride[];
    channels: ChannelNotificationOverride[];
}

export interface NotificationClickData {
    channel_id?: number;
    server_id?: number;
    message_id?: number;
    url?: string;
}
