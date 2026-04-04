import type { Message } from "../types/chat";

type WsEvent = {
  event: "ack" | "error" | "message" | "connected";
  error?: string;
  data?: unknown;
};

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

type MessageListener = (message: Message) => void;
type ErrorListener = (message: string) => void;

function resolveWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  const apiBase = import.meta.env.VITE_API_URL || "/api/v1";
  if (apiBase.startsWith("http://") || apiBase.startsWith("https://")) {
    const apiUrl = new URL(apiBase);
    apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    apiUrl.pathname = `${apiUrl.pathname.replace(/\/$/, "")}/server/ws`;
    const token = localStorage.getItem("token");
    if (token) {
      apiUrl.searchParams.set("token", token);
    }
    return apiUrl.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const normalizedBase = apiBase.startsWith("/") ? apiBase : `/${apiBase}`;
  const wsUrl = new URL(`${protocol}://${window.location.host}${normalizedBase}/server/ws`);
  const token = localStorage.getItem("token");
  if (token) {
    wsUrl.searchParams.set("token", token);
  }

  return wsUrl.toString();
}

function toMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<Message>;
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
    content: candidate.content,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : new Date().toISOString(),
  };
}

export class ChatSocket {
  private socket: WebSocket | null = null;

  private pending: PendingCommand | null = null;

  private readonly messageListeners = new Set<MessageListener>();

  private readonly errorListeners = new Set<ErrorListener>();

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(resolveWsUrl());
      this.socket = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Не удалось подключиться к чату"));
      ws.onclose = () => {
        this.pending?.reject(new Error("Соединение WebSocket закрыто"));
        this.pending = null;
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
          if (this.pending) {
            this.pending.reject(new Error(text));
            this.pending = null;
          }
          this.errorListeners.forEach((listener) => listener(text));
          return;
        }

        if (parsed.event === "ack" && this.pending) {
          this.pending.resolve(parsed.data);
          this.pending = null;
        }
      };
    });
  }

  close(): void {
    this.pending = null;
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

  private sendCommand(action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket не подключен"));
    }
    if (this.pending) {
      return Promise.reject(new Error("Подождите завершения предыдущего запроса"));
    }

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };

      this.socket?.send(
        JSON.stringify({
          action,
          payload,
        }),
      );
    });
  }
}


