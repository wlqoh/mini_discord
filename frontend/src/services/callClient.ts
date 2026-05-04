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
  // eslint-disable-next-line no-console
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

  private currentChannelID = 0;

  private iceServers = buildIceServers();

  private turnCredentialsPromise: Promise<void> | null = null;

  private screenStream: MediaStream | null = null;

  private cameraTrack: MediaStreamTrack | null = null;

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

  async startScreenShare(): Promise<void> {
    if (this.screenStream) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }

    const displayStream = await mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
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

    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        void sender.replaceTrack(displayTrack);
        return;
      }
      pc.addTrack(displayTrack, displayStream);
    });

    displayTrack.onended = () => {
      void this.stopScreenShare();
    };
  };

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) {
      return;
    }

    const screenTrack = this.screenStream.getVideoTracks()[0];
    screenTrack.stop();
    this.screenStream = null;

    const fallbackTrack = this.cameraTrack ?? this.localStream?.getVideoTracks()[0] ?? null;

    this.peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        void sender.replaceTrack(fallbackTrack);
      }
    });

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
      // Prefer full voice+video for channels, fallback to audio-only.
      return await mediaDevices.getUserMedia({ audio: true, video: true });
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

  private stopLocalTracks(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
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

