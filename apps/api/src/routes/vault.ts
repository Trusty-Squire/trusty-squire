// Vault API — the credential store the squire fills and the user reads.
//
//   GET    /v1/vault/credentials               → web + agent: metadata
//          list (incl. the vault reference + allowed_hosts), no secrets.
//   POST   /v1/vault/credentials/:id/reveal     → web: decrypt one (audited).
//   POST   /v1/vault/credentials                → agent: the squire stores
//          a key it collected during a signup.
//   POST   /v1/vault/credentials/manual         → web: the user pastes a
//          key directly into the vault UI.
//   PATCH  /v1/vault/credentials/:id            → web: rotate the value.
//   DELETE /v1/vault/credentials/:id            → web: soft-delete.
//   PATCH  /v1/vault/credentials/:id/allowed-hosts → web: edit the
//          advisory host allowlist.
//
// Every :id-taking route resolves the credential with a single
// account-scoped query (findByIdForAccount) — never load-then-check —
// so a guessed id can't reach another account's credential.

import { z } from "zod";
import { ulid } from "ulid";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { CredentialNotFoundError } from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";

const writeBody = z.object({
  service: z.string().min(1).max(120),
  value: z.string().min(1).max(8192),
  env_var_suggestion: z.string().min(1).max(120).optional(),
  type: z
    .enum([
      "api_key",
      "oauth_token",
      "username_password",
      "session_cookie",
      "secret",
      "totp_seed",
      "sso_metadata",
    ])
    .optional(),
});

const rotateBody = z.object({
  new_value: z.string().min(1).max(8192),
});

// Agent-side management selects by vault reference, not id.
const agentRotateBody = z.object({
  reference: z.string().min(1).max(400),
  new_value: z.string().min(1).max(8192),
});

const agentDeleteBody = z.object({
  reference: z.string().min(1).max(400),
});

const allowedHostsBody = z.object({
  hosts: z.array(z.string().min(1).max(253)).max(50),
});

// Normalise a user-supplied allowlist entry to a bare lowercase host.
// Tolerates a pasted URL ("https://api.openai.com/v1") by stripping the
// scheme + path; rejects anything left with whitespace or that doesn't
// look like a hostname. Returns null when the entry is unusable.
function normaliseHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.length === 0) return null;
  // Strip a scheme + everything from the first path/query separator.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  // Drop an optional port — the allowlist matches on host only.
  host = host.replace(/:\d+$/, "");
  if (host.length === 0 || /\s/.test(host)) return null;
  // A hostname is dot-separated labels of [a-z0-9-]; reject stray chars
  // so we never persist a URL fragment or wildcard glob.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

export const registerVaultRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  // Metadata only — never ships secret values or crypto blobs. Open to
  // both a web session (the user's vault UI) and a paired agent session
  // (a coding agent discovering what keys it can reuse).
  fastify.get(
    "/v1/vault/credentials",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      // Both `web` and `agent` auth contexts carry `account_id`.
      const auth = req.auth!;
      const creds = await opts.deps.credentialStore.listByAccount(
        auth.account_id,
      );
      return reply.code(200).send({
        credentials: creds.map((c) => ({
          id: c.id,
          // The vault reference — an agent passes this to
          // GET /v1/credentials/:reference to retrieve the secret.
          reference: c.reference,
          service:
            typeof c.metadata.service === "string" ? c.metadata.service : null,
          key_name: c.env_var_suggestion,
          type: c.type,
          allowed_hosts: c.allowed_hosts,
          created_at: c.created_at.toISOString(),
          last_retrieved_at: c.last_retrieved_at?.toISOString() ?? null,
          retrieval_count: c.retrieval_count,
        })),
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/reveal",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      // Ownership: only the account's own credentials are listable, so
      // resolving the id through listByAccount is the scoping boundary.
      const owned = await opts.deps.credentialStore.listByAccount(
        auth.account_id,
      );
      const target = owned.find((c) => c.id === req.params.id);
      if (target === undefined) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      let value: string;
      try {
        value = await opts.deps.vault.retrieveForRuntime(
          target.reference,
          "user:vault_reveal",
        );
      } catch (err) {
        reply.code(500).send({
          error: "reveal_failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      return reply
        .code(200)
        .send({ id: target.id, value, revealed_at: new Date().toISOString() });
    },
  );

  fastify.post(
    "/v1/vault/credentials",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = writeBody.safeParse(req.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;
      const entry = await opts.deps.vault.store({
        account_id: auth.account_id,
        // Universal-bot signups have no Subscription row; a per-
        // credential synthetic id keeps the vault reference well-formed.
        subscription_id: ulid(),
        type: data.type ?? "api_key",
        value: data.value,
        env_var_suggestion: data.env_var_suggestion ?? null,
        metadata: { service: data.service, source: "squire" },
      });
      return reply.code(201).send({
        reference: entry.reference,
        type: entry.type,
        created_at: entry.created_at,
        allowed_hosts: entry.allowed_hosts,
      });
    },
  );

  // Agent-driven rotate, by reference (the agent knows references, not
  // ids). Account-scoped: findActive returns the row + its account, and
  // we reject anything not owned by the caller — so a guessed reference
  // from another account 404s.
  fastify.post(
    "/v1/vault/credentials/rotate",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = agentRotateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const existing = await opts.deps.credentialStore.findActive(parsed.data.reference);
      if (existing === null || existing.account_id !== auth.account_id) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      const result = await opts.deps.vault.rotate(
        parsed.data.reference,
        parsed.data.new_value,
      );
      return reply.code(200).send(result);
    },
  );

  // Agent-driven delete, by reference. Same account-scoping gate.
  fastify.post(
    "/v1/vault/credentials/delete",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = agentDeleteBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const existing = await opts.deps.credentialStore.findActive(parsed.data.reference);
      if (existing === null || existing.account_id !== auth.account_id) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      await opts.deps.vault.delete(parsed.data.reference);
      return reply.code(200).send({ deleted_at: new Date().toISOString() });
    },
  );

  // Web paste — the user adds a key by hand from the /vault UI. Same
  // store path as the agent route, but web-authed and tagged
  // source:"manual". Returns the derived allowed_hosts so the UI can
  // show what the proxy will default to.
  fastify.post(
    "/v1/vault/credentials/manual",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = writeBody.safeParse(req.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;
      const entry = await opts.deps.vault.store({
        account_id: auth.account_id,
        // No Subscription row for a hand-pasted key either; a synthetic
        // id keeps the vault reference well-formed.
        subscription_id: ulid(),
        type: data.type ?? "api_key",
        value: data.value,
        env_var_suggestion: data.env_var_suggestion ?? null,
        metadata: { service: data.service, source: "manual" },
      });
      return reply.code(201).send({
        reference: entry.reference,
        type: entry.type,
        created_at: entry.created_at,
        allowed_hosts: entry.allowed_hosts,
      });
    },
  );

  // Rotate the stored value. Cascades to revoke outstanding persistent
  // access-grants (no grants exist until a later PR — revoked_grant_count
  // is 0 today). The reference is resolved by an account-scoped id
  // lookup, so a guessed id from another account 404s.
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = rotateBody.safeParse(req.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
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
        const result = await opts.deps.vault.rotate(
          target.reference,
          parsed.data.new_value,
        );
        return reply.code(200).send(result);
      } catch (err) {
        // The credential existed a moment ago (we just resolved it); a
        // CredentialNotFoundError here means it was deleted between the
        // lookup and the rotate — treat as 404, not 500.
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        throw err;
      }
    },
  );

  // Soft-delete. Idempotent at the store layer; the account-scoped
  // lookup is the ownership gate.
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

  // Edit the advisory host allowlist. Entries are normalised to bare
  // lowercase hosts (a pasted URL is tolerated); a malformed entry 400s
  // the whole request rather than silently dropping it.
  fastify.patch<{ Params: { id: string } }>(
    "/v1/vault/credentials/:id/allowed-hosts",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = allowedHostsBody.safeParse(req.body);
      if (!parsed.success) {
        reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const normalised: string[] = [];
      for (const raw of parsed.data.hosts) {
        const host = normaliseHost(raw);
        if (host === null) {
          reply
            .code(400)
            .send({ error: "invalid_host", value: raw });
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
      await opts.deps.credentialStore.setAllowedHosts(
        target.reference,
        normalised,
      );
      return reply.code(200).send({ allowed_hosts: normalised });
    },
  );
};
