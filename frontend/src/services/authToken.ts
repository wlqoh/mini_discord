const JWT_SEGMENTS = 3;
const USER_PROFILE_KEY = "current_user";

export interface CurrentUserProfile {
  first_name?: string;
  last_name?: string;
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
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };

    if (!profile.first_name && !profile.last_name && !profile.email) {
      return null;
    }

    return profile;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): CurrentUserProfile | null {
  if (!isJwtLike(token)) {
    return null;
  }

  const segments = token.split(".");
  const payload = segments[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = window.atob(padded);
    const parsed = JSON.parse(decoded) as CurrentUserProfile;

    const profile: CurrentUserProfile = {
      first_name: typeof parsed.first_name === "string" ? parsed.first_name : undefined,
      last_name: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };

    if (!profile.first_name && !profile.last_name && !profile.email) {
      return null;
    }

    return profile;
  } catch {
    return null;
  }
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

