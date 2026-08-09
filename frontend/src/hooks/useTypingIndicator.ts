import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket";
import { TYPING_RECEIVER_TTL_MS } from "../services/typing";

export type TypingByChannel = Record<number, number[]>;

export function useTypingIndicator(
    socketRef: React.MutableRefObject<ChatSocket | null>,
    isConnected: boolean,
    currentUserId: number | null,
) {
    const [typingByChannel, setTypingByChannel] = useState<TypingByChannel>({});
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }

        const socket = socketRef.current;
        const timers = timersRef.current;

        const clearUser = (channelId: number, userId: number) => {
            setTypingByChannel((prev) => {
                const list = prev[channelId];
                if (!list || !list.includes(userId)) return prev;
                const next = list.filter((id) => id !== userId);
                const copy = { ...prev };
                if (next.length) {
                    copy[channelId] = next;
                } else {
                    delete copy[channelId];
                }
                return copy;
            });
        };

        const unsubscribe = socket.onTyping((event, isTyping) => {
            if (event.user_id === currentUserId) return;

            const key = `${event.channel_id}:${event.user_id}`;
            const existingTimer = timers.get(key);
            if (existingTimer) {
                clearTimeout(existingTimer);
                timers.delete(key);
            }

            if (!isTyping) {
                clearUser(event.channel_id, event.user_id);
                return;
            }

            setTypingByChannel((prev) => {
                const list = prev[event.channel_id] ?? [];
                if (list.includes(event.user_id)) return prev;
                return { ...prev, [event.channel_id]: [...list, event.user_id] };
            });

            const timer = setTimeout(() => {
                clearUser(event.channel_id, event.user_id);
                timers.delete(key);
            }, TYPING_RECEIVER_TTL_MS);
            timers.set(key, timer);
        });

        return () => {
            unsubscribe();
            timers.forEach((timer) => clearTimeout(timer));
            timers.clear();
        };
    }, [isConnected, socketRef, currentUserId]);

    return typingByChannel;
}
