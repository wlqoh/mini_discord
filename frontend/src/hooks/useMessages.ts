import { useEffect, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import type { ChannelsByServer, Message, MessagesByChannel, PaginationByChannel } from "../types/chat.ts";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    isConnected: boolean;
    selectedChannelId: number;
    selectedServerIdRef: React.MutableRefObject<number>;
    setError: (msg: string) => void;
    setChannelsByServer: React.Dispatch<React.SetStateAction<ChannelsByServer>>;
    messagesByChannel: MessagesByChannel;
    setMessagesByChannel: React.Dispatch<React.SetStateAction<MessagesByChannel>>;
};

export function useMessages({
    socketRef,
    isConnected,
    selectedChannelId,
    selectedServerIdRef,
    setError,
    setChannelsByServer,
    messagesByChannel,
    setMessagesByChannel,
}: Params) {
    const [loadedChannels, setLoadedChannels] = useState<Record<number, boolean>>({});
    const [paginationByChannel, setPaginationByChannel] = useState<PaginationByChannel>({});
    const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);

    // Subscribe to socket messages when connected
    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }

        const socket = socketRef.current;

        const unsubscribeMessage = socket.onMessage((incoming) => {
            setMessagesByChannel((prev) => ({
                ...prev,
                [incoming.channel_id]: [...(prev[incoming.channel_id] ?? []), incoming],
            }));

            // Keep UI in sync if server sends message from a channel not present in local cache.
            setChannelsByServer((prev) => {
                const hasChannel = Object.values(prev).some((list) => list.some((channel) => channel.id === incoming.channel_id));
                if (hasChannel || selectedServerIdRef.current <= 0) {
                    return prev;
                }

                const current = prev[selectedServerIdRef.current] ?? [];
                return {
                    ...prev,
                    [selectedServerIdRef.current]: [
                        ...current,
                        {
                            id: incoming.channel_id,
                            server_id: selectedServerIdRef.current,
                            name: String(incoming.channel_id),
                            type: "text" as const,
                        },
                    ],
                };
            });
        });

        return () => {
            unsubscribeMessage();
        };
    }, [isConnected, socketRef, selectedServerIdRef, setChannelsByServer, setMessagesByChannel]);

    // Load messages for selected channel (once, lazy load)
    useEffect(() => {
        if (selectedChannelId <= 0 || !socketRef.current || !isConnected || loadedChannels[selectedChannelId]) {
            return;
        }

        (async () => {
            try {
                const res = await socketRef.current?.getMessages(selectedChannelId, 100);
                setMessagesByChannel((prev) => ({
                    ...prev,
                    [selectedChannelId]: res?.messages ?? [],
                }));
                setPaginationByChannel((prev) => ({
                    ...prev,
                    [selectedChannelId]: {
                        cursor: res?.nextCursor ?? "",
                        hasMore: res?.hasMore ?? false,
                        isLoadingMore: false,
                        error: false,
                    },
                }));
                setLoadedChannels((prev) => ({ ...prev, [selectedChannelId]: true }));
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to load messages";
                setError(message);
            }
        })();
    }, [selectedChannelId, isConnected, loadedChannels, socketRef, setError, setMessagesByChannel]);

    async function loadOlderMessages(channelId: number): Promise<void> {
        const socket = socketRef.current;
        if (!socket || !isConnected || channelId <= 0) return;

        const state = paginationByChannel[channelId];
        if (!state || state.isLoadingMore || !state.hasMore) return;

        const cursor = state.cursor;
        if (!cursor) return;

        setPaginationByChannel((prev) => ({
            ...prev,
            [channelId]: { ...prev[channelId], isLoadingMore: true, error: false },
        }));

        try {
            const res = await socket.getMessages(channelId, 50, cursor);

            setMessagesByChannel((prev) => ({
                ...prev,
                [channelId]: [...res.messages, ...(prev[channelId] ?? [])],
            }));

            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: {
                    cursor: res.nextCursor,
                    hasMore: res.hasMore,
                    isLoadingMore: false,
                    error: false,
                },
            }));
        } catch {
            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: { ...prev[channelId], isLoadingMore: false, error: true },
            }));
        }
    }

    async function handleSend(text: string, attachmentIds?: number[], replyToId?: number | null) {
        if (!socketRef.current || !isConnected || selectedChannelId <= 0) {
            return;
        }

        try {
            setError("");
            await socketRef.current.sendMessage(selectedChannelId, text, attachmentIds, replyToId);
            setReplyToMessage(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to send message";
            setError(message);
        }
    }

    async function handleDeleteMessage(messageId: number, channelId: number): Promise<void> {
        if (!socketRef.current || !isConnected) {
            setError("No connection");
            return;
        }

        setMessagesByChannel((prev) => {
            const channelMessages = prev[channelId];
            if (!channelMessages) return prev;
            const next = channelMessages.filter((m) => m.id !== messageId);
            if (next.length === channelMessages.length) return prev;
            return { ...prev, [channelId]: next };
        });

        try {
            await socketRef.current.deleteMessage(messageId);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete message";
            setError(message);
            const socket = socketRef.current;
            if (socket) {
                try {
                    const res = await socket.getMessages(channelId);
                    setMessagesByChannel((prev) => ({
                        ...prev,
                        [channelId]: res.messages,
                    }));
                } catch {
                    // best-effort rollback
                }
            }
        }
    }

    return {
        messagesByChannel,
        loadedChannels,
        paginationByChannel,
        loadOlderMessages,
        replyToMessage,
        setReplyToMessage,
        handleSend,
        handleDeleteMessage,
    };
}
