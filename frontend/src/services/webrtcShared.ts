/** Small WebRTC utilities kept in their own module (not private to
 * SfuCallClient) so VITE_WEBRTC_FORCE_RELAY parsing and the debug-log gate
 * have one place to live. */

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

/** sfu-migration-plan.md §6.4 — caps screen-share encoding bitrate, since an
 * uncapped encoder is the single biggest bandwidth cost per stream. Camera
 * uses CAMERA_SIMULCAST_ENCODINGS instead (§7 phase 6) — its per-layer
 * maxBitrate is set once at transceiver creation, not via this preset. */
export type VideoBitratePreset = {
  maxBitrateBps: number;
  maxFramerate?: number;
  degradationPreference?: RTCDegradationPreference;
};

// Screen share favors legibility of static text over smoothness, unlike
// camera video — maintain-resolution instead of balanced.
export const SCREEN_BITRATE_PRESET: VideoBitratePreset = {
  maxBitrateBps: 2_500_000,
  maxFramerate: 30,
  degradationPreference: "maintain-resolution",
};

/** sfu-migration-plan.md §7 phase 6 — camera's three simulcast layers,
 * declared once at transceiver creation (RTCRtpTransceiverInit.sendEncodings)
 * so the server sees all three RIDs from the start (decision #4: simulcast
 * only for camera, never screen — legibility of shared text matters more
 * than adaptive bitrate there). `rid` isn't in this TS toolchain's DOM lib
 * yet even though every target browser supports it at runtime, hence the
 * intersection type instead of RTCRtpEncodingParameters directly — see the
 * usage note at CAMERA_SIMULCAST_ENCODINGS below. */
export type SimulcastEncoding = RTCRtpEncodingParameters & { rid: string };

// Referencing this typed constant (rather than an inline object literal) at
// the sendEncodings call site is what avoids TypeScript's excess-property
// check rejecting `rid` as unknown to RTCRtpEncodingParameters — assigning
// through a variable is a structural-subtype assignment, not an object
// literal one, so extra known properties are allowed.
export const CAMERA_SIMULCAST_ENCODINGS: SimulcastEncoding[] = [
  { rid: "l", scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: "m", scaleResolutionDownBy: 2, maxBitrate: 400_000 },
  { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 4_000_000 },
];

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
