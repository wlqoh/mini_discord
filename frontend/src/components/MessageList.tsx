import type { Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
}

export default function MessageList({ messages }: Props) {
    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => (
                <div key={msg.id} className="message-item">
                    <div className="message-author">User #{msg.author_id}</div>
                    <div className="message-content">{msg.content}</div>
                </div>
            ))}
        </div>
    );
}
