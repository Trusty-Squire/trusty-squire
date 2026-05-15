// Inbox API for the universal signup bot.
//
// Two auth modes, chosen by header:
//   1. Tier 0 — `X-Machine-Token: tsm_...` (anonymous, quota-limited)
//   2. Admin/test — `Authorization: Bearer <UNIVERSAL_BOT_API_KEY>`
//
// Tier 0 callers are checked against their quota on alias creation. Once
// quota is hit, the response carries an explicit cta_pair_url so the MCP
// tool can tell Claude to surface the pairing flow to the user.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InboxService } from "@trusty-squire/inbox";
import { z } from "zod";
import {
  authorizeMachineToken,
  extractMachineToken,
} from "./install.js";
import {
  defaultQuota,
  isMachineToken,
  isOverQuota,
  type MachineTokenStore,
} from "../services/machine-tokens.js";

export interface InboxRouteDeps {
  inbox: InboxService;
  machineTokenStore: MachineTokenStore;
  now?: () => Date;
}

const createAliasSchema = z.object({
  // Tier 0 callers don't have an account; pass "anonymous" or omit.
  account_id: z.string().optional().default("anonymous"),
  service: z.string().min(1),
  run_id: z.string().min(1),
  ttl_seconds: z.number().int().positive().optional(),
});

const waitQuerySchema = z.object({
  timeout_seconds: z.coerce.number().int().min(1).max(120).default(60),
  subject_pattern: z.string().optional(),
  from_pattern: z.string().optional(),
  body_contains: z.string().optional(),
});

// Returns the auth principal as either an admin bearer (legacy) or a
// machine token record. Writes the failure response and returns null on
// auth failure.
async function authorize(
  req: FastifyRequest,
  reply: FastifyReply,
  store: MachineTokenStore,
): Promise<{ kind: "admin" } | { kind: "machine"; token: string; signup_count: number; paired_account_id: string | null } | null> {
  // Try machine token first (the common Tier 0 case).
  const machineToken = extractMachineToken(req);
  if (machineToken !== null) {
    const record = await authorizeMachineToken(req, reply, store);
    if (record === null) return null;
    return {
      kind: "machine",
      token: record.token,
      signup_count: record.signup_count,
      paired_account_id: record.paired_account_id,
    };
  }

  // Fall back to the admin bearer token. Constant-time compare.
  const expected = process.env.UNIVERSAL_BOT_API_KEY;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ") && expected !== undefined && expected.length > 0) {
    const presented = auth.slice("Bearer ".length).trim();
    // Skip machine-prefix tokens here — they're handled above.
    if (!isMachineToken(presented)) {
      if (presented.length === expected.length) {
        let diff = 0;
        for (let i = 0; i < presented.length; i++) {
          diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
        }
        if (diff === 0) return { kind: "admin" };
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }
  }

  reply.code(401).send({ error: "missing_auth" });
  return null;
}

export async function registerInboxRoute(
  fastify: FastifyInstance,
  opts: { deps: InboxRouteDeps },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();

  // Create an alias. For machine-token callers, this consumes one quota
  // slot.
  fastify.post("/v1/inbox/aliases", async (req, reply) => {
    const principal = await authorize(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    const parsed = createAliasSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }

    // Quota check for Tier 0 callers.
    if (principal.kind === "machine") {
      const quota = defaultQuota();
      if (
        principal.paired_account_id === null &&
        principal.signup_count >= quota
      ) {
        reply.code(429).send({
          error: "quota_exceeded",
          quota_limit: quota,
          quota_used: principal.signup_count,
          cta_pair_url: `${pairingBaseUrl()}/pair?machine_token=${encodeURIComponent(principal.token)}`,
          message:
            `You've used all ${quota} free signups on this machine. ` +
            `Pair this machine (free, ~30s) to keep going.`,
        });
        return;
      }
    }

    // exactOptionalPropertyTypes: zod's `.optional()` produces
    // `ttl_seconds: number | undefined`, but CreateAliasInput's
    // `ttl_seconds?: number` rejects an explicit undefined. Build the
    // call input by spreading ttl_seconds only when present.
    const { ttl_seconds, ...rest } = parsed.data;
    const alias = await opts.deps.inbox.createAlias(
      ttl_seconds === undefined ? rest : { ...rest, ttl_seconds },
    );

    if (principal.kind === "machine") {
      await opts.deps.machineTokenStore.incrementUsage(principal.token, now());
    }

    reply.code(201).send({ alias });
  });

  fastify.get<{
    Params: { alias: string };
  }>("/v1/inbox/aliases/:alias/wait", async (req, reply) => {
    const principal = await authorize(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    const query = waitQuerySchema.safeParse(req.query);
    if (!query.success) {
      reply.code(400).send({ error: "invalid_query", issues: query.error.issues });
      return;
    }

    const matcher: { subject?: RegExp; from?: RegExp; body_contains?: string } = {};
    if (query.data.subject_pattern !== undefined) {
      try {
        matcher.subject = new RegExp(query.data.subject_pattern, "i");
      } catch {
        reply.code(400).send({ error: "invalid_subject_pattern" });
        return;
      }
    }
    if (query.data.from_pattern !== undefined) {
      try {
        matcher.from = new RegExp(query.data.from_pattern, "i");
      } catch {
        reply.code(400).send({ error: "invalid_from_pattern" });
        return;
      }
    }
    if (query.data.body_contains !== undefined) {
      matcher.body_contains = query.data.body_contains;
    }

    try {
      const email = await opts.deps.inbox.waitForEmail({
        alias: req.params.alias,
        matcher,
        timeout_seconds: query.data.timeout_seconds,
      });
      reply.send({
        id: email.id,
        alias: email.alias,
        from_address: email.from_address,
        subject: email.subject,
        body_text: email.body_text,
        body_html: email.body_html,
        parsed_links: email.parsed_links,
        parsed_codes: email.parsed_codes,
        received_at: email.received_at.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("timeout")) {
        reply.code(408).send({ error: "timeout", alias: req.params.alias });
        return;
      }
      if (message.includes("inactive") || message.includes("revoked") || message.includes("expired")) {
        reply.code(410).send({ error: "alias_inactive", alias: req.params.alias });
        return;
      }
      fastify.log.error({ err, alias: req.params.alias }, "wait_for_email failed");
      reply.code(500).send({ error: "wait_failed" });
    }
  });

  fastify.delete<{
    Params: { alias: string };
  }>("/v1/inbox/aliases/:alias", async (req, reply) => {
    const principal = await authorize(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;
    await opts.deps.inbox.revokeAlias(req.params.alias);
    reply.code(204).send();
  });
}

function pairingBaseUrl(): string {
  return process.env.PWA_BASE_URL ?? "https://app.trustysquire.ai";
}
