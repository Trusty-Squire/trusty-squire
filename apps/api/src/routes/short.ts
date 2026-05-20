// Tiny URL shortener for the noVNC tunnel banner (G15).
//
// The headless install rig surfaces a cloudflared tunnel URL like
// `https://shouts-clean-mediawiki-cookies.trycloudflare.com/vnc.html
//  #password=25f4cc35` (~80 chars, transcription-hostile on a phone).
// The CLI POSTs that URL here, gets back a 6-char slug, then prints
// `trustysquire.ai/g/<slug>#password=…` (~40 chars). The web app's
// /g/[slug] route resolves the slug back via GET /v1/short/:slug and
// 302s the browser to the long URL, which preserves the original
// fragment across the redirect (per HTTP semantics; browsers append
// the request-URL fragment to a redirect target that has no fragment).
//
// Auth: unauthenticated by design. The slug is random, the TTL is
// 15 minutes (matched to the install token), and the shortened URL
// is itself a one-time-VNC-tunnel address — abusing this endpoint
// only lets an attacker mint short-lived random-slug redirects to a
// URL of their choice. Bounded by the rate limit on the API.
//
// Storage: in-memory Map. Survives process lifetime only — that's
// fine because (a) the TTL is 15 min, well under any realistic
// deploy/restart window, and (b) the URL it points at is itself a
// per-install ephemeral tunnel that won't outlive the API process.

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// Excluded chars: 0/O/1/l/I (look-alike pairs make phone transcription
// error-prone). 58 chars left — log_58(916M) > 5, so 6 chars give
// ~38 billion unique slugs; collision probability over a 15-min
// window with even ~1000 short-lived links is vanishingly small.
const SLUG_CHARSET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SLUG_LEN = 6;
const TTL_MS = 15 * 60 * 1000;

interface Entry {
  url: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function generateSlug(): string {
  const bytes = randomBytes(SLUG_LEN);
  let out = "";
  for (let i = 0; i < SLUG_LEN; i++) {
    out += SLUG_CHARSET[bytes[i]! % SLUG_CHARSET.length];
  }
  return out;
}

// Lazy expiry: every read sweeps the entry it touches. Cheaper than
// a background sweeper; given <1000 entries per 15 min window this
// never accumulates meaningful garbage.
function getActive(slug: string, now: number): Entry | null {
  const entry = store.get(slug);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    store.delete(slug);
    return null;
  }
  return entry;
}

const createBody = z.object({
  // https only — refusing http to keep this from being abused as a
  // plaintext-link shortener. The cloudflared / trycloudflare URLs
  // it's meant for are all https.
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => u.startsWith("https://"), {
      message: "url must use https",
    }),
});

export interface ShortRouteDeps {
  webBaseUrl: string; // e.g. https://trustysquire.ai — the host that serves /g/:slug
  now?: () => Date;
}

export async function registerShortRoute(
  fastify: FastifyInstance,
  opts: { deps: ShortRouteDeps },
): Promise<void> {
  const now = (): number => (opts.deps.now?.() ?? new Date()).getTime();

  fastify.post("/v1/short", async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    // Mint a slug; in the unlikely event of a collision, retry a few
    // times. After 5 tries something's wrong with our crypto RNG —
    // surface the failure rather than loop forever.
    let slug = "";
    const t = now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateSlug();
      if (!store.has(candidate)) {
        slug = candidate;
        break;
      }
    }
    if (slug === "") {
      reply.code(500).send({ error: "slug_generation_failed" });
      return;
    }
    const expiresAt = t + TTL_MS;
    store.set(slug, { url: parsed.data.url, expiresAt });
    reply.code(201).send({
      slug,
      short_url: `${opts.deps.webBaseUrl.replace(/\/$/, "")}/g/${slug}`,
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  fastify.get<{ Params: { slug: string } }>(
    "/v1/short/:slug",
    async (req, reply) => {
      const entry = getActive(req.params.slug, now());
      if (entry === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.code(200).send({
        url: entry.url,
        expires_at: new Date(entry.expiresAt).toISOString(),
      });
    },
  );
}

// Exported for tests. Resets the in-memory store between runs.
export function __resetShortStoreForTests(): void {
  store.clear();
}
