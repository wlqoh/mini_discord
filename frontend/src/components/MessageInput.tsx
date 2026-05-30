import { useCallback, useRef, useState } from "react";
import { Mic, MicOff, Paperclip, Send, X } from "lucide-react";
import type { AttachmentUploadResponse } from "../services/avatarApi.ts";
import { uploadAttachment } from "../services/avatarApi.ts";
import type { OnlineUser } from "../types/chat.ts";

type Props = {
    disabled?: boolean;
    onSend: (text: string, attachmentIds?: number[]) => Promise<void> | void;
    isOnlinePanelOpen: boolean;
    onToggleOnlinePanel: () => void;
    onlineUsers: OnlineUser[];
    isOnlineUsersLoading: boolean;
    onlineUserAvatarByName: Record<string, string>;
    onOpenProfile?: (userId: number) => void;
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
}: Props) {
    const [text, setText] = useState("");
    const [pendingAttachments, setPendingAttachments] = useState<AttachmentUploadResponse[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const fileInputRef = useRef<HTMLInputElement | null>(null);

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

                setIsUploading(true);
                try {
                    const uploaded = await uploadAttachment(file);
                    setPendingAttachments((prev) => [...prev, uploaded]);
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Upload failed";
                    setUploadError(message);
                } finally {
                    setIsUploading(false);
                }
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

    async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = e.target.files;
        if (!files || files.length === 0) {
            return;
        }

        setUploadError("");

        for (const file of Array.from(files)) {
            if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
                setUploadError(`File "${file.name}" is too large (max 10MB)`);
                continue;
            }

            if (!ALLOWED_TYPES.has(file.type)) {
                setUploadError(`File "${file.name}" has unsupported type`);
                continue;
            }

            setIsUploading(true);
            try {
                const uploaded = await uploadAttachment(file);
                setPendingAttachments((prev) => [...prev, uploaded]);
            } catch (err) {
                const message = err instanceof Error ? err.message : "Upload failed";
                setUploadError(message);
            } finally {
                setIsUploading(false);
            }
        }

        e.target.value = "";
    }

    function removeAttachment(attachmentId: number) {
        setPendingAttachments((prev) => prev.filter((a) => a.attachment_id !== attachmentId));
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const value = text.trim();
        if (!value && pendingAttachments.length === 0) {
            return;
        }
        if (disabled) return;

        const attachmentIds = pendingAttachments.length > 0
            ? pendingAttachments.map((a) => a.attachment_id)
            : undefined;

        await onSend(value, attachmentIds);
        setText("");
        setPendingAttachments([]);
        setUploadError("");
    }

    function openFilePicker() {
        fileInputRef.current?.click();
    }

    const canSend = !disabled && !isUploading && !isRecording && (text.trim().length > 0 || pendingAttachments.length > 0);

    return (
        <form className="message-form" onSubmit={handleSubmit}>
            {pendingAttachments.length > 0 && (
                <div className="message-attachments-preview">
                    {pendingAttachments.map((att) => (
                        <div key={att.attachment_id} className="attachment-preview-item">
                            <span className="attachment-preview-name">{att.url.split("/").pop()}</span>
                            <button
                                type="button"
                                className="attachment-preview-remove"
                                onClick={() => removeAttachment(att.attachment_id)}
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
