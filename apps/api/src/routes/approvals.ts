// One approval surface across every kind, for apps that draw approvals in
// their own UI (the SDK's `approvals` and `webhooks`).
//
//   GET    /v1/approvals/:id            → the approval card; ?wait_for_decision=1
//                                         holds up to 15s for a non-pending status
//   POST   /v1/approvals/:id/deny       → refuse it from the host app
//   PUT    /v1/approval-webhook         → register this session's decision webhook
//   GET    /v1/approval-webhook         → the registered URL (never the secret)
//   DELETE /v1/approval-webhook         → stop delivering
//
// Approving is NOT here. A YES still needs the owner's passkey on the Squire
// approval page, signed over that approval's exact payload; this surface can
// only read display data and say no. Every read is scoped to the caller's
// account, and nothing it returns carries a secret value or card data.

import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";
import { readApprovalCard, type ApprovalCard } from "../services/approval-card.js";
import { recordCredentialFetchOutcome } from "../services/credential-fetch-audit.js";
import { validateApprovalWebhookUrl } from "../services/approval-webhooks.js";

const MAX_WAIT_MS = 15_000;
const webhookBody = z.object({ url: z.string().min(1).max(2048) }).strict();

type DenyOutcome = "denied" | "expired" | "not_pending";

export const registerApprovalRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  const now = () => opts.deps.now?.() ?? new Date();
  const read = (accountId: string, id: string) =>
    readApprovalCard(opts.deps, accountId, id, now());

  fastify.get<{
    Params: { id: string };
    Querystring: { wait_for_decision?: string; wait_ms?: string };
  }>("/v1/approvals/:id", { preHandler: opts.requireAny }, async (req, reply) => {
    const accountId = req.auth!.account_id;
    const requested = Number(req.query.wait_ms ?? MAX_WAIT_MS);
    const waitMs =
      req.query.wait_for_decision === "1"
        ? Math.min(Math.max(Number.isFinite(requested) ? Math.floor(requested) : MAX_WAIT_MS, 0), MAX_WAIT_MS)
        : 0;
    const deadline = Date.now() + waitMs;
    let card: ApprovalCard | null = await read(accountId, req.params.id);
    while (card !== null && card.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
      card = await read(accountId, req.params.id);
    }
    if (card === null) {
      reply.code(404).send({ error: "approval_not_found" });
      return;
    }
    return reply.code(200).send({ approval: card });
  });

  fastify.post<{ Params: { id: string } }>(
    "/v1/approvals/:id/deny",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const accountId = req.auth!.account_id;
      const card = await read(accountId, req.params.id);
      if (card === null) {
        reply.code(404).send({ error: "approval_not_found" });
        return;
      }
      const outcome = await deny(opts.deps, card, accountId, now());
      opts.deps.approvalWebhooks.notify(card.id);
      const current = (await read(accountId, card.id)) ?? card;
      if (outcome === "denied" || current.status === "denied") {
        return reply.code(200).send({ approval: current });
      }
      reply.code(409).send({
        error: outcome === "expired" ? "approval_expired" : "approval_not_pending",
        approval: current,
      });
    },
  );

  fastify.put("/v1/approval-webhook", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = webhookBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const url = validateApprovalWebhookUrl(parsed.data.url);
    if (url === null) {
      reply.code(400).send({ error: "invalid_webhook_url" });
      return;
    }
    const endpoint = await opts.deps.approvalWebhookStore.upsertEndpoint({
      accountId: auth.account_id,
      agentSessionId: auth.agent_session_id,
      url: url.toString(),
      secretSalt: randomBytes(24).toString("base64url"),
    });
    // The secret is shown ONCE, here. Registering again rotates it.
    return reply.code(200).send({
      url: endpoint.url,
      secret: opts.deps.approvalWebhooks.secretFor(endpoint),
      created_at: endpoint.createdAt.toISOString(),
    });
  });

  fastify.get("/v1/approval-webhook", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const endpoint = await opts.deps.approvalWebhookStore.getEndpointForSession(
      auth.agent_session_id,
    );
    if (endpoint === null) {
      reply.code(404).send({ error: "approval_webhook_not_found" });
      return;
    }
    return reply.code(200).send({
      url: endpoint.url,
      created_at: endpoint.createdAt.toISOString(),
    });
  });

  fastify.delete("/v1/approval-webhook", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    await opts.deps.approvalWebhookStore.deleteEndpointForSession(auth.agent_session_id);
    return reply.code(204).send();
  });
};

async function deny(
  deps: ApiDeps,
  card: ApprovalCard,
  accountId: string,
  at: Date,
): Promise<DenyOutcome> {
  switch (card.kind) {
    case "payment": {
      if (card.status !== "pending") return card.status === "expired" ? "expired" : "not_pending";
      return (await deps.pendingPaymentApprovalStore.deny(card.id, at)) === "denied"
        ? "denied"
        : "not_pending";
    }
    case "credential_fetch": {
      const record = await deps.credentialFetchApprovalStore.getByIdForAccount(card.id, accountId);
      if (record === null) return "not_pending";
      const result = await deps.credentialFetchApprovalStore.deny(card.id, at);
      // Same ledger row the Squire page's deny writes: a refusal is a security event.
      if (result === "denied") await recordCredentialFetchOutcome(deps.vaultAuditStore, record, "denied");
      if (result === "expired") {
        const settled = await deps.credentialFetchApprovalStore.expire(card.id, at);
        if (settled === "expired") {
          await recordCredentialFetchOutcome(deps.vaultAuditStore, record, "expired");
        }
      }
      return result === "already_denied" ? "denied" : result;
    }
    case "credential_mutation": {
      const result = await deps.credentialMutationApprovalStore.deny(card.id, accountId, at);
      return result === "already_denied" ? "denied" : result;
    }
    case "card_mutation": {
      const result = await deps.cardMutationApprovalStore.deny(card.id, accountId, at);
      return result === "already_denied" ? "denied" : result;
    }
  }
}
