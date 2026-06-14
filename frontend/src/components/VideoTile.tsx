import { useEffect, useRef } from "react";
import { Maximize2, MicOff, VolumeOff } from "lucide-react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  volume?: number;
  micEnabled?: boolean;
  deafened?: boolean;
};

type GainState = {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  stream: MediaStream;
};

export default function VideoTile({ stream, label, muted = false, volume = 1, micEnabled, deafened }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gainStateRef = useRef<GainState | null>(null);
  const isDebugEnabled = (() => {
    try {
      return window.localStorage.getItem("webrtc_debug") === "1";
    } catch {
      return false;
    }
  })();

  const toggleFullScreen = () => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  };

  function teardownGain(): void {
    const g = gainStateRef.current;
    if (!g) return;
    try { g.source.disconnect(); } catch { /* ignore */ }
    try { g.gain.disconnect(); } catch { /* ignore */ }
    try { void g.ctx.close(); } catch { /* ignore */ }
    gainStateRef.current = null;
  }

  // Unmount-only cleanup for the GainNode (safety net).
  useEffect(() => () => teardownGain(), []);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.srcObject = stream;
    if (isDebugEnabled) {
      console.log("[webrtc][video-tile] srcObject set", {
        label,
        streamId: stream?.id ?? null,
        tracks: stream?.getTracks().map((t) => ({ kind: t.kind, id: t.id, muted: t.muted, readyState: t.readyState })) ?? [],
      });
    }
    const playPromise = el.play();
    if (playPromise) {
      void playPromise.catch((err) => {
        if (isDebugEnabled) {
          console.log("[webrtc][video-tile] play rejected", { label, err });
        }
      });
    }
    // GainNode lifecycle is managed entirely in the volume/muted effect below.
  }, [stream, label, isDebugEnabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const clampedVolume = Math.min(2, Math.max(0, Number.isFinite(volume) ? volume : 1));
    const effectiveMuted = muted || clampedVolume === 0;

    if (!effectiveMuted && clampedVolume > 1 && stream) {
      // Route via AudioContext GainNode to allow gain > 1.
      const existing = gainStateRef.current;
      if (existing && existing.stream === stream) {
        // Same stream — just update gain value in place.
        existing.gain.gain.value = clampedVolume;
        el.muted = true;
        return;
      }
      // Stream changed or first time in boost mode — (re)create the graph.
      teardownGain();
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = clampedVolume;
        source.connect(gain);
        gain.connect(ctx.destination);
        gainStateRef.current = { ctx, source, gain, stream };
        el.muted = true;
        void ctx.resume();
        return;
      } catch {
        // AudioContext unavailable — fall through to native volume (capped at 1).
        teardownGain();
      }
    }

    // No boost needed — tear down GainNode if it was active and use native volume.
    teardownGain();
    el.muted = effectiveMuted;
    el.defaultMuted = effectiveMuted;
    el.volume = effectiveMuted ? 0 : Math.min(1, clampedVolume);
  }, [muted, volume, stream]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isDebugEnabled) {
      return;
    }

    const onLoadedMetadata = () => {
      console.log("[webrtc][video-tile] loadedmetadata", { label, width: el.videoWidth, height: el.videoHeight });
    };
    const onPlaying = () => {
      console.log("[webrtc][video-tile] playing", { label, currentTime: el.currentTime });
    };
    const onError = () => {
      console.log("[webrtc][video-tile] error", { label, error: el.error?.message ?? el.error?.code ?? "unknown" });
    };

    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("error", onError);

    return () => {
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("error", onError);
    };
  }, [label, isDebugEnabled]);

  return (
    <div className="video-tile" ref={containerRef}>
      <video ref={ref} autoPlay playsInline muted={muted} className="video-el" />
      <div className="video-label">{label}</div>
      {micEnabled === false || deafened ? (
        <div className="video-status">
          {micEnabled === false ? <MicOff size={14} aria-hidden="true" /> : null}
          {deafened ? <VolumeOff size={14} aria-hidden="true" /> : null}
        </div>
      ) : null}
      <button
        className="video-fullscreen-btn"
        type="button"
        onClick={toggleFullScreen}
        aria-label="Fullscreen"
      >
        <Maximize2 size={18} />
      </button>
    </div>
  );
}
