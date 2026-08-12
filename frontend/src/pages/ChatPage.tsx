import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {Search, Trash2, Mic, MicOff, Camera, CameraOff, Monitor, MonitorOff, RefreshCw, PanelLeftClose, PanelLeftOpen, Volume2, VolumeOff, Hash, Sun, Moon, Menu, Bell} from "lucide-react";
import {useMediaQuery} from "../hooks/useMediaQuery";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import TypingIndicator from "../components/TypingIndicator.tsx";
import VideoTile from "../components/VideoTile.tsx";
import JumpToLatestButton from "../components/JumpToLatestButton.tsx";
import {ChatSocket} from "../services/chatSocket.ts";
import {CallClient} from "../services/callClient.ts";
import {getCurrentUserId, getCurrentUserProfile, clearAuthStorage} from "../services/authToken.ts";
import type {CurrentUserProfile} from "../services/authToken.ts";
import type {
    MessagesByChannel,
    VoiceParticipant,
} from "../types/chat.ts";
import {getMyAvatarUrl} from "../services/avatarApi.ts";
import { useToast } from "../components/Toast.tsx";
import { useVoice } from "../hooks/useVoice.ts";
import { useServers } from "../hooks/useServers.ts";
import { useMessages } from "../hooks/useMessages.ts";
import { useProfile } from "../hooks/useProfile.ts";
import { useTypingEmitter } from "../hooks/useTypingEmitter.ts";
import { useTypingIndicator } from "../hooks/useTypingIndicator.ts";
import { useUnread } from "../hooks/useUnread.ts";
import { useJumpToLatest } from "../hooks/useJumpToLatest.ts";
import { useNotifications } from "../hooks/useNotifications.ts";
import { useServerMembers } from "../hooks/useServerMembers.ts";
import { useNotificationSettings } from "../hooks/useNotificationSettings.ts";
import NotificationSettingsModal from "../components/NotificationSettingsModal.tsx";
import NotificationPermissionBanner from "../components/NotificationPermissionBanner.tsx";
import { useDocumentBadge } from "../hooks/useDocumentBadge.ts";
import {
    initSoundUnlock,
    initLeaderElection,
    getPermissionState,
    requestNotificationPermission,
    resolveLevel,
    isMuted as isChannelNotificationMuted,
    subscribeToPush,
    dismissSoftPrompt,
    type PermissionState,
} from "../services/notifications";
import type { NotificationClickData } from "../types/notifications.ts";
import ContextMenu from "../components/ContextMenu.tsx";
import { useNotificationContextMenu } from "../hooks/useNotificationContextMenu.ts";
import "../styles/chat.css";

const COLOR_THEME_KEY = "color_theme";
type ColorTheme = "dark" | "light";

function formatUnreadCount(count: number): string {
    return count > 99 ? "99+" : String(count);
}

export default function ChatPage() {
    const navigate = useNavigate();
    const { showToast } = useToast();
    const socketRef = useRef<ChatSocket | null>(null);
    const callClientRef = useRef<CallClient | null>(null);
    const chatContentRef = useRef<HTMLDivElement | null>(null);
    const avatarInputRef = useRef<HTMLInputElement | null>(null);
    const prevScrollTrackRef = useRef<{
        channelId: number;
        firstId: number | undefined;
        lastId: number | undefined;
        scrollHeight: number;
    } | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState("");
    const [isPageVisible, setIsPageVisible] = useState(true);
    const [currentUserProfile, setCurrentUserProfile] = useState<CurrentUserProfile | null>(
        () => getCurrentUserProfile(),
    );
    const currentUserId: number | null = getCurrentUserId();
    const [avatarUrl, setAvatarUrl] = useState("");
    const [theme, setTheme] = useState<ColorTheme>(() => {
        try {
            return localStorage.getItem(COLOR_THEME_KEY) === "light" ? "light" : "dark";
        } catch {
            return "dark";
        }
    });
    const [closingModal, setClosingModal] = useState<string | null>(null);
    const [isChannelsSidebarHidden, setIsChannelsSidebarHidden] = useState(false);
    const [isChannelsDrawerOpen, setIsChannelsDrawerOpen] = useState(false);
    const [notificationPermission, setNotificationPermission] = useState<PermissionState>(() => getPermissionState());
    const [isNotificationSettingsOpen, setIsNotificationSettingsOpen] = useState(false);
    const [showPermissionBanner, setShowPermissionBanner] = useState(false);
    const isMobileDevice = useMediaQuery("(max-width: 1024px) and (pointer: coarse)");
    const isPhone = useMediaQuery("(max-width: 768px)");

    // Shared messagesByChannel state (used by both useServers and useMessages)
    const [messagesByChannel, setMessagesByChannel] = useState<MessagesByChannel>({});

    const handleAuthFailure = useCallback(
        (message: string): void => {
            clearAuthStorage();
            setError(message);
            navigate("/login", {replace: true});
        },
        [navigate],
    );

    function closeModalWithAnim(name: string, close: () => void): void {
        setClosingModal(name);
        window.setTimeout(() => {
            close();
            setClosingModal(null);
        }, 160);
    }

    function toggleTheme(): void {
        setTheme((prev) => (prev === "light" ? "dark" : "light"));
    }

    function scrollToMessage(messageId: number) {
        const el = document.getElementById(`message-${messageId}`);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("message-highlight");
            setTimeout(() => el.classList.remove("message-highlight"), 2000);
        }
    }

    // isPageVisible effect
    useEffect(() => {
        const handler = () => setIsPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
    }, []);

    // Notification sound unlock (first user gesture) + multi-tab leader election.
    useEffect(() => {
        const disposeUnlock = initSoundUnlock();
        const disposeLeader = initLeaderElection();
        return () => {
            disposeUnlock();
            disposeLeader();
        };
    }, []);

    async function handleEnableNotifications(): Promise<void> {
        const result = await requestNotificationPermission();
        setNotificationPermission(result);
        if (result === "granted") {
            void subscribeToPush();
        }
    }

    // Ensure a push subscription exists whenever permission is already granted
    // (e.g. returning to the app, or a fresh device that inherited an OS-level
    // grant) — subscribeToPush() no-ops safely if push is disabled server-side.
    useEffect(() => {
        if (notificationPermission === "granted") {
            void subscribeToPush();
        }
    }, [notificationPermission]);

    // Theme effect
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        try {
            localStorage.setItem(COLOR_THEME_KEY, theme);
        } catch {
            // ignore quota or security errors
        }
    }, [theme]);

    // Avatar load effect
    useEffect(() => {
        getMyAvatarUrl().then((url) => setAvatarUrl(url ?? "")).catch(() => {});
    }, []);

    // Hook call order matters for dependency flow
    const voice = useVoice({
        socketRef,
        callClientRef,
        currentUserId,
        currentUserProfile,
        avatarUrl,
        setError,
    });

    const servers = useServers({
        socketRef,
        callClientRef,
        setIsConnected,
        isPageVisible,
        showToast,
        currentUserProfile,
        handleAuthFailure,
        setError,
        setVoiceParticipantsByChannel: voice.setVoiceParticipantsByChannel,
        setMessagesByChannel,
        callClientCallbacks: voice.callClientCallbacks,
        voiceSocketHandlers: voice.voiceSocketHandlers,
        currentUserId,
    });

    const messages = useMessages({
        socketRef,
        isConnected,
        selectedChannelId: servers.selectedChannelId,
        selectedServerIdRef: servers.selectedServerIdRef,
        setError,
        setChannelsByServer: servers.setChannelsByServer,
        messagesByChannel,
        setMessagesByChannel,
    });

    const profile = useProfile({
        socketRef,
        callClientRef,
        avatarInputRef,
        currentUserId,
        currentUserProfile,
        setCurrentUserProfile,
        avatarUrl,
        setAvatarUrl,
        messagesByChannel,
        voiceParticipantsByChannel: voice.voiceParticipantsByChannel,
        showToast,
        navigate,
        closeModalWithAnim,
    });

    const typingEmitter = useTypingEmitter(socketRef, servers.selectedChannelId);
    const typingByChannel = useTypingIndicator(socketRef, isConnected, currentUserId);

    const unread = useUnread({
        socketRef,
        isConnected,
        isPageVisible,
        currentUserId,
        selectedChannelId: servers.selectedChannelId,
        channelsByServer: servers.channelsByServer,
        messagesByChannel,
    });

    const notificationSettings = useNotificationSettings(currentUserId !== null);
    const notificationMenu = useNotificationContextMenu(
        notificationSettings.settings,
        notificationSettings.updateServer,
        notificationSettings.updateChannel,
    );

    useNotifications({
        socketRef,
        isConnected,
        isPageVisible,
        currentUserId,
        selectedChannelId: servers.selectedChannelId,
        channelsByServer: servers.channelsByServer,
        settings: notificationSettings.settings,
        onMissedPermission: () => setShowPermissionBanner(true),
    });

    async function handlePermissionBannerEnable(): Promise<void> {
        setShowPermissionBanner(false);
        await handleEnableNotifications();
    }

    function handlePermissionBannerDismiss(): void {
        setShowPermissionBanner(false);
        dismissSoftPrompt();
    }

    useDocumentBadge(unread.totalUnread, unread.hasUnreadMention);

    const serverMembers = useServerMembers(socketRef, isConnected, servers.selectedServerId);

    // Navigate to a channel/message referenced by a notification click, whether it
    // arrived over postMessage (tab was already open) or as boot query params
    // (tab was opened fresh by the Service Worker — see public/sw.js).
    const navigateFromNotification = useCallback(
        (data: NotificationClickData) => {
            if (!data.channel_id) return;
            (async () => {
                if (data.server_id && data.server_id !== servers.selectedServerId) {
                    await servers.handleSelectServer(data.server_id);
                }
                servers.setSelectedChannelId(data.channel_id!);
                if (data.message_id) {
                    window.setTimeout(() => scrollToMessage(data.message_id!), 300);
                }
            })();
        },
        [servers],
    );

    useEffect(() => {
        if (!("serviceWorker" in navigator)) return;
        const handler = (event: MessageEvent) => {
            if (event.data?.type === "notification-click") {
                navigateFromNotification(event.data as NotificationClickData);
            }
        };
        navigator.serviceWorker.addEventListener("message", handler);
        return () => navigator.serviceWorker.removeEventListener("message", handler);
    }, [navigateFromNotification]);

    const hasHandledBootParamsRef = useRef(false);
    useEffect(() => {
        if (hasHandledBootParamsRef.current || !isConnected) return;

        const params = new URLSearchParams(window.location.search);
        const channelId = Number(params.get("channel"));
        const messageId = Number(params.get("message"));
        if (channelId > 0) {
            hasHandledBootParamsRef.current = true;
            navigateFromNotification({ channel_id: channelId, message_id: messageId > 0 ? messageId : undefined });
            const url = new URL(window.location.href);
            url.searchParams.delete("channel");
            url.searchParams.delete("message");
            window.history.replaceState({}, "", url.toString());
        }
    }, [isConnected, navigateFromNotification]);

    // Derived values
    const activeChannels = servers.channelsByServer[servers.selectedServerId] ?? [];
    const currentServer = servers.servers.find((server) => server.id === servers.selectedServerId);
    const isCurrentServerOwner =
        currentUserId !== null &&
        currentServer !== undefined &&
        currentServer.owner_id === currentUserId;
    const currentChannel = activeChannels.find((channel) => channel.id === servers.selectedChannelId);
    const isVoiceChannel = currentChannel?.type === "voice";
    const isInVoiceCall = voice.voiceChannelId > 0;
    const isInSelectedVoiceChannel = isVoiceChannel && voice.voiceChannelId === servers.selectedChannelId;
    const shouldHideMessageInput = isVoiceChannel;
    const activeMessages = servers.selectedChannelId > 0 ? messagesByChannel[servers.selectedChannelId] ?? [] : [];
    const isMessagesLoading = servers.selectedChannelId > 0 && messagesByChannel[servers.selectedChannelId] === undefined;
    const activePagination = messages.paginationByChannel[servers.selectedChannelId];
    const isLoadingOlder = activePagination?.isLoadingMore ?? false;
    const hasMoreOlder = activePagination?.hasMore ?? false;
    const loadOlderError = activePagination?.error ?? false;
    const typingUserIds = servers.selectedChannelId > 0 ? typingByChannel[servers.selectedChannelId] ?? [] : [];

    const userInitial =
        currentUserProfile?.nickname?.[0]?.toUpperCase() ??
        currentUserProfile?.first_name?.[0]?.toUpperCase() ??
        currentUserProfile?.email?.[0]?.toUpperCase() ??
        "U";

    const getParticipantDisplayName = (participant: VoiceParticipant): string => {
        const nickname = participant.nickname?.trim();
        if (nickname) {
            return nickname;
        }
        const fullName = [participant.first_name, participant.last_name].filter(Boolean).join(" ").trim();
        return fullName || `User ${participant.user_id}`;
    };
    const getParticipantInitials = (participant: VoiceParticipant): string => {
        const nickname = participant.nickname?.trim() ?? "";
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
        const initials = `${participant.first_name?.[0] ?? ""}${participant.last_name?.[0] ?? ""}`.toUpperCase();
        return initials || "U";
    };

    const onlineUserAvatarByName = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};

        const add = (firstName?: string, lastName?: string, avatar?: string, nickname?: string) => {
            if (!avatar) {
                return;
            }
            const fullName = [firstName, lastName].filter(Boolean).join(" ").trim().toLowerCase();
            if (fullName && !map[fullName]) {
                map[fullName] = avatar;
            }
            const nickKey = nickname?.trim().toLowerCase();
            if (nickKey && !map[nickKey]) {
                map[nickKey] = avatar;
            }
        };

        Object.values(messagesByChannel).forEach((msgs) => {
            msgs.forEach((message) => {
                add(message.author_first_name, message.author_last_name, message.author_avatar_url, message.author_nickname);
            });
        });

        add(currentUserProfile?.first_name, currentUserProfile?.last_name, avatarUrl, currentUserProfile?.nickname);

        return map;
    }, [messagesByChannel, currentUserProfile?.first_name, currentUserProfile?.last_name, currentUserProfile?.nickname, avatarUrl]);

    const jump = useJumpToLatest({
        containerRef: chatContentRef,
        messages: activeMessages,
        selectedChannelId: servers.selectedChannelId,
        currentUserId,
    });

    // Scroll positioning: jump to bottom on channel switch, stick to bottom on
    // new tail messages, and preserve reading position when older history is prepended.
    useLayoutEffect(() => {
        const el = chatContentRef.current;
        if (!el) return;

        const channelId = servers.selectedChannelId;
        const firstId = activeMessages[0]?.id;
        const lastId = activeMessages[activeMessages.length - 1]?.id;
        const prev = prevScrollTrackRef.current;

        // prev.lastId is undefined only for the trivial commit captured while
        // messages were still loading (empty activeMessages) — treat the
        // loading-to-loaded transition the same as a fresh mount, otherwise it
        // matches neither isPrepend nor isAppend below and never scrolls down.
        if (!prev || prev.channelId !== channelId || prev.lastId === undefined) {
            el.scrollTop = el.scrollHeight;
            jump.isAtBottomRef.current = true;
            prevScrollTrackRef.current = { channelId, firstId, lastId, scrollHeight: el.scrollHeight };
            return;
        }

        // el.scrollHeight here already reflects the DOM *after* React committed
        // this update — compare against the height captured at the end of the
        // previous run to get the delta added by a prepend.
        const isPrepend = prev.lastId === lastId && prev.firstId !== firstId;
        const isAppend = prev.firstId === firstId && prev.lastId !== lastId;

        if (isPrepend) {
            el.scrollTop += el.scrollHeight - prev.scrollHeight;
        } else if (isAppend && jump.isAtBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }

        prevScrollTrackRef.current = { channelId, firstId, lastId, scrollHeight: el.scrollHeight };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- firstId/lastId are read fresh from activeMessages each run; length is the correct change signal
    }, [activeMessages.length, servers.selectedChannelId]);

    return (
        <div className={`chat-layout ${isChannelsSidebarHidden ? "channels-sidebar-hidden" : ""}`} onClick={() => { if (isChannelsDrawerOpen) setIsChannelsDrawerOpen(false); }}>
            {showPermissionBanner && notificationPermission === "default" ? (
                <NotificationPermissionBanner
                    onEnable={() => void handlePermissionBannerEnable()}
                    onDismiss={handlePermissionBannerDismiss}
                />
            ) : null}
            <aside className="servers-sidebar">
                <button
                    className="server-add-btn"
                    onClick={servers.openCreateServerModal}
                    disabled={!isConnected || servers.isCreatingServer}
                    aria-label="Add server"
                    title="Add server"
                >
                    +
                </button>
                <button
                    className="server-add-btn"
                    onClick={servers.openJoinServerModal}
                    disabled={!isConnected}
                    aria-label="Join server"
                    title="Join server"
                >
                    <Search size={18} aria-hidden="true"/>
                </button>
                <ul className="servers-list">
                    {servers.servers.map((server) => {
                        const serverUnread = unread.unreadByServer[server.id] ?? 0;
                        return (
                            <li key={server.id} className="server-item">
                                <button
                                    className={`server-dot ${servers.selectedServerId === server.id ? "active" : ""}`}
                                    onClick={() => void servers.handleSelectServer(server.id)}
                                    onContextMenu={(e) => notificationMenu.openServerMenu(e, server.id)}
                                    title={`Server ${server.name} (ID ${server.id})`}
                                    aria-label={`Server ${server.name}`}
                                >
                                    {server.name?.[0]?.toUpperCase() ?? "?"}
                                </button>
                                {serverUnread > 0 ? (
                                    <span
                                        className="server-unread-badge"
                                        title={`${serverUnread} unread`}
                                        aria-label={`${serverUnread} непрочитанных сообщений`}
                                    >
                                        {formatUnreadCount(serverUnread)}
                                    </span>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
                <div className="servers-sidebar-footer">
                    {isChannelsSidebarHidden ? (
                        <button
                            className="channels-add-btn"
                            type="button"
                            onClick={() => setIsChannelsSidebarHidden(false)}
                            aria-label="Show channels panel"
                            title="Show channels panel"
                        >
                            <PanelLeftOpen size={16} aria-hidden="true"/>
                        </button>
                    ) : null}
                </div>
            </aside>

            <div
                className={`channels-drawer-overlay ${isChannelsDrawerOpen ? "active" : ""}`}
                onClick={() => setIsChannelsDrawerOpen(false)}
                aria-hidden="true"
            />
            <aside className={`channels-sidebar ${isChannelsSidebarHidden ? "hidden" : ""} ${isChannelsDrawerOpen ? "drawer-open" : ""}`} onClick={(e) => e.stopPropagation()}>
                <div className="channels-header">
                    <span>Server {currentServer?.name ?? "-"}</span>
                    <div className="actions">
                        <button
                            className="channels-add-btn"
                            onClick={() => setIsChannelsSidebarHidden((prev) => !prev)}
                            aria-label={isChannelsSidebarHidden ? "Show channels panel" : "Hide channels panel"}
                            title={isChannelsSidebarHidden ? "Show channels panel" : "Hide channels panel"}
                            type="button"
                        >
                            {isChannelsSidebarHidden ? <PanelLeftOpen size={16} aria-hidden="true"/> : <PanelLeftClose size={16} aria-hidden="true"/>}
                        </button>
                        {isCurrentServerOwner ? (
                            <button
                                className="channels-add-btn"
                                onClick={() => void servers.handleDeleteServer()}
                                disabled={!isConnected || servers.selectedServerId <= 0}
                                aria-label="Delete server"
                                title="Delete server"
                                type="button"
                            >
                                <Trash2 size={14} aria-hidden="true"/>
                            </button>
                        ) : null}
                        <button
                            className="channels-add-btn"
                            onClick={servers.openCreateChannelModal}
                            disabled={!isConnected || servers.selectedServerId <= 0 || servers.isCreatingChannel}
                            aria-label="Create channel"
                            title="Create channel"
                            type="button"
                        >
                            +
                        </button>
                    </div>
                </div>
                <ul className="channels-list">
                    {activeChannels.map((channel) => {
                        const channelUnread = channel.type === "text" ? unread.unreadByChannel[channel.id] ?? 0 : 0;
                        const channelLevel = resolveLevel(notificationSettings.settings, servers.selectedServerId, channel.id);
                        const isChannelSilenced =
                            channelLevel === "none" ||
                            isChannelNotificationMuted(notificationSettings.settings, servers.selectedServerId, channel.id);
                        return (
                        <li key={channel.id} className="channel-item">
                            <div className="channel-row-wrap">
                                <button
                                    className={`channel-row ${servers.selectedChannelId === channel.id ? "active" : ""} ${channelUnread > 0 ? "has-unread" : ""} ${isChannelSilenced ? "muted" : ""}`}
                                    onClick={() => { servers.setSelectedChannelId(channel.id); if (isPhone) setIsChannelsDrawerOpen(false); }}
                                    onContextMenu={(e) => notificationMenu.openChannelMenu(e, channel.id)}
                                    type="button"
                                >
                                    {channel.type === "voice"
                                        ? <Volume2 size={14} aria-hidden="true" />
                                        : <Hash size={14} aria-hidden="true" />
                                    }
                                    <span className="channel-row-name">{channel.name}</span>
                                    {channelUnread > 0 ? (
                                        <span
                                            className="channel-unread-badge"
                                            title={`${channelUnread} unread`}
                                            aria-label={`${channelUnread} непрочитанных сообщений`}
                                        >
                                            {formatUnreadCount(channelUnread)}
                                        </span>
                                    ) : null}
                                </button>

                                {isCurrentServerOwner ? (
                                    <button
                                        className="channels-delete-btn"
                                        type="button"
                                        onClick={() => void servers.handleDeleteChannel(channel.id)}
                                        aria-label={`Delete channel ${channel.name}`}
                                        title="Delete channel"
                                    >
                                        <Trash2 size={14} aria-hidden="true"/>
                                    </button>
                                ) : null}
                            </div>
                            {channel.type === "voice" && (voice.voiceParticipantsByChannel[channel.id]?.length ?? 0) > 0 ? (
                                <ul className="voice-members-list">
                                    {(voice.voiceParticipantsByChannel[channel.id] ?? []).map((participant) => (
                                        <li
                                            key={participant.user_id}
                                            className="voice-member-item"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() =>
                                                voice.setActiveVolumeUserId((prev) => (prev === participant.user_id ? null : participant.user_id))
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    voice.setActiveVolumeUserId((prev) => (prev === participant.user_id ? null : participant.user_id));
                                                }
                                            }}
                                        >
                                            <div
                                                className="voice-member-avatar-wrap"
                                                role="button"
                                                tabIndex={0}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    void profile.openUserProfile(participant.user_id);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") {
                                                        event.stopPropagation();
                                                        void profile.openUserProfile(participant.user_id);
                                                    }
                                                }}
                                            >
                                                {participant.avatar_url ? (
                                                    <img
                                                        src={participant.avatar_url}
                                                        alt={getParticipantDisplayName(participant)}
                                                        className="voice-member-avatar"
                                                    />
                                                ) : (
                                                    <span className="voice-member-avatar-fallback">
                                                        {getParticipantInitials(participant)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="voice-member-meta">
                                                <span className="voice-member-name">{getParticipantDisplayName(participant)}</span>
                                                <span className="voice-member-status">
                                                    {participant.mic_enabled === false ? (
                                                        <MicOff size={14} aria-hidden="true" />
                                                    ) : null}
                                                    {participant.deafened ? <VolumeOff size={14} aria-hidden="true" /> : null}
                                                </span>
                                            </div>
                                            {voice.activeVolumeUserId === participant.user_id && (
                                                <div className="voice-volume-popover" onClick={(e) => e.stopPropagation()}>
                                                    <div className="voice-volume-slider-wrap">
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="2"
                                                            step="0.01"
                                                            value={voice.voiceVolumeByUserId[participant.user_id] ?? 1}
                                                            onChange={(e) => {
                                                                const raw = Number(e.target.value);
                                                                const next = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1;
                                                                voice.setVoiceVolumeByUserId((prev) => ({
                                                                    ...prev,
                                                                    [participant.user_id]: next,
                                                                }));
                                                            }}
                                                        />
                                                        <div className="voice-volume-ticks" aria-hidden="true">
                                                            <span>0%</span>
                                                            <span>100%</span>
                                                            <span>200%</span>
                                                        </div>
                                                    </div>
                                                    <span className="voice-volume-value">
                                                        {Math.round((voice.voiceVolumeByUserId[participant.user_id] ?? 1) * 100)}%
                                                    </span>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </li>
                        );
                    })}
                </ul>
            </aside>

            <section className="chat-main">
                <div className="chat-content-wrap">
                <div className="chat-content" ref={chatContentRef}>
                    <div className="chat-header-block">
                        <div className="chat-header-row">
                            <div className="chat-header-left">
                                <button
                                    className="channels-hamburger-btn"
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setIsChannelsDrawerOpen((prev) => !prev); }}
                                    aria-label={isChannelsDrawerOpen ? "Close channels" : "Open channels"}
                                >
                                    <Menu size={20} aria-hidden="true" />
                                </button>
                                <span className="chat-header">{currentServer ? `Сервер ${currentServer.name}` : "Server"}</span>
                            </div>
                            <div className="chat-header-actions">
                                <button
                                    className="profile-open-btn"
                                    type="button"
                                    onClick={profile.openSelfProfile}
                                    aria-label="Open profile"
                                    title="Profile"
                                >
                                    {avatarUrl ? (
                                        <img
                                            src={avatarUrl}
                                            alt="User avatar"
                                            className="profile-open-avatar"
                                            onError={() => setAvatarUrl("")}
                                        />
                                    ) : (
                                        userInitial
                                    )}
                                </button>
                            </div>
                        </div>
                        <div className="chat-subheader">
                            {currentChannel ? `# ${currentChannel.name}` : "Channel not selected"}
                        </div>
                    </div>
                    {(isInVoiceCall || isVoiceChannel) && (
                        <div className="voice-panel">
                            <div className="voice-controls">
                                {isInVoiceCall ? (
                                    <>
                                        <button className="message-send-btn" onClick={() => void voice.handleLeaveVoice()}>
                                            Leave
                                        </button>
                                        <button className="micam-btn" onClick={voice.toggleMicrophone} disabled={voice.isDeafened}>
                                            {voice.isMicEnabled ? <Mic size={18} aria-hidden="true"/> :
                                                <MicOff size={18} aria-hidden="true" color="#B80606"/>}
                                        </button>
                                        <button className="micam-btn" onClick={voice.toggleCamera}>
                                            {voice.isCameraEnabled ? <Camera size={18} aria-hidden="true"/> :
                                                <CameraOff size={18} aria-hidden="true" color="#B80606"/>}
                                        </button>
                                        {isMobileDevice ? (
                                            <button
                                                className="micam-btn"
                                                onClick={() => void voice.switchCameraFacingMode()}
                                                disabled={voice.isSwitchingCamera || !voice.localStream}
                                                title="Switch camera"
                                                aria-label="Switch camera"
                                            >
                                                <RefreshCw size={18} aria-hidden="true"/>
                                            </button>
                                        ) : (
                                            <button
                                                className="micam-btn"
                                                onClick={() => void voice.toggleScreenShare()}
                                                disabled={!voice.localStream || voice.isTogglingScreenShare || voice.isSwitchingCamera}
                                                title={voice.isScreenSharing ? "Stop screen sharing" : "Share screen"}
                                                aria-label={voice.isScreenSharing ? "Stop screen sharing" : "Share screen"}
                                            >
                                                {voice.isScreenSharing ? <MonitorOff size={18} aria-hidden="true"/> :
                                                    <Monitor size={18} aria-hidden="true"/>}
                                            </button>
                                        )}
                                        <button className="micam-btn" onClick={voice.toggleDeafen}>
                                            {voice.isDeafened ? <VolumeOff size={18} aria-hidden="true" color="#B80606"/> :
                                                <Volume2 size={18} aria-hidden="true"/>}
                                        </button>
                                        {isVoiceChannel && !isInSelectedVoiceChannel && (
                                            <button className="message-send-btn" onClick={() => void voice.handleJoinVoice(servers.selectedChannelId)}>
                                                Switch
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <button className="message-send-btn" onClick={() => void voice.handleJoinVoice(servers.selectedChannelId)}>
                                        Join
                                    </button>
                                )}
                            </div>
                            {isInVoiceCall && (
                            <div className="video-grid">
                                {voice.localStream && (
                                    <VideoTile
                                        stream={voice.localStream}
                                        label="You"
                                        muted
                                        micEnabled={voice.isMicEnabled}
                                        deafened={voice.isDeafened}
                                    />
                                )}
                                {voice.voiceParticipantsInChannel
                                    .filter((p) => p.user_id !== currentUserId)
                                    .map((participant) => {
                                        const remoteItem = voice.remoteStreams.find((r) => r.userId === participant.user_id);
                                        const stream = remoteItem?.stream ?? null;
                                        const label = remoteItem?.label ?? getParticipantDisplayName(participant);
                                        const userVolume = voice.voiceVolumeByUserId[participant.user_id] ?? 1;
                                        const effectiveVolume = voice.isDeafened ? 0 : userVolume;
                                        return (
                                            <VideoTile
                                                key={`${participant.user_id}-${voice.isDeafened ? "deaf" : "live"}`}
                                                stream={stream}
                                                label={label}
                                                muted={voice.isDeafened}
                                                volume={effectiveVolume}
                                                micEnabled={participant.mic_enabled}
                                                deafened={participant.deafened}
                                            />
                                        );
                                    })}
                            </div>
                            )}
                        </div>
                    )}
                    {error ? <div className="messages-empty">{error}</div> : null}
                    <MessageList key={servers.selectedChannelId} messages={activeMessages} currentUserId={currentUserId} onOpenProfile={profile.openUserProfile} onDeleteMessage={messages.handleDeleteMessage} onReply={messages.setReplyToMessage} onScrollToMessage={scrollToMessage} isLoading={isMessagesLoading} hasMoreOlder={hasMoreOlder} isLoadingOlder={isLoadingOlder} loadOlderError={loadOlderError} onLoadOlder={() => messages.loadOlderMessages(servers.selectedChannelId)} serverMembers={serverMembers.members}/>
                </div>
                <JumpToLatestButton
                    isVisible={jump.isVisible}
                    newCount={jump.newCount}
                    onClick={jump.jumpToLatest}
                />
                </div>
                {shouldHideMessageInput ? null : (
                    <>
                        <TypingIndicator
                            userIds={typingUserIds}
                            onlineUsers={servers.onlineUsers}
                            messages={activeMessages}
                            socketRef={socketRef}
                        />
                        <MessageInput
                            onSend={messages.handleSend}
                            disabled={!isConnected || servers.selectedChannelId <= 0}
                            isOnlinePanelOpen={servers.isOnlinePanelOpen}
                            onToggleOnlinePanel={() => servers.setIsOnlinePanelOpen((prev) => !prev)}
                            onlineUsers={servers.onlineUsers}
                            isOnlineUsersLoading={servers.isOnlineUsersLoading}
                            onlineUserAvatarByName={onlineUserAvatarByName}
                            onOpenProfile={profile.openUserProfile}
                            replyToMessage={messages.replyToMessage}
                            onCancelReply={() => messages.setReplyToMessage(null)}
                            onTypingInput={typingEmitter.onInput}
                            onTypingStop={typingEmitter.stop}
                            serverMembers={serverMembers.members}
                        />
                    </>
                )}
            </section>

            {profile.isProfileModalOpen && (
                <div className={`modal-overlay ${closingModal === "profile" ? "closing" : ""}`} onClick={() => closeModalWithAnim("profile", () => profile.setIsProfileModalOpen(false))}>
                    <div className="modal-card profile-modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Profile</h3>
                        <div className="profile-modal-list">
                            {profile.isProfileLoading ? (
                                <div className="skeleton-profile">
                                    <div className="skeleton-profile-avatar-wrap">
                                        <div className="skeleton skeleton-profile-avatar" />
                                    </div>
                                    {[75, 55, 80, 60].map((w, i) => (
                                        <div key={i} className="skeleton-profile-row">
                                            <div className="skeleton skeleton-profile-label" />
                                            <div className="skeleton skeleton-profile-value" style={{ width: `${w}%` }} />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <>
                                    <div className="profile-avatar-block">
                                        <div className="profile-avatar-preview-wrap">
                                            {profile.profileAvatarUrl ? (
                                                profile.isSelfProfile ? (
                                                    <button
                                                        type="button"
                                                        className="profile-avatar-preview-btn"
                                                        onClick={profile.openAvatarPreview}
                                                        aria-label="Open avatar preview"
                                                        title="Open avatar"
                                                    >
                                                        <img
                                                            src={profile.profileAvatarUrl}
                                                            alt="Current avatar"
                                                            className="profile-avatar-preview"
                                                            onError={() => setAvatarUrl("")}
                                                        />
                                                    </button>
                                                ) : (
                                                    <img
                                                        src={profile.profileAvatarUrl}
                                                        alt="User avatar"
                                                        className="profile-avatar-preview"
                                                    />
                                                )
                                            ) : (
                                                <div className="profile-avatar-fallback">{profile.profileInitial}</div>
                                            )}
                                        </div>

                                        {profile.isSelfProfile ? (
                                            <div className="profile-avatar-actions">
                                                <input
                                                    ref={avatarInputRef}
                                                    type="file"
                                                    accept="image/png,image/jpeg,image/webp"
                                                    onChange={(e) => void profile.handleAvatarChange(e)}
                                                    style={{ display: "none" }}
                                                />
                                                <button
                                                    className="modal-btn modal-btn-primary"
                                                    type="button"
                                                    onClick={profile.openAvatarPicker}
                                                    disabled={profile.isAvatarUploading}
                                                >
                                                    {profile.isAvatarUploading ? "Uploading..." : "Change avatar"}
                                                </button>
                                            </div>
                                        ) : null}

                                        {profile.selectedProfileError ? <div className="profile-avatar-error">{profile.selectedProfileError}</div> : null}
                                        {profile.profileUpdateError ? <div className="profile-avatar-error">{profile.profileUpdateError}</div> : null}
                                        {profile.isSelfProfile && profile.avatarError ? <div className="profile-avatar-error">{profile.avatarError}</div> : null}
                                    </div>

                                    <div className="profile-modal-row">
                                        <span className="profile-modal-label">First name</span>
                                        <span className="profile-modal-value">{profile.profileFirstName || "-"}</span>
                                    </div>
                                    <div className="profile-modal-row">
                                        <span className="profile-modal-label">Last name</span>
                                        <span className="profile-modal-value">{profile.profileLastName || "-"}</span>
                                    </div>
                                    <div className="profile-modal-row">
                                        <span className="profile-modal-label">Nickname</span>
                                        {profile.isSelfProfile ? (
                                            <input
                                                className="modal-input"
                                                type="text"
                                                value={profile.nicknameDraft}
                                                onChange={(e) => profile.setNicknameDraft(e.target.value)}
                                                maxLength={48}
                                                placeholder="Enter nickname"
                                                disabled={profile.isSavingNickname}
                                            />
                                        ) : (
                                            <span className="profile-modal-value">{profile.profileNickname || "-"}</span>
                                        )}
                                    </div>
                                    {profile.isSelfProfile ? (
                                        <div className="profile-modal-row">
                                            <span className="profile-modal-label">Email</span>
                                            <span className="profile-modal-value">{currentUserProfile?.email || "-"}</span>
                                        </div>
                                    ) : null}
                                    <div className="profile-modal-row">
                                        <span className="profile-modal-label">Name</span>
                                        <span className="profile-modal-value">{profile.profileDisplayName || "-"}</span>
                                    </div>
                                    {profile.isSelfProfile ? (
                                        <div className="profile-modal-row">
                                            <span className="profile-modal-label">Theme</span>
                                            <button
                                                className="theme-toggle-btn"
                                                type="button"
                                                onClick={toggleTheme}
                                                aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                                                title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                                            >
                                                {theme === "light" ? <Moon size={18} aria-hidden="true"/> : <Sun size={18} aria-hidden="true"/>}
                                            </button>
                                        </div>
                                    ) : null}
                                    {profile.isSelfProfile ? (
                                        <div className="profile-modal-row">
                                            <span className="profile-modal-label">Notifications</span>
                                            <button
                                                className="modal-btn modal-btn-secondary"
                                                type="button"
                                                onClick={() => setIsNotificationSettingsOpen(true)}
                                            >
                                                <Bell size={16} aria-hidden="true" /> Settings
                                            </button>
                                        </div>
                                    ) : null}
                                </>
                            )}
                        </div>
                        {profile.isSelfProfile && profile.isDeleteAccountConfirmOpen ? (
                            <div className="delete-account-confirm">
                                <div className="delete-account-warning">
                                    This permanently deletes your account. Enter your password to confirm.
                                </div>
                                <input
                                    className="modal-input"
                                    type="password"
                                    value={profile.deletePasswordDraft}
                                    onChange={(e) => profile.setDeletePasswordDraft(e.target.value)}
                                    placeholder="Password"
                                    disabled={profile.isDeletingAccount}
                                    autoFocus
                                />
                                {profile.deleteAccountError ? <div className="profile-avatar-error">{profile.deleteAccountError}</div> : null}
                                <div className="delete-account-confirm-actions">
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        type="button"
                                        onClick={() => {
                                            profile.setIsDeleteAccountConfirmOpen(false);
                                            profile.setDeletePasswordDraft("");
                                        }}
                                        disabled={profile.isDeletingAccount}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        className="modal-btn modal-btn-danger"
                                        type="button"
                                        onClick={() => void profile.handleDeleteAccount()}
                                        disabled={profile.isDeletingAccount}
                                    >
                                        {profile.isDeletingAccount ? "Deleting..." : "Delete account"}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        <div className="modal-actions">
                            {profile.isSelfProfile ? (
                                <>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        onClick={() => void profile.handleSaveNickname()}
                                        type="button"
                                        disabled={profile.isSavingNickname}
                                    >
                                        {profile.isSavingNickname ? "Saving..." : "Save"}
                                    </button>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        onClick={profile.handleLogout}
                                        type="button"
                                    >
                                        Logout
                                    </button>
                                    {!profile.isDeleteAccountConfirmOpen ? (
                                        <button
                                            className="modal-btn modal-btn-danger"
                                            type="button"
                                            onClick={() => profile.setIsDeleteAccountConfirmOpen(true)}
                                            disabled={profile.isSavingNickname || profile.isDeletingAccount}
                                        >
                                            Delete account
                                        </button>
                                    ) : null}
                                </>
                            ) : null}
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={() => closeModalWithAnim("profile", () => profile.setIsProfileModalOpen(false))}
                                type="button"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {profile.isAvatarPreviewOpen && avatarUrl && (
                <div className={`avatar-viewer-overlay ${closingModal === "avatarViewer" ? "closing" : ""}`} onClick={profile.closeAvatarPreview}>
                    <div className="avatar-viewer-content" onClick={(e) => e.stopPropagation()}>
                        <img
                            src={avatarUrl}
                            alt="Avatar full size"
                            className="avatar-viewer-image"
                            onError={profile.closeAvatarPreview}
                        />
                        <button
                            type="button"
                            className="avatar-viewer-close"
                            onClick={profile.closeAvatarPreview}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {servers.isCreateServerModalOpen && (
                <div className={`modal-overlay ${closingModal === "createServer" ? "closing" : ""}`} onClick={() => closeModalWithAnim("createServer", () => servers.setIsCreateServerModalOpen(false))}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Create server</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Enter server name"
                            value={servers.newServerName}
                            onChange={(e) => servers.setNewServerName(e.target.value)}
                            maxLength={servers.MAX_SERVER_CHANNEL_NAME_LENGTH}
                            autoFocus
                        />

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => closeModalWithAnim("createServer", () => servers.setIsCreateServerModalOpen(false))}
                                disabled={servers.isCreatingServer}
                            >
                                Cancel
                            </button>
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={() => void servers.handleAddServerSubmit()}
                                disabled={servers.isCreatingServer}
                            >
                                {servers.isCreatingServer ? "Creating..." : "Create"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {servers.isJoinModalOpen && (
                <div className={`modal-overlay ${closingModal === "join" ? "closing" : ""}`} onClick={() => closeModalWithAnim("join", () => servers.setIsJoinModalOpen(false))}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Join server</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Search by server name"
                            value={servers.joinQuery}
                            onChange={(e) => servers.setJoinQuery(e.target.value)}
                            maxLength={64}
                            autoFocus
                        />

                        {servers.isSearchingServers ? <div className="messages-empty">Searching...</div> : null}

                        {!servers.isSearchingServers && servers.joinQuery.trim().length >= 2 && !servers.joinResults.length ? (
                            <div className="messages-empty">No servers found</div>
                        ) : null}

                        {!servers.isSearchingServers && servers.joinResults.length > 0 ? (
                            <ul className="channels-list">
                                {servers.joinResults.map((server) => (
                                    <li key={server.id}>
                                        <button className="channel-row"
                                                onClick={() => void servers.handleJoinServer(server.id)}>
                                            Join {server.name}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => closeModalWithAnim("join", () => servers.setIsJoinModalOpen(false))}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {servers.isCreateChannelModalOpen && (
                <div className={`modal-overlay ${closingModal === "createChannel" ? "closing" : ""}`} onClick={() => closeModalWithAnim("createChannel", () => servers.setIsCreateChannelModalOpen(false))}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Create channel</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Enter channel name"
                            value={servers.newChannelName}
                            onChange={(e) => servers.setNewChannelName(e.target.value)}
                            maxLength={servers.MAX_SERVER_CHANNEL_NAME_LENGTH}
                            autoFocus
                        />
                        <select
                            className="modal-input"
                            value={servers.newChannelType}
                            onChange={(e) => servers.setNewChannelType(e.target.value === "voice" ? "voice" : "text")}
                        >
                            <option value="text">Text</option>
                            <option value="voice">Voice</option>
                        </select>

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => closeModalWithAnim("createChannel", () => servers.setIsCreateChannelModalOpen(false))}
                                disabled={servers.isCreatingChannel}
                            >
                                Cancel
                            </button>
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={() => void servers.handleAddChannelSubmit()}
                                disabled={servers.isCreatingChannel}
                            >
                                {servers.isCreatingChannel ? "Creating..." : "Create"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isNotificationSettingsOpen && (
                <NotificationSettingsModal
                    onClose={() => setIsNotificationSettingsOpen(false)}
                    settings={notificationSettings.settings}
                    isLoading={notificationSettings.isLoading}
                    error={notificationSettings.error}
                    updateGlobal={notificationSettings.updateGlobal}
                    updateServer={notificationSettings.updateServer}
                    updateChannel={notificationSettings.updateChannel}
                    servers={servers.servers}
                    channelsByServer={servers.channelsByServer}
                    permission={notificationPermission}
                    onRequestPermission={() => void handleEnableNotifications()}
                />
            )}

            {notificationMenu.menu && (
                <ContextMenu
                    x={notificationMenu.menu.x}
                    y={notificationMenu.menu.y}
                    items={notificationMenu.menu.items}
                    onClose={notificationMenu.closeMenu}
                />
            )}
        </div>
    );
}
