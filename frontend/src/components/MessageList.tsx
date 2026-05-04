import type { Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
    onOpenProfile?: (userId: number) => void;
};

function getAuthorLabel(msg: Message): string {
    const firstName = msg.author_first_name?.trim() ?? "";
    const lastName = msg.author_last_name?.trim() ?? "";
    const fullName = `${firstName} ${lastName}`.trim();

    return fullName || `User #${msg.author_id}`;
}

function getAuthorInitials(msg: Message): string {
    const first = msg.author_first_name?.trim()?.[0] ?? "";
    const last = msg.author_last_name?.trim()?.[0] ?? "";
    const initials = `${first}${last}`.toUpperCase();

    if (initials) {
        return initials;
    }

    return `U${msg.author_id}`;
}

function formatMessageTimestamp(isoDate: string): string {
    const date = new Date(isoDate);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const now = new Date();
    const isSameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

    const time = new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);

    if (isSameDay) {
        return time;
    }

    const dayAndMonth = new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "short",
    }).format(date);

    return `${dayAndMonth}, ${time}`;
}

export default function MessageList({ messages, currentUserId, onOpenProfile }: Props) {
    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => {
                const isOwn = currentUserId !== null && msg.author_id === currentUserId;

                return (
                    <div key={msg.id} className={`message-row ${isOwn ? "own" : "other"}`}>
                        <button
                            className="message-avatar-wrap"
                            type="button"
                            aria-label={`Open profile for ${getAuthorLabel(msg)}`}
                            onClick={() => onOpenProfile?.(msg.author_id)}
                        >
                            {msg.author_avatar_url ? (
                                <img
                                    className="message-avatar"
                                    src={msg.author_avatar_url}
                                    alt=""
                                    loading="lazy"
                                    onError={(event) => {
                                        event.currentTarget.style.display = "none";
                                        event.currentTarget.nextElementSibling?.classList.add("show");
                                    }}
                                />
                            ) : null}
                            <div className={`message-avatar-fallback ${msg.author_avatar_url ? "" : "show"}`}>
                                {getAuthorInitials(msg)}
                            </div>
                        </button>

                        <div className={`message-item ${isOwn ? "own" : "other"}`}>
                            <div className="message-meta">
                                <button
                                    className="message-author"
                                    type="button"
                                    onClick={() => onOpenProfile?.(msg.author_id)}
                                >
                                    {getAuthorLabel(msg)}
                                </button>
                            </div>
                            <div className="message-content">{msg.content}</div>
                            <div className="message-timestamp">{formatMessageTimestamp(msg.created_at)}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
