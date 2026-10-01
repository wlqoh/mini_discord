import { useEffect, useRef } from "react";

type Options = {
    enabled?: boolean;
    onSwipeRight?: () => void;
    onSwipeLeft?: () => void;
    /** Ignore touches that start closer than this to the left screen edge (system back gesture). */
    edgeGuardPx?: number;
};

const THRESHOLD_PX = 60;
const LOCK_PX = 10;
const NO_SWIPE_SELECTOR =
    "pre, code, input, textarea, select, [contenteditable='true'], .video-grid, .media-player, .video-player, [data-no-swipe]";

function scrollsHorizontally(el: Element | null): boolean {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 1) {
            const ox = getComputedStyle(n).overflowX;
            if (ox === "auto" || ox === "scroll") return true;
        }
    }
    return false;
}

/** Horizontal swipe on `ref`: |dx| > 60px and |dx| > 2·|dy|; direction locks after 10px. */
export function useSwipe(ref: React.RefObject<HTMLElement | null>, options: Options) {
    const opts = useRef(options);
    useEffect(() => {
        opts.current = options;
    });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let sx = 0, sy = 0, tracking = false, locked: "x" | "y" | null = null;

        const onStart = (e: TouchEvent) => {
            const o = opts.current;
            if (!o.enabled || e.touches.length !== 1) { tracking = false; return; }
            const t = e.touches[0];
            const target = e.target as Element | null;
            if (t.clientX < (o.edgeGuardPx ?? 20)) { tracking = false; return; }
            if (target?.closest(NO_SWIPE_SELECTOR) || scrollsHorizontally(target)) { tracking = false; return; }
            sx = t.clientX; sy = t.clientY; tracking = true; locked = null;
        };
        const onMove = (e: TouchEvent) => {
            if (!tracking) return;
            const t = e.touches[0];
            const dx = t.clientX - sx, dy = t.clientY - sy;
            if (!locked && (Math.abs(dx) > LOCK_PX || Math.abs(dy) > LOCK_PX)) {
                locked = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
                if (locked === "y") tracking = false;
            }
        };
        const onEnd = (e: TouchEvent) => {
            if (!tracking || locked !== "x") { tracking = false; return; }
            tracking = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) > THRESHOLD_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
                if (dx > 0) opts.current.onSwipeRight?.(); else opts.current.onSwipeLeft?.();
            }
        };
        el.addEventListener("touchstart", onStart, { passive: true });
        el.addEventListener("touchmove", onMove, { passive: true });
        el.addEventListener("touchend", onEnd, { passive: true });
        el.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
        return () => {
            el.removeEventListener("touchstart", onStart);
            el.removeEventListener("touchmove", onMove);
            el.removeEventListener("touchend", onEnd);
        };
    }, [ref]);
}
