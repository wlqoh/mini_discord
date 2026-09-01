import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { ErrorListener, NoiseSuppressionMode } from "./voiceClient";
import { debugLog } from "./webrtcShared";

export type CameraFacingMode = "user" | "environment";

// DynamicsCompressorNode settings for the rnnoise chain (tmp/noise-
// suppression-plan.md §5.2): with autoGainControl off, a quiet mic would
// otherwise come out noticeably quieter than in "browser" mode.
const COMPRESSOR_THRESHOLD_DB = -28;
const COMPRESSOR_KNEE_DB = 24; // soft knee so the onset isn't audible
const COMPRESSOR_RATIO = 4;
const COMPRESSOR_ATTACK_S = 0.01;
const COMPRESSOR_RELEASE_S = 0.2;
const MAKEUP_GAIN = 2.0; // ~+6 dB; Web Audio's compressor has no makeup-gain of its own

export function formatMediaError(err: unknown): string {
  if (!(err instanceof DOMException)) {
    return "Failed to access microphone/camera";
  }

  switch (err.name) {
    case "NotAllowedError":
      return "Access to microphone/camera is denied in browser settings";
    case "NotFoundError":
      return "Microphone or camera device was not found";
    case "NotReadableError":
      return "Microphone/camera is already used by another app";
    case "OverconstrainedError":
      return "Requested media settings are not supported on this device";
    case "SecurityError":
      return "Media access is blocked: open the app via HTTPS or localhost";
    default:
      return `Failed to access microphone/camera (${err.name})`;
  }
}

// AEC is always requested — it runs against the speaker reference signal at
// the audio-engine level and can't be reproduced by RNNoise on its own. NS/
// AGC are mutually exclusive with the rnnoise graph: browser NS is already a
// nonlinear filter, and stacking RNNoise on top of it feeds RNNoise input it
// was never trained on (see tmp/noise-suppression-plan.md §3.1/§5.1).
function audioConstraintsFor(mode: NoiseSuppressionMode): MediaTrackConstraints {
  switch (mode) {
    case "off":
      return { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
    case "browser":
      return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    case "rnnoise":
      return { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  }
}

/**
 * Owns getUserMedia + RNNoise processing. Media is always acquired BEFORE
 * join_voice_channel is sent (see SfuCallClient.join): the server can
 * broadcast our presence — and other peers can react to it — as soon as
 * we're in the channel, so localStream needs to already exist by then.
 * acquire() only ever captures the microphone — the camera is captured
 * lazily, on demand, via acquireVideoTrack (see SfuCallClient.startCamera),
 * so the camera LED stays off until the user actually turns it on.
 */
export class LocalCapture {
  private readonly onError: ErrorListener;

  // Desired mode (what the user picked) vs. effective mode (what's actually
  // running after degradation — RNNoise unavailable, graph construction
  // failed, or the watchdog fired). UI shows effective; see setMode's doc
  // comment and tmp/noise-suppression-plan.md §5.3.
  private mode: NoiseSuppressionMode;
  private effective: NoiseSuppressionMode;

  private stream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private preferredFacingMode: CameraFacingMode = "user";

  private rnnoiseAudioContext: AudioContext | null = null;
  private rnnoiseSource: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private makeupGainNode: GainNode | null = null;
  // Timestamp of when the RNNoise AudioContext first went "suspended"
  // (browser autoplay policy, background-tab throttling, device change), or
  // null when it isn't. If it stays suspended too long the outgoing audio
  // track goes silent while the UI still shows the mic as enabled — checked
  // by checkWatchdogFallback, which the owner's quality-sample timer polls.
  private rnnoiseSuspendedSince: number | null = null;
  private static readonly RNNOISE_SUSPENDED_FALLBACK_MS = 3000;

  private static rnnoiseBinaryPromise: Promise<ArrayBuffer> | null = null;

  constructor(onError: ErrorListener, mode: NoiseSuppressionMode) {
    this.onError = onError;
    this.mode = mode;
    this.effective = mode;
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  get effectiveMode(): NoiseSuppressionMode {
    return this.effective;
  }

  /** The unprocessed mic track, if one has been captured — the caller must
   * never stop() this itself (see swapMicTrack in sfuCallClient.ts): it's
   * either the rnnoise graph's input or the fallback track a mode switch or
   * the watchdog would hand back next. */
  get rawTrack(): MediaStreamTrack | null {
    return this.rawStream?.getAudioTracks()[0] ?? null;
  }

  get facingMode(): CameraFacingMode {
    return this.preferredFacingMode;
  }

  setPreferredFacingMode(mode: CameraFacingMode): void {
    this.preferredFacingMode = mode;
  }

  /** Lets the owner push an updated stream back in (e.g. after building a
   * new MediaStream around a switched camera track) so this stays the
   * single source of truth for what stopAll() tears down. */
  setStream(next: MediaStream): void {
    this.stream = next;
  }

  async acquire(): Promise<MediaStream> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone/camera access");
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: audioConstraintsFor(this.mode),
        video: false,
      });
    } catch (err) {
      throw new Error(formatMediaError(err));
    }

    await this.enforceAudioProcessing(stream);

    if (this.mode === "rnnoise") {
      this.stream = await this.applyRnnoiseProcessing(stream);
    } else {
      this.rawStream = stream;
      this.effective = this.mode;
      this.stream = stream;
    }
    return this.stream;
  }

  async acquireVideoTrack(facingMode: CameraFacingMode): Promise<MediaStreamTrack> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera switching");
    }

    // Resolution/framerate match the camera's simulcast "h" layer (see
    // webrtcShared.ts CAMERA_SIMULCAST_ENCODINGS / sfu-migration-plan.md §7
    // phase 6) — capping the capture itself, not just the encoder.
    const videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    };
    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { exact: facingMode }, ...videoConstraints } },
      { audio: false, video: { facingMode: { ideal: facingMode }, ...videoConstraints } },
      { audio: false, video: true },
    ];

    let lastErr: unknown;
    for (const constraints of attempts) {
      try {
        const stream = await mediaDevices.getUserMedia(constraints);
        const track = stream.getVideoTracks()[0];
        stream.getAudioTracks().forEach((audioTrack) => audioTrack.stop());
        if (track) {
          stream.getVideoTracks().forEach((videoTrack) => {
            if (videoTrack.id !== track.id) {
              videoTrack.stop();
            }
          });
          return track;
        }
        stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      } catch (err) {
        lastErr = err;
        // Try the next constraints profile.
      }
    }

    throw new Error(formatMediaError(lastErr));
  }

  stopAll(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.rawStream?.getTracks().forEach((track) => track.stop());
    this.rawStream = null;
    this.stream = null;
    this.disposeRnnoiseProcessing();
  }

  /**
   * Switches to a new desired mode on the fly. Returns a new audio track for
   * the caller to feed into RTCRtpSender.replaceTrack, or null when there's
   * nothing to switch (mode unchanged, or no mic was captured at all — e.g.
   * a listen-only join). The caller is responsible for carrying
   * track.enabled over from the old track — otherwise a muted mic comes
   * back live (tmp/noise-suppression-plan.md §7 edge case #1).
   */
  async setMode(next: NoiseSuppressionMode): Promise<MediaStreamTrack | null> {
    if (next === this.mode) {
      return null;
    }
    this.mode = next;

    let rawTrack = this.rawStream?.getAudioTracks()[0] ?? null;
    if (!rawTrack) {
      // No mic captured yet (listen-only) — the new mode takes effect on
      // the next acquire().
      return null;
    }

    try {
      await rawTrack.applyConstraints(audioConstraintsFor(next));
    } catch {
      // Some browsers (Safari) can silently ignore applyConstraints for
      // NS/AGC — fall back to a full re-acquire.
      let reacquired: MediaStream;
      try {
        reacquired = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraintsFor(next),
          video: false,
        });
      } catch (err) {
        throw new Error(formatMediaError(err));
      }
      const newTrack = reacquired.getAudioTracks()[0];
      if (!newTrack) {
        reacquired.getTracks().forEach((track) => track.stop());
        throw new Error("Re-acquired microphone stream has no audio track");
      }
      rawTrack.stop();
      this.rawStream = reacquired;
      rawTrack = newTrack;
    }

    this.disposeRnnoiseProcessing();

    let resultTrack: MediaStreamTrack;
    if (next === "rnnoise") {
      const processedStream = await this.applyRnnoiseProcessing(new MediaStream([rawTrack]));
      resultTrack = processedStream.getAudioTracks()[0] ?? rawTrack;
    } else {
      this.effective = next;
      resultTrack = rawTrack;
    }

    const videoTracks = this.stream?.getVideoTracks() ?? [];
    this.stream = new MediaStream([resultTrack, ...videoTracks]);
    return resultTrack;
  }

  /**
   * Returns the raw (unprocessed) audio track exactly once when RNNoise has
   * been stuck "suspended" for too long — track.enabled/readyState still
   * look fine and the UI shows the mic as on, but the outgoing audio is
   * silent, and nothing else would ever detect or recover from this.
   * Deliberately does not attempt to switch back to RNNoise later, to avoid
   * flapping. Returns null when there's nothing to do.
   */
  checkWatchdogFallback(): MediaStreamTrack | null {
    if (!this.rnnoiseAudioContext || this.rnnoiseSuspendedSince === null) {
      return null;
    }
    if (Date.now() - this.rnnoiseSuspendedSince < LocalCapture.RNNOISE_SUSPENDED_FALLBACK_MS) {
      return null;
    }

    const rawAudioTrack = this.rawStream?.getAudioTracks()[0];
    if (!rawAudioTrack) {
      return null;
    }

    debugLog("rnnoise:suspended-fallback", { suspendedForMs: Date.now() - this.rnnoiseSuspendedSince });
    this.onError("Noise suppression stalled; switched to unfiltered microphone audio so you stay audible.");
    this.effective = "browser";
    // The AudioContext is stuck suspended and would otherwise keep burning
    // CPU indefinitely with nothing coming out of it.
    this.disposeRnnoiseProcessing();
    return rawAudioTrack;
  }

  private async enforceAudioProcessing(stream: MediaStream): Promise<void> {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      return;
    }
    try {
      await audioTrack.applyConstraints(audioConstraintsFor(this.mode));
    } catch {
      // Best-effort on browsers with partial constraint support.
    }
  }

  private async applyRnnoiseProcessing(sourceStream: MediaStream): Promise<MediaStream> {
    const sourceAudioTrack = sourceStream.getAudioTracks()[0];
    if (!sourceAudioTrack) {
      this.rawStream = sourceStream;
      this.effective = "browser";
      return sourceStream;
    }

    if (!window.isSecureContext || typeof AudioWorkletNode === "undefined") {
      debugLog("rnnoise:unsupported", {
        isSecureContext: window.isSecureContext,
        hasAudioWorkletNode: typeof AudioWorkletNode !== "undefined",
      });
      this.rawStream = sourceStream;
      this.effective = "browser";
      return sourceStream;
    }

    try {
      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContext.onstatechange = () => {
        debugLog("rnnoise:state-change", { state: audioContext.state });
        if (audioContext.state === "suspended") {
          if (this.rnnoiseSuspendedSince === null) {
            this.rnnoiseSuspendedSince = Date.now();
          }
          void audioContext.resume();
        } else {
          this.rnnoiseSuspendedSince = null;
        }
      };
      await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);

      const wasmBinary = await LocalCapture.loadRnnoiseBinary();
      const rnnoiseSourceStream = new MediaStream([sourceAudioTrack]);
      const sourceNode = audioContext.createMediaStreamSource(rnnoiseSourceStream);
      const rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
        wasmBinary,
        maxChannels: 1,
      });
      // Compensates for the loss of autoGainControl in the rnnoise
      // constraints profile (decision #4/§5.2) — Web Audio's compressor has
      // no built-in makeup gain, hence the separate GainNode after it.
      const compressorNode = audioContext.createDynamicsCompressor();
      compressorNode.threshold.value = COMPRESSOR_THRESHOLD_DB;
      compressorNode.knee.value = COMPRESSOR_KNEE_DB;
      compressorNode.ratio.value = COMPRESSOR_RATIO;
      compressorNode.attack.value = COMPRESSOR_ATTACK_S;
      compressorNode.release.value = COMPRESSOR_RELEASE_S;
      const makeupGainNode = audioContext.createGain();
      makeupGainNode.gain.value = MAKEUP_GAIN;
      const destinationNode = audioContext.createMediaStreamDestination();

      sourceNode.connect(rnnoiseNode);
      rnnoiseNode.connect(compressorNode);
      compressorNode.connect(makeupGainNode);
      makeupGainNode.connect(destinationNode);
      await audioContext.resume();

      const processedAudioTrack = destinationNode.stream.getAudioTracks()[0];
      if (!processedAudioTrack) {
        throw new Error("RNNoise did not produce processed audio track");
      }

      const processedStream = new MediaStream([processedAudioTrack]);
      sourceStream.getVideoTracks().forEach((track) => processedStream.addTrack(track));

      this.disposeRnnoiseProcessing();
      this.rnnoiseAudioContext = audioContext;
      this.rnnoiseSource = sourceNode;
      this.rnnoiseNode = rnnoiseNode;
      this.compressorNode = compressorNode;
      this.makeupGainNode = makeupGainNode;
      this.rawStream = sourceStream;
      this.effective = "rnnoise";

      debugLog("rnnoise:enabled", {
        sampleRate: audioContext.sampleRate,
        processedTrackID: processedAudioTrack.id,
      });

      return processedStream;
    } catch (err) {
      const message = err instanceof Error ? err.message : "RNNoise initialization failed";
      debugLog("rnnoise:failed", { message });
      this.onError(`RNNoise unavailable (${message}). Using standard microphone processing.`);
      this.disposeRnnoiseProcessing();
      this.rawStream = sourceStream;
      this.effective = "browser";
      return sourceStream;
    }
  }

  private disposeRnnoiseProcessing(): void {
    try {
      this.rnnoiseSource?.disconnect();
    } catch {
      // ignore disconnect errors during teardown
    }
    try {
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
    } catch {
      // ignore destroy errors during teardown
    }
    try {
      this.compressorNode?.disconnect();
    } catch {
      // ignore disconnect errors during teardown
    }
    try {
      this.makeupGainNode?.disconnect();
    } catch {
      // ignore disconnect errors during teardown
    }
    try {
      this.rnnoiseAudioContext?.close();
    } catch {
      // ignore close errors during teardown
    }

    this.rnnoiseSource = null;
    this.rnnoiseNode = null;
    this.compressorNode = null;
    this.makeupGainNode = null;
    this.rnnoiseAudioContext = null;
    this.rnnoiseSuspendedSince = null;
  }

  private static loadRnnoiseBinary(): Promise<ArrayBuffer> {
    if (!LocalCapture.rnnoiseBinaryPromise) {
      LocalCapture.rnnoiseBinaryPromise = loadRnnoise({
        url: rnnoiseWasmPath,
        simdUrl: rnnoiseSimdWasmPath,
      });
    }
    return LocalCapture.rnnoiseBinaryPromise;
  }
}
