// Machine-token issuance for the MCP install flow.
//
// The MCP CLI calls POST /v1/install at install time to mint a
// machine_token for the bot's inbox-OTP use. This token
// is unauthenticated at issuance — it's just a bot-internal credential
// that gets bound to the user's account during the install-claim
// handshake (see routes/mcp-install.ts) seconds later.
//
// Provisioning is free during beta — there is no signup quota. The
// install-claim binds the token to an account; unbound tokens expire
// at their TTL.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  isMachineToken,
  type AsnFingerprint,
  type MachineTokenStore,
  type MachineTokenRecord,
} from "../services/machine-tokens.js";

export interface InstallRouteDeps {
  machineTokenStore: MachineTokenStore;
  now?: () => Date;
}

export async function registerInstallRoute(
  fastify: FastifyInstance,
  // signupsDisabled is the SIGNUPS_DISABLED global kill switch (checklist #10),
  // computed once at server-build time and threaded in (same pattern as
  // billingEnabled). Issuing a machine token is the first step of a fresh
  // install, so when the kill is engaged this route 503s instead of minting.
  opts: { deps: InstallRouteDeps; signupsDisabled: boolean },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();

  // POST /v1/install — issues a fresh machine token. No auth required.
  // The MCP install CLI calls this on first run.
  //
  // Optional body: { asn: { class, number, org, country } }. The CLI
  // does an ipinfo lookup at install time and passes the result through.
  // We accept anything-shaped and validate to a known classifier output;
  // garbage shapes get dropped silently rather than 400'd because the
  // captcha analytics value is "nice to have," not gate-blocking.
  fastify.post("/v1/install", async (req, reply) => {
    if (opts.signupsDisabled) {
      reply.code(503).send({ error: "signups_disabled" });
      return;
    }
    const asn = extractAsnFromBody(req.body);
    const record = await opts.deps.machineTokenStore.issue(now(), asn ?? undefined);
    reply.code(201).send({
      machine_token: record.token,
      message:
        "Machine token issued. The MCP install CLI will now open a " +
        "browser to bind this machine to your account.",
    });
  });

  // GET /v1/install/status — caller passes their machine token, gets its
  // bound account + timestamps. No quota: provisioning is free during beta.
  fastify.get("/v1/install/status", async (req, reply) => {
    const token = extractMachineToken(req);
    if (token === null) {
      reply.code(401).send({ error: "missing_machine_token" });
      return;
    }
    const record = await opts.deps.machineTokenStore.find(token);
    if (record === null) {
      reply.code(404).send({ error: "unknown_machine_token" });
      return;
    }
    reply.send({
      account_id: record.paired_account_id,
      created_at: record.created_at.toISOString(),
      last_used_at: record.last_used_at?.toISOString() ?? null,
    });
  });
}

// Pull `tsm_…` machine token from either:
//   X-Machine-Token: tsm_...
//   Authorization: Bearer tsm_...
export function extractMachineToken(req: FastifyRequest): string | null {
  const headerToken = req.headers["x-machine-token"];
  if (typeof headerToken === "string" && isMachineToken(headerToken)) {
    return headerToken;
  }
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const candidate = auth.slice("Bearer ".length).trim();
    if (isMachineToken(candidate)) return candidate;
  }
  return null;
}

// Validate and narrow the optional asn block from an /v1/install body.
// Returns null when the body is missing, malformed, or carries an
// unknown class — null means "no install-time asn captured for this
// machine," which downstream code already handles.
function extractAsnFromBody(body: unknown): AsnFingerprint | null {
  if (body === null || typeof body !== "object") return null;
  const asn = (body as Record<string, unknown>).asn;
  if (asn === null || typeof asn !== "object") return null;
  const a = asn as Record<string, unknown>;
  const cls = a.class;
  if (cls !== "residential" && cls !== "datacenter" && cls !== "unknown") {
    return null;
  }
  // Other fields default to null on unexpected shape rather than
  // rejecting the whole block — the class is the only field downstream
  // analytics strictly requires.
  return {
    class: cls,
    number: typeof a.number === "string" ? a.number : null,
    org: typeof a.org === "string" ? a.org : null,
    country: typeof a.country === "string" ? a.country : null,
  };
}

// Helper used by other routes (inbox.ts) to authorize a machine-token
// request. Returns the record on success; writes the error response
// and returns null on failure.
export async function authorizeMachineToken(
  req: FastifyRequest,
  reply: FastifyReply,
  store: MachineTokenStore,
): Promise<MachineTokenRecord | null> {
  const token = extractMachineToken(req);
  if (token === null) return null;
  const record = await store.find(token);
  if (record === null) {
    reply.code(401).send({ error: "invalid_machine_token" });
    return null;
  }
  return record;
}
