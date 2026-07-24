import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";

const createBody = z.object({
  merchant: z.string().min(1).max(256),
  checkout_origin: z.string().url().refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }),
  amount_cents: z.number().int().min(0).max(2_147_483_647),
  currency: z.string().min(1).max(8),
  card_ref: z.string().min(1).max(64),
  operator_pubkey: z.string().min(1).max(512),
});

const approveBody = z.object({
  jws: z.string().max(8192),
  sealed_card: z.string().max(16384),
});

export const registerPayApprovalsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post("/v1/pay/approvals", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const now = opts.deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const nonce = randomBytes(16).toString("base64url");
    const id = await opts.deps.pendingPaymentApprovalStore.create(auth.account_id, {
      merchant: parsed.data.merchant,
      checkoutOrigin: parsed.data.checkout_origin,
      amountCents: parsed.data.amount_cents,
      currency: parsed.data.currency,
      nonce,
      cardRef: parsed.data.card_ref,
      operatorPubkey: parsed.data.operator_pubkey,
      expiresAt,
    });
    return reply.code(201).send({ id, nonce, expires_at: expiresAt.toISOString() });
  });

  fastify.get<{ Params: { id: string } }>(
    "/v1/pay/approvals/:id",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const record = await opts.deps.pendingPaymentApprovalStore.getByIdForAccount(
        req.params.id,
        req.auth!.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "payment_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      const status =
        record.status === "pending" && record.expiresAt <= now ? "expired" : record.status;
      return reply.code(200).send({
        id: record.id,
        status,
        merchant: record.merchant,
        checkout_origin: record.checkoutOrigin,
        amount_cents: record.amountCents,
        currency: record.currency,
        nonce: record.nonce,
        card_ref: record.cardRef,
        operator_pubkey: record.operatorPubkey,
        jws: record.jws,
        sealed_card: record.sealedCard,
        expires_at: record.expiresAt.toISOString(),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/pay/approvals/:id/approve",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = approveBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const record = await opts.deps.pendingPaymentApprovalStore.getByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "payment_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      if (record.status !== "pending") {
        reply.code(409).send({ error: "payment_approval_already_approved" });
        return;
      }
      if (record.expiresAt <= now) {
        reply.code(409).send({ error: "payment_approval_expired" });
        return;
      }
      const approved = await opts.deps.pendingPaymentApprovalStore.approveForAccount(
        req.params.id,
        auth.account_id,
        parsed.data.jws,
        parsed.data.sealed_card,
        now,
      );
      if (!approved) {
        reply.code(409).send({ error: "payment_approval_not_pending" });
        return;
      }
      return reply.code(200).send({ status: "approved" });
    },
  );
};
