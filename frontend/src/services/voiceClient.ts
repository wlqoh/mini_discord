import type { JoinVoiceResponse, VoiceParticipant } from "../types/chat";
import type { PeerQuality } from "./connectionQuality";

export type RemoteStreamListener = (user: VoiceParticipant, stream: MediaStream) => void;
export type RemoteLeftListener = (userId: number) => void;
export type LocalStreamListener = (stream: MediaStream | null) => void;
export type ErrorListener = (message: string) => void;
export type QualityListener = (quality: Record<number, PeerQuality>) => void;

/**
 * Transport-agnostic surface both the mesh and SFU implementations expose
 * (see sfu-migration-plan.md §3 decision #6). useVoice/useServers/ChatPage
 * depend only on this interface, never on a concrete implementation, so the
 * transport in use can be swapped per the server's transport_mode without
 * touching call-site code.
 */
export interface VoiceClient {
  join(channelID: number): Promise<JoinVoiceResponse>;
  rejoin(channelID: number): Promise<void>;
  leave(): Promise<void>;
  dispose(): void;

  setMicrophoneEnabled(enabled: boolean): void;
  setCameraEnabled(enabled: boolean): void;
  toggleCameraFacingMode(): Promise<void>;

  isScreenShareActive(): boolean;
  toggleScreenShare(): Promise<boolean>;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void>;

  syncParticipants(channelID: number, participants: VoiceParticipant[]): void;
}
