import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import { ChatSocket } from "../services/chatSocket.ts";
import { clearAuthStorage } from "../services/authToken.ts";
import type { Channel, ChannelsByServer, Message, MessagesByChannel, Server } from "../types/chat.ts";
import "../styles/chat.css";

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getNextNumericName(items: Array<{ name: string }>, fallback = 1): string {
  const numericNames = items.map((item) => Number(item.name)).filter((value) => Number.isInteger(value) && value > 0);

  if (!numericNames.length) return String(fallback);

  return String(Math.max(...numericNames) + 1);
}

export default function ChatPage() {
  const navigate = useNavigate();
  const socketRef = useRef<ChatSocket | null>(null);
  const selectedServerIdRef = useRef(0);

  const [servers, setServers] = useState<Server[]>([]);
  const [channelsByServer, setChannelsByServer] = useState<ChannelsByServer>({});
  const [selectedServerId, setSelectedServerId] = useState<number>(0);
  const [selectedChannelId, setSelectedChannelId] = useState<number>(0);
  const [messagesByChannel, setMessagesByChannel] = useState<MessagesByChannel>({});
  const [loadedChannels, setLoadedChannels] = useState<Record<number, boolean>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState("");

  function handleAuthFailure(message: string): void {
    clearAuthStorage();
    setError(message);
    navigate("/login", { replace: true });
  }

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
        handleAuthFailure("Сессия истекла, войдите снова");
        return;
      }
      setError(text);
    });

    (async () => {
      try {
        await socket.connect();
        setIsConnected(true);
        setError("");

        let persistedServers = readJson<Server[]>(CHAT_SERVERS_KEY, []);
        let persistedChannels = readJson<ChannelsByServer>(CHAT_CHANNELS_BY_SERVER_KEY, {});
        let persistedSelectedServer = Number(localStorage.getItem(CHAT_SELECTED_SERVER_KEY) ?? "0");

        if (!persistedServers.length) {
          const createdServer = await socket.createServer("1");
          const createdChannel = await socket.createChannel(createdServer.server_id, "1");

          persistedServers = [{ id: createdServer.server_id, name: createdServer.name }];
          persistedChannels = {
            [createdServer.server_id]: [
              { id: createdChannel.channel_id, server_id: createdChannel.server_id, name: createdChannel.name },
            ],
          };
          persistedSelectedServer = createdServer.server_id;

          localStorage.setItem(CHAT_SERVERS_KEY, JSON.stringify(persistedServers));
          localStorage.setItem(CHAT_CHANNELS_BY_SERVER_KEY, JSON.stringify(persistedChannels));
          localStorage.setItem(CHAT_SELECTED_SERVER_KEY, String(persistedSelectedServer));
        }

        const activeServerId = persistedServers.some((server) => server.id === persistedSelectedServer)
          ? persistedSelectedServer
          : persistedServers[0].id;

        const activeChannels = persistedChannels[activeServerId] ?? [];

        setServers(persistedServers);
        setChannelsByServer(persistedChannels);
        setSelectedServerId(activeServerId);
        setSelectedChannelId(activeChannels[0]?.id ?? 0);
        setMessagesByChannel((prev) => {
          const next = { ...prev };
          Object.values(persistedChannels)
            .flat()
            .forEach((channel) => {
              if (!next[channel.id]) {
                next[channel.id] = [];
              }
            });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось подключиться к чату";
        if (message.toLowerCase().includes("требуется повторный вход") || message.toLowerCase().includes("permission denied")) {
          handleAuthFailure("Сессия истекла, войдите снова");
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
  }, [navigate]);

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
        const message = err instanceof Error ? err.message : "Не удалось загрузить сообщения";
        setError(message);
      }
    })();
  }, [selectedChannelId, isConnected, loadedChannels]);

  async function handleAddServer() {
    if (!socketRef.current || !isConnected) {
      setError("Нет подключения к чату");
      return;
    }

    try {
      const nextServerName = getNextNumericName(servers);
      const createdServer = await socketRef.current.createServer(nextServerName);
      const createdFirstChannel = await socketRef.current.createChannel(createdServer.server_id, "1");

      const nextServer: Server = { id: createdServer.server_id, name: createdServer.name };
      const firstChannel: Channel = {
        id: createdFirstChannel.channel_id,
        server_id: createdFirstChannel.server_id,
        name: createdFirstChannel.name,
      };

      setServers((prev) => [...prev, nextServer]);
      setChannelsByServer((prev) => ({ ...prev, [nextServer.id]: [firstChannel] }));
      setMessagesByChannel((prev) => ({ ...prev, [firstChannel.id]: [] }));
      setSelectedServerId(nextServer.id);
      setSelectedChannelId(firstChannel.id);
      setError("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось создать сервер";
      setError(message);
    }
  }

  async function handleAddChannel() {
    if (!socketRef.current || !isConnected || selectedServerId <= 0) {
      setError("Нет подключения к чату");
      return;
    }

    try {
      const currentChannels = channelsByServer[selectedServerId] ?? [];
      const nextName = getNextNumericName(currentChannels);
      const createdChannel = await socketRef.current.createChannel(selectedServerId, nextName);

      const nextChannel: Channel = {
        id: createdChannel.channel_id,
        server_id: createdChannel.server_id,
        name: createdChannel.name,
      };

      setChannelsByServer((prev) => ({
        ...prev,
        [selectedServerId]: [...(prev[selectedServerId] ?? []), nextChannel],
      }));
      setMessagesByChannel((prev) => ({ ...prev, [nextChannel.id]: [] }));
      setSelectedChannelId(nextChannel.id);
      setError("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось создать канал";
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
      const message = err instanceof Error ? err.message : "Не удалось отправить сообщение";
      setError(message);
    }
  }

  function handleSelectServer(serverId: number) {
    setSelectedServerId(serverId);
    const serverChannels = channelsByServer[serverId] ?? [];
    setSelectedChannelId(serverChannels[0]?.id ?? 0);
    setError("");
  }

  const activeChannels = channelsByServer[selectedServerId] ?? [];
  const currentServer = servers.find((server) => server.id === selectedServerId);
  const currentChannel = activeChannels.find((channel) => channel.id === selectedChannelId);
  const activeMessages: Message[] = selectedChannelId > 0 ? messagesByChannel[selectedChannelId] ?? [] : [];

  return (
    <div className="chat-layout">
      <aside className="servers-sidebar">
        <button className="server-add-btn" onClick={handleAddServer} aria-label="Добавить сервер" title="Добавить сервер">
          +
        </button>
        <ul className="servers-list">
          {servers.map((server) => (
            <li key={server.id}>
              <button
                className={`server-dot ${selectedServerId === server.id ? "active" : ""}`}
                onClick={() => handleSelectServer(server.id)}
                title={`Сервер ${server.name}`}
                aria-label={`Сервер ${server.name}`}
              >
                {server.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <aside className="channels-sidebar">
        <div className="channels-header">
          <span>Сервер {currentServer?.name ?? "-"}</span>
          <button className="channels-add-btn" onClick={handleAddChannel} aria-label="Добавить канал" title="Добавить канал">
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
        <div className="chat-content">
          <div className="chat-header">{currentServer ? `Сервер ${currentServer.name}` : "Сервер"}</div>
          <div className="chat-subheader">{currentChannel ? `# ${currentChannel.name}` : "Канал не выбран"}</div>
          {error ? <div className="messages-empty">{error}</div> : null}
          <MessageList messages={activeMessages} />
        </div>
        <MessageInput onSend={handleSend} disabled={!isConnected || selectedChannelId <= 0} />
      </section>
    </div>
  );
}