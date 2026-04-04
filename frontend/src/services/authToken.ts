const JWT_SEGMENTS = 3;

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

