import { useState } from "react";
import { Send } from "lucide-react";
import type { OnlineUser } from "../types/chat.ts";

type Props = {
    disabled?: boolean;
    onSend: (text: string) => Promise<void> | void;
    isOnlinePanelOpen: boolean;
    onToggleOnlinePanel: () => void;
    onlineUsers: OnlineUser[];
    isOnlineUsersLoading: boolean;
    onlineUserAvatarByName: Record<string, string>;
    onOpenProfile?: (userId: number) => void;
};

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

    function getInitials(user: OnlineUser): string {
        const first = user.first_name?.trim()?.[0] ?? "";
        const last = user.last_name?.trim()?.[0] ?? "";
        const initials = `${first}${last}`.toUpperCase();
        if (initials) {
            return initials;
        }
        if (user.email) {
            return user.email.trim().slice(0, 2).toUpperCase();
        }
        return "U";
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const value = text.trim();
        if (!value || disabled) return;

        await onSend(value);
        setText("");
    }

    return (
        <form className="message-form" onSubmit={handleSubmit}>
            <input
                className="message-input"
                placeholder="Write a message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={disabled}
            />
            <button className="message-send-btn" type="submit" disabled={disabled || !text.trim()}>
                <Send size={24} aria-hidden="true"/>
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
                                    const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
                                    const initials = getInitials(user);
                                    const avatarKey = fullName.toLowerCase();
                                    const avatarUrl = onlineUserAvatarByName[avatarKey] ?? "";
                                    const userId = (user as OnlineUser & { user_id?: number }).user_id;
                                    const canOpenProfile = typeof userId === "number";
                                    const fallbackKey = fullName || user.email || `user-${index}`;
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
                                                <div className="online-users-name">{fullName || user.email || "User"}</div>
                                                {user.email ? (
                                                    <div className="online-users-email">{user.email}</div>
                                                ) : null}
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
                                                <span className="online-users-status"/>
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