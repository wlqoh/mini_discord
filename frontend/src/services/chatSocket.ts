import type {
  ChannelUnread,
  JoinVoiceResponse,
  LinkPreview,
  Message,
  OnlineUser,
  ReplyPreview,
  SearchFilters, SearchHit, SearchScope, ServerMember, TypingEvent, UserProfile,
  SfuActiveSpeakersEvent,
  SfuAnswerPayload,
  SfuCandidatePayload,
  SfuErrorEvent,
  SfuOfferEvent,
  SfuResumeResponse,
  SfuSlotDecl,
  SfuTrackEvent,
  VoiceChannelParticipants,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
import { getValidAccessToken } from "./authToken";

// Server → client event envelope
type WsServerEvent = {
  event: string;
  request_id?: string;
  error?: string;
  data?: unknown;
};

// ── Ack data shapes per command ──────────────────────────────────────────────

type CreateChannelAck = {
  channel_id?: number;
  server_id?: number;
  name?: string;
  type?: "text" | "voice";
};

type CreateServerAck = {
  server_id?: number;
  name?: string;
};

type GetMessagesAck = {
  channel_id?: number;
  messages?: unknown[];
  next_cursor?: string;
  has_more?: boolean;
};

type GetServersAck = {
  servers?: Array<{ id?: number; name?: string; owner_id?: number }>;
};

type GetMessagesAroundAck = {
  channel_id?: number;
  messages?: unknown[];
  older_cursor?: string;
  newer_cursor?: string;
  has_more_older?: boolean;
  has_more_newer?: boolean;
};

type GetMessagesAfterAck = {
  channel_id?: number;
  messages?: unknown[];
  next_cursor?: string;
  has_more?: boolean;
};

type SearchMessagesAck = {
  hits?: Array<{
    message_id?: number;
    channel_id?: number;
    channel_name?: string;
    author_id?: number;
    author_first_name?: string;
    author_last_name?: string;
    author_nickname?: string;
    author_avatar_url?: string;
    headline?: string;
    created_at?: string;
  }>;
  next_cursor?: string;
  has_more?: boolean;
};

type VoiceParticipantRaw = {
  user_id?: number;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  avatar_url?: string;
  mic_enabled?: boolean;
  deafened?: boolean;
};

type GetServerChannelsAck = {
  channels?: Array<{ id?: number; server_id?: number; name?: string; type?: string }>;
  voice_participants?: Array<{
    channel_id?: number;
    participants?: VoiceParticipantRaw[];
  }>;
};

type GetUsersOnlineAck = {
  users?: Array<{
    first_name?: string;
    last_name?: string;
    nickname?: string;
    user_id?: number;
    avatar_url?: string;
    email?: string;
  }>;
};

type SearchServersAck = {
  servers?: Array<{ id?: number; name?: string }>;
};

type GetServerMembersAck = {
  members?: Array<{
    user_id?: number;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    avatar_url?: string;
  }>;
};

type GetUserInfoAck = {
  user_id?: number;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  avatar_url?: string;
};

type GetUnreadAck = {
  channels?: Array<{ channel_id?: number; server_id?: number; unread_count?: number }>;
};

// ── Internal queue types ─────────────────────────────────────────────────────

type PendingCommand = {
  action: string;
  requestId: string;
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
type SfuOfferListener = (event: SfuOfferEvent) => void;
type SfuAnswerListener = (event: SfuAnswerPayload) => void;
type SfuCandidateListener = (event: SfuCandidatePayload) => void;
type SfuTrackListener = (event: SfuTrackEvent) => void;
type SfuActiveSpeakersListener = (event: SfuActiveSpeakersEvent) => void;
type SfuErrorListener = (event: SfuErrorEvent) => void;
type TypingListener = (event: TypingEvent, isTyping: boolean) => void;
type ReconnectPhase = "lost" | "restored";
type ReconnectListener = (phase: ReconnectPhase) => void;

export type MessageEmbedsEvent = {
  channel_id: number;
  message_id: number;
  embeds: LinkPreview[];
};

type MessageEmbedsListener = (event: MessageEmbedsEvent) => void;

export type MessageEditedEvent = {
  channel_id: number;
  message_id: number;
  content: string;
  edited_at: string;
};

type MessageEditedListener = (event: MessageEditedEvent) => void;

// ── Raw shapes for WS message parsing ───────────────────────────────────────

type AuthorRaw = {
  first_name?: string;
  last_name?: string;
  nickname?: string;
  firstName?: string;
  lastName?: string;
  nickName?: string;
};

type RawReplyTo = {
  message_id?: unknown;
  author_id?: unknown;
  author_first_name?: unknown;
  author_last_name?: unknown;
  author_nickname?: unknown;
  content?: unknown;
  has_attachments?: unknown;
};

type RawMessage = {
  id?: unknown;
  channel_id?: unknown;
  author_id?: unknown;
  content?: unknown;
  created_at?: unknown;
  author_first_name?: unknown;
  author_last_name?: unknown;
  author_nickname?: unknown;
  author_avatar_url?: unknown;
  auuthor_avatar_url?: unknown; // server-side typo kept for compat
  authorAvatarUrl?: unknown;
  avatar_url?: unknown;
  nickname?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  authorFirstName?: unknown;
  authorLastName?: unknown;
  author?: AuthorRaw | null;
  attachments?: unknown;
  reply_to_id?: unknown;
  reply_to?: RawReplyTo | null;
  mentions?: unknown;
  mentions_everyone?: unknown;
  embeds?: unknown;
  edited_at?: unknown;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function parseAttachments(raw: unknown): Message["attachments"] {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      url: typeof item.url === "string" ? item.url : "",
      file_name: typeof item.file_name === "string" ? item.file_name : "",
      content_type: typeof item.content_type === "string" ? item.content_type : "",
    }))
    .filter((item) => Boolean(item.url));
}

function parseEmbeds(raw: unknown): LinkPreview[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      url: typeof item.url === "string" ? item.url : "",
      title: typeof item.title === "string" ? item.title : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      site_name: typeof item.site_name === "string" ? item.site_name : undefined,
      image_token: typeof item.image_token === "string" ? item.image_token : undefined,
    }))
    .filter((item) => Boolean(item.url));
}

function toMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as RawMessage;
  if (
    typeof candidate.channel_id !== "number" ||
    typeof candidate.author_id !== "number" ||
    typeof candidate.content !== "string"
  ) {
    return null;
  }

  const authorFirstName =
    (typeof candidate.author_first_name === "string" && candidate.author_first_name) ||
    (candidate.author?.first_name ?? "") ||
    (candidate.author?.firstName ?? "") ||
    (typeof candidate.first_name === "string" && candidate.first_name) ||
    (typeof candidate.authorFirstName === "string" && candidate.authorFirstName) ||
    "";

  const authorLastName =
    (typeof candidate.author_last_name === "string" && candidate.author_last_name) ||
    (candidate.author?.last_name ?? "") ||
    (candidate.author?.lastName ?? "") ||
    (typeof candidate.last_name === "string" && candidate.last_name) ||
    (typeof candidate.authorLastName === "string" && candidate.authorLastName) ||
    "";

  const authorNickname =
    (typeof candidate.author_nickname === "string" && candidate.author_nickname) ||
    (candidate.author?.nickname ?? "") ||
    (candidate.author?.nickName ?? "") ||
    (typeof candidate.nickname === "string" && candidate.nickname) ||
    "";

  const authorAvatarUrl =
    (typeof candidate.author_avatar_url === "string" && candidate.author_avatar_url) ||
    (typeof candidate.auuthor_avatar_url === "string" && candidate.auuthor_avatar_url) ||
    (typeof candidate.authorAvatarUrl === "string" && candidate.authorAvatarUrl) ||
    (typeof candidate.avatar_url === "string" && candidate.avatar_url) ||
    "";

  const replyToId: number | null | undefined =
    candidate.reply_to_id !== undefined && candidate.reply_to_id !== null
      ? (typeof candidate.reply_to_id === "number" ? candidate.reply_to_id : null)
      : undefined;

  let replyTo: ReplyPreview | null | undefined = undefined;
  if (candidate.reply_to != null) {
    const r = candidate.reply_to;
    if (typeof r.message_id === "number") {
      replyTo = {
        message_id: r.message_id,
        author_id: typeof r.author_id === "number" ? r.author_id : 0,
        author_first_name: typeof r.author_first_name === "string" ? r.author_first_name : "",
        author_last_name: typeof r.author_last_name === "string" ? r.author_last_name : "",
        author_nickname: typeof r.author_nickname === "string" ? r.author_nickname : undefined,
        content: typeof r.content === "string" ? r.content : "",
        has_attachments: typeof r.has_attachments === "boolean" ? r.has_attachments : false,
      };
    }
  } else if (replyToId === null) {
    replyTo = null;
  }

  return {
    id: typeof candidate.id === "number" ? candidate.id : 0,
    channel_id: candidate.channel_id,
    author_id: candidate.author_id,
    author_first_name: authorFirstName,
    author_last_name: authorLastName,
    author_nickname: authorNickname,
    author_avatar_url: authorAvatarUrl,
    content: candidate.content,
    attachments: parseAttachments(candidate.attachments),
    reply_to_id: replyToId,
    reply_to: replyTo,
    mentions: Array.isArray(candidate.mentions)
      ? candidate.mentions.filter((id): id is number => typeof id === "number")
      : undefined,
    mentions_everyone: typeof candidate.mentions_everyone === "boolean" ? candidate.mentions_everyone : undefined,
    embeds: parseEmbeds(candidate.embeds),
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : new Date().toISOString(),
    edited_at: typeof candidate.edited_at === "string" ? candidate.edited_at : undefined,
  };
}

// ── ChatSocket class ─────────────────────────────────────────────────────────

export class ChatSocket {
  private socket: WebSocket | null = null;

  private pending: PendingCommand | null = null;

  private queue: QueuedCommand[] = [];

  // Only handlers dispatched off the hub's Run() loop (search_messages,
  // get_messages_around/after) echo this back — see the comment on
  // types.WsCommand.RequestID server-side. It exists so a response that
  // arrives after the client already timed out and moved on to the next
  // queued command can be recognized as stale instead of resolving that next
  // command with the wrong data.
  private nextRequestId = 1;

  private connectionPromise: Promise<void> | null = null;

  private static readonly COMMAND_TIMEOUT_MS = 10000;

  // Autoreconnect: nginx (and most intermediate proxies) close an idle WS
  // after ~60s, and the server-side ping alone can't prevent every network
  // hiccup. Without this, a dropped connection stranded the user until they
  // reloaded the page — including mid voice call.
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private readonly reconnectListeners = new Set<ReconnectListener>();

  private readonly messageListeners = new Set<MessageListener>();

  private readonly messageEmbedsListeners = new Set<MessageEmbedsListener>();

  private readonly messageEditedListeners = new Set<MessageEditedListener>();

  private readonly errorListeners = new Set<ErrorListener>();

  private readonly voiceParticipantsListeners = new Set<VoiceParticipantsListener>();

  private readonly voiceUserJoinedListeners = new Set<VoiceUserListener>();

  private readonly voiceUserLeftListeners = new Set<VoiceUserListener>();

  private readonly voiceStatusChangedListeners = new Set<VoiceUserListener>();

  // Migration phase 3, decision #10: fired around an SFU session's grace
  // period. Media never stops flowing either way — these are purely a UI
  // affordance (dim the tile while reconnecting), not a membership change.
  private readonly voiceUserDetachedListeners = new Set<VoiceUserListener>();
  private readonly voiceUserResumedListeners = new Set<VoiceUserListener>();

  private readonly sfuOfferListeners = new Set<SfuOfferListener>();
  private readonly sfuAnswerListeners = new Set<SfuAnswerListener>();
  private readonly sfuCandidateListeners = new Set<SfuCandidateListener>();
  private readonly sfuTrackPublishedListeners = new Set<SfuTrackListener>();
  private readonly sfuTrackUnpublishedListeners = new Set<SfuTrackListener>();
  private readonly sfuActiveSpeakersListeners = new Set<SfuActiveSpeakersListener>();
  private readonly sfuErrorListeners = new Set<SfuErrorListener>();

  private readonly typingListeners = new Set<TypingListener>();

  private flushQueue(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.pending || !this.queue.length) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const requestId = `r${this.nextRequestId++}`;

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
      action: next.action,
      requestId,
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
        request_id: requestId,
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

  private handleSocketError(text: string, requestId?: string): void {
    // A request_id that doesn't match the current pending command means this
    // error belongs to one the client already timed out on and abandoned —
    // surface it as a generic error, but don't reject whatever is pending now.
    if (requestId && this.pending && this.pending.requestId !== requestId) {
      this.errorListeners.forEach((listener) => listener(text));
      return;
    }

    const pendingAction = this.pending?.action;
    const isUnsupportedGetUserInfo =
      pendingAction === "get_user_info" && text.toLowerCase().includes("unknown action");

    if (this.pending) {
      this.pending.reject(new Error(text));
      this.pending = null;
      this.flushQueue();
    }
    if (!isUnsupportedGetUserInfo) {
      this.errorListeners.forEach((listener) => listener(text));
    }
  }

  /**
   * Subscribes to reconnect lifecycle. "lost" fires as soon as the socket
   * drops (before any retry); "restored" fires once a reconnect attempt
   * actually reopens the connection. Callers that hold state tied to a
   * connection's lifetime (e.g. voice channel membership, which the server
   * drops on disconnect) should re-establish it on "restored".
   */
  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) {
      return;
    }

    const attempt = ++this.reconnectAttempt;
    // 0.5s, 1s, 2s, 4s, 8s, capped at 15s, plus jitter to avoid every tab
    // reconnecting in lockstep after a backend restart.
    const base = Math.min(15000, 500 * 2 ** (attempt - 1));
    const delay = base + Math.floor(Math.random() * 500);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect()
        .then(() => {
          this.reconnectAttempt = 0;
          this.reconnectListeners.forEach((listener) => listener("restored"));
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.closedByUser = false;

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
        if (!this.closedByUser) {
          this.reconnectListeners.forEach((listener) => listener("lost"));
          this.scheduleReconnect();
        }
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let parsed: WsServerEvent;
        try {
          parsed = JSON.parse(event.data) as WsServerEvent;
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

        if (parsed.event === "message_embeds") {
          const payload = parsed.data as { channel_id?: unknown; message_id?: unknown; embeds?: unknown };
          if (payload && typeof payload.channel_id === "number" && typeof payload.message_id === "number") {
            const event: MessageEmbedsEvent = {
              channel_id: payload.channel_id,
              message_id: payload.message_id,
              embeds: parseEmbeds(payload.embeds),
            };
            this.messageEmbedsListeners.forEach((listener) => listener(event));
          }
          return;
        }

        if (parsed.event === "message_edited") {
          const payload = parsed.data as {
            channel_id?: unknown;
            message_id?: unknown;
            content?: unknown;
            edited_at?: unknown;
          };
          if (
            payload &&
            typeof payload.channel_id === "number" &&
            typeof payload.message_id === "number" &&
            typeof payload.content === "string"
          ) {
            const event: MessageEditedEvent = {
              channel_id: payload.channel_id,
              message_id: payload.message_id,
              content: payload.content,
              // edited_at сервер ставит всегда; запасной вариант нужен лишь
              // чтобы метка «изменено» не пропала при неожиданном формате.
              edited_at: typeof payload.edited_at === "string" ? payload.edited_at : new Date().toISOString(),
            };
            this.messageEditedListeners.forEach((listener) => listener(event));
          }
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

        if (parsed.event === "voice_status_changed") {
          const payload = parsed.data as VoiceUserEvent;

          if (
              payload &&
              typeof payload.channel_id === "number" &&
              payload.user &&
              typeof payload.user.user_id === "number"
          ) {
            this.voiceStatusChangedListeners.forEach((listener) => listener(payload));
          }

          return;
        }

        if (parsed.event === "voice_user_detached") {
          const payload = parsed.data as VoiceUserEvent;
          if (payload && typeof payload.channel_id === "number" && payload.user && typeof payload.user.user_id === "number") {
            this.voiceUserDetachedListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "voice_user_resumed") {
          const payload = parsed.data as VoiceUserEvent;
          if (payload && typeof payload.channel_id === "number" && payload.user && typeof payload.user.user_id === "number") {
            this.voiceUserResumedListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "typing_start" || parsed.event === "typing_stop") {
          const payload = parsed.data as TypingEvent;
          if (payload && typeof payload.channel_id === "number" && typeof payload.user_id === "number") {
            const isTyping = parsed.event === "typing_start";
            this.typingListeners.forEach((listener) => listener(payload, isTyping));
          }
          return;
        }

        // sfu_offer/sfu_answer are pushed by the SERVER here (a
        // renegotiation offer, or the answer to our own initial offer) —
        // distinct from the "ack" our own sfu_offer/sfu_answer *commands*
        // get (handled by the generic ack branch below via sendCommand).
        // Same event name, different direction; they never collide because
        // this switches on parsed.event, not on what we last sent.
        if (parsed.event === "sfu_offer") {
          const payload = parsed.data as SfuOfferEvent;
          if (payload && typeof payload.session_id === "string" && typeof payload.sdp === "string") {
            this.sfuOfferListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_answer") {
          const payload = parsed.data as SfuAnswerPayload;
          if (payload && typeof payload.session_id === "string" && typeof payload.sdp === "string") {
            this.sfuAnswerListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_candidate") {
          const payload = parsed.data as SfuCandidatePayload;
          if (payload && typeof payload.session_id === "string" && typeof payload.candidate === "string") {
            this.sfuCandidateListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_track_published") {
          const payload = parsed.data as SfuTrackEvent;
          if (payload && typeof payload.channel_id === "number" && typeof payload.user_id === "number") {
            this.sfuTrackPublishedListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_track_unpublished") {
          const payload = parsed.data as SfuTrackEvent;
          if (payload && typeof payload.channel_id === "number" && typeof payload.user_id === "number") {
            this.sfuTrackUnpublishedListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_active_speakers") {
          const payload = parsed.data as SfuActiveSpeakersEvent;
          if (payload && typeof payload.channel_id === "number" && Array.isArray(payload.user_ids)) {
            this.sfuActiveSpeakersListeners.forEach((listener) => listener(payload));
          }
          return;
        }

        if (parsed.event === "sfu_error") {
          // sfu_candidate is sent fire-and-forget, so its errors must never
          // touch the ack queue.
          const payload = parsed.data as SfuErrorEvent | undefined;
          this.sfuErrorListeners.forEach((listener) =>
            listener(payload ?? { session_id: "", code: "unknown", message: parsed.error || "SFU error" }),
          );
          return;
        }

        if (parsed.event === "error") {
          const text = parsed.error || "Chat error";
          this.handleSocketError(text, parsed.request_id);
          return;
        }

        if (parsed.event === "ack" && this.pending) {
          // Same staleness guard as handleSocketError: only handlers dispatched
          // off the hub's main loop echo request_id, so this only ever rejects
          // a response for a command the client has already timed out on.
          if (parsed.request_id && parsed.request_id !== this.pending.requestId) {
            return;
          }
          this.pending.resolve(parsed.data);
          this.pending = null;
          this.flushQueue();
          return;
        }

        // Some gateway/proxy responses may come without `event`, but with `error`.
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          this.handleSocketError(parsed.error, parsed.request_id);
        }
      };
    });

    return this.connectionPromise;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectionPromise = null;
    this.rejectAllPending(new Error("The WebSocket connection was closed."));
    this.socket?.close();
    this.socket = null;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onMessageEmbeds(listener: MessageEmbedsListener): () => void {
    this.messageEmbedsListeners.add(listener);
    return () => this.messageEmbedsListeners.delete(listener);
  }

  onMessageEdited(listener: MessageEditedListener): () => void {
    this.messageEditedListeners.add(listener);
    return () => this.messageEditedListeners.delete(listener);
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

  onVoiceStatusChanged(listener: VoiceUserListener): () => void {
    this.voiceStatusChangedListeners.add(listener);
    return () => this.voiceStatusChangedListeners.delete(listener);
  }

  onVoiceUserDetached(listener: VoiceUserListener): () => void {
    this.voiceUserDetachedListeners.add(listener);
    return () => this.voiceUserDetachedListeners.delete(listener);
  }

  onVoiceUserResumed(listener: VoiceUserListener): () => void {
    this.voiceUserResumedListeners.add(listener);
    return () => this.voiceUserResumedListeners.delete(listener);
  }

  onSfuOffer(listener: SfuOfferListener): () => void {
    this.sfuOfferListeners.add(listener);
    return () => this.sfuOfferListeners.delete(listener);
  }

  onSfuAnswer(listener: SfuAnswerListener): () => void {
    this.sfuAnswerListeners.add(listener);
    return () => this.sfuAnswerListeners.delete(listener);
  }

  onSfuCandidate(listener: SfuCandidateListener): () => void {
    this.sfuCandidateListeners.add(listener);
    return () => this.sfuCandidateListeners.delete(listener);
  }

  onSfuTrackPublished(listener: SfuTrackListener): () => void {
    this.sfuTrackPublishedListeners.add(listener);
    return () => this.sfuTrackPublishedListeners.delete(listener);
  }

  onSfuTrackUnpublished(listener: SfuTrackListener): () => void {
    this.sfuTrackUnpublishedListeners.add(listener);
    return () => this.sfuTrackUnpublishedListeners.delete(listener);
  }

  onSfuActiveSpeakers(listener: SfuActiveSpeakersListener): () => void {
    this.sfuActiveSpeakersListeners.add(listener);
    return () => this.sfuActiveSpeakersListeners.delete(listener);
  }

  onSfuError(listener: SfuErrorListener): () => void {
    this.sfuErrorListeners.add(listener);
    return () => this.sfuErrorListeners.delete(listener);
  }

  onTyping(listener: TypingListener): () => void {
    this.typingListeners.add(listener);
    return () => this.typingListeners.delete(listener);
  }

  async createChannel(
    serverId: number,
    name: string,
    type: "text" | "voice" = "text",
  ): Promise<{ channel_id: number; server_id: number; name: string; type: "text" | "voice" }> {
    const payload = await this.sendCommand<CreateChannelAck>("create_channel", { server_id: serverId, name, type });

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
    const payload = await this.sendCommand<CreateServerAck>("create_server", { name });

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

  async sendMessage(channelId: number, content: string, attachmentIds?: number[], replyToId?: number | null): Promise<void> {
    const payload: Record<string, unknown> = { channel_id: channelId, content };
    if (attachmentIds && attachmentIds.length > 0) {
      payload.attachment_ids = attachmentIds;
    }
    if (replyToId != null) {
      payload.reply_to_id = replyToId;
    }
    await this.sendCommand("send_message", payload);
  }

  async getMessages(
    channelId: number,
    limit = 100,
    cursor?: string,
  ): Promise<{ messages: Message[]; nextCursor: string; hasMore: boolean }> {
    const requestPayload: Record<string, unknown> = { channel_id: channelId, limit };
    if (cursor) {
      requestPayload.cursor = cursor;
    }
    const payload = await this.sendCommand<GetMessagesAck>("get_messages", requestPayload);

    const messages = Array.isArray(payload?.messages)
      ? payload.messages.map((item) => toMessage(item)).filter((item): item is Message => item !== null)
      : [];

    return {
      messages,
      nextCursor: typeof payload?.next_cursor === "string" ? payload.next_cursor : "",
      hasMore: payload?.has_more === true,
    };
  }

  /**
   * Opens a two-sided window of history centered on messageId, for jumping
   * straight to an arbitrary message (a search hit, a reply preview, a push
   * notification target) without walking getMessages backward page by page.
   */
  async getMessagesAround(
    channelId: number,
    messageId: number,
    limit = 25,
  ): Promise<{
    messages: Message[];
    olderCursor: string;
    newerCursor: string;
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
  }> {
    const payload = await this.sendCommand<GetMessagesAroundAck>("get_messages_around", {
      channel_id: channelId,
      message_id: messageId,
      limit,
    });

    const messages = Array.isArray(payload?.messages)
      ? payload.messages.map((item) => toMessage(item)).filter((item): item is Message => item !== null)
      : [];

    return {
      messages,
      olderCursor: typeof payload?.older_cursor === "string" ? payload.older_cursor : "",
      newerCursor: typeof payload?.newer_cursor === "string" ? payload.newer_cursor : "",
      hasMoreOlder: payload?.has_more_older === true,
      hasMoreNewer: payload?.has_more_newer === true,
    };
  }

  /**
   * Forward-pagination counterpart to getMessages (which only loads
   * backward) — used to walk a windowed view opened by getMessagesAround
   * back down to the live tail.
   */
  async getMessagesAfter(
    channelId: number,
    cursor: string,
    limit = 50,
  ): Promise<{ messages: Message[]; nextCursor: string; hasMore: boolean }> {
    const payload = await this.sendCommand<GetMessagesAfterAck>("get_messages_after", {
      channel_id: channelId,
      cursor,
      limit,
    });

    const messages = Array.isArray(payload?.messages)
      ? payload.messages.map((item) => toMessage(item)).filter((item): item is Message => item !== null)
      : [];

    return {
      messages,
      nextCursor: typeof payload?.next_cursor === "string" ? payload.next_cursor : "",
      hasMore: payload?.has_more === true,
    };
  }

  async searchMessages(
    query: string,
    scope: SearchScope,
    scopeId: number,
    filters?: SearchFilters,
    cursor?: string,
    limit = 25,
  ): Promise<{ hits: SearchHit[]; nextCursor: string; hasMore: boolean }> {
    const requestPayload: Record<string, unknown> = { query, limit };
    if (scope === "server") {
      requestPayload.server_id = scopeId;
    } else {
      requestPayload.channel_id = scopeId;
    }
    if (filters?.authorId) requestPayload.author_id = filters.authorId;
    if (filters?.hasFile) requestPayload.has_file = true;
    if (filters?.hasLink) requestPayload.has_link = true;
    if (filters?.before) requestPayload.before = filters.before;
    if (filters?.after) requestPayload.after = filters.after;
    if (cursor) requestPayload.cursor = cursor;

    const payload = await this.sendCommand<SearchMessagesAck>("search_messages", requestPayload);

    const hits: SearchHit[] = Array.isArray(payload?.hits)
      ? payload.hits
        .filter((hit) => hit != null && typeof hit.message_id === "number" && typeof hit.channel_id === "number")
        .map((hit) => ({
          message_id: hit.message_id as number,
          channel_id: hit.channel_id as number,
          channel_name: typeof hit.channel_name === "string" ? hit.channel_name : "",
          author_id: typeof hit.author_id === "number" ? hit.author_id : 0,
          author_first_name: hit.author_first_name,
          author_last_name: hit.author_last_name,
          author_nickname: hit.author_nickname,
          author_avatar_url: hit.author_avatar_url,
          headline: typeof hit.headline === "string" ? hit.headline : "",
          created_at: typeof hit.created_at === "string" ? hit.created_at : new Date().toISOString(),
        }))
      : [];

    return {
      hits,
      nextCursor: typeof payload?.next_cursor === "string" ? payload.next_cursor : "",
      hasMore: payload?.has_more === true,
    };
  }

  async getServers(): Promise<Array<{ id: number; name: string; owner_id: number }>> {
    const payload = await this.sendCommand<GetServersAck>("get_servers", {});

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

  async deleteMessage(messageId: number): Promise<void> {
    await this.sendCommand("delete_message", { message_id: messageId });
  }

  async editMessage(messageId: number, content: string): Promise<void> {
    await this.sendCommand("edit_message", { message_id: messageId, content });
  }

  async getServerChannels(serverId: number): Promise<Array<{ id: number; server_id: number; name: string; type: "text" | "voice" }>> {
    const state = await this.getServerChannelsState(serverId);
    return state.channels;
  }

  async getServerChannelsState(serverId: number): Promise<{
    channels: Array<{ id: number; server_id: number; name: string; type: "text" | "voice" }>;
    voice_participants: VoiceChannelParticipants[];
  }> {
    const payload = await this.sendCommand<GetServerChannelsAck>("get_server_channels", { server_id: serverId });

    const channels: Array<{ id: number; server_id: number; name: string; type: "text" | "voice" }> = Array.isArray(payload?.channels)
      ? payload.channels
          .filter((channel) => typeof channel.id === "number" && typeof channel.server_id === "number" && typeof channel.name === "string")
          .map((channel) => ({
            id: channel.id as number,
            server_id: channel.server_id as number,
            name: channel.name as string,
            type: channel.type === "voice" ? "voice" : "text",
          }))
      : [];

    const voice_participants: VoiceChannelParticipants[] = Array.isArray(payload?.voice_participants)
      ? payload.voice_participants
          .filter((entry) => typeof entry?.channel_id === "number")
          .map((entry) => ({
            channel_id: entry.channel_id as number,
            participants: Array.isArray(entry.participants)
              ? entry.participants
                  .filter((participant) => typeof participant?.user_id === "number")
                  .map((participant) => ({
                    user_id: participant.user_id as number,
                    first_name: typeof participant.first_name === "string" ? participant.first_name : undefined,
                    last_name: typeof participant.last_name === "string" ? participant.last_name : undefined,
                    nickname: typeof participant.nickname === "string" ? participant.nickname : undefined,
                    avatar_url: typeof participant.avatar_url === "string" ? participant.avatar_url : undefined,
                    mic_enabled: typeof participant.mic_enabled === "boolean" ? participant.mic_enabled : undefined,
                    deafened: typeof participant.deafened === "boolean" ? participant.deafened : undefined,
                  }))
              : [],
          }))
      : [];

    return { channels, voice_participants };
  }

  async getUsersOnline(serverId: number): Promise<OnlineUser[]> {
    const payload = await this.sendCommand<GetUsersOnlineAck>("get_users_online", { server_id: serverId });

    if (!Array.isArray(payload?.users)) {
      return [];
    }

    return payload.users
      .filter(
        (user) =>
          typeof user.nickname === "string" ||
          typeof user.first_name === "string" ||
          typeof user.last_name === "string" ||
          typeof user.email === "string",
      )
      .map((user) => ({
        first_name: typeof user.first_name === "string" ? user.first_name : undefined,
        last_name: typeof user.last_name === "string" ? user.last_name : undefined,
        nickname: typeof user.nickname === "string" ? user.nickname : undefined,
        user_id: typeof user.user_id === "number" ? user.user_id : undefined,
        avatar_url: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
        email: typeof user.email === "string" ? user.email : undefined,
      }));
  }

  async getServerMembers(serverId: number): Promise<ServerMember[]> {
    const payload = await this.sendCommand<GetServerMembersAck>("get_server_members", { server_id: serverId });

    if (!Array.isArray(payload?.members)) {
      return [];
    }

    return payload.members
      .filter((member) => typeof member.user_id === "number")
      .map((member) => ({
        user_id: member.user_id as number,
        first_name: typeof member.first_name === "string" ? member.first_name : undefined,
        last_name: typeof member.last_name === "string" ? member.last_name : undefined,
        nickname: typeof member.nickname === "string" ? member.nickname : undefined,
        avatar_url: typeof member.avatar_url === "string" ? member.avatar_url : undefined,
      }));
  }

  async joinVoiceChannel(channelId: number): Promise<JoinVoiceResponse> {
    const payload = await this.sendCommand<JoinVoiceResponse>("join_voice_channel", { channel_id: channelId });
    if (!payload || typeof payload.channel_id !== "number" || !Array.isArray(payload.participants)) {
      throw new Error("Invalid join voice response");
    }
    if (payload.transport_mode !== "sfu") {
      throw new Error(`Invalid join voice response: unexpected transport_mode ${JSON.stringify(payload.transport_mode)}`);
    }
    return payload;
  }

  async leaveVoiceChannel(): Promise<void> {
    await this.sendCommand("leave_voice_channel", {});
  }

  async changeVoiceStatus(userId: number, micEnabled: boolean, deafened: boolean): Promise<void> {
    await this.sendCommand("change_voice_status", {
      user_id: userId,
      mic_enabled: micEnabled,
      deafened,
    });
  }

  // sfu_offer/sfu_answer go through sendCommand (awaiting the ack per the
  // protocol table in sfu-migration-plan.md §5.2): there is exactly one
  // PeerConnection per client, so losing one silently is worth surfacing as
  // a rejected promise rather than a fire-and-forget send.
  async sendSfuOffer(sessionId: string, sdp: string, slots: SfuSlotDecl[]): Promise<void> {
    await this.sendCommand("sfu_offer", { session_id: sessionId, sdp, slots });
  }

  async sendSfuAnswer(sessionId: string, sdp: string): Promise<void> {
    await this.sendCommand("sfu_answer", { session_id: sessionId, sdp });
  }

  async sendSfuSubscribeVideo(
    sessionId: string,
    targetUserId: number,
    source: string,
    quality: "off" | "low" | "high",
  ): Promise<void> {
    await this.sendCommand("sfu_subscribe_video", {
      session_id: sessionId,
      target_user_id: targetUserId,
      source,
      quality,
    });
  }

  // sfu_resume (migration phase 3, decision #10): asks the server to keep
  // using the existing SFU session — the PeerConnection never depended on
  // this WebSocket, so a successful resume needs no renegotiation on the
  // client's end at all, just a refreshed participant list.
  async sendSfuResume(sessionId: string): Promise<SfuResumeResponse> {
    const payload = await this.sendCommand<SfuResumeResponse>("sfu_resume", { session_id: sessionId });
    if (!payload || typeof payload.ok !== "boolean" || !Array.isArray(payload.participants)) {
      throw new Error("Invalid sfu_resume response");
    }
    return payload;
  }

  async sendSfuCandidate(payload: SfuCandidatePayload): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    // Fire-and-forget: candidates can burst and are latency-sensitive, so
    // they bypass the ack queue used for commands.
    this.socket.send(
      JSON.stringify({
        action: "sfu_candidate",
        payload,
      }),
    );
  }

  sendTyping(channelId: number, isTyping: boolean): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        action: isTyping ? "typing_start" : "typing_stop",
        payload: { channel_id: channelId },
      }),
    );
  }

  async getUnread(): Promise<ChannelUnread[]> {
    const payload = await this.sendCommand<GetUnreadAck>("get_unread", {});

    if (!Array.isArray(payload?.channels)) {
      return [];
    }

    return payload.channels
      .filter((item) => typeof item.channel_id === "number" && typeof item.unread_count === "number")
      .map((item) => ({
        channel_id: item.channel_id as number,
        server_id: typeof item.server_id === "number" ? item.server_id : 0,
        unread_count: item.unread_count as number,
      }));
  }

  // Fire-and-forget, deliberately bypasses the ack queue (same as sendTyping).
  sendMarkRead(channelId: number, messageId: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        action: "mark_read",
        payload: { channel_id: channelId, message_id: messageId },
      }),
    );
  }

  private sendCommand<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not connected"));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ action, payload, resolve: resolve as (data: unknown) => void, reject });
      this.flushQueue();
    });
  }

  async searchServers(query: string, limit = 20): Promise<Array<{ id: number; name: string }>> {
    const payload = await this.sendCommand<SearchServersAck>("search_servers", { query, limit });

    if (!Array.isArray(payload?.servers)) {
      return [];
    }

    return payload.servers
      .filter((server) => typeof server.id === "number" && typeof server.name === "string")
      .map((server) => ({ id: server.id as number, name: server.name as string }));
  }

  async getUserInfo(userId: number): Promise<UserProfile> {
    const payload = await this.sendCommand<GetUserInfoAck>("get_user_info", { user_id: userId });
    return {
      user_id: typeof payload.user_id === "number" ? payload.user_id : userId,
      first_name: typeof payload.first_name === "string" ? payload.first_name : "",
      last_name: typeof payload.last_name === "string" ? payload.last_name : "",
      nickname: typeof payload.nickname === "string" ? payload.nickname : undefined,
      avatar_url: typeof payload.avatar_url === "string" ? payload.avatar_url : "",
    };
  }
}
