import { createHash, randomBytes } from "node:crypto";
import {
  classifyPaymentCandidateBinding,
  type PaymentCandidateHash,
  type PaymentCandidateKind,
} from "@trusty-squire/skill-schema";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";
import { formatCurrencyAmount } from "../services/money.js";
import { sendTelegramMessage } from "../services/telegram.js";
import {
  PAYMENT_VOUCH_CONTEXT,
  VouchMandateVerificationError,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";
import { authenticatedRequester } from "../services/requesting-agent.js";

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

const approveBody = z
  .object({
    jws: z.string().max(8192),
    sealed_card: z.string().max(16384),
    // Accepted and ignored: shipped operators (>= #406) echo the approval's
    // card_ref in their /confirm body. The server-stored record is the only
    // authority; rejecting the key (as #432's bare .strict() did) 400'd every
    // confirm from every deployed client and broke the whole money path.
    card_ref: z.string().max(64).nullable().optional(),
  })
  .strict();

function decodePayloadHash(jws: string): string | null {
  const parts = jws.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      payload_sha256?: unknown;
      context?: unknown;
    };
    if (claims.context !== "purchase" || typeof claims.payload_sha256 !== "string") return null;
    if (/^[0-9a-fA-F]{64}$/.test(claims.payload_sha256)) {
      return claims.payload_sha256;
    }
    if (/^[A-Za-z0-9_-]{43}$/.test(claims.payload_sha256)) {
      return claims.payload_sha256;
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

type ApprovalRecord = NonNullable<
  Awaited<ReturnType<ApiDeps["pendingPaymentApprovalStore"]["getById"]>>
>;

function approvalPayloadHash(record: ApprovalRecord): Buffer | null {
  if (record.cardRef === null) return null;
  const recipientHash = recipientPubkeyHash(record.operatorPubkey);
  if (recipientHash === null) return null;
  return hashVouchPayload({
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
}

function reviewPayloadHash(record: ApprovalRecord, payloadHash: Buffer): Buffer | null {
  if (record.cardRef === null) return null;
  const recipientHash = recipientPubkeyHash(record.operatorPubkey);
  if (recipientHash === null) return null;
  return hashVouchPayload({
    approval_id: record.id,
    approval_payload_sha256: payloadHash.toString("base64url"),
    card_ref: record.cardRef,
    recipient_pubkey_hash: recipientHash,
  });
}

function candidateHash(hash: Buffer | null): PaymentCandidateHash | null {
  return hash === null
    ? null
    : { base64url: hash.toString("base64url"), hex: hash.toString("hex") };
}

function submissionBinding(
  submission: z.infer<typeof approveBody>,
  record: ApprovalRecord,
): PaymentCandidateKind {
  const payloadHash = approvalPayloadHash(record);
  const reviewHash = payloadHash === null ? null : reviewPayloadHash(record, payloadHash);
  return classifyPaymentCandidateBinding({
    jws: submission.jws,
    sealedCard: submission.sealed_card,
    claimedPayloadHash: decodePayloadHash(submission.jws),
    approvalPayloadHash: candidateHash(payloadHash),
    reviewPayloadHash: candidateHash(reviewHash),
  });
}

// Display-only identity for the card an approval releases: "Label •••• 1234"
// (or the label alone for legacy cards stored before the last4 metadata
// existed). Resolved from the non-secret label/brand/last4 metadata the vault
// stores; never PAN/expiry/CVV. Returns null when the cardless approval binds
// no card or the bound card can't be resolved, so the caller falls back to a
// generic phrase instead of "your saved card".
async function approvalCardName(
  cardRef: string | null,
  deps: Pick<ApiDeps, "e2eCredentialStore">,
  accountId: string,
): Promise<string | null> {
  if (cardRef === null) return null;
  try {
    const card = await deps.e2eCredentialStore.getByIdForAccount(cardRef, accountId);
    if (card === null) return null;
    return card.last4 !== null ? `${card.label} •••• ${card.last4}` : card.label;
  } catch {
    // Display metadata is best-effort; never fail the approval over it.
    return null;
  }
}

const bindCardBody = z.object({
  card_ref: z.string().min(1).max(64),
});

const notifyThreeDsBody = z.object({
  mode: z.enum(["detected_challenge", "possible_out_of_band"]).default("detected_challenge"),
});

export const registerPayApprovalsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  vouchVerifier?: VouchMandateVerifier;
}> = async (fastify, opts) => {
  type Submission = z.infer<typeof approveBody>;
  const submissionWaitMs = 15_000;
  const relayPollIntervalMs = 1_000;
  const sleep = async (ms: number): Promise<void> =>
    await new Promise((resolve) => setTimeout(resolve, ms));
  const verifyVouch = opts.vouchVerifier ?? createVouchMandateVerifier();
  const vouchflowAudience = process.env.VOUCHFLOW_CUSTOMER_ID?.trim() ?? "";

  const submissionFingerprint = (submission: Submission): string =>
    createHash("sha256")
      .update(JSON.stringify([submission.jws, submission.sealed_card]))
      .digest("base64url");

  const event = (
    name: string,
    record: ApprovalRecord,
    fingerprint: string | null,
    failureCode: string,
  ) =>
    fastify.log.info(
      {
        event: name,
        approval_id: record.id,
        candidate_fingerprint: fingerprint,
        account_hash: createHash("sha256").update(record.accountId).digest("base64url"),
        machine_id: process.env.FLY_MACHINE_ID ?? "unknown",
        release_id: process.env.FLY_IMAGE_REF ?? process.env.RELEASE_ID ?? "unknown",
        failure_code: failureCode,
      },
      "payment review lifecycle",
    );

  const candidateLifecycle = (
    record: ApprovalRecord,
    candidateKind: PaymentCandidateKind,
    transitionOutcome: string,
  ) =>
    fastify.log.info(
      {
        event: "payment_candidate_lifecycle",
        approval_id: record.id,
        candidate_kind: candidateKind,
        transition_outcome: transitionOutcome,
        account_hash: createHash("sha256").update(record.accountId).digest("base64url"),
        machine_id: process.env.FLY_MACHINE_ID ?? "unknown",
        release_id: process.env.FLY_IMAGE_REF ?? process.env.RELEASE_ID ?? "unknown",
      },
      "payment candidate lifecycle",
    );

  const readSubmission = async (
    id: string,
    accountId: string,
    peek: boolean,
  ): Promise<Submission | null> => {
    const candidate = peek
      ? await opts.deps.pendingPaymentApprovalStore.peekRelayCandidateForAccount(
          id,
          accountId,
          opts.deps.now?.() ?? new Date(),
        )
      : await opts.deps.pendingPaymentApprovalStore.getRelayCandidateForAccount(
          id,
          accountId,
          opts.deps.now?.() ?? new Date(),
        );
    return candidate === null ? null : { jws: candidate.jws, sealed_card: candidate.sealedCard };
  };

  const waitForSubmission = async (
    id: string,
    accountId: string,
    peek: boolean,
  ): Promise<Submission | null> => {
    const deadline = Date.now() + submissionWaitMs;
    while (Date.now() < deadline) {
      const submission = await readSubmission(id, accountId, peek);
      if (submission !== null) return submission;
      await sleep(relayPollIntervalMs);
    }
    return null;
  };

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
    const agent = authenticatedRequester(auth);
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
      const amount = formatCurrencyAmount(parsed.data.amount_cents, parsed.data.currency);
      const cardName = await approvalCardName(
        parsed.data.card_ref ?? null,
        opts.deps,
        auth.account_id,
      );
      const text =
        `Trusty Squire — approve ${amount} to ${parsed.data.merchant}\n` +
        `${
          cardName !== null
            ? `Using ${cardName}.\n`
            : parsed.data.card_ref == null
              ? "A card will be entered during checkout.\n"
              : "Using this payment's card.\n"
        }` +
        `${webBaseUrl()}/vault/pay/${id}`;
      void sendTelegramMessage(account.telegram_chat_id, text).catch(() => {});
    }

    return reply.code(201).send({ id, nonce, agent, expires_at: expiresAt.toISOString() });
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>(
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
      const parsed = notifyThreeDsBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request" });
        return;
      }
      const account = await opts.deps.accountStore.findAccountById(auth.account_id);
      let sent = false;
      if (account?.telegram_chat_id != null) {
        const amount = formatCurrencyAmount(record.amountCents, record.currency);
        const text =
          parsed.data.mode === "detected_challenge"
            ? `🔐 3-D Secure required — approve the ${amount} payment to ${record.merchant} in your bank app to finish checkout.`
            : `🔐 Authentication may be happening out of band for the ${amount} payment to ${record.merchant}. Check your bank app for an approval request to finish checkout.`;
        sent = await sendTelegramMessage(account.telegram_chat_id, text);
      }
      return reply.code(200).send({ sent });
    },
  );

  fastify.get<{
    Params: { id: string };
    Querystring: {
      wait_for_submission?: string;
      read_submission?: string;
      peek_submission?: string;
    };
  }>("/v1/pay/approvals/:id", { preHandler: opts.requireAny }, async (req, reply) => {
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
    const canReadSubmission = req.auth!.kind === "agent" && status === "pending";
    const peekSubmission = req.query.peek_submission === "1";
    const submission = !canReadSubmission
      ? null
      : req.query.wait_for_submission === "1"
        ? await waitForSubmission(record.id, record.accountId, peekSubmission)
        : req.query.read_submission === "1" || peekSubmission
          ? await readSubmission(record.id, record.accountId, peekSubmission)
          : null;
    if (submission !== null && !peekSubmission)
      event("candidate_delivered", record, submissionFingerprint(submission), "ok");
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
  });

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
    const payloadHash = approvalPayloadHash(record);
    if (status === "pending" && payloadHash === null) {
      reply.code(409).send({ error: "payment_approval_binding_invalid" });
      return;
    }
    return reply.code(200).send({
      id: record.id,
      status,
      // Capability-link disclosure: these are the exact server-stored values
      // the later, single payment mandate must bind. No plaintext card secrets are included.
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
      expires_at: record.expiresAt.toISOString(),
      approval_payload_sha256: payloadHash?.toString("base64url") ?? null,
      card: card === null ? null : { blob: card.blob, label: card.label, last4: card.last4 },
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
    const binding = submissionBinding(parsed.data, record);
    candidateLifecycle(record, binding, "submission_received");
    if (binding === "invalid" || binding === "none") {
      candidateLifecycle(record, binding, "binding_rejected");
      reply.code(403).send({ error: "payment_approval_binding_mismatch" });
      return;
    }
    if (binding === "review") {
      const fingerprint = submissionFingerprint(parsed.data);
      event("review_submitted", record, fingerprint, "stale_payment_client");
      candidateLifecycle(record, "review", "stale_client_rejected");
      return reply.code(409).send({
        error: "stale_payment_client",
        message:
          "This payment approval page uses a retired review protocol. Refresh the page and " +
          "submit the final approval again.",
      });
    }
    const payloadHash = approvalPayloadHash(record);
    if (payloadHash === null) {
      reply.code(409).send({ error: "payment_approval_binding_invalid" });
      return;
    }
    try {
      await verifyVouch({
        jws: parsed.data.jws,
        expectedPayloadHash: payloadHash,
        expectedContext: PAYMENT_VOUCH_CONTEXT,
        expectedAudience: vouchflowAudience,
      });
    } catch (error) {
      const code =
        error instanceof VouchMandateVerificationError ? error.code : "mandate_verification_failed";
      candidateLifecycle(record, "approval", "signature_rejected");
      reply.code(code === "vouchflow_expected_audience_unset" ? 503 : 403).send({
        error: code,
      });
      return;
    }
    const submittedAt = opts.deps.now?.() ?? new Date();
    const fingerprint = submissionFingerprint(parsed.data);
    const submitted = await opts.deps.pendingPaymentApprovalStore.submitCandidate(
      record.id,
      record.accountId,
      { jws: parsed.data.jws, sealedCard: parsed.data.sealed_card, fingerprint },
      record.expiresAt,
      submittedAt,
    );
    if (submitted === "in_progress") {
      candidateLifecycle(record, "approval", "submission_in_progress");
      reply.code(409).send({ error: "payment_approval_in_progress" });
      return;
    }
    if (submitted !== "submitted") {
      candidateLifecycle(record, "approval", "submission_not_pending");
      reply.code(409).send({ error: "payment_approval_not_pending" });
      return;
    }
    candidateLifecycle(record, "approval", "submission_relayed");
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
      if (record.status !== "pending" && record.status !== "approved") {
        reply.code(409).send({ error: "payment_approval_candidate_changed" });
        return;
      }
      if (record.status === "pending" && record.expiresAt <= now) {
        reply.code(409).send({ error: "payment_approval_expired" });
        return;
      }
      const binding = submissionBinding(parsed.data, record);
      candidateLifecycle(record, binding, "confirmation_received");
      if (binding === "invalid" || binding === "none") {
        candidateLifecycle(record, binding, "confirmation_binding_rejected");
        reply.code(403).send({ error: "payment_approval_binding_mismatch" });
        return;
      }
      if (binding === "review") {
        if (record.status !== "pending") {
          reply.code(409).send({ error: "payment_approval_candidate_changed" });
          return;
        }
        const fingerprint = submissionFingerprint(parsed.data);
        event("review_confirm_received", record, fingerprint, "ok");
        const result = await opts.deps.pendingPaymentApprovalStore.confirmReviewCandidate(
          req.params.id,
          auth.account_id,
          fingerprint,
          now,
        );
        if (result !== "confirmed") {
          candidateLifecycle(record, "review", "confirmation_rejected");
          event("review_confirm_rejected", record, fingerprint, result);
          reply.code(409).send({ error: "payment_approval_candidate_changed" });
          return;
        }
        candidateLifecycle(record, "review", "verified_final_required");
        event("review_confirm_matched", record, fingerprint, "ok");
        return reply.code(200).send({ status: "verified" });
      }
      const payloadHash = approvalPayloadHash(record);
      if (payloadHash === null) {
        reply.code(409).send({ error: "payment_approval_binding_invalid" });
        return;
      }
      try {
        await verifyVouch({
          jws: parsed.data.jws,
          expectedPayloadHash: payloadHash,
          expectedContext: PAYMENT_VOUCH_CONTEXT,
          expectedAudience: vouchflowAudience,
          previouslyVerifiedRelay: true,
        });
      } catch (error) {
        const code =
          error instanceof VouchMandateVerificationError
            ? error.code
            : "mandate_verification_failed";
        candidateLifecycle(record, "approval", "confirmation_signature_rejected");
        reply.code(code === "vouchflow_expected_audience_unset" ? 503 : 403).send({
          error: code,
        });
        return;
      }
      const confirmed = await opts.deps.pendingPaymentApprovalStore.confirmCandidateForAccount(
        req.params.id,
        auth.account_id,
        submissionFingerprint(parsed.data),
        opts.deps.now?.() ?? new Date(),
      );
      if (confirmed !== "confirmed") {
        candidateLifecycle(record, "approval", "confirmation_rejected");
        reply.code(409).send({ error: "payment_approval_candidate_changed" });
        return;
      }
      candidateLifecycle(record, "approval", "approved");
      return reply.code(200).send({ status: "approved" });
    },
  );
};
