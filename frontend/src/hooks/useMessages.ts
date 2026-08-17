import { useEffect, useRef, useState } from "react";
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

    // Latest paginationByChannel, readable from the message-subscription
    // effect below without listing it as a dependency — that effect must only
    // resubscribe when isConnected changes, not on every pagination update.
    const paginationRef = useRef<PaginationByChannel>(paginationByChannel);
    useEffect(() => {
        paginationRef.current = paginationByChannel;
    }, [paginationByChannel]);

    // Subscribe to socket messages when connected
    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }

        const socket = socketRef.current;

        const unsubscribeMessage = socket.onMessage((incoming) => {
            if (paginationRef.current[incoming.channel_id]?.hasMoreNewer) {
                // The channel is showing a windowed view opened by jumpToMessage,
                // not the live tail: an unloaded gap separates the window's last
                // message from the real tail, so appending here would splice a
                // new message onto the wrong side of an invisible gap. Unread
                // counters (useUnread) are tracked independently and unaffected.
                return;
            }

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

        // Превью приезжает отдельным событием через 0.3–2 сек после сообщения:
        // хаб не может ждать внешний сайт, поэтому карточка догоняет сообщение.
        const unsubscribeEmbeds = socket.onMessageEmbeds((event) => {
            setMessagesByChannel((prev) => {
                const channelMessages = prev[event.channel_id];
                if (!channelMessages) return prev;

                const index = channelMessages.findIndex((message) => message.id === event.message_id);
                // Сообщения нет в кэше (канал не открывали) — событие просто игнорируем:
                // при загрузке канала превью придёт вместе с историей.
                if (index === -1) return prev;

                const next = channelMessages.slice();
                next[index] = { ...next[index], embeds: event.embeds };
                return { ...prev, [event.channel_id]: next };
            });
        });

        // Правка приходит патчем, а не целым сообщением: меняются только текст
        // и edited_at. Guard по hasMoreNewer, который стоит на onMessage, здесь
        // намеренно отсутствует — мы ничего не добавляем в список, а правим уже
        // загруженные элементы, и это безопасно в любом режиме пагинации.
        const unsubscribeEdited = socket.onMessageEdited((event) => {
            setMessagesByChannel((prev) => {
                const channelMessages = prev[event.channel_id];
                // Канал не открывали — правка приедет вместе с историей.
                if (!channelMessages) return prev;

                let changed = false;
                const next = channelMessages.map((message) => {
                    if (message.id === event.message_id) {
                        changed = true;
                        return { ...message, content: event.content, edited_at: event.edited_at };
                    }
                    // Плашка ответа — снимок текста, вшитый в отвечающее
                    // сообщение при загрузке. Сервер её не пересчитывает и в
                    // событии не присылает, поэтому чиним локально: иначе на
                    // экране одновременно видны старая цитата и новый оригинал.
                    if (message.reply_to?.message_id === event.message_id) {
                        changed = true;
                        return { ...message, reply_to: { ...message.reply_to, content: event.content } };
                    }
                    return message;
                });

                return changed ? { ...prev, [event.channel_id]: next } : prev;
            });
        });

        return () => {
            unsubscribeMessage();
            unsubscribeEmbeds();
            unsubscribeEdited();
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

    // A channel left mid-window (hasMoreNewer, via jumpToMessage) should not
    // still be mid-window when the user comes back to it — every other
    // channel always shows its live tail, so this one should too. Reads
    // paginationRef instead of paginationByChannel so the effect only fires
    // on an actual channel switch, not on every pagination update (loading
    // older/newer history on the *current* channel must not retrigger this).
    useEffect(() => {
        if (selectedChannelId <= 0) return;
        if (paginationRef.current[selectedChannelId]?.hasMoreNewer) {
            void resetToLiveTail(selectedChannelId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedChannelId]);

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
                    ...prev[channelId],
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

    /**
     * Opens a window of history centered on messageId if it isn't already
     * loaded — used to jump to a search hit, a reply preview, or a push
     * notification target regardless of how far back it is. Returns false
     * (and surfaces an error) if the message no longer exists.
     */
    async function jumpToMessage(channelId: number, messageId: number): Promise<boolean> {
        const socket = socketRef.current;
        if (!socket || !isConnected || channelId <= 0 || messageId <= 0) return false;

        if (messagesByChannel[channelId]?.some((m) => m.id === messageId)) {
            return true;
        }

        // Set synchronously (before the network round-trip) so the plain
        // lazy-load effect above never fires for this channel and clobbers
        // the window this call is about to install — React batches this with
        // any selectChannel() the caller just did, so by the time that
        // effect's guard is checked, loadedChannels already reflects this.
        setLoadedChannels((prev) => ({ ...prev, [channelId]: true }));

        try {
            const res = await socket.getMessagesAround(channelId, messageId, 25);

            setMessagesByChannel((prev) => ({
                ...prev,
                [channelId]: res.messages,
            }));
            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: {
                    cursor: res.olderCursor,
                    hasMore: res.hasMoreOlder,
                    isLoadingMore: false,
                    error: false,
                    newerCursor: res.newerCursor,
                    hasMoreNewer: res.hasMoreNewer,
                    isLoadingNewer: false,
                },
            }));
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Message not found";
            setError(message);
            return false;
        }
    }

    async function loadNewerMessages(channelId: number): Promise<void> {
        const socket = socketRef.current;
        if (!socket || !isConnected || channelId <= 0) return;

        const state = paginationByChannel[channelId];
        if (!state || state.isLoadingNewer || !state.hasMoreNewer || !state.newerCursor) return;

        const cursor = state.newerCursor;

        setPaginationByChannel((prev) => ({
            ...prev,
            [channelId]: { ...prev[channelId], isLoadingNewer: true },
        }));

        try {
            const res = await socket.getMessagesAfter(channelId, cursor, 50);

            setMessagesByChannel((prev) => ({
                ...prev,
                [channelId]: [...(prev[channelId] ?? []), ...res.messages],
            }));

            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: {
                    ...prev[channelId],
                    newerCursor: res.nextCursor,
                    hasMoreNewer: res.hasMore,
                    isLoadingNewer: false,
                },
            }));
        } catch {
            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: { ...prev[channelId], isLoadingNewer: false },
            }));
        }
    }

    /** Drops a windowed view and reloads the channel's live tail — used when
     * the user asks to jump to the latest messages, or when they navigate
     * back to a channel they last left mid-window. */
    async function resetToLiveTail(channelId: number): Promise<void> {
        const socket = socketRef.current;
        if (!socket || !isConnected || channelId <= 0) return;

        try {
            const res = await socket.getMessages(channelId, 100);
            setMessagesByChannel((prev) => ({ ...prev, [channelId]: res.messages }));
            setPaginationByChannel((prev) => ({
                ...prev,
                [channelId]: {
                    cursor: res.nextCursor,
                    hasMore: res.hasMore,
                    isLoadingMore: false,
                    error: false,
                    newerCursor: undefined,
                    hasMoreNewer: false,
                    isLoadingNewer: false,
                },
            }));
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load messages";
            setError(message);
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

    /**
     * Отправляет правку и ждёт ack. Локальный кэш здесь намеренно не трогается:
     * единственная точка обновления — обработчик message_edited выше, который
     * одинаково применяет и свою правку, и чужую. Ошибку пробрасываем наверх —
     * её показывает сам редактор рядом с полем ввода, не глобальный баннер.
     */
    async function handleEditMessage(messageId: number, content: string): Promise<void> {
        const socket = socketRef.current;
        if (!socket || !isConnected) {
            throw new Error("Нет соединения");
        }
        await socket.editMessage(messageId, content);
    }

    return {
        messagesByChannel,
        loadedChannels,
        paginationByChannel,
        loadOlderMessages,
        loadNewerMessages,
        jumpToMessage,
        resetToLiveTail,
        replyToMessage,
        setReplyToMessage,
        handleSend,
        handleDeleteMessage,
        handleEditMessage,
    };
}
