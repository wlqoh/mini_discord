import { useCallback, useEffect, useState } from "react";
import type { NotificationSettings } from "../types/notifications.ts";
import {
    getNotificationSettings,
    patchGlobalNotificationSettings,
    putChannelNotificationSetting,
    putServerNotificationSetting,
    type GlobalSettingsPatch,
    type ScopedSettingPatch,
} from "../services/notificationsApi.ts";

/**
 * Fetches and caches server-side notification settings (levels, mutes, DND).
 * These live in Postgres — not localStorage — because the backend push
 * sender must apply the same rules when the tab is closed (NOTIFICATIONS_PLAN.md §2 decision 3).
 */
export function useNotificationSettings(isAuthenticated: boolean) {
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        if (!isAuthenticated) return;
        setIsLoading(true);
        try {
            const next = await getNotificationSettings();
            setSettings(next);
            setError("");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load notification settings");
        } finally {
            setIsLoading(false);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const updateGlobal = useCallback(async (patch: GlobalSettingsPatch) => {
        try {
            const next = await patchGlobalNotificationSettings(patch);
            setSettings(next);
            setError("");
            return next;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to update notification settings";
            setError(message);
            throw err;
        }
    }, []);

    const updateServer = useCallback(async (serverId: number, patch: ScopedSettingPatch) => {
        try {
            const next = await putServerNotificationSetting(serverId, patch);
            setSettings(next);
            setError("");
            return next;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to update server notification setting";
            setError(message);
            throw err;
        }
    }, []);

    const updateChannel = useCallback(async (channelId: number, patch: ScopedSettingPatch) => {
        try {
            const next = await putChannelNotificationSetting(channelId, patch);
            setSettings(next);
            setError("");
            return next;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to update channel notification setting";
            setError(message);
            throw err;
        }
    }, []);

    return {
        settings,
        isLoading,
        error,
        refresh,
        updateGlobal,
        updateServer,
        updateChannel,
    };
}
