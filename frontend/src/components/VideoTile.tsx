import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
};

export default function VideoTile({ stream, label, muted = false }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} className="video-el" />
      <div className="video-label">{label}</div>
    </div>
  );
}

