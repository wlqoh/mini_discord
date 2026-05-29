import type {
  JoinVoiceResponse,
  RTCSignalEvent,
  RTCSignalPayload,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { ChatSocket } from "./chatSocket";
import { getTurnCredentials, type TurnCredentialsResponse } from "./turnApi";

type RemoteStreamListener = (user: VoiceParticipant, stream: MediaStream) => void;
type RemoteLeftListener = (userId: number) => void;
type LocalStreamListener = (stream: MediaStream | null) => void;
type ErrorListener = (message: string) => void;
type CameraFacingMode = "user" | "environment";

type PeerState = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  user: VoiceParticipant;
  pendingCandidates: RTCIceCandidateInit[];
};

function isWebRTCDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("webrtc_debug") === "1";
  } catch {
    return false;
  }
}

function debugLog(...args: unknown[]): void {
  if (!isWebRTCDebugEnabled()) {
    return;
  }
  console.log("[webrtc]", ...args);
}

function formatMediaError(err: unknown): string {
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

function parseUrls(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthy(raw: string | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function buildIceServers(turnCredentials?: TurnCredentialsResponse): RTCIceServer[] {
  const stunUrls = parseUrls(import.meta.env.VITE_WEBRTC_STUN_URLS as string | undefined);
  const turnUrls = turnCredentials?.urls?.length
    ? turnCredentials.urls
    : parseUrls(import.meta.env.VITE_WEBRTC_TURN_URLS as string | undefined);

  const servers: RTCIceServer[] = [];

  if (stunUrls.length) {
    servers.push({ urls: stunUrls });
  } else {
    servers.push({ urls: ["stun:stun.l.google.com:19302"] });
  }

  if (turnUrls.length) {
    const username = turnCredentials?.username?.trim() ?? (import.meta.env.VITE_WEBRTC_TURN_USERNAME as string | undefined)?.trim();
    const credential =
      turnCredentials?.credential?.trim() ?? (import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL as string | undefined)?.trim();

    if (username && credential) {
      servers.push({
        urls: turnUrls,
        username,
        credential,
      });
    }
  }

  return servers;
}

function buildIceTransportPolicy(): RTCIceTransportPolicy {
  return isTruthy(import.meta.env.VITE_WEBRTC_FORCE_RELAY as string | undefined) ? "relay" : "all";
}

function hasUsableTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const hasTurnURL = urls.some((url) => typeof url === "string" && /^turns?:/i.test(url));
    return hasTurnURL && Boolean(server.username) && Boolean(server.credential);
  });
}

export class CallClient {
  private readonly socket: ChatSocket;

  private readonly selfUserID: number;

  private readonly peers = new Map<number, PeerState>();

  private readonly participants = new Map<number, VoiceParticipant>();

  private readonly unsubscribers: Array<() => void> = [];

  private localStream: MediaStream | null = null;

  private rawLocalStream: MediaStream | null = null;

  private currentChannelID = 0;

  private iceServers = buildIceServers();

  private turnCredentialsPromise: Promise<void> | null = null;
  private preferredFacingMode: CameraFacingMode = "user";
  private switchCameraPromise: Promise<void> | null = null;
  private screenSharePromise: Promise<boolean> | null = null;

  private screenStream: MediaStream | null = null;

  private cameraTrack: MediaStreamTrack | null = null;

  private readonly onRemoteStream: RemoteStreamListener;

  private readonly onRemoteLeft: RemoteLeftListener;

  private readonly onLocalStream: LocalStreamListener;

  private readonly onError: ErrorListener;

  private readonly renegotiateRetryTimers = new Map<number, number>();
  private readonly iceRestartTimers = new Map<number, number>();
  private readonly iceRestartAttempts = new Map<number, number>();

  private rnnoiseAudioContext: AudioContext | null = null;

  private rnnoiseSource: MediaStreamAudioSourceNode | null = null;

  private rnnoiseNode: RnnoiseWorkletNode | null = null;

  private static rnnoiseBinaryPromise: Promise<ArrayBuffer> | null = null;

  constructor(
    socket: ChatSocket,
    selfUserID: number,
    onRemoteStream: RemoteStreamListener,
    onRemoteLeft: RemoteLeftListener,
    onLocalStream: LocalStreamListener,
    onError: ErrorListener,
  ) {
    this.socket = socket;
    this.selfUserID = selfUserID;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteLeft = onRemoteLeft;
    this.onLocalStream = onLocalStream;
    this.onError = onError;

    this.unsubscribers.push(this.socket.onVoiceUserJoined((event) => this.handleVoiceUserJoined(event)));
    this.unsubscribers.push(this.socket.onVoiceUserLeft((event) => this.handleVoiceUserLeft(event)));
    this.unsubscribers.push(this.socket.onRTCSignal((event) => void this.handleRTCSignal(event)));
  }

  async join(channelID: number): Promise<JoinVoiceResponse> {
    if (this.currentChannelID === channelID) {
      return {
        channel_id: channelID,
        participants: Array.from(this.participants.values()),
      };
    }

    await this.leave();

    await this.ensureTurnCredentials();
    debugLog("join:start", { channelID, iceServers: this.iceServers, policy: buildIceTransportPolicy() });

    const response: JoinVoiceResponse = await this.socket.joinVoiceChannel(channelID);

    this.currentChannelID = response.channel_id;
    debugLog("join:channel-joined", { channelID: response.channel_id, participants: response.participants.map((p) => p.user_id) });

    try {
      this.localStream = await this.acquireLocalStream();
      // Start voice channels in audio-first mode to reduce mesh bandwidth pressure.
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
      this.onLocalStream(this.localStream);
    } catch (err) {
      this.localStream = null;
      this.onLocalStream(null);
      const message = err instanceof Error ? err.message : "Failed to access microphone/camera";
      debugLog("join:local-stream-failed", { message });
      this.onError(`${message}. Joined voice in listen-only mode.`);
    }

    response.participants.forEach((participant) => {
      this.participants.set(participant.user_id, participant);
      const shouldInitiate = this.selfUserID < participant.user_id;
      void this.ensurePeer(participant, shouldInitiate);
    });

    return response;
  }

  async startScreenShare(): Promise<void> {
    if (this.isScreenShareActive()) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }

    const displayStream = await mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    const displayTrack = displayStream.getVideoTracks()[0];
    if (!displayTrack) {
      throw new Error("No display video track found");
    }

    this.screenStream = displayStream;

    this.cameraTrack = this.localStream?.getVideoTracks()[0] ?? null;

    const previewStream = new MediaStream();
    this.localStream?.getAudioTracks().forEach((track) => previewStream.addTrack(track));
    previewStream.addTrack(displayTrack);
    this.onLocalStream(previewStream);

    await this.updateVideoTrackForPeers(displayTrack, displayStream);

    displayTrack.onended = () => {
      void this.stopScreenShare();
    };
  };

  async stopScreenShare(): Promise<void> {
    if (!this.isScreenShareActive()) {
      return;
    }

    const activeScreenStream = this.screenStream;
    if (!activeScreenStream) {
      return;
    }

    const screenTrack = activeScreenStream.getVideoTracks()[0];
    screenTrack.stop();
    this.screenStream = null;

    const fallbackTrack = this.cameraTrack ?? this.localStream?.getVideoTracks()[0] ?? null;

    await this.updateVideoTrackForPeers(fallbackTrack, this.localStream);

    this.onLocalStream(this.localStream);
  };

  private hasStaticTurnCredentials(): boolean {
    const turnUrls = parseUrls(import.meta.env.VITE_WEBRTC_TURN_URLS as string | undefined);
    const username = (import.meta.env.VITE_WEBRTC_TURN_USERNAME as string | undefined)?.trim();
    const credential = (import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL as string | undefined)?.trim();
    return turnUrls.length > 0 && Boolean(username) && Boolean(credential);
  }

  private isRelayOnlyMode(): boolean {
    return buildIceTransportPolicy() === "relay";
  }

  private ensureRelayTurnReady(): void {
    if (this.isRelayOnlyMode() && !hasUsableTurnServer(this.iceServers)) {
      throw new Error("TURN credentials are required when relay mode is enabled");
    }
  }

  private async ensureTurnCredentials(): Promise<void> {
    if (!this.turnCredentialsPromise) {
      this.turnCredentialsPromise = (async () => {
        if (this.hasStaticTurnCredentials()) {
          this.iceServers = buildIceServers();
          this.ensureRelayTurnReady();
          return;
        }

        try {
          const turnCredentials = await getTurnCredentials();
          this.iceServers = buildIceServers(turnCredentials);
          this.ensureRelayTurnReady();
        } catch (err) {
          this.turnCredentialsPromise = null;
          const message = err instanceof Error ? err.message : "Failed to load TURN credentials";

          if (!this.isRelayOnlyMode()) {
            this.onError(message);
            return;
          }

          throw new Error(message);
        }
      })();
    }

    await this.turnCredentialsPromise;
  }

  private async acquireLocalStream(): Promise<MediaStream> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone/camera access");
    }

    try {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      // Prefer full voice+video for channels, fallback to audio-only.
      const stream = await mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: {
          facingMode: { ideal: this.preferredFacingMode },
        },
      });
      await this.enforceAudioProcessing(stream);
      return await this.applyRnnoiseProcessing(stream);
    } catch (videoErr) {
      try {
        const stream = await mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        await this.enforceAudioProcessing(stream);
        return await this.applyRnnoiseProcessing(stream);
      } catch (audioErr) {
        throw new Error(formatMediaError(audioErr ?? videoErr));
      }
    }
  }

  async leave(): Promise<void> {
    if (this.currentChannelID > 0) {
      try {
        await this.socket.leaveVoiceChannel();
      } catch {
        // ignore disconnect race
      }
    }

    this.closeAllPeers();
    this.participants.clear();
    this.currentChannelID = 0;
    this.stopLocalTracks();
  }

  dispose(): void {
    void this.leave();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers.length = 0;
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  setCameraEnabled(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  isScreenShareActive(): boolean {
    return Boolean(this.screenStream && this.screenStream.getVideoTracks()[0]?.readyState !== "ended");
  }

  async toggleScreenShare(): Promise<boolean> {
    if (!this.localStream) {
      throw new Error("Join voice channel before sharing screen");
    }

    if (this.screenSharePromise) {
      return this.screenSharePromise;
    }

    this.screenSharePromise = (async () => {
      if (this.isScreenShareActive()) {
        await this.stopScreenShare();
        return false;
      }
      await this.startScreenShare();
      return true;
    })().finally(() => {
      this.screenSharePromise = null;
    });

    return this.screenSharePromise;
  }

  async toggleCameraFacingMode(): Promise<void> {
    if (!this.localStream) {
      throw new Error("Join voice channel before switching camera");
    }
    if (this.isScreenShareActive()) {
      throw new Error("Stop screen sharing before switching camera");
    }
    if (this.switchCameraPromise) {
      return this.switchCameraPromise;
    }

    this.switchCameraPromise = this.switchCameraFacingMode().finally(() => {
      this.switchCameraPromise = null;
    });

    return this.switchCameraPromise;
  }

  private async switchCameraFacingMode(): Promise<void> {
    const currentLocalStream = this.localStream;
    if (!currentLocalStream) {
      throw new Error("Join voice channel before switching camera");
    }

    const currentVideoTrack = currentLocalStream.getVideoTracks()[0];
    if (!currentVideoTrack) {
      throw new Error("No camera track available in this call");
    }

    const nextFacingMode: CameraFacingMode = this.preferredFacingMode === "user" ? "environment" : "user";
    const replacementTrack = await this.acquireVideoTrack(nextFacingMode);
    replacementTrack.enabled = currentVideoTrack.enabled;

    const nextLocalStream = new MediaStream([...currentLocalStream.getAudioTracks(), replacementTrack]);

    try {
      await this.updateVideoTrackForPeers(replacementTrack, nextLocalStream);
    } catch {
      replacementTrack.stop();
      throw new Error("Failed to switch camera");
    }

    this.localStream = nextLocalStream;
    this.preferredFacingMode = nextFacingMode;
    this.onLocalStream(nextLocalStream);
    currentVideoTrack.stop();
  }

  private async acquireVideoTrack(facingMode: CameraFacingMode): Promise<MediaStreamTrack> {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera switching");
    }

    const attempts: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { exact: facingMode } } },
      { audio: false, video: { facingMode: { ideal: facingMode } } },
      { audio: false, video: true },
    ];

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
      } catch {
        // Try the next constraints profile.
      }
    }

    throw new Error("Failed to access another camera on this device");
  }

  private stopLocalTracks(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.rawLocalStream?.getTracks().forEach((track) => track.stop());
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.cameraTrack?.stop();
    this.rawLocalStream = null;
    this.screenStream = null;
    this.cameraTrack = null;
    this.switchCameraPromise = null;
    this.screenSharePromise = null;
    this.disposeRnnoiseProcessing();
    this.localStream = null;
    this.onLocalStream(null);
  }

  private closeAllPeers(): void {
    this.renegotiateRetryTimers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    this.renegotiateRetryTimers.clear();
    this.iceRestartTimers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    this.iceRestartTimers.clear();
    this.iceRestartAttempts.clear();

    this.peers.forEach((state, userID) => {
      state.pc.close();
      this.onRemoteLeft(userID);
    });
    this.peers.clear();
  }

  private async ensurePeer(user: VoiceParticipant, initiateOffer: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(user.user_id);
    if (existing) {
      existing.user = user;
      return existing.pc;
    }

    const remoteStream = new MediaStream();
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: buildIceTransportPolicy(),
    });
    debugLog("peer:create", { userID: user.user_id, initiateOffer });

    pc.ontrack = (event) => {
      debugLog("peer:ontrack", {
        fromUserID: user.user_id,
        kind: event.track.kind,
        trackID: event.track.id,
        muted: event.track.muted,
        readyState: event.track.readyState,
        streamIDs: event.streams.map((s) => s.id),
      });
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else if (!remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      event.track.onended = () => {
        const endedTrack = remoteStream.getTracks().find((t) => t.id === event.track.id);
        if (endedTrack) {
          remoteStream.removeTrack(endedTrack);
        }
        this.onRemoteStream(user, remoteStream);
      };
      this.onRemoteStream(user, remoteStream);
    };

    pc.oniceconnectionstatechange = () => {
      debugLog("peer:ice-state", { userID: user.user_id, state: pc.iceConnectionState });
      const state = pc.iceConnectionState;
      if (state === "failed") {
        this.scheduleIceRestart(user.user_id, "failed");
      } else if (state === "disconnected") {
        this.scheduleIceRestart(user.user_id, "disconnected");
      } else if (state === "connected" || state === "completed") {
        this.clearIceRestart(user.user_id);
      }
    };
    pc.onconnectionstatechange = () => {
      debugLog("peer:connection-state", { userID: user.user_id, state: pc.connectionState });
    };
    pc.onsignalingstatechange = () => {
      debugLog("peer:signaling-state", { userID: user.user_id, state: pc.signalingState });
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.currentChannelID <= 0) {
        return;
      }
      debugLog("peer:local-candidate", {
        toUserID: user.user_id,
        type: event.candidate.type,
        protocol: event.candidate.protocol,
      });

      const payload: RTCSignalPayload = {
        channel_id: this.currentChannelID,
        to_user_id: user.user_id,
        signal_type: "candidate",
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid ?? undefined,
        sdp_mline_index: event.candidate.sdpMLineIndex ?? undefined,
      };
      void this.socket.sendRTCSignal(payload);
    };

    this.localStream?.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream as MediaStream);
    });
    const hasLocalAudio = (this.localStream?.getAudioTracks().length ?? 0) > 0;
    const hasLocalVideo = (this.localStream?.getVideoTracks().length ?? 0) > 0;
    if (!hasLocalAudio) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    if (!hasLocalVideo) {
      pc.addTransceiver("video", { direction: "recvonly" });
    }

    this.peers.set(user.user_id, { pc, stream: remoteStream, user, pendingCandidates: [] });

    if (initiateOffer) {
      await this.createAndSendOffer(user.user_id);
    }

    return pc;
  }

  private async createAndSendOffer(remoteUserID: number, options?: { iceRestart?: boolean }): Promise<void> {
    const peer = this.peers.get(remoteUserID);
    if (!peer || this.currentChannelID <= 0) {
      return;
    }

    if (peer.pc.signalingState !== "stable") {
      this.scheduleRenegotiationRetry(remoteUserID);
      return;
    }

    try {
      const offer = await peer.pc.createOffer({ iceRestart: options?.iceRestart });
      await peer.pc.setLocalDescription(offer);
      debugLog("signal:offer-send", { remoteUserID, sdpSize: offer.sdp?.length ?? 0, iceRestart: Boolean(options?.iceRestart) });

      await this.socket.sendRTCSignal({
        channel_id: this.currentChannelID,
        to_user_id: remoteUserID,
        signal_type: "offer",
        sdp: offer.sdp,
      });
    } catch {
      this.onError("Failed to create WebRTC offer");
    }
  }

  private clearIceRestart(remoteUserID: number): void {
    const timerId = this.iceRestartTimers.get(remoteUserID);
    if (timerId) {
      window.clearTimeout(timerId);
      this.iceRestartTimers.delete(remoteUserID);
    }
    this.iceRestartAttempts.delete(remoteUserID);
  }

  private scheduleIceRestart(remoteUserID: number, reason: "failed" | "disconnected"): void {
    if (this.iceRestartTimers.has(remoteUserID)) {
      return;
    }

    const attempt = (this.iceRestartAttempts.get(remoteUserID) ?? 0) + 1;
    if (attempt > 3) {
      this.iceRestartAttempts.set(remoteUserID, attempt);
      return;
    }

    const delayMs = reason === "failed" ? 1500 : 4000;
    const timerId = window.setTimeout(() => {
      this.iceRestartTimers.delete(remoteUserID);
      void this.restartIce(remoteUserID);
    }, delayMs);

    this.iceRestartTimers.set(remoteUserID, timerId);
    this.iceRestartAttempts.set(remoteUserID, attempt);
  }

  private async restartIce(remoteUserID: number): Promise<void> {
    const peer = this.peers.get(remoteUserID);
    if (!peer || this.currentChannelID <= 0) {
      return;
    }

    if (peer.pc.signalingState !== "stable") {
      this.scheduleRenegotiationRetry(remoteUserID);
      return;
    }

    try {
      peer.pc.restartIce();
    } catch {
      // restartIce is best-effort; fallback to offer-based restart.
    }

    await this.createAndSendOffer(remoteUserID, { iceRestart: true });
  }

  private scheduleRenegotiationRetry(remoteUserID: number): void {
    if (this.renegotiateRetryTimers.has(remoteUserID)) {
      return;
    }
    const timerId = window.setTimeout(() => {
      this.renegotiateRetryTimers.delete(remoteUserID);
      void this.createAndSendOffer(remoteUserID);
    }, 250);
    this.renegotiateRetryTimers.set(remoteUserID, timerId);
  }

  private async updateVideoTrackForPeers(track: MediaStreamTrack | null, stream: MediaStream | null): Promise<void> {
    const renegotiateTargets: number[] = [];

    for (const [userID, { pc }] of this.peers) {
      const videoTransceiver = pc
        .getTransceivers()
        .find((t) => t.sender.track?.kind === "video" || t.receiver.track?.kind === "video");

      const sender = videoTransceiver?.sender ?? pc.getSenders().find((s) => s.track?.kind === "video");

      if (sender) {
        await sender.replaceTrack(track);
        if (videoTransceiver) {
          videoTransceiver.direction = track ? "sendrecv" : "recvonly";
        }
      } else if (track && stream) {
        pc.addTrack(track, stream);
      }

      renegotiateTargets.push(userID);
    }

    await Promise.all(renegotiateTargets.map((userID) => this.createAndSendOffer(userID)));
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
      this.rawLocalStream = sourceStream;
      return sourceStream;
    }

    if (!window.isSecureContext || typeof AudioWorkletNode === "undefined") {
      debugLog("rnnoise:unsupported", {
        isSecureContext: window.isSecureContext,
        hasAudioWorkletNode: typeof AudioWorkletNode !== "undefined",
      });
      this.rawLocalStream = sourceStream;
      return sourceStream;
    }

    try {
      const audioContext = new AudioContext({ sampleRate: 48000 });
      await audioContext.audioWorklet.addModule(rnnoiseWorkletPath);

      const wasmBinary = await CallClient.loadRnnoiseBinary();
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
      this.rawLocalStream = sourceStream;

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
      this.rawLocalStream = sourceStream;
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
  }

  private static loadRnnoiseBinary(): Promise<ArrayBuffer> {
    if (!CallClient.rnnoiseBinaryPromise) {
      CallClient.rnnoiseBinaryPromise = loadRnnoise({
        url: rnnoiseWasmPath,
        simdUrl: rnnoiseSimdWasmPath,
      });
    }
    return CallClient.rnnoiseBinaryPromise;
  }

  private handleVoiceUserJoined(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user || event.user.user_id === this.selfUserID) {
      return;
    }

    this.participants.set(event.user.user_id, event.user);
    const shouldInitiate = this.selfUserID < event.user.user_id;
    void this.ensurePeer(event.user, shouldInitiate);
  }

  private handleVoiceUserLeft(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user) {
      return;
    }

    this.participants.delete(event.user.user_id);

    const state = this.peers.get(event.user.user_id);
    if (!state) {
      return;
    }

    const timerId = this.iceRestartTimers.get(event.user.user_id);
    if (timerId) {
      window.clearTimeout(timerId);
      this.iceRestartTimers.delete(event.user.user_id);
    }
    this.iceRestartAttempts.delete(event.user.user_id);

    state.pc.close();
    this.peers.delete(event.user.user_id);
    this.onRemoteLeft(event.user.user_id);
  }

  private async handleRTCSignal(event: RTCSignalEvent): Promise<void> {
    if (event.channel_id !== this.currentChannelID || event.from_user_id === this.selfUserID) {
      return;
    }

    const participant = this.participants.get(event.from_user_id) ?? { user_id: event.from_user_id };
    this.participants.set(event.from_user_id, participant);
    debugLog("signal:incoming", { from: event.from_user_id, signal_type: event.signal_type });

    const pc = await this.ensurePeer(participant, false);
    const peer = this.peers.get(event.from_user_id);
    if (!peer) {
      return;
    }

    try {
      if (event.signal_type === "offer") {
        if (!event.sdp) {
          return;
        }
        if (pc.signalingState !== "stable") {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription({ type: "offer", sdp: event.sdp });
        await this.flushPendingCandidates(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await this.socket.sendRTCSignal({
          channel_id: this.currentChannelID,
          to_user_id: event.from_user_id,
          signal_type: "answer",
          sdp: answer.sdp,
        });
        return;
      }

      if (event.signal_type === "answer") {
        if (!event.sdp) {
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
        await this.flushPendingCandidates(peer);
        return;
      }

      if (!event.candidate) {
        return;
      }

      const candidate: RTCIceCandidateInit = {
        candidate: event.candidate,
        sdpMid: event.sdp_mid,
        sdpMLineIndex: event.sdp_mline_index,
      };

      if (!pc.remoteDescription) {
        peer.pendingCandidates.push(candidate);
        return;
      }

      await pc.addIceCandidate(candidate);
    } catch {
      this.onError("Failed to handle WebRTC signal");
    }
  }

  private async flushPendingCandidates(peer: PeerState): Promise<void> {
    if (!peer.pendingCandidates.length) {
      return;
    }

    const pending = [...peer.pendingCandidates];
    peer.pendingCandidates.length = 0;

    for (const candidate of pending) {
      await peer.pc.addIceCandidate(candidate);
    }
  }
}


