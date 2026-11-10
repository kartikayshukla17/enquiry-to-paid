/**
 * The decision behind the `/app/*` session gate, pulled out of src/middleware.ts so it can be
 * unit-tested directly (Next middleware itself is awkward to exercise in isolation).
 */

/** Everything under /app requires a session. Nothing else does. */
export function isProtectedPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** Given the request path and whether a session was found, should the visitor be sent to /login? */
export function shouldRedirectToLogin(pathname: string, hasSession: boolean): boolean {
  return isProtectedPath(pathname) && !hasSession;
}
