import type {
  JoinVoiceResponse,
  SfuActiveSpeakersEvent,
  SfuAnswerPayload,
  SfuCandidatePayload,
  SfuErrorEvent,
  SfuOfferEvent,
  SfuSlotDecl,
  SfuTrackEvent,
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
import { LocalCapture } from "./localCapture";
import {
  debugLog,
  buildIceTransportPolicy,
  applyVideoBitratePreset,
  CAMERA_SIMULCAST_ENCODINGS,
  SCREEN_BITRATE_PRESET,
} from "./webrtcShared";

/**
 * SFU transport (sfu-migration-plan.md): the only VoiceClient implementation
 * now that mesh has been removed (§9) — a single PeerConnection to the
 * server instead of one per remote participant. The four publish slots
 * (mic/camera/screen/screen_audio) are fixed and created once, up front, in
 * join() (decision #3), so toggling a source is just sender.replaceTrack(),
 * never a renegotiation; the only party that ever sends a fresh offer after
 * the initial exchange is the server (auto-subscribing this peer to others'
 * audio, subscribing it to requested video, etc.).
 */
export class SfuCallClient implements VoiceClient {
  private readonly socket: ChatSocket;
  private readonly selfUserID: number;
  private readonly onRemoteStream: RemoteStreamListener;
  private readonly onRemoteLeft: RemoteLeftListener;
  private readonly onLocalStream: LocalStreamListener;
  private readonly onError: ErrorListener;
  // Unused in phase 1 (no per-connection quality signal in a star topology
  // yet) — kept so this satisfies VoiceClient's constructor shape.
  private readonly onQualityChange: QualityListener;

  private readonly unsubscribers: Array<() => void> = [];
  private readonly participants = new Map<number, VoiceParticipant>();
  private readonly remoteStreams = new Map<number, MediaStream>();

  private capture: LocalCapture | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private screenSharePromise: Promise<boolean> | null = null;
  private switchCameraPromise: Promise<void> | null = null;

  private pc: RTCPeerConnection | null = null;
  private sessionID = "";
  private currentChannelID = 0;
  private iceServers: RTCIceServer[] = [];
  private publishSlots: SfuSlotDecl[] = [];
  private readonly senderBySource = new Map<string, RTCRtpSender>();
  private pendingCandidates: RTCIceCandidateInit[] = [];

  // Video subscriptions (decision #8): audio auto-subscribes server-side,
  // video needs an explicit sfu_subscribe_video per source. Phase 2 policy
  // was "subscribe to everything at high" — phase 6 (simulcast) makes
  // "quality" meaningful, so the policy is now: active speaker's camera ->
  // high, everyone else's -> low, screen (never simulcast, decision #4) ->
  // always high. Same mechanism either way, only the requested tier changes.
  private readonly subscribedVideo = new Set<string>(); // `${userID}:${source}`
  private readonly pendingVideoSubscriptions = new Map<string, { userID: number; source: string }>();
  private subscribeDebounceTimer: number | null = null;
  private static readonly SUBSCRIBE_DEBOUNCE_MS = 300;
  private readonly activeSpeakers = new Set<number>();

  // Only one peer (the server), so a single queue suffices: an offer and
  // the candidates right behind it must not race setRemoteDescription
  // against itself.
  private signalQueue: Promise<void> = Promise.resolve();

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
    this.unsubscribers.push(this.socket.onSfuOffer((event) => this.enqueueSignal(() => this.handleServerOffer(event))));
    this.unsubscribers.push(this.socket.onSfuAnswer((event) => this.enqueueSignal(() => this.handleServerAnswer(event))));
    this.unsubscribers.push(
      this.socket.onSfuCandidate((event) => this.enqueueSignal(() => this.handleServerCandidate(event))),
    );
    this.unsubscribers.push(this.socket.onSfuError((event) => this.handleSfuError(event)));
    this.unsubscribers.push(this.socket.onSfuTrackPublished((event) => this.handleTrackPublished(event)));
    this.unsubscribers.push(this.socket.onSfuActiveSpeakers((event) => this.handleActiveSpeakers(event)));
  }

  private enqueueSignal(task: () => Promise<void>): void {
    this.signalQueue = this.signalQueue.then(task).catch((err) => debugLog("sfu:signal-queue-failed", err));
  }

  /**
   * Media is acquired BEFORE joining the channel: the server can broadcast
   * our presence (and other peers can react to it — e.g. auto-subscribing
   * to our mic) as soon as we're in the channel, so localStream needs to
   * already exist by then.
   */
  async join(channelID: number): Promise<JoinVoiceResponse> {
    if (this.currentChannelID === channelID) {
      return {
        channel_id: channelID,
        participants: Array.from(this.participants.values()),
        transport_mode: "sfu",
      };
    }

    await this.leave();

    const capture = new LocalCapture(this.onError);
    try {
      await capture.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to access microphone/camera";
      debugLog("sfu:join-local-stream-failed", { message });
      this.onError(`${message}. Joined voice in listen-only mode.`);
    }

    const response = await this.socket.joinVoiceChannel(channelID);
    if (this.currentChannelID === response.channel_id) {
      return {
        channel_id: response.channel_id,
        participants: Array.from(this.participants.values()),
        transport_mode: "sfu",
      };
    }

    this.capture = capture;
    const stream = capture.currentStream;
    if (stream) {
      // Start voice channels in audio-first mode to reduce bandwidth until
      // the user explicitly turns their camera on.
      stream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    this.localStream = stream;
    this.onLocalStream(stream);

    this.applySession(response);
    await this.openPeerConnection();

    return response;
  }

  /**
   * Re-establishes the SFU connection after the underlying WebSocket
   * reconnects. Tries sfu_resume first (see below) since our own
   * PeerConnection never depended on the WebSocket and is usually still
   * exactly as it was — only falls back to a full fresh session if resume
   * is rejected (e.g. the grace period already lapsed server-side).
   */
  async rejoin(channelID: number): Promise<void> {
    if (channelID <= 0) {
      return;
    }

    // The PeerConnection to the SFU never depended on the WebSocket (see
    // sfu-migration-plan.md §7 phase 3, decision #10) — our own pc is still
    // exactly as it was before the socket dropped, so try to resume that
    // exact session before falling back to a full rebuild. Only worth
    // trying if we're resuming into the SAME channel we already had a
    // session for; a channel switch always needs a fresh join anyway.
    if (this.pc && this.sessionID && this.currentChannelID === channelID) {
      try {
        const response = await this.socket.sendSfuResume(this.sessionID);
        this.participants.clear();
        response.participants.forEach((participant) => {
          this.participants.set(participant.user_id, participant);
        });
        return;
      } catch (err) {
        debugLog("sfu:resume-failed-falling-back-to-rejoin", err);
      }
    }

    this.teardownPeerConnection();

    const response = await this.socket.joinVoiceChannel(channelID);
    this.applySession(response);
    await this.openPeerConnection();
  }

  private applySession(response: JoinVoiceResponse): void {
    if (!response.session_id) {
      throw new Error("SFU response is missing session_id");
    }

    this.sessionID = response.session_id;
    this.iceServers = (response.ice_servers ?? []).map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential,
    }));
    this.publishSlots = (response.publish_slots ?? []).map((slot) => ({
      mid: "",
      kind: slot.kind,
      source: slot.source,
    }));
    this.currentChannelID = response.channel_id;

    this.participants.clear();
    response.participants.forEach((participant) => {
      this.participants.set(participant.user_id, participant);
    });
  }

  private async openPeerConnection(): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: buildIceTransportPolicy(),
    });
    this.pc = pc;
    this.senderBySource.clear();

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.sessionID) {
        return;
      }
      const payload: SfuCandidatePayload = {
        session_id: this.sessionID,
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid ?? undefined,
        sdp_mline_index: event.candidate.sdpMLineIndex ?? undefined,
      };
      void this.socket.sendSfuCandidate(payload);
    };

    pc.ontrack = (event) => this.handleTrack(event);
    pc.oniceconnectionstatechange = () => {
      debugLog("sfu:ice-state", { state: pc.iceConnectionState });
    };
    pc.onconnectionstatechange = () => {
      debugLog("sfu:connection-state", { state: pc.connectionState });
    };

    // Fixed publish slots (decision #3): every transceiver is created up
    // front, in the server-declared order, so the mid<->source mapping sent
    // back in the initial offer is unambiguous. From here on, turning a
    // source on/off is sender.replaceTrack — never a renegotiation.
    for (const slot of this.publishSlots) {
      // Camera declares its three simulcast layers up front (sfu-migration-
      // plan.md §7 phase 6) so the server sees all of them from the first
      // offer; every other slot is a single stream, same as before.
      const transceiverInit: RTCRtpTransceiverInit =
        slot.source === "camera"
          ? { direction: "sendonly", sendEncodings: CAMERA_SIMULCAST_ENCODINGS }
          : { direction: "sendonly" };
      const transceiver = pc.addTransceiver(slot.kind, transceiverInit);
      const track = this.localTrackForSource(slot.source);
      if (track) {
        void transceiver.sender.replaceTrack(track);
      }
      this.senderBySource.set(slot.source, transceiver.sender);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Transceiver MIDs are only assigned once setLocalDescription has run.
    const slots: SfuSlotDecl[] = pc.getTransceivers().map((transceiver, index) => ({
      mid: transceiver.mid ?? String(index),
      kind: this.publishSlots[index]?.kind ?? "audio",
      source: this.publishSlots[index]?.source ?? "mic",
    }));

    debugLog("sfu:offer-send", { sessionID: this.sessionID, slots });
    await this.socket.sendSfuOffer(this.sessionID, offer.sdp ?? "", slots);
  }

  private localTrackForSource(source: string): MediaStreamTrack | null {
    if (!this.localStream) {
      return null;
    }
    switch (source) {
      case "mic":
        return this.localStream.getAudioTracks()[0] ?? null;
      case "camera":
        return this.localStream.getVideoTracks()[0] ?? null;
      default:
        // screen/screen_audio are attached by startScreenShare, once active.
        return null;
    }
  }

  private handleTrack(event: RTCTrackEvent): void {
    const streamID = event.streams[0]?.id ?? "";
    // Server-assigned stream IDs are "u{userID}-{source}" (sfu-migration-
    // plan.md §4.4) — this is the only place that needs to know that format.
    const match = /^u(\d+)-/.exec(streamID);
    if (!match) {
      debugLog("sfu:ontrack-unrecognized-stream", { streamID });
      return;
    }

    const userID = Number(match[1]);
    if (userID === this.selfUserID) {
      return;
    }
    const participant = this.participants.get(userID) ?? { user_id: userID };
    this.participants.set(userID, participant);

    let stream = this.remoteStreams.get(userID);
    if (!stream) {
      stream = new MediaStream();
      this.remoteStreams.set(userID, stream);
    }
    if (!stream.getTracks().some((existing) => existing.id === event.track.id)) {
      stream.addTrack(event.track);
    }

    const combinedStream = stream;
    event.track.onended = () => {
      const existing = combinedStream.getTracks().find((t) => t.id === event.track.id);
      if (existing) {
        combinedStream.removeTrack(existing);
      }
      this.onRemoteStream(participant, combinedStream);
    };

    this.onRemoteStream(participant, stream);
  }

  private async handleServerOffer(event: SfuOfferEvent): Promise<void> {
    if (!this.pc || event.session_id !== this.sessionID) {
      return;
    }
    await this.pc.setRemoteDescription({ type: "offer", sdp: event.sdp });
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.socket.sendSfuAnswer(this.sessionID, answer.sdp ?? "");
  }

  private async handleServerAnswer(event: SfuAnswerPayload): Promise<void> {
    if (!this.pc || event.session_id !== this.sessionID) {
      return;
    }
    await this.pc.setRemoteDescription({ type: "answer", sdp: event.sdp });
    await this.flushPendingCandidates();
  }

  private async handleServerCandidate(event: SfuCandidatePayload): Promise<void> {
    if (event.session_id !== this.sessionID) {
      return;
    }
    const candidate: RTCIceCandidateInit = {
      candidate: event.candidate,
      sdpMid: event.sdp_mid,
      sdpMLineIndex: event.sdp_mline_index,
    };
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      debugLog("sfu:add-ice-candidate-failed", err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    if (!this.pc || !this.pendingCandidates.length) {
      return;
    }
    const pending = [...this.pendingCandidates];
    this.pendingCandidates.length = 0;
    for (const candidate of pending) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        debugLog("sfu:add-ice-candidate-failed", err);
      }
    }
  }

  private handleSfuError(event: SfuErrorEvent): void {
    if (event.session_id && event.session_id !== this.sessionID) {
      return;
    }
    debugLog("sfu:error", event);
    this.onError(`Voice connection error: ${event.message}`);
  }

  private handleTrackPublished(event: SfuTrackEvent): void {
    if (event.channel_id !== this.currentChannelID || event.user_id === this.selfUserID) {
      return;
    }
    if (event.kind !== "video") {
      return; // audio auto-subscribes server-side (decision #8)
    }

    const key = `${event.user_id}:${event.source}`;
    if (this.subscribedVideo.has(key)) {
      return;
    }
    this.pendingVideoSubscriptions.set(key, { userID: event.user_id, source: event.source });
    this.scheduleSubscribeFlush();
  }

  /** Coalesces a burst of published-track events (e.g. everyone's camera
   * slot announcing itself right after a bulk join) into one batch of
   * sfu_subscribe_video calls instead of one per track. */
  private scheduleSubscribeFlush(): void {
    if (this.subscribeDebounceTimer !== null) {
      return;
    }
    this.subscribeDebounceTimer = window.setTimeout(() => {
      this.subscribeDebounceTimer = null;
      this.flushPendingSubscriptions();
    }, SfuCallClient.SUBSCRIBE_DEBOUNCE_MS);
  }

  private flushPendingSubscriptions(): void {
    if (!this.sessionID) {
      this.pendingVideoSubscriptions.clear();
      return;
    }
    const pending = Array.from(this.pendingVideoSubscriptions.values());
    this.pendingVideoSubscriptions.clear();

    for (const { userID, source } of pending) {
      const key = `${userID}:${source}`;
      this.subscribedVideo.add(key);
      void this.socket.sendSfuSubscribeVideo(this.sessionID, userID, source, this.qualityFor(userID, source)).catch((err) => {
        this.subscribedVideo.delete(key);
        debugLog("sfu:subscribe-video-failed", { userID, source, err });
      });
    }
  }

  /** sfu-migration-plan.md §7 phase 6 step 5: active speaker's camera gets
   * "high" (the only source that's actually simulcast — decision #4), every
   * other camera gets "low"; screen has no simulcast layers to choose
   * between, so it's always requested at "high". */
  private qualityFor(userID: number, source: string): "low" | "high" {
    if (source !== "camera") {
      return "high";
    }
    return this.activeSpeakers.has(userID) ? "high" : "low";
  }

  private handleActiveSpeakers(event: SfuActiveSpeakersEvent): void {
    if (event.channel_id !== this.currentChannelID) {
      return;
    }

    const next = new Set(event.user_ids);
    const affected = new Set<number>();
    for (const id of next) {
      if (!this.activeSpeakers.has(id)) affected.add(id);
    }
    for (const id of this.activeSpeakers) {
      if (!next.has(id)) affected.add(id);
    }
    if (affected.size === 0) {
      return;
    }

    this.activeSpeakers.clear();
    next.forEach((id) => this.activeSpeakers.add(id));

    if (!this.sessionID) {
      return;
    }
    for (const userID of affected) {
      const key = `${userID}:camera`;
      if (!this.subscribedVideo.has(key)) {
        continue; // not (yet) subscribed to their camera — nothing to retarget
      }
      const quality = this.qualityFor(userID, "camera");
      void this.socket.sendSfuSubscribeVideo(this.sessionID, userID, "camera", quality).catch((err) => {
        debugLog("sfu:requality-video-failed", { userID, quality, err });
      });
    }
  }

  private handleVoiceUserJoined(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user || event.user.user_id === this.selfUserID) {
      return;
    }
    this.participants.set(event.user.user_id, event.user);
  }

  private handleVoiceUserLeft(event: VoiceUserEvent): void {
    if (event.channel_id !== this.currentChannelID || !event.user) {
      return;
    }
    this.participants.delete(event.user.user_id);
    if (this.remoteStreams.has(event.user.user_id)) {
      this.remoteStreams.delete(event.user.user_id);
      this.onRemoteLeft(event.user.user_id);
    }

    // Without this, a user who leaves and later rejoins the same channel
    // would be skipped by handleTrackPublished forever: subscribedVideo is
    // keyed by their persistent user_id, not their (new) SFU session, so a
    // stale entry from before they left would look identical to an
    // already-live subscription.
    const prefix = `${event.user.user_id}:`;
    for (const key of this.subscribedVideo) {
      if (key.startsWith(prefix)) {
        this.subscribedVideo.delete(key);
      }
    }
    for (const key of this.pendingVideoSubscriptions.keys()) {
      if (key.startsWith(prefix)) {
        this.pendingVideoSubscriptions.delete(key);
      }
    }
  }

  syncParticipants(channelID: number, participants: VoiceParticipant[]): void {
    if (channelID !== this.currentChannelID || this.currentChannelID <= 0) {
      return;
    }
    for (const participant of participants) {
      if (participant.user_id === this.selfUserID) {
        continue;
      }
      this.participants.set(participant.user_id, { ...this.participants.get(participant.user_id), ...participant });
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

    this.teardownPeerConnection();
    this.participants.clear();
    // No per-connection quality signal in phase 1 (see the field's doc
    // comment) — clear whatever the UI was last showing rather than leave
    // it stale.
    this.onQualityChange({});

    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.screenSharePromise = null;
    this.switchCameraPromise = null;

    this.capture?.stopAll();
    this.capture = null;
    this.localStream = null;
    this.onLocalStream(null);
  }

  private teardownPeerConnection(): void {
    this.pc?.close();
    this.pc = null;
    this.sessionID = "";
    this.senderBySource.clear();
    this.pendingCandidates = [];

    if (this.subscribeDebounceTimer !== null) {
      window.clearTimeout(this.subscribeDebounceTimer);
      this.subscribeDebounceTimer = null;
    }
    this.subscribedVideo.clear();
    this.pendingVideoSubscriptions.clear();
    this.activeSpeakers.clear();

    for (const userID of this.remoteStreams.keys()) {
      this.onRemoteLeft(userID);
    }
    this.remoteStreams.clear();
    this.currentChannelID = 0;
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

  async startScreenShare(): Promise<void> {
    if (this.isScreenShareActive()) {
      return;
    }

    const sender = this.senderBySource.get("screen");
    if (!sender) {
      throw new Error("Screen sharing is not available for this call");
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing is not supported in this browser");
    }

    // Resolution/framerate match SCREEN_BITRATE_PRESET (sfu-migration-
    // plan.md §6.4).
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
    await sender.replaceTrack(displayTrack);
    void applyVideoBitratePreset(sender, SCREEN_BITRATE_PRESET);

    displayTrack.onended = () => {
      void this.stopScreenShare();
    };
  }

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

    const sender = this.senderBySource.get("screen");
    if (sender) {
      await sender.replaceTrack(null);
    }
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
    const sender = this.senderBySource.get("camera");
    if (!currentLocalStream || !this.capture || !sender) {
      throw new Error("Join voice channel before switching camera");
    }

    const currentVideoTrack = currentLocalStream.getVideoTracks()[0];
    if (!currentVideoTrack) {
      throw new Error("No camera track available in this call");
    }

    const nextFacingMode = this.capture.facingMode === "user" ? "environment" : "user";
    const replacementTrack = await this.capture.acquireVideoTrack(nextFacingMode);
    replacementTrack.enabled = currentVideoTrack.enabled;

    try {
      // replaceTrack alone preserves the sender's existing encoding
      // parameters (the simulcast layers set up in openPeerConnection), so
      // there's nothing further to reapply here.
      await sender.replaceTrack(replacementTrack);
    } catch {
      replacementTrack.stop();
      throw new Error("Failed to switch camera");
    }

    const nextLocalStream = new MediaStream([...currentLocalStream.getAudioTracks(), replacementTrack]);
    this.localStream = nextLocalStream;
    this.capture.setStream(nextLocalStream);
    this.capture.setPreferredFacingMode(nextFacingMode);
    this.onLocalStream(nextLocalStream);
    currentVideoTrack.stop();
  }
}
