import { useState } from "react";
import { CornerDownLeft, CornerUpLeft, Paperclip } from "lucide-react";
import type { Attachment, Message, ReplyPreview } from "../types/chat.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
    onOpenProfile?: (userId: number) => void;
    onDeleteMessage?: (messageId: number, channelId: number) => void;
    onReply?: (message: Message) => void;
    onScrollToMessage?: (messageId: number) => void;
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
            <span className="file-attachment-icon"><Paperclip size={16} aria-hidden="true" /></span>
            <span className="file-attachment-info">
                <span className="file-attachment-name">{att.file_name}</span>
                {att.size_bytes ? (
                    <span className="file-attachment-size">{formatFileSize(att.size_bytes)}</span>
                ) : null}
            </span>
        </a>
    );
}

function truncateContent(text: string, maxLen = 60): string {
    const stripped = text.replace(/\n/g, " ").trim();
    if (stripped.length <= maxLen) return stripped;
    return stripped.slice(0, maxLen) + "...";
}

function ReplyPreviewBlock({ reply, onScrollToMessage }: { reply: ReplyPreview; onScrollToMessage?: (id: number) => void }) {
    const authorName = reply.author_nickname?.trim() || `${reply.author_first_name} ${reply.author_last_name}`.trim() || `User #${reply.author_id}`;
    return (
        <div
            className="reply-preview"
            role="button"
            tabIndex={0}
            onClick={() => onScrollToMessage?.(reply.message_id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onScrollToMessage?.(reply.message_id); } }}
        >
            <CornerUpLeft size={14} className="reply-preview-icon" />
            <span className="reply-preview-author">{authorName}</span>
            <span className="reply-preview-content">{truncateContent(reply.content)}</span>
            {reply.has_attachments && <span className="reply-preview-attachment-indicator"><Paperclip size={11} aria-hidden="true" /></span>}
        </div>
    );
}

export default function MessageList({ messages, currentUserId, onOpenProfile, onDeleteMessage, onReply, onScrollToMessage }: Props) {
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => {
                const isOwn = currentUserId !== null && msg.author_id === currentUserId;

                return (
                    <div key={msg.id} id={`message-${msg.id}`} className={`message-row ${isOwn ? "own" : "other"}`}>
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
                                {isOwn ? (
                                    confirmDeleteId === msg.id ? (
                                        <span className="message-delete-confirm">
                                            <button
                                                className="message-delete-btn confirm"
                                                type="button"
                                                onClick={() => {
                                                    onDeleteMessage?.(msg.id, msg.channel_id);
                                                    setConfirmDeleteId(null);
                                                }}
                                            >
                                                Delete
                                            </button>
                                            <button
                                                className="message-delete-btn cancel"
                                                type="button"
                                                onClick={() => setConfirmDeleteId(null)}
                                            >
                                                Cancel
                                            </button>
                                        </span>
                                    ) : (
                                        <span className="message-actions-inline">
                                            <button
                                                className="message-reply-btn"
                                                type="button"
                                                onClick={() => onReply?.(msg)}
                                                aria-label="Reply to message"
                                                title="Reply"
                                            >
                                                <CornerDownLeft size={14} />
                                            </button>
                                            <button
                                                className="message-delete-btn"
                                                type="button"
                                                onClick={() => setConfirmDeleteId(msg.id)}
                                                aria-label="Delete message"
                                                title="Delete message"
                                            >
                                                ✕
                                            </button>
                                        </span>
                                    )
                                ) : (
                                    <button
                                        className="message-reply-btn"
                                        type="button"
                                        onClick={() => onReply?.(msg)}
                                        aria-label="Reply to message"
                                        title="Reply"
                                    >
                                        <CornerDownLeft size={14} />
                                    </button>
                                )}
                            </div>
                            {msg.reply_to && (
                                <ReplyPreviewBlock reply={msg.reply_to} onScrollToMessage={onScrollToMessage} />
                            )}
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