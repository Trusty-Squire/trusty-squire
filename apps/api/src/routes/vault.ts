// Vault API — the credential store the squire fills and the user reads.
//
//   GET  /v1/vault/credentials            → web + agent: metadata list
//        (incl. the vault reference), no secrets.
//   POST /v1/vault/credentials/:id/reveal  → web: decrypt one (audited).
//   POST /v1/vault/credentials             → agent: the squire stores a
//        key it collected during a signup.

import { z } from "zod";
import { ulid } from "ulid";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
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
      return reply.code(201).send({ reference: entry.reference, type: entry.type });
    },
  );
};
