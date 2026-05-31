// Ed25519 signer for published Skills. Signs canonical-bytes of the
// Skill JSON; the published `signature` field is base64url-encoded.
//
// Key material lives in env vars as base64url-encoded DER (PKCS8 for
// private, SPKI for public). This matches what
// `crypto.generateKeyPairSync('ed25519')` produces directly via
// `.export({ format: 'der', type: 'pkcs8' / 'spki' })`.
//
// The env var name is `ADAPTER_SIGNING_PRIVATE_KEY` (and the class
// keeps the historical `ManifestSigner` name) — both predate the 0.8
// native-provision sunset, but renaming them now would require a
// fly-secrets dance and offers no functional gain. The signed payload
// today is always a Skill.

import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import canonicalize from "canonicalize";
import type { Skill } from "@trusty-squire/skill-schema";

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

  signSkill(skill: Skill): SignedManifestEnvelope {
    const bytes = canonicalBytes(skill);
    const sig = nodeSign(null, bytes, this.privateKey);
    return {
      signature: Buffer.from(sig).toString("base64url"),
      signed_at: new Date().toISOString(),
      signed_by: this.signedBy,
    };
  }
}

// Verify the signature on a published Skill. Used by the registry's
// POST /skills route when SKILL_VERIFY_PUBLIC_KEY is configured.
// Returns false for any failure path (malformed key, malformed
// signature, mismatch) — never throws, so the route can fall through
// cleanly to a 401 response.
export function verifySkillSignature(
  skill: Skill,
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
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64url");
  } catch {
    return false;
  }
  try {
    return nodeVerify(null, canonicalBytes(skill), pub, sig);
  } catch {
    return false;
  }
}

function canonicalBytes(payload: Skill): Buffer {
  const json = canonicalize(payload);
  if (typeof json !== "string") {
    throw new SignerConfigError("payload could not be canonicalized");
  }
  return Buffer.from(json, "utf8");
}
