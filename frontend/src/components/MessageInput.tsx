import  { useState } from "react";

type Props = {
    disabled?: boolean;
    onSend: (text: string) => Promise<void> | void;
};

export default function MessageInput({ disabled, onSend }: Props) {
    const [text, setText] = useState("");

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const value = text.trim();
        if (!value || disabled) return;

        await onSend(value);
        setText("");
    }

    return (
        <form className="message-form" onSubmit={handleSubmit}>
            <input
                className="message-input"
                placeholder="Write a message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={disabled}
            />
            <button className="message-send-btn" type="submit" disabled={disabled || !text.trim()}>
                Send
            </button>
        </form>
    );
}