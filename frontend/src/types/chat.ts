export interface Channel {
    id: number;
    server_id: number;
    name: string;
    type: "text" | "voice";
}

export interface Server {
    id: number;
    name: string;
    owner_id: number;
}

export interface Attachment {
    id?: number;
    message_id?: number;
    url: string;
    file_name: string;
    content_type: string;
    size_bytes?: number;
}

export interface LinkPreview {
    url: string;
    title?: string;
    description?: string;
    site_name?: string;
    image_token?: string;
}

export interface ReplyPreview {
    message_id: number;
    author_id: number;
    author_first_name: string;
    author_last_name: string;
    author_nickname?: string;
    content: string;
    has_attachments: boolean;
}

export interface Message {
    id: number;
    channel_id: number;
    author_id: number;
    author_first_name?: string;
    author_last_name?: string;
    author_nickname?: string;
    author_avatar_url?: string;
    content: string;
    attachments?: Attachment[];
    reply_to_id?: number | null;
    reply_to?: ReplyPreview | null;
    mentions?: number[];
    mentions_everyone?: boolean;
    embeds?: LinkPreview[];
    created_at: string;
    // Приходит только у отредактированных сообщений (на бэкенде поле с
    // omitempty). Наличие значения = показываем метку «изменено».
    edited_at?: string;
}

export interface ServerMember {
    user_id: number;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    avatar_url?: string;
}

export interface VoiceParticipant {
    user_id: number;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    avatar_url?: string;
    mic_enabled?: boolean;
    deafened?: boolean
}

export interface VoiceChannelParticipants {
    channel_id: number;
    participants: VoiceParticipant[];
}

export interface OnlineUser {
    first_name?: string;
    last_name?: string;
    nickname?: string;
    user_id?: number;
    avatar_url?: string;
    email?: string;
}

export type VoiceTransportMode = "mesh" | "sfu";

export interface VoiceICEServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface VoicePublishSlot {
    kind: "audio" | "video";
    source: "mic" | "camera" | "screen" | "screen_audio";
}

export interface JoinVoiceResponse {
    channel_id: number;
    participants: VoiceParticipant[];
    // Decided server-side (see sfu-migration-plan.md §3 decision #11) so
    // switching transports doesn't require a frontend rebuild.
    transport_mode: VoiceTransportMode;
    session_id?: string;
    ice_servers?: VoiceICEServer[];
    publish_slots?: VoicePublishSlot[];
}

export interface VoiceUserEvent {
    channel_id: number;
    user: VoiceParticipant;
}

export interface RTCSignalPayload {
    channel_id: number;
    to_user_id: number;
    signal_type: "offer" | "answer" | "candidate";
    sdp?: string;
    candidate?: string;
    sdp_mid?: string;
    sdp_mline_index?: number;
}

export interface RTCSignalEvent {
    channel_id: number;
    from_user_id: number;
    signal_type: "offer" | "answer" | "candidate";
    sdp?: string;
    candidate?: string;
    sdp_mid?: string;
    sdp_mline_index?: number;
}

// --- sfu_* protocol (sfu-migration-plan.md §5) ---

export interface SfuSlotDecl {
    mid: string;
    kind: "audio" | "video";
    source: "mic" | "camera" | "screen" | "screen_audio";
}

export interface SfuOfferEvent {
    session_id: string;
    sdp: string;
}

export interface SfuAnswerPayload {
    session_id: string;
    sdp: string;
}

export interface SfuCandidatePayload {
    session_id: string;
    candidate: string;
    sdp_mid?: string;
    sdp_mline_index?: number;
}

export interface SfuTrackEvent {
    channel_id: number;
    user_id: number;
    source: "mic" | "camera" | "screen" | "screen_audio";
    kind?: "audio" | "video";
}

export interface SfuActiveSpeakersEvent {
    channel_id: number;
    user_ids: number[];
}

export interface SfuErrorEvent {
    session_id: string;
    code: string;
    message: string;
}

export interface SfuResumeResponse {
    ok: boolean;
    participants: VoiceParticipant[];
}

export interface TypingEvent {
    channel_id: number;
    user_id: number;
}

export interface UserProfile {
    user_id: number;
    first_name: string;
    last_name: string;
    nickname?: string;
    avatar_url?: string;
}


export interface ChannelUnread {
    channel_id: number;
    server_id: number;
    unread_count: number;
}

export type MessagesByChannel = Record<number, Message[]>;
export type ChannelsByServer = Record<number, Channel[]>;
export type VoiceParticipantsByChannel = Record<number, VoiceParticipant[]>;
export type UnreadByChannel = Record<number, number>;
export type UnreadByServer = Record<number, number>;

export interface ChannelPagination {
    cursor: string;
    hasMore: boolean;
    isLoadingMore: boolean;
    error: boolean;
    // Present only while the channel is showing a windowed view opened by
    // jumpToMessage (a search hit, a reply, a push notification) rather than
    // the live tail. See useMessages' incoming-message guard: while
    // hasMoreNewer is true, newly arrived messages are not appended, because
    // there is an unloaded gap between the window and the real tail.
    newerCursor?: string;
    hasMoreNewer?: boolean;
    isLoadingNewer?: boolean;
}

export type PaginationByChannel = Record<number, ChannelPagination>;

export type SearchScope = "channel" | "server";

export interface SearchFilters {
    authorId?: number;
    hasFile?: boolean;
    hasLink?: boolean;
    before?: string;
    after?: string;
}

export interface SearchHit {
    message_id: number;
    channel_id: number;
    channel_name: string;
    author_id: number;
    author_first_name?: string;
    author_last_name?: string;
    author_nickname?: string;
    author_avatar_url?: string;
    // Message content with matched terms wrapped in [[HL]]...[[/HL]] markers
    // (Postgres ts_headline output, not HTML) — render via renderHeadline,
    // never as raw HTML.
    headline: string;
    created_at: string;
}
