// fetch_credential — approval-gated raw credential disclosure.
//
//   POST /v1/vault/fetch-approvals            → mint an approval, NO value
//   GET  /v1/vault/fetch-approvals/:id        → resume; value ONLY once approved
//   GET  /v1/vault/fetch-approvals/:id/ceremony → the exact payload to sign
//   POST /v1/vault/fetch-approvals/:id/approve  → passkey mandate lands here
//   POST /v1/vault/fetch-approvals/:id/deny     → the human refuses
//
// The three human-facing endpoints are OWNER-AUTHENTICATED: a signed-in web
// session whose account owns the credential, or nothing. Possession of the
// approval link is not authority — the agent that requested the fetch
// necessarily holds that link, so anyone it reaches could otherwise stand in
// for the owner and authorize the release of the owner's secret with their own
// genuine passkey.
//
// The vault is otherwise a write-only sink: `use_credential` spends a secret
// server-side and `extract { store }` puts one in without either ever crossing
// to the agent. This route is the ONE exception, and every property that makes
// it safe is enforced here, not in the client:
//
//   * disclosure runs only on a Vouchflow assertion signed over THIS approval's
//     payload under the fetch-only context — a mutation or payment mandate
//     hashes differently AND carries a different context, so neither can land;
//   * the human who signs is the credential's owner: the approve/deny/ceremony
//     endpoints require the owner's web session, and the signed payload itself
//     carries an opaque binding to the owning account;
//   * the approval is bound to (account, credential, field) at mint, and the
//     resume re-checks the account, so an approval minted by one account is
//     invisible to another;
//   * delivery is single-use — the store's approved → consumed transition is
//     what authorizes the decrypt, so a replayed approval_id yields nothing;
//   * expiry closes both halves: an unapproved and an approved-but-unclaimed
//     approval both go dead at expires_at.
//
// Every terminal outcome is audited under purpose `reveal` with the credential
// reference, the approval id, the approving account where a human settled it —
// and never the value. Outcomes reached after the decrypt (`success`,
// `field_set_changed`, `missing_credential`) are written by the vault; the
// rest go through recordCredentialFetchOutcome, which the retention cron
// shares so a lapsed approval swept from the table is still settled first.

import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CredentialFieldsChangedError,
  CredentialNotFoundError,
  VaultRateLimitError,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { resolveCredentialForAccount } from "../services/credential-resolution.js";
import type { CredentialFetchApprovalRecord } from "../services/credential-fetch-approval-store.js";
import {
  recordCredentialFetchOutcome,
  type CredentialFetchTerminalOutcome,
} from "../services/credential-fetch-audit.js";
import {
  approvalOwnership,
  approvalPageUrl,
  sendResolutionFailure,
  verifyApprovalMandate,
} from "../services/approval-ceremony.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { authenticatedRequester } from "../services/requesting-agent.js";
import {
  CREDENTIAL_FETCH_VOUCH_CONTEXT,
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

function approvalUrl(id: string): string {
  return approvalPageUrl("fetch", id);
}

// An opaque, purpose-specific digest of the owning account. Putting it inside
// the signed bytes means the human's passkey attests to WHOSE secret is being
// revealed, not merely which credential — and it does so without an account id
// travelling through the browser.
function accountBinding(accountId: string): string {
  return createHash("sha256")
    .update("trusty-squire/credential-fetch/account/v1\n")
    .update(accountId)
    .digest("base64url");
}

// What the passkey signs. `purpose` is inside the signed bytes as well as in
// the context, so the human's device attests to a REVEAL specifically.
export function credentialFetchPayload(record: CredentialFetchApprovalRecord): unknown {
  return {
    account_binding: accountBinding(record.accountId),
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
// someone asked and was told no. Callers must have performed the state
// transition first, so a polling agent produces one row, not one per poll.
async function recordOutcome(
  deps: ApiDeps,
  record: CredentialFetchApprovalRecord,
  outcome: CredentialFetchTerminalOutcome,
  approverAccountId?: string,
): Promise<void> {
  await recordCredentialFetchOutcome(deps.vaultAuditStore, record, outcome, approverAccountId);
}

async function settleExpired(
  deps: ApiDeps,
  record: CredentialFetchApprovalRecord,
  now: Date,
): Promise<void> {
  const settled = await deps.credentialFetchApprovalStore.expire(record.id, now);
  if (settled === "expired") await recordOutcome(deps, record, "expired");
}

// The raw value travels in this response body. Shared caches normally decline
// to store an authorized response, but "normally" is the wrong standard for a
// plaintext secret — say it explicitly on every reply the resume can produce.
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store, private");
}

/**
 * Load an approval on behalf of the HUMAN settling it. Anything but the owner's
 * own live web session gets 404 — and a foreign, authenticated attempt is
 * written to the owner's ledger, because "somebody else tried to release your
 * secret" is precisely what an audit trail exists to show.
 */
async function loadOwnedApproval(
  deps: ApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<CredentialFetchApprovalRecord | null> {
  const auth = req.auth!;
  const ownership = approvalOwnership(
    await deps.credentialFetchApprovalStore.getById(id),
    (record) => record.accountId,
    auth.account_id,
  );
  if (ownership.kind === "owner") return ownership.record;
  if (ownership.kind === "foreign") {
    await recordOutcome(deps, ownership.record, "approver_rejected", auth.account_id);
  }
  reply.code(404).send({ error: "credential_fetch_approval_not_found" });
  return null;
}

export const registerCredentialFetchRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // The human half of the ceremony is web-session only: an agent token is the
  // requester's authority, never the approver's.
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
      noStore(reply);
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
      // Disclose EXACTLY what the human approved, never what the credential
      // happens to hold now. A field added (web "add a field") or renamed
      // (rotation) between the ceremony and the claim would otherwise widen or
      // hollow out a disclosure that was signed over a different field set. The
      // vault applies the filter and audits the result of THAT, so the ledger
      // cannot say `success` for a disclosure that turned out empty.
      const approvedNames = record.field === null ? record.fieldNames : [record.field];
      let fields: Record<string, string>;
      try {
        fields = await opts.deps.vault.revealForApprovedFetch(
          record.credentialReference,
          record.accountId,
          record.id,
          approvedNames,
          // Who released the secret. The approve endpoint is owner-authenticated
          // (loadOwnedApproval), so the only account that can have signed this
          // approval is the record's own — the same value the `approved` row
          // carries. If approval on someone else's behalf is ever allowed, the
          // approver has to be persisted on the record and read from there.
          record.accountId,
        );
      } catch (error) {
        // Everything below this point has already BURNED the single-use
        // approval, so every branch has to leave a terminal row behind. The
        // vault writes its own (`missing_credential`, `field_set_changed`,
        // `rate_limited`); an unexpected decrypt/KMS/store failure has nobody
        // else to write it, and must not vanish into a bare 500.
        if (error instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        if (error instanceof CredentialFieldsChangedError) {
          reply.code(409).send({
            ...approvalResponse(record, now),
            error: "credential_fields_changed",
            field_names: error.fieldNames,
          });
          return;
        }
        if (error instanceof VaultRateLimitError) {
          reply.code(429).send({ error: "rate_limited", scope: "vault_retrieval" });
          return;
        }
        await recordOutcome(opts.deps, record, "internal_error");
        throw error;
      }
      return reply.code(200).send({
        ...approvalResponse(record, now),
        status: "consumed",
        fields,
        fetched_at: now.toISOString(),
      });
    },
  );

  // The exact bytes the owner's passkey will sign. Owner-authenticated like the
  // decisions themselves: handing the ceremony payload to anyone holding the
  // link is what lets a stranger produce a technically valid assertion.
  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/ceremony",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const record = await loadOwnedApproval(opts.deps, req, reply, req.params.id);
      if (record === null) return;
      const now = opts.deps.now?.() ?? new Date();
      return reply.code(200).send({
        ...approvalResponse(record, now),
        payload: credentialFetchPayload(record),
        payload_sha256: hashVouchPayload(credentialFetchPayload(record)).toString("base64url"),
      });
    },
  );

  // The human's YES. Two independent fences stand here, and both are needed:
  // the caller must hold the OWNING account's web session (a genuine passkey
  // belonging to a different Trusty Squire user must not release this secret),
  // and the assertion must be signed over this exact approval's payload.
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/approve",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const record = await loadOwnedApproval(opts.deps, req, reply, req.params.id);
      if (record === null) return;
      const now = opts.deps.now?.() ?? new Date();
      const status = publicStatus(record, now);
      if (status === "expired") {
        // Whoever notices the lapse first settles it, exactly once.
        await settleExpired(opts.deps, record, now);
        reply.code(409).send({ error: "credential_fetch_approval_expired" });
        return;
      }
      // `consumed` is deliberately absent: re-signing a delivered approval
      // must not look like it authorized a second delivery.
      if (status !== "pending" && status !== "approved") {
        reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
        return;
      }

      const claims = await verifyApprovalMandate(
        verifyVouch,
        {
          jws: parsed.data.jws,
          expectedPayloadHash: hashVouchPayload(credentialFetchPayload(record)),
          expectedContext: CREDENTIAL_FETCH_VOUCH_CONTEXT,
          expectedAudience: vouchflowAudience,
        },
        reply,
      );
      if (claims === null) return;

      const mandateId = typeof claims.mandate_id === "string" ? claims.mandate_id : null;
      const result = await opts.deps.credentialFetchApprovalStore.approve(record.id, mandateId);
      if (result === "expired") {
        await settleExpired(opts.deps, record, now);
        reply.code(409).send({ error: "credential_fetch_approval_expired" });
        return;
      }
      if (result === "not_pending") {
        reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
        return;
      }
      // The human said yes: an event in its own right, and the row that names
      // WHO said it. An approval that is never claimed would otherwise leave no
      // trace of the decision until it lapsed.
      if (result === "approved") {
        await recordOutcome(opts.deps, record, "approved", req.auth!.account_id);
      }
      return reply.code(200).send({ status: "approved" });
    },
  );

  // The human's NO. Owner-authenticated for the same reason as approve, plus
  // one of its own: an anonymous deny is a denial-of-service against the
  // owner's fetch, recorded in their ledger as if they had refused it.
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/fetch-approvals/:id/deny",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const record = await loadOwnedApproval(opts.deps, req, reply, req.params.id);
      if (record === null) return;
      const now = opts.deps.now?.() ?? new Date();
      const result = await opts.deps.credentialFetchApprovalStore.deny(record.id, now);
      if (result === "denied") {
        await recordOutcome(opts.deps, record, "denied", req.auth!.account_id);
        return reply.code(200).send({ status: "denied" });
      }
      if (result === "already_denied") return reply.code(200).send({ status: "denied" });
      // Lapsed before the human answered: settle it as the expiry it is rather
      // than logging a refusal nobody made.
      if (result === "expired") {
        await settleExpired(opts.deps, record, now);
        reply.code(409).send({ error: "credential_fetch_approval_expired" });
        return;
      }
      reply.code(409).send({ error: "credential_fetch_approval_not_pending" });
      return;
    },
  );
};
