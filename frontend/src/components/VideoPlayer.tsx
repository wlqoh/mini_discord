import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
    AlertCircle,
    Loader2,
    Maximize,
    Minimize,
    Pause,
    PictureInPicture2,
    Play,
    Volume1,
    Volume2,
    VolumeX,
} from "lucide-react";
import { formatTime, useMediaPlayer } from "../hooks/useMediaPlayer";
import type { Track } from "../types/media";
import { PLAYBACK_RATES } from "../types/media";
import "../styles/videoPlayer.css";

export interface VideoPlayerProps {
    tracks: Track[];
    initialIndex?: number;
    autoPlay?: boolean;
    poster?: string;
    className?: string;
    onTrackChange?: (track: Track | null, index: number) => void;
}

const CONTROLS_HIDE_DELAY_MS = 2500;

function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
    if (muted || volume === 0) return <VolumeX size={18} aria-hidden="true" />;
    if (volume < 0.6) return <Volume1 size={18} aria-hidden="true" />;
    return <Volume2 size={18} aria-hidden="true" />;
}

export default function VideoPlayer({
    tracks,
    initialIndex = 0,
    autoPlay = false,
    poster,
    className,
    onTrackChange,
}: VideoPlayerProps) {
    const {
        audioRef,
        state,
        currentTrack,
        formattedTime,
        togglePlay,
        toggleMute,
        seek,
        seekBy,
        setVolume,
        setPlaybackRate,
    } = useMediaPlayer<HTMLVideoElement>({ tracks, initialIndex, autoPlay, onTrackChange });

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPiP, setIsPiP] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [hoverRatio, setHoverRatio] = useState<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const progressRef = useRef<HTMLDivElement | null>(null);
    const hideTimeoutRef = useRef<number | null>(null);

    const playedPct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
    const bufferedPct = state.duration > 0 ? (state.buffered / state.duration) * 100 : 0;
    const volumePercent = Math.round(state.volume * 100);

    const getRatioFromEvent = useCallback((e: PointerEvent<HTMLDivElement>): number => {
        const el = progressRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) return 0;
        return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    }, []);

    const handleProgressPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
        setIsDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(getRatioFromEvent(e) * (state.duration || 0));
    }, [getRatioFromEvent, seek, state.duration]);

    const handleProgressPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
        const ratio = getRatioFromEvent(e);
        setHoverRatio(ratio);
        if (isDragging) seek(ratio * (state.duration || 0));
    }, [getRatioFromEvent, isDragging, seek, state.duration]);

    const handleProgressPointerUp = useCallback(() => setIsDragging(false), []);
    const handleProgressLeave = useCallback(() => setHoverRatio(null), []);

    const scheduleHideControls = useCallback(() => {
        if (hideTimeoutRef.current !== null) window.clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
    }, []);

    const handleActivity = useCallback(() => {
        setControlsVisible(true);
        if (state.playing) scheduleHideControls();
    }, [state.playing, scheduleHideControls]);

    useEffect(() => {
        if (state.playing) {
            scheduleHideControls();
        } else if (hideTimeoutRef.current !== null) {
            window.clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
        return () => {
            if (hideTimeoutRef.current !== null) window.clearTimeout(hideTimeoutRef.current);
        };
    }, [state.playing, scheduleHideControls]);

    // Controls are always visible while paused, regardless of the auto-hide
    // timer's last value — avoids calling setState synchronously in the effect
    // above just to force them back on.
    const showControls = controlsVisible || !state.playing;

    const toggleFullscreen = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        if (document.fullscreenElement) {
            void document.exitFullscreen();
        } else {
            void el.requestFullscreen?.();
        }
    }, []);

    useEffect(() => {
        const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const togglePiP = useCallback(() => {
        const el = audioRef.current;
        if (!el) return;
        void (async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (document.pictureInPictureEnabled) {
                    await el.requestPictureInPicture();
                }
            } catch {
                /* PiP unsupported or blocked — ignore */
            }
        })();
    }, [audioRef]);

    useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        const onEnter = () => setIsPiP(true);
        const onLeave = () => setIsPiP(false);
        el.addEventListener("enterpictureinpicture", onEnter);
        el.addEventListener("leavepictureinpicture", onLeave);
        return () => {
            el.removeEventListener("enterpictureinpicture", onEnter);
            el.removeEventListener("leavepictureinpicture", onLeave);
        };
    }, [audioRef]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable) return;

        switch (e.key) {
            case " ":
            case "Spacebar":
                e.preventDefault();
                togglePlay();
                break;
            case "m":
            case "M":
                toggleMute();
                break;
            case "f":
            case "F":
                toggleFullscreen();
                break;
            case "ArrowRight":
                e.preventDefault();
                seekBy(5);
                break;
            case "ArrowLeft":
                e.preventDefault();
                seekBy(-5);
                break;
            default:
                break;
        }
    }, [togglePlay, toggleMute, seekBy, toggleFullscreen]);

    return (
        <div
            ref={containerRef}
            className={`video-player ${isFullscreen ? "video-player--fullscreen" : ""} ${className ?? ""}`}
            role="region"
            aria-label={currentTrack ? `Video player: ${currentTrack.title}` : "Video player"}
            onKeyDown={handleKeyDown}
            onMouseMove={handleActivity}
            onPointerDown={handleActivity}
        >
            <video
                ref={audioRef}
                src={currentTrack?.url}
                poster={poster}
                preload="metadata"
                playsInline
                crossOrigin="anonymous"
                className="video-player-el"
                onClick={togglePlay}
            >
                <track kind="captions" />
            </video>

            {state.isLoading && !state.error && (
                <div className="video-player-loading">
                    <Loader2 size={32} className="video-player-spinner" aria-hidden="true" />
                </div>
            )}

            {!state.playing && !state.isLoading && !state.error && (
                <button
                    type="button"
                    className="video-player-center-play"
                    onClick={togglePlay}
                    aria-label="Play"
                >
                    <Play size={28} aria-hidden="true" />
                </button>
            )}

            {state.error && (
                <div className="video-player-error" role="alert">
                    <AlertCircle size={22} aria-hidden="true" />
                    <span>{state.error}</span>
                </div>
            )}

            <div className={`video-player-controls ${showControls ? "" : "video-player-controls--hidden"}`}>
                <div
                    className="video-player-progress"
                    ref={progressRef}
                    role="slider"
                    aria-label="Seek"
                    aria-valuemin={0}
                    aria-valuemax={Math.floor(state.duration)}
                    aria-valuenow={Math.floor(state.currentTime)}
                    aria-valuetext={`${formattedTime.current} of ${formattedTime.duration}`}
                    tabIndex={0}
                    onPointerDown={handleProgressPointerDown}
                    onPointerMove={handleProgressPointerMove}
                    onPointerUp={handleProgressPointerUp}
                    onPointerLeave={handleProgressLeave}
                >
                    <div className="video-player-progress-track">
                        <div className="video-player-progress-buffered" style={{ width: `${bufferedPct}%` }} />
                        <div className="video-player-progress-fill" style={{ width: `${playedPct}%` }} />
                        <div className="video-player-progress-handle" style={{ left: `${playedPct}%` }} />
                        {hoverRatio !== null && (
                            <div className="video-player-progress-hover" style={{ left: `${hoverRatio * 100}%` }}>
                                {formatTime(hoverRatio * state.duration)}
                            </div>
                        )}
                    </div>
                </div>

                <div className="video-player-controls-row">
                    <button
                        type="button"
                        className="video-player-icon-btn"
                        onClick={togglePlay}
                        aria-label={state.playing ? "Pause" : "Play"}
                        title={state.playing ? "Pause" : "Play"}
                    >
                        {state.playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                    </button>

                    <div className="video-player-volume">
                        <button
                            type="button"
                            className="video-player-icon-btn"
                            onClick={toggleMute}
                            aria-pressed={state.muted}
                            aria-label={state.muted ? "Unmute" : "Mute"}
                            title={state.muted ? "Unmute" : "Mute"}
                        >
                            <VolumeIcon volume={state.muted ? 0 : state.volume} muted={state.muted} />
                        </button>
                        <input
                            type="range"
                            className="video-player-volume-slider"
                            min={0}
                            max={100}
                            value={state.muted ? 0 : volumePercent}
                            onChange={(e) => setVolume(Number(e.target.value) / 100)}
                            aria-label="Volume"
                        />
                    </div>

                    <span className="video-player-time">{formattedTime.current} / {formattedTime.duration}</span>

                    <div className="video-player-spacer" />

                    <select
                        className="video-player-speed"
                        value={state.playbackRate}
                        onChange={(e) => setPlaybackRate(Number(e.target.value))}
                        aria-label="Playback speed"
                    >
                        {PLAYBACK_RATES.map((rate) => (
                            <option key={rate} value={rate}>{rate}x</option>
                        ))}
                    </select>

                    {typeof document !== "undefined" && document.pictureInPictureEnabled && (
                        <button
                            type="button"
                            className={`video-player-icon-btn ${isPiP ? "active" : ""}`}
                            onClick={togglePiP}
                            aria-pressed={isPiP}
                            aria-label="Picture-in-picture"
                            title="Picture-in-picture"
                        >
                            <PictureInPicture2 size={16} aria-hidden="true" />
                        </button>
                    )}

                    <button
                        type="button"
                        className="video-player-icon-btn"
                        onClick={toggleFullscreen}
                        aria-pressed={isFullscreen}
                        aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                        {isFullscreen ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}
                    </button>
                </div>
            </div>
        </div>
    );
}
