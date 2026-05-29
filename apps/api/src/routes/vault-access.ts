// Agent-mediated credential access — the approval flow + use_credential
// proxy.
//
// Agent side (Bearer agent session):
//   POST   /v1/vault/access-requests           → request_credential
//   GET    /v1/vault/access-requests/:id        → poll_credential_access
//   POST   /v1/vault/access-requests/:id/proxy  → use_credential
// Web side (session cookie):
//   GET    /v1/vault/access-requests?status=pending → approval list
//   GET    /v1/vault/access-requests/pending-count  → nav badge
//   GET    /v1/vault/approvals/stream               → SSE deltas
//   POST   /v1/vault/access-requests/:id/decision   → approve / deny
//   DELETE /v1/vault/access-requests/:id            → revoke
//
// Every :id route is account/agent-session scoped in a single store
// query — no load-then-check.

import { z } from "zod";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  effectiveGrantStatus,
  GrantNotUsableError,
  DEFAULT_PERSISTENT_TTL_SECONDS,
  MAX_PERSISTENT_TTL_SECONDS,
  VAULT_AUDIT_TYPES,
  type AccessGrantRecord,
  type GrantMode,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1h for once/session

const requestBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    purpose: z.string().min(1).max(400),
    intent: z.enum(["value", "proxy"]),
    proxy_target_host: z.string().min(1).max(253).optional(),
    reason_proxy_not_possible: z.string().min(1).max(400).optional(),
    mode_requested: z.enum(["once", "session", "persistent"]).optional(),
    ttl_requested: z.number().int().positive().max(MAX_PERSISTENT_TTL_SECONDS).optional(),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  })
  .refine((b) => b.intent !== "value" || b.reason_proxy_not_possible !== undefined, {
    message: "reason_proxy_not_possible is required when intent=value",
  });

const decisionBody = z.object({
  decision: z.enum(["approve", "deny"]),
  mode_override: z.enum(["once", "session", "persistent"]).optional(),
  ttl_seconds: z.number().int().positive().max(MAX_PERSISTENT_TTL_SECONDS).optional(),
});

const proxyBody = z.object({
  http: z.object({
    method: z.string().min(1).max(10),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string()).optional(),
    body: z.string().max(64 * 1024).optional(),
  }),
});

function clampTtl(mode: GrantMode, requested: number | undefined): number {
  if (mode === "persistent") {
    return Math.min(requested ?? DEFAULT_PERSISTENT_TTL_SECONDS, MAX_PERSISTENT_TTL_SECONDS);
  }
  return requested ?? DEFAULT_TTL_SECONDS;
}

// Map a ProxyError code to an HTTP status for the agent.
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
      return 502; // upstream_error / dns_failed / response_* / unsupported_*
  }
}

export const registerVaultAccessRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // Injectable for tests (SSRF guard would reject a loopback echo server).
  proxyExecutor?: HttpProxyExecutor;
}> = async (fastify, opts) => {
  const now = (): Date => opts.deps.now?.() ?? new Date();
  const executor = opts.proxyExecutor ?? new HttpProxyExecutor();

  // ── Agent: request_credential ────────────────────────────────
  fastify.post(
    "/v1/vault/access-requests",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = requestBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;

      // Resolve the credential the request targets — account-scoped.
      const owned = await opts.deps.credentialStore.listByAccount(auth.account_id);
      let reference: string | undefined;
      if (data.reference !== undefined) {
        reference = owned.find((c) => c.reference === data.reference)?.reference;
      } else {
        const matches = owned.filter(
          (c) =>
            typeof c.metadata.service === "string" &&
            c.metadata.service.toLowerCase() === data.service!.toLowerCase(),
        );
        if (matches.length > 1) {
          reply.code(409).send({
            error: "ambiguous_service",
            candidates: matches.map((c) => c.reference),
          });
          return;
        }
        reference = matches[0]?.reference;
      }
      if (reference === undefined) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }

      const mode: GrantMode = data.mode_requested ?? "once";
      const session = await opts.deps.agentSessionStore.findByIdForAccount(
        auth.agent_session_id,
        auth.account_id,
      );
      const grant = await opts.deps.vault.requestAccess({
        account_id: auth.account_id,
        reference,
        agent_session_id: auth.agent_session_id,
        intent: data.intent,
        mode,
        ttl_seconds: clampTtl(mode, data.ttl_requested),
        purpose: data.purpose,
        reason_proxy_not_possible: data.reason_proxy_not_possible ?? null,
        requested_target_host: data.proxy_target_host ?? null,
        session_trusted: session?.trusted ?? false,
      });

      return reply.code(202).send({
        request_id: grant.id,
        status: effectiveGrantStatus(grant, now()),
        expires_at: grant.expires_at?.toISOString() ?? null,
        auto_approved: grant.auto_approved,
      });
    },
  );

  // ── Agent: poll_credential_access ────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/access-requests/:id",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const grant = await opts.deps.accessGrantStore.findByIdForAgentSession(
        req.params.id,
        auth.agent_session_id,
      );
      if (grant === null) {
        reply.code(404).send({ error: "request_not_found" });
        return;
      }
      const status = effectiveGrantStatus(grant, now());
      // Value-intent + approved → return the secret (consumes a "once").
      if (grant.intent === "value" && status === "approved") {
        try {
          const value = await opts.deps.vault.retrieveWithGrant(
            grant.id,
            auth.account_id,
            auth.agent_session_id,
            grant.purpose,
          );
          return reply.code(200).send({ status: "approved", value });
        } catch (err) {
          if (err instanceof GrantNotUsableError) {
            // Lost a consume race / just expired — report current state.
            return reply.code(200).send({ status: "consumed" });
          }
          throw err;
        }
      }
      return reply.code(200).send({
        status,
        ...(status === "denied" ? { denied_reason: "user_denied" } : {}),
      });
    },
  );

  // ── Agent: use_credential (proxy) ────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/access-requests/:id/proxy",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = proxyBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      // Rebuild without undefined-valued optionals (exactOptionalPropertyTypes).
      const http = {
        method: parsed.data.http.method,
        url: parsed.data.http.url,
        ...(parsed.data.http.headers !== undefined ? { headers: parsed.data.http.headers } : {}),
        ...(parsed.data.http.body !== undefined ? { body: parsed.data.http.body } : {}),
      };
      try {
        const response = await opts.deps.vault.proxyWithGrant(
          req.params.id,
          auth.account_id,
          auth.agent_session_id,
          http,
          (input) => executor.execute(input),
        );
        return reply.code(200).send({ response });
      } catch (err) {
        if (err instanceof GrantNotUsableError) {
          reply.code(409).send({ error: "grant_not_usable", reason: err.reason });
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

  // ── Web: pending list ────────────────────────────────────────
  fastify.get(
    "/v1/vault/access-requests",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const pending = await opts.deps.accessGrantStore.listPendingByAccount(
        auth.account_id,
      );
      // Resolve agent identities + credential services for display.
      const sessions = await opts.deps.agentSessionStore.listByAccount(auth.account_id);
      const identityById = new Map(sessions.map((s) => [s.id, s.agent_identity]));
      const creds = await opts.deps.credentialStore.listByAccount(auth.account_id);
      const serviceByRef = new Map(
        creds.map((c) => [
          c.reference,
          typeof c.metadata.service === "string" ? c.metadata.service : null,
        ]),
      );
      return reply.code(200).send({ requests: pending.map((g) => view(g, identityById, serviceByRef)) });
    },
  );

  // ── Web: pending count (nav badge) ───────────────────────────
  fastify.get(
    "/v1/vault/access-requests/pending-count",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const count = await opts.deps.accessGrantStore.countPendingByAccount(
        auth.account_id,
      );
      return reply.code(200).send({ count });
    },
  );

  // ── Web: SSE stream of pending deltas ────────────────────────
  fastify.get(
    "/v1/vault/approvals/stream",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.hijack();

      let lastCount = -1;
      const tick = async (): Promise<void> => {
        const count = await opts.deps.accessGrantStore.countPendingByAccount(
          auth.account_id,
        );
        if (count !== lastCount) {
          lastCount = count;
          reply.raw.write(`event: pending\ndata: ${JSON.stringify({ count })}\n\n`);
        } else {
          reply.raw.write(": keepalive\n\n");
        }
      };
      await tick();
      const interval = setInterval(() => {
        void tick();
      }, 2000);
      req.raw.on("close", () => {
        clearInterval(interval);
        reply.raw.end();
      });
    },
  );

  // ── Web: decide (approve / deny) ─────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/access-requests/:id/decision",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = decisionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const grant = await opts.deps.accessGrantStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (grant === null) {
        reply.code(404).send({ error: "request_not_found" });
        return;
      }
      const decidedAt = now();

      if (parsed.data.decision === "deny") {
        const n = await opts.deps.accessGrantStore.deny({
          id: grant.id,
          accountId: auth.account_id,
          decidedAt,
        });
        if (n === 0) {
          reply.code(409).send({ error: "not_pending" });
          return;
        }
        await opts.deps.vault.recordAccessAudit(auth.account_id, VAULT_AUDIT_TYPES.accessDenied, {
          reference: grant.reference,
          requester: "user",
          request_id: grant.id,
        });
        return reply.code(200).send({ status: "denied", expires_at: null });
      }

      const mode: GrantMode = parsed.data.mode_override ?? grant.mode;
      const ttl = clampTtl(mode, parsed.data.ttl_seconds);
      const expiresAt = new Date(decidedAt.getTime() + ttl * 1000);
      const n = await opts.deps.accessGrantStore.approve({
        id: grant.id,
        accountId: auth.account_id,
        mode,
        ttlSeconds: ttl,
        expiresAt,
        decidedAt,
      });
      if (n === 0) {
        reply.code(409).send({ error: "not_pending" });
        return;
      }
      await opts.deps.vault.recordAccessAudit(auth.account_id, VAULT_AUDIT_TYPES.accessApproved, {
        reference: grant.reference,
        requester: "user",
        request_id: grant.id,
        mode,
        auto_approved: false,
      });
      return reply.code(200).send({ status: "approved", expires_at: expiresAt.toISOString() });
    },
  );

  // ── Web: revoke ──────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/v1/vault/access-requests/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const grant = await opts.deps.accessGrantStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (grant === null) {
        reply.code(404).send({ error: "request_not_found" });
        return;
      }
      await opts.deps.accessGrantStore.revoke({ id: grant.id, accountId: auth.account_id });
      return reply.code(204).send();
    },
  );
};

// Web-facing projection of a grant — no secret, ever.
function view(
  g: AccessGrantRecord,
  identityById: Map<string, string | null>,
  serviceByRef: Map<string, string | null>,
): Record<string, unknown> {
  return {
    request_id: g.id,
    reference: g.reference,
    service: serviceByRef.get(g.reference) ?? null,
    agent_identity: identityById.get(g.agent_session_id) ?? null,
    intent: g.intent,
    mode: g.mode,
    purpose: g.purpose,
    reason_proxy_not_possible: g.reason_proxy_not_possible,
    requested_target_host: g.requested_target_host,
    requested_at: g.requested_at.toISOString(),
    expires_at: g.expires_at?.toISOString() ?? null,
    status: g.status,
  };
}
