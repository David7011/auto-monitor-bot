import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, SESSION_TTL_SECONDS, signDashboardSession } from "@/lib/dashboard-auth";
import { getBackendProxyConfig } from "@/lib/server-api";

export const dynamic = "force-dynamic";

type LoginResponse = {
  ok: boolean;
  user?: {
    username: string;
    authVersion: number;
  };
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const body = await request.json().catch(() => null);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Invalid username or password", code: "INVALID_CREDENTIALS" }, { status: 401 });
  }

  const config = getBackendProxyConfig(requestId);
  if (config.ok) {
    try {
      const response = await fetch(`${config.internalApiUrl}/dashboard-auth/login`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.localApiToken}`,
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({
          username: body.username,
          password: body.password,
          clientId: clientFingerprint(request),
        }),
        cache: "no-store",
      });

      if (response.ok) {
        const result = (await response.json()) as LoginResponse;
        const username = result.user?.username;
        const authVersion = result.user?.authVersion;
        if (result.ok && username && authVersion) return await issueSession(request, username, authVersion);
      }
      if (response.status === 429 || response.status >= 500) {
        const errorBody = await response.json().catch(() => ({
          error: response.status === 429 ? "Too many login attempts" : "Authentication service is unavailable",
          code: response.status === 429 ? "LOGIN_RATE_LIMITED" : "AUTH_SERVICE_UNAVAILABLE",
        }));
        const nextResponse = NextResponse.json(errorBody, { status: response.status });
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) nextResponse.headers.set("retry-after", retryAfter);
        return nextResponse;
      }
    } catch {
      return NextResponse.json({ error: "Authentication service is unavailable", code: "AUTH_SERVICE_UNAVAILABLE" }, { status: 503 });
    }
  }

  if (!config.ok) return NextResponse.json(config.body, { status: config.status });

  return NextResponse.json({ error: "Invalid username or password", code: "INVALID_CREDENTIALS" }, { status: 401 });
}

function clientFingerprint(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  const realIp = request.headers.get("x-real-ip")?.trim() ?? "direct";
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? "unknown";
  return createHash("sha256").update(`${forwarded}|${realIp}|${userAgent}`).digest("hex");
}

async function issueSession(request: NextRequest, username: string, authVersion: number): Promise<NextResponse> {
  const session = await signDashboardSession(username, authVersion);
  const nextResponse = NextResponse.json({ ok: true, user: { username } });
  nextResponse.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: session,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return nextResponse;
}
