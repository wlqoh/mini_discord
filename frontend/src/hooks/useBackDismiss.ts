import { useEffect, useRef } from "react";

/**
 * Makes the system "back" gesture/button close the topmost overlay
 * (drawer, sheet, search, call screen…) instead of leaving the page.
 *
 * Every open overlay owns exactly one extra history entry. A module-level
 * stack lets a single popstate listener close only the top one. When an
 * overlay is closed by other means (tap, Esc) its entry is released with
 * history.back(); releases are batched on a 0ms timer so that closing one
 * overlay and opening another in the same tick (or React StrictMode's
 * effect double-invoke) reuses the entry instead of churning history.
 */
type Entry = { close: () => void };

const stack: Entry[] = [];
let ignorePops = 0;
let pendingBacks = 0;
let backTimer: number | null = null;
let listening = false;

function onPopState() {
    if (ignorePops > 0) {
        ignorePops -= 1;
        return;
    }
    const top = stack.pop();
    top?.close();
}

function ensureListener() {
    if (listening) return;
    window.addEventListener("popstate", onPopState);
    listening = true;
}

function acquireHistoryEntry() {
    if (pendingBacks > 0) {
        pendingBacks -= 1; // reuse an entry that was about to be released
        return;
    }
    window.history.pushState({ ...(window.history.state ?? {}), overlay: true }, "");
}

function releaseHistoryEntry() {
    pendingBacks += 1;
    if (backTimer !== null) return;
    backTimer = window.setTimeout(() => {
        backTimer = null;
        const n = pendingBacks;
        pendingBacks = 0;
        if (n > 0) {
            ignorePops += 1;
            window.history.go(-n);
        }
    }, 0);
}

export function useBackDismiss(isOpen: boolean, onClose: () => void, enabled = true): void {
    const closeRef = useRef(onClose);
    useEffect(() => {
        closeRef.current = onClose;
    });

    useEffect(() => {
        if (!isOpen || !enabled) return;
        ensureListener();
        const entry: Entry = { close: () => closeRef.current() };
        stack.push(entry);
        acquireHistoryEntry();
        return () => {
            const idx = stack.indexOf(entry);
            if (idx !== -1) {
                stack.splice(idx, 1);
                releaseHistoryEntry();
            }
        };
    }, [isOpen, enabled]);
}
