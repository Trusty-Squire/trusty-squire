// Ed25519 manifest signer. Signs the canonical-bytes of the manifest
// JSON; the published `signature` field is base64url-encoded.
//
// Key material lives in env vars (ADAPTER_SIGNING_PRIVATE_KEY +
// ADAPTER_SIGNING_PUBLIC_KEY) as base64url-encoded DER (PKCS8 for
// private, SPKI for public). This matches what
// `crypto.generateKeyPairSync('ed25519')` produces directly via
// `.export({ format: 'der', type: 'pkcs8' / 'spki' })`.

import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import canonicalize from "canonicalize";
import type { AdapterManifest } from "@trusty-squire/adapter-sdk";

export class SignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerConfigError";
  }
}

export interface SignedManifestEnvelope {
  signature: string;
  signed_at: string;
  signed_by: string;
}

export class ManifestSigner {
  constructor(private readonly privateKey: KeyObject, public readonly signedBy: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, signedBy = "trusty-squire-core"): ManifestSigner {
    const raw = env.ADAPTER_SIGNING_PRIVATE_KEY;
    if (raw === undefined || raw.length === 0) {
      throw new SignerConfigError(
        "ADAPTER_SIGNING_PRIVATE_KEY is not set. " +
          "Generate a key with the snippet in .env.example.",
      );
    }
    const der = Buffer.from(raw, "base64url");
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } catch (err) {
      throw new SignerConfigError(
        `ADAPTER_SIGNING_PRIVATE_KEY is not a valid Ed25519 PKCS8 key: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return new ManifestSigner(privateKey, signedBy);
  }

  // Direct constructor for tests.
  static fromKeyObject(privateKey: KeyObject, signedBy = "test"): ManifestSigner {
    return new ManifestSigner(privateKey, signedBy);
  }

  sign(manifest: AdapterManifest): SignedManifestEnvelope {
    const bytes = canonicalBytes(manifest);
    const sig = nodeSign(null, bytes, this.privateKey);
    return {
      signature: Buffer.from(sig).toString("base64url"),
      signed_at: new Date().toISOString(),
      signed_by: this.signedBy,
    };
  }
}

// Standalone verifier for tests + future RegistryClient hardening.
// Public key is base64url-encoded SPKI DER.
export function verifyManifestSignature(
  manifest: AdapterManifest,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  const der = Buffer.from(publicKeyB64, "base64url");
  let pub: KeyObject;
  try {
    pub = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return false;
  }
  const sig = Buffer.from(signatureB64, "base64url");
  return nodeVerify(null, canonicalBytes(manifest), pub, sig);
}

function canonicalBytes(manifest: AdapterManifest): Buffer {
  const json = canonicalize(manifest);
  if (typeof json !== "string") {
    throw new SignerConfigError("manifest could not be canonicalized");
  }
  return Buffer.from(json, "utf8");
}
