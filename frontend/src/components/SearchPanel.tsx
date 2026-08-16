import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Search as SearchIcon, X } from "lucide-react";
import type { SearchFilters, SearchHit, SearchScope, ServerMember } from "../types/chat.ts";
import { memberDisplayName } from "../services/mentions.ts";
import { renderHeadline } from "../services/searchHighlight.tsx";
import { formatMessageTimestamp } from "../services/formatTimestamp.ts";

type Props = {
    isOpen: boolean;
    onClose: () => void;
    query: string;
    onQueryChange: (value: string) => void;
    scope: SearchScope;
    onScopeChange: (scope: SearchScope) => void;
    filters: SearchFilters;
    onFiltersChange: (filters: SearchFilters) => void;
    hits: SearchHit[];
    hasMore: boolean;
    isLoading: boolean;
    isLoadingMore: boolean;
    hasSearched: boolean;
    error: string;
    onSubmit: () => void;
    onLoadMore: () => void;
    serverMembers: ServerMember[];
    onScrollToMessage: (messageId: number, channelId?: number) => void;
};

export default function SearchPanel({
    isOpen,
    onClose,
    query,
    onQueryChange,
    scope,
    onScopeChange,
    filters,
    onFiltersChange,
    hits,
    hasMore,
    isLoading,
    isLoadingMore,
    hasSearched,
    error,
    onSubmit,
    onLoadMore,
    serverMembers,
    onScrollToMessage,
}: Props) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const resultsRef = useRef<HTMLDivElement | null>(null);
    const [activeHitId, setActiveHitId] = useState<number | null>(null);

    useEffect(() => {
        if (isOpen) inputRef.current?.focus();
    }, [isOpen]);

    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || !hasMore || isLoadingMore) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) onLoadMore();
            },
            { root: resultsRef.current, rootMargin: "200px 0px 0px 0px", threshold: 0 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, hits.length]);

    if (!isOpen) return null;

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
        } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
        }
    }

    function handleHitClick(hit: SearchHit) {
        setActiveHitId(hit.message_id);
        onScrollToMessage(hit.message_id, hit.channel_id);
    }

    const trimmedLength = query.trim().length;
    const isQueryTooShort = trimmedLength > 0 && trimmedLength < 2;

    return (
        <aside className="search-panel">
            <div className="search-panel-header">
                <div className="search-panel-input-row">
                    <SearchIcon size={16} aria-hidden="true" className="search-panel-input-icon" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => onQueryChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Поиск по сообщениям…"
                        className="search-panel-input"
                        aria-label="Поиск по сообщениям"
                    />
                </div>
                <button type="button" className="search-panel-close-btn" onClick={onClose} aria-label="Закрыть поиск">
                    <X size={18} aria-hidden="true" />
                </button>
            </div>

            <div className="search-panel-scope" role="tablist" aria-label="Область поиска">
                <button
                    type="button"
                    role="tab"
                    aria-selected={scope === "channel"}
                    className={`search-scope-btn ${scope === "channel" ? "active" : ""}`}
                    onClick={() => onScopeChange("channel")}
                >
                    Канал
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={scope === "server"}
                    className={`search-scope-btn ${scope === "server" ? "active" : ""}`}
                    onClick={() => onScopeChange("server")}
                >
                    Сервер
                </button>
            </div>

            <div className="search-panel-filters">
                <select
                    value={filters.authorId ?? ""}
                    onChange={(e) =>
                        onFiltersChange({ ...filters, authorId: e.target.value ? Number(e.target.value) : undefined })
                    }
                    className="search-filter-select"
                    aria-label="Автор"
                >
                    <option value="">Любой автор</option>
                    {serverMembers.map((member) => (
                        <option key={member.user_id} value={member.user_id}>
                            {memberDisplayName(member)}
                        </option>
                    ))}
                </select>
                <label className="search-filter-checkbox">
                    <input
                        type="checkbox"
                        checked={filters.hasFile ?? false}
                        onChange={(e) => onFiltersChange({ ...filters, hasFile: e.target.checked || undefined })}
                    />
                    С файлом
                </label>
                <label className="search-filter-checkbox">
                    <input
                        type="checkbox"
                        checked={filters.hasLink ?? false}
                        onChange={(e) => onFiltersChange({ ...filters, hasLink: e.target.checked || undefined })}
                    />
                    Со ссылкой
                </label>
            </div>

            <div className="search-panel-results" ref={resultsRef}>
                {isQueryTooShort && <div className="search-panel-hint">Введите минимум 2 символа</div>}
                {error && <div className="search-panel-error">{error}</div>}
                {isLoading && (
                    <div className="history-loading">
                        <span className="history-spinner" /> Поиск…
                    </div>
                )}

                {!isLoading && hasSearched && hits.length === 0 && !error && (
                    <div className="search-panel-empty">Ничего не найдено</div>
                )}

                {hits.length > 0 && (
                    <ul className="search-hit-list">
                        {hits.map((hit) => {
                            const authorName =
                                hit.author_nickname?.trim() ||
                                `${hit.author_first_name ?? ""} ${hit.author_last_name ?? ""}`.trim() ||
                                `User #${hit.author_id}`;

                            return (
                                <li key={`${hit.channel_id}-${hit.message_id}`}>
                                    <button
                                        type="button"
                                        className={`search-hit ${activeHitId === hit.message_id ? "active" : ""}`}
                                        onClick={() => handleHitClick(hit)}
                                    >
                                        <div className="search-hit-meta">
                                            <span className="search-hit-author">{authorName}</span>
                                            {scope === "server" && (
                                                <span className="search-hit-channel"># {hit.channel_name}</span>
                                            )}
                                            <span className="search-hit-date">{formatMessageTimestamp(hit.created_at)}</span>
                                        </div>
                                        <div className="search-hit-headline">{renderHeadline(hit.headline)}</div>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {isLoadingMore && (
                    <div className="history-loading">
                        <span className="history-spinner" /> Загрузка…
                    </div>
                )}
                {hasMore && !isLoadingMore && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}
            </div>
        </aside>
    );
}
