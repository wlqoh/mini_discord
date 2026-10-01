import { useEffect } from "react";

let locks = 0;

/** Reference-counted `overflow: hidden` on <body> while any overlay is open. */
export function useBodyScrollLock(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        locks += 1;
        document.body.classList.add("scroll-locked");
        return () => {
            locks -= 1;
            if (locks <= 0) {
                locks = 0;
                document.body.classList.remove("scroll-locked");
            }
        };
    }, [active]);
}
