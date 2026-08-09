import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket";
import { TYPING_INACTIVITY_MS, TYPING_THROTTLE_MS } from "../services/typing";

export function useTypingEmitter(
    socketRef: React.MutableRefObject<ChatSocket | null>,
    channelId: number,
) {
    const lastSentRef = useRef(0);
    const inactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeRef = useRef(false);

    const stop = useCallback(() => {
        if (inactivityRef.current) {
            clearTimeout(inactivityRef.current);
            inactivityRef.current = null;
        }
        if (!activeRef.current) return;
        activeRef.current = false;
        lastSentRef.current = 0;
        if (channelId > 0) {
            socketRef.current?.sendTyping(channelId, false);
        }
    }, [socketRef, channelId]);

    const onInput = useCallback((value: string) => {
        if (channelId <= 0) return;
        if (value.trim().length === 0) {
            stop();
            return;
        }

        const now = Date.now();
        if (!activeRef.current || now - lastSentRef.current >= TYPING_THROTTLE_MS) {
            activeRef.current = true;
            lastSentRef.current = now;
            socketRef.current?.sendTyping(channelId, true);
        }

        if (inactivityRef.current) {
            clearTimeout(inactivityRef.current);
        }
        inactivityRef.current = setTimeout(stop, TYPING_INACTIVITY_MS);
    }, [socketRef, channelId, stop]);

    useEffect(() => () => stop(), [channelId, stop]);

    return { onInput, stop };
}
