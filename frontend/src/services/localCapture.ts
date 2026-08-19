import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { ErrorListener } from "./voiceClient";
import { debugLog } from "./webrtcShared";

export type CameraFacingMode = "user" | "environment";

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

  private stream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private preferredFacingMode: CameraFacingMode = "user";

  private rnnoiseAudioContext: AudioContext | null = null;
  private rnnoiseSource: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  // Timestamp of when the RNNoise AudioContext first went "suspended"
  // (browser autoplay policy, background-tab throttling, device change), or
  // null when it isn't. If it stays suspended too long the outgoing audio
  // track goes silent while the UI still shows the mic as enabled — checked
  // by checkWatchdogFallback, which the owner's reconciliation loop polls.
  private rnnoiseSuspendedSince: number | null = null;
  private static readonly RNNOISE_SUSPENDED_FALLBACK_MS = 3000;

  private static rnnoiseBinaryPromise: Promise<ArrayBuffer> | null = null;

  constructor(onError: ErrorListener) {
    this.onError = onError;
  }

  get currentStream(): MediaStream | null {
    return this.stream;
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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      throw new Error(formatMediaError(err));
    }

    await this.enforceAudioProcessing(stream);
    this.stream = await this.applyRnnoiseProcessing(stream);
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
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
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
    this.rnnoiseSuspendedSince = null;
    return rawAudioTrack;
  }

  private async enforceAudioProcessing(stream: MediaStream): Promise<void> {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      return;
    }
    try {
      await audioTrack.applyConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    } catch {
      // Best-effort on browsers with partial constraint support.
    }
  }

  private async applyRnnoiseProcessing(sourceStream: MediaStream): Promise<MediaStream> {
    const sourceAudioTrack = sourceStream.getAudioTracks()[0];
    if (!sourceAudioTrack) {
      this.rawStream = sourceStream;
      return sourceStream;
    }

    if (!window.isSecureContext || typeof AudioWorkletNode === "undefined") {
      debugLog("rnnoise:unsupported", {
        isSecureContext: window.isSecureContext,
        hasAudioWorkletNode: typeof AudioWorkletNode !== "undefined",
      });
      this.rawStream = sourceStream;
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
      const destinationNode = audioContext.createMediaStreamDestination();

      sourceNode.connect(rnnoiseNode);
      rnnoiseNode.connect(destinationNode);
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
      this.rawStream = sourceStream;

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
      this.rnnoiseAudioContext?.close();
    } catch {
      // ignore close errors during teardown
    }

    this.rnnoiseSource = null;
    this.rnnoiseNode = null;
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
