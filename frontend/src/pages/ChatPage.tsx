import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {Search, Trash2, Mic, MicOff, Camera, CameraOff, Monitor, MonitorOff, RefreshCw, PanelLeftClose, PanelLeftOpen, Volume2, VolumeOff, Hash, Sun, Moon, Menu} from "lucide-react";
import {useMediaQuery} from "../hooks/useMediaQuery";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import VideoTile from "../components/VideoTile.tsx";
import API from "../api";
import { extractApiError } from "../services/apiError";
import {ChatSocket} from "../services/chatSocket.ts";
import {CallClient} from "../services/callClient.ts";
import {clearAuthStorage, getCurrentUserId, getCurrentUserProfile} from "../services/authToken.ts";
import type {CurrentUserProfile} from "../services/authToken.ts";
import type {
    ChannelsByServer,
    Message,
    MessagesByChannel,
    OnlineUser,
    Server,
    UserProfile,
    VoiceParticipant,
    VoiceParticipantsByChannel,
} from "../types/chat.ts";
import {getMyAvatarUrl, uploadMyAvatar} from "../services/avatarApi.ts";
import {playJoinSound, playLeaveSound} from "../services/sounds.ts";
import "../styles/chat.css";

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";
const VOICE_VOLUME_KEY = "voice_volume_by_user";
const COLOR_THEME_KEY = "color_theme";
type ColorTheme = "dark" | "light";
const MAX_SERVER_CHANNEL_NAME_LENGTH = 16;
const MAX_AVATAR_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// function getNextNumericName(items: Array<{ name: string }>, fallback = 1): string {
//   const numericNames = items.map((item) => Number(item.name)).filter((value) => Number.isInteger(value) && value > 0);
//
//   if (!numericNames.length) return String(fallback);
//
//   return String(Math.max(...numericNames) + 1);
// }

export default function ChatPage() {
    const navigate = useNavigate();
    const socketRef = useRef<ChatSocket | null>(null);
    const callClientRef = useRef<CallClient | null>(null);
    const selectedServerIdRef = useRef(0);
    const joinSearchRequestIdRef = useRef(0);
    const chatContentRef = useRef<HTMLDivElement | null>(null);
    const isCreatingServerRef = useRef(false);
    const [isCreatingServer, setIsCreatingServer] = useState(false);
    const isCreatingChannelRef = useRef(false);
    const [isCreatingChannel, setIsCreatingChannel] = useState(false);
    const [isSearchingServers, setIsSearchingServers] = useState(false);
    const [isChannelsSidebarHidden, setIsChannelsSidebarHidden] = useState(false);
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
    const avatarInputRef = useRef<HTMLInputElement | null>(null);
    const [avatarUrl, setAvatarUrl] = useState("")
    const [isOnlinePanelOpen, setIsOnlinePanelOpen] = useState(false);
    const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
    const [isOnlineUsersLoading, setIsOnlineUsersLoading] = useState(false);
    const [servers, setServers] = useState<Server[]>([]);
    const [channelsByServer, setChannelsByServer] = useState<ChannelsByServer>({});
    const [voiceParticipantsByChannel, setVoiceParticipantsByChannel] = useState<VoiceParticipantsByChannel>({});
    const [selectedServerId, setSelectedServerId] = useState<number>(0);
    const [selectedChannelId, setSelectedChannelId] = useState<number>(0);
    const [messagesByChannel, setMessagesByChannel] = useState<MessagesByChannel>({});
    const [loadedChannels, setLoadedChannels] = useState<Record<number, boolean>>({});
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState("");
    const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
    const [newServerName, setNewServerName] = useState("");
    const [isCreateChannelModalOpen, setIsCreateChannelModalOpen] = useState(false);
    const [newChannelName, setNewChannelName] = useState("");
    const [newChannelType, setNewChannelType] = useState<"text" | "voice">("text");
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isAvatarPreviewOpen, setIsAvatarPreviewOpen] = useState(false);
    const [voiceChannelId, setVoiceChannelId] = useState(0);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<Array<{
        userId: number;
        label: string;
        stream: MediaStream
    }>>([]);
    const [selectedProfileUserId, setSelectedProfileUserId] = useState<number | null>(null);
    const [selectedProfile, setSelectedProfile] = useState<UserProfile | null>(null);
    const [selectedProfileError, setSelectedProfileError] = useState("");
    const [isProfileLoading, setIsProfileLoading] = useState(false);
    const [nicknameDraft, setNicknameDraft] = useState("");
    const [profileUpdateError, setProfileUpdateError] = useState("");
    const [isSavingNickname, setIsSavingNickname] = useState(false);
    const [isDeleteAccountConfirmOpen, setIsDeleteAccountConfirmOpen] = useState(false);
    const [deletePasswordDraft, setDeletePasswordDraft] = useState("");
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [deleteAccountError, setDeleteAccountError] = useState("");
    const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isTogglingScreenShare, setIsTogglingScreenShare] = useState(false);
    const [isDeafened, setIsDeafened] = useState(false);
    const [isMicEnabled, setIsMicEnabled] = useState(true);
    const [isCameraEnabled, setIsCameraEnabled] = useState(true);
    const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
    const [voiceVolumeByUserId, setVoiceVolumeByUserId] = useState<Record<number, number>>(() => {
        try {
            const stored = localStorage.getItem(VOICE_VOLUME_KEY);
            if (!stored) return {};
            const parsed = JSON.parse(stored) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
            const result: Record<number, number> = {};
            for (const [k, v] of Object.entries(parsed)) {
                const id = Number(k);
                const vol = Number(v);
                if (Number.isFinite(id) && id > 0 && Number.isFinite(vol) && vol >= 0 && vol <= 2) {
                    result[id] = vol;
                }
            }
            return result;
        } catch {
            return {};
        }
    });
    const [activeVolumeUserId, setActiveVolumeUserId] = useState<number | null>(null);
    const [theme, setTheme] = useState<ColorTheme>(() => {
        try {
            return localStorage.getItem(COLOR_THEME_KEY) === "light" ? "light" : "dark";
        } catch {
            return "dark";
        }
    });
    const micBeforeDeafenRef = useRef(true);
    const [currentUserProfile, setCurrentUserProfile] = useState<CurrentUserProfile | null>(
        () => getCurrentUserProfile(),
    );
    const currentUserId: number | null = getCurrentUserId();
    const isMobileDevice = useMediaQuery("(max-width: 1024px) and (pointer: coarse)");
    const isPhone = useMediaQuery("(max-width: 768px)");
    const [isChannelsDrawerOpen, setIsChannelsDrawerOpen] = useState(false);
    const [isPageVisible, setIsPageVisible] = useState(true);
    const [joinQuery, setJoinQuery] = useState("");
    const [joinResults, setJoinResults] = useState<Array<{ id: number; name: string }>>([]);
    const [avatarError, setAvatarError] = useState("");
    const [isAvatarUploading, setIsAvatarUploading] = useState(false);
    const toParticipantLabel = useCallback((participant: VoiceParticipant): string => {
        const nickname = participant.nickname?.trim();
        if (nickname) {
            return nickname;
        }
        const fullName = [participant.first_name, participant.last_name].filter(Boolean).join(" ").trim();
        if (fullName) {
            return fullName;
        }
        return `User ${participant.user_id}`;
    }, []);

    const handleAuthFailure = useCallback(
        (message: string): void => {
            clearAuthStorage();
            setError(message);
            navigate("/login", {replace: true});
        },
        [navigate],
    );

    const loadAvatar = useCallback(async () => {
        const url = await getMyAvatarUrl();
        setAvatarUrl(url ?? "");
    }, []);

    const openSelfProfile = useCallback(() => {
        setSelectedProfileUserId(null);
        setSelectedProfile(null);
        setSelectedProfileError("");
        setProfileUpdateError("");
        setIsProfileLoading(false);
        setDeleteAccountError("");
        setIsDeleteAccountConfirmOpen(false);
        setDeletePasswordDraft("");
        setIsAvatarPreviewOpen(false);
        setNicknameDraft(currentUserProfile?.nickname ?? "");
        setIsProfileModalOpen(true);
    }, [currentUserProfile?.nickname]);

    async function handleSaveNickname(): Promise<void> {
        if (!currentUserProfile) {
            setProfileUpdateError("Profile not loaded");
            return;
        }
        const firstName = profileFirstName?.trim() ?? "";
        const lastName = profileLastName?.trim() ?? "";
        const nickname = nicknameDraft.trim();
        if (!firstName || !lastName || !nickname) {
            setProfileUpdateError("First name, last name, and nickname are required");
            return;
        }
        if (nickname.length < 5) {
            setProfileUpdateError("Nickname must be at least 5 characters long");
            return;
        }
        if (isSavingNickname) {
            return;
        }
        setIsSavingNickname(true);
        setProfileUpdateError("");
        try {
            await API.post("/updateUser", {
                first_name: firstName,
                last_name: lastName,
                nickname,
            });
            const nextProfile: CurrentUserProfile = {
                ...currentUserProfile,
                first_name: firstName,
                last_name: lastName,
                nickname,
            };
            localStorage.setItem("current_user", JSON.stringify(nextProfile));
            setCurrentUserProfile(nextProfile);
            setNicknameDraft(nickname);
        } catch (err) {
            setProfileUpdateError(extractApiError(err, "Failed to update profile"));
        } finally {
            setIsSavingNickname(false);
        }
    }

    const refreshOnlineUsers = useCallback(async () => {
        if (!socketRef.current || !isConnected || selectedServerId <= 0) {
            setOnlineUsers([]);
            return;
        }

        try {
            setIsOnlineUsersLoading(true);
            const users = await socketRef.current.getUsersOnline(selectedServerId);
            const currentEmail = currentUserProfile?.email?.trim().toLowerCase();
            const currentNickname = currentUserProfile?.nickname?.trim();
            const normalizedUsers = users.map((user) => {
                if (user.nickname?.trim()) {
                    return user;
                }
                const userEmail = user.email?.trim().toLowerCase();
                if (currentEmail && currentNickname && userEmail === currentEmail) {
                    return { ...user, nickname: currentNickname };
                }
                return user;
            });
            setOnlineUsers(normalizedUsers);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load online users";
            setError(message);
        } finally {
            setIsOnlineUsersLoading(false);
        }
    }, [isConnected, selectedServerId, currentUserProfile?.email, currentUserProfile?.nickname]);

    const syncServersAndChannels = useCallback(
        async (preferredServerId?: number) => {
            if (!socketRef.current) {
                return;
            }

            const remoteServers = await socketRef.current.getServers();
            if (!remoteServers.length) {
                setServers([]);
                setChannelsByServer({});
                setVoiceParticipantsByChannel({});
                setSelectedServerId(0);
                setSelectedChannelId(0);
                setMessagesByChannel({});
                localStorage.setItem(CHAT_SERVERS_KEY, JSON.stringify([]));
                localStorage.setItem(CHAT_CHANNELS_BY_SERVER_KEY, JSON.stringify({}));
                localStorage.removeItem(CHAT_SELECTED_SERVER_KEY);
                return;
            }

            const channelsStateByServerEntries = await Promise.all(
                remoteServers.map(async (server) => {
                    const state = await socketRef.current!.getServerChannelsState(server.id);
                    return [server.id, state] as const;
                }),
            );

            const remoteChannelsByServer = Object.fromEntries(
                channelsStateByServerEntries.map(([serverId, state]) => [serverId, state.channels]),
            ) as ChannelsByServer;
            const validChannelIds = new Set(
                Object.values(remoteChannelsByServer)
                    .flat()
                    .map((channel) => channel.id),
            );
            const nextVoiceParticipantsByChannel: VoiceParticipantsByChannel = {};
            channelsStateByServerEntries.forEach(([, state]) => {
                state.voice_participants.forEach((entry) => {
                    if (validChannelIds.has(entry.channel_id)) {
                        nextVoiceParticipantsByChannel[entry.channel_id] = entry.participants;
                    }
                });
            });

            const fromState = selectedServerIdRef.current;
            const activeServerId =
                (preferredServerId && remoteServers.some((server) => server.id === preferredServerId) && preferredServerId) ||
                (fromState > 0 && remoteServers.some((server) => server.id === fromState) && fromState) ||
                remoteServers[0].id;

            const activeChannels = remoteChannelsByServer[activeServerId] ?? [];

            setServers(remoteServers);
            setChannelsByServer(remoteChannelsByServer);
            setVoiceParticipantsByChannel(nextVoiceParticipantsByChannel);
            setSelectedServerId(activeServerId);
            setSelectedChannelId((prev) => {
                if (activeChannels.some((channel) => channel.id === prev)) {
                    return prev;
                }
                return activeChannels[0]?.id ?? 0;
            });
            setMessagesByChannel((prev) => {
                const next = {...prev};
                Object.values(remoteChannelsByServer)
                    .flat()
                    .forEach((channel) => {
                        if (!next[channel.id]) {
                            next[channel.id] = [];
                        }
                    });
                return next;
            });

            localStorage.setItem(CHAT_SERVERS_KEY, JSON.stringify(remoteServers));
            localStorage.setItem(CHAT_CHANNELS_BY_SERVER_KEY, JSON.stringify(remoteChannelsByServer));
            localStorage.setItem(CHAT_SELECTED_SERVER_KEY, String(activeServerId));
        },
        [],
    );

    useEffect(() => {
        const socket = new ChatSocket();
        socketRef.current = socket;

        if (currentUserId && currentUserId > 0) {
            callClientRef.current = new CallClient(
                socket,
                currentUserId,
                (participant, stream) => {
                    const label = toParticipantLabel(participant);
                    setRemoteStreams((prev) => {
                        const next = prev.filter((item) => item.userId !== participant.user_id);
                        next.push({userId: participant.user_id, label, stream});
                        return next;
                    });
                    setVoiceVolumeByUserId((prev) => {
                        if (participant.user_id in prev) {
                            return prev;
                        }
                        return { ...prev, [participant.user_id]: 1 };
                    });
                },
                (userId) => {
                    setRemoteStreams((prev) => prev.filter((item) => item.userId !== userId));
                },
                (stream) => {
                    setLocalStream(stream);
                    const hasVideoTrack = Boolean(stream?.getVideoTracks()[0]);
                    const isVideoEnabled = stream?.getVideoTracks()[0]?.enabled ?? false;
                    setIsCameraEnabled(hasVideoTrack && isVideoEnabled);
                    setIsScreenSharing(callClientRef.current?.isScreenShareActive() ?? false);
                    if (!stream) {
                        setRemoteStreams([]);
                        setIsSwitchingCamera(false);
                        setIsTogglingScreenShare(false);
                    }
                },
                (message) => setError(message),
            );
        }

        const unsubscribeMessage = socket.onMessage((incoming) => {
            setMessagesByChannel((prev) => ({
                ...prev,
                [incoming.channel_id]: [...(prev[incoming.channel_id] ?? []), incoming],
            }));

            // Keep UI in sync if server sends message from a channel not present in local cache.
            setChannelsByServer((prev) => {
                const hasChannel = Object.values(prev).some((list) => list.some((channel) => channel.id === incoming.channel_id));
                if (hasChannel || selectedServerIdRef.current <= 0) {
                    return prev;
                }

                const current = prev[selectedServerIdRef.current] ?? [];
                return {
                    ...prev,
                    [selectedServerIdRef.current]: [
                        ...current,
                        {
                            id: incoming.channel_id,
                            server_id: selectedServerIdRef.current,
                            name: String(incoming.channel_id),
                            type: "text",
                        },
                    ],
                };
            });
        });

        const unsubscribeError = socket.onError((text) => {
            if (text.toLowerCase().includes("permission denied")) {
                handleAuthFailure("Timed out, try again later");
                return;
            }
            setError(text);
        });

        const unsubscribeVoiceUserJoined = socket.onVoiceUserJoined((event) => {
            setVoiceParticipantsByChannel((prev) => {
                const current = prev[event.channel_id] ?? [];
                if (current.some((participant) => participant.user_id === event.user.user_id)) {
                    return prev;
                }

                return {
                    ...prev,
                    [event.channel_id]: [...current, event.user],
                };
            });
        });

        const unsubscribeVoiceUserLeft = socket.onVoiceUserLeft((event) => {
            setVoiceParticipantsByChannel((prev) => {
                const current = prev[event.channel_id] ?? [];
                if (!current.length) {
                    return prev;
                }

                const next = current.filter((participant) => participant.user_id !== event.user.user_id);
                if (next.length === current.length) {
                    return prev;
                }

                if (!next.length) {
                    const rest = {...prev};
                    delete rest[event.channel_id];
                    return rest;
                }

                return {
                    ...prev,
                    [event.channel_id]: next,
                };
            });
        });

        const unsubscribeVoiceStatusChanged = socket.onVoiceStatusChanged((event) => {
            setVoiceParticipantsByChannel((prev) => {
                const current = prev[event.channel_id] ?? [];
                if (!current.length) {
                    return prev;
                }

                const index = current.findIndex((participant) => participant.user_id === event.user.user_id);
                if (index === -1) {
                    return prev;
                }

                const next = [...current];
                next[index] = {
                    ...current[index],
                    ...event.user,
                };

                return {
                    ...prev,
                    [event.channel_id]: next,
                };
            });
        });

        (async () => {
            try {
                await socket.connect();
                setIsConnected(true);
                setError("");

                const persistedSelectedServer = Number(localStorage.getItem(CHAT_SELECTED_SERVER_KEY) ?? "0");
                await syncServersAndChannels(persistedSelectedServer > 0 ? persistedSelectedServer : undefined);
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to connect to chat";
                if (
                    message.toLowerCase().includes("re-entry required") ||
                    message.toLowerCase().includes("re-login required") ||
                    message.toLowerCase().includes("permission denied")
                ) {
                    handleAuthFailure("Session expired, please log in again");
                    return;
                }
                setError(message);
            }
        })();

        return () => {
            unsubscribeMessage();
            unsubscribeError();
            unsubscribeVoiceUserJoined();
            unsubscribeVoiceUserLeft();
            unsubscribeVoiceStatusChanged();
            callClientRef.current?.dispose();
            callClientRef.current = null;
            socketRef.current?.close();
            socketRef.current = null;
            setIsConnected(false);
        };
    }, [navigate, handleAuthFailure, syncServersAndChannels, currentUserId, toParticipantLabel]);

    useEffect(() => {
        if (!isConnected || !socketRef.current || !isPageVisible) {
            return;
        }

        const intervalId = window.setInterval(() => {
            void syncServersAndChannels();
        }, 3000);

        return () => window.clearInterval(intervalId);
    }, [isConnected, syncServersAndChannels, isPageVisible]);

    useEffect(() => {
        localStorage.setItem(CHAT_SERVERS_KEY, JSON.stringify(servers));
    }, [servers]);

    useEffect(() => {
        localStorage.setItem(CHAT_CHANNELS_BY_SERVER_KEY, JSON.stringify(channelsByServer));
    }, [channelsByServer]);

    useEffect(() => {
        if (selectedServerId > 0) {
            localStorage.setItem(CHAT_SELECTED_SERVER_KEY, String(selectedServerId));
        }
        selectedServerIdRef.current = selectedServerId;
    }, [selectedServerId]);

    useEffect(() => {
        try {
            localStorage.setItem(VOICE_VOLUME_KEY, JSON.stringify(voiceVolumeByUserId));
        } catch {
            // ignore quota or security errors
        }
    }, [voiceVolumeByUserId]);

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        try {
            localStorage.setItem(COLOR_THEME_KEY, theme);
        } catch {
            // ignore quota or security errors
        }
    }, [theme]);

    useEffect(() => {
        if (!isConnected || selectedServerId <= 0) {
            setOnlineUsers([]);
            setIsOnlinePanelOpen(false);
            return;
        }

        if (!isPageVisible) return;

        void refreshOnlineUsers();

        const intervalId = window.setInterval(() => {
            void refreshOnlineUsers();
        }, 10000);

        return () => window.clearInterval(intervalId);
    }, [isConnected, selectedServerId, refreshOnlineUsers, isPageVisible]);

    useEffect(() => {
        void loadAvatar();
    }, [loadAvatar]);

    useEffect(() => {
        const handler = () => setIsPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
    }, []);

    useEffect(() => {
        if (!isJoinModalOpen) {
            setJoinResults([]);
            setIsSearchingServers(false);
            return;
        }

        const socket = socketRef.current;
        if (!socket || !isConnected) {
            setJoinResults([]);
            setIsSearchingServers(false);
            return;
        }

        const query = joinQuery.trim();
        if (query.length < 2) {
            setJoinResults([]);
            setIsSearchingServers(false);
            return;
        }

        setIsSearchingServers(true);

        const timeoutId = window.setTimeout(() => {
            const requestId = ++joinSearchRequestIdRef.current;

            void socket.searchServers(query, 20)
                .then((results) => {
                    if (requestId !== joinSearchRequestIdRef.current) {
                        return;
                    }
                    setJoinResults(results);
                    setError("");
                })
                .catch((err: unknown) => {
                    if (requestId !== joinSearchRequestIdRef.current) {
                        return;
                    }

                    const message = err instanceof Error ? err.message : "Failed to search servers";
                    setError(message);
                    setJoinResults([]);
                })
                .finally(() => {
                    if (requestId === joinSearchRequestIdRef.current) {
                        setIsSearchingServers(false);
                    }
                });
        }, 350);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [joinQuery, isJoinModalOpen, isConnected]);

    useEffect(() => {
        if (selectedChannelId <= 0 || !socketRef.current || !isConnected || loadedChannels[selectedChannelId]) {
            return;
        }

        (async () => {
            try {
                const data = await socketRef.current?.getMessages(selectedChannelId);
                setMessagesByChannel((prev) => ({
                    ...prev,
                    [selectedChannelId]: data ?? [],
                }));
                setLoadedChannels((prev) => ({...prev, [selectedChannelId]: true}));
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to load messages";
                setError(message);
            }
        })();
    }, [selectedChannelId, isConnected, loadedChannels]);

    useEffect(() => {
        if (selectedChannelId <= 0 || !socketRef.current || !isConnected || !isPageVisible) {
            return;
        }

        const intervalId = window.setInterval(() => {
            const socket = socketRef.current;
            if (!socket) return;

            void socket.getMessages(selectedChannelId).then((data) => {
                if (!data) return;
                setMessagesByChannel((prev) => {
                    const prevMessages = prev[selectedChannelId];
                    if (prevMessages && prevMessages.length === data.length && prevMessages.every((m, i) => m.id === data[i].id)) {
                        return prev;
                    }
                    return { ...prev, [selectedChannelId]: data };
                });
            }).catch(() => {});
        }, 5000);

        return () => window.clearInterval(intervalId);
    }, [selectedChannelId, isConnected, isPageVisible]);

    function openCreateServerModal() {
        setError("");
        setNewServerName("");
        setIsCreateServerModalOpen(true);
    }

    function openJoinServerModal() {
        setError("");
        setJoinQuery("");
        setJoinResults([]);
        setIsJoinModalOpen(true);
    }

    function openCreateChannelModal() {
        setError("");
        setNewChannelName("");
        setNewChannelType("text");
        setIsCreateChannelModalOpen(true);
    }

    async function handleAddServerSubmit() {
        if (!socketRef.current || !isConnected) {
            setError("No connection");
            return;
        }

        const trimmedName = newServerName.trim();
        if (!trimmedName) {
            setError("Enter the server name");
            return;
        }
        if ([...trimmedName].length > MAX_SERVER_CHANNEL_NAME_LENGTH) {
            setError(`Server name must be at most ${MAX_SERVER_CHANNEL_NAME_LENGTH} characters`);
            return;
        }

        if (isCreatingServerRef.current) {
            return;
        }

        isCreatingServerRef.current = true;
        setIsCreatingServer(true);

        try {
            const createdServer = await socketRef.current.createServer(trimmedName);
            await socketRef.current.createChannel(createdServer.server_id, "Main", "text");
            await socketRef.current.createChannel(createdServer.server_id, "Voice", "voice");

            await syncServersAndChannels(createdServer.server_id);
            setError("");
            setIsCreateServerModalOpen(false);
            setNewServerName("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to create server";
            setError(message);
        } finally {
            isCreatingServerRef.current = false;
            setIsCreatingServer(false);
        }
    }

    async function handleAddChannelSubmit() {
        if (!socketRef.current || !isConnected || selectedServerId <= 0) {
            setError("No connection to chat");
            return;
        }

        const trimmedName = newChannelName.trim();
        if (!trimmedName) {
            setError("Enter the channel name");
            return;
        }
        if ([...trimmedName].length > MAX_SERVER_CHANNEL_NAME_LENGTH) {
            setError(`Channel name must be at most ${MAX_SERVER_CHANNEL_NAME_LENGTH} characters`);
            return;
        }

        if (isCreatingChannelRef.current) {
            return;
        }

        isCreatingChannelRef.current = true;
        setIsCreatingChannel(true);

        try {
            // const currentChannels = channelsByServer[selectedServerId] ?? [];
            await socketRef.current.createChannel(selectedServerId, trimmedName, newChannelType);

            await syncServersAndChannels(selectedServerId);
            setError("");
            setIsCreateChannelModalOpen(false);
            setNewChannelName("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to create channel";
            setError(message);
        } finally {
            isCreatingChannelRef.current = false;
            setIsCreatingChannel(false);
        }
    }

    async function handleDeleteMessage(messageId: number, channelId: number): Promise<void> {
        if (!socketRef.current || !isConnected) {
            setError("No connection");
            return;
        }

        setMessagesByChannel((prev) => {
            const channelMessages = prev[channelId];
            if (!channelMessages) return prev;
            const next = channelMessages.filter((m) => m.id !== messageId);
            if (next.length === channelMessages.length) return prev;
            return { ...prev, [channelId]: next };
        });

        try {
            await socketRef.current.deleteMessage(messageId);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete message";
            setError(message);
            const socket = socketRef.current;
            if (socket) {
                try {
                    const data = await socket.getMessages(channelId);
                    setMessagesByChannel((prev) => ({
                        ...prev,
                        [channelId]: data ?? [],
                    }));
                } catch {
                    // best-effort rollback
                }
            }
        }
    }

    async function handleSend(text: string, attachmentIds?: number[], replyToId?: number | null) {
        if (!socketRef.current || !isConnected || selectedChannelId <= 0) {
            return;
        }

        try {
            setError("");
            await socketRef.current.sendMessage(selectedChannelId, text, attachmentIds, replyToId);
            setReplyToMessage(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to send message";
            setError(message);
        }
    }

    async function handleSelectServer(serverId: number) {
        setSelectedServerId(serverId);
        setError("");

        if (!socketRef.current || !isConnected) {
            const serverChannels = channelsByServer[serverId] ?? [];
            setSelectedChannelId(serverChannels[0]?.id ?? 0);
            return;
        }

        try {
            await syncServersAndChannels(serverId);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load channels";
            setError(message);
        }
    }

    function handleLogout() {
        callClientRef.current?.dispose();
        callClientRef.current = null;
        socketRef.current?.close();
        socketRef.current = null;

        clearAuthStorage();

        localStorage.removeItem("chat_servers");
        localStorage.removeItem("chat_channels_by_server");
        localStorage.removeItem("chat_selected_server_id");

        setIsProfileModalOpen(false);

        navigate("/login", {replace: true});
    }

    async function handleDeleteAccount(): Promise<void> {
        const password = deletePasswordDraft;
        if (!password) {
            setDeleteAccountError("Enter your password to confirm");
            return;
        }
        if (isDeletingAccount) {
            return;
        }
        setIsDeletingAccount(true);
        setDeleteAccountError("");
        try {
            await API.delete("/deleteUser", { data: { password } });
            callClientRef.current?.dispose();
            callClientRef.current = null;
            socketRef.current?.close();
            socketRef.current = null;
            clearAuthStorage();
            localStorage.removeItem(CHAT_SERVERS_KEY);
            localStorage.removeItem(CHAT_CHANNELS_BY_SERVER_KEY);
            localStorage.removeItem(CHAT_SELECTED_SERVER_KEY);
            setIsProfileModalOpen(false);
            navigate("/login", {replace: true});
        } catch (err) {
            setDeleteAccountError(extractApiError(err, "Failed to delete account"));
        } finally {
            setIsDeletingAccount(false);
        }
    }

    async function handleJoinVoice(): Promise<void> {
        if (!callClientRef.current || selectedChannelId <= 0) {
            setError("Voice call is unavailable");
            return;
        }

        const previousChannelId = voiceChannelId;

        try {
            const response = await callClientRef.current.join(selectedChannelId);
            setVoiceChannelId(response.channel_id);
            setIsMicEnabled(true);
            setIsDeafened(false);
            setIsCameraEnabled(false);
            setIsSwitchingCamera(false);
            setIsScreenSharing(false);
            setIsTogglingScreenShare(false);
            setError("");

            playJoinSound();

            if (currentUserId) {
                setVoiceParticipantsByChannel((prev) => {
                    const next = { ...prev };

                    if (previousChannelId > 0 && previousChannelId !== response.channel_id) {
                        const prevChannel = next[previousChannelId];
                        if (prevChannel) {
                            const filtered = prevChannel.filter((p) => p.user_id !== currentUserId);
                            if (filtered.length === 0) {
                                delete next[previousChannelId];
                            } else {
                                next[previousChannelId] = filtered;
                            }
                        }
                    }

                    const selfParticipant: VoiceParticipant = {
                        user_id: currentUserId,
                        first_name: currentUserProfile?.first_name || undefined,
                        last_name: currentUserProfile?.last_name || undefined,
                        nickname: currentUserProfile?.nickname || undefined,
                        avatar_url: avatarUrl || undefined,
                        mic_enabled: true,
                        deafened: false,
                    };

                    const serverParticipants = response.participants.filter(
                        (p) => p.user_id !== selfParticipant.user_id,
                    );
                    next[response.channel_id] = [selfParticipant, ...serverParticipants];

                    return next;
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to join voice channel";
            setError(message);
        }
    }

    async function handleLeaveVoice(): Promise<void> {
        const channelId = voiceChannelId;

        try {
            await callClientRef.current?.leave();
            playLeaveSound();
        } finally {
            setVoiceChannelId(0);
            setRemoteStreams([]);
            setIsMicEnabled(true);
            setIsDeafened(false);
            setIsCameraEnabled(false);
            setIsSwitchingCamera(false);
            setIsScreenSharing(false);
            setIsTogglingScreenShare(false);

            if (channelId > 0 && currentUserId) {
                setVoiceParticipantsByChannel((prev) => {
                    const current = prev[channelId] ?? [];
                    const next = current.filter((p) => p.user_id !== currentUserId);
                    if (!next.length) {
                        const rest = { ...prev };
                        delete rest[channelId];
                        return rest;
                    }
                    return { ...prev, [channelId]: next };
                });
            }
        }
    }

    async function handleJoinServer(serverId: number) {
        if (!socketRef.current || !isConnected) {
            setError("No connection");
            return;
        }

        try {
            await socketRef.current.joinServer(serverId);
            await syncServersAndChannels(serverId);
            setJoinQuery("");
            setJoinResults([]);
            setIsJoinModalOpen(false);
            setError("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to join server";
            setError(message);
        }
    }

    async function handleDeleteServer(): Promise<void> {
        if (!socketRef.current || !isConnected || selectedServerId <= 0) {
            setError("No connection");
            return
        }

        const confirmed = window.confirm("Delete this server? This action cannot be undone");
        if (!confirmed) {
            return;
        }

        try {
            await socketRef.current.deleteServer(selectedServerId);
            await syncServersAndChannels();
            setError("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete server";
            setError(message);
        }
    }

    async function handleDeleteChannel(channelId: number): Promise<void> {
        if (!socketRef.current || !isConnected || selectedServerId <= 0 || channelId <= 0) {
            setError("No connection");
            return
        }

        const confirmed = window.confirm("Delete this channel? This action cannot be undone");
        if (!confirmed) return;

        try {
            await socketRef.current.deleteChannel(channelId);
            await syncServersAndChannels(selectedServerId);
            setError("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete channel";
            setError(message);
        }
    }

    function openAvatarPicker(): void {
        setAvatarError("");
        avatarInputRef.current?.click();
    }

    async function handleAvatarChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
            setAvatarError("Unsupported file type. Please select a PNG, JPEG, or WEBP image.");
            event.target.value = "";
            return;
        }

        if (file.size > MAX_AVATAR_SIZE_BYTES) {
            setAvatarError("File is too large. Please select an image smaller than 1 MB.");
            event.target.value = "";
            return;
        }

        setIsAvatarUploading(true);
        setAvatarError("");

        try {
      const uploadedUrl = await uploadMyAvatar(file);
      setAvatarUrl(uploadedUrl);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to upload avatar";
            setAvatarError(message);
        } finally {
            setIsAvatarUploading(false);
            event.target.value = "";
        }
    }

    function openAvatarPreview(): void {
        if (!avatarUrl) return;
        setIsAvatarPreviewOpen(true);
    }

    function closeAvatarPreview(): void {
        setIsAvatarPreviewOpen(false);
    }

    useEffect(() => {
        if (!isAvatarPreviewOpen) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsAvatarPreviewOpen(false);
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isAvatarPreviewOpen]);

    function toggleMicrophone(): void {
        if (isDeafened) {
            return;
        }
        const next = !isMicEnabled;
        setIsMicEnabled(next);
        callClientRef.current?.setMicrophoneEnabled(next);

        if (currentUserId && voiceChannelId > 0 && socketRef.current) {
            void socketRef.current.changeVoiceStatus(currentUserId, next, isDeafened);
        }

        if (currentUserId && voiceChannelId > 0) {
            setVoiceParticipantsByChannel((prev) => {
                const channel = prev[voiceChannelId];
                if (!channel) return prev;
                const idx = channel.findIndex((p) => p.user_id === currentUserId);
                if (idx === -1) return prev;
                const updated = [...channel];
                updated[idx] = { ...updated[idx], mic_enabled: next };
                return { ...prev, [voiceChannelId]: updated };
            });
        }
    }

    function toggleCamera(): void {
        const videoTrack = localStream?.getVideoTracks()[0];
        if (!videoTrack) {
            setIsCameraEnabled(false);
            setError("Camera is unavailable on this device");
            return;
        }

        const next = !isCameraEnabled;
        setIsCameraEnabled(next);
        callClientRef.current?.setCameraEnabled(next);
    }

    async function switchCameraFacingMode(): Promise<void> {
        if (!callClientRef.current || isSwitchingCamera) {
            return;
        }

        try {
            setIsSwitchingCamera(true);
            setError("");
            await callClientRef.current.toggleCameraFacingMode();
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to switch camera";
            setError(message);
        } finally {
            setIsSwitchingCamera(false);
        }
    }

    async function toggleScreenShare(): Promise<void> {
        if (!callClientRef.current || isTogglingScreenShare || isSwitchingCamera) {
            return;
        }

        try {
            setIsTogglingScreenShare(true);
            setError("");
            const nextState = await callClientRef.current.toggleScreenShare();
            setIsScreenSharing(nextState);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to toggle screen sharing";
            setError(message);
        } finally {
            setIsTogglingScreenShare(false);
        }
    }

    function toggleDeafen(): void {
        const next = !isDeafened;
        if (next) {
            micBeforeDeafenRef.current = isMicEnabled;
            setIsDeafened(true);
            setIsMicEnabled(false);
            callClientRef.current?.setMicrophoneEnabled(false);

            if (currentUserId && voiceChannelId > 0 && socketRef.current) {
                void socketRef.current.changeVoiceStatus(currentUserId, false, true);
            }

            if (currentUserId && voiceChannelId > 0) {
                setVoiceParticipantsByChannel((prev) => {
                    const channel = prev[voiceChannelId];
                    if (!channel) return prev;
                    const idx = channel.findIndex((p) => p.user_id === currentUserId);
                    if (idx === -1) return prev;
                    const updated = [...channel];
                    updated[idx] = { ...updated[idx], mic_enabled: false, deafened: true };
                    return { ...prev, [voiceChannelId]: updated };
                });
            }
        } else {
            setIsDeafened(false);
            const restoreMic = micBeforeDeafenRef.current;
            setIsMicEnabled(restoreMic);
            callClientRef.current?.setMicrophoneEnabled(restoreMic);

            if (currentUserId && voiceChannelId > 0 && socketRef.current) {
                void socketRef.current.changeVoiceStatus(currentUserId, restoreMic, false);
            }

            if (currentUserId && voiceChannelId > 0) {
                setVoiceParticipantsByChannel((prev) => {
                    const channel = prev[voiceChannelId];
                    if (!channel) return prev;
                    const idx = channel.findIndex((p) => p.user_id === currentUserId);
                    if (idx === -1) return prev;
                    const updated = [...channel];
                    updated[idx] = { ...updated[idx], mic_enabled: restoreMic, deafened: false };
                    return { ...prev, [voiceChannelId]: updated };
                });
            }
        }
    }

    function toggleTheme(): void {
        setTheme((prev) => (prev === "light" ? "dark" : "light"));
    }

    useEffect(() => {
        remoteStreams.forEach(({stream}) => {
            stream.getAudioTracks().forEach((track) => {
                track.enabled = !isDeafened;
            });
        });
    }, [remoteStreams, isDeafened]);


    const activeChannels = channelsByServer[selectedServerId] ?? [];
    const currentServer = servers.find((server) => server.id === selectedServerId);
    const isCurrentServerOwner =
        currentUserId !== null &&
        currentServer !== undefined &&
        currentServer.owner_id === currentUserId;
    const currentChannel = activeChannels.find((channel) => channel.id === selectedChannelId);
    const isVoiceChannel = currentChannel?.type === "voice";
    const isInVoiceCall = voiceChannelId > 0;
    const isInSelectedVoiceChannel = isVoiceChannel && voiceChannelId === selectedChannelId;
    const shouldHideMessageInput = isVoiceChannel;
    const activeMessages: Message[] = selectedChannelId > 0 ? messagesByChannel[selectedChannelId] ?? [] : [];

    function scrollToMessage(messageId: number) {
        const el = document.getElementById(`message-${messageId}`);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("message-highlight");
            setTimeout(() => el.classList.remove("message-highlight"), 2000);
        }
    }

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

    const voiceParticipantsInChannel = useMemo(
        () => voiceParticipantsByChannel[voiceChannelId] ?? [],
        [voiceParticipantsByChannel, voiceChannelId],
    );

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

        Object.values(messagesByChannel).forEach((messages) => {
            messages.forEach((message) => {
                add(message.author_first_name, message.author_last_name, message.author_avatar_url, message.author_nickname);
            });
        });

        add(currentUserProfile?.first_name, currentUserProfile?.last_name, avatarUrl, currentUserProfile?.nickname);

        return map;
    }, [messagesByChannel, currentUserProfile?.first_name, currentUserProfile?.last_name, currentUserProfile?.nickname, avatarUrl]);

    const openUserProfile = useCallback(async (userId: number) => {
        if (currentUserId && userId === currentUserId) {
            openSelfProfile();
            return;
        }

        setSelectedProfileUserId(userId);
        setSelectedProfile(null);
        setSelectedProfileError("");
        setProfileUpdateError("");
        setIsProfileLoading(true);
        setIsAvatarPreviewOpen(false);
        setNicknameDraft("");
        setIsProfileModalOpen(true);

        const socket = socketRef.current;
        if (!socket) {
            setSelectedProfileError("No connection");
            setIsProfileLoading(false);
            return;
        }

        try {
            const info = await socket.getUserInfo(userId);
            setSelectedProfile(info);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load user profile";
            if (message.toLowerCase().includes("unknown action")) {
                const messageFallback = Object.values(messagesByChannel)
                    .flat()
                    .find((item) => item.author_id === userId);
                const voiceFallback = Object.values(voiceParticipantsByChannel)
                    .flat()
                    .find((item) => item.user_id === userId);

                if (messageFallback || voiceFallback) {
                    setSelectedProfile({
                        user_id: userId,
                        first_name: messageFallback?.author_first_name ?? voiceFallback?.first_name ?? "",
                        last_name: messageFallback?.author_last_name ?? voiceFallback?.last_name ?? "",
                        nickname: messageFallback?.author_nickname ?? voiceFallback?.nickname ?? "",
                        avatar_url: messageFallback?.author_avatar_url ?? voiceFallback?.avatar_url ?? "",
                    });
                    setSelectedProfileError("");
                    return;
                }
            }

            setSelectedProfileError(message);
        } finally {
            setIsProfileLoading(false);
        }
    }, [currentUserId, openSelfProfile, messagesByChannel, voiceParticipantsByChannel]);

    const isSelfProfile = selectedProfileUserId === null || selectedProfileUserId === currentUserId;
    const profileAvatarUrl = isSelfProfile ? avatarUrl : (selectedProfile?.avatar_url ?? "");
    const profileFirstName = isSelfProfile ? currentUserProfile?.first_name : selectedProfile?.first_name;
    const profileLastName = isSelfProfile ? currentUserProfile?.last_name : selectedProfile?.last_name;
    const profileNickname = isSelfProfile ? currentUserProfile?.nickname : selectedProfile?.nickname;
    const profileDisplayName = profileNickname || [profileFirstName, profileLastName].filter(Boolean).join(" ").trim();
    const profileInitial = (profileNickname?.[0] ?? profileFirstName?.[0] ?? profileLastName?.[0] ?? "U").toUpperCase();

    useEffect(() => {
        const el = chatContentRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [activeMessages.length, selectedChannelId]);

    return (
        <div className={`chat-layout ${isChannelsSidebarHidden ? "channels-sidebar-hidden" : ""}`} onClick={() => { if (isChannelsDrawerOpen) setIsChannelsDrawerOpen(false); }}>
            <aside className="servers-sidebar">
                <button
                    className="server-add-btn"
                    onClick={openCreateServerModal}
                    disabled={!isConnected || isCreatingServer}
                    aria-label="Add server"
                    title="Add server"
                >
                    +
                </button>
                <button
                    className="server-add-btn"
                    onClick={openJoinServerModal}
                    disabled={!isConnected}
                    aria-label="Join server"
                    title="Join server"
                >
                    <Search size={18} aria-hidden="true"/>
                </button>
                <ul className="servers-list">
                    {servers.map((server) => (
                        <li key={server.id}>
                            <button
                                className={`server-dot ${selectedServerId === server.id ? "active" : ""}`}
                                onClick={() => handleSelectServer(server.id)}
                                title={`Server ${server.name} (ID ${server.id})`}
                                aria-label={`Server ${server.name}`}
                            >
                                {server.name?.[0]?.toUpperCase() ?? "?"}
                            </button>
                        </li>
                    ))}
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
                                onClick={() => void handleDeleteServer()}
                                disabled={!isConnected || selectedServerId <= 0}
                                aria-label="Delete server"
                                title="Delete server"
                                type="button"
                            >
                                <Trash2 size={14} aria-hidden="true"/>
                            </button>
                        ) : null}
                        <button
                            className="channels-add-btn"
                            onClick={openCreateChannelModal}
                            disabled={!isConnected || selectedServerId <= 0 || isCreatingChannel}
                            aria-label="Create channel"
                            title="Create channel"
                            type="button"
                        >
                            +
                        </button>
                    </div>
                </div>
                <ul className="channels-list">
                    {activeChannels.map((channel) => (
                        <li key={channel.id} className="channel-item">
                            <div className="channel-row-wrap">
                                <button
                                    className={`channel-row ${selectedChannelId === channel.id ? "active" : ""}`}
                                    onClick={() => { setSelectedChannelId(channel.id); if (isPhone) setIsChannelsDrawerOpen(false); }}
                                    type="button"
                                >
                                    {channel.type === "voice"
                                        ? <Volume2 size={14} aria-hidden="true" />
                                        : <Hash size={14} aria-hidden="true" />
                                    } {channel.name}
                                </button>

                                {isCurrentServerOwner ? (
                                    <button
                                        className="channels-delete-btn"
                                        type="button"
                                        onClick={() => void handleDeleteChannel(channel.id)}
                                        aria-label={`Delete channel ${channel.name}`}
                                        title="Delete channel"
                                    >
                                        <Trash2 size={14} aria-hidden="true"/>
                                    </button>
                                ) : null}
                            </div>
                            {channel.type === "voice" && (voiceParticipantsByChannel[channel.id]?.length ?? 0) > 0 ? (
                                <ul className="voice-members-list">
                                    {(voiceParticipantsByChannel[channel.id] ?? []).map((participant) => (
                                        <li
                                            key={participant.user_id}
                                            className="voice-member-item"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() =>
                                                setActiveVolumeUserId((prev) => (prev === participant.user_id ? null : participant.user_id))
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    setActiveVolumeUserId((prev) => (prev === participant.user_id ? null : participant.user_id));
                                                }
                                            }}
                                        >
                                            <div
                                                className="voice-member-avatar-wrap"
                                                role="button"
                                                tabIndex={0}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    openUserProfile(participant.user_id);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") {
                                                        event.stopPropagation();
                                                        openUserProfile(participant.user_id);
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
                                            {activeVolumeUserId === participant.user_id && (
                                                <div className="voice-volume-popover" onClick={(e) => e.stopPropagation()}>
                                                    <div className="voice-volume-slider-wrap">
                                                        <input
                                                            type="range"
                                                            min="0"
                                                            max="2"
                                                            step="0.01"
                                                            value={voiceVolumeByUserId[participant.user_id] ?? 1}
                                                            onChange={(e) => {
                                                                const raw = Number(e.target.value);
                                                                const next = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1;
                                                                setVoiceVolumeByUserId((prev) => ({
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
                                                        {Math.round((voiceVolumeByUserId[participant.user_id] ?? 1) * 100)}%
                                                    </span>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </aside>

            <section className="chat-main">
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
                                    onClick={openSelfProfile}
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
                                        <button className="message-send-btn" onClick={() => void handleLeaveVoice()}>
                                            Leave
                                        </button>
                                        <button className="micam-btn" onClick={toggleMicrophone} disabled={isDeafened}>
                                            {isMicEnabled ? <Mic size={18} aria-hidden="true"/> :
                                                <MicOff size={18} aria-hidden="true" color="#B80606"/>}
                                        </button>
                                        <button className="micam-btn" onClick={toggleCamera}>
                                            {isCameraEnabled ? <Camera size={18} aria-hidden="true"/> :
                                                <CameraOff size={18} aria-hidden="true" color="#B80606"/>}
                                        </button>
                                        {isMobileDevice ? (
                                            <button
                                                className="micam-btn"
                                                onClick={() => void switchCameraFacingMode()}
                                                disabled={isSwitchingCamera || !localStream}
                                                title="Switch camera"
                                                aria-label="Switch camera"
                                            >
                                                <RefreshCw size={18} aria-hidden="true"/>
                                            </button>
                                        ) : (
                                            <button
                                                className="micam-btn"
                                                onClick={() => void toggleScreenShare()}
                                                disabled={!localStream || isTogglingScreenShare || isSwitchingCamera}
                                                title={isScreenSharing ? "Stop screen sharing" : "Share screen"}
                                                aria-label={isScreenSharing ? "Stop screen sharing" : "Share screen"}
                                            >
                                                {isScreenSharing ? <MonitorOff size={18} aria-hidden="true"/> :
                                                    <Monitor size={18} aria-hidden="true"/>}
                                            </button>
                                        )}
                                        <button className="micam-btn" onClick={toggleDeafen}>
                                            {isDeafened ? <VolumeOff size={18} aria-hidden="true" color="#B80606"/> :
                                                <Volume2 size={18} aria-hidden="true"/>}
                                        </button>
                                        {isVoiceChannel && !isInSelectedVoiceChannel && (
                                            <button className="message-send-btn" onClick={() => void handleJoinVoice()}>
                                                Switch
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <button className="message-send-btn" onClick={() => void handleJoinVoice()}>
                                        Join
                                    </button>
                                )}
                            </div>
                            {isInVoiceCall && (
                            <div className="video-grid">
                                {localStream && (
                                    <VideoTile
                                        stream={localStream}
                                        label="You"
                                        muted
                                        micEnabled={isMicEnabled}
                                        deafened={isDeafened}
                                    />
                                )}
                                {voiceParticipantsInChannel
                                    .filter((p) => p.user_id !== currentUserId)
                                    .map((participant) => {
                                        const remoteItem = remoteStreams.find((r) => r.userId === participant.user_id);
                                        const stream = remoteItem?.stream ?? null;
                                        const label = remoteItem?.label ?? getParticipantDisplayName(participant);
                                        const userVolume = voiceVolumeByUserId[participant.user_id] ?? 1;
                                        const effectiveVolume = isDeafened ? 0 : userVolume;

                                        return (
                                            <VideoTile
                                                key={`${participant.user_id}-${isDeafened ? "deaf" : "live"}`}
                                                stream={stream}
                                                label={label}
                                                muted={isDeafened}
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
                    <MessageList key={selectedChannelId} messages={activeMessages} currentUserId={currentUserId} onOpenProfile={openUserProfile} onDeleteMessage={handleDeleteMessage} onReply={setReplyToMessage} onScrollToMessage={scrollToMessage}/>
                </div>
                {shouldHideMessageInput ? null : (
                    <MessageInput
                        onSend={handleSend}
                        disabled={!isConnected || selectedChannelId <= 0}
                        isOnlinePanelOpen={isOnlinePanelOpen}
                        onToggleOnlinePanel={() => setIsOnlinePanelOpen((prev) => !prev)}
                        onlineUsers={onlineUsers}
                        isOnlineUsersLoading={isOnlineUsersLoading}
                        onlineUserAvatarByName={onlineUserAvatarByName}
                        onOpenProfile={openUserProfile}
                        replyToMessage={replyToMessage}
                        onCancelReply={() => setReplyToMessage(null)}
                    />
                )}
            </section>

            {isProfileModalOpen && (
                <div className="modal-overlay" onClick={() => setIsProfileModalOpen(false)}>
                    <div className="modal-card profile-modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Profile</h3>
                        <div className="profile-modal-list">
                            <div className="profile-avatar-block">
                                <div className="profile-avatar-preview-wrap">
                                    {profileAvatarUrl ? (
                                        isSelfProfile ? (
                                            <button
                                                type="button"
                                                className="profile-avatar-preview-btn"
                                                onClick={openAvatarPreview}
                                                aria-label="Open avatar preview"
                                                title="Open avatar"
                                            >
                                                <img
                                                    src={profileAvatarUrl}
                                                    alt="Current avatar"
                                                    className="profile-avatar-preview"
                                                    onError={() => setAvatarUrl("")}
                                                />
                                            </button>
                                        ) : (
                                            <img
                                                src={profileAvatarUrl}
                                                alt="User avatar"
                                                className="profile-avatar-preview"
                                            />
                                        )
                                    ) : (
                                        <div className="profile-avatar-fallback">{profileInitial}</div>
                                    )}
                                </div>

                                {isSelfProfile ? (
                                    <div className="profile-avatar-actions">
                                        <input
                                            ref={avatarInputRef}
                                            type="file"
                                            accept="image/png,image/jpeg,image/webp"
                                            onChange={(e) => void handleAvatarChange(e)}
                                            style={{ display: "none" }}
                                        />
                                        <button
                                            className="modal-btn modal-btn-primary"
                                            type="button"
                                            onClick={openAvatarPicker}
                                            disabled={isAvatarUploading}
                                        >
                                            {isAvatarUploading ? "Uploading..." : "Change avatar"}
                                        </button>
                                    </div>
                                ) : null}

                                {isProfileLoading ? <div className="profile-avatar-error">Loading profile...</div> : null}
                                {selectedProfileError ? <div className="profile-avatar-error">{selectedProfileError}</div> : null}
                                {profileUpdateError ? <div className="profile-avatar-error">{profileUpdateError}</div> : null}
                                {isSelfProfile && avatarError ? <div className="profile-avatar-error">{avatarError}</div> : null}
                            </div>

                            <div className="profile-modal-row">
                                <span className="profile-modal-label">First name</span>
                                <span className="profile-modal-value">{profileFirstName || "-"}</span>
                            </div>
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Last name</span>
                                <span className="profile-modal-value">{profileLastName || "-"}</span>
                            </div>
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Nickname</span>
                                {isSelfProfile ? (
                                    <input
                                        className="modal-input"
                                        type="text"
                                        value={nicknameDraft}
                                        onChange={(e) => setNicknameDraft(e.target.value)}
                                        maxLength={48}
                                        placeholder="Enter nickname"
                                        disabled={isSavingNickname}
                                    />
                                ) : (
                                    <span className="profile-modal-value">{profileNickname || "-"}</span>
                                )}
                            </div>
                            {isSelfProfile ? (
                                <div className="profile-modal-row">
                                    <span className="profile-modal-label">Email</span>
                                    <span className="profile-modal-value">{currentUserProfile?.email || "-"}</span>
                                </div>
                            ) : null}
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Name</span>
                                <span className="profile-modal-value">{profileDisplayName || "-"}</span>
                            </div>
                            {isSelfProfile ? (
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
                        </div>
                        {isSelfProfile && isDeleteAccountConfirmOpen ? (
                            <div className="delete-account-confirm">
                                <div className="delete-account-warning">
                                    This permanently deletes your account. Enter your password to confirm.
                                </div>
                                <input
                                    className="modal-input"
                                    type="password"
                                    value={deletePasswordDraft}
                                    onChange={(e) => setDeletePasswordDraft(e.target.value)}
                                    placeholder="Password"
                                    disabled={isDeletingAccount}
                                    autoFocus
                                />
                                {deleteAccountError ? <div className="profile-avatar-error">{deleteAccountError}</div> : null}
                                <div className="delete-account-confirm-actions">
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        type="button"
                                        onClick={() => {
                                            setIsDeleteAccountConfirmOpen(false);
                                            setDeletePasswordDraft("");
                                            setDeleteAccountError("");
                                        }}
                                        disabled={isDeletingAccount}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        className="modal-btn modal-btn-danger"
                                        type="button"
                                        onClick={() => void handleDeleteAccount()}
                                        disabled={isDeletingAccount}
                                    >
                                        {isDeletingAccount ? "Deleting..." : "Delete account"}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        <div className="modal-actions">
                            {isSelfProfile ? (
                                <>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        onClick={() => void handleSaveNickname()}
                                        type="button"
                                        disabled={isSavingNickname}
                                    >
                                        {isSavingNickname ? "Saving..." : "Save"}
                                    </button>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        onClick={handleLogout}
                                        type="button"
                                    >
                                        Logout
                                    </button>
                                    {!isDeleteAccountConfirmOpen ? (
                                        <button
                                            className="modal-btn modal-btn-danger"
                                            type="button"
                                            onClick={() => setIsDeleteAccountConfirmOpen(true)}
                                            disabled={isSavingNickname || isDeletingAccount}
                                        >
                                            Delete account
                                        </button>
                                    ) : null}
                                </>
                            ) : null}
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={() => setIsProfileModalOpen(false)}
                                type="button"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isAvatarPreviewOpen && avatarUrl && (
                <div className="avatar-viewer-overlay" onClick={closeAvatarPreview}>
                    <div className="avatar-viewer-content" onClick={(e) => e.stopPropagation()}>
                        <img
                            src={avatarUrl}
                            alt="Avatar full size"
                            className="avatar-viewer-image"
                            onError={closeAvatarPreview}
                        />
                        <button
                            type="button"
                            className="avatar-viewer-close"
                            onClick={closeAvatarPreview}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {isCreateServerModalOpen && (
                <div className="modal-overlay" onClick={() => setIsCreateServerModalOpen(false)}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Create server</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Enter server name"
                            value={newServerName}
                            onChange={(e) => setNewServerName(e.target.value)}
                            maxLength={MAX_SERVER_CHANNEL_NAME_LENGTH}
                            autoFocus
                        />

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => setIsCreateServerModalOpen(false)}
                                disabled={isCreatingServer}
                            >
                                Cancel
                            </button>
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={handleAddServerSubmit}
                                disabled={isCreatingServer}
                            >
                                {isCreatingServer ? "Creating..." : "Create"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isJoinModalOpen && (
                <div className="modal-overlay" onClick={() => setIsJoinModalOpen(false)}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Join server</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Search by server name"
                            value={joinQuery}
                            onChange={(e) => setJoinQuery(e.target.value)}
                            maxLength={64}
                            autoFocus
                        />

                        {isSearchingServers ? <div className="messages-empty">Searching...</div> : null}

                        {!isSearchingServers && joinQuery.trim().length >= 2 && !joinResults.length ? (
                            <div className="messages-empty">No servers found</div>
                        ) : null}

                        {!isSearchingServers && joinResults.length > 0 ? (
                            <ul className="channels-list">
                                {joinResults.map((server) => (
                                    <li key={server.id}>
                                        <button className="channel-row"
                                                onClick={() => void handleJoinServer(server.id)}>
                                            Join {server.name}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => setIsJoinModalOpen(false)}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isCreateChannelModalOpen && (
                <div className="modal-overlay" onClick={() => setIsCreateChannelModalOpen(false)}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Create channel</h3>

                        <input
                            className="modal-input"
                            type="text"
                            placeholder="Enter channel name"
                            value={newChannelName}
                            onChange={(e) => setNewChannelName(e.target.value)}
                            maxLength={MAX_SERVER_CHANNEL_NAME_LENGTH}
                            autoFocus
                        />
                        <select
                            className="modal-input"
                            value={newChannelType}
                            onChange={(e) => setNewChannelType(e.target.value === "voice" ? "voice" : "text")}
                        >
                            <option value="text">Text</option>
                            <option value="voice">Voice</option>
                        </select>

                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={() => setIsCreateChannelModalOpen(false)}
                                disabled={isCreatingChannel}
                            >
                                Cancel
                            </button>
                            <button
                                className="modal-btn modal-btn-primary"
                                onClick={handleAddChannelSubmit}
                                disabled={isCreatingChannel}
                            >
                                {isCreatingChannel ? "Creating..." : "Create"}
                            </button>
                        </div>
                    </div>
                </div>
            )}


        </div>
    );
}

