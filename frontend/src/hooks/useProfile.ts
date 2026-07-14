import { useCallback, useEffect, useState } from "react";
import type React from "react";
import type { NavigateFunction } from "react-router-dom";
import API from "../api";
import { extractApiError } from "../services/apiError";
import { CallClient } from "../services/callClient.ts";
import { ChatSocket } from "../services/chatSocket.ts";
import { clearAuthStorage } from "../services/authToken.ts";
import type { CurrentUserProfile } from "../services/authToken.ts";
import { uploadMyAvatar } from "../services/avatarApi.ts";
import type { MessagesByChannel, UserProfile, VoiceParticipantsByChannel } from "../types/chat.ts";

const MAX_AVATAR_SIZE_BYTES = 1024 * 1024; // 1 MB
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const CHAT_SERVERS_KEY = "chat_servers";
const CHAT_CHANNELS_BY_SERVER_KEY = "chat_channels_by_server";
const CHAT_SELECTED_SERVER_KEY = "chat_selected_server_id";

type Params = {
    socketRef: React.MutableRefObject<ChatSocket | null>;
    callClientRef: React.MutableRefObject<CallClient | null>;
    avatarInputRef: React.MutableRefObject<HTMLInputElement | null>;
    currentUserId: number | null;
    currentUserProfile: CurrentUserProfile | null;
    setCurrentUserProfile: (profile: CurrentUserProfile) => void;
    avatarUrl: string;
    setAvatarUrl: (url: string) => void;
    messagesByChannel: MessagesByChannel;
    voiceParticipantsByChannel: VoiceParticipantsByChannel;
    showToast: (type: "success" | "error", message: string) => void;
    navigate: NavigateFunction;
    closeModalWithAnim: (name: string, close: () => void) => void;
};

export function useProfile({
    socketRef,
    callClientRef,
    avatarInputRef,
    currentUserId,
    currentUserProfile,
    setCurrentUserProfile,
    avatarUrl,
    setAvatarUrl,
    messagesByChannel,
    voiceParticipantsByChannel,
    showToast,
    navigate,
    closeModalWithAnim,
}: Params) {
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isAvatarPreviewOpen, setIsAvatarPreviewOpen] = useState(false);
    const [selectedProfileUserId, setSelectedProfileUserId] = useState<number | null>(null);
    const [selectedProfile, setSelectedProfile] = useState<UserProfile | null>(null);
    const [selectedProfileError, setSelectedProfileError] = useState("");
    const [isProfileLoading, setIsProfileLoading] = useState(false);
    const [nicknameDraft, setNicknameDraft] = useState("");
    const [profileUpdateError, setProfileUpdateError] = useState("");
    const [isSavingNickname, setIsSavingNickname] = useState(false);
    const [isDeleteAccountConfirmOpen, setIsDeleteAccountConfirmOpen] = useState(false);
    const [deletePasswordDraft, setDeletePasswordDraft] = useState("");
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [deleteAccountError, setDeleteAccountError] = useState("");
    const [avatarError, setAvatarError] = useState("");
    const [isAvatarUploading, setIsAvatarUploading] = useState(false);

    // Derived values
    const isSelfProfile = selectedProfileUserId === null || selectedProfileUserId === currentUserId;
    const profileAvatarUrl = isSelfProfile ? avatarUrl : (selectedProfile?.avatar_url ?? "");
    const profileFirstName = isSelfProfile ? currentUserProfile?.first_name : selectedProfile?.first_name;
    const profileLastName = isSelfProfile ? currentUserProfile?.last_name : selectedProfile?.last_name;
    const profileNickname = isSelfProfile ? currentUserProfile?.nickname : selectedProfile?.nickname;
    const profileDisplayName = profileNickname || [profileFirstName, profileLastName].filter(Boolean).join(" ").trim();
    const profileInitial = (profileNickname?.[0] ?? profileFirstName?.[0] ?? profileLastName?.[0] ?? "U").toUpperCase();

    // Escape key effect for avatar preview
    useEffect(() => {
        if (!isAvatarPreviewOpen) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                closeModalWithAnim("avatarViewer", () => setIsAvatarPreviewOpen(false));
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isAvatarPreviewOpen, closeModalWithAnim]);

    const openSelfProfile = useCallback(() => {
        setSelectedProfileUserId(null);
        setSelectedProfile(null);
        setSelectedProfileError("");
        setProfileUpdateError("");
        setIsProfileLoading(false);
        setDeleteAccountError("");
        setIsDeleteAccountConfirmOpen(false);
        setDeletePasswordDraft("");
        setIsAvatarPreviewOpen(false);
        setNicknameDraft(currentUserProfile?.nickname ?? "");
        setIsProfileModalOpen(true);
    }, [currentUserProfile?.nickname]);

    const openUserProfile = useCallback(async (userId: number) => {
        if (currentUserId && userId === currentUserId) {
            openSelfProfile();
            return;
        }

        setSelectedProfileUserId(userId);
        setSelectedProfile(null);
        setSelectedProfileError("");
        setProfileUpdateError("");
        setIsProfileLoading(true);
        setIsAvatarPreviewOpen(false);
        setNicknameDraft("");
        setIsProfileModalOpen(true);

        const socket = socketRef.current;
        if (!socket) {
            setSelectedProfileError("No connection");
            setIsProfileLoading(false);
            return;
        }

        try {
            const info = await socket.getUserInfo(userId);
            setSelectedProfile(info);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to load user profile";
            if (message.toLowerCase().includes("unknown action")) {
                const messageFallback = Object.values(messagesByChannel)
                    .flat()
                    .find((item) => item.author_id === userId);
                const voiceFallback = Object.values(voiceParticipantsByChannel)
                    .flat()
                    .find((item) => item.user_id === userId);

                if (messageFallback || voiceFallback) {
                    setSelectedProfile({
                        user_id: userId,
                        first_name: messageFallback?.author_first_name ?? voiceFallback?.first_name ?? "",
                        last_name: messageFallback?.author_last_name ?? voiceFallback?.last_name ?? "",
                        nickname: messageFallback?.author_nickname ?? voiceFallback?.nickname ?? "",
                        avatar_url: messageFallback?.author_avatar_url ?? voiceFallback?.avatar_url ?? "",
                    });
                    setSelectedProfileError("");
                    return;
                }
            }

            setSelectedProfileError(message);
        } finally {
            setIsProfileLoading(false);
        }
    }, [currentUserId, openSelfProfile, messagesByChannel, voiceParticipantsByChannel, socketRef]);

    async function handleSaveNickname(): Promise<void> {
        if (!currentUserProfile) {
            setProfileUpdateError("Profile not loaded");
            return;
        }
        const firstName = profileFirstName?.trim() ?? "";
        const lastName = profileLastName?.trim() ?? "";
        const nickname = nicknameDraft.trim();
        if (!firstName || !lastName || !nickname) {
            setProfileUpdateError("First name, last name, and nickname are required");
            return;
        }
        if (nickname.length < 5) {
            setProfileUpdateError("Nickname must be at least 5 characters long");
            return;
        }
        if (isSavingNickname) {
            return;
        }
        setIsSavingNickname(true);
        setProfileUpdateError("");
        try {
            await API.post("/updateUser", {
                first_name: firstName,
                last_name: lastName,
                nickname,
            });
            const nextProfile: CurrentUserProfile = {
                ...currentUserProfile,
                first_name: firstName,
                last_name: lastName,
                nickname,
            };
            localStorage.setItem("current_user", JSON.stringify(nextProfile));
            setCurrentUserProfile(nextProfile);
            setNicknameDraft(nickname);
            showToast("success", "Profile updated");
        } catch (err) {
            setProfileUpdateError(extractApiError(err, "Failed to update profile"));
        } finally {
            setIsSavingNickname(false);
        }
    }

    function openAvatarPicker(): void {
        setAvatarError("");
        avatarInputRef.current?.click();
    }

    async function handleAvatarChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
            setAvatarError("Unsupported file type. Please select a PNG, JPEG, or WEBP image.");
            event.target.value = "";
            return;
        }

        if (file.size > MAX_AVATAR_SIZE_BYTES) {
            setAvatarError("File is too large. Please select an image smaller than 1 MB.");
            event.target.value = "";
            return;
        }

        setIsAvatarUploading(true);
        setAvatarError("");

        try {
            const uploadedUrl = await uploadMyAvatar(file);
            setAvatarUrl(uploadedUrl);
            showToast("success", "Profile photo updated");
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to upload avatar";
            setAvatarError(message);
        } finally {
            setIsAvatarUploading(false);
            event.target.value = "";
        }
    }

    function openAvatarPreview(): void {
        if (!avatarUrl) return;
        setIsAvatarPreviewOpen(true);
    }

    function closeAvatarPreview(): void {
        closeModalWithAnim("avatarViewer", () => setIsAvatarPreviewOpen(false));
    }

    function handleLogout() {
        callClientRef.current?.dispose();
        callClientRef.current = null;
        socketRef.current?.close();
        socketRef.current = null;

        clearAuthStorage();

        localStorage.removeItem(CHAT_SERVERS_KEY);
        localStorage.removeItem(CHAT_CHANNELS_BY_SERVER_KEY);
        localStorage.removeItem(CHAT_SELECTED_SERVER_KEY);

        setIsProfileModalOpen(false);

        navigate("/login", { replace: true });
    }

    async function handleDeleteAccount(): Promise<void> {
        const password = deletePasswordDraft;
        if (!password) {
            setDeleteAccountError("Enter your password to confirm");
            return;
        }
        if (isDeletingAccount) {
            return;
        }
        setIsDeletingAccount(true);
        setDeleteAccountError("");
        try {
            await API.delete("/deleteUser", { data: { password } });
            callClientRef.current?.dispose();
            callClientRef.current = null;
            socketRef.current?.close();
            socketRef.current = null;
            clearAuthStorage();
            localStorage.removeItem(CHAT_SERVERS_KEY);
            localStorage.removeItem(CHAT_CHANNELS_BY_SERVER_KEY);
            localStorage.removeItem(CHAT_SELECTED_SERVER_KEY);
            setIsProfileModalOpen(false);
            navigate("/login", { replace: true });
        } catch (err) {
            setDeleteAccountError(extractApiError(err, "Failed to delete account"));
        } finally {
            setIsDeletingAccount(false);
        }
    }

    return {
        isProfileModalOpen,
        setIsProfileModalOpen,
        isAvatarPreviewOpen,
        setIsAvatarPreviewOpen,
        selectedProfileUserId,
        selectedProfile,
        selectedProfileError,
        isProfileLoading,
        nicknameDraft,
        setNicknameDraft,
        profileUpdateError,
        isSavingNickname,
        isDeleteAccountConfirmOpen,
        setIsDeleteAccountConfirmOpen,
        deletePasswordDraft,
        setDeletePasswordDraft,
        isDeletingAccount,
        deleteAccountError,
        avatarError,
        isAvatarUploading,
        isSelfProfile,
        profileAvatarUrl,
        profileFirstName,
        profileLastName,
        profileNickname,
        profileDisplayName,
        profileInitial,
        openSelfProfile,
        openUserProfile,
        handleSaveNickname,
        openAvatarPicker,
        handleAvatarChange,
        openAvatarPreview,
        closeAvatarPreview,
        handleLogout,
        handleDeleteAccount,
    };
}
