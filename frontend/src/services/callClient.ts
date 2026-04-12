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
  pendingCandidates: RTCIceCandidateInit[];
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

function envVar(name: string): string {
  const meta = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };

  return (meta.env?.[name] || "").trim();
}

function buildIceServers(): RTCIceServer[] {
  const rawStun = envVar("VITE_WEBRTC_STUN_URLS");
  const stunUrls = (rawStun || "stun:stun.l.google.com:19302")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const iceServers: RTCIceServer[] = [];

  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  const rawTurn = envVar("VITE_WEBRTC_TURN_URLS");
  const turnUsername = envVar("VITE_WEBRTC_TURN_USERNAME");
  const turnCredential = envVar("VITE_WEBRTC_TURN_CREDENTIAL");

  if (rawTurn && turnUsername && turnCredential) {
    const turnUrls = rawTurn
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (turnUrls.length) {
      iceServers.push({
        urls: turnUrls,
        username: turnUsername,
        credential: turnCredential,
      });
    }
  }

  return iceServers.length ? iceServers : [{ urls: ["stun:stun.l.google.com:19302"] }];
}

export class CallClient {
  private readonly socket: ChatSocket;

  private readonly selfUserID: number;

  private readonly peers = new Map<number, PeerState>();

  private readonly participants = new Map<number, VoiceParticipant>();

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
    this.peers.clear();
  }

  private async ensurePeer(user: VoiceParticipant, initiateOffer: boolean): Promise<RTCPeerConnection> {
    const existing = this.peers.get(user.user_id);
    if (existing) {
      existing.user = user;
      return existing.pc;
    }

    const remoteStream = new MediaStream();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      this.onRemoteStream(user, remoteStream);
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

    this.localStream?.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream as MediaStream);
    });

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


