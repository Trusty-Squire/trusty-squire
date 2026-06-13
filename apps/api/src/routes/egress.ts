// egress.ts — Egress Grants v1a (buffered). A deployed machine holds a revocable
// grant token and calls a provider through Squire's injecting proxy; the raw
// vault credential never leaves the server.
//
//   POST   /v1/egress/grants        (agent)  mint a grant for a credential
//   GET    /v1/egress/grants        (agent)  list this account's grants
//   DELETE /v1/egress/grants/:id    (agent)  revoke a grant
//   ALL    /v1/egress/:grant/*      (grant token)  transparent injecting proxy
//
// The proxy reuses the SAME injection path as /v1/vault/use (vault.proxy →
// HttpProxyExecutor): SSRF pin, allowed_hosts enforcement, and ${SECRET}
// substitution all come for free. auth_shape (credential metadata) decides where
// the secret goes (bearer / header / query) so any provider works.

import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AllowlistViolationError, CredentialNotFoundError } from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";
import {
  applyAuthShape,
  parseAuthShape,
  mintGrant,
  verifyEgressToken,
  grantIsLive,
  type EgressGrantStore,
} from "../services/egress-grant.js";

const mintBody = z.object({
  reference: z.string().min(1).max(400).optional(),
  service: z.string().min(1).max(120).optional(),
  rate_limit_per_hour: z.number().int().min(1).max(100000).optional(),
  spend_cap_usd: z.number().min(0).optional(),
}).refine((b) => b.reference !== undefined || b.service !== undefined, {
  message: "one of reference or service is required",
});

// Minimal per-grant rolling-hour rate limiter (in-memory). Limits are OPT-IN:
// a grant minted without a rate carries perHour <= 0, which means UNLIMITED and
// the limiter never blocks it. A leaked token is still bounded by revocation +
// the (optional) spend cap; the rate cap only exists when the caller asked for
// one. One writer per process; the LLM tracker is the model, kept local here.
class GrantRateLimiter {
  private readonly hits = new Map<string, number[]>();
  allow(grantId: string, perHour: number, now: number): boolean {
    if (perHour <= 0) return true; // unlimited — no rate cap requested
    const cutoff = now - 3_600_000;
    const arr = (this.hits.get(grantId) ?? []).filter((t) => t > cutoff);
    if (arr.length >= perHour) {
      this.hits.set(grantId, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(grantId, arr);
    return true;
  }
}

function proxyErrorStatus(code: ProxyError["code"]): number {
  switch (code) {
    case "secret_in_url":
    case "secret_in_method":
    case "secret_in_header_key":
    case "secret_unsafe_chars":
    case "header_too_large":
    case "invalid_url":
      return 400;
    case "not_https":
    case "blocked_address":
      return 403;
    case "concurrency_limit":
      return 429;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

export const registerEgressRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  egressGrantStore: EgressGrantStore;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  proxyExecutor?: HttpProxyExecutor;
  now?: () => Date;
}> = async (fastify, opts) => {
  // Egress is a WORKLOAD proxy (LLM SDKs, deployed apps), not the agent's
  // snappy one-shot use_credential call — so it needs a much larger body cap
  // (LLM JSON responses dwarf the 10KB default) and patient timeouts (a non-
  // streaming completion's time-to-first-byte is tens of seconds, not 5s).
  const executor =
    opts.proxyExecutor ??
    new HttpProxyExecutor({
      maxResponseBytes: 16 * 1024 * 1024, // 16MB — full LLM JSON responses
      headersTimeoutMs: 120_000, // time-to-first-byte for slow completions
      bodyTimeoutMs: 120_000,
    });
  const limiter = new GrantRateLimiter();
  const now = opts.now ?? (() => new Date());
  // Limits are OPT-IN: 0 = unlimited. A grant only gets a rate cap when the
  // caller passes rate_limit_per_hour; spend_cap is likewise null unless asked.
  const UNLIMITED_RATE = 0;

  // ── Mint (agent) ──────────────────────────────────────────────
  fastify.post("/v1/egress/grants", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = mintBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const owned = await opts.deps.credentialStore.listByAccount(auth.account_id);
    let reference: string | undefined;
    if (parsed.data.reference !== undefined) {
      reference = owned.find((c) => c.reference === parsed.data.reference)?.reference;
    } else {
      const matches = owned.filter(
        (c) =>
          typeof c.metadata.service === "string" &&
          c.metadata.service.toLowerCase() === parsed.data.service!.toLowerCase(),
      );
      if (matches.length > 1) {
        reply.code(409).send({ error: "ambiguous_service", candidates: matches.map((c) => c.reference) });
        return;
      }
      reference = matches[0]?.reference;
    }
    if (reference === undefined) {
      reply.code(404).send({ error: "credential_not_found" });
      return;
    }
    const { grant, token } = mintGrant({
      account_id: auth.account_id,
      credential_ref: reference,
      rate_limit_per_hour: parsed.data.rate_limit_per_hour ?? UNLIMITED_RATE,
      spend_cap_usd: parsed.data.spend_cap_usd ?? null,
      now: now().toISOString(),
    });
    await opts.egressGrantStore.create(grant);
    const base = `${req.protocol}://${req.headers.host ?? "egress.trustysquire.ai"}/v1/egress/${grant.id}`;
    reply.code(201).send({
      grant_id: grant.id,
      base_url: base,
      token, // returned ONCE — only the hash is stored
      rate_limit_per_hour: grant.rate_limit_per_hour > 0 ? grant.rate_limit_per_hour : null, // null = unlimited
      spend_cap_usd: grant.spend_cap_usd, // null = unlimited
      hint: "Backend-only token. Point the SDK's base URL at base_url; it injects the real key server-side.",
    });
  });

  // ── List (agent) ──────────────────────────────────────────────
  fastify.get("/v1/egress/grants", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const grants = await opts.egressGrantStore.listByAccount(auth.account_id);
    reply.send({
      grants: grants.map((g) => ({
        grant_id: g.id,
        credential_ref: g.credential_ref,
        rate_limit_per_hour: g.rate_limit_per_hour > 0 ? g.rate_limit_per_hour : null, // null = unlimited
        spend_cap_usd: g.spend_cap_usd, // null = unlimited
        created_at: g.created_at,
        revoked_at: g.revoked_at, // token_hash deliberately omitted
      })),
    });
  });

  // ── Revoke (agent) ────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/v1/egress/grants/:id",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const ok = await opts.egressGrantStore.revoke(req.params.id, auth.account_id, now().toISOString());
      if (!ok) {
        reply.code(404).send({ error: "grant_not_found" });
        return;
      }
      reply.send({ revoked: true, grant_id: req.params.id });
    },
  );

  // ── Transparent egress proxy (grant token) ────────────────────
  fastify.all<{ Params: { grant: string; "*": string } }>(
    "/v1/egress/:grant/*",
    async (req, reply) => {
      const authz = req.headers.authorization ?? "";
      const token = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim() ?? "";
      const grant = await opts.egressGrantStore.getById(req.params.grant);
      if (grant === null || !verifyEgressToken(token, grant.token_hash)) {
        reply.code(401).send({ error: "invalid_egress_token" });
        return;
      }
      if (!grantIsLive(grant)) {
        reply.code(403).send({ error: "grant_revoked" });
        return;
      }
      if (!limiter.allow(grant.id, grant.rate_limit_per_hour, now().getTime())) {
        reply.code(429).send({ error: "rate_limited", limit_per_hour: grant.rate_limit_per_hour });
        return;
      }

      // Resolve the credential (account-scoped to the grant) for its upstream
      // host + auth_shape. The secret itself is injected by vault.proxy.
      const owned = await opts.deps.credentialStore.listByAccount(grant.account_id);
      const cred = owned.find((c) => c.reference === grant.credential_ref);
      if (cred === undefined || cred.allowed_hosts.length === 0) {
        reply.code(404).send({ error: "credential_unavailable" });
        return;
      }
      const host = cred.allowed_hosts[0]!; // v1: a grant targets the credential's primary host
      const shape = parseAuthShape(
        typeof cred.metadata.auth_shape === "string" ? cred.metadata.auth_shape : undefined,
      );
      const path = req.params["*"] ?? "";

      // App's inbound headers (minus hop-by-hop) → auth injected per shape with a
      // ${SECRET} placeholder the executor substitutes. URL carries no query
      // (host check runs clean); query goes via http.query (incl. ${SECRET} for
      // query-auth providers).
      const inboundHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (["host", "content-length", "connection", "authorization"].includes(key)) continue;
        if (typeof v === "string") inboundHeaders[key] = v;
      }
      const inboundQuery: Record<string, string> = {};
      const qIdx = req.url.indexOf("?");
      if (qIdx >= 0) for (const [k, v] of new URLSearchParams(req.url.slice(qIdx + 1))) inboundQuery[k] = v;

      const injected = applyAuthShape(shape, "${SECRET}", inboundHeaders, inboundQuery);
      const body =
        req.body === undefined || req.body === null
          ? undefined
          : typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body);

      try {
        const response = await opts.deps.vault.proxy(
          grant.credential_ref,
          grant.account_id,
          {
            method: req.method,
            url: `https://${host}/${path}`,
            headers: injected.headers,
            ...(Object.keys(injected.query).length > 0 ? { query: injected.query } : {}),
            ...(body !== undefined ? { body } : {}),
          },
          (input) => executor.execute(input),
        );
        reply.code(response.status).send(response.body);
      } catch (err) {
        if (err instanceof AllowlistViolationError) {
          reply.code(403).send({ error: "host_not_allowed", host: err.host });
          return;
        }
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        if (err instanceof ProxyError) {
          reply.code(proxyErrorStatus(err.code)).send({ error: err.code });
          return;
        }
        throw err;
      }
    },
  );
};
