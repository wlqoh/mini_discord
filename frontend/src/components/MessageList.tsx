import type { Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
};

function getAuthorLabel(msg: Message): string {
    const firstName = msg.author_first_name?.trim() ?? "";
    const lastName = msg.author_last_name?.trim() ?? "";
    const fullName = `${firstName} ${lastName}`.trim();

    return fullName || `User #${msg.author_id}`;
}

export default function MessageList({ messages }: Props) {
    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => (
                <div key={msg.id} className="message-item">
                    <div className="message-author">{getAuthorLabel(msg)}</div>
                    <div className="message-content">{msg.content}</div>
                </div>
            ))}
        </div>
    );
}
