// Primitives shared by every passkey-gated approval ceremony — payment,
// credential mutation, credential fetch.
//
// The STORES stay deliberately separate (a signed mutation mandate must have
// nowhere to land in the reveal state machine, and vice versa). The
// cryptographic boundary, the caller-authentication predicate, and the link
// building are NOT security-by-separation — duplicating them is how the fetch
// ceremony ended up shipping approve/deny endpoints that authenticated nobody
// while the mutation ones it was copied from had the same gap. One copy each,
// used by every ceremony.

import type { FastifyReply } from "fastify";
import type { resolveCredentialForAccount } from "./credential-resolution.js";
import {
  VouchMandateVerificationError,
  type VouchMandateVerificationInput,
  type VouchMandateVerifier,
} from "./vouch-mandate.js";

export function approvalWebBaseUrl(): string {
  return (
    process.env.PWA_BASE_URL ?? process.env.TRUSTY_SQUIRE_WEB_BASE ?? "https://trustysquire.ai"
  );
}

/** `/vault/<kind>/<id>` on the web app — the link the human opens to sign. */
export function approvalPageUrl(kind: "fetch" | "mutate", id: string): string {
  return `${approvalWebBaseUrl().replace(/\/+$/, "")}/vault/${kind}/${encodeURIComponent(id)}`;
}

export function sendResolutionFailure(
  resolution: Awaited<ReturnType<typeof resolveCredentialForAccount>>,
  reply: FastifyReply,
): boolean {
  if (resolution.kind === "found") return false;
  if (resolution.kind === "missing") {
    reply.code(404).send({ error: "credential_not_found" });
    return true;
  }
  reply.code(409).send({
    error: "ambiguous_credential",
    candidates: resolution.candidates.map((credential) => ({
      reference: credential.reference,
      service: typeof credential.metadata.service === "string" ? credential.metadata.service : null,
      name: credential.label,
    })),
  });
  return true;
}

/**
 * Verify a Vouchflow assertion and, on failure, send the ceremony's standard
 * refusal. Returns the claims on success and `null` once it has replied — so a
 * caller cannot accidentally continue on an unverified mandate.
 */
export async function verifyApprovalMandate(
  verify: VouchMandateVerifier,
  input: VouchMandateVerificationInput,
  reply: FastifyReply,
): Promise<Awaited<ReturnType<VouchMandateVerifier>> | null> {
  try {
    return await verify(input);
  } catch (error) {
    const code =
      error instanceof VouchMandateVerificationError ? error.code : "mandate_verification_failed";
    reply.code(code === "vouchflow_expected_audience_unset" ? 503 : 403).send({ error: code });
    return null;
  }
}

export type ApprovalOwnership<R> =
  | { kind: "owner"; record: R }
  /** No such approval — or one whose existence this caller may not learn. */
  | { kind: "not_found" }
  /** The approval exists and belongs to SOMEONE ELSE. Never disclose more than not_found. */
  | { kind: "foreign"; record: R };

/**
 * The ownership predicate for a human-facing ceremony endpoint. An approval is
 * settled by the account that owns the credential, and by nobody else: holding
 * the (bearer) approval link is not authority, because the agent that requested
 * the fetch necessarily holds it too.
 *
 * `foreign` is reported separately from `not_found` so the OWNER's audit ledger
 * can record that someone else tried; the HTTP answer must stay identical.
 */
export function approvalOwnership<R>(
  record: R | null,
  ownerAccountIdOf: (record: R) => string,
  callerAccountId: string,
): ApprovalOwnership<R> {
  if (record === null) return { kind: "not_found" };
  return ownerAccountIdOf(record) === callerAccountId
    ? { kind: "owner", record }
    : { kind: "foreign", record };
}
