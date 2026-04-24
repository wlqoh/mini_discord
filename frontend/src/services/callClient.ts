import type {
  JoinVoiceResponse,
  RTCSignalEvent,
  RTCSignalPayload,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
import { ChatSocket } from "./chatSocket";

type RemoteStreamListener = (user: VoiceParticipant, stream: MediaStream) => void;
type RemoteLeftListener = (userId: number) => void;
type LocalStreamListener = (stream: MediaStream | null) => void;
type ErrorListener = (message: string) => void;

type PeerState = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  user: VoiceParticipant;
};

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

function buildIceServers(): RTCIceServer[] {
  const stunUrls = parseUrls(import.meta.env.VITE_WEBRTC_STUN_URLS as string | undefined);
  const turnUrls = parseUrls(import.meta.env.VITE_WEBRTC_TURN_URLS as string | undefined);

  const servers: RTCIceServer[] = [];

  if (stunUrls.length) {
    servers.push({ urls: stunUrls });
  } else {
    servers.push({ urls: ["stun:stun.l.google.com:19302"] });
  }

  if (turnUrls.length) {
    const username = (import.meta.env.VITE_WEBRTC_TURN_USERNAME as string | undefined)?.trim();
    const credential = (import.meta.env.VITE_WEBRTC_TURN_CREDENTIAL as string | undefined)?.trim();

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

export class CallClient {
  private static readonly ICE_RESTART_DELAY_MS = 2500;

  private readonly socket: ChatSocket;

  private readonly selfUserID: number;

  private readonly peers = new Map<number, PeerState>();

  private readonly participants = new Map<number, VoiceParticipant>();

  private readonly pendingIceCandidates = new Map<number, RTCIceCandidateInit[]>();

  private readonly scheduledIceRestarts = new Map<number, number>();

  private readonly unsubscribers: Array<() => void> = [];

  private localStream: MediaStream | null = null;

  private currentChannelID = 0;

  private readonly iceServers = buildIceServers();

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

    this.localStream = await this.acquireLocalStream();
    // Start voice channels in audio-first mode to reduce mesh bandwidth pressure.
    this.localStream.getVideoTracks().forEach((track) => {
      track.enabled = false;
    });
    this.onLocalStream(this.localStream);

    let response: JoinVoiceResponse;
    try {
      response = await this.socket.joinVoiceChannel(channelID);
    } catch (err) {
      this.stopLocalTracks();
      throw err;
    }

    this.currentChannelID = response.channel_id;

    response.participants.forEach((participant) => {
      this.participants.set(participant.user_id, participant);
      const shouldInitiate = this.selfUserID < participant.user_id;
      void this.ensurePeer(participant, shouldInitiate);
    });
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
    this.scheduledIceRestarts.forEach((timerId) => window.clearTimeout(timerId));
    this.scheduledIceRestarts.clear();
    this.peers.clear();
    this.pendingIceCandidates.clear();
  }

  private clearScheduledIceRestart(remoteUserID: number): void {
    const timerId = this.scheduledIceRestarts.get(remoteUserID);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.scheduledIceRestarts.delete(remoteUserID);
    }
  }

  private scheduleIceRestart(remoteUserID: number): void {
    if (this.currentChannelID <= 0 || this.selfUserID >= remoteUserID || this.scheduledIceRestarts.has(remoteUserID)) {
      return;
    }

    const timerId = window.setTimeout(() => {
      this.scheduledIceRestarts.delete(remoteUserID);
      void this.createAndSendOffer(remoteUserID, true);
    }, CallClient.ICE_RESTART_DELAY_MS);

    this.scheduledIceRestarts.set(remoteUserID, timerId);
  }

  private async flushPendingIceCandidates(remoteUserID: number, pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIceCandidates.get(remoteUserID);
    if (!queued?.length) {
      return;
    }

    this.pendingIceCandidates.delete(remoteUserID);
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate);
    }
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

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else if (!remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }

      const current = this.peers.get(user.user_id)?.user ?? user;
      this.onRemoteStream(current, remoteStream);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.currentChannelID <= 0) {
        return;
      }

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

    pc.oniceconnectionstatechange = () => {
      switch (pc.iceConnectionState) {
        case "connected":
        case "completed":
          this.clearScheduledIceRestart(user.user_id);
          break;
        case "disconnected":
        case "failed":
          this.scheduleIceRestart(user.user_id);
          break;
        default:
          break;
      }
    };

    this.localStream?.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream as MediaStream);
    });

    this.peers.set(user.user_id, { pc, stream: remoteStream, user });

    if (initiateOffer) {
      await this.createAndSendOffer(user.user_id);
    }

    return pc;
  }

  private async createAndSendOffer(remoteUserID: number, iceRestart = false): Promise<void> {
    const peer = this.peers.get(remoteUserID);
    if (!peer || this.currentChannelID <= 0) {
      return;
    }

    if (peer.pc.signalingState !== "stable") {
      if (iceRestart) {
        this.scheduleIceRestart(remoteUserID);
      }
      return;
    }

    try {
      const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.pc.setLocalDescription(offer);

      await this.socket.sendRTCSignal({
        channel_id: this.currentChannelID,
        to_user_id: remoteUserID,
        signal_type: "offer",
        sdp: offer.sdp,
      });
    } catch {
      if (iceRestart) {
        this.scheduleIceRestart(remoteUserID);
      }
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
    this.clearScheduledIceRestart(event.user.user_id);
    this.pendingIceCandidates.delete(event.user.user_id);
    this.onRemoteLeft(event.user.user_id);
  }

  private async handleRTCSignal(event: RTCSignalEvent): Promise<void> {
    if (event.channel_id !== this.currentChannelID || event.from_user_id === this.selfUserID) {
      return;
    }

    const participant = this.participants.get(event.from_user_id) ?? { user_id: event.from_user_id };
    this.participants.set(event.from_user_id, participant);

    const pc = await this.ensurePeer(participant, false);
    try {
      if (event.signal_type === "offer") {
        if (!event.sdp) {
          return;
        }

        if (pc.signalingState !== "stable") {
          await pc.setLocalDescription({ type: "rollback" });
        }

        await pc.setRemoteDescription({ type: "offer", sdp: event.sdp });
        await this.flushPendingIceCandidates(event.from_user_id, pc);
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
        await this.flushPendingIceCandidates(event.from_user_id, pc);
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
        const queued = this.pendingIceCandidates.get(event.from_user_id) ?? [];
        queued.push(candidate);
        this.pendingIceCandidates.set(event.from_user_id, queued);
        return;
      }

      await pc.addIceCandidate(candidate);
    } catch {
      this.onError("Failed to handle WebRTC signal");
    }
  }

}


