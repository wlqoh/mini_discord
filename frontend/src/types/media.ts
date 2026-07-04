export type MediaFormat = "mp3" | "wav" | "ogg" | "webm" | "mp4";

export type LoopMode = "off" | "one" | "all";

export interface Track {
    id: string | number;
    title: string;
    artist?: string;
    album?: string;
    /** Duration in seconds. May be 0 until metadata loads. */
    duration: number;
    url: string;
    albumArt?: string;
    format?: MediaFormat;
}

export interface PlayerState {
    playing: boolean;
    currentTime: number;
    duration: number;
    /** Buffered duration in seconds, from the end of the last contiguous range starting at 0. */
    buffered: number;
    /** 0..2, where 1 is 100% (native) and up to 2 is a 200% Web-Audio-boosted gain. */
    volume: number;
    muted: boolean;
    playbackRate: number;
    loopMode: LoopMode;
    shuffle: boolean;
    currentTrackIndex: number;
    isLoading: boolean;
    error: string | null;
}

export interface EqualizerBand {
    frequency: number;
    /** Gain in dB, typically -12..12. */
    gain: number;
    label?: string;
}

export const DEFAULT_EQUALIZER_BANDS: EqualizerBand[] = [
    { frequency: 60, gain: 0, label: "Bass" },
    { frequency: 250, gain: 0, label: "Low" },
    { frequency: 1000, gain: 0, label: "Mid" },
    { frequency: 4000, gain: 0, label: "High" },
    { frequency: 12000, gain: 0, label: "Treble" },
];

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function guessFormatFromContentType(contentType: string): MediaFormat | undefined {
    if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
    if (contentType.includes("wav")) return "wav";
    if (contentType.includes("ogg")) return "ogg";
    if (contentType.includes("webm")) return "webm";
    if (contentType.includes("mp4")) return "mp4";
    return undefined;
}
