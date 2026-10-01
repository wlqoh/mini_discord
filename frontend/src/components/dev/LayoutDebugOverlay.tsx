import { useCallback, useEffect, useRef, useState } from "react";

/**
 * DEV-only layout diagnostics for the mobile UI work. Enable with
 * `?debugLayout=1` or `localStorage.debugLayout = "1"`. Highlights:
 *   red    — element sticks out of the viewport horizontally
 *   orange — interactive element with a hit area under 44×44
 *   purple — interactive element covered by another element at its centre
 */
const MARK = "data-layout-debug";
const INTERACTIVE = "button, a[href], [role='button'], input, select, textarea";

function isEnabled(): boolean {
    try {
        return new URLSearchParams(window.location.search).get("debugLayout") === "1"
            || localStorage.getItem("debugLayout") === "1";
    } catch {
        return false;
    }
}

function describe(el: Element): string {
    const cls = typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return `${el.tagName.toLowerCase()}${cls}`;
}

function isVisible(el: Element, r: DOMRect): boolean {
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

function isClippedByAncestor(el: Element): boolean {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "hidden" || ox === "auto" || ox === "scroll" || ox === "clip") {
            const pr = p.getBoundingClientRect();
            if (pr.right <= window.innerWidth + 1 && pr.left >= -1) return true;
        }
    }
    return false;
}

function outline(el: Element, color: string) {
    const h = el as HTMLElement;
    h.setAttribute(MARK, "1");
    h.style.outline = `2px solid ${color}`;
    h.style.outlineOffset = "-2px";
}

function clear() {
    document.querySelectorAll(`[${MARK}]`).forEach((el) => {
        const h = el as HTMLElement;
        h.style.outline = "";
        h.style.outlineOffset = "";
        h.removeAttribute(MARK);
    });
}

export function LayoutDebugOverlay() {
    const [enabled] = useState(isEnabled);
    const [stats, setStats] = useState({ overflow: 0, small: 0, covered: 0 });
    const timer = useRef<number | null>(null);

    const scan = useCallback(() => {
        clear();
        let overflow = 0, small = 0, covered = 0;
        const vw = window.innerWidth;

        document.querySelectorAll("body *").forEach((el) => {
            if (el.closest("[data-layout-debug-ui]")) return;
            const r = el.getBoundingClientRect();
            if (!isVisible(el, r)) return;

            if ((r.right > vw + 1 || r.left < -1) && !isClippedByAncestor(el)) {
                overflow++;
                outline(el, "red");
                console.warn("[layout] overflow-x:", describe(el), Math.round(r.left), Math.round(r.right), el);
            }

            if (el.matches(INTERACTIVE)) {
                if (r.width < 44 || r.height < 44) {
                    small++;
                    outline(el, "orange");
                }
                const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
                if (cx >= 0 && cy >= 0 && cx <= vw && cy <= window.innerHeight) {
                    const top = document.elementFromPoint(cx, cy);
                    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
                        covered++;
                        outline(el, "purple");
                        console.warn("[layout] covered:", describe(el), "by", describe(top), el);
                    }
                }
            }
        });
        setStats({ overflow, small, covered });
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const schedule = () => {
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(scan, 400);
        };
        const mo = new MutationObserver(schedule);
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        window.addEventListener("resize", schedule);
        schedule();
        return () => {
            mo.disconnect();
            window.removeEventListener("resize", schedule);
            if (timer.current) window.clearTimeout(timer.current);
            clear();
        };
    }, [enabled, scan]);

    if (!enabled) return null;
    return (
        <div
            data-layout-debug-ui
            style={{
                position: "fixed", left: 4, bottom: 4, zIndex: 9999, font: "11px monospace",
                background: "rgba(0,0,0,.85)", color: "#fff", padding: "4px 8px", borderRadius: 6,
                display: "flex", gap: 8, alignItems: "center",
            }}
        >
            <span>overflow: {stats.overflow} · small: {stats.small} · covered: {stats.covered}</span>
            <button type="button" onClick={scan} style={{ font: "inherit", minHeight: 0, minWidth: 0 }}>Scan</button>
        </div>
    );
}
