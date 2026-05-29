// Connected-agents API — the web side of CLI pairing.
//
//   GET   /v1/mcp/sessions            → list this account's paired CLIs.
//   POST  /v1/mcp/sessions/:id/revoke → kill one.
//   PATCH /v1/mcp/sessions/:id        → set/clear the trusted flag.
//
// All require a web session: this is the account holder managing their
// own agents, never the agent itself. Marking a session trusted is a
// step-up action — it requires a passkey assertion within the last 24h
// (PASSKEY_STEP_UP_MS); without one the PATCH returns 401
// step_up_required so the web UI can prompt a WebAuthn ceremony.

import { z } from "zod";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  agentSessionRejectionReason,
  type AgentSessionRecord,
} from "../auth/agent.js";
import type { ApiDeps } from "../services/deps.js";

// Step-up freshness window (user-locked at 24h).
const PASSKEY_STEP_UP_MS = 24 * 60 * 60 * 1000;

const trustBody = z.object({ trusted: z.boolean() });

function agentStatus(
  record: AgentSessionRecord,
  now: Date,
): "active" | "expired" | "revoked" {
  return agentSessionRejectionReason(record, now) ?? "active";
}

export const registerMcpSessionsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.get(
    "/v1/mcp/sessions",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const now = opts.deps.now?.() ?? new Date();
      const sessions = await opts.deps.agentSessionStore.listByAccount(
        auth.account_id,
      );
      return reply.code(200).send({
        sessions: sessions.map((s) => ({
          id: s.id,
          agent_identity: s.agent_identity,
          agent_version: s.agent_version,
          issued_at: s.issued_at.toISOString(),
          expires_at: s.expires_at.toISOString(),
          last_used_at: s.last_used_at?.toISOString() ?? null,
          use_count: s.use_count,
          revoked_at: s.revoked_at?.toISOString() ?? null,
          status: agentStatus(s, now),
          trusted: s.trusted,
          trust_granted_at: s.trust_granted_at?.toISOString() ?? null,
        })),
      });
    },
  );

  // Set/clear the trusted flag. Granting trust is a step-up action:
  // it requires a passkey assertion recorded in the last 24h. Revoking
  // trust (trusted=false) is de-escalation and needs no step-up.
  fastify.patch<{ Params: { id: string } }>(
    "/v1/mcp/sessions/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = trustBody.safeParse(req.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      const session = await opts.deps.agentSessionStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (session === null) {
        reply.code(404).send({ error: "session_not_found" });
        return;
      }

      let passkeyId: string | null = null;
      let grantedAt: Date | null = null;
      if (parsed.data.trusted) {
        const since = new Date(now.getTime() - PASSKEY_STEP_UP_MS);
        const recent = await opts.deps.passkeyAssertionStore.findRecent(
          auth.account_id,
          since,
        );
        if (recent === null) {
          reply.code(401).send({
            error: "step_up_required",
            reason: "no_recent_passkey_assertion",
          });
          return;
        }
        passkeyId = recent.credential_id;
        grantedAt = now;
      }

      await opts.deps.agentSessionStore.setTrust({
        id: session.id,
        accountId: auth.account_id,
        trusted: parsed.data.trusted,
        grantedAt,
        passkeyId,
      });
      return reply.code(200).send({
        trusted: parsed.data.trusted,
        trust_granted_at: grantedAt?.toISOString() ?? null,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/mcp/sessions/:id/revoke",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;

      // Ownership check: only revoke a session that belongs to the
      // caller's account. listByAccount is the scoping boundary.
      const owned = await opts.deps.agentSessionStore.listByAccount(
        auth.account_id,
      );
      const target = owned.find((s) => s.id === req.params.id);
      if (target === undefined) {
        reply.code(404).send({ error: "session_not_found" });
        return;
      }
      if (target.revoked_at !== null) {
        return reply.code(200).send({ ok: true, already_revoked: true });
      }
      await opts.deps.agentSessionStore.revoke(target.id, "revoked_by_user");
      return reply.code(200).send({ ok: true });
    },
  );
};
