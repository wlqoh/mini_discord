import type { OnlineUser } from "../types/chat.ts";

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

type Props = {
    users: OnlineUser[];
    isLoading: boolean;
    avatarByName: Record<string, string>;
    onOpenProfile?: (userId: number) => void;
};

/** Online-users list: shown in a desktop side panel or inside a phone bottom sheet. */
export default function OnlineUsersList({ users, isLoading, avatarByName, onOpenProfile }: Props) {
    return (
        <>
            <div className="online-users-panel-title">Online users</div>
                        {isLoading ? (
                            <div className="skeleton-users-list">
                                {[65, 80, 50].map((w, i) => (
                                    <div key={i} className="skeleton-user-item">
                                        <div className="skeleton skeleton-user-avatar" />
                                        <div className="skeleton-user-lines">
                                            <div className="skeleton skeleton-user-name" style={{ width: `${w}%` }} />
                                            <div className="skeleton skeleton-user-email" style={{ width: `${Math.round(w * 0.7)}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        {!isLoading && users.length === 0 ? (
                            <div className="online-users-empty">No users online</div>
                        ) : null}
                        {!isLoading && users.length > 0 ? (
                            <ul className="online-users-list">
                                {users.map((user, index) => {
                                    const nickname = user.nickname?.trim() || "";
                                    const displayName = nickname || "User";
                                    const initials = getInitials(user);
                                    const avatarKey = displayName.toLowerCase();
                                    const directAvatarUrl = user.avatar_url?.trim() || "";
                                    const avatarUrl = directAvatarUrl || (avatarByName[avatarKey] ?? "");
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
        </>
    );
}
