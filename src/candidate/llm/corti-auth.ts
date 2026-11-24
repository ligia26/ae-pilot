/**
 * Keeps CORTI_API_KEY valid for lib/corti.ts (which sends it as a Bearer token).
 *
 * Corti access tokens are short-lived (~5 min). Supported setups, in priority order:
 *   1. CORTI_TOKEN_CMD     a shell command that prints a fresh token (e.g. your curl); re-run before expiry
 *   2. CORTI_CLIENT_ID/SECRET (+ TENANT_NAME, ENVIRONMENT)  OAuth2 client-credentials exchange, auto-refreshed
 *   3. CORTI_API_KEY        used as-is (fine for long-lived keys; a pasted short-lived token will expire)
 * On a 401/403 the caller can force a refresh and retry once (see assistant.ts).
 */
import { execSync } from "node:child_process";

let cached: { token: string; expiresAt: number } | null = null;
const STATIC_KEY = process.env.CORTI_API_KEY;

export function hasClientCredentials(): boolean {
  return !!(process.env.CORTI_CLIENT_ID && process.env.CORTI_CLIENT_SECRET);
}

export function canRefresh(): boolean {
  return !!process.env.CORTI_TOKEN_CMD || (!STATIC_KEY && hasClientCredentials());
}

/** Expiry from a JWT's `exp` claim, if the token is a JWT. */
function jwtExpiry(token: string): number | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchToken(): Promise<{ token: string; expiresAt: number }> {
  const cmd = process.env.CORTI_TOKEN_CMD;
  if (cmd) {
    const token = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).trim();
    if (!token || /\s/.test(token)) throw new Error("CORTI_TOKEN_CMD did not print a single token");
    return { token, expiresAt: jwtExpiry(token) ?? Date.now() + 4 * 60_000 };
  }
  const env = process.env.CORTI_ENVIRONMENT ?? "eu";
  const tenant = process.env.CORTI_TENANT_NAME ?? "base";
  const res = await fetch(`https://auth.${env}.corti.app/realms/${tenant}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "openid",
      client_id: process.env.CORTI_CLIENT_ID!,
      client_secret: process.env.CORTI_CLIENT_SECRET!,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Corti auth failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { access_token: string; expires_in?: number };
  return { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
}

export async function ensureCortiToken(force = false): Promise<void> {
  if (!canRefresh()) return; // static key mode
  if (!force && cached && Date.now() < cached.expiresAt - 30_000) return;
  cached = await fetchToken();
  process.env.CORTI_API_KEY = cached.token;
  if (!process.env.CORTI_BASE_URL) process.env.CORTI_BASE_URL = `https://ai.${process.env.CORTI_ENVIRONMENT ?? "eu"}.corti.app/v1`;
}

/** Human-readable note for start-up, e.g. warn when a pasted token is about to expire. */
export function authNote(): string {
  if (process.env.CORTI_TOKEN_CMD) return "token refreshed automatically via CORTI_TOKEN_CMD";
  if (canRefresh()) return "token refreshed automatically via client credentials";
  const exp = STATIC_KEY ? jwtExpiry(STATIC_KEY) : null;
  if (!exp) return "using CORTI_API_KEY";
  const mins = Math.round((exp - Date.now()) / 60_000);
  return mins > 0 ? `using CORTI_API_KEY — it expires in ~${mins} min; set CORTI_TOKEN_CMD to auto-refresh` : "CORTI_API_KEY has EXPIRED — regenerate it or set CORTI_TOKEN_CMD";
}
