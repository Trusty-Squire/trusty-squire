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
import { CredentialNotFoundError, deriveAllowedHosts } from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";

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
