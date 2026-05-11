// Signer tests — round-trip via verifyManifestSignature.

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  ManifestSigner,
  SignerConfigError,
  verifyManifestSignature,
} from "../signer.js";
import { generateEd25519KeyPair, makeValidManifest } from "./_fixtures.js";

describe("ManifestSigner", () => {
  it("signs + verifies via the public key", () => {
    const { privateKey, publicKeyB64 } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey, "test");
    const manifest = makeValidManifest();
    const env = signer.sign(manifest);
    expect(verifyManifestSignature(manifest, env.signature, publicKeyB64)).toBe(true);
  });

  it("verification fails on a tampered manifest", () => {
    const { privateKey, publicKeyB64 } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey, "test");
    const manifest = makeValidManifest();
    const env = signer.sign(manifest);
    const tampered = { ...manifest, version: "9.9.9" };
    expect(verifyManifestSignature(tampered, env.signature, publicKeyB64)).toBe(false);
  });

  it("verification fails on a tampered signature", () => {
    const { privateKey, publicKeyB64 } = generateEd25519KeyPair();
    const signer = ManifestSigner.fromKeyObject(privateKey, "test");
    const manifest = makeValidManifest();
    const env = signer.sign(manifest);
    const tampered = env.signature.slice(0, -2) + "AA";
    expect(verifyManifestSignature(manifest, tampered, publicKeyB64)).toBe(false);
  });

  it("fromEnv throws when ADAPTER_SIGNING_PRIVATE_KEY missing", () => {
    expect(() => ManifestSigner.fromEnv({} as NodeJS.ProcessEnv)).toThrow(SignerConfigError);
  });

  it("fromEnv throws on a malformed key", () => {
    expect(() =>
      ManifestSigner.fromEnv({
        ADAPTER_SIGNING_PRIVATE_KEY: "not-a-real-key",
      } as NodeJS.ProcessEnv),
    ).toThrow(SignerConfigError);
  });

  it("fromEnv accepts a valid base64url-encoded PKCS8 Ed25519 key", () => {
    const { privateKey } = generateEd25519KeyPair();
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const env = { ADAPTER_SIGNING_PRIVATE_KEY: Buffer.from(der).toString("base64url") } as NodeJS.ProcessEnv;
    const signer = ManifestSigner.fromEnv(env, "ts-test");
    expect(signer.signedBy).toBe("ts-test");
    const manifest = makeValidManifest();
    const out = signer.sign(manifest);
    expect(out.signed_by).toBe("ts-test");
  });
});
