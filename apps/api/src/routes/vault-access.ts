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
import { constants, publicEncrypt } from "node:crypto";
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
      // Query-string auth (FRED etc.): { api_key: "${SECRET}" } — injected
      // server-side after the host check; secret never appears in `url`.
      query: z.record(z.string()).optional(),
    }),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

const browserFillBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    current_host: z.string().min(1).max(2048),
    fields: z.array(z.string().min(1).max(120)).min(1).max(20),
    encrypted_response_public_key: z.string().min(1).max(4096),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

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

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "org.au",
  "co.jp", "co.nz", "co.in", "com.br", "co.za", "com.cn",
  "github.io", "web.app", "firebaseapp.com", "pages.dev", "workers.dev",
  "vercel.app", "netlify.app", "herokuapp.com",
]);

function loginHostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (suffix.split(".").length < 2 || TWO_LABEL_PUBLIC_SUFFIXES.has(suffix)) return false;
    return host !== suffix && host.endsWith(`.${suffix}`);
  }
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(pattern)) return false;
  return host === pattern;
}

function encryptBrowserFillField(value: string, publicKeyPem: string): string {
  return publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(value, "utf8"),
  ).toString("base64");
}

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
  // use_credential responses flow back to the AGENT (into its context), so this
  // is capped well below the egress path's 16MB. The old 10KB default was too
  // small for real API responses and web pages — an agent GETting a Shopify HTML
  // page tripped it. Default 2MB; tune via VAULT_USE_MAX_RESPONSE_BYTES without a
  // redeploy. Guard a non-numeric / <= 0 env so a bad value can't disable the cap.
  const envMax = Number(process.env.VAULT_USE_MAX_RESPONSE_BYTES);
  const useMaxResponseBytes =
    Number.isFinite(envMax) && envMax > 0 ? envMax : 2 * 1024 * 1024;
  const executor =
    opts.proxyExecutor ?? new HttpProxyExecutor({ maxResponseBytes: useMaxResponseBytes });

  async function resolveCredential(authAccountId: string, selector: { reference?: string; service?: string }, reply: FastifyReply) {
    const owned = await opts.deps.credentialStore.listByAccount(authAccountId);
    if (selector.reference !== undefined) {
      const selected = owned.find((c) => c.reference === selector.reference);
      if (selected === undefined) {
        reply.code(404).send({ error: "credential_not_found" });
        return null;
      }
      return selected;
    }
    const matches = owned.filter(
      (c) =>
        typeof c.metadata.service === "string" &&
        c.metadata.service.toLowerCase() === selector.service!.toLowerCase(),
    );
    if (matches.length > 1) {
      reply.code(409).send({
        error: "ambiguous_service",
        candidates: matches.map((c) => c.reference),
      });
      return null;
    }
    const selected = matches[0];
    if (selected === undefined) {
      reply.code(404).send({ error: "credential_not_found" });
      return null;
    }
    return selected;
  }

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

      const selected = await resolveCredential(auth.account_id, {
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.service !== undefined ? { service: data.service } : {}),
      }, reply);
      if (selected === null) return;
      if (selected.type === "username_password") {
        reply.code(400).send({
          error: "unsupported_credential_type",
          hint: "username_password credentials can only be used through browser fill.",
        });
        return;
      }

      // Rebuild http without undefined-valued optionals (exactOptionalPropertyTypes).
      const http = {
        method: data.http.method,
        url: data.http.url,
        ...(data.http.headers !== undefined ? { headers: data.http.headers } : {}),
        ...(data.http.body !== undefined ? { body: data.http.body } : {}),
        ...(data.http.query !== undefined ? { query: data.http.query } : {}),
      };

      try {
        const response = await opts.deps.vault.proxy(
          selected.reference,
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

  fastify.post(
    "/v1/vault/browser-fill",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = browserFillBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;
      const selected = await resolveCredential(auth.account_id, {
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.service !== undefined ? { service: data.service } : {}),
      }, reply);
      if (selected === null) return;
      if (selected.type !== "username_password") {
        reply.code(400).send({ error: "unsupported_credential_type" });
        return;
      }
      const currentHost = normaliseHost(data.current_host);
      if (currentHost === null) {
        reply.code(400).send({ error: "invalid_current_host" });
        return;
      }
      const loginHosts = metadataStringArray(selected.metadata.login_hosts);
      if (!loginHosts.some((pattern) => loginHostMatches(pattern, currentHost))) {
        reply.code(403).send({ error: "login_host_not_allowed", host: currentHost });
        return;
      }
      try {
        const fields = await opts.deps.vault.retrieveForAgentBrowserFill(
          selected.reference,
          auth.account_id,
        );
        const missing = data.fields.filter((field) => fields[field] === undefined);
        if (missing.length > 0) {
          reply.code(400).send({ error: "missing_fields", fields: missing });
          return;
        }
        const encryptedFields: Record<string, string> = {};
        try {
          for (const field of data.fields) {
            encryptedFields[field] = encryptBrowserFillField(fields[field]!, data.encrypted_response_public_key);
          }
        } catch {
          reply.code(400).send({ error: "invalid_public_key" });
          return;
        }
        return reply.code(200).send({ reference: selected.reference, encrypted_fields: encryptedFields });
      } catch (err) {
        if (err instanceof CredentialNotFoundError) {
          reply.code(404).send({ error: "credential_not_found" });
          return;
        }
        throw err;
      }
    },
  );
};
