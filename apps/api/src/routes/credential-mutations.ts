import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";
import {
  applyCredentialMetadataChanges,
  editableMetadata,
} from "../services/credential-metadata.js";
import { resolveCredentialForAccount } from "../services/credential-resolution.js";
import {
  mutationAuditEvent,
  type CredentialMutationApprovalRecord,
} from "../services/credential-mutation-approval-store.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { notifyVaultAuditAfterCommit } from "../services/vault-notify.js";
import {
  CREDENTIAL_MUTATION_VOUCH_CONTEXT,
  VouchMandateVerificationError,
  createVouchMandateVerifier,
  hashVouchPayload,
  type VouchMandateVerifier,
} from "../services/vouch-mandate.js";

const selector = {
  reference: z.string().min(1).max(400).optional(),
  service: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(60).optional(),
};

const hostEdit = z
  .object({
    mode: z.enum(["add", "remove", "replace"]),
    hosts: z.array(z.string().min(1).max(253)).max(50),
  })
  .strict();

const metadataChanges = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    allowed_hosts: hostEdit.optional(),
    login_hosts: hostEdit.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one editable metadata field is required",
  });

const editBody = z
  .object({
    operation: z.literal("edit"),
    ...selector,
    changes: metadataChanges,
  })
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );

const deleteBody = z
  .object({
    operation: z.literal("delete"),
    ...selector,
  })
  .strict()
  .refine(
    (value) =>
      value.reference !== undefined || value.service !== undefined || value.name !== undefined,
    { message: "one of reference, service, or name is required" },
  );

const createBody = z.union([editBody, deleteBody]);
const approveBody = z.object({ jws: z.string().min(1).max(8192) }).strict();
const requesterName = z.string().trim().min(1).max(256);

function webBaseUrl(): string {
  return (
    process.env.PWA_BASE_URL ?? process.env.TRUSTY_SQUIRE_WEB_BASE ?? "https://trustysquire.ai"
  );
}

export function credentialMutationPayload(record: CredentialMutationApprovalRecord): unknown {
  return {
    agent: record.agent,
    approval_id: record.id,
    credential: {
      label: record.credentialLabel,
      reference: record.credentialReference,
      service: record.credentialService,
    },
    mutation: {
      after: record.after,
      before: record.before,
      operation: `credential.${record.operation}`,
    },
    nonce: record.nonce,
  };
}

function mutationStatus(record: CredentialMutationApprovalRecord, now: Date): string {
  return record.status === "pending" && record.expiresAt <= now ? "expired" : record.status;
}

function approvalResponse(record: CredentialMutationApprovalRecord, now: Date) {
  return {
    approval_id: record.id,
    approval_url: `${webBaseUrl().replace(/\/+$/, "")}/vault/mutate/${encodeURIComponent(record.id)}`,
    status: mutationStatus(record, now),
    operation: record.operation,
    credential: {
      reference: record.credentialReference,
      service: record.credentialService,
      name: record.credentialLabel,
    },
    before: record.before,
    after: record.after,
    expires_at: record.expiresAt.toISOString(),
    ...(record.failureCode !== null ? { error: record.failureCode } : {}),
  };
}

function describeMetadata(
  prefix: string,
  metadata: CredentialMutationApprovalRecord["before"],
): string {
  return (
    `${prefix} name=${metadata.label}; ` +
    `allowed_hosts=[${metadata.allowed_hosts.join(", ")}]; ` +
    `login_hosts=[${metadata.login_hosts.join(", ")}]`
  );
}

function telegramPrompt(record: CredentialMutationApprovalRecord): string {
  const credential = `${record.credentialService ?? "credential"}/${record.credentialLabel}`;
  const link = `${webBaseUrl().replace(/\/+$/, "")}/vault/mutate/${record.id}`;
  if (record.operation === "delete") {
    return (
      `Trusty Squire — approve credential deletion\n` +
      `${credential}\n${record.credentialReference}\n${link}`
    );
  }
  return (
    `Trusty Squire — approve credential metadata edit\n` +
    `${credential}\n${record.credentialReference}\n` +
    `${describeMetadata("Before:", record.before)}\n` +
    `${describeMetadata("After:", record.after!)}\n${link}`
  );
}

async function sendMutationTelegram(deps: ApiDeps, record: CredentialMutationApprovalRecord) {
  const account = await deps.accountStore.findAccountById(record.accountId);
  if (account?.telegram_chat_id === null || account?.telegram_chat_id === undefined) return;
  void sendTelegramMessage(account.telegram_chat_id, telegramPrompt(record)).catch(() => {});
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

export const registerCredentialMutationRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  vouchVerifier?: VouchMandateVerifier;
}> = async (fastify, opts) => {
  const verifyVouch = opts.vouchVerifier ?? createVouchMandateVerifier();
  const vouchflowAudience = process.env.VOUCHFLOW_CUSTOMER_ID?.trim() ?? "";

  fastify.post(
    "/v1/vault/mutation-approvals",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
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
      const requester = requesterName.safeParse(req.headers["x-squire-agent-identity"]);
      const agent = requester.success ? requester.data : (auth.agent_identity ?? "unknown-agent");
      const before = editableMetadata(credential);
      let after = null;
      if (parsed.data.operation === "edit") {
        const applied = applyCredentialMetadataChanges(before, {
          ...(parsed.data.changes.label !== undefined ? { label: parsed.data.changes.label } : {}),
          ...(parsed.data.changes.allowed_hosts !== undefined
            ? { allowed_hosts: parsed.data.changes.allowed_hosts }
            : {}),
          ...(parsed.data.changes.login_hosts !== undefined
            ? { login_hosts: parsed.data.changes.login_hosts }
            : {}),
        });
        if ("error" in applied) {
          reply.code(400).send({ error: applied.error });
          return;
        }
        after = applied;
        const service =
          typeof credential.metadata.service === "string" ? credential.metadata.service : "";
        if (service.length > 0 && after.label !== before.label) {
          const conflict = await opts.deps.credentialStore.findActiveByServiceLabel(
            auth.account_id,
            service,
            after.label,
          );
          if (conflict !== null && conflict.reference !== credential.reference) {
            reply.code(409).send({ error: "credential_name_conflict" });
            return;
          }
        }
      }
      const intentHash = hashVouchPayload({
        agent,
        after,
        before,
        credential_reference: credential.reference,
        operation: parsed.data.operation,
      }).toString("base64url");
      const now = opts.deps.now?.() ?? new Date();
      const reusable = await opts.deps.credentialMutationApprovalStore.findReusablePending(
        auth.account_id,
        intentHash,
        now,
      );
      if (reusable !== null) {
        await sendMutationTelegram(opts.deps, reusable);
        return reply.code(200).send(approvalResponse(reusable, now));
      }

      const id = await opts.deps.credentialMutationApprovalStore.create(auth.account_id, {
        operation: parsed.data.operation,
        credentialReference: credential.reference,
        credentialService:
          typeof credential.metadata.service === "string" ? credential.metadata.service : null,
        credentialLabel: credential.label,
        before,
        after,
        nonce: randomBytes(16).toString("base64url"),
        agent,
        intentHash,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      });
      const record = await opts.deps.credentialMutationApprovalStore.getById(id);
      if (record === null) throw new Error("credential mutation approval disappeared after create");
      await sendMutationTelegram(opts.deps, record);
      return reply.code(201).send(approvalResponse(record, now));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/mutation-approvals/:id",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const record = await opts.deps.credentialMutationApprovalStore.getByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "credential_mutation_approval_not_found" });
        return;
      }
      return reply.code(200).send(approvalResponse(record, opts.deps.now?.() ?? new Date()));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/mutation-approvals/:id/ceremony",
    async (req, reply) => {
      const record = await opts.deps.credentialMutationApprovalStore.getById(req.params.id);
      if (record === null) {
        reply.code(404).send({ error: "credential_mutation_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      return reply.code(200).send({
        ...approvalResponse(record, now),
        payload: credentialMutationPayload(record),
        payload_sha256: hashVouchPayload(credentialMutationPayload(record)).toString("base64url"),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/mutation-approvals/:id/approve",
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const record = await opts.deps.credentialMutationApprovalStore.getById(req.params.id);
      if (record === null) {
        reply.code(404).send({ error: "credential_mutation_approval_not_found" });
        return;
      }
      const now = opts.deps.now?.() ?? new Date();
      if (record.status !== "pending" && record.status !== "approved") {
        reply.code(409).send({ error: "credential_mutation_approval_not_pending" });
        return;
      }
      if (record.status !== "approved" && record.expiresAt <= now) {
        reply.code(409).send({ error: "credential_mutation_approval_expired" });
        return;
      }

      let claims;
      try {
        claims = await verifyVouch({
          jws: parsed.data.jws,
          expectedPayloadHash: hashVouchPayload(credentialMutationPayload(record)),
          expectedContext: CREDENTIAL_MUTATION_VOUCH_CONTEXT,
          expectedAudience: vouchflowAudience,
        });
      } catch (error) {
        const code =
          error instanceof VouchMandateVerificationError
            ? error.code
            : "mandate_verification_failed";
        reply.code(code === "vouchflow_expected_audience_unset" ? 503 : 403).send({
          error: code,
        });
        return;
      }

      // Idempotent retries still prove possession of a valid mandate. The
      // mutation is not repeated, but an arbitrary string must never be
      // accepted as approval merely because execution already finished.
      if (record.status === "approved") {
        return reply.code(200).send({ status: "approved", operation: record.operation });
      }

      const commitNow = opts.deps.now?.() ?? new Date();
      const mandateId = typeof claims.mandate_id === "string" ? claims.mandate_id : null;
      const result = await opts.deps.credentialMutationApprovalStore.commit(
        record.id,
        mandateId,
        commitNow,
      );
      if (result === "already_approved") {
        return reply.code(200).send({ status: "approved", operation: record.operation });
      }
      if (result === "expired") {
        reply.code(409).send({ error: "credential_mutation_approval_expired" });
        return;
      }
      if (result === "credential_not_found") {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      if (result === "metadata_changed") {
        reply.code(409).send({ error: "credential_metadata_changed" });
        return;
      }
      if (result === "name_conflict") {
        reply.code(409).send({ error: "credential_name_conflict" });
        return;
      }
      if (result !== "approved") {
        reply.code(409).send({ error: "credential_mutation_approval_not_pending" });
        return;
      }
      notifyVaultAuditAfterCommit(opts.deps.vaultAuditStore, mutationAuditEvent(record));
      return reply.code(200).send({ status: "approved", operation: record.operation });
    },
  );
};
