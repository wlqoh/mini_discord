import { useEffect, useRef } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import type { ChannelsByServer, Message } from "../types/chat.ts";
import type { NotificationSettings } from "../types/notifications.ts";
import { notify, shouldShowSoftPrompt } from "../services/notifications";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    isConnected: boolean;
    isPageVisible: boolean;
    currentUserId: number | null;
    selectedChannelId: number;
    channelsByServer: ChannelsByServer;
    settings: NotificationSettings | null;
    onMissedPermission?: () => void;
};

function resolveAuthorName(message: Message): string {
    const nickname = message.author_nickname?.trim();
    if (nickname) return nickname;
    const fullName = [message.author_first_name, message.author_last_name].filter(Boolean).join(" ").trim();
    return fullName || "Someone";
}

function resolveChannelName(channelId: number, channelsByServer: ChannelsByServer): string {
    for (const list of Object.values(channelsByServer)) {
        const found = list.find((channel) => channel.id === channelId);
        if (found) return found.name;
    }
    return String(channelId);
}

function resolveServerId(channelId: number, channelsByServer: ChannelsByServer): number {
    for (const [serverId, list] of Object.entries(channelsByServer)) {
        if (list.some((channel) => channel.id === channelId)) return Number(serverId);
    }
    return 0;
}

function resolveBody(message: Message): string {
    if (message.content) return message.content;
    if (message.attachments && message.attachments.length > 0) return "📎 Attachment";
    return "New message";
}

/** Wires incoming WS messages to the notifications facade (sound + SW display). */
export function useNotifications({
    socketRef,
    isConnected,
    isPageVisible,
    currentUserId,
    selectedChannelId,
    channelsByServer,
    settings,
    onMissedPermission,
}: Params): void {
    const selectedChannelIdRef = useRef(selectedChannelId);
    useEffect(() => {
        selectedChannelIdRef.current = selectedChannelId;
    }, [selectedChannelId]);

    const isPageVisibleRef = useRef(isPageVisible);
    useEffect(() => {
        isPageVisibleRef.current = isPageVisible;
    }, [isPageVisible]);

    const channelsByServerRef = useRef(channelsByServer);
    useEffect(() => {
        channelsByServerRef.current = channelsByServer;
    }, [channelsByServer]);

    const settingsRef = useRef(settings);
    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    const onMissedPermissionRef = useRef(onMissedPermission);
    useEffect(() => {
        onMissedPermissionRef.current = onMissedPermission;
    }, [onMissedPermission]);

    useEffect(() => {
        if (!isConnected || !socketRef.current) return;
        const socket = socketRef.current;

        const unsubscribe = socket.onMessage((incoming) => {
            const channelName = resolveChannelName(incoming.channel_id, channelsByServerRef.current);
            const serverId = resolveServerId(incoming.channel_id, channelsByServerRef.current);
            const hidePreview = settingsRef.current?.hide_message_preview ?? false;

            const title = hidePreview ? "MuArAb" : `${resolveAuthorName(incoming)} — #${channelName}`;
            const body = hidePreview ? `New message in #${channelName}` : resolveBody(incoming);

            void notify({
                message: incoming,
                ctx: {
                    currentUserId,
                    activeChannelId: selectedChannelIdRef.current,
                    isPageVisible: isPageVisibleRef.current,
                    serverId,
                    settings: settingsRef.current,
                },
                title,
                body,
                icon: hidePreview ? undefined : incoming.author_avatar_url,
                tag: `channel-${incoming.channel_id}`,
                data: {
                    channel_id: incoming.channel_id,
                    server_id: serverId,
                    message_id: incoming.id,
                    url: `/?channel=${incoming.channel_id}&message=${incoming.id}`,
                },
            }).then((outcome) => {
                if (outcome === "blocked-by-permission" && shouldShowSoftPrompt()) {
                    onMissedPermissionRef.current?.();
                }
            });
        });

        return () => unsubscribe();
    }, [isConnected, socketRef, currentUserId]);
}
