// Hand-rolled service worker.
//
// Strategy:
//   - PRECACHE: shell HTML + brand assets. Loaded on install, kept for
//     offline + cold-load. Any byte that changes here MUST bump the
//     SHELL_CACHE version so old caches are purged on activate.
//   - RUNTIME: static asset paths (/icons/, /logo.svg, /favicon.svg,
//     /manifest.json). Served stale-while-revalidate so the user gets
//     the fastest possible response while the network refresh runs in
//     the background.
//   - PASSTHROUGH: API + auth + Next.js build chunks. Network only;
//     never cached. Caching /v1/* would create catastrophic security
//     bugs (stale session data, replayed credentials).
//
// Versioning: bumping any of the *_VERSION constants triggers an
// `update` event in clients. sw-register.ts handles the "new version
// available, reload to update" prompt.

const SHELL_VERSION = "v1.0.0";
const RUNTIME_VERSION = "v1.0.0";

const SHELL_CACHE = `squire-shell-${SHELL_VERSION}`;
const RUNTIME_CACHE = `squire-runtime-${RUNTIME_VERSION}`;

// Only the routes that render WITHOUT requiring a session. /dashboard et
// al. need a logged-in cookie, so precaching them would surface stale
// auth-gated HTML to the wrong account. Stick to public shell pages.
const SHELL_PATHS = ["/", "/manifest.json", "/logo.svg", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PATHS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or auth traffic.
  if (
    url.pathname.startsWith("/v1/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/")
  ) {
    return;
  }

  // Next.js build chunks have hashed filenames — they're immutable so
  // we could cache them, but the browser already heavy-caches them and
  // adding them to our cache risks pinning a busted version after a
  // deploy. Let the network + HTTP cache handle them.
  if (url.pathname.startsWith("/_next/")) return;

  // Stale-while-revalidate for static assets.
  if (
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/manifest.json"
  ) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Shell paths: cache-first for navigation, fall back to network.
  if (req.mode === "navigate" || SHELL_PATHS.includes(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => cached);
  return cached ?? networkPromise;
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && req.method === "GET") {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    // Last-ditch: try the runtime cache or fall back to the cached root.
    const runtime = await caches.open(RUNTIME_CACHE);
    return (await runtime.match(req)) ?? (await cache.match("/")) ?? Response.error();
  }
}

// Allow sw-register.ts to ask us to take over without a reload by
// sending {type:'SKIP_WAITING'} to the waiting worker.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
