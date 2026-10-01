import { useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "../hooks/useIsMobile.ts";
import { useBackDismiss } from "../hooks/useBackDismiss.ts";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock.ts";

type Props = {
    open: boolean;
    onClose: () => void;
    title?: string;
    /** Desktop presentation: "modal" is centred; "popover" is placed at `anchor`. Phones always get a bottom sheet. */
    variant?: "modal" | "popover";
    anchor?: { x: number; y: number };
    /** Adds the `closing` class so the desktop exit animation can play. */
    isClosing?: boolean;
    className?: string;
    children: React.ReactNode;
};

const DRAG_CLOSE_PX = 80;
const DRAG_CLOSE_VELOCITY = 0.5; // px/ms

/**
 * One overlay primitive: modal/popover on desktop, bottom sheet on phones.
 * Phones get a grabber, swipe-down-to-close, safe-area padding, body scroll
 * lock and system-back dismissal.
 */
export default function Sheet({ open, onClose, title, variant = "modal", anchor, isClosing, className = "", children }: Props) {
    const isMobile = useIsMobile();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [dragY, setDragY] = useState(0);
    const drag = useRef<{ startY: number; startT: number; lastY: number; lastT: number } | null>(null);

    useBackDismiss(open, onClose, isMobile);
    useBodyScrollLock(open);

    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        const panel = panelRef.current;
        if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            previous?.focus?.({ preventScroll: true });
        };
    }, [open, onClose]);

    if (!open) return null;

    const onGrabStart = (e: React.PointerEvent) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startY: e.clientY, startT: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp };
    };
    const onGrabMove = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        d.lastY = e.clientY;
        d.lastT = e.timeStamp;
        setDragY(Math.max(0, e.clientY - d.startY));
    };
    const onGrabEnd = (e: React.PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const dy = e.clientY - d.startY;
        const velocity = (e.clientY - d.startY) / Math.max(1, e.timeStamp - d.startT);
        setDragY(0);
        if (dy > DRAG_CLOSE_PX || (dy > 20 && velocity > DRAG_CLOSE_VELOCITY)) onClose();
    };

    const closingCls = isClosing ? " closing" : "";

    if (isMobile) {
        return createPortal(
            <div className={`sheet-overlay${closingCls}`} onClick={onClose}>
                <div
                    ref={panelRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-label={title}
                    className={`sheet-panel ${className}`}
                    style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div
                        className="sheet-grab"
                        onPointerDown={onGrabStart}
                        onPointerMove={onGrabMove}
                        onPointerUp={onGrabEnd}
                        onPointerCancel={onGrabEnd}
                    >
                        <span className="sheet-grabber" aria-hidden="true" />
                        {title ? <span className="sheet-title">{title}</span> : null}
                    </div>
                    <div className="sheet-body">{children}</div>
                </div>
            </div>,
            document.body,
        );
    }

    if (variant === "popover" && anchor) {
        const width = 260;
        const left = Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 240));
        return createPortal(
            <div className="sheet-popover-backdrop" onClick={onClose}>
                <div
                    ref={panelRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-label={title}
                    className={`sheet-popover ${className}`}
                    style={{ left, top, width }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {children}
                </div>
            </div>,
            document.body,
        );
    }

    return createPortal(
        <div className={`modal-overlay${closingCls}`} onClick={onClose}>
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={`modal-card ${className}`}
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>,
        document.body,
    );
}
