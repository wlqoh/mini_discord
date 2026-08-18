import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { SfuCallClient } from "../services/sfuCallClient.ts";
import type { VoiceClient } from "../services/voiceClient.ts";
import { ChatSocket } from "../services/chatSocket.ts";
import type { CurrentUserProfile } from "../services/authToken.ts";
import type {
    ChannelsByServer,
    MessagesByChannel,
    OnlineUser,
    Server,
    VoiceParticipant,
    VoiceParticipantsByChannel,
} from "../types/chat.ts";
import type { PeerQuality } from "../services/connectionQuality.ts";

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";
const MAX_SERVER_CHANNEL_NAME_LENGTH = 16;

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    callClientRef: React.MutableRefObject<VoiceClient | null>;
    setIsConnected: (v: boolean) => void;
    isPageVisible: boolean;
    showToast: (type: "success" | "error", message: string) => void;
    currentUserProfile: CurrentUserProfile | null;
    handleAuthFailure: (message: string) => void;
    setError: (msg: string) => void;
    setVoiceParticipantsByChannel: React.Dispatch<React.SetStateAction<VoiceParticipantsByChannel>>;
    setMessagesByChannel: React.Dispatch<React.SetStateAction<MessagesByChannel>>;
    callClientCallbacks: {
        onParticipantStream: (participant: VoiceParticipant, stream: MediaStream) => void;
        onParticipantLeft: (userId: number) => void;
        onLocalStream: (stream: MediaStream | null) => void;
        onLocalScreenStream: (stream: MediaStream | null) => void;
        onError: (message: string) => void;
        onQualityChange: (quality: Record<number, PeerQuality>) => void;
    };
    voiceSocketHandlers: {
        onVoiceUserJoined: (event: { channel_id: number; user: VoiceParticipant }) => void;
        onVoiceUserLeft: (event: { channel_id: number; user: VoiceParticipant }) => void;
        onVoiceStatusChanged: (event: { channel_id: number; user: VoiceParticipant }) => void;
        onVoiceUserDetached: (event: { channel_id: number; user: VoiceParticipant }) => void;
        onVoiceUserResumed: (event: { channel_id: number; user: VoiceParticipant }) => void;
        onSfuActiveSpeakers: (event: { channel_id: number; user_ids: number[] }) => void;
    };
    onSocketReconnectRestored: () => void;
    currentUserId: number | null;
};

export function useServers({
    socketRef,
    callClientRef,
    setIsConnected,
    isPageVisible,
    showToast,
    currentUserProfile,
    handleAuthFailure,
    setError,
    setVoiceParticipantsByChannel,
    setMessagesByChannel,
    callClientCallbacks,
    voiceSocketHandlers,
    onSocketReconnectRestored,
    currentUserId,
}: Params) {
    const [servers, setServers] = useState<Server[]>([]);
    const [channelsByServer, setChannelsByServer] = useState<ChannelsByServer>({});
    const [selectedServerId, setSelectedServerId] = useState<number>(0);
    const selectedServerIdRef = useRef(0);
    const [selectedChannelId, setSelectedChannelId] = useState<number>(0);

    const isCreatingServerRef = useRef(false);
    const [isCreatingServer, setIsCreatingServer] = useState(false);
    const isCreatingChannelRef = useRef(false);
    const [isCreatingChannel, setIsCreatingChannel] = useState(false);

    const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
    const [newServerName, setNewServerName] = useState("");

    const [isCreateChannelModalOpen, setIsCreateChannelModalOpen] = useState(false);
    const [newChannelName, setNewChannelName] = useState("");
    const [newChannelType, setNewChannelType] = useState<"text" | "voice">("text");

    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
    const [joinQuery, setJoinQuery] = useState("");
    const [joinResults, setJoinResults] = useState<Array<{ id: number; name: string }>>([]);
    const [isSearchingServers, setIsSearchingServers] = useState(false);
    const joinSearchRequestIdRef = useRef(0);

    const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
    const [isOnlineUsersLoading, setIsOnlineUsersLoading] = useState(false);
    const [isOnlinePanelOpen, setIsOnlinePanelOpen] = useState(false);

    const [isConnectedLocal, setIsConnectedLocal] = useState(false);

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
                const next = { ...prev };
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
        [socketRef, setVoiceParticipantsByChannel, setMessagesByChannel],
    );

    // Big socket init effect
    useEffect(() => {
        const socket = new ChatSocket();
        socketRef.current = socket;

        if (currentUserId && currentUserId > 0) {
            callClientRef.current = new SfuCallClient(
                socket,
                currentUserId,
                callClientCallbacks.onParticipantStream,
                callClientCallbacks.onParticipantLeft,
                callClientCallbacks.onLocalStream,
                callClientCallbacks.onLocalScreenStream,
                callClientCallbacks.onError,
                callClientCallbacks.onQualityChange,
            );
        }

        const unsubscribeMessage = socket.onMessage((incoming) => {
            // useMessages subscribes separately; we only handle channelsByServer sync here
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
                            type: "text" as const,
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

        const unsubscribeVoiceUserJoined = socket.onVoiceUserJoined(voiceSocketHandlers.onVoiceUserJoined);
        const unsubscribeVoiceUserLeft = socket.onVoiceUserLeft(voiceSocketHandlers.onVoiceUserLeft);
        const unsubscribeVoiceStatusChanged = socket.onVoiceStatusChanged(voiceSocketHandlers.onVoiceStatusChanged);
        const unsubscribeVoiceUserDetached = socket.onVoiceUserDetached(voiceSocketHandlers.onVoiceUserDetached);
        const unsubscribeVoiceUserResumed = socket.onVoiceUserResumed(voiceSocketHandlers.onVoiceUserResumed);
        const unsubscribeSfuActiveSpeakers = socket.onSfuActiveSpeakers(voiceSocketHandlers.onSfuActiveSpeakers);

        // An unplanned disconnect (idle proxy timeout, network blip, backend
        // restart) previously left isConnected stuck at true forever and the
        // user in voice silently dropped with no way back short of a reload.
        const unsubscribeReconnect = socket.onReconnect((phase) => {
            if (phase === "restored") {
                setIsConnected(true);
                setIsConnectedLocal(true);
                setError("");
                onSocketReconnectRestored();
                void syncServersAndChannels();
            } else {
                setIsConnected(false);
                setIsConnectedLocal(false);
            }
        });

        (async () => {
            try {
                await socket.connect();
                setIsConnected(true);
                setIsConnectedLocal(true);
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
            unsubscribeVoiceUserDetached();
            unsubscribeVoiceUserResumed();
            unsubscribeSfuActiveSpeakers();
            unsubscribeReconnect();
            callClientRef.current?.dispose();
            callClientRef.current = null;
            socketRef.current?.close();
            socketRef.current = null;
            setIsConnected(false);
            setIsConnectedLocal(false);
        };
    }, [handleAuthFailure, syncServersAndChannels, currentUserId, callClientCallbacks, voiceSocketHandlers, onSocketReconnectRestored, socketRef, callClientRef, setIsConnected, setError]);

    // Periodic sync effect
    useEffect(() => {
        if (!isConnectedLocal || !socketRef.current || !isPageVisible) {
            return;
        }

        const intervalId = window.setInterval(() => {
            void syncServersAndChannels();
        }, 3000);

        return () => window.clearInterval(intervalId);
    }, [isConnectedLocal, syncServersAndChannels, isPageVisible, socketRef]);

    // Persistence effects
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

    const refreshOnlineUsers = useCallback(async () => {
        if (!socketRef.current || !isConnectedLocal || selectedServerId <= 0) {
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
    }, [isConnectedLocal, selectedServerId, currentUserProfile?.email, currentUserProfile?.nickname, socketRef, setError]);

    // Online users effect
    useEffect(() => {
        if (!isConnectedLocal || selectedServerId <= 0) {
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
    }, [isConnectedLocal, selectedServerId, refreshOnlineUsers, isPageVisible]);

    // Refresh when panel opens so the list is always fresh
    useEffect(() => {
        if (isOnlinePanelOpen) {
            setOnlineUsers([]);
            void refreshOnlineUsers();
        }
    }, [isOnlinePanelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

    // Debounced join search effect
    useEffect(() => {
        if (!isJoinModalOpen) {
            setJoinResults([]);
            setIsSearchingServers(false);
            return;
        }

        const socket = socketRef.current;
        if (!socket || !isConnectedLocal) {
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
    }, [joinQuery, isJoinModalOpen, isConnectedLocal, socketRef, setError]);

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
        if (!socketRef.current || !isConnectedLocal) {
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
            showToast("success", `Server "${trimmedName}" created`);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to create server";
            setError(message);
            showToast("error", message);
        } finally {
            isCreatingServerRef.current = false;
            setIsCreatingServer(false);
        }
    }

    async function handleAddChannelSubmit() {
        if (!socketRef.current || !isConnectedLocal || selectedServerId <= 0) {
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
            await socketRef.current.createChannel(selectedServerId, trimmedName, newChannelType);

            await syncServersAndChannels(selectedServerId);
            setError("");
            setIsCreateChannelModalOpen(false);
            setNewChannelName("");
            showToast("success", `Channel "${trimmedName}" created`);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to create channel";
            setError(message);
            showToast("error", message);
        } finally {
            isCreatingChannelRef.current = false;
            setIsCreatingChannel(false);
        }
    }

    async function handleDeleteServer(): Promise<void> {
        if (!socketRef.current || !isConnectedLocal || selectedServerId <= 0) {
            setError("No connection");
            return;
        }

        const confirmed = window.confirm("Delete this server? This action cannot be undone");
        if (!confirmed) {
            return;
        }

        try {
            await socketRef.current.deleteServer(selectedServerId);
            await syncServersAndChannels();
            setError("");
            showToast("success", "Server deleted");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete server";
            setError(message);
            showToast("error", message);
        }
    }

    async function handleDeleteChannel(channelId: number): Promise<void> {
        if (!socketRef.current || !isConnectedLocal || selectedServerId <= 0 || channelId <= 0) {
            setError("No connection");
            return;
        }

        const confirmed = window.confirm("Delete this channel? This action cannot be undone");
        if (!confirmed) return;

        try {
            await socketRef.current.deleteChannel(channelId);
            await syncServersAndChannels(selectedServerId);
            setError("");
            showToast("success", "Channel deleted");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to delete channel";
            setError(message);
            showToast("error", message);
        }
    }

    async function handleSelectServer(serverId: number) {
        setSelectedServerId(serverId);
        setError("");

        if (!socketRef.current || !isConnectedLocal) {
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

    async function handleJoinServer(serverId: number) {
        if (!socketRef.current || !isConnectedLocal) {
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

    return {
        servers,
        channelsByServer,
        setChannelsByServer,
        selectedServerId,
        selectedServerIdRef,
        selectedChannelId,
        setSelectedChannelId,
        isCreatingServer,
        isCreatingChannel,
        isCreateServerModalOpen,
        setIsCreateServerModalOpen,
        newServerName,
        setNewServerName,
        isCreateChannelModalOpen,
        setIsCreateChannelModalOpen,
        newChannelName,
        setNewChannelName,
        newChannelType,
        setNewChannelType,
        isJoinModalOpen,
        setIsJoinModalOpen,
        joinQuery,
        setJoinQuery,
        joinResults,
        isSearchingServers,
        onlineUsers,
        isOnlineUsersLoading,
        isOnlinePanelOpen,
        setIsOnlinePanelOpen,
        syncServersAndChannels,
        handleAddServerSubmit,
        handleAddChannelSubmit,
        handleDeleteServer,
        handleDeleteChannel,
        handleSelectServer,
        handleJoinServer,
        openCreateServerModal,
        openJoinServerModal,
        openCreateChannelModal,
        MAX_SERVER_CHANNEL_NAME_LENGTH,
    };
}
