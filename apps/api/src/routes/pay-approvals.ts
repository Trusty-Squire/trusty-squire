import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";
import { sendTelegramMessage } from "../services/telegram.js";

// Web base for the approval link sent to Telegram. Reuses PWA_BASE_URL
// (the same override server.ts's defaultPwaBaseUrl() reads) if set, else
// the Telegram-specific override, else the production default.
function webBaseUrl(): string {
  return (
    process.env.PWA_BASE_URL ?? process.env.TRUSTY_SQUIRE_WEB_BASE ?? "https://trustysquire.ai"
  );
}

const createBody = z.object({
  merchant: z.string().min(1).max(256),
  checkout_origin: z
    .string()
    .url()
    .refine((value) => {
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
  item: z.string().max(500).optional(),
  reason: z.string().max(500).optional(),
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
  fastify.get("/v1/pay/config", { preHandler: opts.requireAgent }, async (req, reply) => {
    if (req.auth!.kind !== "agent") return;
    const audience = process.env.VOUCHFLOW_CUSTOMER_ID?.trim();
    return reply.code(200).send({
      ...(audience !== undefined && audience.length > 0 ? { vouchflow_audience: audience } : {}),
    });
  });

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
    const agent = auth.agent_identity ?? "unknown-agent";
    const id = await opts.deps.pendingPaymentApprovalStore.create(auth.account_id, {
      merchant: parsed.data.merchant,
      checkoutOrigin: parsed.data.checkout_origin,
      amountCents: parsed.data.amount_cents,
      currency: parsed.data.currency,
      nonce,
      cardRef: parsed.data.card_ref,
      operatorPubkey: parsed.data.operator_pubkey,
      item: parsed.data.item ?? "",
      reason: parsed.data.reason ?? "",
      agent,
      expiresAt,
    });

    // Push to the user's linked Telegram, if any. Fire-and-forget — a
    // Telegram error must never delay or fail the approval response.
    const account = await opts.deps.accountStore.findAccountById(auth.account_id);
    if (account?.telegram_chat_id != null) {
      const amount = (parsed.data.amount_cents / 100).toFixed(2);
      const text =
        `Trusty Squire — approve ${parsed.data.currency} ${amount} to ${parsed.data.merchant}\n` +
        `${webBaseUrl()}/vault/pay/${id}`;
      void sendTelegramMessage(account.telegram_chat_id, text).catch(() => {});
    }

    return reply.code(201).send({ id, nonce, agent, expires_at: expiresAt.toISOString() });
  });

  fastify.post<{ Params: { id: string } }>(
    "/v1/pay/approvals/:id/notify-3ds",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const record = await opts.deps.pendingPaymentApprovalStore.getByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      const account = await opts.deps.accountStore.findAccountById(auth.account_id);
      let sent = false;
      if (account?.telegram_chat_id != null) {
        const text =
          "🔐 3-D Secure required — complete the challenge in the open checkout browser to finish your " +
          record.currency +
          " " +
          (record.amountCents / 100).toFixed(2) +
          " payment to " +
          record.merchant +
          ".";
        sent = await sendTelegramMessage(account.telegram_chat_id, text);
      }
      return reply.code(200).send({ sent });
    },
  );

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
        item: record.item,
        reason: record.reason,
        agent: record.agent,
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
