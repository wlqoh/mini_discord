import { useEffect, useRef } from "react";
import { MicOff, VolumeOff } from "lucide-react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  micEnabled?: boolean;
  deafened?: boolean;
};

export default function VideoTile({ stream, label, muted = false, micEnabled, deafened }: Props) {
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
    el.muted = muted;
    el.defaultMuted = muted;
    el.volume = muted ? 0 : 1;

    const media = el.srcObject;
    if (media instanceof MediaStream) {
      media.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }, [muted, stream]);

  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} className="video-el" />
      <div className="video-label">{label}</div>
      {micEnabled === false || deafened ? (
        <div className="video-status">
          {micEnabled === false ? <MicOff size={14} aria-hidden="true" /> : null}
          {deafened ? <VolumeOff size={14} aria-hidden="true" /> : null}
        </div>
      ) : null}
    </div>
  );
}
