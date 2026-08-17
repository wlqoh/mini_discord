/** Small utilities shared by both VoiceClient implementations (mesh and
 * SFU) — kept here instead of duplicated so VITE_WEBRTC_FORCE_RELAY parsing
 * and the debug-log gate can't drift between them. */

export function isWebRTCDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("webrtc_debug") === "1";
  } catch {
    return false;
  }
}

export function debugLog(...args: unknown[]): void {
  if (!isWebRTCDebugEnabled()) {
    return;
  }
  console.log("[webrtc]", ...args);
}

function isTruthy(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function buildIceTransportPolicy(): RTCIceTransportPolicy {
  return isTruthy(import.meta.env.VITE_WEBRTC_FORCE_RELAY as string | undefined) ? "relay" : "all";
}

/** sfu-migration-plan.md §6.4. Shared by both VoiceClient implementations —
 * mesh had no bandwidth control at all before this, and the SFU path needs
 * the same caps for the same reason (an uncapped camera/screen encoder is
 * the single biggest bandwidth cost either transport carries per stream). */
export type VideoBitratePreset = {
  maxBitrateBps: number;
  maxFramerate?: number;
  degradationPreference?: RTCDegradationPreference;
};

export const CAMERA_BITRATE_PRESET: VideoBitratePreset = {
  maxBitrateBps: 800_000,
  maxFramerate: 30,
  degradationPreference: "balanced",
};

// Screen share favors legibility of static text over smoothness, unlike
// camera video — maintain-resolution instead of balanced.
export const SCREEN_BITRATE_PRESET: VideoBitratePreset = {
  maxBitrateBps: 2_500_000,
  maxFramerate: 30,
  degradationPreference: "maintain-resolution",
};

export async function applyVideoBitratePreset(sender: RTCRtpSender, preset: VideoBitratePreset): Promise<void> {
  if (!sender.track || sender.track.kind !== "video") {
    return;
  }
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = preset.maxBitrateBps;
    if (preset.maxFramerate) {
      params.encodings[0].maxFramerate = preset.maxFramerate;
    }
    if (preset.degradationPreference) {
      params.degradationPreference = preset.degradationPreference;
    }
    await sender.setParameters(params);
  } catch {
    // Best-effort: some browsers reject setParameters before the first
    // negotiation completes, or don't support a given field — the
    // connection still works fine with default encoding limits.
  }
}
