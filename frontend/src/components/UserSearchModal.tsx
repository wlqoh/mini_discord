import { useEffect, useRef, useState } from "react";
import type { UserSearchHit } from "../types/chat";

type Props = {
    onClose: () => void;
    searchUsers: (query: string, limit?: number) => Promise<UserSearchHit[]>;
    onSelectUser: (user: UserSearchHit) => void;
};

const SEARCH_DEBOUNCE_MS = 250;

// A hook (not inline effect logic in the component) so the debounced-fetch
// setState calls are the "sync external state into a hook" pattern rather
// than a component driving its own derived state through an effect.
function useUserSearchResults(query: string, searchUsers: Props["searchUsers"]) {
    const [results, setResults] = useState<UserSearchHit[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState("");
    const requestIdRef = useRef(0);
    const trimmedQuery = query.trim();

    useEffect(() => {
        if (!trimmedQuery) {
            return;
        }

        const requestId = ++requestIdRef.current;
        // Same debounce-then-fetch shape as useServers.ts's join-search
        // effect (setting the loading flag before the timeout fires); the
        // rule doesn't flag that one, apparently bailing out on its extra
        // early-return branches, but does flag this simpler one.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsSearching(true);
        const timeoutId = window.setTimeout(() => {
            searchUsers(trimmedQuery, 20)
                .then((hits) => {
                    if (requestId !== requestIdRef.current) return;
                    setResults(hits);
                    setError("");
                })
                .catch((err: unknown) => {
                    if (requestId !== requestIdRef.current) return;
                    setResults([]);
                    setError(err instanceof Error ? err.message : "Failed to search users");
                })
                .finally(() => {
                    if (requestId === requestIdRef.current) {
                        setIsSearching(false);
                    }
                });
        }, SEARCH_DEBOUNCE_MS);

        return () => window.clearTimeout(timeoutId);
    }, [trimmedQuery, searchUsers]);

    return {
        trimmedQuery,
        results: trimmedQuery ? results : [],
        error: trimmedQuery ? error : "",
        isSearching: trimmedQuery ? isSearching : false,
    };
}

export default function UserSearchModal({ onClose, searchUsers, onSelectUser }: Props) {
    const [query, setQuery] = useState("");
    const {
        trimmedQuery,
        results: displayResults,
        error: displayError,
        isSearching: displayIsSearching,
    } = useUserSearchResults(query, searchUsers);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <h3 className="modal-title">New message</h3>

                <input
                    className="modal-input"
                    type="text"
                    placeholder="Search by nickname"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    maxLength={64}
                    autoFocus
                />

                {displayError ? <div className="messages-empty">{displayError}</div> : null}

                {!displayError && displayIsSearching ? <div className="messages-empty">Searching...</div> : null}

                {!displayError && !displayIsSearching && trimmedQuery.length > 0 && displayResults.length === 0 ? (
                    <div className="messages-empty">No users found</div>
                ) : null}

                {!displayIsSearching && displayResults.length > 0 ? (
                    <ul className="channels-list">
                        {displayResults.map((user) => (
                            <li key={user.user_id}>
                                <button className="channel-row dm-row" onClick={() => onSelectUser(user)} type="button">
                                    <span className="dm-avatar-wrap">
                                        {user.avatar_url ? (
                                            <img src={user.avatar_url} alt={user.nickname} className="dm-avatar-img" />
                                        ) : (
                                            <span className="dm-avatar-fallback">{user.nickname?.[0]?.toUpperCase() ?? "?"}</span>
                                        )}
                                    </span>
                                    <span className="channel-row-name">{user.nickname}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}

                <div className="modal-actions">
                    <button className="modal-btn modal-btn-secondary" onClick={onClose} type="button">
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
