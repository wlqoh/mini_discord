export interface Channel {
    id: number;
    server_id: number;
    name: string;
}

export interface Server {
    id: number;
    name: string;
}

export interface Message {
    id: number;
    channel_id: number;
    author_id: number;
    content: string;
    created_at: string;
}

export type MessagesByChannel = Record<number, Message[]>;
export type ChannelsByServer = Record<number, Channel[]>;
