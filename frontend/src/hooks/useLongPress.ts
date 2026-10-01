import { useCallback, useEffect, useRef } from "react";
import type React from "react";

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

export type LongPressPoint = { x: number; y: number };

/**
 * Touch long-press. Spread the returned props on the element. Mouse input is
 * ignored (desktop keeps hover buttons / right-click). After a long press the
 * synthetic click is swallowed so the press doesn't also "tap" the target.
 */
export function useLongPress(
    onLongPress: (point: LongPressPoint, target: EventTarget | null) => void,
    options: { enabled?: boolean; ms?: number } = {},
) {
    const { enabled = true, ms = LONG_PRESS_MS } = options;
    const timer = useRef<number | null>(null);
    const start = useRef<LongPressPoint | null>(null);
    const fired = useRef(false);
    const cbRef = useRef(onLongPress);
    useEffect(() => {
        cbRef.current = onLongPress;
    });

    const cancel = useCallback(() => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
        start.current = null;
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!enabled || e.pointerType === "mouse" || !e.isPrimary) return;
        fired.current = false;
        const point = { x: e.clientX, y: e.clientY };
        const target = e.target;
        start.current = point;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            fired.current = true;
            navigator.vibrate?.(10);
            cbRef.current(point, target);
        }, ms);
    }, [enabled, ms]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const s = start.current;
        if (!s) return;
        if (Math.abs(e.clientX - s.x) > MOVE_TOLERANCE_PX || Math.abs(e.clientY - s.y) > MOVE_TOLERANCE_PX) cancel();
    }, [cancel]);

    const onClickCapture = useCallback((e: React.MouseEvent) => {
        if (fired.current) {
            fired.current = false;
            e.preventDefault();
            e.stopPropagation();
        }
    }, []);

    // Android fires a native contextmenu on long press; we already handled it.
    const onContextMenu = useCallback((e: React.MouseEvent) => {
        if (enabled && fired.current) e.preventDefault();
    }, [enabled]);

    return {
        onPointerDown,
        onPointerMove,
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
        onClickCapture,
        onContextMenu,
    };
}
