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
  LocalScreenStreamListener,
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

/**
 * States getStats() can't measure anything useful for — the RTCPeerConnection
 * itself already knows definitively (mirrors the mesh-era helper of the same
 * name, adapted to the SFU's single shared connection instead of one per
 * remote peer).
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
  private readonly onLocalScreenStream: LocalScreenStreamListener;
  private readonly onError: ErrorListener;
  // There's exactly one PeerConnection (the star topology to the server),
  // so unlike mesh there's only ever one quality reading to make — see
  // sampleQuality/sampleConnection. It's reported under every currently
  // known participant's userID, since in a star topology everyone's
  // audio/video shares the same transport health.
  private readonly onQualityChange: QualityListener;

  private readonly unsubscribers: Array<() => void> = [];
  private readonly participants = new Map<number, VoiceParticipant>();
  private readonly remoteStreams = new Map<number, MediaStream>();
  // Camera and screen publish as separate slots and can be live
  // simultaneously (decision #3/§4.3), but the UI renders one tile per
  // participant — a MediaStream with two video tracks leaves the browser to
  // arbitrarily pick which one a <video> element actually shows, and it
  // reliably picks camera. This tracks both candidates per participant (set
  // once, at ontrack — see handleTrack) so reconcileRemoteVideo can decide
  // which one is actually in the combined stream, preferring screen.
  private readonly remoteVideoTracks = new Map<number, { camera?: MediaStreamTrack; screen?: MediaStreamTrack }>();
  // Sources explicitly reported paused via sfu_track_unpublished ("screen"
  // or "camera" — see handleTrackUnpublished/announcePublishState). The
  // underlying track object above is never removed on pause (the same
  // transceiver/SSRC resumes on the next share — decision #3, no
  // renegotiation for a toggle), only whether reconcileRemoteVideo is
  // allowed to prefer it right now.
  private readonly hiddenRemoteVideo = new Set<string>(); // `${userID}:${source}`

  private qualitySampleTimer: number | null = null;
  private qualityTracker: QualityTracker = createQualityTracker();
  private lastQualitySignature = "";

  private capture: LocalCapture | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private screenSharePromise: Promise<boolean> | null = null;
  private switchCameraPromise: Promise<void> | null = null;
  // Single source of truth for whether the camera is on (lazy-capture
  // design): a track's presence in localStream can't be trusted for this —
  // after a reconnect the slot is recreated empty, and the server treats an
  // unannounced source as active by default (see peer.go publishState).
  // Replayed into a freshly (re)created slot by restoreCameraState().
  private cameraEnabled = false;
  private cameraStartPromise: Promise<void> | null = null;

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
    onLocalScreenStream: LocalScreenStreamListener,
    onError: ErrorListener,
    onQualityChange: QualityListener,
  ) {
    this.socket = socket;
    this.selfUserID = selfUserID;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteLeft = onRemoteLeft;
    this.onLocalStream = onLocalStream;
    this.onLocalScreenStream = onLocalScreenStream;
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
    this.unsubscribers.push(this.socket.onSfuTrackUnpublished((event) => this.handleTrackUnpublished(event)));
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
    this.cameraEnabled = false;
    const stream = capture.currentStream;
    this.localStream = stream;
    this.onLocalStream(stream);

    this.applySession(response);
    await this.openPeerConnection();

    // Camera starts off (lazy capture) — announce that now so it's already
    // reflected in the snapshot anyone joining after us receives (see
    // sendTrackSnapshot on the server).
    this.restoreCameraState();

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
        this.restoreCameraState();
        return;
      } catch (err) {
        debugLog("sfu:resume-failed-falling-back-to-rejoin", err);
      }
    }

    this.teardownPeerConnection();

    const response = await this.socket.joinVoiceChannel(channelID);
    this.applySession(response);
    await this.openPeerConnection();
    this.restoreCameraState();
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

    this.startQualityMonitor();
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
    const match = /^u(\d+)-(.+)$/.exec(streamID);
    if (!match) {
      debugLog("sfu:ontrack-unrecognized-stream", { streamID });
      return;
    }

    const userID = Number(match[1]);
    const source = match[2];
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
    const combinedStream = stream;

    if (event.track.kind === "video" && (source === "camera" || source === "screen")) {
      const slots = this.remoteVideoTracks.get(userID) ?? {};
      slots[source] = event.track;
      this.remoteVideoTracks.set(userID, slots);

      // Whether this slot is *currently* shown (vs. paused) is driven
      // explicitly by sfu_track_published/unpublished — see
      // handleTrackPublished/handleTrackUnpublished and hiddenRemoteVideo's
      // doc comment for why RTP-level signals (mute/ended) aren't used for
      // that. `ended` here only covers the track object going away for
      // real, e.g. this whole subscription being torn down.
      event.track.onended = () => {
        const current = this.remoteVideoTracks.get(userID);
        if (current?.[source] === event.track) {
          delete current[source];
        }
        this.reconcileRemoteVideo(userID, combinedStream);
        this.onRemoteStream(participant, combinedStream);
      };

      this.reconcileRemoteVideo(userID, combinedStream);
      this.onRemoteStream(participant, combinedStream);
      return;
    }

    // Audio (mic/screen_audio): the browser mixes and plays every audio
    // track in a stream simultaneously, so — unlike video — there's no
    // "only one wins" problem and both can just coexist here.
    if (!combinedStream.getTracks().some((existing) => existing.id === event.track.id)) {
      combinedStream.addTrack(event.track);
    }
    event.track.onended = () => {
      const existing = combinedStream.getTracks().find((t) => t.id === event.track.id);
      if (existing) {
        combinedStream.removeTrack(existing);
      }
      this.onRemoteStream(participant, combinedStream);
    };

    this.onRemoteStream(participant, combinedStream);
  }

  /** Picks which of a participant's camera/screen tracks should actually be
   * in their combined tile's MediaStream: a screen share that's live and
   * not explicitly paused (hiddenRemoteVideo) takes priority over camera —
   * see the field doc on remoteVideoTracks for why this is needed at all. */
  private reconcileRemoteVideo(userID: number, stream: MediaStream): void {
    const slots = this.remoteVideoTracks.get(userID);
    const available = (source: "camera" | "screen", track?: MediaStreamTrack) =>
      Boolean(track && track.readyState === "live" && !this.hiddenRemoteVideo.has(`${userID}:${source}`));

    const desired = available("screen", slots?.screen)
      ? slots!.screen!
      : available("camera", slots?.camera)
        ? slots!.camera!
        : null;

    for (const track of stream.getVideoTracks()) {
      if (track !== desired) {
        stream.removeTrack(track);
      }
    }
    if (desired && !stream.getTracks().includes(desired)) {
      stream.addTrack(desired);
    }
  }

  /** Marks source as currently paused for userID (sfu_track_unpublished) and
   * re-reconciles their tile — e.g. a screen share stopping should fall back
   * to camera immediately, not stay frozen on the last frame. */
  private hideRemoteVideo(userID: number, source: "camera" | "screen"): void {
    this.hiddenRemoteVideo.add(`${userID}:${source}`);
    this.refreshRemoteVideo(userID);
  }

  /** Marks source as live again for userID (sfu_track_published) and
   * re-reconciles their tile. */
  private reappearRemoteVideo(userID: number, source: "camera" | "screen"): void {
    this.hiddenRemoteVideo.delete(`${userID}:${source}`);
    this.refreshRemoteVideo(userID);
  }

  private refreshRemoteVideo(userID: number): void {
    const stream = this.remoteStreams.get(userID);
    if (!stream) {
      return; // ontrack hasn't fired yet for this participant at all
    }
    this.reconcileRemoteVideo(userID, stream);
    const participant = this.participants.get(userID) ?? { user_id: userID };
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

    if (event.source === "screen" || event.source === "camera") {
      // A screen share or camera restarting after sfu_publish_state
      // announced it stopped: the underlying subscription (m-line) never
      // went away (decision #3 — no renegotiation for a toggle), so
      // there's nothing to re-subscribe to, just show it again. Safe to
      // call even on the very first ever publish, before
      // subscribedVideo/ontrack exist yet — reappearRemoteVideo/
      // refreshRemoteVideo both no-op until they do.
      this.reappearRemoteVideo(event.user_id, event.source);
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

  /** sfu_track_unpublished for "screen" or "camera" (the only sources the
   * server ever sends this for mid-call — see WsActionSfuPublishState): the
   * sharer called stopScreenShare(), or setCameraEnabled(false). The
   * subscription itself stays intact (decision #3), this only swaps the
   * tile's visible video immediately instead of leaving it frozen on the
   * source's last frame. */
  private handleTrackUnpublished(event: SfuTrackEvent): void {
    if (event.channel_id !== this.currentChannelID || event.user_id === this.selfUserID) {
      return;
    }
    if (event.source === "screen" || event.source === "camera") {
      this.hideRemoteVideo(event.user_id, event.source);
    }
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
    this.qualityTracker = createQualityTracker();
    this.lastQualitySignature = "";
    this.onQualityChange({});
  }

  /**
   * Star topology (decision #6/§4): there's exactly one PeerConnection, so
   * unlike mesh's per-peer sampling there's only ever one quality reading —
   * getStats() aggregates inbound (everything from the server, i.e.
   * everyone's audio/video) and outbound (this client's own publish slots)
   * across every track on the connection. The same reading is reported
   * under every currently known participant so both the per-tile badges and
   * the toolbar's aggregate (worst-of-all, which collapses to this single
   * value) light up correctly.
   */
  private async sampleQuality(): Promise<void> {
    if (this.currentChannelID <= 0) {
      return;
    }

    const quality = await this.sampleConnection(readForcedLevel());

    // getStats() is async — leave()/teardown may have run while awaiting it.
    if (this.currentChannelID <= 0) {
      return;
    }

    const snapshot: Record<number, PeerQuality> = {};
    for (const userID of this.participants.keys()) {
      snapshot[userID] = quality;
    }

    const signature = qualitySignature(snapshot);
    if (signature === this.lastQualitySignature) {
      return;
    }
    this.lastQualitySignature = signature;
    this.onQualityChange(snapshot);
  }

  private async sampleConnection(forcedLevel: QualityLevel | null): Promise<PeerQuality> {
    const tracker = this.qualityTracker;

    if (forcedLevel) {
      tracker.level = forcedLevel;
      return buildQuality(forcedLevel, EMPTY_METRICS, null);
    }

    const pc = this.pc;
    if (!pc) {
      return buildQuality(applyHysteresis(tracker, "disconnected"), EMPTY_METRICS, null);
    }

    const serviceLevel = serviceLevelOf(pc);
    if (serviceLevel) {
      return buildQuality(applyHysteresis(tracker, serviceLevel), EMPTY_METRICS, null);
    }

    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return buildQuality(applyHysteresis(tracker, "connecting"), EMPTY_METRICS, null);
    }

    const sample = readQualitySample(report, tracker);
    debugLog("sfu:quality-sample", { level: sample.level, ...sample.metrics });

    // No previous counters yet, or nothing flowed this interval — nothing to
    // measure, not evidence of a problem.
    if (!sample.level) {
      return buildQuality(applyHysteresis(tracker, "connecting"), sample.metrics, null);
    }

    return buildQuality(applyHysteresis(tracker, sample.level), sample.metrics, sample.direction);
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
    this.remoteVideoTracks.delete(event.user.user_id);
    if (this.remoteStreams.has(event.user.user_id)) {
      this.remoteStreams.delete(event.user.user_id);
      this.onRemoteLeft(event.user.user_id);
    }

    // Without this, a user who leaves and later rejoins the same channel
    // would be skipped by handleTrackPublished forever: subscribedVideo is
    // keyed by their persistent user_id, not their (new) SFU session, so a
    // stale entry from before they left would look identical to an
    // already-live subscription. Same reasoning for hiddenRemoteVideo: a
    // stale "screen paused" entry from a previous session would otherwise
    // keep their camera showing even after they republish screen next time.
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
    for (const key of this.hiddenRemoteVideo) {
      if (key.startsWith(prefix)) {
        this.hiddenRemoteVideo.delete(key);
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

    this.teardownPeerConnection(); // also stops the quality monitor and clears onQualityChange
    this.participants.clear();

    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.onLocalScreenStream(null);
    this.screenSharePromise = null;
    this.switchCameraPromise = null;
    this.cameraEnabled = false;
    this.cameraStartPromise = null;

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
    this.remoteVideoTracks.clear();
    this.hiddenRemoteVideo.clear();
    this.currentChannelID = 0;

    this.stopQualityMonitor();
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

  /**
   * Camera is captured lazily: turning it on requests getUserMedia for the
   * first time (or again, since turning it off fully releases the device —
   * see releaseCameraTrack), turning it off stops the track so the camera
   * LED actually goes out instead of just muting frames.
   */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (this.cameraStartPromise) {
      await this.cameraStartPromise; // don't let two clicks race two getUserMedia calls
    }
    if (enabled === this.cameraEnabled) {
      return;
    }
    if (!enabled) {
      this.cameraEnabled = false;
      this.releaseCameraTrack();
      this.announcePublishState("camera", false);
      return;
    }
    this.cameraStartPromise = this.startCamera().finally(() => {
      this.cameraStartPromise = null;
    });
    return this.cameraStartPromise;
  }

  /** Captures the camera on demand and drops it into the already-declared
   * publish slot. No renegotiation: the simulcast sendEncodings live on the
   * transceiver, not the track, and survive replaceTrack. */
  private async startCamera(): Promise<void> {
    if (!this.capture || !this.localStream) {
      throw new Error("Join voice channel before enabling camera");
    }
    const sender = this.senderBySource.get("camera");
    if (!sender) {
      throw new Error("Camera slot is not available in this session");
    }
    const track = await this.capture.acquireVideoTrack(this.capture.facingMode);
    // The user may have left the channel while the permission prompt was up.
    if (!this.capture || !this.localStream || !this.senderBySource.get("camera")) {
      track.stop();
      return;
    }
    track.onended = () => { void this.setCameraEnabled(false); };
    await sender.replaceTrack(track);

    const nextStream = new MediaStream([...this.localStream.getAudioTracks(), track]);
    this.localStream = nextStream;
    this.capture.setStream(nextStream);
    this.onLocalStream(nextStream);

    this.cameraEnabled = true;
    this.announcePublishState("camera", true);
  }

  /** Releases the device (camera LED goes out) instead of just muting frames. */
  private releaseCameraTrack(): void {
    const sender = this.senderBySource.get("camera");
    void sender?.replaceTrack(null).catch(() => { /* session already torn down */ });

    const track = this.localStream?.getVideoTracks()[0];
    if (track) {
      track.onended = null;
      track.stop();
    }
    if (this.localStream && this.capture) {
      const nextStream = new MediaStream(this.localStream.getAudioTracks());
      this.localStream = nextStream;
      this.capture.setStream(nextStream);
      this.onLocalStream(nextStream);
    }
  }

  /** Replays cameraEnabled into a freshly (re)created slot and re-announces
   * publish_state. Needed after join/rejoin/resume, since the server treats
   * an unannounced source as active by default (peer.go publishState). */
  private restoreCameraState(): void {
    const track = this.localStream?.getVideoTracks()[0] ?? null;
    if (this.cameraEnabled && track) {
      void this.senderBySource.get("camera")?.replaceTrack(track).catch((err) => {
        debugLog("sfu:camera-restore-failed", err);
      });
    }
    this.announcePublishState("camera", this.cameraEnabled && Boolean(track));
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
    this.onLocalScreenStream(displayStream);
    await sender.replaceTrack(displayTrack);
    void applyVideoBitratePreset(sender, SCREEN_BITRATE_PRESET);
    this.announcePublishState("screen", true);

    displayTrack.onended = () => {
      void this.stopScreenShare();
    };
  }

  async stopScreenShare(): Promise<void> {
    const activeScreenStream = this.screenStream;
    if (!activeScreenStream) {
      return;
    }
    this.screenStream = null;

    // The track may already be "ended" — that's exactly the path through the
    // browser's own "Stop sharing" pill: displayTrack.onended calls us
    // ourselves. stop() on an already-stopped track is safe and idempotent.
    activeScreenStream.getVideoTracks().forEach((track) => track.stop());

    const sender = this.senderBySource.get("screen");
    if (sender) {
      await sender.replaceTrack(null);
    }
    this.onLocalScreenStream(null);
    this.announcePublishState("screen", false);
  }

  /** Tells the room this source just started/stopped producing media (see
   * sfu_publish_state's doc comment in chatSocket.ts for why this exists).
   * Best-effort by design, same as sfu_candidate: worth logging on failure,
   * not worth surfacing as an error to the user over a tile staying on its
   * last frame a little longer. */
  private announcePublishState(source: string, active: boolean): void {
    if (!this.sessionID) {
      return;
    }
    void this.socket.sendSfuPublishState(this.sessionID, source, active).catch((err) => {
      debugLog("sfu:publish-state-failed", { source, active, err });
    });
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
