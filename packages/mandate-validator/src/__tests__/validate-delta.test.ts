// Per-action delta verification tests.
//
// The run_binding mismatch case is the security-critical one: a stolen
// approval for a $5 action must NOT be reusable to authorise a $50
// action. That's what binding the delta to (run_id, service, plan,
// cost_cents) prevents.

import { describe, expect, it } from "vitest";
import {
  buildSignedDelta,
  buildSignedMandate,
  generateEd25519,
  makeDeps,
  NOW,
} from "./_fixtures.js";
import { MandateValidator } from "../validator.js";

describe("verifyDeltaSignature", () => {
  it("Run binding matches → valid", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate });
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(true);
  });

  it("Run binding mismatch → invalid (security-critical)", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate });
    // Tamper the run_binding (or change cost without re-binding) — same
    // attack: approval was for a different action.
    signed.payload.run_binding = "0".repeat(64);
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("run_binding_mismatch");
  });

  it("Cost-cents tampering after signing → mismatch (binding catches it)", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate });
    // Bump cost without recomputing the binding — the signed binding
    // still references the original cost, so verification fails.
    signed.payload.action.cost_cents = 999_999;
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("run_binding_mismatch");
  });

  it("Nonce already used → invalid (nonce_replay)", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate, nonce: "burned-nonce" });
    const deps = makeDeps();
    deps.usedNonces.add("burned-nonce");
    const r = await new MandateValidator(deps).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("nonce_replay");
  });

  it("Wrong mandate_id → invalid (mandate_id_mismatch)", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({
      pair,
      mandate,
      payloadOverrides: { mandate_id: "01HOTHERMANDATEZZZZZZZZZZZZ" },
    });
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("mandate_id_mismatch");
  });

  it("Wrong account_id → invalid (account_id_mismatch)", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({
      pair,
      mandate,
      payloadOverrides: { account_id: "01HOTHERACCOUNTAAAAAAAAAAA" },
    });
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("account_id_mismatch");
  });

  it("Expired delta (signed_at older than 7 days) → invalid", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signedAt = new Date(Date.parse(NOW) - 8 * 24 * 60 * 60 * 1000).toISOString();
    const signed = buildSignedDelta({ pair, mandate, signedAt });
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signed_at_too_old");
  });

  it("Unknown signing device → invalid", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate });
    signed.signature.signing_device_id = "01HSTRANGERZZZZZZZZZZZZZZZZ";
    const r = await new MandateValidator(makeDeps()).verifyDeltaSignature(signed, mandate);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("unknown_signing_device");
  });

  it("Successful verify burns the delta nonce", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate, nonce: "delta-fresh-1" });
    const deps = makeDeps();
    await new MandateValidator(deps).verifyDeltaSignature(signed, mandate);
    expect(deps.usedNonces.has("delta-fresh-1")).toBe(true);
  });

  it("Failed signature verification does NOT burn the nonce", async () => {
    const pair = generateEd25519();
    const mandate = buildSignedMandate({ pair }).payload;
    const signed = buildSignedDelta({ pair, mandate, nonce: "retry-delta" });
    // Tamper a non-binding field after signing
    signed.payload.not_after = "2099-01-01T00:00:00.000Z";
    const deps = makeDeps();
    await new MandateValidator(deps).verifyDeltaSignature(signed, mandate);
    expect(deps.usedNonces.has("retry-delta")).toBe(false);
  });
});
