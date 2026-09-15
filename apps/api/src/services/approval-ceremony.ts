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
import type { JWTPayload } from "jose";
import type { resolveCredentialForAccount } from "./credential-resolution.js";
import type { VouchflowDeviceStore } from "./vouchflow-device-store.js";
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

/** The signer an accepted assertion names, for the ledger row it produces. */
export interface ApprovalMandateSigner {
  deviceToken: string;
  signingDeviceId: string | null;
}

/**
 * The second half of "the passkey IS the authentication": a genuine Vouchflow
 * assertion proves SOMEONE signed these exact bytes, never that it was the
 * account whose approval it answers. Vouchflow names the signer in the signed
 * claims; this resolves that device against the devices the owning account has
 * claimed from a signed-in browser, so a stranger's entirely genuine passkey
 * cannot settle someone else's approval now that the ceremony is sessionless.
 *
 * Returns the signer on success and `null` once it has replied — so a caller
 * cannot accidentally continue on an unattributable one.
 */
export async function resolveApprovalMandateSigner(
  devices: VouchflowDeviceStore,
  claims: JWTPayload,
  ownerAccountId: string,
  reply: FastifyReply,
): Promise<ApprovalMandateSigner | null> {
  const deviceToken = typeof claims.device_token === "string" ? claims.device_token : "";
  if (deviceToken.length === 0) {
    reply.code(403).send({ error: "missing_device_token" });
    return null;
  }
  const authorized = await devices.listTokensByAccount(ownerAccountId);
  if (!authorized.includes(deviceToken)) {
    reply.code(403).send({ error: "mandate_signer_not_authorized" });
    return null;
  }
  return {
    deviceToken,
    signingDeviceId:
      typeof claims.signing_device_id === "string" && claims.signing_device_id.length > 0
        ? claims.signing_device_id
        : null,
  };
}
