import type {
  JoinVoiceResponse,
  Message,
  OnlineUser,
  RTCSignalEvent,
  RTCSignalPayload,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
import { getValidAccessToken } from "./authToken";

type WsEvent = {
  event:
    | "ack"
    | "error"
    | "message"
    | "connected"
    | "voice_participants"
    | "voice_user_joined"
    | "voice_user_left"
    | "rtc_signal";
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
type VoiceParticipantsListener = (participants: VoiceParticipant[]) => void;
type VoiceUserListener = (event: VoiceUserEvent) => void;
type RTCSignalListener = (event: RTCSignalEvent) => void;

function resolveWsUrl(): string {
  const token = getValidAccessToken();
  if (!token) {
    throw new Error("Re-login required");
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
    author_avatar_url?: unknown;
    auuthor_avatar_url?: unknown;
    authorAvatarUrl?: unknown;
    avatar_url?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    authorFirstName?: unknown;
    authorLastName?: unknown;
    author?: {
      first_name?: unknown;
      last_name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    } | unknown;
  };

  const candidate = raw as RawMessage;
  if (
    typeof candidate.channel_id !== "number" ||
    typeof candidate.author_id !== "number" ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }

  const authorObject =
    candidate.author && typeof candidate.author === "object"
      ? (candidate.author as {
          first_name?: unknown;
          last_name?: unknown;
          firstName?: unknown;
          lastName?: unknown;
        })
      : null;

  const authorFirstName =
    (typeof candidate.author_first_name === "string" && candidate.author_first_name) ||
    (authorObject && typeof authorObject.first_name === "string" ? authorObject.first_name : "") ||
    (authorObject && typeof authorObject.firstName === "string" ? authorObject.firstName : "") ||
    (typeof candidate.first_name === "string" && candidate.first_name) ||
    (typeof candidate.authorFirstName === "string" && candidate.authorFirstName) ||
    "";

  const authorLastName =
    (typeof candidate.author_last_name === "string" && candidate.author_last_name) ||
    (authorObject && typeof authorObject.last_name === "string" ? authorObject.last_name : "") ||
    (authorObject && typeof authorObject.lastName === "string" ? authorObject.lastName : "") ||
    (typeof candidate.last_name === "string" && candidate.last_name) ||
    (typeof candidate.authorLastName === "string" && candidate.authorLastName) ||
    "";

  const authorAvatarUrl =
    (typeof candidate.author_avatar_url === "string" && candidate.author_avatar_url) ||
    (typeof candidate.auuthor_avatar_url === "string" && candidate.auuthor_avatar_url) ||
    (typeof candidate.authorAvatarUrl === "string" && candidate.authorAvatarUrl) ||
    (typeof candidate.avatar_url === "string" && candidate.avatar_url) ||
    "";

  return {
    id: typeof candidate.id === "number" ? candidate.id : 0,
    channel_id: candidate.channel_id,
    author_id: candidate.author_id,
    author_first_name: authorFirstName,
    author_last_name: authorLastName,
    author_avatar_url: authorAvatarUrl,
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

  private readonly voiceParticipantsListeners = new Set<VoiceParticipantsListener>();

  private readonly voiceUserJoinedListeners = new Set<VoiceUserListener>();

  private readonly voiceUserLeftListeners = new Set<VoiceUserListener>();

  private readonly rtcSignalListeners = new Set<RTCSignalListener>();

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
      pending.reject(new Error("Chat response timeout"));
      this.errorListeners.forEach((listener) => listener("Chat response timeout"));
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
        reject(new Error("Failed to connect to chat"));
      };
      ws.onclose = () => {
        this.connectionPromise = null;
        this.rejectAllPending(new Error("The WebSocket connection was closed."));
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

        if (parsed.event === "voice_participants") {
          const payload = parsed.data as { participants?: VoiceParticipant[] };
          if (Array.isArray(payload?.participants)) {
            this.voiceParticipantsListeners.forEach((listener) => listener(payload.participants as VoiceParticipant[]));
          }
          return;
        }

        if (parsed.event === "voice_user_joined") {
          const payload = parsed.data as VoiceUserEvent;
          if (payload && typeof payload.channel_id === "number" && payload.user && typeof payload.user.user_id === "number") {
            this.voiceUserJoinedListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "voice_user_left") {
          const payload = parsed.data as VoiceUserEvent;
          if (payload && typeof payload.channel_id === "number" && payload.user && typeof payload.user.user_id === "number") {
            this.voiceUserLeftListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "rtc_signal") {
          const payload = parsed.data as RTCSignalEvent;
          if (
            payload &&
            typeof payload.channel_id === "number" &&
            typeof payload.from_user_id === "number" &&
            (payload.signal_type === "offer" || payload.signal_type === "answer" || payload.signal_type === "candidate")
          ) {
            this.rtcSignalListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "error") {
          const text = parsed.error || "Chat error";
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
    this.rejectAllPending(new Error("The WebSocket connection was closed."));
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

  onVoiceParticipants(listener: VoiceParticipantsListener): () => void {
    this.voiceParticipantsListeners.add(listener);
    return () => this.voiceParticipantsListeners.delete(listener);
  }

  onVoiceUserJoined(listener: VoiceUserListener): () => void {
    this.voiceUserJoinedListeners.add(listener);
    return () => this.voiceUserJoinedListeners.delete(listener);
  }

  onVoiceUserLeft(listener: VoiceUserListener): () => void {
    this.voiceUserLeftListeners.add(listener);
    return () => this.voiceUserLeftListeners.delete(listener);
  }

  onRTCSignal(listener: RTCSignalListener): () => void {
    this.rtcSignalListeners.add(listener);
    return () => this.rtcSignalListeners.delete(listener);
  }

  async createChannel(
    serverId: number,
    name: string,
    type: "text" | "voice" = "text",
  ): Promise<{ channel_id: number; server_id: number; name: string; type: "text" | "voice" }> {
    const data = await this.sendCommand("create_channel", { server_id: serverId, name, type });
    const payload = data as { channel_id?: number; server_id?: number; name?: string; type?: "text" | "voice" };

    if (
      typeof payload?.channel_id !== "number" ||
      typeof payload?.server_id !== "number" ||
      typeof payload?.name !== "string" ||
      (payload?.type !== "text" && payload?.type !== "voice")
    ) {
      throw new Error("The server returned an invalid response when creating a channel.");
    }

    return {
      channel_id: payload.channel_id,
      server_id: payload.server_id,
      name: payload.name,
      type: payload.type,
    };
  }

  async createServer(name: string): Promise<{ server_id: number; name: string }> {
    const data = await this.sendCommand("create_server", { name });
    const payload = data as { server_id?: number; name?: string };

    if (typeof payload?.server_id !== "number" || typeof payload?.name !== "string") {
      throw new Error("The server returned an invalid response while creating the server.");
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

  async getServers(): Promise<Array<{ id: number; name: string; owner_id: number }>> {
    const data = await this.sendCommand("get_servers", {});
    const payload = data as { servers?: Array<{ id?: number; name?: string; owner_id?: number }> };

    if (!Array.isArray(payload?.servers)) {
      return [];
    }

    return payload.servers
        .filter(
            (server) =>
                typeof server.id === "number" &&
                typeof server.name === "string" &&
                typeof server.owner_id === "number",
        )
        .map((server) => ({
          id: server.id as number,
          name: server.name as string,
          owner_id: server.owner_id as number,
        }));
  }

  async deleteServer(serverId: number): Promise<void> {
    await this.sendCommand("delete_server", { server_id: serverId });
  }

  async deleteChannel(channelId: number): Promise<void> {
    await this.sendCommand("delete_channel", { channel_id: channelId });
  }

  async getServerChannels(serverId: number): Promise<Array<{ id: number; server_id: number; name: string; type: "text" | "voice" }>> {
    const data = await this.sendCommand("get_server_channels", { server_id: serverId });
    const payload = data as { channels?: Array<{ id?: number; server_id?: number; name?: string; type?: string }> };

    if (!Array.isArray(payload?.channels)) {
      return [];
    }

    return payload.channels
      .filter((channel) => typeof channel.id === "number" && typeof channel.server_id === "number" && typeof channel.name === "string")
      .map((channel) => ({
        id: channel.id as number,
        server_id: channel.server_id as number,
        name: channel.name as string,
        type: channel.type === "voice" ? "voice" : "text",
      }));
  }

  async getUsersOnline(serverId: number): Promise<OnlineUser[]> {
    const data = await this.sendCommand("get_users_online", { server_id: serverId });
    const payload = data as { users?: Array<{ first_name?: string; last_name?: string; email?: string }> };

    if (!Array.isArray(payload?.users)) {
      return [];
    }

    return payload.users
      .filter(
        (user) =>
          typeof user.first_name === "string" &&
          typeof user.last_name === "string" &&
          typeof user.email === "string",
      )
      .map((user) => ({
        first_name: user.first_name as string,
        last_name: user.last_name as string,
        email: user.email as string,
      }));
  }

  async joinVoiceChannel(channelId: number): Promise<JoinVoiceResponse> {
    const data = await this.sendCommand("join_voice_channel", { channel_id: channelId });
    const payload = data as JoinVoiceResponse;
    if (!payload || typeof payload.channel_id !== "number" || !Array.isArray(payload.participants)) {
      throw new Error("Invalid join voice response");
    }
    return payload;
  }

  async leaveVoiceChannel(): Promise<void> {
    await this.sendCommand("leave_voice_channel", {});
  }

  async sendRTCSignal(payload: RTCSignalPayload): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    // RTC signaling is latency-sensitive and can burst with ICE candidates,
    // so it bypasses the ack queue used for regular chat commands.
    this.socket.send(
      JSON.stringify({
        action: "rtc_signal",
        payload,
      }),
    );
  }

  private sendCommand(action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not connected"));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ action, payload, resolve, reject });
      this.flushQueue();
    });
  }

  async searchServers(query: string, limit = 20): Promise<Array<{ id: number; name: string }>> {
    const data = await this.sendCommand("search_servers", { query, limit });
    const payload = data as { servers?: Array<{ id?: number; name?: string }> };

    if (!Array.isArray(payload?.servers)) {
      return [];
    }

    return payload.servers
      .filter((server) => typeof server.id === "number" && typeof server.name === "string")
      .map((server) => ({ id: server.id as number, name: server.name as string }));
  }
}

