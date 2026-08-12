// Multiple open tabs would otherwise each play the notification sound for the
// same message. Only the elected "leader" tab plays sound; every tab still
// shows its own badge/title since those are per-tab DOM state anyway.
const CHANNEL_NAME = "mini-discord-notif-leader";
const HEARTBEAT_MS = 4000;
const LEADER_TIMEOUT_MS = 9000;

type LeaderMessage =
    | { type: "heartbeat"; id: string }
    | { type: "leaving"; id: string };

let isLeaderFlag = true; // no BroadcastChannel support -> always act as leader
let myId = "";
let leaderId: string | null = null;
let channel: BroadcastChannel | null = null;
let heartbeatTimer: number | undefined;
let watchdogTimer: number | undefined;

function randomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function broadcast(msg: LeaderMessage): void {
    channel?.postMessage(msg);
}

function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
    }
}

function becomeLeader(): void {
    isLeaderFlag = true;
    leaderId = myId;
    broadcast({ type: "heartbeat", id: myId });
    if (heartbeatTimer === undefined) {
        heartbeatTimer = window.setInterval(() => broadcast({ type: "heartbeat", id: myId }), HEARTBEAT_MS);
    }
}

function resetWatchdog(): void {
    if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
    watchdogTimer = window.setTimeout(becomeLeader, LEADER_TIMEOUT_MS);
}

export function initLeaderElection(): () => void {
    if (typeof BroadcastChannel === "undefined") {
        isLeaderFlag = true;
        return () => {};
    }

    myId = randomId();
    isLeaderFlag = false;
    channel = new BroadcastChannel(CHANNEL_NAME);

    channel.onmessage = (event: MessageEvent<LeaderMessage>) => {
        const msg = event.data;
        if (msg.type === "heartbeat") {
            leaderId = msg.id;
            if (isLeaderFlag && msg.id !== myId && msg.id < myId) {
                // Two tabs both claimed leadership on startup — the one with the
                // lexicographically smaller id wins, the other steps down.
                isLeaderFlag = false;
                stopHeartbeat();
            }
            resetWatchdog();
        } else if (msg.type === "leaving" && msg.id === leaderId) {
            window.clearTimeout(watchdogTimer);
            becomeLeader();
        }
    };

    resetWatchdog();
    // Give an existing leader a moment to announce itself before claiming the role.
    window.setTimeout(() => {
        if (!leaderId) becomeLeader();
    }, 300);

    const onUnload = () => {
        if (isLeaderFlag) broadcast({ type: "leaving", id: myId });
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
        window.removeEventListener("beforeunload", onUnload);
        stopHeartbeat();
        if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
        channel?.close();
        channel = null;
    };
}

export function isLeader(): boolean {
    return isLeaderFlag;
}
