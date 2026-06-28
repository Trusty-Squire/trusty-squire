// Inbox API for the universal signup bot.
//
// Two auth modes, chosen by header:
//   1. Machine token — `X-Machine-Token: tsm_...` (bound to an account
//      at install-claim time; quota tracked per-account)
//   2. Admin/test — `Authorization: Bearer <UNIVERSAL_BOT_API_KEY>`
//
// Machine-token callers are checked against the free-signup quota on
// alias creation. Once the limit is hit, the response is
// payment_required + cta_billing_url so the MCP tool can tell the LLM
// to point the user at billing.
//
// Alias ownership: an alias is stamped with the principal that created
// it. The /wait and DELETE routes assert the caller owns the alias, so
// one machine token cannot long-poll or revoke another machine's alias
// (an admin bearer bypasses the check).

import type { FastifyInstance } from "fastify";
import { AliasInactiveError, EmailTimeoutError, type InboxService } from "@trusty-squire/inbox";
import { z } from "zod";
import {
  authorizeMachineOrAdmin,
  type AuthPrincipal,
} from "../auth/authorize-machine-or-admin.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";

export interface InboxRouteDeps {
  inbox: InboxService;
  machineTokenStore: MachineTokenStore;
  now?: () => Date;
}

const createAliasSchema = z.object({
  // In single-tier every machine_token is bound to an account; the
  // CLI sends the bound account_id here.
  account_id: z.string().min(1),
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

// Sentinel owner stamped on aliases created via an admin bearer. Admin
// callers also bypass the ownership check on read/delete, so this value
// is only ever compared when a machine token tries to touch an
// admin-created alias.
const ADMIN_OWNER = "admin";

// The owner key stored on an alias for a given principal.
function ownerKey(principal: AuthPrincipal): string {
  return principal.kind === "machine" ? principal.token : ADMIN_OWNER;
}

// True when `principal` is allowed to read/delete an alias whose
// recorded owner is `issuedTo`. Admin bypasses. A null owner means the
// alias predates ownership tracking — treated as permissive so legacy
// aliases keep working.
function ownsAlias(principal: AuthPrincipal, issuedTo: string | null): boolean {
  if (principal.kind === "admin") return true;
  if (issuedTo === null) return true;
  return issuedTo === principal.token;
}

export async function registerInboxRoute(
  fastify: FastifyInstance,
  opts: { deps: InboxRouteDeps },
): Promise<void> {
  // Create an alias. The creating principal is stamped onto the alias.
  // Provisioning is free during beta — no signup quota, no paywall.
  fastify.post("/v1/inbox/aliases", async (req, reply) => {
    const principal = await authorizeMachineOrAdmin(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    const parsed = createAliasSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }

    // exactOptionalPropertyTypes: zod's `.optional()` produces
    // `ttl_seconds: number | undefined`, but CreateAliasInput's
    // `ttl_seconds?: number` rejects an explicit undefined. Build the
    // call input by spreading ttl_seconds only when present.
    const { ttl_seconds, ...rest } = parsed.data;
    const alias = await opts.deps.inbox.createAlias({
      ...rest,
      issued_to: ownerKey(principal),
      ...(ttl_seconds === undefined ? {} : { ttl_seconds }),
    });

    reply.code(201).send({ alias });
  });

  fastify.get<{
    Params: { alias: string };
  }>("/v1/inbox/aliases/:alias/wait", async (req, reply) => {
    const principal = await authorizeMachineOrAdmin(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    // Ownership check: only the issuing principal (or an admin) may
    // long-poll this alias. Without it, any valid machine token could
    // read another machine's verification codes/links.
    const aliasRecord = await opts.deps.inbox.getAlias(req.params.alias);
    if (aliasRecord === null) {
      reply.code(404).send({ error: "unknown_alias", alias: req.params.alias });
      return;
    }
    if (!ownsAlias(principal, aliasRecord.issued_to)) {
      reply.code(403).send({ error: "alias_not_owned", alias: req.params.alias });
      return;
    }

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
      // Match on the typed error classes the inbox package exports —
      // the previous string-matching on err.message was brittle (the
      // timeout error message says "within Ns", not "timeout").
      if (err instanceof EmailTimeoutError) {
        reply.code(408).send({ error: "timeout", alias: req.params.alias });
        return;
      }
      if (err instanceof AliasInactiveError) {
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
    const principal = await authorizeMachineOrAdmin(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    // Ownership check: only the issuing principal (or admin) may revoke.
    const aliasRecord = await opts.deps.inbox.getAlias(req.params.alias);
    if (aliasRecord === null) {
      // Idempotent delete: a never-created (or already TTL-swept) alias
      // is a no-op success, matching the store's revoke() semantics.
      reply.code(204).send();
      return;
    }
    if (!ownsAlias(principal, aliasRecord.issued_to)) {
      reply.code(403).send({ error: "alias_not_owned", alias: req.params.alias });
      return;
    }

    await opts.deps.inbox.revokeAlias(req.params.alias);
    reply.code(204).send();
  });
}
