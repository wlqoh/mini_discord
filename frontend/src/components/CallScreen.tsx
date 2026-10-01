import { useEffect } from "react";
import type React from "react";
import { ChevronDown } from "lucide-react";
import ConnectionQualityIcon from "./ConnectionQualityIcon";
import type { PeerQuality } from "../services/connectionQuality";

type Props = {
    open: boolean;
    channelName: string;
    quality: PeerQuality | null;
    statusBanner?: React.ReactNode;
    onCollapse: () => void;
    grid: React.ReactNode;
    controls: React.ReactNode;
};

/**
 * Full-screen call view for phones. It stays mounted (just hidden) for the whole
 * call: the video tiles own the remote audio playback, so unmounting them on
 * collapse would silence the call.
 */
export default function CallScreen({ open, channelName, quality, statusBanner, onCollapse, grid, controls }: Props) {
    useEffect(() => {
        if (!open) return;
        let lock: WakeLockSentinel | null = null;
        let cancelled = false;
        const acquire = async () => {
            try {
                const l = await navigator.wakeLock?.request("screen");
                if (!l) return;
                if (cancelled) void l.release();
                else lock = l;
            } catch {
                /* unsupported or denied — ignore */
            }
        };
        void acquire();
        const onVisible = () => {
            if (document.visibilityState === "visible" && (!lock || lock.released)) void acquire();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", onVisible);
            void lock?.release();
        };
    }, [open]);

    return (
        <div className={`call-screen${open ? " open" : ""}`} hidden={!open} role="dialog" aria-label="Call">
            <header className="call-screen-header">
                <button type="button" className="call-screen-collapse" onClick={onCollapse} aria-label="Collapse call">
                    <ChevronDown size={24} aria-hidden="true" />
                </button>
                <span className="call-screen-title">{channelName}</span>
                {quality ? <ConnectionQualityIcon quality={quality} size={16} className="voice-quality-badge" /> : null}
            </header>
            {statusBanner}
            <div className="call-screen-grid">{grid}</div>
            <div className="call-controls">{controls}</div>
        </div>
    );
}
