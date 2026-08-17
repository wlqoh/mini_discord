import type {
  JoinVoiceResponse,
  RTCSignalEvent,
  RTCSignalPayload,
  VoiceParticipant,
  VoiceUserEvent,
} from "../types/chat";
import { ChatSocket } from "./chatSocket";
import type {
  VoiceClient,
  RemoteStreamListener,
  RemoteLeftListener,
  LocalStreamListener,
  ErrorListener,
  QualityListener,
} from "./voiceClient";
import { LocalCapture, type CameraFacingMode } from "./localCapture";
import {
  debugLog,
  buildIceTransportPolicy,
  applyVideoBitratePreset,
  CAMERA_BITRATE_PRESET,
  SCREEN_BITRATE_PRESET,
  type VideoBitratePreset,
} from "./webrtcShared";
import { getTurnCredentials, type TurnCredentialsResponse } from "./turnApi";
import {
  QUALITY_SAMPLE_INTERVAL_MS,
  EMPTY_METRICS,
  applyHysteresis,
  buildQuality,
  createQualityTracker,
  qualitySignature,
  readForcedLevel,
  readQualitySample,
  type PeerQuality,
  type QualityLevel,
  type QualityTracker,
} from "./connectionQuality";

type PeerHealth = "ok" | "connecting" | "broken";

type PeerState = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  user: VoiceParticipant;
  pendingCandidates: RTCIceCandidateInit[];
  // Perfect-negotiation bookkeeping (see ensurePeer/handleDescription below).
  // The polite side accepts an implicit rollback on glare; the impolite side wins.
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
};

function parseUrls(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function hasUsableTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const hasTurnURL = urls.some((url) => typeof url === "string" && /^turns?:/i.test(url));
    return hasTurnURL && Boolean(server.username) && Boolean(server.credential);
  });
}

/**
 * Состояния, которые не нужно измерять: их авторитетно сообщает сам
 * RTCPeerConnection. Возвращает null, когда соединение живо и метрики осмысленны.
 */
function serviceLevelOf(pc: RTCPeerConnection): QualityLevel | null {
  switch (pc.connectionState) {
    case "new":
    case "connecting":
      return "connecting";
    case "disconnected":
    case "failed":
    case "closed":
      return "disconnected";
    default:
      return null;
  }
}

export class MeshCallClient implements VoiceClient {
  private readonly socket: ChatSocket;

  private readonly selfUserID: number;

  private readonly peers = new Map<number, PeerState>();

  private readonly participants = new Map<number, VoiceParticipant>();

  private readonly unsubscribers: Array<() => void> = [];

  // Mirrors capture?.currentStream — kept as its own field because most of
  // this class reads this.localStream directly rather than going through
  // capture, and updating every call site would be a much larger diff for
  // no behavioral benefit. Always kept in sync by whoever changes capture's
  // stream (attachJoin, switchCameraFacingMode, the RNNoise watchdog path in
  // reconcilePeers).
  private localStream: MediaStream | null = null;

  // Owns getUserMedia + RNNoise (see localCapture.ts). Nullable because a
  // factory-driven join hands in an already-acquired LocalCapture via
  // attachJoin rather than this class creating its own — see join()/
  // attachJoin below and callClientFactory.ts's note on why acquisition has
  // to happen before the transport is known.
  private capture: LocalCapture | null = null;

  private currentChannelID = 0;

  private iceServers = buildIceServers();

  private turnCredentialsPromise: Promise<void> | null = null;
  // 0 means "static creds (never expire) or not fetched yet". Only set for
  // dynamically-issued (short-TTL) credentials from getTurnCredentials().
  private turnExpiresAt = 0;
  private switchCameraPromise: Promise<void> | null = null;
  private screenSharePromise: Promise<boolean> | null = null;

  private screenStream: MediaStream | null = null;

  private cameraTrack: MediaStreamTrack | null = null;

  private readonly onRemoteStream: RemoteStreamListener;

  private readonly onRemoteLeft: RemoteLeftListener;

  private readonly onLocalStream: LocalStreamListener;

  private readonly onError: ErrorListener;

  private readonly onQualityChange: QualityListener;

  private qualitySampleTimer: number | null = null;

  private readonly qualityTrackers = new Map<number, QualityTracker>();

  private lastQualitySignature = "";

  private readonly iceRestartTimers = new Map<number, number>();

  // Peer reconciliation: periodically reconciles the server's authoritative
  // participant list against the live peer map, recreating any peer that's
  // missing or stuck (lost signaling events, unresolved glare, dead ICE).
  private reconcileTimer: number | null = null;
  private readonly peerAttempts = new Map<number, number>();
  private readonly peerSince = new Map<number, number>();
  private static readonly RECONCILE_INTERVAL_MS = 4000;
  private static readonly CONNECT_GRACE_MS = 15000;
  private static readonly MAX_PEER_ATTEMPTS = 8;

  // Serializes signal handling per remote peer so an offer and the ICE
  // candidates that immediately follow it can't race each other.
  private readonly signalQueues = new Map<number, Promise<void>>();

  constructor(
    socket: ChatSocket,
    selfUserID: number,
    onRemoteStream: RemoteStreamListener,
    onRemoteLeft: RemoteLeftListener,
    onLocalStream: LocalStreamListener,
    onError: ErrorListener,
    onQualityChange: QualityListener,
  ) {
    this.socket = socket;
    this.selfUserID = selfUserID;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteLeft = onRemoteLeft;
    this.onLocalStream = onLocalStream;
    this.onError = onError;
    this.onQualityChange = onQualityChange;

    this.unsubscribers.push(this.socket.onVoiceUserJoined((event) => this.handleVoiceUserJoined(event)));
    this.unsubscribers.push(this.socket.onVoiceUserLeft((event) => this.handleVoiceUserLeft(event)));
    this.unsubscribers.push(
      this.socket.onRTCSignal((event) => this.enqueueSignal(event.from_user_id, () => this.handleRTCSignal(event))),
    );
  }

  /**
   * Serializes signal processing per remote peer. Without this, an offer and
   * the ICE candidates that immediately follow it can be handled concurrently,
   * racing setRemoteDescription against itself (InvalidStateError) and
   * silently dropping the signal.
   */
  private enqueueSignal(fromUserID: number, task: () => Promise<void>): void {
    const previous = this.signalQueues.get(fromUserID) ?? Promise.resolve();
    const next = previous.then(task).catch((err) => debugLog("signal:queue-failed", { fromUserID, err }));
    this.signalQueues.set(fromUserID, next);
    void next.finally(() => {
      if (this.signalQueues.get(fromUserID) === next) {
        this.signalQueues.delete(fromUserID);
      }
    });
  }

  /**
   * Media is acquired BEFORE joining the channel. If we joined first, an
   * incoming offer could create a peer while localStream is still null,
   * which gives that peer recvonly transceivers — and nothing ever re-adds
   * tracks to an already-created peer, so it stays one-way deaf forever.
   */
  async join(channelID: number): Promise<JoinVoiceResponse> {
    if (this.currentChannelID === channelID) {
      return {
        channel_id: channelID,
        participants: Array.from(this.participants.values()),
        transport_mode: "mesh",
      };
    }

    await this.leave();
    await this.ensureTurnCredentials();
    debugLog("join:start", { channelID, iceServers: this.iceServers, policy: buildIceTransportPolicy() });

    const capture = new LocalCapture(this.onError);
    try {
      await capture.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to access microphone/camera";
      debugLog("join:local-stream-failed", { message });
      this.onError(`${message}. Joined voice in listen-only mode.`);
    }

    const response: JoinVoiceResponse = await this.socket.joinVoiceChannel(channelID);
    return this.attachJoin(response, capture);
  }

  /**
   * Used by the transport factory (see callClientFactory.ts) when it has
   * already called join_voice_channel itself — after acquiring an already-
   * resolved LocalCapture — to learn transport_mode before choosing an
   * implementation. Skips join()'s own media-acquisition/join_voice_channel
   * steps and just adopts what the caller already has.
   */
  async attachJoin(response: JoinVoiceResponse, capture: LocalCapture): Promise<JoinVoiceResponse> {
    if (this.currentChannelID === response.channel_id) {
      return {
        channel_id: response.channel_id,
        participants: Array.from(this.participants.values()),
        transport_mode: "mesh",
      };
    }

    this.capture = capture;
    const stream = capture.currentStream;
    if (stream) {
      // Start voice channels in audio-first mode to reduce mesh bandwidth pressure.
      stream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    this.localStream = stream;
    this.onLocalStream(stream);

    this.currentChannelID = response.channel_id;
    debugLog("join:channel-joined", { channelID: response.channel_id, participants: response.participants.map((p) => p.user_id) });

    response.participants.forEach((participant) => {
      this.participants.set(participant.user_id, participant);
      void this.ensurePeer(participant);
    });

    this.startQualityMonitor();
    this.startReconciliation();

    return response;
  }

  /**
   * Re-establishes voice after the underlying WebSocket reconnects. The
   * server drops the user from its voice-channel map on disconnect (see
   * hub.go unregisterClient), so on the wire this is a fresh join — but
   * unlike join() it reuses the already-acquired localStream instead of
   * re-prompting for mic/camera access.
   */
  async rejoin(channelID: number): Promise<void> {
    if (channelID <= 0) {
      return;
    }

    this.stopReconciliation();
    this.closeAllPeers();
    this.currentChannelID = 0;

    const response: JoinVoiceResponse = await this.socket.joinVoiceChannel(channelID);
    this.currentChannelID = response.channel_id;
    debugLog("rejoin:channel-joined", { channelID: response.channel_id, participants: response.participants.map((p) => p.user_id) });

    this.participants.clear();
    response.participants.forEach((participant) => {
      this.participants.set(participant.user_id, participant);
      void this.ensurePeer(participant);
    });

    this.startReconciliation();
  }

  async startScreenShare(): Promise<void> {
    if (this.isScreenShareActive()) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }

    // Resolution/framerate match SCREEN_BITRATE_PRESET (sfu-migration-
    // plan.md §6.4): the old 2560x1440@60 was only tolerable because mesh
    // usually has one screen-sharer at a time; it's pure waste against the
    // same bitrate cap applied below, with no gain in legibility.
    const displayStream = await mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
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

    await this.updateVideoTrackForPeers(displayTrack, displayStream, SCREEN_BITRATE_PRESET);

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

    await this.updateVideoTrackForPeers(fallbackTrack, this.localStream, CAMERA_BITRATE_PRESET);

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

  // Dynamically-issued TURN credentials expire (default TTL 600s server-side)
  // and a call can easily outlast that. Static creds never need this.
  private turnCredentialsNeedRefresh(): boolean {
    if (this.hasStaticTurnCredentials() || this.turnExpiresAt === 0) {
      return false;
    }
    return Date.now() > this.turnExpiresAt - 60_000;
  }

  private async ensureTurnCredentials(): Promise<void> {
    if (!this.turnCredentialsPromise || this.turnCredentialsNeedRefresh()) {
      this.turnCredentialsPromise = (async () => {
        if (this.hasStaticTurnCredentials()) {
          this.iceServers = buildIceServers();
          this.ensureRelayTurnReady();
          return;
        }

        try {
          const turnCredentials = await getTurnCredentials();
          this.iceServers = buildIceServers(turnCredentials);
          this.turnExpiresAt =
            Date.parse(turnCredentials.expires_at) || Date.now() + turnCredentials.ttl_seconds * 1000;
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

  async leave(): Promise<void> {
    this.stopQualityMonitor();
    this.stopReconciliation();

    if (this.currentChannelID > 0) {
      try {
        await this.socket.leaveVoiceChannel();
      } catch {
        // ignore disconnect race
      }
    }

    this.closeAllPeers();
    this.participants.clear();
    this.peerAttempts.clear();
    this.peerSince.clear();
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
    if (!currentLocalStream || !this.capture) {
      throw new Error("Join voice channel before switching camera");
    }

    const currentVideoTrack = currentLocalStream.getVideoTracks()[0];
    if (!currentVideoTrack) {
      throw new Error("No camera track available in this call");
    }

    const nextFacingMode: CameraFacingMode = this.capture.facingMode === "user" ? "environment" : "user";
    const replacementTrack = await this.capture.acquireVideoTrack(nextFacingMode);
    replacementTrack.enabled = currentVideoTrack.enabled;

    const nextLocalStream = new MediaStream([...currentLocalStream.getAudioTracks(), replacementTrack]);

    try {
      await this.updateVideoTrackForPeers(replacementTrack, nextLocalStream, CAMERA_BITRATE_PRESET);
    } catch {
      replacementTrack.stop();
      throw new Error("Failed to switch camera");
    }

    this.localStream = nextLocalStream;
    this.capture.setStream(nextLocalStream);
    this.capture.setPreferredFacingMode(nextFacingMode);
    this.onLocalStream(nextLocalStream);
    currentVideoTrack.stop();
  }

  private stopLocalTracks(): void {
    this.capture?.stopAll();
    this.capture = null;
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.cameraTrack?.stop();
    this.screenStream = null;
    this.cameraTrack = null;
    this.switchCameraPromise = null;
    this.screenSharePromise = null;
    this.localStream = null;
    this.onLocalStream(null);
  }

  private closeAllPeers(): void {
    this.iceRestartTimers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    this.iceRestartTimers.clear();
    this.signalQueues.clear();

    this.peers.forEach((state, userID) => {
      state.pc.close();
      this.onRemoteLeft(userID);
    });
    this.peers.clear();
  }

  private async ensurePeer(user: VoiceParticipant): Promise<RTCPeerConnection> {
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
    // Perfect negotiation (W3C canonical pattern): the polite side always
    // accepts the other side's offer (via implicit rollback) on glare; the
    // impolite side's offer always wins. Politeness must be role-symmetric
    // across the pair, so it's derived the same way both sides compute it.
    const polite = this.selfUserID > user.user_id;
    debugLog("peer:create", { userID: user.user_id, polite });

    const state: PeerState = {
      pc,
      stream: remoteStream,
      user,
      pendingCandidates: [],
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
    };
    this.peers.set(user.user_id, state);
    this.peerSince.set(user.user_id, Date.now());

    // Single point of (re)negotiation: adding/removing tracks, changing a
    // transceiver's direction, or calling pc.restartIce() all schedule this
    // automatically — no manual "who offers first" bookkeeping needed.
    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription();
        debugLog("signal:offer-send", { userID: user.user_id, sdpSize: pc.localDescription?.sdp?.length ?? 0 });
        await this.socket.sendRTCSignal({
          channel_id: this.currentChannelID,
          to_user_id: user.user_id,
          signal_type: "offer",
          sdp: pc.localDescription?.sdp,
        });
      } catch (err) {
        debugLog("peer:negotiation-failed", { userID: user.user_id, err });
      } finally {
        state.makingOffer = false;
      }
    };

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
      if (pc.connectionState === "connected") {
        this.peerAttempts.delete(user.user_id);
      } else if (pc.connectionState === "failed") {
        // connectionState "failed" covers DTLS failures that iceConnectionState
        // alone won't catch (e.g. both sides ended up "active" after a glare
        // that wasn't resolved — see the perfect-negotiation setup above).
        this.scheduleIceRestart(user.user_id, "failed");
      }
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

    this.syncLocalTracksToPeer(pc);
    const hasLocalAudio = (this.localStream?.getAudioTracks().length ?? 0) > 0;
    const hasLocalVideo = (this.localStream?.getVideoTracks().length ?? 0) > 0;
    if (!hasLocalAudio) {
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
    if (!hasLocalVideo) {
      pc.addTransceiver("video", { direction: "recvonly" });
    }

    return pc;
  }

  /**
   * Ensures every local track has a matching sender on this peer. Called when
   * a peer is created and from the reconciliation loop after localStream
   * appears or changes (e.g. mic access resolved late, camera switched).
   * Idempotent: safe to call on every reconcile tick. Renegotiation itself is
   * driven automatically by onnegotiationneeded once a sender's track or a
   * transceiver's direction actually changes — this never sends offers itself.
   */
  private syncLocalTracksToPeer(pc: RTCPeerConnection): void {
    const stream = this.localStream;
    if (!stream) {
      return;
    }

    for (const track of stream.getTracks()) {
      const transceiver = pc
        .getTransceivers()
        .find((t) => (t.sender.track?.kind ?? t.receiver.track?.kind) === track.kind);

      if (!transceiver) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === "video") {
          void applyVideoBitratePreset(sender, CAMERA_BITRATE_PRESET);
        }
        continue;
      }
      if (transceiver.sender.track?.id === track.id) {
        continue;
      }

      void transceiver.sender.replaceTrack(track);
      if (transceiver.direction === "recvonly" || transceiver.direction === "inactive") {
        transceiver.direction = "sendrecv";
      }
    }
  }

  private clearIceRestart(remoteUserID: number): void {
    const timerId = this.iceRestartTimers.get(remoteUserID);
    if (timerId) {
      window.clearTimeout(timerId);
      this.iceRestartTimers.delete(remoteUserID);
    }
  }

  private scheduleIceRestart(remoteUserID: number, reason: "failed" | "disconnected"): void {
    if (this.iceRestartTimers.has(remoteUserID)) {
      return;
    }

    // A single quick ICE restart attempt; if the peer is still broken
    // afterwards, reconcilePeers() takes over and fully recreates it (with
    // its own attempt cap and backoff — see recreatePeer) instead of retrying
    // ICE restarts forever.
    const delayMs = reason === "failed" ? 1500 : 4000;
    const timerId = window.setTimeout(() => {
      this.iceRestartTimers.delete(remoteUserID);
      void this.restartIce(remoteUserID);
    }, delayMs);

    this.iceRestartTimers.set(remoteUserID, timerId);
  }

  private restartIce(remoteUserID: number): void {
    const peer = this.peers.get(remoteUserID);
    if (!peer || this.currentChannelID <= 0) {
      return;
    }

    try {
      // restartIce() marks the transport for restart and schedules
      // onnegotiationneeded itself; the resulting offer automatically carries
      // fresh ICE credentials without needing an explicit iceRestart option.
      peer.pc.restartIce();
    } catch {
      // Best-effort; if unsupported, recreatePeer() will eventually replace
      // this peer wholesale once reconcilePeers() notices it's still broken.
    }
  }

  private async updateVideoTrackForPeers(
    track: MediaStreamTrack | null,
    stream: MediaStream | null,
    preset?: VideoBitratePreset,
  ): Promise<void> {
    for (const [, { pc }] of this.peers) {
      const videoTransceiver = pc
        .getTransceivers()
        .find((t) => t.sender.track?.kind === "video" || t.receiver.track?.kind === "video");

      const sender = videoTransceiver?.sender ?? pc.getSenders().find((s) => s.track?.kind === "video");

      if (sender) {
        await sender.replaceTrack(track);
        if (videoTransceiver) {
          videoTransceiver.direction = track ? "sendrecv" : "recvonly";
        }
        if (track && preset) {
          void applyVideoBitratePreset(sender, preset);
        }
      } else if (track && stream) {
        const newSender = pc.addTrack(track, stream);
        if (preset) {
          void applyVideoBitratePreset(newSender, preset);
        }
      }
    }
    // No manual offer here: replaceTrack never needs renegotiation, and a
    // direction/track change that does need it raises onnegotiationneeded
    // automatically (see ensurePeer) — sending an offer manually on top would
    // race the perfect-negotiation flow.
  }

  /**
   * If LocalCapture's RNNoise pipeline has been stuck "suspended" for too
   * long, the outgoing audio track is silent even though track.enabled/
   * readyState both look fine and the UI shows the mic as on — nothing else
   * would ever detect or recover from this (see LocalCapture.
   * checkWatchdogFallback). Falls back to the unfiltered mic track on every
   * peer so the user stays audible.
   */
  private applyRnnoiseWatchdogFallback(): void {
    const rawAudioTrack = this.capture?.checkWatchdogFallback();
    if (!rawAudioTrack) {
      return;
    }

    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
      void sender?.replaceTrack(rawAudioTrack);
    }
    if (this.localStream) {
      const nextStream = new MediaStream([rawAudioTrack, ...this.localStream.getVideoTracks()]);
      this.localStream = nextStream;
      this.capture?.setStream(nextStream);
      this.onLocalStream(nextStream);
    }
  }

  private handleVoiceUserJoined(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user || event.user.user_id === this.selfUserID) {
      return;
    }

    this.participants.set(event.user.user_id, event.user);
    void this.ensurePeer(event.user);
  }

  private handleVoiceUserLeft(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user) {
      return;
    }

    this.participants.delete(event.user.user_id);
    this.peerAttempts.delete(event.user.user_id);
    this.peerSince.delete(event.user.user_id);
    this.dropPeer(event.user.user_id);
  }

  private dropPeer(userID: number): void {
    const state = this.peers.get(userID);
    if (!state) {
      return;
    }

    this.clearIceRestart(userID);
    this.signalQueues.delete(userID);
    state.pc.close();
    this.peers.delete(userID);
    this.onRemoteLeft(userID);
  }

  /**
   * Reconciles the server's authoritative participant list (pushed from
   * useVoice on every periodic get_server_channels poll) against the live
   * peer map. This is the safety net for lost voice_user_joined/left events
   * and dropped signaling: without it, a peer that never got created (or
   * whose participant left silently) stays wrong until someone rejoins.
   */
  syncParticipants(channelID: number, participants: VoiceParticipant[]): void {
    if (channelID !== this.currentChannelID || this.currentChannelID <= 0) {
      return;
    }

    const alive = new Set<number>();
    for (const participant of participants) {
      if (participant.user_id === this.selfUserID) {
        continue;
      }
      alive.add(participant.user_id);
      this.participants.set(participant.user_id, { ...this.participants.get(participant.user_id), ...participant });
    }

    for (const userID of [...this.peers.keys(), ...this.participants.keys()]) {
      if (userID !== this.selfUserID && !alive.has(userID)) {
        this.participants.delete(userID);
        this.peerAttempts.delete(userID);
        this.peerSince.delete(userID);
        this.dropPeer(userID);
      }
    }
  }

  private peerHealth(userID: number, pc: RTCPeerConnection): PeerHealth {
    if (pc.connectionState === "connected") {
      return "ok";
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      return "broken";
    }
    const since = this.peerSince.get(userID) ?? 0;
    return Date.now() - since > MeshCallClient.CONNECT_GRACE_MS ? "broken" : "connecting";
  }

  private reconcilePeers(): void {
    if (this.currentChannelID <= 0) {
      return;
    }

    // Refresh dynamic TURN credentials in the background before they expire,
    // so any peer created later in a long call still gets a usable relay.
    // Fire-and-forget: ensurePeer reads this.iceServers synchronously and
    // must never block on a network round-trip.
    if (this.turnCredentialsNeedRefresh()) {
      void this.ensureTurnCredentials().catch(() => {
        // Failure already surfaced via onError inside ensureTurnCredentials.
      });
    }

    this.applyRnnoiseWatchdogFallback();

    for (const [userID, participant] of this.participants) {
      if (userID === this.selfUserID) {
        continue;
      }

      const state = this.peers.get(userID);

      if (!state) {
        // No peer at all: a voice_user_joined event or an offer was lost.
        this.recreatePeer(userID, participant, "missing");
        continue;
      }

      // Local tracks may have appeared/changed after this peer was created
      // (e.g. mic access resolved late, or a rejoin reused an older stream).
      this.syncLocalTracksToPeer(state.pc);

      if (this.peerHealth(userID, state.pc) === "broken") {
        this.recreatePeer(userID, participant, `state=${state.pc.connectionState}`);
      }
    }
  }

  private recreatePeer(userID: number, participant: VoiceParticipant, reason: string): void {
    const attempt = (this.peerAttempts.get(userID) ?? 0) + 1;
    if (attempt > MeshCallClient.MAX_PEER_ATTEMPTS) {
      return;
    }

    // Exponential backoff: recreating faster than ICE can settle is pointless.
    const backoffMs = Math.min(30000, 2000 * 2 ** (attempt - 1));
    const since = this.peerSince.get(userID) ?? 0;
    if (since && Date.now() - since < backoffMs) {
      return;
    }

    debugLog("peer:recreate", { userID, reason, attempt });
    this.peerAttempts.set(userID, attempt);
    this.dropPeer(userID);
    void this.ensurePeer(participant);
  }

  private startReconciliation(): void {
    if (this.reconcileTimer !== null) {
      return;
    }
    this.reconcileTimer = window.setInterval(() => this.reconcilePeers(), MeshCallClient.RECONCILE_INTERVAL_MS);
  }

  private stopReconciliation(): void {
    if (this.reconcileTimer !== null) {
      window.clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private async handleRTCSignal(event: RTCSignalEvent): Promise<void> {
    if (event.channel_id !== this.currentChannelID || event.from_user_id === this.selfUserID) {
      return;
    }

    const participant = this.participants.get(event.from_user_id) ?? { user_id: event.from_user_id };
    this.participants.set(event.from_user_id, participant);
    debugLog("signal:incoming", { from: event.from_user_id, signal_type: event.signal_type });

    const pc = await this.ensurePeer(participant);
    const peer = this.peers.get(event.from_user_id);
    if (!peer) {
      return;
    }

    try {
      if (event.signal_type === "offer" || event.signal_type === "answer") {
        await this.handleDescription(peer, event);
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

      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        // Candidates that arrive for an offer we deliberately ignored (see
        // handleDescription) are expected to fail — that offer's generation
        // never became our remote description.
        if (!peer.ignoreOffer) {
          throw err;
        }
      }
    } catch {
      this.onError("Failed to handle WebRTC signal");
    }
  }

  /**
   * Perfect-negotiation glare resolution (W3C canonical pattern). Neither
   * side pre-decides who offers: onnegotiationneeded (see ensurePeer) fires
   * on whichever side has something to negotiate, and if both fire at once,
   * this resolves the collision deterministically instead of the old
   * symmetric-rollback approach, which left both sides "active" and the DTLS
   * handshake never completing.
   */
  private async handleDescription(peer: PeerState, event: RTCSignalEvent): Promise<void> {
    const { pc } = peer;
    if (!event.sdp) {
      return;
    }

    const isOffer = event.signal_type === "offer";
    const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.isSettingRemoteAnswerPending);
    const offerCollision = isOffer && !readyForOffer;

    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) {
      debugLog("signal:offer-ignored (impolite)", { from: event.from_user_id });
      return;
    }

    peer.isSettingRemoteAnswerPending = !isOffer;
    try {
      // The polite side relies on implicit rollback here: setRemoteDescription
      // with an incoming offer while we have a pending local offer discards it.
      await pc.setRemoteDescription({ type: isOffer ? "offer" : "answer", sdp: event.sdp });
    } finally {
      peer.isSettingRemoteAnswerPending = false;
    }

    await this.flushPendingCandidates(peer);

    if (isOffer) {
      await pc.setLocalDescription();
      await this.socket.sendRTCSignal({
        channel_id: this.currentChannelID,
        to_user_id: event.from_user_id,
        signal_type: "answer",
        sdp: pc.localDescription?.sdp,
      });
    }
  }

  private startQualityMonitor(): void {
    if (this.qualitySampleTimer !== null) {
      return;
    }
    this.qualitySampleTimer = window.setInterval(() => {
      void this.sampleQuality();
    }, QUALITY_SAMPLE_INTERVAL_MS);
  }

  private stopQualityMonitor(): void {
    if (this.qualitySampleTimer !== null) {
      window.clearInterval(this.qualitySampleTimer);
      this.qualitySampleTimer = null;
    }
    this.qualityTrackers.clear();
    this.lastQualitySignature = "";
    this.onQualityChange({});
  }

  private ensureQualityTracker(userID: number): QualityTracker {
    const existing = this.qualityTrackers.get(userID);
    if (existing) {
      return existing;
    }
    const tracker = createQualityTracker();
    this.qualityTrackers.set(userID, tracker);
    return tracker;
  }

  private async sampleQuality(): Promise<void> {
    // Между запуском таймера и его срабатыванием мог произойти leave().
    if (this.currentChannelID <= 0) {
      return;
    }

    const forcedLevel = readForcedLevel();
    const entries = await Promise.all(
      Array.from(this.peers.entries()).map(
        async ([userID, state]) => [userID, await this.samplePeer(userID, state, forcedLevel)] as const,
      ),
    );

    // getStats асинхронный — за время ожидания звонок мог закончиться.
    if (this.currentChannelID <= 0) {
      return;
    }

    const snapshot: Record<number, PeerQuality> = {};
    entries.forEach(([userID, quality]) => {
      snapshot[userID] = quality;
    });

    this.qualityTrackers.forEach((_, userID) => {
      if (!this.peers.has(userID)) {
        this.qualityTrackers.delete(userID);
      }
    });

    const signature = qualitySignature(snapshot);
    if (signature === this.lastQualitySignature) {
      return;
    }
    this.lastQualitySignature = signature;
    this.onQualityChange(snapshot);
  }

  private async samplePeer(
    userID: number,
    state: PeerState,
    forcedLevel: QualityLevel | null,
  ): Promise<PeerQuality> {
    const tracker = this.ensureQualityTracker(userID);

    if (forcedLevel) {
      tracker.level = forcedLevel;
      return buildQuality(forcedLevel, EMPTY_METRICS, null);
    }

    const serviceLevel = serviceLevelOf(state.pc);
    if (serviceLevel) {
      return buildQuality(applyHysteresis(tracker, serviceLevel), EMPTY_METRICS, null);
    }

    let report: RTCStatsReport;
    try {
      report = await state.pc.getStats();
    } catch {
      return buildQuality(applyHysteresis(tracker, "connecting"), EMPTY_METRICS, null);
    }

    const sample = readQualitySample(report, tracker);
    debugLog("quality:sample", { userID, level: sample.level, ...sample.metrics });

    // Первый замер (нет предыдущих счётчиков) или поток без пакетов — измерять нечего.
    if (!sample.level) {
      return buildQuality(applyHysteresis(tracker, "connecting"), sample.metrics, null);
    }

    return buildQuality(applyHysteresis(tracker, sample.level), sample.metrics, sample.direction);
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


