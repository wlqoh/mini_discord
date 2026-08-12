import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import type { ServerMember } from "../types/chat.ts";

type MembersByServer = Record<number, ServerMember[]>;

/** Caches server membership (with user_id) for @-mention autocomplete and name resolution. */
export function useServerMembers(socketRef: React.MutableRefObject<ChatSocket | null>, isConnected: boolean, serverId: number) {
    const [membersByServer, setMembersByServer] = useState<MembersByServer>({});
    const loadingRef = useRef<Set<number>>(new Set());

    const ensureLoaded = useCallback(
        (targetServerId: number) => {
            if (targetServerId <= 0 || !socketRef.current || !isConnected) return;
            if (membersByServer[targetServerId] || loadingRef.current.has(targetServerId)) return;

            loadingRef.current.add(targetServerId);
            socketRef.current
                .getServerMembers(targetServerId)
                .then((members) => {
                    setMembersByServer((prev) => ({ ...prev, [targetServerId]: members }));
                })
                .catch(() => {})
                .finally(() => {
                    loadingRef.current.delete(targetServerId);
                });
        },
        [socketRef, isConnected, membersByServer],
    );

    useEffect(() => {
        ensureLoaded(serverId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureLoaded already depends on serverId's cache state
    }, [serverId, isConnected]);

    return {
        membersByServer,
        members: membersByServer[serverId] ?? [],
        ensureLoaded,
    };
}
