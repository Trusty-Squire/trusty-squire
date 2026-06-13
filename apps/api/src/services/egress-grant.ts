// egress-grant.ts — the v1a core of Egress Grants: a standing, revocable token a
// deployed machine holds to call a provider through Squire's injecting proxy, so
// the raw vault credential never leaves the server. This is `use_credential`
// (agent-initiated, request-scoped) generalized to a workload identity.
//
// This module is the PURE core — the grant model, token mint/verify, auth-shape
// injection, and an in-memory store. The Fastify egress route + the
// grant_app_access MCP tool build on top. Provider-agnostic by construction: the
// auth_shape table covers bearer / header / query, so any vaulted credential
// works (the "OpenRouter-only" framing was wrong — see DESIGN-egress-grants.md).

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

// How the upstream provider expects the secret. Default bearer covers most LLM
// APIs; header/query cover the rest (ElevenLabs `xi-api-key`, Anthropic
// `x-api-key`, query-param keys) WITHOUT per-service code.
export type AuthShape =
  | { kind: "bearer" }
  | { kind: "header"; name: string }
  | { kind: "query"; param: string };

export interface EgressGrant {
  id: string; // "g_<opaque>" — appears in the egress base URL
  account_id: string; // inherits the vault credential's account scoping
  credential_ref: string; // the vault credential whose secret is injected
  token_hash: string; // sha256 of the egress token; the token itself is never stored
  rate_limit_per_hour: number; // mandatory — bounds a leaked token to an annoyance
  spend_cap_usd: number | null; // optional hard ceiling
  created_at: string;
  revoked_at: string | null; // set = instant kill, no key rotation needed
}

export interface MintedGrant {
  grant: EgressGrant;
  token: string; // returned to the caller ONCE; only the hash is persisted
}

const TOKEN_PREFIX = "sqr_egress_";

// Parse an `auth_shape` string from credential metadata into the typed shape.
// "bearer" (default) | "header:<name>" | "query:<param>". Unknown → bearer.
export function parseAuthShape(raw: string | undefined | null): AuthShape {
  if (raw === undefined || raw === null || raw.trim().length === 0) return { kind: "bearer" };
  const v = raw.trim();
  if (v === "bearer") return { kind: "bearer" };
  const header = /^header:(.+)$/i.exec(v);
  if (header) return { kind: "header", name: header[1]!.trim() };
  const query = /^query:(.+)$/i.exec(v);
  if (query) return { kind: "query", param: query[1]!.trim() };
  return { kind: "bearer" };
}

// Inject the secret into a forwarded request per the provider's auth shape.
// Returns NEW headers/query (never mutates inputs). The caller's own
// Authorization header is dropped for bearer (replaced) so a client-supplied
// egress token never reaches the upstream. Pure + exported for tests.
export function applyAuthShape(
  shape: AuthShape,
  secret: string,
  headers: Record<string, string>,
  query: Record<string, string>,
): { headers: Record<string, string>; query: Record<string, string> } {
  // Strip any inbound authorization (the egress token) so it never leaks upstream.
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") continue;
    outHeaders[k] = v;
  }
  const outQuery: Record<string, string> = { ...query };
  switch (shape.kind) {
    case "bearer":
      outHeaders["authorization"] = `Bearer ${secret}`;
      break;
    case "header":
      outHeaders[shape.name.toLowerCase()] = secret;
      break;
    case "query":
      outQuery[shape.param] = secret;
      break;
  }
  return { headers: outHeaders, query: outQuery };
}

export function hashEgressToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Constant-time compare of a presented token against a stored hash.
export function verifyEgressToken(token: string, tokenHash: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  const presented = Buffer.from(hashEgressToken(token), "hex");
  let stored: Buffer;
  try {
    stored = Buffer.from(tokenHash, "hex");
  } catch {
    return false;
  }
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

// Mint a grant + its one-time token. `now`/`randomId`/`randomToken` are injected
// so the pure logic is deterministic in tests; production passes the real ones.
export function mintGrant(input: {
  account_id: string;
  credential_ref: string;
  rate_limit_per_hour: number;
  spend_cap_usd?: number | null;
  now: string;
  randomId?: () => string;
  randomToken?: () => string;
}): MintedGrant {
  const id = `g_${(input.randomId ?? (() => randomBytes(12).toString("hex")))()}`;
  const token = `${TOKEN_PREFIX}${(input.randomToken ?? (() => randomBytes(24).toString("base64url")))()}`;
  const grant: EgressGrant = {
    id,
    account_id: input.account_id,
    credential_ref: input.credential_ref,
    token_hash: hashEgressToken(token),
    rate_limit_per_hour: input.rate_limit_per_hour,
    spend_cap_usd: input.spend_cap_usd ?? null,
    created_at: input.now,
    revoked_at: null,
  };
  return { grant, token };
}

// ── Store ──────────────────────────────────────────────────────────

export interface EgressGrantStore {
  create(grant: EgressGrant): Promise<void>;
  getById(id: string): Promise<EgressGrant | null>;
  listByAccount(accountId: string): Promise<EgressGrant[]>;
  revoke(id: string, accountId: string, at: string): Promise<boolean>;
}

export class InMemoryEgressGrantStore implements EgressGrantStore {
  private readonly grants = new Map<string, EgressGrant>();

  async create(grant: EgressGrant): Promise<void> {
    this.grants.set(grant.id, grant);
  }
  async getById(id: string): Promise<EgressGrant | null> {
    return this.grants.get(id) ?? null;
  }
  async listByAccount(accountId: string): Promise<EgressGrant[]> {
    return [...this.grants.values()].filter((g) => g.account_id === accountId);
  }
  async revoke(id: string, accountId: string, at: string): Promise<boolean> {
    const g = this.grants.get(id);
    if (g === undefined || g.account_id !== accountId) return false;
    if (g.revoked_at !== null) return true; // idempotent
    this.grants.set(id, { ...g, revoked_at: at });
    return true;
  }
}

// True when a grant may currently authorize a call.
export function grantIsLive(grant: EgressGrant): boolean {
  return grant.revoked_at === null;
}
