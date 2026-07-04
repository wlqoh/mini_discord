import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
    AlertCircle,
    ListMusic,
    Loader2,
    Maximize2,
    Minimize2,
    Music,
    Pause,
    Play,
    Repeat,
    Repeat1,
    Shuffle,
    SkipBack,
    SkipForward,
    SlidersHorizontal,
    Square,
    Volume1,
    Volume2,
    VolumeX,
} from "lucide-react";
import { formatTime, useMediaPlayer } from "../hooks/useMediaPlayer";
import type { LoopMode, Track } from "../types/media";
import { PLAYBACK_RATES } from "../types/media";
import "../styles/mediaPlayer.css";

export interface MediaPlayerProps {
    tracks: Track[];
    initialIndex?: number;
    autoPlay?: boolean;
    /** Start in mini/collapsed mode. The user can still expand it. */
    compact?: boolean;
    showPlaylist?: boolean;
    showEqualizer?: boolean;
    showVisualizer?: boolean;
    /** Reuse an existing AudioContext (e.g. shared with call/video audio) instead of creating a private one. */
    audioContext?: AudioContext;
    className?: string;
    onTrackChange?: (track: Track | null, index: number) => void;
}

const LOOP_CYCLE: LoopMode[] = ["off", "all", "one"];

function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
    if (muted || volume === 0) return <VolumeX size={18} aria-hidden="true" />;
    if (volume < 0.6) return <Volume1 size={18} aria-hidden="true" />;
    return <Volume2 size={18} aria-hidden="true" />;
}

function LoopIcon({ mode }: { mode: LoopMode }) {
    return mode === "one" ? <Repeat1 size={16} aria-hidden="true" /> : <Repeat size={16} aria-hidden="true" />;
}

export default function MediaPlayer({
    tracks,
    initialIndex = 0,
    autoPlay = false,
    compact = false,
    showPlaylist = true,
    showEqualizer = true,
    showVisualizer = true,
    audioContext,
    className,
    onTrackChange,
}: MediaPlayerProps) {
    const player = useMediaPlayer({ tracks, initialIndex, autoPlay, audioContext, onTrackChange });
    const { state, currentTrack, formattedTime } = player;

    const [expanded, setExpanded] = useState(!compact);
    const [playlistOpen, setPlaylistOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [hoverRatio, setHoverRatio] = useState<number | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const progressRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);

    const playedPct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
    const bufferedPct = state.duration > 0 ? (state.buffered / state.duration) * 100 : 0;

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
        player.seek(getRatioFromEvent(e) * (state.duration || 0));
    }, [getRatioFromEvent, player, state.duration]);

    const handleProgressPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
        const ratio = getRatioFromEvent(e);
        setHoverRatio(ratio);
        if (isDragging) player.seek(ratio * (state.duration || 0));
    }, [getRatioFromEvent, isDragging, player, state.duration]);

    const handleProgressPointerUp = useCallback(() => setIsDragging(false), []);
    const handleProgressLeave = useCallback(() => setHoverRatio(null), []);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable) return;

        switch (e.key) {
            case " ":
            case "Spacebar":
                e.preventDefault();
                player.togglePlay();
                break;
            case "m":
            case "M":
                player.toggleMute();
                break;
            case "ArrowRight":
                e.preventDefault();
                player.seekBy(5);
                break;
            case "ArrowLeft":
                e.preventDefault();
                player.seekBy(-5);
                break;
            default:
                break;
        }
    }, [player]);

    const cycleLoopMode = useCallback(() => {
        const idx = LOOP_CYCLE.indexOf(state.loopMode);
        player.setLoopMode(LOOP_CYCLE[(idx + 1) % LOOP_CYCLE.length]);
    }, [player, state.loopMode]);

    useEffect(() => {
        // Only run the draw loop while the visualizer is both enabled AND its
        // panel/canvas is actually mounted (advancedOpen) — otherwise it spins
        // forever drawing to a canvas nobody sees.
        const visible = player.visualizerEnabled && advancedOpen;
        if (!visible) {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            return;
        }
        const analyser = player.getAnalyser();
        if (!analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            // Re-read the canvas ref each frame instead of capturing it once,
            // so the loop stops cleanly if the canvas unmounts mid-animation.
            const canvas = canvasRef.current;
            const ctx2d = canvas?.getContext("2d");
            if (!canvas || !ctx2d) {
                rafRef.current = null;
                return;
            }
            rafRef.current = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);
            const { width, height } = canvas;
            ctx2d.clearRect(0, 0, width, height);
            const barWidth = (width / bufferLength) * 2.5;
            let x = 0;
            for (let i = 0; i < bufferLength && x <= width; i++) {
                const barHeight = (dataArray[i] / 255) * height;
                ctx2d.fillStyle = `hsl(352, 80%, ${45 + (barHeight / height) * 25}%)`;
                ctx2d.fillRect(x, height - barHeight, barWidth, barHeight);
                x += barWidth + 1;
            }
        };
        draw();

        return () => {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [player.visualizerEnabled, player.getAnalyser, advancedOpen]);

    const volumePercent = Math.round(state.volume * 100);
    const boostPercent = Math.round(state.boost * 100);

    const progressBar = (
        <div
            className="media-player-progress"
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
            <div className="media-player-progress-track">
                <div className="media-player-progress-buffered" style={{ width: `${bufferedPct}%` }} />
                <div className="media-player-progress-fill" style={{ width: `${playedPct}%` }} />
                <div className="media-player-progress-handle" style={{ left: `${playedPct}%` }} />
                {hoverRatio !== null && (
                    <div className="media-player-progress-hover" style={{ left: `${hoverRatio * 100}%` }}>
                        {formatTime(hoverRatio * state.duration)}
                    </div>
                )}
            </div>
        </div>
    );

    const muteButton = (
        <button
            type="button"
            className="media-player-icon-btn"
            onClick={player.toggleMute}
            aria-pressed={state.muted}
            aria-label={state.muted ? "Unmute" : "Mute"}
            title={state.muted ? "Unmute" : "Mute"}
        >
            <VolumeIcon volume={state.muted ? 0 : state.volume} muted={state.muted} />
        </button>
    );

    return (
        <div
            className={`media-player ${expanded ? "" : "media-player--mini"} ${className ?? ""}`}
            role="region"
            aria-label={currentTrack ? `Media player: ${currentTrack.title}` : "Media player"}
            onKeyDown={handleKeyDown}
        >
            <audio
                ref={player.audioRef}
                src={currentTrack?.url}
                preload="metadata"
                className="media-player-native-audio"
            >
                <track kind="captions" />
            </audio>

            {expanded ? (
                <>
                    <div className="media-player-header">
                        <div className="media-player-art">
                            {currentTrack?.albumArt ? (
                                <img src={currentTrack.albumArt} alt="" loading="lazy" />
                            ) : (
                                <Music size={20} aria-hidden="true" />
                            )}
                        </div>
                        <div className="media-player-meta">
                            <span className="media-player-title">{currentTrack?.title ?? "No track selected"}</span>
                            {currentTrack?.artist && <span className="media-player-artist">{currentTrack.artist}</span>}
                        </div>
                        {state.isLoading && <Loader2 size={16} className="media-player-spinner" aria-hidden="true" />}
                        <button
                            type="button"
                            className="media-player-icon-btn"
                            onClick={() => setExpanded(false)}
                            aria-label="Collapse player"
                            title="Collapse"
                        >
                            <Minimize2 size={14} aria-hidden="true" />
                        </button>
                    </div>

                    {state.error && <div className="media-player-error" role="alert">{state.error}</div>}

                    {progressBar}

                    <div className="media-player-time-row">
                        <span>{formattedTime.current}</span>
                        <span>{formattedTime.duration}</span>
                    </div>

                    <div className="media-player-controls-row">
                        <button
                            type="button"
                            className={`media-player-icon-btn ${state.shuffle ? "active" : ""}`}
                            onClick={player.toggleShuffle}
                            aria-pressed={state.shuffle}
                            aria-label="Shuffle"
                            title="Shuffle"
                        >
                            <Shuffle size={15} aria-hidden="true" />
                        </button>
                        <button type="button" className="media-player-icon-btn" onClick={player.previous} aria-label="Previous track" title="Previous">
                            <SkipBack size={18} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="media-player-play-btn"
                            onClick={player.togglePlay}
                            aria-label={state.playing ? "Pause" : "Play"}
                            title={state.playing ? "Pause" : "Play"}
                        >
                            {state.playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
                        </button>
                        <button type="button" className="media-player-icon-btn" onClick={player.stop} aria-label="Stop" title="Stop">
                            <Square size={15} aria-hidden="true" />
                        </button>
                        <button type="button" className="media-player-icon-btn" onClick={player.next} aria-label="Next track" title="Next">
                            <SkipForward size={18} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className={`media-player-icon-btn ${state.loopMode !== "off" ? "active" : ""}`}
                            onClick={cycleLoopMode}
                            aria-label={`Loop mode: ${state.loopMode}`}
                            title={`Loop: ${state.loopMode}`}
                        >
                            <LoopIcon mode={state.loopMode} />
                        </button>
                    </div>

                    <div className="media-player-secondary-row">
                        <div className="media-player-volume">
                            {muteButton}
                            <input
                                type="range"
                                className="media-player-volume-slider"
                                min={0}
                                max={100}
                                value={state.muted ? 0 : volumePercent}
                                onChange={(e) => player.setVolume(Number(e.target.value) / 100)}
                                aria-label="Volume"
                            />
                        </div>

                        <select
                            className="media-player-speed"
                            value={state.playbackRate}
                            onChange={(e) => player.setPlaybackRate(Number(e.target.value))}
                            aria-label="Playback speed"
                        >
                            {PLAYBACK_RATES.map((rate) => (
                                <option key={rate} value={rate}>{rate}x</option>
                            ))}
                        </select>

                        <div className="media-player-toggle-group">
                            {(showEqualizer || showVisualizer) && (
                                <button
                                    type="button"
                                    className={`media-player-icon-btn ${advancedOpen ? "active" : ""}`}
                                    onClick={() => setAdvancedOpen((v) => !v)}
                                    aria-pressed={advancedOpen}
                                    aria-label="Equalizer and visualizer"
                                    title="Equalizer / visualizer"
                                >
                                    <SlidersHorizontal size={15} aria-hidden="true" />
                                </button>
                            )}
                            {showPlaylist && (
                                <button
                                    type="button"
                                    className={`media-player-icon-btn ${playlistOpen ? "active" : ""}`}
                                    onClick={() => setPlaylistOpen((v) => !v)}
                                    aria-pressed={playlistOpen}
                                    aria-label="Queue"
                                    title="Queue"
                                >
                                    <ListMusic size={15} aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    </div>

                    {advancedOpen && (
                        <div className="media-player-advanced-panel">
                            {showEqualizer && (
                                <div className="media-player-eq">
                                    <div className="media-player-eq-header">
                                        <span>Equalizer</span>
                                        <label className="media-player-eq-enable">
                                            <input type="checkbox" checked={player.eqEnabled} onChange={player.toggleEqualizer} />
                                            On
                                        </label>
                                    </div>
                                    <div className="media-player-eq-bands">
                                        {player.eqBands.map((band, i) => (
                                            <div className="media-player-eq-band" key={band.frequency}>
                                                <input
                                                    type="range"
                                                    className="media-player-eq-slider"
                                                    min={-12}
                                                    max={12}
                                                    step={1}
                                                    value={band.gain}
                                                    disabled={!player.eqEnabled}
                                                    aria-label={`${band.label ?? `${band.frequency}Hz`} gain`}
                                                    onChange={(e) => {
                                                        const next = player.eqBands.slice();
                                                        next[i] = { ...band, gain: Number(e.target.value) };
                                                        player.setEqBands(next);
                                                    }}
                                                />
                                                <span className="media-player-eq-label">{band.label}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="media-player-boost">
                                        <span>Boost</span>
                                        <input
                                            type="range"
                                            min={100}
                                            max={200}
                                            value={boostPercent}
                                            onChange={(e) => player.setBoost(Number(e.target.value) / 100)}
                                            aria-label="Volume boost"
                                        />
                                        <span>{boostPercent}%</span>
                                    </div>
                                </div>
                            )}
                            {showVisualizer && (
                                <div className="media-player-visualizer">
                                    <label className="media-player-eq-enable">
                                        <input type="checkbox" checked={player.visualizerEnabled} onChange={player.toggleVisualizer} />
                                        Spectrum
                                    </label>
                                    {player.visualizerEnabled && (
                                        <canvas ref={canvasRef} className="media-player-canvas" width={300} height={60} />
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {playlistOpen && showPlaylist && (
                        <div className="media-player-playlist">
                            <ul className="media-player-playlist-items">
                                {player.queue.map((track, i) => (
                                    <li key={track.id}>
                                        <button
                                            type="button"
                                            className={`media-player-playlist-item ${i === state.currentTrackIndex ? "active" : ""}`}
                                            onClick={() => player.playTrackAt(i)}
                                        >
                                            <span className="media-player-playlist-item-title">{track.title}</span>
                                            {track.artist && <span className="media-player-playlist-item-artist">{track.artist}</span>}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            ) : (
                <div className="media-player-mini-row">
                    <button
                        type="button"
                        className="media-player-icon-btn"
                        onClick={player.togglePlay}
                        aria-label={state.playing ? "Pause" : "Play"}
                    >
                        {state.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                    </button>
                    <div className="media-player-mini-info">
                        <span className="media-player-mini-title-row">
                            <span className="media-player-mini-title">{currentTrack?.title ?? "No track"}</span>
                            {state.error && (
                                <span
                                    className="media-player-mini-error"
                                    role="alert"
                                    aria-label={state.error}
                                    title={state.error}
                                >
                                    <AlertCircle size={12} aria-hidden="true" />
                                </span>
                            )}
                        </span>
                        {progressBar}
                    </div>
                    {muteButton}
                    <input
                        type="range"
                        className="media-player-volume-slider media-player-mini-volume-slider"
                        min={0}
                        max={100}
                        value={state.muted ? 0 : volumePercent}
                        onChange={(e) => player.setVolume(Number(e.target.value) / 100)}
                        aria-label="Volume"
                    />
                    <button
                        type="button"
                        className="media-player-icon-btn"
                        onClick={() => setExpanded(true)}
                        aria-label="Expand player"
                        title="Expand"
                    >
                        <Maximize2 size={14} aria-hidden="true" />
                    </button>
                </div>
            )}
        </div>
    );
}
