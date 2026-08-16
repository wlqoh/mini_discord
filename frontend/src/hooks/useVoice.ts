import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { CallClient } from "../services/callClient.ts";
import { ChatSocket } from "../services/chatSocket.ts";
import { playJoinSound, playLeaveSound } from "../services/sounds.ts";
import type { CurrentUserProfile } from "../services/authToken.ts";
import type { VoiceParticipant, VoiceParticipantsByChannel } from "../types/chat.ts";
import { aggregateQuality, type PeerQuality } from "../services/connectionQuality.ts";

const VOICE_VOLUME_KEY = "voice_volume_by_user";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    callClientRef: React.MutableRefObject<CallClient | null>;
    currentUserId: number | null;
    currentUserProfile: CurrentUserProfile | null;
    avatarUrl: string;
    setError: (msg: string) => void;
};

export function useVoice({
    socketRef,
    callClientRef,
    currentUserId,
    currentUserProfile,
    avatarUrl,
    setError,
}: Params) {
    const [voiceChannelId, setVoiceChannelId] = useState(0);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<Array<{
        userId: number;
        label: string;
        stream: MediaStream;
    }>>([]);
    const [voiceParticipantsByChannel, setVoiceParticipantsByChannel] = useState<VoiceParticipantsByChannel>({});
    const [qualityByUserId, setQualityByUserId] = useState<Record<number, PeerQuality>>({});
    const [voiceVolumeByUserId, setVoiceVolumeByUserId] = useState<Record<number, number>>(() => {
        try {
            const stored = localStorage.getItem(VOICE_VOLUME_KEY);
            if (!stored) return {};
            const parsed = JSON.parse(stored) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
            const result: Record<number, number> = {};
            for (const [k, v] of Object.entries(parsed)) {
                const id = Number(k);
                const vol = Number(v);
                if (Number.isFinite(id) && id > 0 && Number.isFinite(vol) && vol >= 0 && vol <= 2) {
                    result[id] = vol;
                }
            }
            return result;
        } catch {
            return {};
        }
    });
    const [activeVolumeUserId, setActiveVolumeUserId] = useState<number | null>(null);
    const [isDeafened, setIsDeafened] = useState(false);
    const [isMicEnabled, setIsMicEnabled] = useState(true);
    const [isCameraEnabled, setIsCameraEnabled] = useState(true);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
    const [isTogglingScreenShare, setIsTogglingScreenShare] = useState(false);

    const micBeforeDeafenRef = useRef(true);

    // Voice volume persistence effect
    useEffect(() => {
        try {
            localStorage.setItem(VOICE_VOLUME_KEY, JSON.stringify(voiceVolumeByUserId));
        } catch {
            // ignore quota or security errors
        }
    }, [voiceVolumeByUserId]);

    // Deafen audio tracks effect
    useEffect(() => {
        remoteStreams.forEach(({ stream }) => {
            stream.getAudioTracks().forEach((track) => {
                track.enabled = !isDeafened;
            });
        });
    }, [remoteStreams, isDeafened]);

    const toParticipantLabel = useCallback((participant: VoiceParticipant): string => {
        const nickname = participant.nickname?.trim();
        if (nickname) {
            return nickname;
        }
        const fullName = [participant.first_name, participant.last_name].filter(Boolean).join(" ").trim();
        if (fullName) {
            return fullName;
        }
        return `User ${participant.user_id}`;
    }, []);

    const onParticipantStream = useCallback((participant: VoiceParticipant, stream: MediaStream) => {
        const label = toParticipantLabel(participant);
        setRemoteStreams((prev) => {
            const next = prev.filter((item) => item.userId !== participant.user_id);
            next.push({ userId: participant.user_id, label, stream });
            return next;
        });
        setVoiceVolumeByUserId((prev) => {
            if (participant.user_id in prev) {
                return prev;
            }
            return { ...prev, [participant.user_id]: 1 };
        });
    }, [toParticipantLabel]);

    const onParticipantLeft = useCallback((userId: number) => {
        setRemoteStreams((prev) => prev.filter((item) => item.userId !== userId));
    }, []);

    const onLocalStream = useCallback((stream: MediaStream | null) => {
        setLocalStream(stream);
        const hasVideoTrack = Boolean(stream?.getVideoTracks()[0]);
        const isVideoEnabled = stream?.getVideoTracks()[0]?.enabled ?? false;
        setIsCameraEnabled(hasVideoTrack && isVideoEnabled);
        setIsScreenSharing(callClientRef.current?.isScreenShareActive() ?? false);
        if (!stream) {
            setRemoteStreams([]);
            setIsSwitchingCamera(false);
            setIsTogglingScreenShare(false);
        }
    }, [callClientRef]);

    const onError = useCallback((message: string) => {
        setError(message);
    }, [setError]);

    const onQualityChange = useCallback((quality: Record<number, PeerQuality>) => {
        setQualityByUserId(quality);
    }, []);

    const callClientCallbacks = useMemo(() => ({
        onParticipantStream,
        onParticipantLeft,
        onLocalStream,
        onError,
        onQualityChange,
    }), [onParticipantStream, onParticipantLeft, onLocalStream, onError, onQualityChange]);

    const onVoiceUserJoined = useCallback((event: { channel_id: number; user: VoiceParticipant }) => {
        setVoiceParticipantsByChannel((prev) => {
            const current = prev[event.channel_id] ?? [];
            if (current.some((participant) => participant.user_id === event.user.user_id)) {
                return prev;
            }
            return {
                ...prev,
                [event.channel_id]: [...current, event.user],
            };
        });
    }, []);

    const onVoiceUserLeft = useCallback((event: { channel_id: number; user: VoiceParticipant }) => {
        setVoiceParticipantsByChannel((prev) => {
            const current = prev[event.channel_id] ?? [];
            if (!current.length) {
                return prev;
            }

            const next = current.filter((participant) => participant.user_id !== event.user.user_id);
            if (next.length === current.length) {
                return prev;
            }

            if (!next.length) {
                const rest = { ...prev };
                delete rest[event.channel_id];
                return rest;
            }

            return {
                ...prev,
                [event.channel_id]: next,
            };
        });
    }, []);

    const onVoiceStatusChanged = useCallback((event: { channel_id: number; user: VoiceParticipant }) => {
        setVoiceParticipantsByChannel((prev) => {
            const current = prev[event.channel_id] ?? [];
            if (!current.length) {
                return prev;
            }

            const index = current.findIndex((participant) => participant.user_id === event.user.user_id);
            if (index === -1) {
                return prev;
            }

            const next = [...current];
            next[index] = {
                ...current[index],
                ...event.user,
            };

            return {
                ...prev,
                [event.channel_id]: next,
            };
        });
    }, []);

    const voiceSocketHandlers = useMemo(() => ({
        onVoiceUserJoined,
        onVoiceUserLeft,
        onVoiceStatusChanged,
    }), [onVoiceUserJoined, onVoiceUserLeft, onVoiceStatusChanged]);

    const handleJoinVoice = useCallback(async (selectedChannelId: number): Promise<void> => {
        if (!callClientRef.current || selectedChannelId <= 0) {
            setError("Voice call is unavailable");
            return;
        }

        const previousChannelId = voiceChannelId;

        try {
            const response = await callClientRef.current.join(selectedChannelId);
            setVoiceChannelId(response.channel_id);
            setIsMicEnabled(true);
            setIsDeafened(false);
            setIsCameraEnabled(false);
            setIsSwitchingCamera(false);
            setIsScreenSharing(false);
            setIsTogglingScreenShare(false);
            setError("");

            playJoinSound();

            if (currentUserId) {
                setVoiceParticipantsByChannel((prev) => {
                    const next = { ...prev };

                    if (previousChannelId > 0 && previousChannelId !== response.channel_id) {
                        const prevChannel = next[previousChannelId];
                        if (prevChannel) {
                            const filtered = prevChannel.filter((p) => p.user_id !== currentUserId);
                            if (filtered.length === 0) {
                                delete next[previousChannelId];
                            } else {
                                next[previousChannelId] = filtered;
                            }
                        }
                    }

                    const selfParticipant: VoiceParticipant = {
                        user_id: currentUserId,
                        first_name: currentUserProfile?.first_name || undefined,
                        last_name: currentUserProfile?.last_name || undefined,
                        nickname: currentUserProfile?.nickname || undefined,
                        avatar_url: avatarUrl || undefined,
                        mic_enabled: true,
                        deafened: false,
                    };

                    const serverParticipants = response.participants.filter(
                        (p) => p.user_id !== selfParticipant.user_id,
                    );
                    next[response.channel_id] = [selfParticipant, ...serverParticipants];

                    return next;
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to join voice channel";
            setError(message);
        }
    }, [callClientRef, voiceChannelId, currentUserId, currentUserProfile, avatarUrl, setError]);

    const handleLeaveVoice = useCallback(async (): Promise<void> => {
        const channelId = voiceChannelId;

        try {
            await callClientRef.current?.leave();
            playLeaveSound();
        } finally {
            setVoiceChannelId(0);
            setRemoteStreams([]);
            setQualityByUserId({});
            setIsMicEnabled(true);
            setIsDeafened(false);
            setIsCameraEnabled(false);
            setIsSwitchingCamera(false);
            setIsScreenSharing(false);
            setIsTogglingScreenShare(false);

            if (channelId > 0 && currentUserId) {
                setVoiceParticipantsByChannel((prev) => {
                    const current = prev[channelId] ?? [];
                    const next = current.filter((p) => p.user_id !== currentUserId);
                    if (!next.length) {
                        const rest = { ...prev };
                        delete rest[channelId];
                        return rest;
                    }
                    return { ...prev, [channelId]: next };
                });
            }
        }
    }, [callClientRef, voiceChannelId, currentUserId]);

    const toggleMicrophone = useCallback((): void => {
        if (isDeafened) {
            return;
        }
        const next = !isMicEnabled;
        setIsMicEnabled(next);
        callClientRef.current?.setMicrophoneEnabled(next);

        if (currentUserId && voiceChannelId > 0 && socketRef.current) {
            void socketRef.current.changeVoiceStatus(currentUserId, next, isDeafened);
        }

        if (currentUserId && voiceChannelId > 0) {
            setVoiceParticipantsByChannel((prev) => {
                const channel = prev[voiceChannelId];
                if (!channel) return prev;
                const idx = channel.findIndex((p) => p.user_id === currentUserId);
                if (idx === -1) return prev;
                const updated = [...channel];
                updated[idx] = { ...updated[idx], mic_enabled: next };
                return { ...prev, [voiceChannelId]: updated };
            });
        }
    }, [isDeafened, isMicEnabled, callClientRef, currentUserId, voiceChannelId, socketRef]);

    const toggleCamera = useCallback((): void => {
        const videoTrack = localStream?.getVideoTracks()[0];
        if (!videoTrack) {
            setIsCameraEnabled(false);
            setError("Camera is unavailable on this device");
            return;
        }

        const next = !isCameraEnabled;
        setIsCameraEnabled(next);
        callClientRef.current?.setCameraEnabled(next);
    }, [localStream, isCameraEnabled, callClientRef, setError]);

    const switchCameraFacingMode = useCallback(async (): Promise<void> => {
        if (!callClientRef.current || isSwitchingCamera) {
            return;
        }

        try {
            setIsSwitchingCamera(true);
            setError("");
            await callClientRef.current.toggleCameraFacingMode();
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to switch camera";
            setError(message);
        } finally {
            setIsSwitchingCamera(false);
        }
    }, [callClientRef, isSwitchingCamera, setError]);

    const toggleScreenShare = useCallback(async (): Promise<void> => {
        if (!callClientRef.current || isTogglingScreenShare || isSwitchingCamera) {
            return;
        }

        try {
            setIsTogglingScreenShare(true);
            setError("");
            const nextState = await callClientRef.current.toggleScreenShare();
            setIsScreenSharing(nextState);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to toggle screen sharing";
            setError(message);
        } finally {
            setIsTogglingScreenShare(false);
        }
    }, [callClientRef, isTogglingScreenShare, isSwitchingCamera, setError]);

    const toggleDeafen = useCallback((): void => {
        const next = !isDeafened;
        if (next) {
            micBeforeDeafenRef.current = isMicEnabled;
            setIsDeafened(true);
            setIsMicEnabled(false);
            callClientRef.current?.setMicrophoneEnabled(false);

            if (currentUserId && voiceChannelId > 0 && socketRef.current) {
                void socketRef.current.changeVoiceStatus(currentUserId, false, true);
            }

            if (currentUserId && voiceChannelId > 0) {
                setVoiceParticipantsByChannel((prev) => {
                    const channel = prev[voiceChannelId];
                    if (!channel) return prev;
                    const idx = channel.findIndex((p) => p.user_id === currentUserId);
                    if (idx === -1) return prev;
                    const updated = [...channel];
                    updated[idx] = { ...updated[idx], mic_enabled: false, deafened: true };
                    return { ...prev, [voiceChannelId]: updated };
                });
            }
        } else {
            setIsDeafened(false);
            const restoreMic = micBeforeDeafenRef.current;
            setIsMicEnabled(restoreMic);
            callClientRef.current?.setMicrophoneEnabled(restoreMic);

            if (currentUserId && voiceChannelId > 0 && socketRef.current) {
                void socketRef.current.changeVoiceStatus(currentUserId, restoreMic, false);
            }

            if (currentUserId && voiceChannelId > 0) {
                setVoiceParticipantsByChannel((prev) => {
                    const channel = prev[voiceChannelId];
                    if (!channel) return prev;
                    const idx = channel.findIndex((p) => p.user_id === currentUserId);
                    if (idx === -1) return prev;
                    const updated = [...channel];
                    updated[idx] = { ...updated[idx], mic_enabled: restoreMic, deafened: false };
                    return { ...prev, [voiceChannelId]: updated };
                });
            }
        }
    }, [isDeafened, isMicEnabled, callClientRef, currentUserId, voiceChannelId, socketRef]);

    const voiceParticipantsInChannel = useMemo(
        () => voiceParticipantsByChannel[voiceChannelId] ?? [],
        [voiceParticipantsByChannel, voiceChannelId],
    );

    // Агрегат «ваше соединение»: худший из линков. null, когда пиров нет —
    // в одиночку в канале измерять нечего, индикатор не рендерится.
    const connectionQuality = useMemo(
        () => aggregateQuality(Object.values(qualityByUserId)),
        [qualityByUserId],
    );

    return {
        voiceChannelId,
        localStream,
        remoteStreams,
        voiceParticipantsByChannel,
        setVoiceParticipantsByChannel,
        qualityByUserId,
        connectionQuality,
        voiceVolumeByUserId,
        setVoiceVolumeByUserId,
        activeVolumeUserId,
        setActiveVolumeUserId,
        isDeafened,
        isMicEnabled,
        isCameraEnabled,
        isScreenSharing,
        isSwitchingCamera,
        isTogglingScreenShare,
        handleJoinVoice,
        handleLeaveVoice,
        toggleMicrophone,
        toggleCamera,
        switchCameraFacingMode,
        toggleScreenShare,
        toggleDeafen,
        voiceParticipantsInChannel,
        callClientCallbacks,
        voiceSocketHandlers,
    };
}
