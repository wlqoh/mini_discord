import type { NoiseSuppressionMode } from "./voiceClient";

const NOISE_SUPPRESSION_KEY = "voice_noise_suppression";
const DEFAULT_MODE: NoiseSuppressionMode = "rnnoise";

function isNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return value === "off" || value === "browser" || value === "rnnoise";
}

// Device-scoped (depends on the microphone/CPU, not the account) — see
// tmp/noise-suppression-plan.md decision #6.
export function loadNoiseSuppressionMode(): NoiseSuppressionMode {
  try {
    const stored = localStorage.getItem(NOISE_SUPPRESSION_KEY);
    return isNoiseSuppressionMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveNoiseSuppressionMode(mode: NoiseSuppressionMode): void {
  try {
    localStorage.setItem(NOISE_SUPPRESSION_KEY, mode);
  } catch {
    // ignore quota or security errors
  }
}
