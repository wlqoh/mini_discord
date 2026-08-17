import type { JoinVoiceResponse, VoiceParticipant, VoiceTransportMode } from "../types/chat";
import { ChatSocket } from "./chatSocket";
import { MeshCallClient } from "./meshCallClient";
import { SfuCallClient } from "./sfuCallClient";
import { LocalCapture } from "./localCapture";
import type {
  VoiceClient,
  RemoteStreamListener,
  RemoteLeftListener,
  LocalStreamListener,
  ErrorListener,
  QualityListener,
} from "./voiceClient";

/** Internal contract both implementations satisfy structurally (see their
 * own attachJoin doc comments) — not part of the public VoiceClient surface
 * because only this factory needs to hand in an already-acquired capture. */
interface AttachableVoiceClient extends VoiceClient {
  attachJoin(response: JoinVoiceResponse, capture: LocalCapture): Promise<JoinVoiceResponse>;
}

/**
 * Picks the transport implementation the server assigns for a channel
 * (join_voice_channel's transport_mode — sfu-migration-plan.md §3 decision
 * #11) without callers needing to know which concrete class is active.
 *
 * The tricky part (flagged as a TODO here through migration phase 0, now
 * resolved): MeshCallClient.join() and SfuCallClient.join() both need local
 * media acquired BEFORE join_voice_channel is called — otherwise another
 * participant can react to our join (mesh: send us an offer; SFU: the
 * server can start subscribing others to our mic) before our track exists,
 * and nothing ever retries that. But transport_mode is only known from
 * join_voice_channel's *response*. This factory breaks that cycle by owning
 * the acquisition itself: acquire once, then call join_voice_channel, then
 * construct whichever implementation the ack names and hand it the
 * already-acquired LocalCapture via attachJoin — so neither implementation
 * ever has to guess, and media is never acquired twice.
 */
export class VoiceClientFactory implements VoiceClient {
  private readonly socket: ChatSocket;
  private readonly selfUserID: number;
  private readonly onRemoteStream: RemoteStreamListener;
  private readonly onRemoteLeft: RemoteLeftListener;
  private readonly onLocalStream: LocalStreamListener;
  private readonly onError: ErrorListener;
  private readonly onQualityChange: QualityListener;

  private active: AttachableVoiceClient | null = null;
  private activeMode: VoiceTransportMode | null = null;
  private currentChannelID = 0;

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
  }

  private construct(mode: VoiceTransportMode): AttachableVoiceClient {
    const args = [
      this.socket,
      this.selfUserID,
      this.onRemoteStream,
      this.onRemoteLeft,
      this.onLocalStream,
      this.onError,
      this.onQualityChange,
    ] as const;
    return mode === "sfu" ? new SfuCallClient(...args) : new MeshCallClient(...args);
  }

  async join(channelID: number): Promise<JoinVoiceResponse> {
    // Already in this channel on the currently active implementation:
    // delegate to its own join(), which short-circuits without touching
    // media or the socket — same as calling join() twice used to be a
    // no-op before this factory existed.
    if (this.active && this.currentChannelID === channelID) {
      return this.active.join(channelID);
    }

    if (this.active) {
      await this.active.leave();
    }

    const capture = new LocalCapture(this.onError);
    try {
      await capture.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to access microphone/camera";
      this.onError(`${message}. Joined voice in listen-only mode.`);
    }

    const response = await this.socket.joinVoiceChannel(channelID);

    if (!this.active || this.activeMode !== response.transport_mode) {
      this.active?.dispose();
      this.active = this.construct(response.transport_mode);
      this.activeMode = response.transport_mode;
    }

    const result = await this.active.attachJoin(response, capture);
    this.currentChannelID = result.channel_id;
    return result;
  }

  async rejoin(channelID: number): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.active.rejoin(channelID);
    this.currentChannelID = channelID;
  }

  async leave(): Promise<void> {
    await this.active?.leave();
    this.currentChannelID = 0;
  }

  dispose(): void {
    this.active?.dispose();
    this.active = null;
    this.activeMode = null;
    this.currentChannelID = 0;
  }

  setMicrophoneEnabled(enabled: boolean): void {
    this.active?.setMicrophoneEnabled(enabled);
  }

  setCameraEnabled(enabled: boolean): void {
    this.active?.setCameraEnabled(enabled);
  }

  toggleCameraFacingMode(): Promise<void> {
    return this.active?.toggleCameraFacingMode() ?? Promise.resolve();
  }

  isScreenShareActive(): boolean {
    return this.active?.isScreenShareActive() ?? false;
  }

  toggleScreenShare(): Promise<boolean> {
    return this.active?.toggleScreenShare() ?? Promise.resolve(false);
  }

  startScreenShare(): Promise<void> {
    return this.active?.startScreenShare() ?? Promise.resolve();
  }

  stopScreenShare(): Promise<void> {
    return this.active?.stopScreenShare() ?? Promise.resolve();
  }

  syncParticipants(channelID: number, participants: VoiceParticipant[]): void {
    this.active?.syncParticipants(channelID, participants);
  }
}
