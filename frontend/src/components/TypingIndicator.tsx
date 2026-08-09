import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket";
import type { Message, OnlineUser } from "../types/chat";

type Props = {
    userIds: number[];
    onlineUsers: OnlineUser[];
    messages: Message[];
    socketRef: React.MutableRefObject<ChatSocket | null>;
};

function resolveNameFromOnline(userId: number, onlineUsers: OnlineUser[]): string | null {
    const user = onlineUsers.find((u) => u.user_id === userId);
    if (!user) return null;
    const nickname = user.nickname?.trim();
    if (nickname) return nickname;
    const firstName = user.first_name?.trim();
    return firstName || null;
}

function resolveNameFromMessages(userId: number, messages: Message[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.author_id === userId) {
            const nickname = message.author_nickname?.trim();
            if (nickname) return nickname;
            const firstName = message.author_first_name?.trim();
            return firstName || null;
        }
    }
    return null;
}

function formatTyping(names: string[]): string {
    switch (names.length) {
        case 1:
            return `${names[0]} печатает…`;
        case 2:
            return `${names[0]} и ${names[1]} печатают…`;
        case 3:
            return `${names[0]}, ${names[1]} и ещё 1 печатают…`;
        default:
            return "Несколько человек печатают…";
    }
}

export default function TypingIndicator({ userIds, onlineUsers, messages, socketRef }: Props) {
    const [resolvedNames, setResolvedNames] = useState<Record<number, string>>({});
    const requestedRef = useRef<Set<number>>(new Set());

    useEffect(() => {
        userIds.forEach((userId) => {
            if (resolvedNames[userId]) return;

            const fromOnline = resolveNameFromOnline(userId, onlineUsers);
            if (fromOnline) {
                setResolvedNames((prev) => (prev[userId] ? prev : { ...prev, [userId]: fromOnline }));
                return;
            }

            const fromMessages = resolveNameFromMessages(userId, messages);
            if (fromMessages) {
                setResolvedNames((prev) => (prev[userId] ? prev : { ...prev, [userId]: fromMessages }));
                return;
            }

            if (requestedRef.current.has(userId)) return;
            requestedRef.current.add(userId);

            socketRef.current
                ?.getUserInfo(userId)
                .then((profile) => {
                    const name = profile.nickname?.trim() || profile.first_name?.trim();
                    if (name) {
                        setResolvedNames((prev) => (prev[userId] ? prev : { ...prev, [userId]: name }));
                    }
                })
                .catch(() => {});
        });
    }, [userIds, onlineUsers, messages, resolvedNames, socketRef]);

    if (userIds.length === 0) {
        return <div className="typing-indicator" aria-hidden="true" />;
    }

    const names = userIds.map((id) => resolvedNames[id]).filter((name): name is string => Boolean(name));
    const allResolved = names.length === userIds.length;

    let label: string;
    if (userIds.length >= 4) {
        label = "Несколько человек печатают…";
    } else if (!allResolved) {
        label = userIds.length === 1 ? "Печатает…" : "Печатают…";
    } else {
        label = formatTyping(names);
    }

    return (
        <div className="typing-indicator">
            <span className="typing-indicator-text">{label}</span>
            <span className="typing-indicator-dots" aria-hidden="true">
                <span />
                <span />
                <span />
            </span>
        </div>
    );
}
