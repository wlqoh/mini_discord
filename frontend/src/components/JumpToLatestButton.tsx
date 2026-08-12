import { ArrowDown } from "lucide-react";

type Props = {
    isVisible: boolean;
    newCount: number;
    onClick: () => void;
};

export default function JumpToLatestButton({ isVisible, newCount, onClick }: Props) {
    const label = newCount > 0
        ? `Перейти к последним сообщениям, новых: ${newCount}`
        : "Перейти к последним сообщениям";

    return (
        <button
            type="button"
            className={`jump-latest-btn ${isVisible ? "visible" : ""}`}
            onClick={onClick}
            aria-label={label}
            title="К последним сообщениям"
            // Скрытая кнопка не должна ловить Tab, но остаётся в DOM ради transition.
            tabIndex={isVisible ? 0 : -1}
            aria-hidden={isVisible ? undefined : true}
        >
            <ArrowDown size={18} aria-hidden="true" />
            {/* aria-live работает только если узел уже был в DOM до изменения,
                поэтому span рендерится всегда, а пустой прячется через :empty. */}
            <span className="jump-latest-badge" aria-live="polite">
                {newCount > 0 ? (newCount > 99 ? "99+" : String(newCount)) : ""}
            </span>
        </button>
    );
}
