// Top-level MandateValidator class — composes the operations into the
// dependency-injected interface the runtime consumes.
//
// Two signature paths:
//   - signature: legacy raw Ed25519 / ES256 (verifyMandateSignature /
//     verifyDeltaSignature)
//   - bundle:    Vouchflow signPayload bundle (verifyMandateBundle /
//     verifyDeltaBundle). Chunk-10 onwards uses this for the API.

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { evaluateAction } from "./policy-evaluator.js";
import {
  verifyDeltaBundle,
  verifyDeltaSignature,
  type VouchflowDeltaVerification,
} from "./validate-delta.js";
import {
  verifyMandateBundle,
  verifyMandateSignature,
  type VouchflowMandateVerification,
} from "./validate-mandate.js";
import type { VouchflowSignedBundle, VouchflowVerifier } from "./vouchflow.js";
import type {
  ConfidenceLevel,
  DeltaChallenge,
  EvaluationContext,
  Mandate,
  MandateValidatorDeps,
  PolicyDecision,
  ProposedAction,
  SignedDelta,
  SignedMandate,
  ValidationResult,
} from "./types.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_BYTES = 32;

export class MandateValidator {
  constructor(
    private readonly deps: MandateValidatorDeps,
    // Optional: only required for verifyMandateBundle / verifyDeltaBundle.
    // Tests of the raw-signature path can omit it.
    private readonly vouchflow?: VouchflowVerifier,
  ) {}

  verifyMandateSignature(signed: SignedMandate): Promise<ValidationResult> {
    return verifyMandateSignature(signed, this.deps);
  }

  verifyMandateBundle(bundle: VouchflowSignedBundle): Promise<VouchflowMandateVerification> {
    this.requireVouchflow("verifyMandateBundle");
    return verifyMandateBundle(bundle, this.vouchflow!, this.deps);
  }

  verifyDeltaSignature(signed: SignedDelta, mandate: Mandate): Promise<ValidationResult> {
    return verifyDeltaSignature(signed, mandate, this.deps);
  }

  verifyDeltaBundle(
    bundle: VouchflowSignedBundle,
    mandate: Mandate,
    minConfidence: ConfidenceLevel,
  ): Promise<VouchflowDeltaVerification> {
    this.requireVouchflow("verifyDeltaBundle");
    return verifyDeltaBundle(bundle, mandate, minConfidence, this.vouchflow!, this.deps);
  }

  private requireVouchflow(method: string): void {
    if (this.vouchflow === undefined) {
      throw new Error(
        `MandateValidator.${method} requires a VouchflowVerifier; construct with new MandateValidator(deps, verifier)`,
      );
    }
  }

  evaluateAction(
    mandate: Mandate,
    action: ProposedAction,
    ctx: EvaluationContext,
  ): Promise<PolicyDecision> {
    return evaluateAction(mandate, action, ctx, this.deps);
  }

  // The runtime asks for a challenge before redirecting the user to
  // their device for approval. The nonce is cryptographically random
  // (32 bytes hex-encoded → 64 chars). expires_at gates how long the
  // user has to sign before the runtime needs to issue a fresh one.
  //
  // run_id and action are accepted for forward compatibility — future
  // versions may bind them to the challenge so that a stolen nonce
  // can't be re-used for an unrelated action. Today we just generate.
  async issueDeltaChallenge(
    _runId: string,
    _action: ProposedAction,
  ): Promise<DeltaChallenge> {
    const nonce = Buffer.from(randomBytes(NONCE_BYTES)).toString("hex");
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const expires_at = new Date(now + CHALLENGE_TTL_MS).toISOString();
    return { nonce, expires_at };
  }
}
