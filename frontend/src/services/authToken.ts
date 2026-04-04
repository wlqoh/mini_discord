const JWT_SEGMENTS = 3;

export function isJwtLike(token: string): boolean {
  return token.split(".").length === JWT_SEGMENTS;
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

  const normalized = token.trim();
  if (!normalized || !isJwtLike(normalized)) {
    clearAuthStorage();
    return null;
  }

  return normalized;
}

