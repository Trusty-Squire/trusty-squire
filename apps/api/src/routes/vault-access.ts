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
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AllowlistViolationError,
  CredentialNotFoundError,
  EgressFieldNotFoundError,
  EGRESS_LOCAL_FILE_HOST,
} from "@trusty-squire/vault";
import type { ApiDeps } from "../services/deps.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";
import { resolveCredentialForAccount } from "../services/credential-resolution.js";

const useBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(60).optional(),
    http: z.object({
      method: z.string().min(1).max(10),
      url: z.string().min(1).max(2048),
      headers: z.record(z.string()).optional(),
      body: z
        .string()
        .max(64 * 1024)
        .optional(),
      // Query-string auth (FRED etc.): { api_key: "${SECRET}" } — injected
      // server-side after the host check; secret never appears in `url`.
      query: z.record(z.string()).optional(),
    }),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined || b.name !== undefined, {
    message: "one of reference, service, or name is required",
  });

// Vault-first egress. The agent names a credential and a DESTINATION KIND it is
// about to write the key into from its own machine; the server gates, decrypts,
// and seals the fields to the caller's ephemeral public key. Deliberately not
// `browser-fill`: that route gates on `login_hosts` (browser-fill semantics),
// while an egress destination is a proxy-semantics `allowed_hosts` question.
//
// The client does NOT get to say which host is checked. It says what KIND of
// destination it is; the server derives the host from the kind and checks THAT
// against allowed_hosts. Anything else would make the gate a formality: the
// same client that asserts the destination is the one that receives the
// decryptable payload, so a self-declared host authorises nothing.
const egressDestination = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_repo_secret"),
    // Recorded on the audit row so the trail names the exact repository the
    // key went to. NOT used for the gate — the gate is the derived host.
    owner: z.string().min(1).max(200),
    repo: z.string().min(1).max(200),
    environment: z.string().min(1).max(200).optional(),
  }),
  z.object({ kind: z.literal("dotenv_write") }),
]);

// The host each destination kind is gated on. `.env` has no network host, so
// it gets a literal marker — but that marker is an ordinary `allowed_hosts`
// ENTRY the user adds through edit_credential (passkey-signed), not an
// exemption. There is no destination kind that skips the allowlist.
const EGRESS_DESTINATION_HOSTS = {
  github_repo_secret: "api.github.com",
  dotenv_write: EGRESS_LOCAL_FILE_HOST,
} as const;

const egressFetchBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(60).optional(),
    // EXACTLY one. The client resolves which field it needs from the
    // non-secret `field_names` in list_credentials BEFORE calling here, so a
    // destination only ever receives the one value it is for. Accepting a list
    // would let an authenticated client ask for everything by name and call it
    // least privilege.
    fields: z.array(z.string().min(1).max(120)).length(1),
    encrypted_response_public_key: z.string().min(1).max(4096),
    destination: egressDestination,
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined || b.name !== undefined, {
    message: "one of reference, service, or name is required",
  });

// The destination identity recorded alongside the retrieval — who received the
// key, never its value. For `.env` the server cannot know the path (the
// filesystem is on the client), so the retrieval row names the kind and the
// client-reported egress-outcome row carries the path.
function egressFetchDestinationLabel(
  destination: z.infer<typeof egressDestination>,
): string | undefined {
  if (destination.kind === "dotenv_write") return undefined;
  return destination.environment !== undefined
    ? `${destination.owner}/${destination.repo}:${destination.environment}`
    : `${destination.owner}/${destination.repo}`;
}

const egressOutcomeBody = z.object({
  reference: z.string().min(1).max(400),
  destination: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("github_repo_secret"),
      repo: z.string().min(1).max(300),
      environment: z.string().min(1).max(200).optional(),
    }),
    z.object({ kind: z.literal("dotenv_write"), path: z.string().min(1).max(2048) }),
  ]),
  status: z.enum(["ok", "error"]),
  error: z.string().max(2000).optional(),
});

// The exact string recorded as `egress_destination` — the identity of what
// received the key, never its value.
function egressDestinationLabel(
  destination: z.infer<typeof egressOutcomeBody>["destination"],
): string {
  return destination.kind === "dotenv_write"
    ? destination.path
    : destination.environment !== undefined
      ? `${destination.repo}:${destination.environment}`
      : destination.repo;
}

const browserFillBody = z
  .object({
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(60).optional(),
    current_host: z.string().min(1).max(2048),
    fields: z.array(z.string().min(1).max(120)).min(1).max(20),
    encrypted_response_public_key: z.string().min(1).max(4096),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined || b.name !== undefined, {
    message: "one of reference, service, or name is required",
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

// A login credential is identified by its `auth_strategy` — the canonical signal
// store_credential sets for username/password logins. The legacy top-level `type`
// is NOT reliably "username_password": a credential stored the documented way
// (auth_strategy:"username_password", no explicit type) has type=null, so gating
// browser-fill on `type` alone rejected valid login credentials with a spurious
// 400 unsupported_credential_type (#326), forcing plaintext password typing.
// Check both signals; auth_strategy is authoritative.
function isUsernamePasswordCredential(selected: {
  type?: string | null;
  metadata?: Record<string, unknown>;
}): boolean {
  return (
    selected.type === "username_password" ||
    selected.metadata?.auth_strategy === "username_password"
  );
}

const TWO_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "com.br",
  "co.za",
  "com.cn",
  "github.io",
  "web.app",
  "firebaseapp.com",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
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
  const useMaxResponseBytes = Number.isFinite(envMax) && envMax > 0 ? envMax : 2 * 1024 * 1024;
  const executor =
    opts.proxyExecutor ?? new HttpProxyExecutor({ maxResponseBytes: useMaxResponseBytes });

  async function resolveCredential(
    authAccountId: string,
    selector: { reference?: string; service?: string; name?: string },
    reply: FastifyReply,
  ) {
    const resolution = await resolveCredentialForAccount(
      opts.deps.credentialStore,
      authAccountId,
      selector,
    );
    if (resolution.kind === "ambiguous") {
      reply.code(409).send({
        error: "ambiguous_service",
        candidates: resolution.candidates.map((credential) => credential.reference),
      });
      return null;
    }
    if (resolution.kind === "missing") {
      reply.code(404).send({ error: "credential_not_found" });
      return null;
    }
    return resolution.credential;
  }

  fastify.post("/v1/vault/use", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = useBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    const selected = await resolveCredential(
      auth.account_id,
      {
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.service !== undefined ? { service: data.service } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
      },
      reply,
    );
    if (selected === null) return;
    if (isUsernamePasswordCredential(selected)) {
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
  });

  fastify.post("/v1/vault/browser-fill", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = browserFillBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const selected = await resolveCredential(
      auth.account_id,
      {
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.service !== undefined ? { service: data.service } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
      },
      reply,
    );
    if (selected === null) return;
    if (!isUsernamePasswordCredential(selected)) {
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
          encryptedFields[field] = encryptBrowserFillField(
            fields[field]!,
            data.encrypted_response_public_key,
          );
        }
      } catch {
        reply.code(400).send({ error: "invalid_public_key" });
        return;
      }
      return reply
        .code(200)
        .send({ reference: selected.reference, encrypted_fields: encryptedFields });
    } catch (err) {
      if (err instanceof CredentialNotFoundError) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      throw err;
    }
  });

  fastify.post("/v1/vault/egress-fetch", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = egressFetchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const selected = await resolveCredential(
      auth.account_id,
      {
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.service !== undefined ? { service: data.service } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
      },
      reply,
    );
    if (selected === null) return;
    if (isUsernamePasswordCredential(selected)) {
      reply.code(400).send({
        error: "unsupported_credential_type",
        hint: "username_password credentials can only be used through browser fill.",
      });
      return;
    }
    // Derived from the KIND, never read off the request. A client that claims
    // `api.example.com` or omits a host entirely gets the same check.
    const targetHost = EGRESS_DESTINATION_HOSTS[data.destination.kind];
    const destinationLabel = egressFetchDestinationLabel(data.destination);
    try {
      // The gate lives inside retrieveForEgress and runs BEFORE any decrypt —
      // an off-allowlist destination never causes plaintext to exist.
      const requestedField = data.fields[0]!;
      // The vault returns ONLY this field — the narrowing happens there, next
      // to the decrypt, not here after the fact.
      const fields = await opts.deps.vault.retrieveForEgress(
        selected.reference,
        auth.account_id,
        targetHost,
        {
          kind: data.destination.kind,
          field: requestedField,
          ...(destinationLabel !== undefined ? { destination: destinationLabel } : {}),
        },
      );
      const encryptedFields: Record<string, string> = {};
      try {
        encryptedFields[requestedField] = encryptBrowserFillField(
          fields[requestedField]!,
          data.encrypted_response_public_key,
        );
      } catch {
        reply.code(400).send({ error: "invalid_public_key" });
        return;
      }
      return reply
        .code(200)
        .send({ reference: selected.reference, encrypted_fields: encryptedFields });
    } catch (err) {
      if (err instanceof AllowlistViolationError) {
        reply.code(403).send({
          error: "host_not_allowed",
          host: err.host,
          hint: "Add the host to this credential's allowed_hosts in /vault.",
        });
        return;
      }
      if (err instanceof EgressFieldNotFoundError) {
        reply.code(400).send({ error: "missing_fields", fields: [err.field] });
        return;
      }
      if (err instanceof CredentialNotFoundError) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      throw err;
    }
  });

  fastify.post(
    "/v1/vault/egress-outcome",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = egressOutcomeBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const data = parsed.data;
      const record = await opts.deps.credentialStore.findActive(data.reference);
      if (record === null || record.account_id !== auth.account_id) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      await opts.deps.vault.recordEgressDelivery(auth.account_id, {
        reference: data.reference,
        kind: data.destination.kind,
        destination: egressDestinationLabel(data.destination),
        status: data.status,
        ...(data.error !== undefined ? { error: data.error } : {}),
      });
      return reply.code(201).send({ recorded: true });
    },
  );
};
