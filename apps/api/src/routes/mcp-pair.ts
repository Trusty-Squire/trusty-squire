// MCP install pairing flow.
//
//   POST /v1/mcp/pair/initiate  → CLI mints a token + browser URL.
//   GET  /v1/mcp/pair/:token/status  → CLI polls; once `claimed`,
//        response delivers the raw bearer token exactly once.
//   POST /v1/mcp/pair/:token/claim   → PWA (web auth) marks the token
//        claimed, creates an AgentSession, returns success.
//
// Initiate + status are unauthenticated by design (CLI has no
// credentials yet). The TTL + single-use semantics bound the
// attack surface.

import { z } from "zod";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issuePairingToken } from "../auth/pairing-token.js";
import type { ApiDeps } from "../services/deps.js";

const initiateBody = z
  .object({
    target: z.string().min(1).max(60).optional(),
    agent_identity: z.string().min(1).max(60).optional(),
    // Optional Tier-0 machine token. When present, the eventual claim
    // links the machine token to the new account so the quota counter
    // stops applying.
    machine_token: z.string().min(8).max(128).optional(),
  })
  .optional();

const claimBody = z
  .object({
    agent_identity: z.string().min(1).max(60).optional(),
    agent_version: z.string().min(1).max(60).optional(),
  })
  .optional();

export const registerMcpPairRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  pairBaseUrl?: string;
}> = async (fastify, opts) => {
  const pairBaseUrl = opts.pairBaseUrl ?? "https://trustysquire.ai/pair";

  fastify.post("/v1/mcp/pair/initiate", async (req, reply) => {
    // Body is optional; if invalid we surface 400 rather than silently
    // accepting — keeps the contract honest for the CLI.
    const parsed = initiateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const now = opts.deps.now?.() ?? new Date();
    // `agent_identity` is the canonical field; `target` is a legacy alias
    // the early CLI sent. Either works.
    const agentIdentity = parsed.data?.agent_identity ?? parsed.data?.target ?? null;
    const machineToken = parsed.data?.machine_token ?? null;
    const record = issuePairingToken(now, agentIdentity, machineToken);
    await opts.deps.pairingTokenStore.insert(record);
    return reply.code(201).send({
      pair_token: record.token,
      pair_url: `${pairBaseUrl}?token=${encodeURIComponent(record.token)}`,
      expires_at: record.expires_at.toISOString(),
    });
  });

  fastify.get<{ Params: { token: string } }>(
    "/v1/mcp/pair/:token/status",
    async (req, reply) => {
      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.token);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (now > record.expires_at && record.status !== "delivered") {
        reply.code(410).send({ status: "expired" });
        return;
      }
      if (record.status === "pending") {
        return reply.code(200).send({
          status: "pending",
          agent_identity: record.agent_identity,
        });
      }
      if (record.status === "claimed") {
        // First poll after claim — deliver the raw token (exactly once).
        const raw = await opts.deps.pairingTokenStore.deliverAndMarkUsed(req.params.token, now);
        if (raw === null) {
          reply.code(410).send({ status: "expired" });
          return;
        }
        return reply.code(200).send({
          status: "claimed",
          agent_session_token: raw,
          account_id: record.account_id,
        });
      }
      // delivered / expired
      reply.code(410).send({ status: "expired" });
    },
  );

  // Browser-side status check — used by the /pair web page. Unlike
  // /status, this NEVER delivers the one-time agent token: that delivery
  // is reserved exclusively for the CLI's /status poll, so a page load
  // can't consume the token out from under the CLI.
  fastify.get<{ Params: { token: string } }>(
    "/v1/mcp/pair/:token/state",
    async (req, reply) => {
      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.token);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (now > record.expires_at && record.status !== "delivered") {
        return reply.code(200).send({ status: "expired" });
      }
      if (record.status === "pending") {
        return reply.code(200).send({
          status: "pending",
          agent_identity: record.agent_identity,
        });
      }
      // claimed or delivered — pairing is done from the browser's POV.
      return reply.code(200).send({ status: record.status });
    },
  );

  fastify.post<{ Params: { token: string } }>(
    "/v1/mcp/pair/:token/claim",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = claimBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }

      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.token);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (record.status !== "pending" || now > record.expires_at) {
        reply.code(409).send({ error: "not_pending" });
        return;
      }

      // Mint an AgentSession bound to the authenticated account. Prefer
      // the agent_identity from the claim body (PWA echo), fall back to
      // whatever the CLI declared at initiate.
      const { raw_token, record: agentRecord } = issueAgentSession({
        account_id: auth.account_id,
        agent_identity: parsed.data?.agent_identity ?? record.agent_identity ?? null,
        agent_version: parsed.data?.agent_version ?? null,
        now,
      });
      await opts.deps.agentSessionStore.insert(agentRecord);

      const claimed = await opts.deps.pairingTokenStore.claim(
        req.params.token,
        auth.account_id,
        raw_token,
        now,
      );
      if (!claimed) {
        reply.code(409).send({ error: "claim_failed" });
        return;
      }

      // Tier 0 → Tier 1 upgrade: if a machine token was declared at
      // /initiate, link it to the account so subsequent quota checks
      // skip this token.
      if (record.machine_token !== null) {
        try {
          await opts.deps.machineTokenStore.markPaired(
            record.machine_token,
            auth.account_id,
          );
        } catch (err) {
          // Non-fatal: pairing already succeeded. Log and continue.
          fastify.log.warn({ err, machine_token_prefix: record.machine_token.slice(0, 8) }, "markPaired failed");
        }
      }

      return reply.code(200).send({
        ok: true,
        agent_session_id: agentRecord.id,
        account_id: auth.account_id,
      });
    },
  );
};
