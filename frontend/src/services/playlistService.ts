import type { LoopMode, Track } from "../types/media";

const FAVORITES_KEY = "mediaPlayer:favorites";
const HISTORY_KEY = "mediaPlayer:history";
const MAX_HISTORY = 50;

/** Fisher-Yates shuffle. Returns a new array; does not mutate the input. */
export function shuffleTracks<T>(items: T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export function addTrack(queue: Track[], track: Track): Track[] {
    if (queue.some((t) => t.id === track.id)) return queue;
    return [...queue, track];
}

export function removeTrack(queue: Track[], trackId: Track["id"]): Track[] {
    return queue.filter((t) => t.id !== trackId);
}

export function reorderTracks(queue: Track[], fromIndex: number, toIndex: number): Track[] {
    if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= queue.length ||
        toIndex >= queue.length
    ) {
        return queue;
    }
    const result = queue.slice();
    const [moved] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, moved);
    return result;
}

/** Resolves the queue index to advance to, honoring loop mode and an optional shuffle order. Returns null when playback should stop. */
export function getNextIndex(
    queueLength: number,
    currentIndex: number,
    loopMode: LoopMode,
    order?: number[],
): number | null {
    if (queueLength === 0) return null;
    const activeOrder = order && order.length === queueLength ? order : queueLength <= 0 ? [] : Array.from({ length: queueLength }, (_, i) => i);
    const pos = activeOrder.indexOf(currentIndex);
    const nextPos = pos + 1;
    if (nextPos < activeOrder.length) return activeOrder[nextPos];
    if (loopMode === "all") return activeOrder[0];
    return null;
}

export function getPreviousIndex(
    queueLength: number,
    currentIndex: number,
    loopMode: LoopMode,
    order?: number[],
): number | null {
    if (queueLength === 0) return null;
    const activeOrder = order && order.length === queueLength ? order : Array.from({ length: queueLength }, (_, i) => i);
    const pos = activeOrder.indexOf(currentIndex);
    const prevPos = pos - 1;
    if (prevPos >= 0) return activeOrder[prevPos];
    if (loopMode === "all") return activeOrder[activeOrder.length - 1];
    return null;
}

function readTracks(key: string): Track[] {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as Track[]) : [];
    } catch {
        return [];
    }
}

function writeTracks(key: string, tracks: Track[]): void {
    try {
        window.localStorage.setItem(key, JSON.stringify(tracks));
    } catch {
        /* ignore (private browsing / quota) */
    }
}

export function getFavorites(): Track[] {
    return readTracks(FAVORITES_KEY);
}

export function isFavorite(trackId: Track["id"]): boolean {
    return getFavorites().some((t) => t.id === trackId);
}

export function toggleFavorite(track: Track): Track[] {
    const favorites = getFavorites();
    const next = favorites.some((t) => t.id === track.id)
        ? favorites.filter((t) => t.id !== track.id)
        : [...favorites, track];
    writeTracks(FAVORITES_KEY, next);
    return next;
}

export function getHistory(): Track[] {
    return readTracks(HISTORY_KEY);
}

export function addToHistory(track: Track): void {
    const history = readTracks(HISTORY_KEY).filter((t) => t.id !== track.id);
    history.unshift(track);
    writeTracks(HISTORY_KEY, history.slice(0, MAX_HISTORY));
}

export function clearHistory(): void {
    writeTracks(HISTORY_KEY, []);
}
