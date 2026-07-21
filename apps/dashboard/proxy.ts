import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifyDashboardSession } from "@/lib/dashboard-auth";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) {
    if (pathname === "/login") {
      const session = await verifyDashboardSession(request.cookies.get(AUTH_COOKIE_NAME)?.value);
      if (session.ok && await sessionIsActive(session.username, session.authVersion)) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }
    return NextResponse.next();
  }

  const session = await verifyDashboardSession(request.cookies.get(AUTH_COOKIE_NAME)?.value);
  if (session.ok && await sessionIsActive(session.username, session.authVersion)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Нужен вход в dashboard", code: "DASHBOARD_AUTH_REQUIRED" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

async function sessionIsActive(username: string, authVersion: number): Promise<boolean> {
  const localApiToken = (process.env.LOCAL_API_TOKEN ?? "").trim();
  const internalApiUrl = (process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/u, "");
  if (!localApiToken) return false;
  try {
    const response = await fetch(`${internalApiUrl}/dashboard-auth/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ username, authVersion }),
      cache: "no-store",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const result = await response.json() as { ok?: boolean };
    return result.ok === true;
  } catch {
    return false;
  }
}
