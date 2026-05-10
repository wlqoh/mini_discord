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

export default function VideoTile({ stream, label, muted = false, volume = 1, micEnabled, deafened }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
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
  }, [stream, label, isDebugEnabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const safeVolume = Math.min(1, Math.max(0, volume));
    el.muted = muted;
    el.defaultMuted = muted;
    el.volume = muted ? 0 : safeVolume;
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
