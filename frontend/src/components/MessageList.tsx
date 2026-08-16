import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, CornerUpLeft, Paperclip } from "lucide-react";
import type { Attachment, Message, ReplyPreview, ServerMember } from "../types/chat.ts";
import MediaPlayer from "./MediaPlayer";
import VideoPlayer from "./VideoPlayer";
import LinkPreviewCard from "./LinkPreviewCard.tsx";
import { guessFormatFromContentType } from "../types/media";
import type { Track } from "../types/media";
import { memberDisplayName } from "../services/mentions.ts";
import { trimUrlTail } from "../services/links.ts";
import { formatMessageTimestamp } from "../services/formatTimestamp.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
    onOpenProfile?: (userId: number) => void;
    onDeleteMessage?: (messageId: number, channelId: number) => void;
    onReply?: (message: Message) => void;
    onScrollToMessage?: (messageId: number) => void;
    isLoading?: boolean;
    hasMoreOlder?: boolean;
    isLoadingOlder?: boolean;
    loadOlderError?: boolean;
    onLoadOlder?: () => void;
    // Present only while the channel is showing a windowed view (opened by
    // jumping to a search hit, reply, or notification target) rather than its
    // live tail — see the hasMoreNewer guard in useMessages.
    hasMoreNewer?: boolean;
    isLoadingNewer?: boolean;
    onLoadNewer?: () => void;
    serverMembers?: ServerMember[];
};

// Один проход по тексту на все виды токенов. `<@id>` начинается с угловой
// скобки, а URL-часть шаблона её исключает, поэтому ветки не конфликтуют.
const TOKEN_PATTERN = /<@(\d+)>|@everyone|https?:\/\/[^\s<>"']+/g;

function renderMessageContent(content: string, membersById: Map<number, ServerMember>) {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    TOKEN_PATTERN.lastIndex = 0;
    while ((match = TOKEN_PATTERN.exec(content)) !== null) {
        const token = match[0];

        if (match.index > lastIndex) {
            parts.push(<Fragment key={lastIndex}>{content.slice(lastIndex, match.index)}</Fragment>);
        }

        if (token === "@everyone") {
            parts.push(
                <span key={match.index} className="mention-chip mention-chip-everyone">
                    @everyone
                </span>,
            );
        } else if (token.startsWith("<@")) {
            const userId = Number(match[1]);
            const member = membersById.get(userId);
            const label = member ? memberDisplayName(member) : `user ${userId}`;
            parts.push(
                <span key={match.index} className="mention-chip">
                    @{label}
                </span>,
            );
        } else {
            // Шаблон гарантирует схему http/https, поэтому в href не может
            // попасть javascript:/data: — отдельная санитизация не нужна.
            const href = trimUrlTail(token);
            parts.push(
                <a
                    key={match.index}
                    className="message-link"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                >
                    {href}
                </a>,
            );
            // Сдвигаемся на длину ссылки, а не всего совпадения: отрезанные
            // знаки препинания должны вернуться в текст следующей итерацией.
            lastIndex = match.index + href.length;
            continue;
        }

        lastIndex = match.index + token.length;
    }

    if (lastIndex < content.length) {
        parts.push(<Fragment key={lastIndex}>{content.slice(lastIndex)}</Fragment>);
    }

    return parts;
}

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

function AudioAttachment({ att }: { att: Attachment }) {
    // Memoized so MediaPlayer/useMediaPlayer see a stable `tracks` array across
    // unrelated MessageList re-renders (new/deleted messages elsewhere), instead
    // of tearing down and re-subscribing their audio event listeners every time.
    const tracks = useMemo<Track[]>(() => [{
        id: att.id ?? att.url,
        title: att.file_name,
        duration: 0,
        url: att.url,
        format: guessFormatFromContentType(att.content_type),
    }], [att.id, att.url, att.file_name, att.content_type]);

    return (
        <div className="message-attachment audio-attachment">
            <MediaPlayer tracks={tracks} compact showPlaylist={false} />
        </div>
    );
}

function VideoAttachment({ att }: { att: Attachment }) {
    // Memoized for the same reason as AudioAttachment's tracks — keeps VideoPlayer's
    // underlying video element and its event listeners stable across unrelated
    // MessageList re-renders.
    const tracks = useMemo<Track[]>(() => [{
        id: att.id ?? att.url,
        title: att.file_name,
        duration: 0,
        url: att.url,
        format: guessFormatFromContentType(att.content_type),
    }], [att.id, att.url, att.file_name, att.content_type]);

    return (
        <div className="message-attachment video-attachment">
            <VideoPlayer tracks={tracks} />
        </div>
    );
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
        return <VideoAttachment key={att.url} att={att} />;
    }

    if (isAudioType(att.content_type)) {
        return <AudioAttachment key={att.url} att={att} />;
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

export default function MessageList({
    messages,
    currentUserId,
    onOpenProfile,
    onDeleteMessage,
    onReply,
    onScrollToMessage,
    isLoading,
    hasMoreOlder,
    isLoadingOlder,
    loadOlderError,
    onLoadOlder,
    hasMoreNewer,
    isLoadingNewer,
    onLoadNewer,
    serverMembers = [],
}: Props) {
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    const membersById = useMemo(() => new Map(serverMembers.map((member) => [member.user_id, member])), [serverMembers]);
    // Messages present at mount (or already seen) never re-animate as "new" —
    // this stays correct even when older history is prepended, since ids only grow.
    const [initialMaxId] = useState(() => messages.reduce((max, m) => Math.max(max, m.id), 0));
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const bottomSentinelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || !onLoadOlder) return;
        if (!hasMoreOlder || isLoadingOlder || loadOlderError) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    onLoadOlder();
                }
            },
            { root: node.closest(".chat-content"), rootMargin: "200px 0px 0px 0px", threshold: 0 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMoreOlder, isLoadingOlder, loadOlderError, onLoadOlder, messages.length]);

    // Mirrors the sentinel above but at the tail: only relevant while a
    // windowed view is open (hasMoreNewer), since a live-tail channel has
    // nothing further down to load.
    useEffect(() => {
        const node = bottomSentinelRef.current;
        if (!node || !onLoadNewer) return;
        if (!hasMoreNewer || isLoadingNewer) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    onLoadNewer();
                }
            },
            { root: node.closest(".chat-content"), rootMargin: "0px 0px 200px 0px", threshold: 0 },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMoreNewer, isLoadingNewer, onLoadNewer, messages.length]);

    if (isLoading) {
        return (
            <div className="skeleton-msg-list">
                {[70, 50, 85, 60, 40].map((w, i) => (
                    <div key={i} className="skeleton-msg-row">
                        <div className="skeleton skeleton-avatar" />
                        <div className="skeleton-lines">
                            <div className="skeleton skeleton-line" style={{ width: `${w}%` }} />
                            <div className="skeleton skeleton-line" style={{ width: `${Math.round(w * 0.65)}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {hasMoreOlder && !loadOlderError && <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />}

            {isLoadingOlder && (
                <div className="history-loading">
                    <span className="history-spinner" /> Загрузка…
                </div>
            )}

            {loadOlderError && (
                <div className="history-error">
                    Не удалось загрузить.{" "}
                    <button type="button" onClick={onLoadOlder}>Повторить</button>
                </div>
            )}

            {!hasMoreOlder && !isLoadingOlder && !loadOlderError && (
                <div className="history-start">Начало истории канала</div>
            )}

            {messages.map((msg) => {
                const isOwn = currentUserId !== null && msg.author_id === currentUserId;
                const isNew = msg.id > initialMaxId;
                const isMentioned =
                    !isOwn && currentUserId !== null && (msg.mentions?.includes(currentUserId) || msg.mentions_everyone === true);

                return (
                    <div
                        key={msg.id}
                        id={`message-${msg.id}`}
                        className={`message-row ${isOwn ? "own" : "other"} ${isMentioned ? "mentioned" : ""}`}
                        data-new={isNew ? "true" : undefined}
                    >
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
                            {msg.content && <div className="message-content">{renderMessageContent(msg.content, membersById)}</div>}
                            {msg.attachments && msg.attachments.length > 0 && (
                                <div className="message-attachments">
                                    {msg.attachments.map(renderAttachment)}
                                </div>
                            )}
                            {/* Карточки внизу сообщения: они приезжают позже остального
                                и не должны сдвигать уже отрисованный текст и вложения. */}
                            {msg.embeds && msg.embeds.length > 0 && (
                                <div className="message-embeds">
                                    {msg.embeds.map((preview) => (
                                        <LinkPreviewCard key={preview.url} preview={preview} />
                                    ))}
                                </div>
                            )}
                            <div className="message-timestamp">{formatMessageTimestamp(msg.created_at)}</div>
                        </div>
                    </div>
                );
            })}

            {isLoadingNewer && (
                <div className="history-loading">
                    <span className="history-spinner" /> Загрузка…
                </div>
            )}

            {hasMoreNewer && <div ref={bottomSentinelRef} className="scroll-sentinel" aria-hidden="true" />}
        </div>
    );
}