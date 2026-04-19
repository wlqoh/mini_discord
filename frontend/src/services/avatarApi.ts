import API from "../api";
import { extractApiError } from "./apiError.ts";

type AvatarUrlResponse = {
    url: string;
};

function looksLikeAvatarKey(value: string): boolean {
    // Avatar keys are currently UUID-like values without file extension.
    return /^[a-z0-9-]{16,}$/i.test(value);
}

function ensureAvatarPath(url: string): string {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(url, window.location.origin);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length === 0 || segments.includes("avatars")) {
            return parsed.toString();
        }

        const lastSegment = segments[segments.length - 1];
        if (!looksLikeAvatarKey(lastSegment)) {
            return parsed.toString();
        }

        segments.splice(segments.length - 1, 0, "avatars");
        parsed.pathname = `/${segments.join("/")}`;
        return parsed.toString();
    } catch {
        return url;
    }
}

function withCacheBuster(url: string, version?: string): string {
    if (!url) {
        return url;
    }

    try {
        const parsed = new URL(normalizeAvatarUrl(url));
        if (version) {
            parsed.searchParams.set("v", version);
        }
        return parsed.toString();
    } catch {
        return normalizeAvatarUrl(url);
    }
}

function normalizeAvatarUrl(url: string): string {
    if (!url) {
        return url;
    }

    if (/^https?:\/\//i.test(url)) {
        return ensureAvatarPath(url);
    }

    const baseFromApi = API.defaults.baseURL;
    if (typeof baseFromApi === "string" && baseFromApi.length > 0) {
        try {
            return ensureAvatarPath(new URL(url, baseFromApi).toString());
        } catch {
            // fallback below
        }
    }

    return ensureAvatarPath(new URL(url, window.location.origin).toString());
}

export async function getMyAvatarUrl(): Promise<string | null> {
    try {
        const { data } = await API.get<AvatarUrlResponse>("/getAvatar");
        return data.url ? normalizeAvatarUrl(data.url) : null;
    } catch {
        return null;
    }
}

export async function uploadMyAvatar(file: File): Promise<string> {
    const form = new FormData();
    form.append("avatar", file, file.name);

    try {
        const { data } = await API.postForm<AvatarUrlResponse>("/setAvatar", form);

        // Backend exposes canonical avatar URL via GET /getAvatar.
        const version = String(Date.now());
        const canonicalUrl = await getMyAvatarUrl();
        if (canonicalUrl) {
            return withCacheBuster(canonicalUrl, version);
        }

        if (!data.url) {
            throw new Error("Avatar URL is missing");
        }

        return withCacheBuster(data.url, version);
    } catch (err) {
        throw new Error(extractApiError(err, "Failed to upload avatar"));
    }
}