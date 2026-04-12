import { useCallback, useEffect, useRef, useState } from "react";
import {useNavigate} from "react-router-dom";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import VideoTile from "../components/VideoTile.tsx";
import {ChatSocket} from "../services/chatSocket.ts";
import {CallClient} from "../services/callClient.ts";
import {clearAuthStorage, getCurrentUserId, getCurrentUserProfile} from "../services/authToken.ts";
import type {CurrentUserProfile} from "../services/authToken.ts";
import type {ChannelsByServer, Message, MessagesByChannel, Server, VoiceParticipant} from "../types/chat.ts";
import "../styles/chat.css";

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";

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
    const chatContentRef = useRef<HTMLDivElement | null>(null);
    const isCreatingServerRef = useRef(false);
    const [isCreatingServer, setIsCreatingServer] = useState(false);
    const isCreatingChannelRef = useRef(false);
    const [isCreatingChannel, setIsCreatingChannel] = useState(false);

    const [servers, setServers] = useState<Server[]>([]);
    const [channelsByServer, setChannelsByServer] = useState<ChannelsByServer>({});
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
    const [voiceChannelId, setVoiceChannelId] = useState(0);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<Array<{ userId: number; label: string; stream: MediaStream }>>([]);
    const [isMicEnabled, setIsMicEnabled] = useState(true);
    const [isCameraEnabled, setIsCameraEnabled] = useState(true);
    const currentUserProfile: CurrentUserProfile | null = getCurrentUserProfile();
    const currentUserId: number | null = getCurrentUserId();
    const toParticipantLabel = useCallback((participant: VoiceParticipant): string => {
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

    const syncServersAndChannels = useCallback(
        async (preferredServerId?: number) => {
            if (!socketRef.current) {
                return;
            }

            const remoteServers = await socketRef.current.getServers();
            if (!remoteServers.length) {
                setServers([]);
                setChannelsByServer({});
                setSelectedServerId(0);
                setSelectedChannelId(0);
                setMessagesByChannel({});
                localStorage.setItem(CHAT_SERVERS_KEY, JSON.stringify([]));
                localStorage.setItem(CHAT_CHANNELS_BY_SERVER_KEY, JSON.stringify({}));
                localStorage.removeItem(CHAT_SELECTED_SERVER_KEY);
                return;
            }

            const channelsByServerEntries = await Promise.all(
                remoteServers.map(async (server) => {
                    const channels = await socketRef.current!.getServerChannels(server.id);
                    return [server.id, channels] as const;
                }),
            );

            const remoteChannelsByServer = Object.fromEntries(channelsByServerEntries) as ChannelsByServer;

            const fromState = selectedServerIdRef.current;
            const activeServerId =
                (preferredServerId && remoteServers.some((server) => server.id === preferredServerId) && preferredServerId) ||
                (fromState > 0 && remoteServers.some((server) => server.id === fromState) && fromState) ||
                remoteServers[0].id;

            const activeChannels = remoteChannelsByServer[activeServerId] ?? [];

            setServers(remoteServers);
            setChannelsByServer(remoteChannelsByServer);
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
                },
                (userId) => {
                    setRemoteStreams((prev) => prev.filter((item) => item.userId !== userId));
                },
                (stream) => {
                    setLocalStream(stream);
                    if (!stream) {
                        setRemoteStreams([]);
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

        (async () => {
            try {
                await socket.connect();
                setIsConnected(true);
                setError("");

                const persistedSelectedServer = Number(localStorage.getItem(CHAT_SELECTED_SERVER_KEY) ?? "0");
                await syncServersAndChannels(persistedSelectedServer > 0 ? persistedSelectedServer : undefined);
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to connect to chat";
                if (message.toLowerCase().includes("re-entry required") || message.toLowerCase().includes("permission denied")) {
                    handleAuthFailure("Session expired, please log in again");
                    return;
                }
                setError(message);
            }
        })();

        return () => {
            unsubscribeMessage();
            unsubscribeError();
            callClientRef.current?.dispose();
            callClientRef.current = null;
            socketRef.current?.close();
            socketRef.current = null;
            setIsConnected(false);
        };
    }, [navigate, handleAuthFailure, syncServersAndChannels, currentUserId, toParticipantLabel]);

    useEffect(() => {
        if (!isConnected || !socketRef.current) {
            return;
        }

        const intervalId = window.setInterval(() => {
            void syncServersAndChannels();
        }, 3000);

        return () => window.clearInterval(intervalId);
    }, [isConnected, syncServersAndChannels]);

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

    function openCreateServerModal() {
        setError("");
        setNewServerName("");
        setIsCreateServerModalOpen(true);
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

    async function handleSend(text: string) {
        if (!socketRef.current || !isConnected || selectedChannelId <= 0) {
            return;
        }

        try {
            setError("");
            await socketRef.current.sendMessage(selectedChannelId, text);
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

    async function handleJoinVoice(): Promise<void> {
        if (!callClientRef.current || selectedChannelId <= 0) {
            setError("Voice call is unavailable");
            return;
        }

        try {
            await callClientRef.current.join(selectedChannelId);
            setVoiceChannelId(selectedChannelId);
            setIsMicEnabled(true);
            setIsCameraEnabled(true);
            setError("");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to join voice channel";
            setError(message);
        }
    }

    async function handleLeaveVoice(): Promise<void> {
        try {
            await callClientRef.current?.leave();
        } finally {
            setVoiceChannelId(0);
            setRemoteStreams([]);
            setIsMicEnabled(true);
            setIsCameraEnabled(true);
        }
    }

    function toggleMicrophone(): void {
        const next = !isMicEnabled;
        setIsMicEnabled(next);
        callClientRef.current?.setMicrophoneEnabled(next);
    }

    function toggleCamera(): void {
        const next = !isCameraEnabled;
        setIsCameraEnabled(next);
        callClientRef.current?.setCameraEnabled(next);
    }


    const activeChannels = channelsByServer[selectedServerId] ?? [];
    const currentServer = servers.find((server) => server.id === selectedServerId);
    const currentChannel = activeChannels.find((channel) => channel.id === selectedChannelId);
    const isVoiceChannel = currentChannel?.type === "voice";
    const isInSelectedVoiceChannel = isVoiceChannel && voiceChannelId === selectedChannelId;
    const activeMessages: Message[] = selectedChannelId > 0 ? messagesByChannel[selectedChannelId] ?? [] : [];
    const userDisplayName = [currentUserProfile?.first_name, currentUserProfile?.last_name].filter(Boolean).join(" ").trim();
    const userInitial =
        currentUserProfile?.first_name?.[0]?.toUpperCase() ??
        currentUserProfile?.email?.[0]?.toUpperCase() ??
        "U";

    useEffect(() => {
        const el = chatContentRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [activeMessages.length, selectedChannelId]);

    return (
        <div className="chat-layout">
            <aside className="servers-sidebar">
                <button
                    className="server-add-btn"
                    onClick={openCreateServerModal}
                    disabled={!isConnected || isCreatingServer}
                    aria-label="Add server"
                    title="Add server">
                    +
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
            </aside>

            <aside className="channels-sidebar">
                <div className="channels-header">
                    <span>Server {currentServer?.name ?? "-"}</span>
                    <button
                        className="channels-add-btn"
                        onClick={openCreateChannelModal}
                        disabled={!isConnected || selectedServerId <= 0 || isCreatingChannel}
                        aria-label="Create channel"
                        title="Create channel">
                        +
                    </button>
                </div>
                <ul className="channels-list">
                    {activeChannels.map((channel) => (
                        <li key={channel.id}>
                            <button className={`channel-row ${selectedChannelId === channel.id ? "active" : ""}`}
                                    onClick={() => setSelectedChannelId(channel.id)}>
                                {channel.type === "voice" ? "🔊" : "#"} {channel.name}
                            </button>
                        </li>
                    ))}
                </ul>
            </aside>

            <section className="chat-main">
                <div className="chat-content" ref={chatContentRef}>
                    <div className="chat-header-row">
                        <div className="chat-header">{currentServer ? `Сервер ${currentServer.name}` : "Server"}</div>
                        <button
                            className="profile-open-btn"
                            type="button"
                            onClick={() => setIsProfileModalOpen(true)}
                            aria-label="Open profile"
                            title="Profile"
                        >
                            {userInitial}
                        </button>
                    </div>
                    <div
                        className="chat-subheader">{currentChannel ? `# ${currentChannel.name}` : "Channel not selected"}</div>
                    {isVoiceChannel && (
                        <div className="voice-panel">
                            <div className="voice-controls">
                                {!isInSelectedVoiceChannel ? (
                                    <button className="message-send-btn" onClick={() => void handleJoinVoice()}>
                                        Join voice
                                    </button>
                                ) : (
                                    <>
                                        <button className="message-send-btn" onClick={() => void handleLeaveVoice()}>
                                            Leave voice
                                        </button>
                                        <button className="channels-add-btn" onClick={toggleMicrophone}>
                                            {isMicEnabled ? "Mic on" : "Mic off"}
                                        </button>
                                        <button className="channels-add-btn" onClick={toggleCamera}>
                                            {isCameraEnabled ? "Cam on" : "Cam off"}
                                        </button>
                                    </>
                                )}
                            </div>
                            <div className="video-grid">
                                {localStream && <VideoTile stream={localStream} label="You" muted />}
                                {remoteStreams.map((item) => (
                                    <VideoTile key={item.userId} stream={item.stream} label={item.label} />
                                ))}
                            </div>
                        </div>
                    )}
                    {error ? <div className="messages-empty">{error}</div> : null}
                    <MessageList messages={activeMessages} currentUserId={currentUserId} />
                </div>
                <MessageInput onSend={handleSend} disabled={!isConnected || selectedChannelId <= 0 || isVoiceChannel}/>
            </section>

            {isProfileModalOpen && (
                <div className="modal-overlay" onClick={() => setIsProfileModalOpen(false)}>
                    <div className="modal-card profile-modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">Profile</h3>
                        <div className="profile-modal-list">
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">First name</span>
                                <span className="profile-modal-value">{currentUserProfile?.first_name || "-"}</span>
                            </div>
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Last name</span>
                                <span className="profile-modal-value">{currentUserProfile?.last_name || "-"}</span>
                            </div>
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Email</span>
                                <span className="profile-modal-value">{currentUserProfile?.email || "-"}</span>
                            </div>
                            <div className="profile-modal-row">
                                <span className="profile-modal-label">Name</span>
                                <span className="profile-modal-value">{userDisplayName || "-"}</span>
                            </div>
                        </div>
                        <div className="modal-actions">
                            <button
                                className="modal-btn modal-btn-secondary"
                                onClick={handleLogout}
                                type="button"
                            >
                                Logout
                            </button>
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
                            maxLength={64}
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
                            maxLength={64}
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