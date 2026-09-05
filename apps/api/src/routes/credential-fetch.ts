// fetch_credential — approval-gated raw credential disclosure.
//
//   POST /v1/vault/fetch-approvals            → mint an approval, NO value
//   GET  /v1/vault/fetch-approvals/:id        → resume; value ONLY once approved
//   GET  /v1/vault/fetch-approvals/:id/ceremony → the exact payload to sign
//   POST /v1/vault/fetch-approvals/:id/approve  → passkey mandate lands here
//   POST /v1/vault/fetch-approvals/:id/deny     → the human refuses
//
// The vault is otherwise a write-only sink: `use_credential` spends a secret
// server-side and `extract { store }` puts one in without either ever crossing
// to the agent. This route is the ONE exception, and every property that makes
// it safe is enforced here, not in the client:
//
//   * disclosure runs only on a Vouchflow assertion signed over THIS approval's
//     payload under the fetch-only context — a mutation or payment mandate
//     hashes differently AND carries a different context, so neither can land;
//   * the approval is bound to (account, credential, field) at mint, and the
//     resume re-checks the account, so an approval minted by one account is
//     invisible to another;
//   * delivery is single-use — the store's approved → consumed transition is
//     what authorizes the decrypt, so a replayed approval_id yields nothing;
//   * expiry closes both halves: an unapproved and an approved-but-unclaimed
//     approval both go dead at expires_at.
//
// Every terminal outcome is audited under purpose `reveal` with the credential
// reference and the approval id, and never the value.

import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CredentialNotFoundError,
  VAULT_AUDIT_TYPES,
  VAULT_REVEAL_PURPOSE,
  VaultRateLimitError,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { resolveCredentialForAccount } from "../services/credential-resolution.js";
import type { CredentialFetchApprovalRecord } from "../services/credential-fetch-approval-store.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { authenticatedRequester } from "../services/requesting-agent.js";
import {
  CREDENTIAL_FETCH_VOUCH_CONTEXT,
  VouchMandateVerificationError,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";

const APPROVAL_TTL_MS = 10 * 60 * 1000;

const createBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(60).optional(),
    field: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );

const approveBody = z.object({ jws: z.string().min(1).max(8192) }).strict();

function webBaseUrl(): string {
  return (
    process.env.PWA_BASE_URL ?? process.env.TRUSTY_SQUIRE_WEB_BASE ?? "https://trustysquire.ai"
  );
}

function approvalUrl(id: string): string {
  return `${webBaseUrl().replace(/\/+$/, "")}/vault/fetch/${encodeURIComponent(id)}`;
}

// What the passkey signs. `purpose` is inside the signed bytes as well as in
// the context, so the human's device attests to a REVEAL specifically.
export function credentialFetchPayload(record: CredentialFetchApprovalRecord): unknown {
  return {
    agent: record.agent,
    approval_id: record.id,
    credential: {
      label: record.credentialLabel,
      reference: record.credentialReference,
      service: record.credentialService,
    },
    fetch: {
      field: record.field,
      field_names: record.fieldNames,
      purpose: "credential.reveal",
    },
    nonce: record.nonce,
    requester_kind: record.requesterKind,
  };
}

export type CredentialFetchPublicStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "denied"
  | "expired"
  | "failed";

function publicStatus(
  record: CredentialFetchApprovalRecord,
  now: Date,
): CredentialFetchPublicStatus {
  return (record.status === "pending" || record.status === "approved") && record.expiresAt <= now
    ? "expired"
    : record.status;
}

function approvalResponse(record: CredentialFetchApprovalRecord, now: Date) {
  return {
    approval_id: record.id,
    approval_url: approvalUrl(record.id),
    status: publicStatus(record, now),
    credential: {
      reference: record.credentialReference,
      service: record.credentialService,
      name: record.credentialLabel,
    },
    field: record.field,
    field_names: record.fieldNames,
    expires_at: record.expiresAt.toISOString(),
    ...(record.failureCode !== null ? { error: record.failureCode } : {}),
  };
}

function telegramPrompt(record: CredentialFetchApprovalRecord): string {
  const credential = `${record.credentialService ?? "credential"}/${record.credentialLabel}`;
  return (
    `Trusty Squire — approve REVEALING a secret to an agent\n` +
    `${credential}\n${record.credentialReference}\n` +
    `Field: ${record.field ?? record.fieldNames.join(", ")}\n` +
    `Requested by: ${record.agent}\n` +
    `Approving hands the raw value to the agent, where it enters its transcript.\n` +
    `Review and approve: ${approvalUrl(record.id)}`
  );
}

async function sendFetchTelegram(deps: ApiDeps, record: CredentialFetchApprovalRecord) {
  const account = await deps.accountStore.findAccountById(record.accountId);
  if (account?.telegram_chat_id === null || account?.telegram_chat_id === undefined) return;
  void sendTelegramMessage(account.telegram_chat_id, telegramPrompt(record)).catch(() => {});
}

// A refused disclosure is as much a security event as a granted one: it says
// someone asked and was told no. Written straight to the audit store because
// no decrypt path ran to write it for us. Callers must have performed the
// state transition first, so a polling agent produces one row, not one per poll.
async function recordRefusal(
  deps: ApiDeps,
  record: CredentialFetchApprovalRecord,
  outcome: "denied" | "expired",
): Promise<void> {
  await deps.vaultAuditStore.record({
    account_id: record.accountId,
    type: VAULT_AUDIT_TYPES.retrieved,
    payload: {
      reference: record.credentialReference,
      requester: record.requesterKind === "web" ? "user" : "agent",
      purpose: VAULT_REVEAL_PURPOSE,
      outcome,
      approval_id: record.id,
      label: record.credentialLabel,
      ...(record.credentialService !== null ? { service: record.credentialService } : {}),
    },
  });
}

async function settleExpired(
  deps: ApiDeps,
  record: CredentialFetchApprovalRecord,
  now: Date,
): Promise<void> {
  const settled = await deps.credentialFetchApprovalStore.expire(record.id, now);
  if (settled === "expired") await recordRefusal(deps, record, "expired");
}

function sendResolutionFailure(
  resolution: Awaited<ReturnType<typeof resolveCredentialForAccount>>,
  reply: FastifyReply,
): boolean {
  if (resolution.kind === "found") return false;
  if (resolution.kind === "missing") {
    reply.code(404).send({ error: "credential_not_found" });
    return true;
  }
  reply.code(409).send({
    error: "ambiguous_credential",
    candidates: resolution.candidates.map((credential) => ({
      reference: credential.reference,
      service: typeof credential.metadata.service === "string" ? credential.metadata.service : null,
      name: credential.label,
    })),
  });
  return true;
}

export const registerCredentialFetchRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  vouchVerifier?: VouchMandateVerifier;
}> = async (fastify, opts) => {
  const verifyVouch = opts.vouchVerifier ?? createVouchMandateVerifier();
  const vouchflowAudience = process.env.VOUCHFLOW_CUSTOMER_ID?.trim() ?? "";

  fastify.post("/v1/vault/fetch-approvals", { preHandler: opts.requireAny }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const resolution = await resolveCredentialForAccount(
      opts.deps.credentialStore,
      auth.account_id,
      {
        ...(parsed.data.reference !== undefined ? { reference: parsed.data.reference } : {}),
        ...(parsed.data.service !== undefined ? { service: parsed.data.service } : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      },
    );
    if (sendResolutionFailure(resolution, reply)) return;
    if (resolution.kind !== "found") return;

    const credential = resolution.credential;
    const fieldNames = [...credential.field_names];
    // Field selection is settled BEFORE the human is asked, so the ceremony
    // states exactly which value is about to be disclosed. A multi-field
    // credential with no field named would otherwise reveal all of them on
    // the strength of an approval that never said so.
    const field = parsed.data.field ?? null;
    if (field !== null && !fieldNames.includes(field)) {
      reply.code(404).send({ error: "credential_field_not_found", field_names: fieldNames });
      return;
    }
    if (field === null && fieldNames.length > 1) {
      reply.code(409).send({ error: "ambiguous_credential_field", field_names: fieldNames });
      return;
    }

    const agent = authenticatedRequester(auth);
    const requesterKind = auth.kind;
    const intentHash = hashVouchPayload({
      agent,
      credential_reference: credential.reference,
      field,
      purpose: "credential.reveal",
      requester_kind: requesterKind,
    }).toString("base64url");
    const now = opts.deps.now?.() ?? new Date();
    const reusable = await opts.deps.credentialFetchApprovalStore.findReusablePending(
      auth.account_id,
      intentHash,
      now,
    );
    if (reusable !== null) {
      await sendFetchTelegram(opts.deps, reusable);
      return reply.code(200).send(approvalResponse(reusable, now));
    }

    const id = await opts.deps.credentialFetchApprovalStore.create(auth.account_id, {
      credentialReference: credential.reference,
      credentialService:
        typeof credential.metadata.service === "string" ? credential.metadata.service : null,
      credentialLabel: credential.label,
      field,
      fieldNames,
      nonce: randomBytes(16).toString("base64url"),
      agent,
      requesterKind,
      intentHash,
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    });
    const record = await opts.deps.credentialFetchApprovalStore.getById(id);
    if (record === null) throw new Error("credential fetch approval disappeared after create");
    await sendFetchTelegram(opts.deps, record);
    return reply.code(201).send(approvalResponse(record, now));
  });

  // The resume. This is the only place a raw value leaves the vault for an
  // agent, and it does so only on the store's single-use approved → consumed
  // claim.
  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const now = opts.deps.now?.() ?? new Date();
      const claim = await opts.deps.credentialFetchApprovalStore.claim(
        req.params.id,
        auth.account_id,
      );
      if (claim.kind === "not_found") {
        reply.code(404).send({ error: "credential_fetch_approval_not_found" });
        return;
      }
      if (claim.kind === "expired") {
        await settleExpired(opts.deps, claim.record, now);
        reply.code(409).send({
          ...approvalResponse(claim.record, now),
          status: "expired",
          error: "credential_fetch_approval_expired",
        });
        return;
      }
      if (claim.kind === "already_consumed") {
        reply.code(409).send({
          ...approvalResponse(claim.record, now),
          error: "credential_fetch_already_delivered",
        });
        return;
      }
      if (claim.kind === "not_approved") {
        const status = publicStatus(claim.record, now);
        // Still waiting on the human — not an error, just no value yet.
        if (status === "pending") return reply.code(200).send(approvalResponse(claim.record, now));
        // An unsigned approval that ran out the clock is an expiry, not a
        // "wrong state": the store only reports the stored status, so the
        // derived expiry has to be resolved here for both halves alike.
        if (status === "expired") {
          await settleExpired(opts.deps, claim.record, now);
          reply.code(409).send({
            ...approvalResponse(claim.record, now),
            error: "credential_fetch_approval_expired",
          });
          return;
        }
        reply.code(409).send({
          ...approvalResponse(claim.record, now),
          error:
            status === "denied"
              ? "credential_fetch_denied"
              : "credential_fetch_approval_not_pending",
        });
        return;
      }

      const record = claim.record;
      let fields: Record<string, string>;
      try {
        fields = await opts.deps.vault.revealForApprovedFetch(
          record.credentialReference,
          record.accountId,
          record.id,
        );
      } catch (error) {
        if (error instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        if (error instanceof VaultRateLimitError) {
          reply.code(429).send({ error: "rate_limited", scope: "vault_retrieval" });
          return;
        }
        throw error;
      }
      // Disclose EXACTLY what the human approved, never what the credential
      // happens to hold now. A field added (web "add a field") or renamed
      // (rotation) between the ceremony and the claim would otherwise widen or
      // hollow out a disclosure that was signed over a different field set.
      const approvedNames = record.field === null ? record.fieldNames : [record.field];
      const disclosed = Object.fromEntries(
        Object.entries(fields).filter(([name]) => approvedNames.includes(name)),
      );
      if (Object.keys(disclosed).length === 0) {
        reply.code(409).send({
          ...approvalResponse(record, now),
          error: "credential_fields_changed",
          field_names: Object.keys(fields),
        });
        return;
      }
      return reply.code(200).send({
        ...approvalResponse(record, now),
        status: "consumed",
        fields: disclosed,
        fetched_at: now.toISOString(),
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/ceremony",
    async (req, reply) => {
      const record = await opts.deps.credentialFetchApprovalStore.getById(req.params.id);
      if (record === null) {
        reply.code(404).send({ error: "credential_fetch_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      return reply.code(200).send({
        ...approvalResponse(record, now),
        payload: credentialFetchPayload(record),
        payload_sha256: hashVouchPayload(credentialFetchPayload(record)).toString("base64url"),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/approve",
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const record = await opts.deps.credentialFetchApprovalStore.getById(req.params.id);
      if (record === null) {
        reply.code(404).send({ error: "credential_fetch_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      const status = publicStatus(record, now);
      if (status === "expired") {
        reply.code(409).send({ error: "credential_fetch_approval_expired" });
        return;
      }
      // `consumed` is deliberately absent: re-signing a delivered approval
      // must not look like it authorized a second delivery.
      if (status !== "pending" && status !== "approved") {
        reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
        return;
      }

      let claims;
      try {
        claims = await verifyVouch({
          jws: parsed.data.jws,
          expectedPayloadHash: hashVouchPayload(credentialFetchPayload(record)),
          expectedContext: CREDENTIAL_FETCH_VOUCH_CONTEXT,
          expectedAudience: vouchflowAudience,
        });
      } catch (error) {
        const code =
          error instanceof VouchMandateVerificationError
            ? error.code
            : "mandate_verification_failed";
        reply
          .code(code === "vouchflow_expected_audience_unset" ? 503 : 403)
          .send({ error: code });
        return;
      }

      const mandateId = typeof claims.mandate_id === "string" ? claims.mandate_id : null;
      const result = await opts.deps.credentialFetchApprovalStore.approve(record.id, mandateId);
      if (result === "expired") {
        reply.code(409).send({ error: "credential_fetch_approval_expired" });
        return;
      }
      if (result === "not_pending") {
        reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
        return;
      }
      return reply.code(200).send({ status: "approved" });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/deny",
    async (req, reply) => {
      const record = await opts.deps.credentialFetchApprovalStore.getById(req.params.id);
      if (record === null) {
        reply.code(404).send({ error: "credential_fetch_approval_not_found" });
        return;
      }
      const result = await opts.deps.credentialFetchApprovalStore.deny(record.id);
      if (result === "denied") {
        await recordRefusal(opts.deps, record, "denied");
        return reply.code(200).send({ status: "denied" });
      }
      if (result === "already_denied") return reply.code(200).send({ status: "denied" });
      reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
      return;
    },
  );
};
