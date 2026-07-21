export const AUTH_COOKIE_NAME = "amb_dashboard_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type SessionPayload = {
  sub: string;
  ver: number;
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signDashboardSession(
  username: string,
  authVersion: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const secret = dashboardAuthSecret();
  if (!secret) throw new Error("DASHBOARD_AUTH_SECRET is not configured");

  const payload: SessionPayload = {
    sub: username,
    ver: authVersion,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
  };
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifyDashboardSession(
  token: string | undefined | null,
): Promise<{ ok: true; username: string; authVersion: number } | { ok: false }> {
  const secret = dashboardAuthSecret();
  if (!secret || !token) return { ok: false };

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return { ok: false };

  const expectedSignature = await hmacSha256(encodedPayload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) return { ok: false };

  try {
    const payload = JSON.parse(base64UrlDecodeToString(encodedPayload)) as Partial<SessionPayload>;
    if (!payload.sub || typeof payload.sub !== "string") return { ok: false };
    if (!payload.ver || typeof payload.ver !== "number" || !Number.isInteger(payload.ver)) return { ok: false };
    if (!payload.exp || typeof payload.exp !== "number") return { ok: false };
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { ok: false };
    return { ok: true, username: payload.sub, authVersion: payload.ver };
  } catch {
    return { ok: false };
  }
}

function dashboardAuthSecret(): string {
  return (process.env.DASHBOARD_AUTH_SECRET || process.env.LOCAL_API_TOKEN || "").trim();
}

async function hmacSha256(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecodeToString(value: string): string {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return decoder.decode(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
