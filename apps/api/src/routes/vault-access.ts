// use_credential — the agent-facing server-side proxy.
//
//   POST /v1/vault/use   (agent)   { reference? | service?, http }
//
// The vault is a write-only sink: the secret is injected into the
// outbound request server-side and only the upstream response is
// returned — the plaintext never reaches the agent. The target host is
// HARD-ENFORCED against the credential's allowed_hosts (off-allowlist =
// 403), so the secret can only ever reach destinations the user
// pre-authorised. There is deliberately no raw-value extraction path and
// no per-call approval — the write-only-sink model is what makes that
// safe.

import { z } from "zod";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  AllowlistViolationError,
  CredentialNotFoundError,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";

const useBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    http: z.object({
      method: z.string().min(1).max(10),
      url: z.string().min(1).max(2048),
      headers: z.record(z.string()).optional(),
      body: z.string().max(64 * 1024).optional(),
    }),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

function proxyErrorStatus(code: ProxyError["code"]): number {
  switch (code) {
    case "secret_in_url":
    case "secret_in_method":
    case "secret_in_header_key":
    case "secret_unsafe_chars":
    case "header_too_large":
    case "invalid_url":
      return 400;
    case "not_https":
    case "blocked_address":
      return 403;
    case "concurrency_limit":
      return 429;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

export const registerVaultAccessRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // Injectable for tests (the SSRF guard would reject a loopback echo).
  proxyExecutor?: HttpProxyExecutor;
}> = async (fastify, opts) => {
  const executor = opts.proxyExecutor ?? new HttpProxyExecutor();

  fastify.post(
    "/v1/vault/use",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = useBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;

      // Resolve the credential — account-scoped.
      const owned = await opts.deps.credentialStore.listByAccount(auth.account_id);
      let reference: string | undefined;
      if (data.reference !== undefined) {
        reference = owned.find((c) => c.reference === data.reference)?.reference;
      } else {
        const matches = owned.filter(
          (c) =>
            typeof c.metadata.service === "string" &&
            c.metadata.service.toLowerCase() === data.service!.toLowerCase(),
        );
        if (matches.length > 1) {
          reply.code(409).send({
            error: "ambiguous_service",
            candidates: matches.map((c) => c.reference),
          });
          return;
        }
        reference = matches[0]?.reference;
      }
      if (reference === undefined) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }

      // Rebuild http without undefined-valued optionals (exactOptionalPropertyTypes).
      const http = {
        method: data.http.method,
        url: data.http.url,
        ...(data.http.headers !== undefined ? { headers: data.http.headers } : {}),
        ...(data.http.body !== undefined ? { body: data.http.body } : {}),
      };

      try {
        const response = await opts.deps.vault.proxy(
          reference,
          auth.account_id,
          http,
          (input) => executor.execute(input),
        );
        return reply.code(200).send({ response });
      } catch (err) {
        if (err instanceof AllowlistViolationError) {
          reply.code(403).send({
            error: "host_not_allowed",
            host: err.host,
            hint: "Add the host to this credential's allowed_hosts in /vault.",
          });
          return;
        }
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        if (err instanceof ProxyError) {
          reply.code(proxyErrorStatus(err.code)).send({ error: err.code });
          return;
        }
        throw err;
      }
    },
  );
};
