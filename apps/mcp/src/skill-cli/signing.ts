// Client-side Ed25519 signer for skill publishes (Phase 7).
//
// Mirrors the registry ManifestSigner contract so the bytes the
// server verifies are byte-identical to what we sign here:
//
//   sign:   canonicalize(skill) → Ed25519(SHA-512 over those bytes)
//   verify: same canonicalize → Ed25519 verify
//
// Key material lives in env (SKILL_SIGNING_PRIVATE_KEY) as base64url-
// encoded PKCS8 DER — exactly what `crypto.generateKeyPairSync('ed25519')`
// emits via `.export({format:'der', type:'pkcs8'})`. The matching public
// key lives on the registry as SKILL_VERIFY_PUBLIC_KEY (SPKI DER).
//
// Kept narrow on purpose: the CLI is the only client today. If a second
// publisher ever lands, lift this and the registry signer into a shared
// package — until then the duplication is honest.

import { Buffer } from "node:buffer";
import { createPrivateKey, sign as nodeSign, type KeyObject } from "node:crypto";
import canonicalize from "canonicalize";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { CliExit, ExitCode } from "./errors.js";

export interface SignedSkillEnvelope {
  signature: string;
}

/**
 * Sign a skill with the operator's private key. Source order:
 *
 *   1. `opts.privateKey` (tests inject a KeyObject directly)
 *   2. `SKILL_SIGNING_PRIVATE_KEY` env (production — base64url PKCS8 DER)
 *
 * Throws CliExit(CONFIG) when no key is configured. The registry will
 * reject an unsigned-or-stub-signed publish when its
 * `SKILL_VERIFY_PUBLIC_KEY` is set, so producing a real signature is
 * load-bearing for any non-dev deploy.
 */
export function signSkillForPublish(
  skill: Skill,
  opts: { privateKey?: KeyObject; env?: NodeJS.ProcessEnv } = {},
): SignedSkillEnvelope {
  const env = opts.env ?? process.env;
  const privateKey = opts.privateKey ?? loadPrivateKeyFromEnv(env);

  const canonicalJson = canonicalize(skill);
  if (typeof canonicalJson !== "string") {
    // canonicalize() returns undefined for cyclic objects and similar
    // pathological inputs. Skill is a plain JSON-safe data shape, so
    // hitting this branch means the caller passed something malformed.
    throw new CliExit(
      ExitCode.GENERIC,
      "signing failed: skill object could not be canonicalized to JSON",
    );
  }
  const bytes = Buffer.from(canonicalJson, "utf8");
  const sig = nodeSign(null, bytes, privateKey);
  return { signature: Buffer.from(sig).toString("base64url") };
}

function loadPrivateKeyFromEnv(env: NodeJS.ProcessEnv): KeyObject {
  const raw = env.SKILL_SIGNING_PRIVATE_KEY;
  if (raw === undefined || raw.length === 0) {
    throw new CliExit(
      ExitCode.CONFIG,
      "SKILL_SIGNING_PRIVATE_KEY is not set. Generate an Ed25519 key with:\n" +
        "  node -e \"const {generateKeyPairSync}=require('crypto');" +
        "const {privateKey,publicKey}=generateKeyPairSync('ed25519');" +
        "console.log('priv:',privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'));" +
        "console.log('pub:',publicKey.export({format:'der',type:'spki'}).toString('base64url'));\"\n" +
        "Set the priv: value as SKILL_SIGNING_PRIVATE_KEY here, and the pub: " +
        "value as SKILL_VERIFY_PUBLIC_KEY on the registry.",
    );
  }
  let der: Buffer;
  try {
    der = Buffer.from(raw, "base64url");
  } catch (err) {
    throw new CliExit(
      ExitCode.CONFIG,
      `SKILL_SIGNING_PRIVATE_KEY is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch (err) {
    throw new CliExit(
      ExitCode.CONFIG,
      `SKILL_SIGNING_PRIVATE_KEY is not a valid Ed25519 PKCS8 key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
