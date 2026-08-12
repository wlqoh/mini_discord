import { useState } from "react";
import { Bell, BellOff, Volume2, VolumeX } from "lucide-react";
import type { ChannelsByServer, Server } from "../types/chat.ts";
import type { NotificationLevel, NotificationSettings } from "../types/notifications.ts";
import type { GlobalSettingsPatch, ScopedSettingPatch } from "../services/notificationsApi.ts";
import {
    getVolume,
    setVolume as setSoundVolume,
    isSoundEnabled,
    setSoundEnabled as setSoundEnabledStorage,
    sendTestNotification,
    type PermissionState,
} from "../services/notifications";

type Props = {
    onClose: () => void;
    settings: NotificationSettings | null;
    isLoading: boolean;
    error: string;
    updateGlobal: (patch: GlobalSettingsPatch) => Promise<NotificationSettings>;
    updateServer: (serverId: number, patch: ScopedSettingPatch) => Promise<NotificationSettings>;
    updateChannel: (channelId: number, patch: ScopedSettingPatch) => Promise<NotificationSettings>;
    servers: Server[];
    channelsByServer: ChannelsByServer;
    permission: PermissionState;
    onRequestPermission: () => void;
};

const LEVEL_OPTIONS: Array<{ value: NotificationLevel; label: string }> = [
    { value: "all", label: "All messages" },
    { value: "mentions", label: "Only mentions" },
    { value: "none", label: "Nothing" },
];

function formatDND(iso: string | null): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
    return date.toLocaleString();
}

function hoursFromNow(hours: number): string {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function tomorrowNineAM(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
}

function findServerName(servers: Server[], serverId: number): string {
    return servers.find((s) => s.id === serverId)?.name ?? `Server #${serverId}`;
}

function findChannelName(channelsByServer: ChannelsByServer, channelId: number): string {
    for (const list of Object.values(channelsByServer)) {
        const found = list.find((c) => c.id === channelId);
        if (found) return `#${found.name}`;
    }
    return `Channel #${channelId}`;
}

export default function NotificationSettingsModal({
    onClose,
    settings,
    isLoading,
    error,
    updateGlobal,
    updateServer,
    updateChannel,
    servers,
    channelsByServer,
    permission,
    onRequestPermission,
}: Props) {
    const [volume, setVolumeState] = useState(() => Math.round(getVolume() * 100));
    const [soundEnabled, setSoundEnabledState] = useState(() => isSoundEnabled());
    const [testStatus, setTestStatus] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    async function handleGlobalChange(patch: GlobalSettingsPatch) {
        setIsSaving(true);
        try {
            await updateGlobal(patch);
        } catch {
            // error surfaced via `error` prop
        } finally {
            setIsSaving(false);
        }
    }

    async function handleTestNotification() {
        setTestStatus(null);
        const result = await sendTestNotification();
        setTestStatus(result.shown ? "Notification sent." : result.reason ?? "Could not show a test notification.");
    }

    const dndLabel = formatDND(settings?.dnd_until ?? null);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card notification-settings-modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="modal-title">Notifications</h3>

                {error ? <div className="profile-avatar-error">{error}</div> : null}

                <div className="notification-settings-section">
                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Browser permission</span>
                        {permission === "granted" ? (
                            <span className="profile-modal-value"><Bell size={16} aria-hidden="true" /> Enabled</span>
                        ) : permission === "denied" ? (
                            <span className="profile-modal-value" title="Blocked in browser site settings">
                                <BellOff size={16} aria-hidden="true" /> Blocked — enable it in site settings
                            </span>
                        ) : permission === "unsupported" ? (
                            <span className="profile-modal-value"><BellOff size={16} aria-hidden="true" /> Not supported</span>
                        ) : (
                            <button className="modal-btn modal-btn-secondary" type="button" onClick={onRequestPermission}>
                                Enable
                            </button>
                        )}
                    </div>
                </div>

                <div className="notification-settings-section">
                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Default level</span>
                        <select
                            className="modal-input"
                            value={settings?.default_level ?? "all"}
                            disabled={isLoading || isSaving}
                            onChange={(e) => void handleGlobalChange({ default_level: e.target.value as NotificationLevel })}
                        >
                            {LEVEL_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>

                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Show message text in notifications</span>
                        <label className="notification-settings-toggle">
                            <input
                                type="checkbox"
                                checked={!(settings?.hide_message_preview ?? false)}
                                disabled={isLoading || isSaving}
                                onChange={(e) => void handleGlobalChange({ hide_message_preview: !e.target.checked })}
                            />
                        </label>
                    </div>
                </div>

                <div className="notification-settings-section">
                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Do Not Disturb</span>
                        <span className="profile-modal-value">{dndLabel ? `Until ${dndLabel}` : "Off"}</span>
                    </div>
                    <div className="notification-settings-dnd-actions">
                        <button className="modal-btn modal-btn-secondary" type="button" onClick={() => void handleGlobalChange({ dnd_until: hoursFromNow(1) })}>1 hour</button>
                        <button className="modal-btn modal-btn-secondary" type="button" onClick={() => void handleGlobalChange({ dnd_until: hoursFromNow(8) })}>8 hours</button>
                        <button className="modal-btn modal-btn-secondary" type="button" onClick={() => void handleGlobalChange({ dnd_until: tomorrowNineAM() })}>Until tomorrow</button>
                        {dndLabel ? (
                            <button className="modal-btn modal-btn-secondary" type="button" onClick={() => void handleGlobalChange({ dnd_until: null })}>Clear</button>
                        ) : null}
                    </div>
                </div>

                <div className="notification-settings-section">
                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Sound</span>
                        <label className="notification-settings-toggle">
                            <input
                                type="checkbox"
                                checked={soundEnabled}
                                onChange={(e) => {
                                    setSoundEnabledState(e.target.checked);
                                    setSoundEnabledStorage(e.target.checked);
                                }}
                            />
                        </label>
                    </div>
                    <div className="notification-settings-row">
                        <span className="profile-modal-label">Volume</span>
                        <div className="notification-settings-volume">
                            {volume === 0 ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={volume}
                                disabled={!soundEnabled}
                                onChange={(e) => {
                                    const next = Number(e.target.value);
                                    setVolumeState(next);
                                    setSoundVolume(next / 100);
                                }}
                            />
                        </div>
                    </div>
                    <div className="notification-settings-row">
                        <button className="modal-btn modal-btn-secondary" type="button" onClick={() => void handleTestNotification()}>
                            Test notification
                        </button>
                        {testStatus ? <span className="notification-settings-test-status">{testStatus}</span> : null}
                    </div>
                </div>

                {(settings?.servers.length || settings?.channels.length) ? (
                    <div className="notification-settings-section">
                        <span className="profile-modal-label">Custom overrides</span>
                        <ul className="notification-settings-overrides">
                            {settings.servers.map((override) => (
                                <li key={`server-${override.server_id}`} className="notification-settings-override-item">
                                    <span>{findServerName(servers, override.server_id)}</span>
                                    <span className="notification-settings-override-detail">
                                        {override.level ?? "inherit"}
                                        {override.muted_until && new Date(override.muted_until).getTime() > Date.now() ? " · muted" : ""}
                                    </span>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        type="button"
                                        onClick={() => void updateServer(override.server_id, { level: null, muted_until: null })}
                                    >
                                        Reset
                                    </button>
                                </li>
                            ))}
                            {settings.channels.map((override) => (
                                <li key={`channel-${override.channel_id}`} className="notification-settings-override-item">
                                    <span>{findChannelName(channelsByServer, override.channel_id)}</span>
                                    <span className="notification-settings-override-detail">
                                        {override.level ?? "inherit"}
                                        {override.muted_until && new Date(override.muted_until).getTime() > Date.now() ? " · muted" : ""}
                                    </span>
                                    <button
                                        className="modal-btn modal-btn-secondary"
                                        type="button"
                                        onClick={() => void updateChannel(override.channel_id, { level: null, muted_until: null })}
                                    >
                                        Reset
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                <div className="modal-actions">
                    <button className="modal-btn modal-btn-primary" type="button" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
