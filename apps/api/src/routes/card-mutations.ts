import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";
import {
  cardMutationAuditEvent,
  type CardMutationApprovalRecord,
  type CardMutationMetadata,
} from "../services/card-mutation-approval-store.js";
import {
  approvalPageUrl,
  approvalWebBaseUrl,
  verifyApprovalMandate,
} from "../services/approval-ceremony.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { notifyVaultAuditAfterCommit } from "../services/vault-notify.js";
import { authenticatedRequester } from "../services/requesting-agent.js";
import {
  CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";

// edit_payment_card's API half — the saved-card analogue of
// routes/credential-mutations.ts, reusing the SAME passkey ceremony
// (same vouch context, same mandate verification, same approval-link +
// resume-with-approval_id flow, same 10-minute window). The one structural
// difference is decided by the card model: a card's fields live only inside
// the client-encrypted blob, so the agent proposes nothing but the target
// card. The human edits the fields in the browser, which decrypts locally,
// re-encrypts with the same sealed key, and submits the new opaque blob at
// approve time — the server never sees a card value, and the signed mandate
// covers the exact new blob the server will store.

const TELEGRAM_TEXT_LIMIT = 4096;

const createBody = z
  .object({
    operation: z.literal("edit_card"),
    card_id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => value.card_id !== undefined || value.label !== undefined, {
    message: "card_id or label is required",
  });

// Same shape and limits as the store route's e2eBody: the blob is opaque
// ciphertext, brand holds no digits (no full PAN can hide in it), last4 is
// exactly 4 digits.
const approveBody = z
  .object({
    jws: z.string().min(1).max(8192),
    blob: z.string().min(1).max(8192),
    label: z.string().min(1).max(256),
    brand: z
      .string()
      .regex(/^[A-Za-z][A-Za-z \-]{0,31}$/)
      .optional(),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
  })
  .strict();

function accountBinding(accountId: string): string {
  return createHash("sha256")
    .update("trusty-squire/card-mutation/account/v1\n")
    .update(accountId)
    .digest("base64url");
}

export function cardMetadataOf(card: {
  label: string;
  brand: string | null;
  last4: string | null;
}): CardMutationMetadata {
  return { label: card.label, brand: card.brand, last4: card.last4 };
}

// The exact payload the human's passkey signs. `after` is null on the
// ceremony page (the browser fills it in from the edited card) and must be
// present — and byte-identical to what this function builds — when the
// approve endpoint re-derives the payload from the submitted blob.
export function cardMutationPayload(
  record: CardMutationApprovalRecord,
  after: { label: string; brand: string | null; last4: string | null; blob: string } | null,
): unknown {
  return {
    account_binding: accountBinding(record.accountId),
    agent: record.agent,
    requester_kind: record.requesterKind,
    approval_id: record.id,
    card: {
      id: record.cardId,
      label: record.cardLabel,
      brand: record.before.brand,
      last4: record.before.last4,
    },
    mutation: {
      after:
        after === null
          ? null
          : { label: after.label, brand: after.brand, last4: after.last4, blob: after.blob },
      before: record.before,
      operation: `card.${record.operation}`,
    },
    nonce: record.nonce,
  };
}

function mutationStatus(record: CardMutationApprovalRecord, now: Date): string {
  return record.status === "pending" && record.expiresAt <= now ? "expired" : record.status;
}

function approvalResponse(
  record: CardMutationApprovalRecord,
  now: Date,
  currentCard?: CardMutationMetadata | null,
): Record<string, unknown> {
  const card: Record<string, unknown> =
    record.status === "approved" && record.after !== null
      ? { id: record.cardId, ...record.after }
      : currentCard !== undefined && currentCard !== null
        ? { id: record.cardId, ...currentCard }
        : { id: record.cardId, ...record.before };
  return {
    approval_id: record.id,
    approval_url: approvalPageUrl("mutate-card", record.id),
    status: mutationStatus(record, now),
    operation: record.operation,
    card,
    before: record.before,
    after: record.after,
    expires_at: record.expiresAt.toISOString(),
    ...(record.failureCode !== null ? { error: record.failureCode } : {}),
  };
}

function cardIdentity(record: CardMutationApprovalRecord): string {
  return record.before.last4 !== null
    ? `${record.before.label} •••• ${record.before.last4}`
    : record.before.label;
}

function telegramPrompt(record: CardMutationApprovalRecord): string {
  const link = `${approvalWebBaseUrl().replace(/\/+$/, "")}/vault/mutate-card/${record.id}`;
  const body =
    `Trusty Squire — approve card edit\n` +
    `${cardIdentity(record)}\ncard://${record.cardId}\n` +
    `You'll review and edit the card in the browser (expiry, name, billing — the server never sees card values), then confirm with your passkey.`;
  const suffix = `\nReview exact details: ${link}`;
  if (body.length + suffix.length <= TELEGRAM_TEXT_LIMIT) return `${body}${suffix}`;
  return `${body.slice(0, Math.max(0, TELEGRAM_TEXT_LIMIT - suffix.length))}${suffix}`;
}

async function sendCardMutationTelegram(deps: ApiDeps, record: CardMutationApprovalRecord) {
  const account = await deps.accountStore.findAccountById(record.accountId);
  if (account?.telegram_chat_id === null || account?.telegram_chat_id === undefined) return;
  void sendTelegramMessage(account.telegram_chat_id, telegramPrompt(record)).catch(() => {});
}

async function resolveCardForAccount(
  deps: ApiDeps,
  accountId: string,
  selector: { card_id?: string | undefined; label?: string | undefined },
  reply: FastifyReply,
): Promise<{ id: string; label: string; brand: string | null; last4: string | null } | null> {
  if (selector.card_id !== undefined) {
    const card = await deps.e2eCredentialStore.getByIdForAccount(selector.card_id, accountId);
    if (card === null) {
      reply.code(404).send({ error: "card_not_found" });
      return null;
    }
    return { id: card.id, label: card.label, brand: card.brand, last4: card.last4 };
  }
  const matches = (await deps.e2eCredentialStore.listByAccount(accountId)).filter(
    (card) => card.label === selector.label,
  );
  if (matches.length === 0) {
    reply.code(404).send({ error: "card_not_found" });
    return null;
  }
  if (matches.length > 1) {
    reply.code(409).send({
      error: "ambiguous_card",
      candidates: matches.map((card) => ({ id: card.id, label: card.label })),
    });
    return null;
  }
  const card = matches[0]!;
  return { id: card.id, label: card.label, brand: card.brand, last4: card.last4 };
}

export const registerCardMutationRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  vouchVerifier?: VouchMandateVerifier;
}> = async (fastify, opts) => {
  const verifyVouch = opts.vouchVerifier ?? createVouchMandateVerifier();
  const vouchflowAudience = process.env.VOUCHFLOW_CUSTOMER_ID?.trim() ?? "";

  fastify.post(
    "/v1/vault/card-mutation-approvals",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const card = await resolveCardForAccount(depsOf(opts), auth.account_id, parsed.data, reply);
      if (card === null) return;

      const agent = authenticatedRequester(auth);
      const requesterKind = auth.kind;
      const before = cardMetadataOf(card);
      const intentHash = hashVouchPayload({
        agent,
        requester_kind: requesterKind,
        before,
        card_id: card.id,
        operation: parsed.data.operation,
      }).toString("base64url");
      const now = opts.deps.now?.() ?? new Date();
      const reusable = await opts.deps.cardMutationApprovalStore.findReusablePending(
        auth.account_id,
        intentHash,
        now,
      );
      if (reusable !== null) {
        await sendCardMutationTelegram(opts.deps, reusable);
        return reply.code(200).send(approvalResponse(reusable, now));
      }

      const id = await opts.deps.cardMutationApprovalStore.create(auth.account_id, {
        operation: parsed.data.operation,
        cardId: card.id,
        cardLabel: card.label,
        before,
        after: null,
        nonce: randomBytes(16).toString("base64url"),
        agent,
        requesterKind,
        intentHash,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      });
      const record = await opts.deps.cardMutationApprovalStore.getById(id);
      if (record === null) throw new Error("card mutation approval disappeared after create");
      await sendCardMutationTelegram(opts.deps, record);
      return reply.code(201).send(approvalResponse(record, now));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/card-mutation-approvals/:id",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const record = await opts.deps.cardMutationApprovalStore.getByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "card_mutation_approval_not_found" });
        return;
      }
      return reply.code(200).send(approvalResponse(record, opts.deps.now?.() ?? new Date()));
    },
  );

  // The human half. Web session only, and the response carries the card's
  // current sealed blob so the owner's browser can decrypt locally — the
  // same disclosure GET /v1/vault/e2e/:id already makes to this account.
  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/card-mutation-approvals/:id/ceremony",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const record = await opts.deps.cardMutationApprovalStore.getByIdForAccount(
        req.params.id,
        req.auth!.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "card_mutation_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      const card = await opts.deps.e2eCredentialStore.getByIdForAccount(
        record.cardId,
        req.auth!.account_id,
      );
      if (card === null) {
        reply.code(404).send({ error: "card_not_found" });
        return;
      }
      const payload = cardMutationPayload(record, null);
      return reply.code(200).send({
        ...approvalResponse(record, now, cardMetadataOf(card)),
        blob: card.blob,
        payload,
        payload_sha256: hashVouchPayload(payload).toString("base64url"),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/card-mutation-approvals/:id/approve",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const record = await opts.deps.cardMutationApprovalStore.getByIdForAccount(
        req.params.id,
        req.auth!.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "card_mutation_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      if (record.status !== "pending" && record.status !== "approved") {
        reply.code(409).send({ error: "card_mutation_approval_not_pending" });
        return;
      }
      if (record.status !== "approved" && record.expiresAt <= now) {
        reply.code(409).send({ error: "card_mutation_approval_expired" });
        return;
      }

      const after = {
        label: parsed.data.label,
        blob: parsed.data.blob,
        brand: parsed.data.brand ?? null,
        last4: parsed.data.last4 ?? null,
      };
      const claims = await verifyApprovalMandate(
        verifyVouch,
        {
          jws: parsed.data.jws,
          expectedPayloadHash: hashVouchPayload(cardMutationPayload(record, after)),
          expectedContext: CREDENTIAL_MUTATION_VOUCH_CONTEXT,
          expectedAudience: vouchflowAudience,
        },
        reply,
      );
      if (claims === null) return;

      // Idempotent retries still prove possession of a valid mandate. The
      // mutation is not repeated, but an arbitrary string must never be
      // accepted as approval merely because execution already finished.
      if (record.status === "approved") {
        return reply.code(200).send({ status: "approved", operation: record.operation });
      }

      const mandateId = typeof claims.mandate_id === "string" ? claims.mandate_id : null;
      const result = await opts.deps.cardMutationApprovalStore.commit(
        record.id,
        mandateId,
        after,
      );
      if (result === "already_approved") {
        return reply.code(200).send({ status: "approved", operation: record.operation });
      }
      if (result === "expired") {
        reply.code(409).send({ error: "card_mutation_approval_expired" });
        return;
      }
      if (result === "card_not_found") {
        reply.code(404).send({ error: "card_not_found" });
        return;
      }
      if (result === "card_changed") {
        reply.code(409).send({ error: "card_changed" });
        return;
      }
      if (result !== "approved") {
        reply.code(409).send({ error: "card_mutation_approval_not_pending" });
        return;
      }
      notifyVaultAuditAfterCommit(
        opts.deps.vaultAuditStore,
        cardMutationAuditEvent(record, after),
      );
      return reply.code(200).send({ status: "approved", operation: record.operation });
    },
  );
};

function depsOf(opts: { deps: ApiDeps }): ApiDeps {
  return opts.deps;
}
