import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  volume?: number;
};

export default function VideoTile({ stream, label, muted = false, volume = 1 }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    ref.current.srcObject = stream;
  }, [stream]);

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

  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} className="video-el" />
      <div className="video-label">{label}</div>
    </div>
  );
}
