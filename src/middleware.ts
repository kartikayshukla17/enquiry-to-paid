import { NextResponse, type NextRequest } from "next/server";
import { shouldRedirectToLogin } from "./lib/session-gate";

// Same base URL the agent runs its Better Auth under (see next.config.ts's rewrites() comment for
// why the agent is a separate process from this Next site). Middleware runs server-side, so it
// talks to the agent directly instead of going through the browser-facing /api/auth/* rewrite.
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:4010";

async function hasSession(req: NextRequest): Promise<boolean> {
  const cookie = req.headers.get("cookie");
  if (!cookie) return false;
  try {
    const r = await fetch(`${AGENT_URL}/api/auth/get-session`, { headers: { cookie } });
    if (!r.ok) return false;
    return (await r.json()) !== null;
  } catch {
    // Agent unreachable: fail closed, same as having no session.
    return false;
  }
}

export async function middleware(req: NextRequest) {
  if (shouldRedirectToLogin(req.nextUrl.pathname, await hasSession(req))) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};
