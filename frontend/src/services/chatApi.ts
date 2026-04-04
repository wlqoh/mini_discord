import API from "../api";
import type { Channel, Message } from "../types/chat.ts";

export async function getChannels(): Promise<Channel[]> {
    const { data } = await API.get<Channel[]>("/channels");
    return data;
}

export async function getMessages(channelId:string): Promise<Message[]> {
    const { data } = await API.get<Message[]>(`/channels/${channelId}/messages`);
    return data;
}

export async function sendMessage(channelId: string, content: string): Promise<Message> {
    const { data } = await API.post<Message>(`/channels/${channelId}/messages`, { content });
    return data;
}