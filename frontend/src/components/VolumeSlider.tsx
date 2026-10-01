type Props = {
    value: number;
    onChange: (next: number) => void;
};

/** 0–200% per-participant volume slider (shared by the desktop popover and the phone sheet). */
export default function VolumeSlider({ value, onChange }: Props) {
    return (
        <>
            <div className="voice-volume-slider-wrap">
                <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={value}
                    onChange={(e) => {
                        const raw = Number(e.target.value);
                        onChange(Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1);
                    }}
                />
                <div className="voice-volume-ticks" aria-hidden="true">
                    <span>0%</span>
                    <span>100%</span>
                    <span>200%</span>
                </div>
            </div>
            <span className="voice-volume-value">{Math.round(value * 100)}%</span>
        </>
    );
}
