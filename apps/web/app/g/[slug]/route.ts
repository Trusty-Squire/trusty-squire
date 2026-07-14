// G15: short-URL redirect endpoint.
//
// The headless install CLI shortens its cloudflared noVNC tunnel URL
// to `trustysquire.ai/g/<slug>` via the API's `POST /v1/short` —
// this route is what users actually open in their browser. It looks
// the slug up via the API and 302-redirects to the long URL with
// its fragment intact (the fragment carries the VNC password, which
// the browser preserves across the Location header).
//
// Three-line happy path; failure modes (404 / API error) get a plain
// HTML stub explaining what happened.

import { NextResponse } from "next/server";

const ROBOTS_HEADER = "noindex, nofollow";

const API_BASE =
  process.env.API_PROXY_TARGET ??
  (process.env.NODE_ENV === "production"
    ? "https://trusty-squire-api.fly.dev"
    : "http://localhost:3000");

// Next 15 wraps dynamic-route params in a Promise.
export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;

  let lookup: Response;
  try {
    lookup = await fetch(`${API_BASE}/v1/short/${encodeURIComponent(slug)}`, {
      // Don't let Next.js cache this — every redirect must resolve
      // against the live store (slugs expire after 15 min).
      cache: "no-store",
    });
  } catch {
    return htmlError(
      502,
      "Couldn't reach the link shortener. Try again in a few seconds, or use the original cloudflared URL printed by your terminal.",
    );
  }

  if (lookup.status === 404) {
    return htmlError(
      404,
      "This link doesn't exist or has expired (links last 15 minutes). " +
        "Re-run install on your terminal to get a fresh link.",
    );
  }
  if (!lookup.ok) {
    return htmlError(
      502,
      "The link shortener returned an unexpected error. Try the original cloudflared URL printed by your terminal.",
    );
  }

  const body = (await lookup.json()) as { url?: unknown };
  if (typeof body.url !== "string") {
    return htmlError(502, "The shortener returned a malformed response.");
  }
  // NextResponse.redirect serializes the URL into the Location header
  // verbatim — fragments are preserved (browsers honor them per
  // long-standing convention, even though HTTP/1.1 didn't formally
  // permit fragments in Location until RFC 7231).
  const response = NextResponse.redirect(body.url, 302);
  response.headers.set("X-Robots-Tag", ROBOTS_HEADER);
  return response;
}

// Minimal styled error page. Plain HTML rather than a React Server
// Component because the route is a pure Edge-able resolver — no
// reason to drag a tree into the redirect path's failure case.
function htmlError(status: number, message: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trusty Squire — link error</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0f1115; color: #e6e8ec;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    body { display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 480px; padding: 28px 32px; background: #171a21;
      border: 1px solid #272b35; border-radius: 12px; line-height: 1.45; }
    h1 { margin: 0 0 12px; font-size: 18px; color: #fff; }
    p { margin: 0; color: #9aa0ab; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${status === 404 ? "Link not found" : "Couldn't load this link"}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "X-Robots-Tag": ROBOTS_HEADER,
    },
  });
}
