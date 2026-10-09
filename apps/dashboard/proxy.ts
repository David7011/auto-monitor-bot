import { NextResponse } from "next/server";

// Dashboard login removed: access from the local machine / trusted network is
// allowed without a browser session. The backend API remains guarded by
// LOCAL_API_TOKEN and the dashboard BFF (app/api/backend) injects it
// server-side, so all dashboard actions keep working without a login page.
export function proxy(): NextResponse {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
