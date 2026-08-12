import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket";
import type { ChannelsByServer, MessagesByChannel, UnreadByChannel, UnreadByServer } from "../types/chat";

const MARK_READ_THROTTLE_MS = 2000;

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    isConnected: boolean;
    isPageVisible: boolean;
    currentUserId: number | null;
    selectedChannelId: number;
    channelsByServer: ChannelsByServer;
    messagesByChannel: MessagesByChannel;
};

export function useUnread({
    socketRef,
    isConnected,
    isPageVisible,
    currentUserId,
    selectedChannelId,
    channelsByServer,
    messagesByChannel,
}: Params) {
    const [unreadByChannel, setUnreadByChannel] = useState<UnreadByChannel>({});

    const lastMessageIdByChannel = useRef<Record<number, number>>({});
    const serverIdByChannelRef = useRef<Record<number, number>>({});
    const pendingByChannelRef = useRef<Map<number, number>>(new Map());
    const lastSentByChannelRef = useRef<Map<number, number>>(new Map());
    const lastSentAtByChannelRef = useRef<Map<number, number>>(new Map());
    const timerByChannelRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const selectedChannelIdRef = useRef(selectedChannelId);
    useEffect(() => {
        selectedChannelIdRef.current = selectedChannelId;
    }, [selectedChannelId]);

    const isPageVisibleRef = useRef(isPageVisible);
    useEffect(() => {
        isPageVisibleRef.current = isPageVisible;
    }, [isPageVisible]);

    const sendNow = useCallback((channelId: number) => {
        const messageId = pendingByChannelRef.current.get(channelId);
        if (messageId === undefined) return;

        const lastSent = lastSentByChannelRef.current.get(channelId) ?? 0;
        if (messageId <= lastSent) {
            pendingByChannelRef.current.delete(channelId);
            return;
        }

        socketRef.current?.sendMarkRead(channelId, messageId);
        lastSentByChannelRef.current.set(channelId, messageId);
        lastSentAtByChannelRef.current.set(channelId, Date.now());
        pendingByChannelRef.current.delete(channelId);
    }, [socketRef]);

    const flushChannel = useCallback((channelId: number) => {
        const timer = timerByChannelRef.current.get(channelId);
        if (timer) {
            clearTimeout(timer);
            timerByChannelRef.current.delete(channelId);
        }
        sendNow(channelId);
    }, [sendNow]);

    const flushAll = useCallback(() => {
        const channelIds = Array.from(timerByChannelRef.current.keys());
        channelIds.forEach((channelId) => flushChannel(channelId));
    }, [flushChannel]);

    const scheduleSend = useCallback((channelId: number, messageId: number, force: boolean) => {
        const lastSent = lastSentByChannelRef.current.get(channelId) ?? 0;
        if (messageId <= lastSent) return;

        pendingByChannelRef.current.set(channelId, messageId);

        if (force) {
            flushChannel(channelId);
            return;
        }

        const now = Date.now();
        const lastSentAt = lastSentAtByChannelRef.current.get(channelId) ?? 0;
        if (now - lastSentAt >= MARK_READ_THROTTLE_MS) {
            sendNow(channelId);
            return;
        }

        if (timerByChannelRef.current.has(channelId)) return;

        const delay = MARK_READ_THROTTLE_MS - (now - lastSentAt);
        const timer = setTimeout(() => {
            timerByChannelRef.current.delete(channelId);
            sendNow(channelId);
        }, delay);
        timerByChannelRef.current.set(channelId, timer);
    }, [flushChannel, sendNow]);

    const markChannelRead = useCallback((channelId: number, messageId: number, force = false) => {
        if (channelId <= 0 || messageId <= 0) return;

        setUnreadByChannel((prev) => (prev[channelId] ? { ...prev, [channelId]: 0 } : prev));
        scheduleSend(channelId, messageId, force);
    }, [scheduleSend]);

    const refreshUnread = useCallback(async () => {
        const socket = socketRef.current;
        if (!socket) return;

        try {
            const channels = await socket.getUnread();
            const nextUnread: UnreadByChannel = {};
            channels.forEach((c) => {
                nextUnread[c.channel_id] = c.unread_count;
                if (c.server_id > 0) {
                    serverIdByChannelRef.current[c.channel_id] = c.server_id;
                }
            });
            setUnreadByChannel(nextUnread);
        } catch {
            // best-effort; the next reconnect will retry
        }
    }, [socketRef]);

    // Subscribe to incoming messages: track last known id per channel and
    // either mark the active+visible channel read on the fly, or bump the
    // unread counter for background channels.
    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }

        const socket = socketRef.current;

        const unsubscribe = socket.onMessage((incoming) => {
            const known = lastMessageIdByChannel.current[incoming.channel_id] ?? 0;
            if (incoming.id > known) {
                lastMessageIdByChannel.current[incoming.channel_id] = incoming.id;
            }

            if (incoming.author_id === currentUserId) {
                return;
            }

            const isActive = incoming.channel_id === selectedChannelIdRef.current;
            if (isActive && isPageVisibleRef.current) {
                markChannelRead(incoming.channel_id, incoming.id, false);
                return;
            }

            setUnreadByChannel((prev) => ({
                ...prev,
                [incoming.channel_id]: (prev[incoming.channel_id] ?? 0) + 1,
            }));
        });

        return () => unsubscribe();
    }, [isConnected, socketRef, currentUserId, markChannelRead]);

    // Resync with the server on every (re)connect — the only moment counters
    // can genuinely drift is a dropped socket that missed `message` events.
    useEffect(() => {
        if (isConnected) {
            void refreshUnread();
        }
    }, [isConnected, refreshUnread]);

    const activeChannelMessageCount = selectedChannelId > 0 ? messagesByChannel[selectedChannelId]?.length ?? 0 : 0;

    // Mark the currently open channel read, but only while the tab is visible.
    useEffect(() => {
        if (selectedChannelId <= 0 || !isPageVisible) {
            return;
        }

        const list = messagesByChannel[selectedChannelId];
        const loadedLast = list && list.length > 0 ? list[list.length - 1].id : 0;
        const known = lastMessageIdByChannel.current[selectedChannelId] ?? 0;
        const messageId = Math.max(known, loadedLast);

        if (messageId > 0) {
            lastMessageIdByChannel.current[selectedChannelId] = messageId;
            markChannelRead(selectedChannelId, messageId, false);
        } else {
            setUnreadByChannel((prev) => (prev[selectedChannelId] ? { ...prev, [selectedChannelId]: 0 } : prev));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedChannelId, isPageVisible, activeChannelMessageCount, markChannelRead]);

    // Flush on channel switch (leaving a channel with a throttled send pending).
    useEffect(() => {
        return () => {
            if (selectedChannelId > 0) {
                flushChannel(selectedChannelId);
            }
        };
    }, [selectedChannelId, flushChannel]);

    // Flush on tab hide / page unload so a pending throttled send isn't lost.
    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                flushAll();
            }
        };
        const onBeforeUnload = () => flushAll();

        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            document.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("beforeunload", onBeforeUnload);
        };
    }, [flushAll]);

    const unreadByServer = useMemo(() => {
        const serverIdByChannel: Record<number, number> = { ...serverIdByChannelRef.current };
        Object.entries(channelsByServer).forEach(([serverId, list]) => {
            list.forEach((ch) => {
                serverIdByChannel[ch.id] = Number(serverId);
            });
        });

        const acc: UnreadByServer = {};
        Object.entries(unreadByChannel).forEach(([channelId, count]) => {
            if (count <= 0) return;
            const serverId = serverIdByChannel[Number(channelId)];
            if (!serverId) return;
            acc[serverId] = (acc[serverId] ?? 0) + count;
        });
        return acc;
    }, [unreadByChannel, channelsByServer]);

    return {
        unreadByChannel,
        unreadByServer,
        refreshUnread,
    };
}
