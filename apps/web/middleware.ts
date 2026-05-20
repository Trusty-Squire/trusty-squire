import { NextResponse, type NextRequest } from "next/server";

// Signed-in visitors skip the marketing landing and go straight to
// their vault — the vault is the default view once you have a session.
// A presence check on the ts_session cookie is enough here: if the
// cookie is stale, /vault's own data fetch surfaces the expired
// session. Doing this in middleware (not a client-side fetch probe)
// means the redirect happens before any HTML ships — no landing flash,
// no dependency on a probe request succeeding.
export function middleware(request: NextRequest) {
  const session = request.cookies.get("ts_session");
  if (session !== undefined && session.value.length > 0) {
    return NextResponse.redirect(new URL("/vault", request.url));
  }
  return NextResponse.next();
}

// Only guard the marketing landing.
export const config = { matcher: "/" };
