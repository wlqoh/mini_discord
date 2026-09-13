import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket";
import type { DMChannel } from "../types/chat";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    isConnected: boolean;
};

function sortDMChannels(channels: DMChannel[]): DMChannel[] {
    return [...channels].sort((a, b) => {
        const aTime = a.last_message_at ? Date.parse(a.last_message_at) : 0;
        const bTime = b.last_message_at ? Date.parse(b.last_message_at) : 0;
        return bTime - aTime;
    });
}

export function useDMs({ socketRef, isConnected }: Params) {
    const [dmChannels, setDMChannels] = useState<DMChannel[]>([]);
    const [isLoadingDMs, setIsLoadingDMs] = useState(false);

    const upsert = useCallback((dm: DMChannel) => {
        setDMChannels((prev) => {
            const next = prev.some((c) => c.channel_id === dm.channel_id)
                ? prev.map((c) => (c.channel_id === dm.channel_id ? dm : c))
                : [...prev, dm];
            return sortDMChannels(next);
        });
    }, []);

    const refresh = useCallback(async () => {
        const socket = socketRef.current;
        if (!socket) {
            return;
        }

        try {
            setIsLoadingDMs(true);
            const channels = await socket.listDMs();
            setDMChannels(sortDMChannels(channels));
        } catch {
            // best-effort; the next reconnect (or the caller's own retry)
            // will refresh again — same convention as useUnread.refreshUnread.
        } finally {
            setIsLoadingDMs(false);
        }
    }, [socketRef]);

    const openDM = useCallback(async (peerUserId: number): Promise<DMChannel> => {
        const socket = socketRef.current;
        if (!socket) {
            throw new Error("No connection to chat");
        }
        const dm = await socket.openDM(peerUserId);
        upsert(dm);
        return dm;
    }, [socketRef, upsert]);

    const closeDM = useCallback(async (channelId: number): Promise<void> => {
        const socket = socketRef.current;
        if (!socket) {
            throw new Error("No connection to chat");
        }
        await socket.closeDM(channelId);
        setDMChannels((prev) => prev.filter((c) => c.channel_id !== channelId));
    }, [socketRef]);

    // dm_opened is both open_dm's own reply and a broadcast fired on every
    // message saved into a DM channel (see hub sendMessage/broadcastDMOpened
    // server-side), so subscribing here alone keeps last_message_at fresh and
    // reveals a brand-new or previously-closed conversation in real time,
    // with no separate listener needed on the generic `message` event.
    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }
        const socket = socketRef.current;
        const unsubscribe = socket.onDMOpened((dm) => {
            upsert(dm);
        });
        return () => unsubscribe();
    }, [isConnected, socketRef, upsert]);

    useEffect(() => {
        if (isConnected) {
            void refresh();
        } else {
            setDMChannels([]);
        }
    }, [isConnected, refresh]);

    return {
        dmChannels,
        isLoadingDMs,
        refresh,
        openDM,
        closeDM,
    };
}
