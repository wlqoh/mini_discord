import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ChatSocket } from "../services/chatSocket.ts";
import type { SearchFilters, SearchHit, SearchScope } from "../types/chat.ts";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    isConnected: boolean;
    channelId: number;
    serverId: number;
};

const MIN_QUERY_LENGTH = 2;

/**
 * Search runs on Enter/button, not as-you-type: websearch_to_tsquery matches
 * whole lexemes, so a query fired on every keystroke would mostly return
 * nothing until a word is finished — see message-search-plan.md decision 10.
 */
export function useMessageSearch({ socketRef, isConnected, channelId, serverId }: Params) {
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<SearchScope>("channel");
    const [filters, setFilters] = useState<SearchFilters>({});
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [cursor, setCursor] = useState("");
    const [hasMore, setHasMore] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [error, setError] = useState("");
    const [hasSearched, setHasSearched] = useState(false);

    // Bumped on every submit/loadMore; a response is applied only if it's
    // still current when it arrives. Needed on top of chatSocket's own
    // request_id guard (which stops a stale response from resolving the
    // wrong in-flight command): if that response instead times out and
    // *rejects* ~10s late, this is what stops the resulting error from
    // clobbering a newer, already-displayed result set.
    const requestSeqRef = useRef(0);

    const scopeId = scope === "server" ? serverId : channelId;

    // A channel-scoped result set from the channel just left would be
    // misleading if the user reopens search after switching — clear it, but
    // only for channel scope: a server-wide result set stays valid across a
    // channel switch within the same server.
    useEffect(() => {
        if (scope !== "channel") return;
        setHits([]);
        setCursor("");
        setHasMore(false);
        setHasSearched(false);
        setError("");
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally scoped to channelId changes only
    }, [channelId]);

    async function submit(): Promise<void> {
        const trimmed = query.trim();
        if (trimmed.length < MIN_QUERY_LENGTH || !socketRef.current || !isConnected || scopeId <= 0) {
            return;
        }

        const seq = ++requestSeqRef.current;
        setIsLoading(true);
        setError("");

        try {
            const res = await socketRef.current.searchMessages(trimmed, scope, scopeId, filters);
            if (seq !== requestSeqRef.current) return;
            setHits(res.hits);
            setCursor(res.nextCursor);
            setHasMore(res.hasMore);
            setHasSearched(true);
        } catch (err) {
            if (seq !== requestSeqRef.current) return;
            setError(err instanceof Error ? err.message : "Search failed");
        } finally {
            if (seq === requestSeqRef.current) setIsLoading(false);
        }
    }

    async function loadMore(): Promise<void> {
        const trimmed = query.trim();
        if (trimmed.length < MIN_QUERY_LENGTH || !socketRef.current || !isConnected || scopeId <= 0) {
            return;
        }
        if (isLoadingMore || !hasMore || !cursor) return;

        const seq = requestSeqRef.current;
        setIsLoadingMore(true);

        try {
            const res = await socketRef.current.searchMessages(trimmed, scope, scopeId, filters, cursor);
            if (seq !== requestSeqRef.current) return;
            setHits((prev) => [...prev, ...res.hits]);
            setCursor(res.nextCursor);
            setHasMore(res.hasMore);
        } catch (err) {
            if (seq !== requestSeqRef.current) return;
            setError(err instanceof Error ? err.message : "Search failed");
        } finally {
            if (seq === requestSeqRef.current) setIsLoadingMore(false);
        }
    }

    return {
        query,
        setQuery,
        scope,
        setScope,
        filters,
        setFilters,
        hits,
        hasMore,
        isLoading,
        isLoadingMore,
        hasSearched,
        error,
        submit,
        loadMore,
    };
}
