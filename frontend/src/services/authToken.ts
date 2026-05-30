const JWT_SEGMENTS = 3;
const USER_PROFILE_KEY = "current_user";

export interface CurrentUserProfile {
  first_name?: string;
  last_name?: string;
  nickname?: string;
  email?: string;
}

export function isJwtLike(token: string): boolean {
  return token.split(".").length === JWT_SEGMENTS;
}

function normalizeToken(raw: string): string {
  let normalized = raw.trim();

  if (normalized.toLowerCase().startsWith("bearer ")) {
    normalized = normalized.slice(7).trim();
  }

  // Some deployments accidentally wrap token in quotes.
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

function decodeJwtPayloadObject(token: string): Record<string, unknown> | null {
  if (!isJwtLike(token)) {
    return null;
  }

  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = window.atob(padded);
    const parsed = JSON.parse(decoded);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function clearAuthStorage(): void {
  localStorage.removeItem("token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem(USER_PROFILE_KEY);
}

export function getValidAccessToken(): string | null {
  const token = localStorage.getItem("token");
  if (!token) {
    return null;
  }

  const normalized = normalizeToken(token);
  if (!normalized || !isJwtLike(normalized)) {
    clearAuthStorage();
    return null;
  }

  const payload = decodeJwtPayloadObject(normalized);
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  if (exp !== null) {
    const now = Math.floor(Date.now() / 1000);
    if (exp <= now) {
      clearAuthStorage();
      return null;
    }
  }

  if (normalized !== token) {
    localStorage.setItem("token", normalized);
  }

  return normalized;
}

function parseStoredProfile(raw: string | null): CurrentUserProfile | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CurrentUserProfile;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const profile: CurrentUserProfile = {
      first_name: typeof parsed.first_name === "string" ? parsed.first_name : undefined,
      last_name: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
      nickname: typeof parsed.nickname === "string" ? parsed.nickname : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };

    if (!profile.first_name && !profile.last_name && !profile.nickname && !profile.email) {
      return null;
    }

    return profile;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): CurrentUserProfile | null {
  const parsed = decodeJwtPayloadObject(token) as CurrentUserProfile | null;
  if (!parsed) {
    return null;
  }

  const profile: CurrentUserProfile = {
    first_name: typeof parsed.first_name === "string" ? parsed.first_name : undefined,
    last_name: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
    nickname: typeof parsed.nickname === "string" ? parsed.nickname : undefined,
    email: typeof parsed.email === "string" ? parsed.email : undefined,
  };

  if (!profile.first_name && !profile.last_name && !profile.nickname && !profile.email) {
    return null;
  }

  return profile;
}

export function getCurrentUserProfile(): CurrentUserProfile | null {
  const fromStorage = parseStoredProfile(localStorage.getItem(USER_PROFILE_KEY));
  if (fromStorage) {
    return fromStorage;
  }

  const token = getValidAccessToken();
  if (!token) {
    return null;
  }

  const fromToken = decodeJwtPayload(token);
  if (fromToken) {
    localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(fromToken));
  }

  return fromToken;
}

export function getCurrentUserId(): number | null {
  const token = getValidAccessToken();
  if (!token) {
    return null;
  }

  const parsed = decodeJwtPayloadObject(token) as { user_id?: unknown } | null;
  if (!parsed) {
    return null;
  }

  if (typeof parsed.user_id === "number") {
    return parsed.user_id;
  }

  if (typeof parsed.user_id === "string") {
    const asNumber = Number(parsed.user_id);
    return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : null;
  }

  return null;
}
