// Connected-agents API — the web side of CLI pairing.
//
//   GET  /v1/mcp/sessions            → list this account's paired CLIs.
//   POST /v1/mcp/sessions/:id/revoke → kill one.
//
// Both require a web session: this is the account holder managing
// their own agents, never the agent itself.

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
        })),
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
