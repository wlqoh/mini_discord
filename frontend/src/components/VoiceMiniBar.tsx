import { useEffect, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import ConnectionQualityIcon from "./ConnectionQualityIcon";
import type { PeerQuality } from "../services/connectionQuality";

type Props = {
    channelName: string;
    quality: PeerQuality | null;
    isMicEnabled: boolean;
    isDeafened: boolean;
    onToggleMic: () => void;
    onLeave: () => void;
    onExpand: () => void;
};

function formatElapsed(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Thin call strip above the composer; tap the body to open the full-screen call. */
export default function VoiceMiniBar({ channelName, quality, isMicEnabled, isDeafened, onToggleMic, onLeave, onExpand }: Props) {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        const id = window.setInterval(() => setElapsed((v) => v + 1), 1000);
        return () => window.clearInterval(id);
    }, []);

    return (
        <div className="voice-minibar" role="region" aria-label="Active call">
            <button type="button" className="voice-minibar-body" onClick={onExpand} aria-label="Open call">
                {quality ? <ConnectionQualityIcon quality={quality} size={16} /> : <span className="voice-minibar-dot" />}
                <span className="voice-minibar-name">{channelName}</span>
                <span className="voice-minibar-time">{formatElapsed(elapsed)}</span>
            </button>
            <button
                type="button"
                className="voice-minibar-btn"
                onClick={onToggleMic}
                disabled={isDeafened}
                aria-label={isMicEnabled ? "Mute microphone" : "Unmute microphone"}
            >
                {isMicEnabled ? <Mic size={20} aria-hidden="true" /> : <MicOff size={20} aria-hidden="true" color="#ff5a5a" />}
            </button>
            <button type="button" className="voice-minibar-btn leave" onClick={onLeave} aria-label="Leave call">
                <PhoneOff size={20} aria-hidden="true" />
            </button>
        </div>
    );
}
