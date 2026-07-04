import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EqualizerBand, LoopMode, PlayerState, Track } from "../types/media";
import { DEFAULT_EQUALIZER_BANDS } from "../types/media";
import { addToHistory, getNextIndex, getPreviousIndex, shuffleTracks } from "../services/playlistService";

export interface UseMediaPlayerOptions {
    tracks: Track[];
    initialIndex?: number;
    initialVolume?: number;
    autoPlay?: boolean;
    loopMode?: LoopMode;
    /** Reuse an existing AudioContext (e.g. shared with call audio) instead of creating a private one. */
    audioContext?: AudioContext;
    onTrackChange?: (track: Track | null, index: number) => void;
}

interface AudioGraph {
    ctx: AudioContext;
    source: MediaElementAudioSourceNode;
    filters: BiquadFilterNode[];
    gainNode: GainNode;
    analyser: AnalyserNode;
}

const initialState: PlayerState = {
    playing: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    boost: 1,
    muted: false,
    playbackRate: 1,
    loopMode: "off",
    shuffle: false,
    currentTrackIndex: 0,
    isLoading: false,
    error: null,
};

/**
 * A page can host many MediaPlayer instances (e.g. one per audio attachment in a
 * chat). Browsers cap concurrent AudioContexts (notably Safari), so instances
 * share one context by default instead of each creating their own.
 */
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
    if (sharedAudioContext) return sharedAudioContext;
    const AudioContextCtor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    sharedAudioContext = new AudioContextCtor();
    return sharedAudioContext;
}

/**
 * Generic over the element type so it works for both <audio> (MediaPlayer,
 * default) and <video> (VideoPlayer) — every API used below (play/pause/
 * currentTime/duration/volume/muted/playbackRate/buffered/addEventListener,
 * createMediaElementSource) is defined on the shared HTMLMediaElement base.
 */
export function useMediaPlayer<TElement extends HTMLMediaElement = HTMLAudioElement>(options: UseMediaPlayerOptions) {
    const { tracks, onTrackChange, audioContext: externalAudioContext } = options;

    const audioRef = useRef<TElement | null>(null);
    const graphRef = useRef<AudioGraph | null>(null);
    const eqBandsRef = useRef<EqualizerBand[]>(DEFAULT_EQUALIZER_BANDS);
    const shuffleOrderRef = useRef<number[]>([]);

    const [queue, setQueue] = useState<Track[]>(tracks);
    const [eqBands, setEqBandsState] = useState<EqualizerBand[]>(DEFAULT_EQUALIZER_BANDS);
    const [eqEnabled, setEqEnabled] = useState(false);
    const [visualizerEnabled, setVisualizerEnabled] = useState(false);
    const [state, setState] = useState<PlayerState>(() => ({
        ...initialState,
        currentTrackIndex: options.initialIndex ?? 0,
        volume: options.initialVolume ?? 1,
        loopMode: options.loopMode ?? "off",
    }));

    useEffect(() => {
        eqBandsRef.current = eqBands;
    }, [eqBands]);

    useEffect(() => {
        setQueue(tracks);
    }, [tracks]);

    const currentTrack = queue[state.currentTrackIndex] ?? null;

    const ensureGraph = useCallback((): AudioGraph | null => {
        if (graphRef.current) return graphRef.current;
        const el = audioRef.current;
        if (!el) return null;

        try {
            const ctx = externalAudioContext ?? getSharedAudioContext();
            if (!ctx) return null;
            const source = ctx.createMediaElementSource(el);
            const filters = eqBandsRef.current.map((band) => {
                const filter = ctx.createBiquadFilter();
                filter.type = "peaking";
                filter.frequency.value = band.frequency;
                filter.Q.value = 1;
                filter.gain.value = band.gain;
                return filter;
            });
            const gainNode = ctx.createGain();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;

            let node: AudioNode = source;
            for (const filter of filters) {
                node.connect(filter);
                node = filter;
            }
            node.connect(gainNode);
            gainNode.connect(analyser);
            analyser.connect(ctx.destination);

            graphRef.current = { ctx, source, filters, gainNode, analyser };
            void ctx.resume();
            return graphRef.current;
        } catch {
            return null;
        }
    }, [externalAudioContext]);

    useEffect(() => {
        // The underlying AudioContext (external or the shared singleton) outlives
        // this component instance, so it is never closed here — only the nodes
        // this instance created are torn down.
        return () => {
            const g = graphRef.current;
            if (!g) return;
            try { g.filters.forEach((f) => f.disconnect()); } catch { /* ignore */ }
            try { g.gainNode.disconnect(); } catch { /* ignore */ }
            try { g.analyser.disconnect(); } catch { /* ignore */ }
            try { g.source.disconnect(); } catch { /* ignore */ }
            graphRef.current = null;
        };
    }, []);

    useEffect(() => {
        const el = audioRef.current;
        if (!el) return;

        const needsGraph = graphRef.current !== null || state.boost > 1 || eqEnabled || visualizerEnabled;
        if (needsGraph) {
            const graph = ensureGraph();
            if (graph) {
                el.volume = 1;
                graph.gainNode.gain.value = state.muted ? 0 : state.volume * state.boost;
                return;
            }
        }
        el.volume = Math.min(1, Math.max(0, state.volume));
        el.muted = state.muted;
    }, [state.volume, state.boost, state.muted, eqEnabled, visualizerEnabled, ensureGraph]);

    useEffect(() => {
        const g = graphRef.current;
        if (!g) return;
        eqBands.forEach((band, i) => {
            if (g.filters[i]) g.filters[i].gain.value = eqEnabled ? band.gain : 0;
        });
    }, [eqBands, eqEnabled]);

    useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        el.playbackRate = state.playbackRate;
    }, [state.playbackRate]);

    const play = useCallback(async () => {
        const el = audioRef.current;
        if (!el) return;
        try {
            if (graphRef.current) void graphRef.current.ctx.resume();
            await el.play();
        } catch (err) {
            setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Playback failed" }));
        }
    }, []);

    const pause = useCallback(() => {
        audioRef.current?.pause();
    }, []);

    const togglePlay = useCallback(() => {
        if (state.playing) pause();
        else void play();
    }, [state.playing, pause, play]);

    const stop = useCallback(() => {
        const el = audioRef.current;
        if (!el) return;
        el.pause();
        el.currentTime = 0;
    }, []);

    const seek = useCallback((time: number) => {
        const el = audioRef.current;
        if (!el) return;
        el.currentTime = Math.min(Math.max(0, time), el.duration || time);
    }, []);

    const seekBy = useCallback((deltaSeconds: number) => {
        const el = audioRef.current;
        if (!el) return;
        seek(el.currentTime + deltaSeconds);
    }, [seek]);

    const setVolume = useCallback((volume: number) => {
        setState((s) => ({ ...s, volume: Math.min(1, Math.max(0, volume)), muted: volume === 0 ? s.muted : false }));
    }, []);

    const setBoost = useCallback((boost: number) => {
        setState((s) => ({ ...s, boost: Math.min(2, Math.max(1, boost)) }));
    }, []);

    const toggleMute = useCallback(() => {
        setState((s) => ({ ...s, muted: !s.muted }));
    }, []);

    const setPlaybackRate = useCallback((rate: number) => {
        setState((s) => ({ ...s, playbackRate: rate }));
    }, []);

    const setLoopMode = useCallback((mode: LoopMode) => {
        setState((s) => ({ ...s, loopMode: mode }));
    }, []);

    const setEqBands = useCallback((bands: EqualizerBand[]) => {
        setEqBandsState(bands);
    }, []);

    const toggleEqualizer = useCallback(() => {
        setEqEnabled((v) => !v);
    }, []);

    const toggleVisualizer = useCallback(() => {
        setVisualizerEnabled((v) => !v);
    }, []);

    const getAnalyser = useCallback((): AnalyserNode | null => {
        const graph = ensureGraph();
        return graph?.analyser ?? null;
    }, [ensureGraph]);

    const playTrackAt = useCallback((index: number) => {
        if (index < 0 || index >= queue.length) return;
        setState((s) => ({ ...s, currentTrackIndex: index, currentTime: 0, error: null }));
    }, [queue.length]);

    const toggleShuffle = useCallback(() => {
        setState((s) => {
            const shuffle = !s.shuffle;
            shuffleOrderRef.current = shuffle
                ? shuffleTracks(queue.map((_, i) => i).filter((i) => i !== s.currentTrackIndex))
                : [];
            if (shuffle) shuffleOrderRef.current.unshift(s.currentTrackIndex);
            return { ...s, shuffle };
        });
    }, [queue]);

    const next = useCallback(() => {
        const idx = getNextIndex(queue.length, state.currentTrackIndex, state.loopMode, state.shuffle ? shuffleOrderRef.current : undefined);
        if (idx === null) {
            stop();
            return;
        }
        playTrackAt(idx);
    }, [queue.length, state.currentTrackIndex, state.loopMode, state.shuffle, playTrackAt, stop]);

    const previous = useCallback(() => {
        const el = audioRef.current;
        if (el && el.currentTime > 3) {
            seek(0);
            return;
        }
        const idx = getPreviousIndex(queue.length, state.currentTrackIndex, state.loopMode, state.shuffle ? shuffleOrderRef.current : undefined);
        if (idx === null) return;
        playTrackAt(idx);
    }, [queue.length, state.currentTrackIndex, state.loopMode, state.shuffle, playTrackAt, seek]);

    useEffect(() => {
        const el = audioRef.current;
        if (!el) return;

        const onTimeUpdate = () => setState((s) => ({ ...s, currentTime: el.currentTime }));
        const onLoadedMetadata = () => setState((s) => ({ ...s, duration: Number.isFinite(el.duration) ? el.duration : 0, isLoading: false }));
        const onEnded = () => {
            if (currentTrack) addToHistory(currentTrack);
            if (state.loopMode === "one") {
                el.currentTime = 0;
                void play();
                return;
            }
            next();
        };
        const onError = () => setState((s) => ({ ...s, error: "Failed to load media", isLoading: false, playing: false }));
        const onWaiting = () => setState((s) => ({ ...s, isLoading: true }));
        const onCanPlay = () => setState((s) => ({ ...s, isLoading: false }));
        const onPlay = () => setState((s) => ({ ...s, playing: true, error: null }));
        const onPause = () => setState((s) => ({ ...s, playing: false }));
        const onProgress = () => {
            if (el.buffered.length === 0) return;
            setState((s) => ({ ...s, buffered: el.buffered.end(el.buffered.length - 1) }));
        };

        el.addEventListener("timeupdate", onTimeUpdate);
        el.addEventListener("loadedmetadata", onLoadedMetadata);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onError);
        el.addEventListener("waiting", onWaiting);
        el.addEventListener("canplay", onCanPlay);
        el.addEventListener("play", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("progress", onProgress);

        return () => {
            el.removeEventListener("timeupdate", onTimeUpdate);
            el.removeEventListener("loadedmetadata", onLoadedMetadata);
            el.removeEventListener("ended", onEnded);
            el.removeEventListener("error", onError);
            el.removeEventListener("waiting", onWaiting);
            el.removeEventListener("canplay", onCanPlay);
            el.removeEventListener("play", onPlay);
            el.removeEventListener("pause", onPause);
            el.removeEventListener("progress", onProgress);
        };
    }, [currentTrack, state.loopMode, next, play]);

    const isFirstTrackLoad = useRef(true);
    useEffect(() => {
        const el = audioRef.current;
        if (!el) return;
        setState((s) => ({ ...s, currentTime: 0, isLoading: true }));
        if (isFirstTrackLoad.current) {
            isFirstTrackLoad.current = false;
            if (options.autoPlay) void play();
        } else {
            void play();
        }
        onTrackChange?.(currentTrack, state.currentTrackIndex);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.currentTrackIndex, currentTrack?.url]);

    const formattedTime = useMemo(() => ({
        current: formatTime(state.currentTime),
        duration: formatTime(state.duration),
    }), [state.currentTime, state.duration]);

    return {
        audioRef,
        state,
        queue,
        setQueue,
        currentTrack,
        eqBands,
        eqEnabled,
        visualizerEnabled,
        formattedTime,
        play,
        pause,
        togglePlay,
        stop,
        seek,
        seekBy,
        setVolume,
        setBoost,
        toggleMute,
        setPlaybackRate,
        setLoopMode,
        setEqBands,
        toggleEqualizer,
        toggleVisualizer,
        getAnalyser,
        playTrackAt,
        toggleShuffle,
        next,
        previous,
    };
}

export function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}
