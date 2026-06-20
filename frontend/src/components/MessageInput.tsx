import { useCallback, useRef, useState } from "react";
import { Mic, MicOff, Paperclip, Send, X } from "lucide-react";
import { uploadAttachment } from "../services/avatarApi.ts";
import type { Message, OnlineUser } from "../types/chat.ts";

type PendingFile = {
    id: string;
    file: File;
    previewUrl: string | null;
};

type Props = {
    disabled?: boolean;
    onSend: (text: string, attachmentIds?: number[], replyToId?: number | null) => Promise<void> | void;
    isOnlinePanelOpen: boolean;
    onToggleOnlinePanel: () => void;
    onlineUsers: OnlineUser[];
    isOnlineUsersLoading: boolean;
    onlineUserAvatarByName: Record<string, string>;
    onOpenProfile?: (userId: number) => void;
    replyToMessage?: Message | null;
    onCancelReply?: () => void;
};

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/mp4",
]);

function formatRecordingDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function MessageInput({
    disabled,
    onSend,
    isOnlinePanelOpen,
    onToggleOnlinePanel,
    onlineUsers,
    isOnlineUsersLoading,
    onlineUserAvatarByName,
    onOpenProfile,
    replyToMessage,
    onCancelReply,
}: Props) {
    const [text, setText] = useState("");
    const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    function getReplyAuthorLabel(msg: Message): string {
        const nickname = msg.author_nickname?.trim() ?? "";
        if (nickname) return nickname;
        const fullName = `${msg.author_first_name?.trim() ?? ""} ${msg.author_last_name?.trim() ?? ""}`.trim();
        return fullName || `User #${msg.author_id}`;
    }

    

    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const stopRecording = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== "inactive") {
            recorder.stop();
        }
        setIsRecording(false);
    }, []);

    async function startRecording() {
        setUploadError("");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            chunksRef.current = [];

            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : MediaRecorder.isTypeSupported("audio/webm")
                  ? "audio/webm"
                  : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
                    ? "audio/ogg;codecs=opus"
                    : "audio/mp4";

            const recorder = new MediaRecorder(stream, { mimeType });
            mediaRecorderRef.current = recorder;

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            recorder.onstop = async () => {
                streamRef.current?.getTracks().forEach((t) => t.stop());
                streamRef.current = null;

                const blob = new Blob(chunksRef.current, { type: mimeType });
                chunksRef.current = [];

                const ext = mimeType.startsWith("audio/webm") ? "webm" : mimeType.startsWith("audio/ogg") ? "ogg" : "m4a";
                const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
                const file = new File([blob], `voice_${id}.${ext}`, { type: mimeType });

                if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
                    setUploadError("Voice message is too long (max 10MB)");
                    return;
                }

                const pendingId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
                setPendingFiles((prev) => [...prev, { id: pendingId, file, previewUrl: null }]);
            };

            recorder.start(250);
            setIsRecording(true);
            setRecordingDuration(0);
            timerRef.current = window.setInterval(() => {
                setRecordingDuration((prev) => prev + 1);
            }, 1000);
        } catch {
            setUploadError("Microphone access denied");
        }
    }

    function getInitials(user: OnlineUser): string {
        const nickname = user.nickname?.trim() ?? "";
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
        const initials = `${user.first_name?.[0] ?? ""}${user.last_name?.[0] ?? ""}`.toUpperCase();
        return initials || "U";
    }

    function addFiles(files: File[]) {
        setUploadError("");

        const newFiles: PendingFile[] = [];

        for (const file of files) {
            if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
                setUploadError(`File "${file.name}" is too large (max 10MB)`);
                continue;
            }

            if (!ALLOWED_TYPES.has(file.type)) {
                setUploadError(`File "${file.name}" has unsupported type`);
                continue;
            }

            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            const previewUrl = file.type.startsWith("image/") || file.type.startsWith("video/")
                ? URL.createObjectURL(file)
                : null;
            newFiles.push({ id, file, previewUrl });
        }

        if (newFiles.length > 0) {
            setPendingFiles((prev) => [...prev, ...newFiles]);
        }
    }

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = e.target.files;
        if (!files || files.length === 0) {
            return;
        }

        addFiles(Array.from(files));
        e.target.value = "";
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
        const items = e.clipboardData?.items;
        if (!items) return;

        const imageFiles: File[] = [];

        for (const item of Array.from(items)) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                    imageFiles.push(file);
                }
            }
        }

        if (imageFiles.length === 0) {
            return;
        }

        e.preventDefault();
        addFiles(imageFiles);
    }

    function removePendingFile(id: string) {
        setPendingFiles((prev) => {
            const removed = prev.find((f) => f.id === id);
            if (removed?.previewUrl) {
                URL.revokeObjectURL(removed.previewUrl);
            }
            return prev.filter((f) => f.id !== id);
        });
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const value = text.trim();
        if (!value && pendingFiles.length === 0) {
            return;
        }
        if (disabled) return;

        let attachmentIds: number[] | undefined;

        if (pendingFiles.length > 0) {
            setIsUploading(true);
            try {
                const results = await Promise.allSettled(
                    pendingFiles.map((pf) => uploadAttachment(pf.file)),
                );
                const ids: number[] = [];
                const errors: string[] = [];
                results.forEach((r, i) => {
                    if (r.status === "fulfilled") {
                        ids.push(r.value.attachment_id);
                    } else {
                        errors.push(pendingFiles[i].file.name);
                    }
                });
                if (errors.length > 0) {
                    setUploadError(`Failed to upload: ${errors.join(", ")}`);
                    setIsUploading(false);
                    if (ids.length === 0) return;
                }
                attachmentIds = ids.length > 0 ? ids : undefined;
                pendingFiles.forEach((pf) => {
                    if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
                });
            } catch {
                setUploadError("Upload failed");
                setIsUploading(false);
                return;
            }
            setIsUploading(false);
        }

        await onSend(value, attachmentIds, replyToMessage?.id ?? undefined);
        setText("");
        setPendingFiles([]);
        setUploadError("");
    }

    function openFilePicker() {
        fileInputRef.current?.click();
    }

    const canSend = !disabled && !isUploading && !isRecording && (text.trim().length > 0 || pendingFiles.length > 0);

    return (
        <form className="message-form" onSubmit={handleSubmit}>
            {replyToMessage && (
                <div className="reply-draft">
                    <div className="reply-draft-content">
                        <span className="reply-draft-author">{getReplyAuthorLabel(replyToMessage)}</span>
                        <span className="reply-draft-text">{replyToMessage.content ? (replyToMessage.content.length > 80 ? replyToMessage.content.slice(0, 80) + "..." : replyToMessage.content) : (replyToMessage.attachments && replyToMessage.attachments.length > 0 ? "📎 Attachment" : "")}</span>
                    </div>
                    <button type="button" className="reply-draft-cancel" onClick={onCancelReply} aria-label="Cancel reply">
                        <X size={14} />
                    </button>
                </div>
            )}
            {pendingFiles.length > 0 && (
                <div className="message-attachments-preview">
                    {pendingFiles.map((pf) => (
                        <div key={pf.id} className="attachment-preview-item">
                            {pf.previewUrl && (pf.file.type.startsWith("image/") || pf.file.type.startsWith("video/")) && (
                                <img
                                    src={pf.previewUrl}
                                    alt={pf.file.name}
                                    className="attachment-preview-thumb"
                                />
                            )}
                            <span className="attachment-preview-name">{pf.file.name}</span>
                            <button
                                type="button"
                                className="attachment-preview-remove"
                                onClick={() => removePendingFile(pf.id)}
                                aria-label="Remove attachment"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {uploadError && (
                <div className="message-upload-error">{uploadError}</div>
            )}
            {isRecording && (
                <div className="voice-recording-bar">
                    <span className="voice-recording-dot" />
                    <span className="voice-recording-timer">{formatRecordingDuration(recordingDuration)}</span>
                    <button
                        type="button"
                        className="voice-recording-stop"
                        onClick={stopRecording}
                        aria-label="Stop recording"
                    >
                        <MicOff size={18} aria-hidden="true" />
                    </button>
                </div>
            )}
            {!isRecording && (
                <>
                    <input
                        className="message-input"
                        placeholder={isUploading ? "Uploading..." : "Write a message"}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onPaste={handlePaste}
                        disabled={disabled || isUploading}
                    />
                    <button
                        className="message-voice-btn"
                        type="button"
                        onClick={startRecording}
                        disabled={disabled || isUploading}
                        aria-label="Record voice message"
                    >
                        <Mic size={20} aria-hidden="true" />
                    </button>
                </>
            )}
            <button
                className="message-attach-btn"
                type="button"
                onClick={openFilePicker}
                disabled={disabled || isUploading || isRecording}
                aria-label="Attach file"
            >
                <Paperclip size={20} aria-hidden="true" />
            </button>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                style={{ display: "none" }}
                onChange={handleFileChange}
            />
            <button
                className="message-send-btn"
                type="submit"
                disabled={!canSend}
            >
                <Send size={24} aria-hidden="true" />
            </button>
            <div className="message-actions-wrap">
                <button
                    className={`message-online-toggle-btn ${isOnlinePanelOpen ? "active" : ""}`}
                    type="button"
                    onClick={onToggleOnlinePanel}
                >
                    Online
                </button>

                {isOnlinePanelOpen ? (
                    <aside className="online-users-panel" aria-label="Online users">
                        <div className="online-users-panel-title">Online users</div>
                        {isOnlineUsersLoading ? <div className="online-users-empty">Loading...</div> : null}
                        {!isOnlineUsersLoading && onlineUsers.length === 0 ? (
                            <div className="online-users-empty">No users online</div>
                        ) : null}
                        {!isOnlineUsersLoading && onlineUsers.length > 0 ? (
                            <ul className="online-users-list">
                                {onlineUsers.map((user, index) => {
                                    const nickname = user.nickname?.trim() || "";
                                    const displayName = nickname || "User";
                                    const initials = getInitials(user);
                                    const avatarKey = displayName.toLowerCase();
                                    const directAvatarUrl = user.avatar_url?.trim() || "";
                                    const avatarUrl = directAvatarUrl || (onlineUserAvatarByName[avatarKey] ?? "");
                                    const userId = user.user_id;
                                    const canOpenProfile = typeof userId === "number";
                                    const fallbackKey = displayName || `user-${index}`;
                                    return (
                                        <li
                                            key={userId ?? fallbackKey}
                                            className="online-users-item"
                                            role={canOpenProfile ? "button" : undefined}
                                            tabIndex={canOpenProfile ? 0 : undefined}
                                            onClick={() => (canOpenProfile ? onOpenProfile?.(userId as number) : undefined)}
                                            onKeyDown={(event) => {
                                                if (!canOpenProfile) return;
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    onOpenProfile?.(userId as number);
                                                }
                                            }}
                                        >
                                            <div className="online-users-meta">
                                                <div className="online-users-name">{displayName}</div>
                                            </div>
                                            <div className="online-users-avatar-wrap" aria-hidden="true">
                                                {avatarUrl ? (
                                                    <img
                                                        className="online-users-avatar-img"
                                                        src={avatarUrl}
                                                        alt=""
                                                        loading="lazy"
                                                        onError={(event) => {
                                                            event.currentTarget.style.display = "none";
                                                            event.currentTarget.nextElementSibling?.classList.add("show");
                                                        }}
                                                    />
                                                ) : null}
                                                <div className={`online-users-avatar-fallback ${avatarUrl ? "" : "show"}`}>{initials}</div>
                                                <span className="online-users-status" />
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : null}
                    </aside>
                ) : null}
            </div>
        </form>
    );
}
