export type PaymentCandidateKind = "none" | "review" | "approval" | "invalid";

export interface PaymentCandidateHash {
  base64url: string;
  hex: string;
}

export interface PaymentCandidateBindingInput {
  jws: string | null | undefined;
  sealedCard: string | null | undefined;
  claimedPayloadHash: unknown;
  approvalPayloadHash: PaymentCandidateHash | null;
  reviewPayloadHash: PaymentCandidateHash | null;
}

function equalText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

function matchesHash(claim: string, expected: PaymentCandidateHash): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(claim)) {
    return equalText(claim.toLowerCase(), expected.hex.toLowerCase());
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(claim)) {
    return equalText(claim, expected.base64url);
  }
  return false;
}

/**
 * Classifies the authorization boundary of a relayed payment candidate.
 *
 * This function deliberately performs no JWS verification and opens no card.
 * Callers first extract the untrusted payload_sha256 claim, then use this
 * classifier only to choose which expected AAD must be verified cryptographically.
 */
export function classifyPaymentCandidateBinding(
  input: PaymentCandidateBindingInput,
): PaymentCandidateKind {
  const hasJws = typeof input.jws === "string";
  const hasSealedCard = typeof input.sealedCard === "string";
  if (!hasJws && !hasSealedCard) return "none";
  if (!hasJws || !hasSealedCard || typeof input.claimedPayloadHash !== "string") {
    return "invalid";
  }
  if (
    input.approvalPayloadHash !== null &&
    matchesHash(input.claimedPayloadHash, input.approvalPayloadHash)
  ) {
    return "approval";
  }
  if (
    input.reviewPayloadHash !== null &&
    matchesHash(input.claimedPayloadHash, input.reviewPayloadHash)
  ) {
    return "review";
  }
  return "invalid";
}
