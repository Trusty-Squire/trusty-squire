// Shared "machine token OR admin bearer" authorization.
//
// Both /v1/inbox/* and /v1/llm/chat accept the same two auth modes:
//   1. the machine-token caller  — `X-Machine-Token: tsm_…` (or `Authorization: Bearer tsm_…`)
//   2. Admin   — `Authorization: Bearer <UNIVERSAL_BOT_API_KEY>`
//
// This logic used to be hand-copied into inbox.ts and llm.ts, including a
// hand-rolled constant-time compare. The two copies had already drifted,
// so the single source of truth lives here.

import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import {
  authorizeMachineToken,
  extractMachineToken,
} from "../routes/install.js";
import { isMachineToken, type MachineTokenStore } from "../services/machine-tokens.js";

// The resolved auth principal. `machine` carries the full record fields
// the inbox quota check needs; `admin` is the operator/test bypass.
export type AuthPrincipal =
  | { kind: "admin" }
  | {
      kind: "machine";
      token: string;
      signup_count: number;
      paired_account_id: string | null;
    };

// Constant-time string compare. Returns false on any length mismatch
// (timingSafeEqual throws on differing lengths) — the early length
// branch is itself non-secret, since token length isn't a secret.
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Outcome of an admin-bearer-only check. `unconfigured` means the
// UNIVERSAL_BOT_API_KEY env var is missing — callers must fail closed.
export type AdminBearerResult = "ok" | "unauthorized" | "unconfigured";

// Generic timing-safe `Authorization: Bearer <expected>` check. Returns
// `unconfigured` when `expected` is unset/empty (caller fails closed).
// Shared so routes with their own dedicated token (e.g. the funnel
// metrics endpoint's FUNNEL_METRICS_TOKEN) reuse one constant-time
// compare instead of hand-rolling a third copy.
export function verifyBearer(
  req: FastifyRequest,
  expected: string | undefined,
): AdminBearerResult {
  if (expected === undefined || expected.length === 0) {
    return "unconfigured";
  }
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    return "unauthorized";
  }
  const presented = auth.slice("Bearer ".length).trim();
  return constantTimeEquals(presented, expected) ? "ok" : "unauthorized";
}

// Verify the request carries `Authorization: Bearer <UNIVERSAL_BOT_API_KEY>`.
// Used by routes that have no provider signature to verify (e.g. the
// self-hosted Postfix webhook) and fall back to the operator bearer.
export function checkAdminBearer(req: FastifyRequest): AdminBearerResult {
  return verifyBearer(req, process.env.UNIVERSAL_BOT_API_KEY);
}

// Authorize a request as either a the machine-token caller machine token or the admin
// bearer. Writes the failure response and returns null on auth failure;
// returns the principal on success.
export async function authorizeMachineOrAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  store: MachineTokenStore,
): Promise<AuthPrincipal | null> {
  // Try machine token first — the common the machine-token caller case.
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

  // Fall back to the admin bearer token.
  const expected = process.env.UNIVERSAL_BOT_API_KEY;
  const auth = req.headers["authorization"];
  if (
    typeof auth === "string" &&
    auth.startsWith("Bearer ") &&
    expected !== undefined &&
    expected.length > 0
  ) {
    const presented = auth.slice("Bearer ".length).trim();
    // Skip machine-prefix tokens — extractMachineToken handles those
    // above; a tsm_-prefixed value here means an unknown machine token.
    if (!isMachineToken(presented)) {
      if (constantTimeEquals(presented, expected)) {
        return { kind: "admin" };
      }
      reply.code(401).send({ error: "invalid_token" });
      return null;
    }
  }

  reply.code(401).send({ error: "missing_auth" });
  return null;
}
