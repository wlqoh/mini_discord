import type React from "react";
import type { DMChannel } from "../types/chat";
import { formatMessageTimestamp } from "../services/formatTimestamp";

type Props = {
    channels: DMChannel[];
    selectedChannelId: number;
    onSelect: (channelId: number) => void;
    onContextMenu: (e: React.MouseEvent, channel: DMChannel) => void;
    // Best-effort presence: populated from whatever get_users_online result
    // the app already has for the currently/previously selected server
    // (decision #10 — DMs have no server of their own to scope a dedicated
    // presence query to). A peer missing from this set simply gets no dot,
    // rather than an incorrectly confident "offline" one.
    onlineUserIds?: Set<number>;
    unreadByChannel?: Record<number, number>;
    isLoading?: boolean;
};

function formatUnreadCount(count: number): string {
    return count > 99 ? "99+" : String(count);
}

export default function DMList({ channels, selectedChannelId, onSelect, onContextMenu, onlineUserIds, unreadByChannel, isLoading }: Props) {
    if (isLoading && channels.length === 0) {
        return (
            <ul className="channels-list dm-list">
                <li className="dm-list-empty">Loading…</li>
            </ul>
        );
    }

    if (channels.length === 0) {
        return (
            <ul className="channels-list dm-list">
                <li className="dm-list-empty">No conversations yet</li>
            </ul>
        );
    }

    return (
        <ul className="channels-list dm-list">
            {channels.map((dm) => {
                const isOnline = onlineUserIds?.has(dm.peer_user_id) ?? false;
                const initial = dm.peer_nickname?.[0]?.toUpperCase() ?? "?";
                const unreadCount = unreadByChannel?.[dm.channel_id] ?? 0;
                return (
                    <li key={dm.channel_id} className="channel-item dm-item">
                        <button
                            className={`channel-row dm-row ${selectedChannelId === dm.channel_id ? "active" : ""} ${unreadCount > 0 ? "has-unread" : ""}`}
                            onClick={() => onSelect(dm.channel_id)}
                            onContextMenu={(e) => onContextMenu(e, dm)}
                            type="button"
                        >
                            <span className="dm-avatar-wrap">
                                {dm.peer_avatar_url ? (
                                    <img src={dm.peer_avatar_url} alt={dm.peer_nickname} className="dm-avatar-img" />
                                ) : (
                                    <span className="dm-avatar-fallback">{initial}</span>
                                )}
                                {isOnline ? <span className="dm-online-dot" title="Online" /> : null}
                            </span>
                            <span className="dm-row-meta">
                                <span className="channel-row-name dm-row-name">{dm.peer_nickname}</span>
                                {dm.last_message_at ? (
                                    <span className="dm-row-time">{formatMessageTimestamp(dm.last_message_at)}</span>
                                ) : null}
                            </span>
                            {unreadCount > 0 ? (
                                <span className="channel-unread-badge" title={`${unreadCount} unread`}>
                                    {formatUnreadCount(unreadCount)}
                                </span>
                            ) : null}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
