import { describe, expect, it } from "vitest";
import { classifyPaymentCandidateBinding, type PaymentCandidateHash } from "../index.js";

const approval: PaymentCandidateHash = {
  base64url: "A".repeat(43),
  hex: "ab".repeat(32),
};
const review: PaymentCandidateHash = {
  base64url: "B".repeat(43),
  hex: "cd".repeat(32),
};

function classify(
  claimedPayloadHash: unknown,
  candidate: { jws?: string | null; sealedCard?: string | null } = {
    jws: "header.payload.signature",
    sealedCard: "sealed",
  },
) {
  return classifyPaymentCandidateBinding({
    jws: candidate.jws,
    sealedCard: candidate.sealedCard,
    claimedPayloadHash,
    approvalPayloadHash: approval,
    reviewPayloadHash: review,
  });
}

describe("classifyPaymentCandidateBinding", () => {
  it("distinguishes absent, review-bound, approval-bound, and malformed candidates", () => {
    expect(classify(null, { jws: null, sealedCard: null })).toBe("none");
    expect(classify(review.base64url)).toBe("review");
    expect(classify(approval.hex.toUpperCase())).toBe("approval");
    expect(classify("not-a-sha256")).toBe("invalid");
    expect(classify(approval.base64url, { jws: "signed", sealedCard: null })).toBe("invalid");
  });
});
