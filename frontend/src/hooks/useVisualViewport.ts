import { useEffect } from "react";

/**
 * Keeps --app-height / --keyboard-inset in sync with the visual viewport so
 * the layout shrinks above the on-screen keyboard (iOS Safari does not resize
 * the layout viewport). Also toggles `html.keyboard-open`.
 */
export function useVisualViewport(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        const root = document.documentElement;
        const vv = window.visualViewport;
        let raf = 0;

        const update = () => {
            raf = 0;
            const height = vv ? vv.height : window.innerHeight;
            const offsetTop = vv ? vv.offsetTop : 0;
            const inset = Math.max(0, window.innerHeight - height - offsetTop);
            root.style.setProperty("--app-height", `${Math.round(height)}px`);
            root.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
            root.classList.toggle("keyboard-open", inset > 80);
            // iOS scrolls the whole page when a field is focused; undo it.
            if (window.scrollY !== 0 || (vv && vv.offsetTop !== 0)) window.scrollTo(0, 0);
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

        update();
        vv?.addEventListener("resize", schedule);
        vv?.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        window.addEventListener("orientationchange", schedule);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            vv?.removeEventListener("resize", schedule);
            vv?.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("orientationchange", schedule);
            root.style.removeProperty("--app-height");
            root.style.removeProperty("--keyboard-inset");
            root.classList.remove("keyboard-open");
        };
    }, [enabled]);
}
