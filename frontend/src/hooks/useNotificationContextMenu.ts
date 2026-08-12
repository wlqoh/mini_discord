import { useCallback, useState } from "react";
import type React from "react";
import type { NotificationLevel, NotificationSettings } from "../types/notifications.ts";
import type { ContextMenuItem } from "../components/ContextMenu.tsx";
import type { ScopedSettingPatch } from "../services/notificationsApi.ts";

type ContextMenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

const LEVELS: Array<{ value: "all" | "mentions" | "none"; label: string }> = [
    { value: "all", label: "All messages" },
    { value: "mentions", label: "Only mentions" },
    { value: "none", label: "Nothing" },
];

function hoursFromNow(hours: number): string {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

type Override = { level: NotificationLevel | null; muted_until: string | null } | undefined;

function buildLevelItems(override: Override, onUpdate: (patch: ScopedSettingPatch) => void): ContextMenuItem[] {
    const currentLevel = override?.level ?? null;
    const currentMutedUntil = override?.muted_until ?? null;
    const isMuted = Boolean(currentMutedUntil && new Date(currentMutedUntil).getTime() > Date.now());

    const items: ContextMenuItem[] = LEVELS.map((opt) => ({
        label: opt.label,
        active: currentLevel === opt.value,
        onClick: () => onUpdate({ level: opt.value, muted_until: currentMutedUntil }),
    }));

    items.push({ type: "separator" });
    if (isMuted) {
        items.push({ label: "Unmute", onClick: () => onUpdate({ level: currentLevel, muted_until: null }) });
    } else {
        items.push({ label: "Mute for 1 hour", onClick: () => onUpdate({ level: currentLevel, muted_until: hoursFromNow(1) }) });
        items.push({ label: "Mute for 8 hours", onClick: () => onUpdate({ level: currentLevel, muted_until: hoursFromNow(8) }) });
    }

    if (currentLevel !== null || isMuted) {
        items.push({ type: "separator" });
        items.push({ label: "Reset to default", onClick: () => onUpdate({ level: null, muted_until: null }) });
    }

    return items;
}

/** Right-click "Notifications" quick actions for a server or channel row — see NOTIFICATIONS_PLAN.md §2 decision 13. */
export function useNotificationContextMenu(
    settings: NotificationSettings | null,
    updateServer: (serverId: number, patch: ScopedSettingPatch) => Promise<NotificationSettings>,
    updateChannel: (channelId: number, patch: ScopedSettingPatch) => Promise<NotificationSettings>,
) {
    const [menu, setMenu] = useState<ContextMenuState>(null);

    const closeMenu = useCallback(() => setMenu(null), []);

    const openServerMenu = useCallback(
        (e: React.MouseEvent, serverId: number) => {
            e.preventDefault();
            const override = settings?.servers.find((s) => s.server_id === serverId);
            const items = buildLevelItems(override, (patch) => void updateServer(serverId, patch));
            setMenu({ x: e.clientX, y: e.clientY, items });
        },
        [settings, updateServer],
    );

    const openChannelMenu = useCallback(
        (e: React.MouseEvent, channelId: number) => {
            e.preventDefault();
            const override = settings?.channels.find((c) => c.channel_id === channelId);
            const items = buildLevelItems(override, (patch) => void updateChannel(channelId, patch));
            setMenu({ x: e.clientX, y: e.clientY, items });
        },
        [settings, updateChannel],
    );

    return { menu, closeMenu, openServerMenu, openChannelMenu };
}
