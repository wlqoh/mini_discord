import type { Attachment, Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
    onOpenProfile?: (userId: number) => void;
};

function getAuthorLabel(msg: Message): string {
    const nickname = msg.author_nickname?.trim() ?? "";
    if (nickname) {
        return nickname;
    }

    const firstName = msg.author_first_name?.trim() ?? "";
    const lastName = msg.author_last_name?.trim() ?? "";
    const fullName = `${firstName} ${lastName}`.trim();

    return fullName || `User #${msg.author_id}`;
}

function getAuthorInitials(msg: Message): string {
    const nickname = msg.author_nickname?.trim() ?? "";
    if (nickname) {
        const initials = nickname
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part[0] ?? "")
            .join("")
            .slice(0, 2)
            .toUpperCase();
        return initials || nickname[0]?.toUpperCase() || "U";
    }

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

function isImageType(contentType: string): boolean {
    return contentType.startsWith("image/");
}

function isVideoType(contentType: string): boolean {
    return contentType.startsWith("video/");
}

function isAudioType(contentType: string): boolean {
    return contentType.startsWith("audio/");
}

function formatFileSize(bytes?: number): string {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachment(att: Attachment) {
    if (isImageType(att.content_type)) {
        return (
            <a key={att.url} href={att.url} target="_blank" rel="noopener noreferrer" className="message-attachment image-attachment">
                <img src={att.url} alt={att.file_name} className="message-attachment-img" loading="lazy" />
            </a>
        );
    }

    if (isVideoType(att.content_type)) {
        return (
            <video key={att.url} src={att.url} controls className="message-attachment video-attachment">
                <track kind="captions" />
            </video>
        );
    }

    if (isAudioType(att.content_type)) {
        return (
            <audio key={att.url} src={att.url} controls className="message-attachment audio-attachment">
                <track kind="captions" />
            </audio>
        );
    }

    return (
        <a key={att.url} href={att.url} download={att.file_name} className="message-attachment file-attachment">
            <span className="file-attachment-icon">📎</span>
            <span className="file-attachment-info">
                <span className="file-attachment-name">{att.file_name}</span>
                {att.size_bytes ? (
                    <span className="file-attachment-size">{formatFileSize(att.size_bytes)}</span>
                ) : null}
            </span>
        </a>
    );
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
                            {msg.content && <div className="message-content">{msg.content}</div>}
                            {msg.attachments && msg.attachments.length > 0 && (
                                <div className="message-attachments">
                                    {msg.attachments.map(renderAttachment)}
                                </div>
                            )}
                            <div className="message-timestamp">{formatMessageTimestamp(msg.created_at)}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}