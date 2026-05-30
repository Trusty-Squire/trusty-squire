// Vault API — credential CRUD (write-only sink, multi-field).
//
//   GET    /v1/vault/credentials                → web+agent: metadata
//   POST   /v1/vault/credentials                → agent: upsert store
//   POST   /v1/vault/credentials/manual         → web: upsert store
//   POST   /v1/vault/credentials/:id/reveal     → web: decrypt fields (human)
//   PATCH  /v1/vault/credentials/:id            → web: replace fields
//   DELETE /v1/vault/credentials/:id            → web: soft delete
//   PATCH  /v1/vault/credentials/:id/allowed-hosts → web: edit allowlist
//
// store is an upsert keyed (account, service, label) — re-storing a
// service overwrites it (that IS rotation). Agents cannot rotate or
// delete: rotation = re-store; delete is human-only here. The raw value
// is never returned to an agent; reveal is web-session only.

import { z } from "zod";
import { ulid } from "ulid";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  CredentialNotFoundError,
  RestoreConflictError,
  deriveAllowedHosts,
  VAULT_AUDIT_TYPES,
  type VaultAuditType,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";

const AUDIT_TYPE_VALUES = Object.values(VAULT_AUDIT_TYPES) as [VaultAuditType, ...VaultAuditType[]];

// GET /v1/vault/audit query: keyset pagination + optional filters.
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
  type: z.enum(AUDIT_TYPE_VALUES).optional(),
  reference: z.string().min(1).max(256).optional(),
});

// Brand domain for the vault UI's favicon, independent of the proxy
// allowlist. Existing credentials predate the allowed_hosts column (it
// backfilled to []), so we fall back to the canonical service→host map.
// Reduce to the registrable domain (last two labels) so the favicon
// resolves to the brand site — api.anthropic.com → anthropic.com,
// app.posthog.com → posthog.com — rather than an API/app subdomain that
// often serves no icon. (Doesn't handle multi-part TLDs like .co.uk, but
// none of the known services use one.)
function faviconDomain(service: string | null, allowedHosts: string[]): string | null {
  const host = allowedHosts[0] ?? (service !== null ? deriveAllowedHosts(service)[0] : undefined);
  if (host === undefined) return null;
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

// A credential is either a single `value` or a named-field map. The bot
// + "paste a key" path send `value`; AWS-style creds send `fields`.
const storeBody = z
  .object({
    service: z.string().min(1).max(120),
    label: z.string().min(1).max(60).optional(),
    value: z.string().min(1).max(8192).optional(),
    fields: z.record(z.string().min(1).max(8192)).optional(),
    env_var_suggestion: z.string().min(1).max(120).optional(),
    type: z.string().min(1).max(60).optional(),
  })
  .refine((b) => b.value !== undefined || (b.fields !== undefined && Object.keys(b.fields).length > 0), {
    message: "one of value or fields is required",
  });

const patchBody = z
  .object({
    value: z.string().min(1).max(8192).optional(),
    fields: z.record(z.string().min(1).max(8192)).optional(),
  })
  .refine((b) => b.value !== undefined || (b.fields !== undefined && Object.keys(b.fields).length > 0), {
    message: "one of value or fields is required",
  });

const allowedHostsBody = z.object({
  hosts: z.array(z.string().min(1).max(253)).max(50),
});

// Kill-switch guard — an explicit confirm so a stray POST can't nuke a vault.
const revokeAllBody = z.object({ confirm: z.literal(true) });

function fieldsFrom(b: { value?: string | undefined; fields?: Record<string, string> | undefined }): Record<string, string> {
  if (b.fields !== undefined && Object.keys(b.fields).length > 0) return b.fields;
  return { value: b.value! };
}

function normaliseHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.length === 0) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/:\d+$/, "");
  if (host.length === 0 || /\s/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

export const registerVaultRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  // ── list (web + agent): metadata only, no secret values ──────
  fastify.get(
    "/v1/vault/credentials",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const creds = await opts.deps.credentialStore.listByAccount(auth.account_id);
      return reply.code(200).send({
        credentials: creds.map((c) => {
          const service = typeof c.metadata.service === "string" ? c.metadata.service : null;
          return {
            id: c.id,
            reference: c.reference,
            service,
            label: c.label,
            field_names: c.field_names,
            key_name: c.env_var_suggestion,
            type: c.type,
            allowed_hosts: c.allowed_hosts,
            favicon_domain: faviconDomain(service, c.allowed_hosts),
            created_at: c.created_at.toISOString(),
            last_retrieved_at: c.last_retrieved_at?.toISOString() ?? null,
            retrieval_count: c.retrieval_count,
          };
        }),
      });
    },
  );

  // ── audit timeline (web only): who-touched-my-keys ───────────
  // The full event trail for the account — stored/retrieved/rotated/
  // deleted/proxy_executed/proxy_rejected — newest first, paginated by
  // the `before` keyset cursor. Payloads carry NO secret values.
  fastify.get(
    "/v1/vault/audit",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = auditQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const events = await opts.deps.vault.listAudit(auth.account_id, {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.before !== undefined ? { before: new Date(q.before) } : {}),
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.reference !== undefined ? { reference: q.reference } : {}),
      });
      const last = events.at(-1);
      return reply.code(200).send({
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          emitted_at: e.emitted_at.toISOString(),
          // Whole payload is non-secret by construction (references,
          // requesters, outcomes, proxy forensics — never a key value).
          ...e.payload,
        })),
        // Keyset cursor for the next page; null when this page wasn't full.
        next_before: events.length === (q.limit ?? 50) && last !== undefined
          ? last.emitted_at.toISOString()
          : null,
      });
    },
  );

  // ── reveal (web only): decrypt fields for the human ──────────
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/reveal",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const target = await opts.deps.credentialStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (target === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      try {
        const fields = await opts.deps.vault.reveal(target.reference, auth.account_id);
        return reply.code(200).send({ id: target.id, fields, revealed_at: new Date().toISOString() });
      } catch (err) {
        reply.code(500).send({
          error: "reveal_failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    },
  );

  // ── store (agent): upsert ────────────────────────────────────
  fastify.post(
    "/v1/vault/credentials",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      return storeUpsert(opts, auth.account_id, req, reply, "squire");
    },
  );

  // ── store (web manual paste): upsert ─────────────────────────
  fastify.post(
    "/v1/vault/credentials/manual",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      return storeUpsert(opts, auth.account_id, req, reply, "manual");
    },
  );

  // ── replace fields (web): rotate / field edit ────────────────
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = patchBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const target = await opts.deps.credentialStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (target === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      try {
        const result = await opts.deps.vault.replaceFields(
          target.reference,
          auth.account_id,
          fieldsFrom(parsed.data),
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        throw err;
      }
    },
  );

  // ── delete (web only) ────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const target = await opts.deps.credentialStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (target === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      await opts.deps.vault.delete(target.reference);
      return reply.code(204).send();
    },
  );

  // ── GDPR export (web only): everything we hold ───────────────
  // The complete, machine-readable record of the account's vault: every
  // credential's non-secret metadata (active + deleted) plus the full
  // audit trail. No secret values. Served as a download.
  fastify.get(
    "/v1/vault/export",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const data = await opts.deps.vault.exportAccount(auth.account_id);
      return reply
        .code(200)
        .header("content-disposition", 'attachment; filename="trusty-squire-vault-export.json"')
        .send({ exported_at: new Date().toISOString(), ...data });
    },
  );

  // ── account erasure (web only): GDPR hard delete ─────────────
  // Right-to-be-forgotten: irreversibly purge every credential row AND
  // the entire audit trail for the account. Distinct from revoke-all
  // (soft, recoverable) — this leaves nothing. Requires explicit confirm.
  fastify.delete(
    "/v1/vault/account",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = revokeAllBody.safeParse(req.body);
      if (!parsed.success || parsed.data.confirm !== true) {
        reply.code(400).send({ error: "confirmation_required", message: "pass { confirm: true } to permanently erase all vault data" });
        return;
      }
      const result = await opts.deps.vault.purgeAccount(auth.account_id);
      return reply.code(200).send(result);
    },
  );

  // ── revoke-all (web only): kill-switch ───────────────────────
  // One-shot soft-delete of every active credential for the account —
  // the "a key leaked, burn it all down" panic button. Requires an
  // explicit confirm flag so a stray POST can't nuke a vault. Recoverable
  // via restore until the retention sweep purges the soft-deleted rows.
  fastify.post(
    "/v1/vault/credentials/revoke-all",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = revokeAllBody.safeParse(req.body);
      if (!parsed.success || parsed.data.confirm !== true) {
        reply.code(400).send({ error: "confirmation_required", message: "pass { confirm: true } to revoke all credentials" });
        return;
      }
      const result = await opts.deps.vault.deleteAllForAccount(auth.account_id);
      return reply.code(200).send({ revoked: result.revoked });
    },
  );

  // ── restore (web only): undelete a soft-deleted credential ───
  // Soft-deletes are recoverable until a GDPR purge. Resurrects the row
  // unless a live (service,label) twin now occupies the slot (409).
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/restore",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const target = await opts.deps.credentialStore.findByIdForAccountIncludingDeleted(
        req.params.id,
        auth.account_id,
      );
      if (target === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      try {
        await opts.deps.vault.restore(target.reference, auth.account_id);
        return reply.code(200).send({ id: target.id, restored: true });
      } catch (err) {
        if (err instanceof RestoreConflictError) {
          reply.code(409).send({ error: "restore_conflict", message: err.message });
          return;
        }
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        throw err;
      }
    },
  );

  // ── edit allowed hosts (web) ─────────────────────────────────
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/allowed-hosts",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = allowedHostsBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const normalised: string[] = [];
      for (const raw of parsed.data.hosts) {
        const host = normaliseHost(raw);
        if (host === null) {
          reply.code(400).send({ error: "invalid_host", value: raw });
          return;
        }
        if (!normalised.includes(host)) normalised.push(host);
      }
      const target = await opts.deps.credentialStore.findByIdForAccount(
        req.params.id,
        auth.account_id,
      );
      if (target === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      await opts.deps.credentialStore.setAllowedHosts(target.reference, normalised);
      return reply.code(200).send({ allowed_hosts: normalised });
    },
  );
};

async function storeUpsert(
  opts: { deps: ApiDeps },
  accountId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  source: string,
): Promise<void> {
  const parsed = storeBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const entry = await opts.deps.vault.store({
    account_id: accountId,
    subscription_id: ulid(),
    service: data.service,
    ...(data.label !== undefined ? { label: data.label } : {}),
    fields: fieldsFrom(data),
    ...(data.type !== undefined ? { type: data.type } : {}),
    ...(data.env_var_suggestion !== undefined ? { env_var_suggestion: data.env_var_suggestion } : {}),
    metadata: { source },
  });
  reply.code(entry.updated ? 200 : 201).send({
    reference: entry.reference,
    service: entry.service,
    label: entry.label,
    field_names: entry.field_names,
    type: data.type ?? "api_key",
    allowed_hosts: entry.allowed_hosts,
    created_at: entry.created_at,
    updated: entry.updated,
  });
}
