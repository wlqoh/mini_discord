import type { SoundName } from "../../types/notifications.ts";

// Placeholder tones generated locally (public/sounds/message.mp3, mention.mp3) — swap these
// files for real assets whenever they're ready, no code change needed.
const SOUND_SOURCES: Record<SoundName, string> = {
    message: "/sounds/message.mp3",
    mention: "/sounds/mention.mp3",
    join: "/sounds/joinvoice.mp3",
    leave: "/sounds/leavevoice.mp3",
};

const POOL_SIZE = 3;
const CHANNEL_RATE_LIMIT_MS = 3000;
const GLOBAL_RATE_LIMIT_MS = 1000;

const VOLUME_KEY = "notif.volume";
const ENABLED_KEY = "notif.soundEnabled";
const DEFAULT_VOLUME = 0.6;

const pools = new Map<SoundName, HTMLAudioElement[]>();
let unlocked = false;

function getPool(name: SoundName): HTMLAudioElement[] {
    let pool = pools.get(name);
    if (!pool) {
        pool = Array.from({ length: POOL_SIZE }, () => {
            const el = new Audio(SOUND_SOURCES[name]);
            el.preload = "auto";
            el.volume = getVolume();
            return el;
        });
        pools.set(name, pool);
    }
    return pool;
}

function allPools(): HTMLAudioElement[] {
    (Object.keys(SOUND_SOURCES) as SoundName[]).forEach(getPool);
    return Array.from(pools.values()).flat();
}

export function getVolume(): number {
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        const parsed = raw !== null ? Number(raw) : DEFAULT_VOLUME;
        return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_VOLUME;
    } catch {
        return DEFAULT_VOLUME;
    }
}

export function setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    try {
        localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
        // ignore storage errors (private mode, quota)
    }
    pools.forEach((pool) => pool.forEach((el) => { el.volume = clamped; }));
}

export function isSoundEnabled(): boolean {
    try {
        return localStorage.getItem(ENABLED_KEY) !== "false";
    } catch {
        return true;
    }
}

export function setSoundEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(ENABLED_KEY, String(enabled));
    } catch {
        // ignore storage errors
    }
}

export function isSoundUnlocked(): boolean {
    return unlocked;
}

/**
 * Browsers block autoplay until a user gesture. Play every pooled element at
 * volume 0 on the first pointerdown/keydown so later real playback isn't the
 * first attempt (which would silently fail on strict browsers, e.g. Safari).
 */
export function initSoundUnlock(): () => void {
    if (typeof document === "undefined") {
        return () => {};
    }

    const unlock = () => {
        if (unlocked) return;
        allPools().forEach((el) => {
            const originalVolume = el.volume;
            el.volume = 0;
            void el.play()
                .then(() => {
                    el.pause();
                    el.currentTime = 0;
                    el.volume = originalVolume;
                })
                .catch(() => {
                    el.volume = originalVolume;
                });
        });
        unlocked = true;
        document.removeEventListener("pointerdown", unlock);
        document.removeEventListener("keydown", unlock);
    };

    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);

    return () => {
        document.removeEventListener("pointerdown", unlock);
        document.removeEventListener("keydown", unlock);
    };
}

const lastPlayedByChannel = new Map<number, number>();
let lastPlayedGlobal = 0;

type PlayOptions = {
    channelId?: number;
    bypassChannelLimit?: boolean;
};

export function playSound(name: SoundName, opts: PlayOptions = {}): void {
    if (!isSoundEnabled()) return;

    const now = Date.now();
    if (now - lastPlayedGlobal < GLOBAL_RATE_LIMIT_MS) return;

    if (opts.channelId !== undefined && !opts.bypassChannelLimit) {
        const lastForChannel = lastPlayedByChannel.get(opts.channelId) ?? 0;
        if (now - lastForChannel < CHANNEL_RATE_LIMIT_MS) return;
    }

    const pool = getPool(name);
    const el = pool.find((candidate) => candidate.paused || candidate.ended) ?? pool[0];
    el.currentTime = 0;
    el.volume = getVolume();
    void el.play().catch(() => {});

    lastPlayedGlobal = now;
    if (opts.channelId !== undefined) {
        lastPlayedByChannel.set(opts.channelId, now);
    }
}
