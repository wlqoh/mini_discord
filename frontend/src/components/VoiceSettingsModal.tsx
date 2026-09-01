import { useState } from "react";
import type { NoiseSuppressionMode } from "../services/voiceClient.ts";
import { loadNoiseSuppressionMode } from "../services/voiceSettings.ts";

type Props = {
    onClose: () => void;
    effectiveMode: NoiseSuppressionMode;
    onSetMode: (mode: NoiseSuppressionMode) => void;
};

const OPTIONS: Array<{ value: NoiseSuppressionMode; label: string; description: string }> = [
    { value: "off", label: "Off", description: "Microphone is sent as-is, only echo cancellation." },
    { value: "browser", label: "Standard (browser)", description: "Built-in WebRTC noise suppression. Cheaper on CPU, works everywhere." },
    { value: "rnnoise", label: "Enhanced (RNNoise)", description: "Neural-network noise suppression. Cuts steady background noise better, costs more CPU." },
];

export default function VoiceSettingsModal({ onClose, effectiveMode, onSetMode }: Props) {
    // The desired mode (what the user picked) can differ from effectiveMode
    // (what's actually running) after degradation — see
    // tmp/noise-suppression-plan.md §5.3. The radio list reflects intent;
    // the note below reflects reality.
    const [desiredMode, setDesiredMode] = useState<NoiseSuppressionMode>(() => loadNoiseSuppressionMode());

    function handleSelect(mode: NoiseSuppressionMode) {
        setDesiredMode(mode);
        onSetMode(mode);
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <h3 className="modal-title">Voice</h3>

                <div className="notification-settings-section">
                    <span className="profile-modal-label">Noise suppression</span>
                    <div className="voice-settings-options">
                        {OPTIONS.map((opt) => (
                            <label key={opt.value} className="voice-settings-option">
                                <input
                                    type="radio"
                                    name="noise-suppression-mode"
                                    value={opt.value}
                                    checked={desiredMode === opt.value}
                                    onChange={() => handleSelect(opt.value)}
                                />
                                <span>
                                    <strong>{opt.label}</strong>
                                    <small>{opt.description}</small>
                                </span>
                            </label>
                        ))}
                    </div>
                    {desiredMode === "rnnoise" && effectiveMode !== "rnnoise" ? (
                        <span className="notification-settings-test-status">
                            RNNoise is unavailable in this browser; standard suppression is active instead.
                        </span>
                    ) : null}
                </div>

                <div className="modal-actions">
                    <button className="modal-btn modal-btn-primary" type="button" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
