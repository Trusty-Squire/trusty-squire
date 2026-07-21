// Vault API — credential CRUD (write-only sink, multi-field).
//
//   GET    /v1/vault/credentials                → web+agent: metadata
//   POST   /v1/vault/credentials                → agent: upsert store
//   POST   /v1/vault/credentials/manual         → web: upsert store
//   POST   /v1/vault/credentials/:id/reveal     → web: decrypt fields (human)
//   PATCH  /v1/vault/credentials/:id            → web: replace fields
//   DELETE /v1/vault/credentials/:id            → web: soft delete
//   PATCH  /v1/vault/credentials/:id/allowed-hosts → web: edit allowlist
//   PATCH  /v1/vault/credentials/:id/label      → web: rename entry
//   POST   /v1/vault/credentials/:id/fields     → web: add a field
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
  FieldExistsError,
  RestoreConflictError,
  deriveAllowedHosts,
  VAULT_AUDIT_TYPES,
  type VaultAuditType,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import type { EmailForwarder } from "../services/email-forwarder.js";
import { buildEmailForwarder } from "../services/webhook-forwarder.js";
import { clearSessionCookie } from "../auth/middleware.js";

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
    auth_strategy: z.enum(["api_key", "username_password"]).optional(),
    signin_url: z.string().url().max(2048).optional(),
    login_hosts: z.array(z.string().min(1).max(253)).max(20).optional(),
    // Hosts the capture observed (signup URL host, etc.) — unioned with the
    // service-name table so a new credential never lands with an empty
    // allowlist. Bare hosts or URLs; normalised server-side. Max 10.
    observed_hosts: z.array(z.string().min(1).max(256)).max(10).optional(),
    // How the provider expects the secret — drives the egress-grant proxy's
    // auto-injection. "bearer" (default) | "header:<name>" | "query:<param>".
    // Lets a non-bearer provider (ElevenLabs xi-api-key, query-param keys) work
    // with no per-service code — parseAuthShape reads it off metadata.
    auth_shape: z
      .string()
      .max(120)
      .regex(/^(bearer|header:.+|query:.+)$/, "auth_shape must be bearer|header:<name>|query:<param>")
      .optional(),
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

// Rename an entry — same bound as the store label (1..60).
const renameBody = z.object({
  label: z.string().min(1).max(60),
});

// Add ONE field to an existing entry. Additive only — a name collision
// is rejected (changing a value is the rotate/PATCH path).
const addFieldBody = z.object({
  name: z.string().min(1).max(120),
  value: z.string().min(1).max(8192),
});

// Destructive-action guard — an explicit confirm so a stray request can't
// delete an account.
const confirmDeleteBody = z.object({ confirm: z.literal(true) });

const DAY_MS = 24 * 60 * 60 * 1000;
// A credential is "stale" — due for rotation — once this many days have
// passed since it was last changed (rotated_at, or created_at if never
// rotated). Surfaced in the list so the web can nudge a rotation; not
// enforced. Env-overridable.
const ROTATION_STALE_DAYS = Number.parseInt(process.env.VAULT_ROTATION_STALE_DAYS ?? "90", 10);

// Rotation-age signal for a credential, for the web's "rotate me" nudge.
function rotationAge(
  rotatedAt: Date | null,
  createdAt: Date,
  now: Date,
): { last_changed_at: string; age_days: number; stale: boolean } {
  const lastChanged = rotatedAt ?? createdAt;
  const ageDays = Math.floor((now.getTime() - lastChanged.getTime()) / DAY_MS);
  return {
    last_changed_at: lastChanged.toISOString(),
    age_days: ageDays,
    stale: ageDays >= ROTATION_STALE_DAYS,
  };
}

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

const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.in", "com.br", "co.za", "com.cn",
  "github.io", "web.app", "firebaseapp.com", "pages.dev", "workers.dev",
  "vercel.app", "netlify.app", "herokuapp.com",
]);

function validLoginHost(host: string): boolean {
  if (host.includes("..") || host.startsWith(".") || host.endsWith(".")) return false;
  if (host.includes("xn--")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(host)) return false;
  return true;
}

function normaliseLoginHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    const suffix = normaliseHost(trimmed.slice(2));
    if (suffix === null || !validLoginHost(suffix)) return null;
    return `*.${suffix}`;
  }
  const host = normaliseHost(trimmed);
  return host !== null && validLoginHost(host) ? host : null;
}

function normaliseLoginHosts(rawHosts: string[] | undefined): string[] | undefined | null {
  if (rawHosts === undefined) return undefined;
  const hosts: string[] = [];
  for (const raw of rawHosts) {
    const host = normaliseLoginHost(raw);
    if (host === null) return null;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

export const registerVaultRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  emailForwarder?: EmailForwarder;
}> = async (fastify, opts) => {
  // Defaults to an env-configured forwarder (no-op when RESEND_API_KEY is
  // unset); tests inject a stub. Powers the "new key added" notification.
  const forwarder = buildEmailForwarder(opts.emailForwarder);
  // ── list (web + agent): metadata only, no secret values ──────
  fastify.get(
    "/v1/vault/credentials",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
      const now = opts.deps.now?.() ?? new Date();
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
            auth_strategy: typeof c.metadata.auth_strategy === "string" ? c.metadata.auth_strategy : null,
            signin_url: typeof c.metadata.signin_url === "string" ? c.metadata.signin_url : null,
            login_hosts: Array.isArray(c.metadata.login_hosts)
              ? c.metadata.login_hosts.filter((h): h is string => typeof h === "string")
              : [],
            favicon_domain: faviconDomain(service, c.allowed_hosts),
            created_at: c.created_at.toISOString(),
            rotated_at: c.rotated_at?.toISOString() ?? null,
            last_retrieved_at: c.last_retrieved_at?.toISOString() ?? null,
            retrieval_count: c.retrieval_count,
            // Rotation-age nudge: age since last change + a stale flag.
            ...rotationAge(c.rotated_at, c.created_at, now),
          };
        }),
      });
    },
  );

  // ── audit timeline (web only): who-touched-my-keys ───────────
  // The full event trail for the account — stored/retrieved/rotated/
  // deleted/proxy_executed/proxy_rejected — newest first, paginated by
  // the `before` keyset cursor. Payloads carry NO secret values.
  // Account-scoped, no secret values (references / requesters / outcomes /
  // proxy forensics only). Readable by the human in the web UI AND by the
  // account's own agent ("show me everything that touched my keys"), since
  // both are bound to the same account and the agent already lists creds +
  // mints grants on it — the audit trail exposes strictly less.
  fastify.get(
    "/v1/vault/audit",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const auth = req.auth!;
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
      // Bot stores happen with no human watching, so a new key gets a
      // "key added" notification. Re-stores (rotation) don't — they're
      // expected churn, not a surprise the user needs flagged.
      return storeUpsert(opts, auth.account_id, req, reply, "squire", forwarder, true);
    },
  );

  // ── store (web manual paste): upsert ─────────────────────────
  fastify.post(
    "/v1/vault/credentials/manual",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      // The user is in the UI doing this by hand — no notification.
      return storeUpsert(opts, auth.account_id, req, reply, "manual", forwarder, false);
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
      await opts.deps.vault.delete(target.reference, auth.account_id);
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

  // ── account deletion (web only): GDPR hard delete ────────────
  // Right-to-be-forgotten: irreversibly delete the whole account.
  //   1. purge every credential row + the entire vault audit trail
  //   2. delete machine tokens paired to the account
  //   3. delete the account identity — cascades OAuth identities,
  //      devices, mandate, and web/agent sessions (FK onDelete: Cascade)
  //   4. clear the session cookie so the caller is signed out
  // Leaves nothing. Requires explicit confirm.
  fastify.delete(
    "/v1/vault/account",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = confirmDeleteBody.safeParse(req.body);
      if (!parsed.success || parsed.data.confirm !== true) {
        reply.code(400).send({ error: "confirmation_required", message: "pass { confirm: true } to permanently delete your account" });
        return;
      }
      const purged = await opts.deps.vault.purgeAccount(auth.account_id);
      const machine_tokens_deleted = await opts.deps.machineTokenStore.deleteByAccount(auth.account_id);
      // Revoke the acting session explicitly so the kill is immediate in any
      // store; deleting the account row then cascade-removes all remaining
      // web/agent sessions (FK onDelete: Cascade) in Postgres.
      await opts.deps.sessionStore.revoke(auth.jwt_id, "account_deleted");
      await opts.deps.accountStore.deleteAccount(auth.account_id);
      clearSessionCookie(reply);
      return reply.code(200).send({ ...purged, machine_tokens_deleted, account_deleted: true });
    },
  );

  // ── health (web only): envelope integrity probe ─────────────
  // Confirms the credential still decrypts under the current KMS keyring
  // (catches rot from a botched master-key rotation). No secret returned,
  // no upstream call, no retrieval counted.
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/health",
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
      const result = await opts.deps.vault.checkHealth(target.reference, auth.account_id);
      // 200 with healthy:false — the probe ran successfully and found the
      // envelope unhealthy; that's a valid result, not a request error.
      return reply.code(200).send({ id: target.id, ...result, checked_at: new Date().toISOString() });
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

  // ── edit sign-in (login) hosts (web) ─────────────────────────
  // The username/password twin of allowed-hosts: sets metadata.login_hosts —
  // the sign-in pages where a browser-fill login may be sealed — and stamps
  // auth_strategy, so setting hosts on a plain multi-field entry converts it
  // into a proper login credential.
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/login-hosts",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = allowedHostsBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const normalised = normaliseLoginHosts(parsed.data.hosts);
      if (normalised === null) {
        reply.code(400).send({ error: "invalid_login_hosts" });
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
      await opts.deps.credentialStore.setLoginHosts(target.reference, normalised ?? []);
      return reply.code(200).send({ login_hosts: normalised ?? [] });
    },
  );

  // ── rename entry (web) ───────────────────────────────────────
  // Changes the entry's label only — non-secret metadata, no re-encrypt.
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/label",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = renameBody.safeParse(req.body);
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
        const result = await opts.deps.vault.rename(
          target.reference,
          auth.account_id,
          parsed.data.label,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        if (err instanceof RestoreConflictError) {
          reply.code(409).send({ error: "rename_conflict", message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── add a field to an entry (web) ────────────────────────────
  // Additive: the server decrypts the existing blob, merges the new
  // field, and re-encrypts (the UI can't supply existing values — the
  // vault is write-only across this boundary). Name collision → 409.
  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/fields",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = addFieldBody.safeParse(req.body);
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
        const result = await opts.deps.vault.addField(
          target.reference,
          auth.account_id,
          parsed.data.name,
          parsed.data.value,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof FieldExistsError) {
          reply.code(409).send({ error: "field_exists", field: err.field });
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
};

async function storeUpsert(
  opts: { deps: ApiDeps },
  accountId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  source: string,
  forwarder: EmailForwarder,
  notifyOnCreate: boolean,
): Promise<void> {
  const parsed = storeBody.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const loginHosts = normaliseLoginHosts(data.login_hosts);
  if (loginHosts === null) {
    reply.code(400).send({ error: "invalid_login_hosts" });
    return;
  }
  const authStrategy = data.auth_strategy ?? (data.type === "username_password" ? "username_password" : undefined);
  if ((data.type === "username_password" || authStrategy === "username_password") && (loginHosts === undefined || loginHosts.length === 0)) {
    reply.code(400).send({ error: "login_hosts_required" });
    return;
  }
  const entry = await opts.deps.vault.store({
    account_id: accountId,
    subscription_id: ulid(),
    service: data.service,
    ...(data.label !== undefined ? { label: data.label } : {}),
    fields: fieldsFrom(data),
    ...(data.type !== undefined ? { type: data.type } : {}),
    ...(data.env_var_suggestion !== undefined ? { env_var_suggestion: data.env_var_suggestion } : {}),
    ...(data.observed_hosts !== undefined ? { observed_hosts: data.observed_hosts } : {}),
    metadata: {
      source,
      ...(data.auth_shape !== undefined ? { auth_shape: data.auth_shape } : {}),
      ...(authStrategy !== undefined ? { auth_strategy: authStrategy } : {}),
      ...(data.signin_url !== undefined ? { signin_url: data.signin_url } : {}),
      ...(loginHosts !== undefined ? { login_hosts: loginHosts } : {}),
    },
  });
  // Notify the user that a key landed in their vault unattended. Only on
  // a fresh create (not a rotation), and never fatal to the store —
  // failures are swallowed so a misconfigured mailer can't break signups.
  if (notifyOnCreate && !entry.updated) {
    await notifyNewKey(opts.deps, forwarder, accountId, entry.service, entry.label);
  }
  reply.code(entry.updated ? 200 : 201).send({
    reference: entry.reference,
    service: entry.service,
    label: entry.label,
    field_names: entry.field_names,
    type: data.type ?? "api_key",
    auth_strategy: authStrategy ?? null,
    signin_url: data.signin_url ?? null,
    login_hosts: loginHosts ?? [],
    allowed_hosts: entry.allowed_hosts,
    created_at: entry.created_at,
    updated: entry.updated,
  });
}

// Best-effort "a new key was added to your vault" email. Resolves the
// account's address, sends via the forwarder, and SWALLOWS every failure
// (no account, no email, mailer down) — a notification must never break
// the store that triggered it.
async function notifyNewKey(
  deps: ApiDeps,
  forwarder: EmailForwarder,
  accountId: string,
  service: string,
  label: string,
): Promise<void> {
  try {
    const account = await deps.accountStore.findAccountById(accountId);
    if (account === null || account.email.length === 0) return;
    const labelSuffix = label && label !== "default" ? ` (${label})` : "";
    await forwarder.sendDirect({
      to: account.email,
      subject: `Trusty Squire: new ${service} key added to your vault`,
      text: [
        `A new ${service}${labelSuffix} credential was just added to your Trusty Squire vault.`,
        ``,
        `If this was you (or your agent provisioning ${service}), no action is needed.`,
        `If you didn't expect this, open your vault to review or revoke it — and use`,
        `"revoke all" if anything looks wrong.`,
        ``,
        `— Trusty Squire`,
      ].join("\n"),
    });
  } catch {
    // Intentionally swallowed — see the doc comment.
  }
}
