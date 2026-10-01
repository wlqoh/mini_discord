import { useEffect, useMemo, useRef } from "react";
import type React from "react";
import { Check } from "lucide-react";
import Sheet from "./Sheet.tsx";
import { useIsMobile } from "../hooks/useIsMobile.ts";

export type ContextMenuItem =
    | {
        type?: "action";
        label: string;
        onClick: () => void;
        danger?: boolean;
        disabled?: boolean;
        icon?: React.ReactNode;
        active?: boolean;
    }
    | { type: "separator" };

type Props = {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
    /** Heading shown on the phone bottom sheet. */
    title?: string;
};

const MENU_WIDTH = 230;
const ITEM_HEIGHT = 34;

/** Generic right-click / "more actions" menu — positions itself at (x, y) and clamps to the viewport. */
export default function ContextMenu({ x, y, items, onClose, title }: Props) {
    const isMobile = useIsMobile();
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const handlePointerDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    const style = useMemo(() => {
        const estimatedHeight = items.length * ITEM_HEIGHT + 16;
        const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
        const top = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8));
        return { left, top, width: MENU_WIDTH };
    }, [x, y, items.length]);

    if (isMobile) {
        return (
            <Sheet open onClose={onClose} title={title}>
                <div className="sheet-menu" role="menu">
                    {items.map((item, index) =>
                        item.type === "separator" ? (
                            <div key={index} className="sheet-menu-separator" role="separator" />
                        ) : (
                            <button
                                key={index}
                                type="button"
                                className={`sheet-menu-item ${item.danger ? "danger" : ""}`}
                                disabled={item.disabled}
                                onClick={() => {
                                    onClose();
                                    item.onClick();
                                }}
                                role="menuitem"
                            >
                                <span className="sheet-menu-item-icon">
                                    {item.active ? <Check size={18} aria-hidden="true" /> : item.icon}
                                </span>
                                <span>{item.label}</span>
                            </button>
                        ),
                    )}
                </div>
            </Sheet>
        );
    }

    return (
        <div className="context-menu" style={style} ref={menuRef} role="menu">
            {items.map((item, index) =>
                item.type === "separator" ? (
                    <div key={index} className="context-menu-separator" role="separator" />
                ) : (
                    <button
                        key={index}
                        type="button"
                        className={`context-menu-item ${item.danger ? "danger" : ""}`}
                        disabled={item.disabled}
                        onClick={() => {
                            item.onClick();
                            onClose();
                        }}
                        role="menuitem"
                    >
                        <span className="context-menu-item-icon">
                            {item.active ? <Check size={14} aria-hidden="true" /> : item.icon}
                        </span>
                        <span>{item.label}</span>
                    </button>
                ),
            )}
        </div>
    );
}
