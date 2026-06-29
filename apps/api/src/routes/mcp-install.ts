// MCP install handshake — the browser-confirm step that binds a local
// machine to an account.
//
//   POST /v1/mcp/install/initiate         CLI mints a setup_code +
//                                         browser confirm_url.
//   GET  /v1/mcp/install/:code/status     CLI polls; once `claimed`,
//                                         delivers the raw bearer token
//                                         exactly once.
//   GET  /v1/mcp/install/:code/state      Browser polls; status only —
//                                         never delivers the token.
//   POST /v1/mcp/install/:code/claim      PWA (web auth) marks the
//                                         setup_code claimed, creates
//                                         an AgentSession, returns ok.
//
// Initiate + status + state are unauthenticated by design (the CLI has
// no credentials yet). The TTL + single-use semantics bound the attack
// surface.

import { z } from "zod";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { issueAgentSession } from "../auth/agent.js";
import { issuePairingToken } from "../auth/pairing-token.js";
import type { ApiDeps } from "../services/deps.js";

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) return undefined;
    if (parsed.hostname.length === 0) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

const initiateBody = z
  .object({
    target: z.string().min(1).max(60).optional(),
    agent_identity: z.string().min(1).max(60).optional(),
    // The machine token issued seconds earlier via /v1/install — the
    // claim step binds it to the account so quota and rate-limits
    // accrue against that account.
    machine_token: z.string().min(8).max(128).optional(),
  })
  .optional();

const claimBody = z
  .object({
    agent_identity: z.string().min(1).max(60).optional(),
    agent_version: z.string().min(1).max(60).optional(),
    registry_enabled: z.boolean().optional(),
    consent_operator_inbox_otp: z.boolean().optional(),
    proxy_url: z
      .string()
      .max(500)
      .transform((value) => normalizeProxyUrl(value))
      .refine((value): value is string => value !== undefined, {
        message: "proxy_url must be http://, https://, or socks5:// without whitespace",
      })
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .optional();

function installPreferences(record: {
  registry_enabled: boolean | null;
  consent_operator_inbox_otp: boolean | null;
  proxy_url: string | null;
}) {
  return {
    registry_enabled: record.registry_enabled === true,
    consent_operator_inbox_otp: record.consent_operator_inbox_otp === true,
    ...(record.proxy_url !== null ? { proxy_url: record.proxy_url } : {}),
  };
}

export const registerMcpInstallRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  installBaseUrl?: string;
}> = async (fastify, opts) => {
  const installBaseUrl = opts.installBaseUrl ?? "https://trustysquire.ai/install";

  fastify.post("/v1/mcp/install/initiate", async (req, reply) => {
    // Body is optional; if invalid we surface 400 rather than silently
    // accepting — keeps the contract honest for the CLI.
    const parsed = initiateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const now = opts.deps.now?.() ?? new Date();
    // `agent_identity` is the canonical field; `target` is a legacy alias
    // the early CLI sent. Either works.
    const agentIdentity = parsed.data?.agent_identity ?? parsed.data?.target ?? null;
    const machineToken = parsed.data?.machine_token ?? null;
    const record = issuePairingToken(now, agentIdentity, machineToken);
    await opts.deps.pairingTokenStore.insert(record);
    return reply.code(201).send({
      setup_code: record.token,
      confirm_url: `${installBaseUrl}?token=${encodeURIComponent(record.token)}`,
      expires_at: record.expires_at.toISOString(),
    });
  });

  fastify.get<{ Params: { code: string } }>(
    "/v1/mcp/install/:code/status",
    async (req, reply) => {
      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.code);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (now > record.expires_at && record.status !== "delivered") {
        reply.code(410).send({ status: "expired" });
        return;
      }
      if (record.status === "pending") {
        return reply.code(200).send({
          status: "pending",
          agent_identity: record.agent_identity,
        });
      }
      if (record.status === "claimed") {
        // First poll after claim — deliver the raw token (exactly once).
        const raw = await opts.deps.pairingTokenStore.deliverAndMarkUsed(req.params.code, now);
        if (raw === null) {
          reply.code(410).send({ status: "expired" });
          return;
        }
        return reply.code(200).send({
          status: "claimed",
          agent_session_token: raw,
          account_id: record.account_id,
          install_preferences: installPreferences(record),
        });
      }
      // delivered / expired
      reply.code(410).send({ status: "expired" });
    },
  );

  // Browser-side status check — used by the /install web page. Unlike
  // /status, this NEVER delivers the one-time agent token: that
  // delivery is reserved exclusively for the CLI's /status poll, so a
  // page load can't consume the token out from under the CLI.
  fastify.get<{ Params: { code: string } }>(
    "/v1/mcp/install/:code/state",
    async (req, reply) => {
      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.code);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (now > record.expires_at && record.status !== "delivered") {
        return reply.code(200).send({ status: "expired" });
      }
      if (record.status === "pending") {
        return reply.code(200).send({
          status: "pending",
          agent_identity: record.agent_identity,
        });
      }
      // claimed or delivered — install is confirmed from the browser's POV.
      return reply.code(200).send({ status: record.status });
    },
  );

  fastify.post<{ Params: { code: string } }>(
    "/v1/mcp/install/:code/claim",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = claimBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }

      const now = opts.deps.now?.() ?? new Date();
      const record = await opts.deps.pairingTokenStore.find(req.params.code);
      if (record === null) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      if (record.status !== "pending" || now > record.expires_at) {
        reply.code(409).send({ error: "not_pending" });
        return;
      }

      // Mint an AgentSession bound to the authenticated account. Prefer
      // the agent_identity from the claim body (PWA echo), fall back to
      // whatever the CLI declared at initiate.
      const { raw_token, record: agentRecord } = issueAgentSession({
        account_id: auth.account_id,
        agent_identity: parsed.data?.agent_identity ?? record.agent_identity ?? null,
        agent_version: parsed.data?.agent_version ?? null,
        now,
      });
      await opts.deps.agentSessionStore.insert(agentRecord);

      const claimed = await opts.deps.pairingTokenStore.claim(
        req.params.code,
        auth.account_id,
        raw_token,
        now,
        {
          registry_enabled: parsed.data?.registry_enabled === true,
          consent_operator_inbox_otp:
            parsed.data?.consent_operator_inbox_otp === true,
          proxy_url: parsed.data?.proxy_url ?? null,
        },
      );
      if (!claimed) {
        reply.code(409).send({ error: "claim_failed" });
        return;
      }

      // Bind the machine_token declared at /initiate to this account.
      // Subsequent quota + rate-limit checks are per-account, so the
      // bot's LLM-proxy + inbox calls (which authenticate with the
      // machine_token) credit the right account.
      if (record.machine_token !== null) {
        try {
          await opts.deps.machineTokenStore.markPaired(
            record.machine_token,
            auth.account_id,
          );
        } catch (err) {
          // Non-fatal: claim already succeeded. Log and continue. Never log any
          // slice of the token — a prefix is still a partial credential; the err
          // + message are enough to correlate.
          fastify.log.warn({ err }, "machine_token bind failed");
        }
      }

      return reply.code(200).send({
        ok: true,
        agent_session_id: agentRecord.id,
        account_id: auth.account_id,
      });
    },
  );
};
