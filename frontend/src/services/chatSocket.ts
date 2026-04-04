import type { Message } from "../types/chat";
import { getValidAccessToken } from "./authToken";

type WsEvent = {
  event: "ack" | "error" | "message" | "connected";
  error?: string;
  data?: unknown;
};

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

type QueuedCommand = {
  action: string;
  payload: Record<string, unknown>;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

type MessageListener = (message: Message) => void;
type ErrorListener = (message: string) => void;

function resolveWsUrl(): string {
  const token = getValidAccessToken();
  if (!token) {
    throw new Error("Требуется повторный вход в систему");
  }

  if (import.meta.env.VITE_WS_URL) {
    const rawUrl = new URL(import.meta.env.VITE_WS_URL);
    rawUrl.searchParams.set("token", token);
    return rawUrl.toString();
  }

  const apiBase = import.meta.env.VITE_API_URL || "/api/v1";
  if (apiBase.startsWith("http://") || apiBase.startsWith("https://")) {
    const apiUrl = new URL(apiBase);
    apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    apiUrl.pathname = `${apiUrl.pathname.replace(/\/$/, "")}/server/ws`;
    apiUrl.searchParams.set("token", token);
    return apiUrl.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const normalizedBase = apiBase.startsWith("/") ? apiBase : `/${apiBase}`;
  const wsUrl = new URL(`${protocol}://${window.location.host}${normalizedBase}/server/ws`);
  wsUrl.searchParams.set("token", token);

  return wsUrl.toString();
}

function toMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  type RawMessage = Partial<Message> & {
    author_first_name?: unknown;
    author_last_name?: unknown;
  };

  const candidate = raw as RawMessage;
  if (
    typeof candidate.channel_id !== "number" ||
    typeof candidate.author_id !== "number" ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }

  return {
    id: typeof candidate.id === "number" ? candidate.id : 0,
    channel_id: candidate.channel_id,
    author_id: candidate.author_id,
    author_first_name: typeof candidate.author_first_name === "string" ? candidate.author_first_name : "",
    author_last_name: typeof candidate.author_last_name === "string" ? candidate.author_last_name : "",
    content: candidate.content,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : new Date().toISOString(),
  };
}

export class ChatSocket {
  private socket: WebSocket | null = null;

  private pending: PendingCommand | null = null;

  private queue: QueuedCommand[] = [];

  private connectionPromise: Promise<void> | null = null;

  private static readonly COMMAND_TIMEOUT_MS = 10000;

  private readonly messageListeners = new Set<MessageListener>();

  private readonly errorListeners = new Set<ErrorListener>();

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.pending || !this.queue.length) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!this.pending) {
        return;
      }

      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error("Таймаут ответа от чата"));
      this.errorListeners.forEach((listener) => listener("Таймаут ответа от чата"));
      this.flushQueue();
    }, ChatSocket.COMMAND_TIMEOUT_MS);

    this.pending = {
      resolve: (data) => {
        window.clearTimeout(timeoutId);
        next.resolve(data);
      },
      reject: (error) => {
        window.clearTimeout(timeoutId);
        next.reject(error);
      },
      timeoutId,
    };

    this.socket.send(
      JSON.stringify({
        action: next.action,
        payload: next.payload,
      }),
    );
  }

  private rejectAllPending(reason: Error): void {
    if (this.pending) {
      window.clearTimeout(this.pending.timeoutId);
      this.pending.reject(reason);
      this.pending = null;
    }

    if (this.queue.length) {
      const queued = [...this.queue];
      this.queue = [];
      queued.forEach((item) => item.reject(reason));
    }
  }

  private handleSocketError(text: string): void {
    if (this.pending) {
      this.pending.reject(new Error(text));
      this.pending = null;
      this.flushQueue();
    }
    this.errorListeners.forEach((listener) => listener(text));
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(resolveWsUrl());
      this.socket = ws;

      ws.onopen = () => {
        this.connectionPromise = null;
        this.flushQueue();
        resolve();
      };
      ws.onerror = () => {
        this.connectionPromise = null;
        reject(new Error("Не удалось подключиться к чату"));
      };
      ws.onclose = () => {
        this.connectionPromise = null;
        this.rejectAllPending(new Error("Соединение WebSocket закрыто"));
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let parsed: WsEvent;
        try {
          parsed = JSON.parse(event.data) as WsEvent;
        } catch {
          return;
        }

        if (parsed.event === "message") {
          const message = toMessage(parsed.data);
          if (!message) {
            return;
          }

          this.messageListeners.forEach((listener) => listener(message));
          return;
        }

        if (parsed.event === "error") {
          const text = parsed.error || "Ошибка чата";
          this.handleSocketError(text);
          return;
        }

        if (parsed.event === "ack" && this.pending) {
          this.pending.resolve(parsed.data);
          this.pending = null;
          this.flushQueue();
          return;
        }

        // Some gateway/proxy responses may come without `event`, but with `error`.
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          this.handleSocketError(parsed.error);
        }
      };
    });

    return this.connectionPromise;
  }

  close(): void {
    this.connectionPromise = null;
    this.rejectAllPending(new Error("Соединение WebSocket закрыто"));
    this.socket?.close();
    this.socket = null;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async createChannel(serverId: number, name: string): Promise<{ channel_id: number; server_id: number; name: string }> {
    const data = await this.sendCommand("create_channel", { server_id: serverId, name });
    const payload = data as { channel_id?: number; server_id?: number; name?: string };

    if (typeof payload?.channel_id !== "number" || typeof payload?.server_id !== "number" || typeof payload?.name !== "string") {
      throw new Error("Сервер вернул некорректный ответ при создании канала");
    }

    return {
      channel_id: payload.channel_id,
      server_id: payload.server_id,
      name: payload.name,
    };
  }

  async createServer(name: string): Promise<{ server_id: number; name: string }> {
    const data = await this.sendCommand("create_server", { name });
    const payload = data as { server_id?: number; name?: string };

    if (typeof payload?.server_id !== "number" || typeof payload?.name !== "string") {
      throw new Error("Сервер вернул некорректный ответ при создании сервера");
    }

    return {
      server_id: payload.server_id,
      name: payload.name,
    };
  }

  async joinServer(serverId: number): Promise<void> {
    await this.sendCommand("join_server", { server_id: serverId });
  }

  async sendMessage(channelId: number, content: string): Promise<void> {
    await this.sendCommand("send_message", { channel_id: channelId, content });
  }

  async getMessages(channelId: number, limit = 100): Promise<Message[]> {
    const data = await this.sendCommand("get_messages", { channel_id: channelId, limit });
    const payload = data as { messages?: unknown[] };

    if (!Array.isArray(payload?.messages)) {
      return [];
    }

    return payload.messages.map((item) => toMessage(item)).filter((item): item is Message => item !== null);
  }

  async getServers(): Promise<Array<{ id: number; name: string }>> {
    const data = await this.sendCommand("get_servers", {});
    const payload = data as { servers?: Array<{ id?: number; name?: string }> };

    if (!Array.isArray(payload?.servers)) {
      return [];
    }

    return payload.servers
      .filter((server) => typeof server.id === "number" && typeof server.name === "string")
      .map((server) => ({ id: server.id as number, name: server.name as string }));
  }

  async getServerChannels(serverId: number): Promise<Array<{ id: number; server_id: number; name: string }>> {
    const data = await this.sendCommand("get_server_channels", { server_id: serverId });
    const payload = data as { channels?: Array<{ id?: number; server_id?: number; name?: string }> };

    if (!Array.isArray(payload?.channels)) {
      return [];
    }

    return payload.channels
      .filter(
        (channel) =>
          typeof channel.id === "number" &&
          typeof channel.server_id === "number" &&
          typeof channel.name === "string",
      )
      .map((channel) => ({
        id: channel.id as number,
        server_id: channel.server_id as number,
        name: channel.name as string,
      }));
  }

  private sendCommand(action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket не подключен"));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ action, payload, resolve, reject });
      this.flushQueue();
    });
  }
}

