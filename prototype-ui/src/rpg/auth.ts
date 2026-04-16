import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

const API_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8788"
    : "https://augur.carl-lewis.workers.dev";

const TOKEN_KEY = "augur-session-token";
const USER_KEY = "augur-user-id";

export function getSessionToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getUserId(): string | null {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}

function saveSession(token: string, userId: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, userId);
  } catch { /* ignore */ }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* ignore */ }
}

export function isAuthenticated(): boolean {
  return !!getSessionToken();
}

export function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function validateSession(): Promise<boolean> {
  const token = getSessionToken();
  if (!token) return false;
  try {
    const resp = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) return true;
    clearSession();
    return false;
  } catch {
    return true; // assume valid if offline
  }
}

export async function register(displayName?: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const optResp = await fetch(`${API_BASE}/api/auth/register/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: displayName || "Augur Player" }),
    });
    if (!optResp.ok) return { ok: false, error: `server: ${optResp.status}` };
    const { options, challengeToken } = (await optResp.json()) as {
      options: never;
      challengeToken: string;
    };

    const credential = await startRegistration({ optionsJSON: options });

    const verResp = await fetch(`${API_BASE}/api/auth/register/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken, credential }),
    });
    if (!verResp.ok) {
      const err = (await verResp.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error || `verify: ${verResp.status}` };
    }
    const { sessionToken, userId } = (await verResp.json()) as {
      sessionToken: string;
      userId: string;
    };
    saveSession(sessionToken, userId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function login(): Promise<{ ok: boolean; error?: string }> {
  try {
    const optResp = await fetch(`${API_BASE}/api/auth/login/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!optResp.ok) return { ok: false, error: `server: ${optResp.status}` };
    const { options, challengeToken } = (await optResp.json()) as {
      options: never;
      challengeToken: string;
    };

    const credential = await startAuthentication({ optionsJSON: options });

    const verResp = await fetch(`${API_BASE}/api/auth/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken, credential }),
    });
    if (!verResp.ok) {
      const err = (await verResp.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error || `verify: ${verResp.status}` };
    }
    const { sessionToken, userId } = (await verResp.json()) as {
      sessionToken: string;
      userId: string;
    };
    saveSession(sessionToken, userId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
