import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  volume?: number;
};

export default function VideoTile({ stream, label, muted = false, volume = 1 }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const isDebugEnabled = (() => {
    try {
      return window.localStorage.getItem("webrtc_debug") === "1";
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.srcObject = stream;
    if (isDebugEnabled) {
      // eslint-disable-next-line no-console
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
          // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.log("[webrtc][video-tile] loadedmetadata", { label, width: el.videoWidth, height: el.videoHeight });
    };
    const onPlaying = () => {
      // eslint-disable-next-line no-console
      console.log("[webrtc][video-tile] playing", { label, currentTime: el.currentTime });
    };
    const onError = () => {
      // eslint-disable-next-line no-console
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
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} className="video-el" />
      <div className="video-label">{label}</div>
    </div>
  );
}
