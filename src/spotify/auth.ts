const STORAGE_VERIFIER = "lovify_pkce_verifier";
const STORAGE_TOKEN = "lovify_access_token";
const STORAGE_EXPIRY = "lovify_token_expiry";
const STORAGE_REFRESH = "lovify_refresh_token";
const STORAGE_CLIENT_ID = "lovify_client_id";

export function getRedirectUri(): string {
  const fromEnv = import.meta.env.VITE_SPOTIFY_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${window.location.origin}/callback`;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

export async function beginLogin(clientId: string): Promise<void> {
  const verifier = randomVerifier();
  sessionStorage.setItem(STORAGE_VERIFIER, verifier);
  const challenge = await sha256base64url(verifier);
  const redirect = getRedirectUri();
  const scopes = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-top-read",
    "user-library-read",
    "user-library-modify",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-public",
    "playlist-modify-private",
  ].join(" ");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: scopes,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const verifier = sessionStorage.getItem(STORAGE_VERIFIER);
  if (!verifier) throw new Error("Missing PKCE verifier — try signing in again.");
  sessionStorage.removeItem(STORAGE_VERIFIER);
  const redirect = getRedirectUri();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>;
}

export function saveSession(t: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}, clientId?: string): void {
  localStorage.setItem(STORAGE_TOKEN, t.access_token);
  localStorage.setItem(STORAGE_EXPIRY, String(Date.now() + t.expires_in * 1000));
  if (t.refresh_token) localStorage.setItem(STORAGE_REFRESH, t.refresh_token);
  if (clientId) localStorage.setItem(STORAGE_CLIENT_ID, clientId);
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_TOKEN);
  localStorage.removeItem(STORAGE_EXPIRY);
  localStorage.removeItem(STORAGE_REFRESH);
  localStorage.removeItem(STORAGE_CLIENT_ID);
}

export async function refreshAccessToken(clientId: string): Promise<string | null> {
  const refresh = localStorage.getItem(STORAGE_REFRESH);
  if (!refresh) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  saveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refresh,
    expires_in: data.expires_in,
  });
  return data.access_token;
}

export async function getValidAccessToken(clientId: string): Promise<string | null> {
  // Invalidate tokens from a different Spotify app (e.g. after app recreation)
  const storedClientId = localStorage.getItem(STORAGE_CLIENT_ID);
  if (storedClientId && storedClientId !== clientId) {
    console.warn("Client ID changed — clearing stale session");
    clearSession();
    return null;
  }
  const token = localStorage.getItem(STORAGE_TOKEN);
  const exp = localStorage.getItem(STORAGE_EXPIRY);
  if (!token || !exp) return null;
  if (Date.now() < Number(exp) - 30_000) return token;
  return refreshAccessToken(clientId);
}
