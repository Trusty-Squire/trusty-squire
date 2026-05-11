// Standing-mandate signature verification tests.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../canonicalize.js";
import {
  buildSignedMandate,
  generateEd25519,
  generateEs256,
  makeDeps,
  NOW,
  signEd25519,
} from "./_fixtures.js";
import { MandateValidator } from "../validator.js";

describe("verifyMandateSignature", () => {
  it("Valid Ed25519 signature → valid", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    const v = new MandateValidator(makeDeps());
    const r = await v.verifyMandateSignature(signed);
    expect(r.valid).toBe(true);
  });

  it("Valid ECDSA-DER signature → valid", async () => {
    const pair = generateEs256();
    const signed = buildSignedMandate({ pair, es256Encoding: "der" });
    const v = new MandateValidator(makeDeps());
    expect((await v.verifyMandateSignature(signed)).valid).toBe(true);
  });

  it("Valid ECDSA raw r||s signature → valid (browser variant)", async () => {
    const pair = generateEs256();
    const signed = buildSignedMandate({ pair, es256Encoding: "raw" });
    const v = new MandateValidator(makeDeps());
    expect((await v.verifyMandateSignature(signed)).valid).toBe(true);
  });

  it("Tampered payload → invalid", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    // Mutate payload after signing
    signed.payload.monthly_budget_cents = 9_999_999;
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_invalid");
  });

  it("Unknown signing device → invalid (unknown_signing_device)", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    signed.signature.signing_device_id = "01HBOGUSDEVICEZZZZZZZZZZZZZ";
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("unknown_signing_device");
  });

  it("Reused nonce → invalid (nonce_replay)", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair, nonce: "shared-nonce" });
    const deps = makeDeps();
    deps.usedNonces.add("shared-nonce");
    const r = await new MandateValidator(deps).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("nonce_replay");
  });

  it("Successful verify burns the nonce in the deps store", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair, nonce: "fresh-nonce-1" });
    const deps = makeDeps();
    expect(deps.usedNonces.has("fresh-nonce-1")).toBe(false);
    await new MandateValidator(deps).verifyMandateSignature(signed);
    expect(deps.usedNonces.has("fresh-nonce-1")).toBe(true);
  });

  it("Failed verify does NOT burn the nonce (so a retry is possible)", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair, nonce: "retryable-nonce" });
    signed.payload.monthly_budget_cents = 1; // tamper
    const deps = makeDeps();
    await new MandateValidator(deps).verifyMandateSignature(signed);
    expect(deps.usedNonces.has("retryable-nonce")).toBe(false);
  });

  it("signed_at older than 7 days → invalid (signed_at_too_old)", async () => {
    const pair = generateEd25519();
    // 8 days before NOW
    const signedAt = new Date(Date.parse(NOW) - 8 * 24 * 60 * 60 * 1000).toISOString();
    const signed = buildSignedMandate({ pair, signedAt });
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signed_at_too_old");
  });

  it("signature alg ≠ device alg → invalid (signature_alg_mismatch)", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    signed.signature.alg = "ES256"; // claim ECDSA but device is Ed25519
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signature_alg_mismatch");
  });

  it("signing device revoked before signed_at → invalid", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    // Mutate the embedded device to be revoked at NOW (before signed_at would
    // need to be after revocation; here equality also rejects per spec).
    signed.payload.signing_devices[0]!.revoked_at = NOW;
    // Re-sign because mutation changed the canonical bytes.
    const message = canonicalBytes(signed.payload);
    signed.signature.sig = signEd25519(pair.privateKey, message);
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signing_device_revoked");
  });

  it("malformed signed_at → invalid", async () => {
    const pair = generateEd25519();
    const signed = buildSignedMandate({ pair });
    signed.signature.signed_at = "not-a-date";
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("signed_at_unparseable");
  });

  it("ES256 signature too short (neither raw nor DER) → invalid", async () => {
    const pair = generateEs256();
    const signed = buildSignedMandate({ pair });
    // Replace with 32-byte garbage (valid base64url, not a valid sig length)
    signed.signature.sig = Buffer.from(new Uint8Array(32).fill(1)).toString("base64url");
    const r = await new MandateValidator(makeDeps()).verifyMandateSignature(signed);
    expect(r.valid).toBe(false);
    // Falls through to signature_invalid (detection returned null → false)
    expect(r.reason).toBe("signature_invalid");
  });
});

