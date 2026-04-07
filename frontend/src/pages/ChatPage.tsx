import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import { ChatSocket } from "../services/chatSocket.ts";
import { clearAuthStorage } from "../services/authToken.ts";
import type { ChannelsByServer, Message, MessagesByChannel, Server } from "../types/chat.ts";
import "../styles/chat.css";

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";

function getNextNumericName(items: Array<{ name: string }>, fallback = 1): string {
  const numericNames = items.map((item) => Number(item.name)).filter((value) => Number.isInteger(value) && value > 0);

  if (!numericNames.length) return String(fallback);

  return String(Math.max(...numericNames) + 1);
}

export default function ChatPage() {
  const navigate = useNavigate();
  const socketRef = useRef<ChatSocket | null>(null);
  const selectedServerIdRef = useRef(0);
  const chatContentRef = useRef<HTMLDivElement | null>(null);
  const isCreatingServerRef = useRef(false);
  const [isCreatingServer, setIsCreatingServer] = useState(false);

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

  const handleAuthFailure = useCallback(
    (message: string): void => {
      clearAuthStorage();
      setError(message);
      navigate("/login", { replace: true });
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
    [],
  );

  useEffect(() => {
    const socket = new ChatSocket();
    socketRef.current = socket;

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
            { id: incoming.channel_id, server_id: selectedServerIdRef.current, name: String(incoming.channel_id) },
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
      socketRef.current?.close();
      socketRef.current = null;
      setIsConnected(false);
    };
  }, [navigate, handleAuthFailure, syncServersAndChannels]);

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
        setLoadedChannels((prev) => ({ ...prev, [selectedChannelId]: true }));
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
      await socketRef.current.createChannel(createdServer.server_id, "1");

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

  async function handleAddChannel() {
    if (!socketRef.current || !isConnected || selectedServerId <= 0) {
      setError("No connection to chat");
      return;
    }

    try {
      const currentChannels = channelsByServer[selectedServerId] ?? [];
      const nextName = getNextNumericName(currentChannels);
      await socketRef.current.createChannel(selectedServerId, nextName);

      await syncServersAndChannels(selectedServerId);
      setError("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create channel";
      setError(message);
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

  const activeChannels = channelsByServer[selectedServerId] ?? [];
  const currentServer = servers.find((server) => server.id === selectedServerId);
  const currentChannel = activeChannels.find((channel) => channel.id === selectedChannelId);
  const activeMessages: Message[] = selectedChannelId > 0 ? messagesByChannel[selectedChannelId] ?? [] : [];

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
                {server.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <aside className="channels-sidebar">
        <div className="channels-header">
          <span>Server {currentServer?.name ?? "-"}</span>
          <button className="channels-add-btn" onClick={handleAddChannel} aria-label="Create channel" title="Create channel">
            +
          </button>
        </div>
        <ul className="channels-list">
          {activeChannels.map((channel) => (
            <li key={channel.id}>
              <button className={`channel-row ${selectedChannelId === channel.id ? "active" : ""}`} onClick={() => setSelectedChannelId(channel.id)}>
                # {channel.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat-main">
        <div className="chat-content" ref={chatContentRef}>
          <div className="chat-header">{currentServer ? `Сервер ${currentServer.name}` : "Server"}</div>
          <div className="chat-subheader">{currentChannel ? `# ${currentChannel.name}` : "Channel not selected"}</div>
          {error ? <div className="messages-empty">{error}</div> : null}
          <MessageList messages={activeMessages} />
        </div>
        <MessageInput onSend={handleSend} disabled={!isConnected || selectedChannelId <= 0} />
      </section>

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
    </div>
  );
}