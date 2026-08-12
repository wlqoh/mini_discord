import { useEffect, useRef } from "react";

const APP_NAME = "MuArAb";
const FAVICON_SELECTOR = 'link[rel="icon"][sizes="32x32"]';
const DEFAULT_FAVICON = "/favicon-32x32.png";
const DOT_FAVICON = "/favicon-dot-32x32.png";

// Badging API isn't in every TS DOM lib version yet — narrow via a local type
// instead of widening `navigator` to `any`.
type NavigatorWithBadge = Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

/** Out-of-tab indicators: document.title counter, PWA app badge, dot favicon. */
export function useDocumentBadge(totalUnread: number, hasUnreadMention: boolean): void {
    const originalTitleRef = useRef<string | null>(null);
    if (originalTitleRef.current === null) {
        originalTitleRef.current = document.title;
    }

    useEffect(() => {
        if (totalUnread <= 0) {
            document.title = APP_NAME;
            return;
        }
        const prefix = hasUnreadMention ? "(@)" : `(${totalUnread > 99 ? "99+" : totalUnread})`;
        document.title = `${prefix} ${APP_NAME}`;
    }, [totalUnread, hasUnreadMention]);

    useEffect(() => {
        const nav = navigator as NavigatorWithBadge;
        if (totalUnread > 0 && nav.setAppBadge) {
            void nav.setAppBadge(totalUnread).catch(() => {});
        } else if (totalUnread <= 0 && nav.clearAppBadge) {
            void nav.clearAppBadge().catch(() => {});
        }
    }, [totalUnread]);

    useEffect(() => {
        const link = document.querySelector<HTMLLinkElement>(FAVICON_SELECTOR);
        if (!link) return;
        link.href = totalUnread > 0 ? DOT_FAVICON : DEFAULT_FAVICON;
    }, [totalUnread]);

    useEffect(() => {
        return () => {
            document.title = originalTitleRef.current ?? APP_NAME;
            const nav = navigator as NavigatorWithBadge;
            void nav.clearAppBadge?.().catch(() => {});
        };
    }, []);
}
