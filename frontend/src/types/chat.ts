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

export interface Message {
    id: number;
    channel_id: number;
    author_id: number;
    author_first_name?: string;
    author_last_name?: string;
    author_avatar_url?: string;
    content: string;
    created_at: string;
}

export interface VoiceParticipant {
    user_id: number;
    first_name?: string;
    last_name?: string;
    avatar_url?: string;
    mic_enabled?: boolean;
    deafened?: boolean
}

export interface VoiceChannelParticipants {
    channel_id: number;
    participants: VoiceParticipant[];
}

export interface OnlineUser {
    first_name: string;
    last_name: string;
    email: string;
}

export interface JoinVoiceResponse {
    channel_id: number;
    participants: VoiceParticipant[];
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


export type MessagesByChannel = Record<number, Message[]>;
export type ChannelsByServer = Record<number, Channel[]>;
export type VoiceParticipantsByChannel = Record<number, VoiceParticipant[]>;
