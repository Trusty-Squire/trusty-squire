// POST /v1/inbox/poll-operator-otp — bot-internal endpoint for the
// email_otp_required gate (rc.27).
//
// Authenticates with a machine token (same as /v1/notify/heightened-
// auth). Connects to GMAIL_USER's inbox over IMAP via the existing
// GMAIL_APP_PASSWORD secret, finds the most recent message matching
// the requested from-domain in the last `since_seconds` seconds,
// and returns the first OTP-shaped substring.
//
// Best-effort: any failure returns 200 with { code: null, reason }
// so the bot can degrade to the prior abort path without a noisy
// 5xx. Hard auth/config failures (no token, no machine record)
// still 4xx — those are operator-visible mistakes.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractMachineToken } from "./install.js";
import {
  OperatorOtpPoller,
  type OtpPollInput,
  type OtpPollResult,
} from "../services/operator-otp-poller.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";

export interface OperatorOtpRouteDeps {
  machineTokenStore: MachineTokenStore;
}

export async function registerOperatorOtpRoute(
  fastify: FastifyInstance,
  opts: { deps: OperatorOtpRouteDeps },
): Promise<void> {
  fastify.post("/v1/inbox/poll-operator-otp", async (req, reply) => {
    const token = extractMachineToken(req);
    if (token === null) {
      reply.code(401).send({ error: "missing_machine_token" });
      return;
    }
    const tokenRow = await opts.deps.machineTokenStore.find(token);
    if (tokenRow === null) {
      reply.code(401).send({ error: "invalid_machine_token" });
      return;
    }

    const cfg = readOperatorImapConfig();
    if (cfg === null) {
      reply.code(503).send({
        code: null,
        reason: "operator_imap_not_configured",
        scanned: 0,
      } satisfies OtpPollResult);
      return;
    }

    const input = parseBody(req);
    if (input === null) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    const poller = new OperatorOtpPoller(cfg);
    const result = await poller.poll(input);
    reply.code(200).send(result);
  });
}

// The operator's single IMAP identity. Prefers the OPERATOR_IMAP_* names;
// falls back to the legacy GMAIL_* names so a deploy that still has the old
// secret keeps working through the migration (the consolidation onto one
// Workspace inbox, lunchbox@trustysquire.ai).
function readOperatorImapConfig(): { imapUser: string; imapAppPassword: string } | null {
  const u = process.env.OPERATOR_IMAP_USER ?? process.env.GMAIL_USER;
  const p = process.env.OPERATOR_IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
  if (typeof u !== "string" || u.length === 0) return null;
  if (typeof p !== "string" || p.length === 0) return null;
  return { imapUser: u, imapAppPassword: p };
}

function parseBody(req: FastifyRequest): OtpPollInput | null {
  const b = req.body;
  if (b === null || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;
  const sinceRaw = obj["since_seconds"];
  if (typeof sinceRaw !== "number" || !Number.isFinite(sinceRaw)) return null;
  const out: OtpPollInput = { since_seconds: Math.floor(sinceRaw) };
  if (typeof obj["from_domain"] === "string" && obj["from_domain"].length > 0) {
    out.from_domain = obj["from_domain"];
  }
  if (typeof obj["otp_pattern"] === "string" && obj["otp_pattern"].length > 0) {
    out.otp_pattern = obj["otp_pattern"];
  }
  if (obj["return_kind"] === "url" || obj["return_kind"] === "code") {
    out.return_kind = obj["return_kind"];
  }
  return out;
}
