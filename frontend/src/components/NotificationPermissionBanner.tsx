import { Bell, X } from "lucide-react";

type Props = {
    onEnable: () => void;
    onDismiss: () => void;
};

/**
 * Soft pre-prompt: appears only after a genuinely missed message (see
 * useNotifications' onMissedPermission), never on first load. The real
 * browser permission prompt only fires from the "Enable" click here —
 * asking cold, unprompted, tends to get reflex-denied and burns the one
 * chance a site gets to ask (NOTIFICATIONS_PLAN.md §2 decision 11).
 */
export default function NotificationPermissionBanner({ onEnable, onDismiss }: Props) {
    return (
        <div className="notification-permission-banner" role="status">
            <Bell size={16} aria-hidden="true" />
            <span className="notification-permission-banner-text">
                Turn on notifications so you don't miss new messages while you're away.
            </span>
            <div className="notification-permission-banner-actions">
                <button className="modal-btn modal-btn-primary" type="button" onClick={onEnable}>
                    Enable
                </button>
                <button className="modal-btn modal-btn-secondary" type="button" onClick={onDismiss}>
                    Not now
                </button>
            </div>
            <button className="notification-permission-banner-close" type="button" onClick={onDismiss} aria-label="Dismiss">
                <X size={14} aria-hidden="true" />
            </button>
        </div>
    );
}
