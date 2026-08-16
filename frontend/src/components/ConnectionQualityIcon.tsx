import type { PeerQuality, QualityLevel } from "../services/connectionQuality";

type Props = {
  quality: PeerQuality;
  /** Размер в px: 10 для плашки на тайле, 16 для панели звонка. */
  size?: number;
  className?: string;
};

const ACTIVE_BARS: Record<QualityLevel, number> = {
  good: 3,
  medium: 2,
  bad: 1,
  connecting: 0,
  disconnected: 0,
};

const BAR_INDEXES = [0, 1, 2];

export default function ConnectionQualityIcon({ quality, size = 12, className }: Props) {
  const activeBars = ACTIVE_BARS[quality.level];

  return (
    <span
      className={`cq cq--${quality.level}${className ? ` ${className}` : ""}`}
      title={quality.title}
      role="img"
      aria-label={quality.ariaLabel}
    >
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {BAR_INDEXES.map((index) => (
          <rect
            key={index}
            className={`cq-bar${index < activeBars ? " is-active" : ""}`}
            x={index * 4.5}
            y={8 - index * 3.5}
            width={3}
            height={4 + index * 3.5}
            rx={1}
          />
        ))}
        {quality.level === "disconnected" ? (
          <line className="cq-slash" x1="0.5" y1="11.5" x2="11.5" y2="0.5" />
        ) : null}
      </svg>
    </span>
  );
}
