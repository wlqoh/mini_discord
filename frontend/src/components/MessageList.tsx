import type { Message } from "../types/chat.ts";

type Props = {
    messages: Message[];
    currentUserId: number | null;
};

function getAuthorLabel(msg: Message): string {
    const firstName = msg.author_first_name?.trim() ?? "";
    const lastName = msg.author_last_name?.trim() ?? "";
    const fullName = `${firstName} ${lastName}`.trim();

    return fullName || `User #${msg.author_id}`;
}

export default function MessageList({ messages, currentUserId }: Props) {
    if (!messages.length) return <div className="messages-empty">No messages</div>;

    return (
        <div className="messages-list">
            {messages.map((msg) => {
                const isOwn = currentUserId !== null && msg.author_id === currentUserId;

                return (
                    <div key={msg.id} className={`message-row ${isOwn ? "own" : "other"}`}>
                        <div className={`message-item ${isOwn ? "own" : "other"}`}>
                            <div className="message-author">{getAuthorLabel(msg)}</div>
                            <div className="message-content">{msg.content}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
