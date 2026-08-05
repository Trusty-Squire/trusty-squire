import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  // Optional: a JIT add-card ceremony mints the approval card-less and binds
  // the card later via POST /v1/pay/approvals/:id/bind-card.
  card_ref: z.string().min(1).max(64).optional(),
  operator_pubkey: z.string().min(1).max(512),
  item: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
});

const requesterName = z.string().trim().min(1).max(256);

const approveBody = z
  .object({
    jws: z.string().max(8192),
    sealed_card: z.string().max(16384),
  })
  .strict();

function decodePayloadHash(jws: string): Buffer | null {
  const parts = jws.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      payload_sha256?: unknown;
      context?: unknown;
    };
    if (claims.context !== "purchase" || typeof claims.payload_sha256 !== "string") return null;
    if (/^[0-9a-fA-F]{64}$/.test(claims.payload_sha256)) {
      return Buffer.from(claims.payload_sha256, "hex");
    }
    if (/^[A-Za-z0-9_-]{43}$/.test(claims.payload_sha256)) {
      return Buffer.from(claims.payload_sha256, "base64url");
    }
    return null;
  } catch {
    return null;
  }
}

function recipientPubkeyHash(operatorPubkey: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(operatorPubkey)) return null;
  try {
    return createHash("sha256")
      .update(Buffer.from(operatorPubkey, "base64url"))
      .digest("base64url");
  } catch {
    return null;
  }
}

function submissionMatchesApproval(
  submission: z.infer<typeof approveBody>,
  record: Awaited<ReturnType<ApiDeps["pendingPaymentApprovalStore"]["getById"]>>,
): boolean {
  if (record === null || record.cardRef === null) return false;
  const signedHash = decodePayloadHash(submission.jws);
  if (signedHash === null || signedHash.byteLength !== 32) return false;
  const recipientHash = recipientPubkeyHash(record.operatorPubkey);
  if (recipientHash === null) return false;
  // JSON Canonicalization Scheme orders these flat keys lexicographically.
  // All values are strings or an integer, so JSON.stringify over this explicit
  // order is byte-identical to the web SDK and the operator's canonicalize().
  const canonical = JSON.stringify({
    agent: record.agent,
    amount_cents: record.amountCents,
    approval_id: record.id,
    card_ref: record.cardRef,
    checkout_origin: record.checkoutOrigin,
    currency: record.currency,
    item: record.item,
    merchant: record.merchant,
    nonce: record.nonce,
    reason: record.reason,
    recipient_pubkey_hash: recipientHash,
  });
  const expectedHash = createHash("sha256").update(canonical, "utf8").digest();
  return timingSafeEqual(signedHash, expectedHash);
}

const bindCardBody = z.object({
  card_ref: z.string().min(1).max(64),
});

export const registerPayApprovalsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  type Submission = z.infer<typeof approveBody>;
  type SubmissionWaiter = {
    accountId: string;
    resolve: (submission: Submission | null) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const submissionWaiters = new Map<string, SubmissionWaiter>();

  const waitForSubmission = async (id: string, accountId: string): Promise<Submission | null> =>
    await new Promise<Submission | null>((resolve) => {
      const previous = submissionWaiters.get(id);
      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.resolve(null);
      }
      let waiter: SubmissionWaiter;
      const timer = setTimeout(() => {
        if (submissionWaiters.get(id) === waiter) submissionWaiters.delete(id);
        resolve(null);
      }, 15_000);
      waiter = { accountId, resolve, timer };
      submissionWaiters.set(id, waiter);
    });

  const deliverSubmission = (id: string, accountId: string, submission: Submission): boolean => {
    const waiter = submissionWaiters.get(id);
    if (waiter === undefined || waiter.accountId !== accountId) return false;
    submissionWaiters.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(submission);
    return true;
  };

  fastify.addHook("onClose", async () => {
    for (const waiter of submissionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    submissionWaiters.clear();
  });

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
    // Card-less (JIT add-card) approvals need a longer window: the user
    // fills a first-time card form + passkey ceremony, not a one-tap
    // approve, so 18 min vs the 10-min has-card tap window. The MCP side
    // waits ~18 min; without this the real window was capped at 10.
    const ttlMs = parsed.data.card_ref == null ? 18 * 60 * 1000 : 10 * 60 * 1000;
    const expiresAt = new Date(now.getTime() + ttlMs);
    const nonce = randomBytes(16).toString("base64url");
    const requester = requesterName.safeParse(req.headers["x-squire-agent-identity"]);
    const agent = requester.success ? requester.data : (auth.agent_identity ?? "unknown-agent");
    const id = await opts.deps.pendingPaymentApprovalStore.create(auth.account_id, {
      merchant: parsed.data.merchant,
      checkoutOrigin: parsed.data.checkout_origin,
      amountCents: parsed.data.amount_cents,
      currency: parsed.data.currency,
      nonce,
      cardRef: parsed.data.card_ref ?? null,
      operatorPubkey: parsed.data.operator_pubkey,
      item: parsed.data.item,
      reason: parsed.data.reason,
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

  fastify.get<{ Params: { id: string }; Querystring: { wait_for_submission?: string } }>(
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
      const submission =
        req.auth!.kind === "agent" && req.query.wait_for_submission === "1" && status === "pending"
          ? await waitForSubmission(record.id, record.accountId)
          : null;
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
        jws: submission?.jws ?? record.jws,
        sealed_card: submission?.sealed_card ?? record.sealedCard,
        expires_at: record.expiresAt.toISOString(),
      });
    },
  );

  fastify.get<{ Params: { id: string } }>("/v1/pay/approvals/:id/ceremony", async (req, reply) => {
    const record = await opts.deps.pendingPaymentApprovalStore.getById(req.params.id);
    if (record === null) {
      reply.code(404).send({ error: "payment_approval_not_found" });
      return;
    }
    const now = opts.deps.now?.() ?? new Date();
    const status =
      record.status === "pending" && record.expiresAt <= now ? "expired" : record.status;
    const card =
      record.cardRef === null || status !== "pending"
        ? null
        : await opts.deps.e2eCredentialStore.getByIdForAccount(record.cardRef, record.accountId);
    if (status === "pending" && record.cardRef !== null && card === null) {
      reply.code(409).send({ error: "payment_card_unavailable" });
      return;
    }
    return reply.code(200).send({
      id: record.id,
      status,
      card_ref: record.cardRef,
      operator_pubkey: record.operatorPubkey,
      card: card === null ? null : { blob: card.blob },
    });
  });

  // Binds a stored card to a card-less pending approval (the JIT add-card
  // ceremony). Web-authed, pending-only, write-once, and the bound card must
  // be an E2ECredential owned by the same account. Converts the
  // seal→bind→approve ordering from client convention into a server-enforced
  // state machine.
  fastify.post<{ Params: { id: string } }>(
    "/v1/pay/approvals/:id/bind-card",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = bindCardBody.safeParse(req.body);
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
      if (record.status !== "pending") {
        reply.code(409).send({ error: "payment_approval_not_pending" });
        return;
      }
      if (record.cardRef !== null) {
        reply.code(409).send({ error: "card_already_bound" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      if (record.expiresAt <= now) {
        reply.code(409).send({ error: "payment_approval_expired" });
        return;
      }
      const bindResult = await opts.deps.pendingPaymentApprovalStore.bindCardForAccount(
        req.params.id,
        auth.account_id,
        parsed.data.card_ref,
        now,
      );
      if (bindResult === "card_not_found") {
        reply.code(404).send({ error: "card_not_found" });
        return;
      }
      if (bindResult === "not_bindable") {
        reply.code(409).send({ error: "payment_approval_not_pending" });
        return;
      }
      return reply.code(200).send({ card_ref: parsed.data.card_ref });
    },
  );

  fastify.post<{ Params: { id: string } }>("/v1/pay/approvals/:id/approve", async (req, reply) => {
    const parsed = approveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const record = await opts.deps.pendingPaymentApprovalStore.getById(req.params.id);
    if (record === null) {
      reply.code(404).send({ error: "payment_approval_not_found" });
      return;
    }
    // A card-less mandate cannot be approved — the card must be bound first
    // (seal→bind→approve). Server-enforced, not client convention.
    if (record.cardRef === null) {
      reply.code(409).send({ error: "card_required" });
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
    if (!submissionMatchesApproval(parsed.data, record)) {
      reply.code(403).send({ error: "payment_approval_binding_mismatch" });
      return;
    }
    if (!deliverSubmission(req.params.id, record.accountId, parsed.data)) {
      reply.code(409).send({ error: "payment_operator_unavailable" });
      return;
    }
    return reply.code(202).send({ status: "pending" });
  });

  fastify.post<{ Params: { id: string } }>(
    "/v1/pay/approvals/:id/confirm",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
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
      if (record.cardRef === null) {
        reply.code(409).send({ error: "card_required" });
        return;
      }
      if (record.status !== "pending") {
        const sameApprovedSubmission =
          record.status === "approved" &&
          record.jws === parsed.data.jws &&
          record.sealedCard === parsed.data.sealed_card;
        if (sameApprovedSubmission) {
          return reply.code(200).send({ status: "approved" });
        }
        reply.code(409).send({ error: "payment_approval_candidate_changed" });
        return;
      }
      if (record.expiresAt <= now) {
        reply.code(409).send({ error: "payment_approval_expired" });
        return;
      }
      if (!submissionMatchesApproval(parsed.data, record)) {
        reply.code(403).send({ error: "payment_approval_binding_mismatch" });
        return;
      }
      const confirmed = await opts.deps.pendingPaymentApprovalStore.approveForAccount(
        req.params.id,
        auth.account_id,
        parsed.data.jws,
        parsed.data.sealed_card,
        now,
      );
      if (!confirmed) {
        reply.code(409).send({ error: "payment_approval_candidate_changed" });
        return;
      }
      return reply.code(200).send({ status: "approved" });
    },
  );
};
