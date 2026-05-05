import type {
  JoinVoiceResponse,
  RTCSignalEvent,
  RTCSignalPayload,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
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

const SCREEN_SHARE_TARGET_WIDTH = 2560;
const SCREEN_SHARE_TARGET_HEIGHT = 1440;
const SCREEN_SHARE_TARGET_FPS = 60;

function buildScreenShareVideoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: SCREEN_SHARE_TARGET_WIDTH },
    height: { ideal: SCREEN_SHARE_TARGET_HEIGHT },
    frameRate: { ideal: SCREEN_SHARE_TARGET_FPS },
  };
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

  private currentChannelID = 0;

  private iceServers = buildIceServers();

  private turnCredentialsPromise: Promise<void> | null = null;
  private preferredFacingMode: CameraFacingMode = "user";
  private switchCameraPromise: Promise<void> | null = null;
  private screenSharePromise: Promise<boolean> | null = null;
  private screenShareTrack: MediaStreamTrack | null = null;
  private cameraTrackBeforeScreenShare: MediaStreamTrack | null = null;

  private readonly onRemoteStream: RemoteStreamListener;

  private readonly onRemoteLeft: RemoteLeftListener;

  private readonly onLocalStream: LocalStreamListener;

  private readonly onError: ErrorListener;

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

  async join(channelID: number): Promise<void> {
    if (this.currentChannelID === channelID) {
      return;
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
  }

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
      // Prefer full voice+video for channels, fallback to audio-only.
      return await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: { ideal: this.preferredFacingMode },
        },
      });
    } catch (videoErr) {
      try {
        return await mediaDevices.getUserMedia({ audio: true, video: false });
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
    return Boolean(this.screenShareTrack && this.screenShareTrack.readyState !== "ended");
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

  async toggleScreenShare(): Promise<boolean> {
    if (!this.localStream) {
      throw new Error("Join voice channel before sharing screen");
    }

    if (this.screenSharePromise) {
      return this.screenSharePromise;
    }

    this.screenSharePromise = (this.isScreenShareActive() ? this.stopScreenShare() : this.startScreenShare()).finally(() => {
      this.screenSharePromise = null;
    });

    return this.screenSharePromise;
  }

  private async startScreenShare(): Promise<boolean> {
    const mediaDevices = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
    };
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }

    const currentLocalStream = this.localStream;
    if (!currentLocalStream) {
      throw new Error("Join voice channel before sharing screen");
    }

    const videoConstraints = buildScreenShareVideoConstraints();
    const displayStream = await mediaDevices.getDisplayMedia({
      audio: false,
      video: videoConstraints,
    });
    const displayTrack = displayStream.getVideoTracks()[0];
    if (!displayTrack) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error("Failed to start screen sharing");
    }

    displayTrack.contentHint = "detail";
    try {
      await displayTrack.applyConstraints(videoConstraints);
    } catch {
      debugLog("screen-share:constraints-not-fully-applied", videoConstraints);
    }
    debugLog("screen-share:active-settings", displayTrack.getSettings());

    const currentVideoTrack = currentLocalStream.getVideoTracks()[0] ?? null;
    this.cameraTrackBeforeScreenShare = currentVideoTrack;
    displayTrack.enabled = currentVideoTrack?.enabled ?? true;
    displayTrack.onended = () => {
      if (this.screenShareTrack?.id === displayTrack.id) {
        void this.stopScreenShareOnEnded();
      }
    };

    try {
      await this.replaceVideoTrackForPeers(displayTrack);
    } catch {
      displayStream.getTracks().forEach((track) => track.stop());
      this.cameraTrackBeforeScreenShare = null;
      throw new Error("Failed to start screen sharing");
    }

    this.localStream = new MediaStream([...currentLocalStream.getAudioTracks(), displayTrack]);
    this.screenShareTrack = displayTrack;
    this.onLocalStream(this.localStream);
    return true;
  }

  private async stopScreenShare(): Promise<boolean> {
    return this.stopScreenShareInternal(false);
  }

  private async stopScreenShareOnEnded(): Promise<void> {
    try {
      await this.stopScreenShareInternal(true);
    } catch {
      // Best-effort restore on native picker stop.
    }
  }

  private async stopScreenShareInternal(fromEndedEvent: boolean): Promise<boolean> {
    const activeScreenTrack = this.screenShareTrack;
    if (!activeScreenTrack) {
      return false;
    }

    const currentLocalStream = this.localStream;
    if (!currentLocalStream) {
      this.screenShareTrack = null;
      this.cameraTrackBeforeScreenShare = null;
      return false;
    }

    let cameraTrack = this.cameraTrackBeforeScreenShare;
    if (!cameraTrack || cameraTrack.readyState === "ended") {
      try {
        cameraTrack = await this.acquireVideoTrack(this.preferredFacingMode);
      } catch {
        cameraTrack = null;
      }
    }

    if (cameraTrack) {
      cameraTrack.enabled = activeScreenTrack.enabled;
    }

    try {
      await this.replaceVideoTrackForPeers(cameraTrack ?? null);
    } catch {
      if (!fromEndedEvent) {
        throw new Error("Failed to stop screen sharing");
      }

      // Fallback: screen-share track is already ended, keep call alive in audio-only mode.
      this.localStream = new MediaStream([...currentLocalStream.getAudioTracks()]);
      this.onLocalStream(this.localStream);
      this.screenShareTrack = null;
      this.cameraTrackBeforeScreenShare = null;
      return false;
    }

    this.localStream = cameraTrack
      ? new MediaStream([...currentLocalStream.getAudioTracks(), cameraTrack])
      : new MediaStream([...currentLocalStream.getAudioTracks()]);
    this.onLocalStream(this.localStream);

    if (activeScreenTrack.readyState !== "ended") {
      activeScreenTrack.stop();
    }
    this.screenShareTrack = null;
    this.cameraTrackBeforeScreenShare = null;
    return false;
  }

  private async replaceVideoTrackForPeers(track: MediaStreamTrack | null): Promise<void> {
    for (const peerState of this.peers.values()) {
      const directSender = peerState.pc.getSenders().find((sender) => sender.track?.kind === "video");
      const fallbackSender =
        peerState.pc
          .getTransceivers()
          .find((transceiver) => transceiver.receiver?.track?.kind === "video")?.sender ?? null;
      const sender = directSender ?? fallbackSender;
      if (!sender) {
        continue;
      }
      await sender.replaceTrack(track);
    }
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

    const nextLocalStream = new MediaStream([
      ...currentLocalStream.getAudioTracks(),
      replacementTrack,
    ]);

    try {
      await this.replaceVideoTrackForPeers(replacementTrack);
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
    const activeTrackIDs = new Set(this.localStream?.getTracks().map((track) => track.id) ?? []);
    this.localStream?.getTracks().forEach((track) => track.stop());
    if (this.cameraTrackBeforeScreenShare && !activeTrackIDs.has(this.cameraTrackBeforeScreenShare.id)) {
      this.cameraTrackBeforeScreenShare.stop();
    }
    if (this.screenShareTrack && !activeTrackIDs.has(this.screenShareTrack.id)) {
      this.screenShareTrack.stop();
    }
    this.screenSharePromise = null;
    this.switchCameraPromise = null;
    this.cameraTrackBeforeScreenShare = null;
    this.screenShareTrack = null;
    this.localStream = null;
    this.onLocalStream(null);
  }

  private closeAllPeers(): void {
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
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      this.onRemoteStream(user, remoteStream);
    };

    pc.oniceconnectionstatechange = () => {
      debugLog("peer:ice-state", { userID: user.user_id, state: pc.iceConnectionState });
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

  private async createAndSendOffer(remoteUserID: number): Promise<void> {
    const peer = this.peers.get(remoteUserID);
    if (!peer || this.currentChannelID <= 0) {
      return;
    }

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      debugLog("signal:offer-send", { remoteUserID, sdpSize: offer.sdp?.length ?? 0 });

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
    debugLog("signal:incoming", { from: event.from_user_id, type: event.signal_type });

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

