import type { Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
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

export default function MessageList({ messages, currentUserId }: Props) {
    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => {
                const isOwn = currentUserId !== null && msg.author_id === currentUserId;

                return (
                    <div key={msg.id} className={`message-row ${isOwn ? "own" : "other"}`}>
                        <div className="message-avatar-wrap" aria-hidden="true">
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
                        </div>

                        <div className={`message-item ${isOwn ? "own" : "other"}`}>
                            <div className="message-meta">
                                <div className="message-author">{getAuthorLabel(msg)}</div>
                            </div>
                            <div className="message-content">{msg.content}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
