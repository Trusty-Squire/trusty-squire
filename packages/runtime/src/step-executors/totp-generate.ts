// totp_generate — generate a TOTP code from a vault-stored seed.
//
// Vault read uses retrieveForRuntime (chunk-5 introduced this for
// runtime-internal access without a fresh device assertion). The
// resulting code goes into ${generated.<extract_to>} so the next
// step can interpolate it.

import type { TotpGenerateStepDef } from "@trusty-squire/adapter-sdk";
import { authenticator } from "otplib";
import {
  type BaseStepCtx,
  makeError,
  newStepRecord,
  nowIso,
} from "./_helpers.js";
import { interpolateString, buildScope } from "./interpolate.js";
import type { Run, StepError, StepRecord } from "../types.js";
import type { VaultClient } from "../vault-client.js";

export interface TotpGenerateContext extends BaseStepCtx {
  vault: VaultClient;
}

export type TotpGenerateResult =
  | {
      kind: "success";
      step: StepRecord;
      new_side_effects: never[];
      generated_updates: Record<string, string>;
    }
  | { kind: "failure"; step: StepRecord; error: StepError };

export async function executeTotpGenerate(
  stepDef: TotpGenerateStepDef,
  run: Run,
  ctx: TotpGenerateContext,
): Promise<TotpGenerateResult> {
  const startedAt = nowIso(ctx);
  // The seed_reference can carry placeholders so adapter authors can
  // embed the run's email/account into the vault path.
  const seedRef = interpolateString(stepDef.seed_reference, buildScope(run));
  const requestRecord = {
    seed_reference: seedRef,
    extract_to: stepDef.extract_to,
  };

  let seed: string;
  try {
    seed = await ctx.vault.retrieveForRuntime(seedRef, "totp_generate");
  } catch (err) {
    return {
      kind: "failure",
      step: newStepRecord(
        ctx,
        stepDef.id,
        stepDef.type,
        startedAt,
        nowIso(ctx),
        "failure",
        requestRecord,
        null,
      ),
      error: makeError(
        `TOTP_SEED_MISSING: ${err instanceof Error ? err.message : String(err)}`,
        {},
        { code: "TOTP_SEED_MISSING" },
      ),
    };
  }

  let code: string;
  try {
    // RFC 6238 defaults: SHA-1, 6 digits, 30s. otplib uses these by
    // default. We don't override to keep behaviour matching standard
    // authenticator apps.
    code = authenticator.generate(seed);
  } catch (err) {
    return {
      kind: "failure",
      step: newStepRecord(
        ctx,
        stepDef.id,
        stepDef.type,
        startedAt,
        nowIso(ctx),
        "failure",
        requestRecord,
        null,
      ),
      error: makeError(
        `TOTP_GENERATE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        {},
        { code: "TOTP_GENERATE_FAILED" },
      ),
    };
  }

  return {
    kind: "success",
    step: newStepRecord(
      ctx,
      stepDef.id,
      stepDef.type,
      startedAt,
      nowIso(ctx),
      "success",
      requestRecord,
      {
        // Don't echo the code in the persisted response — like OTPs
        // from email, TOTP codes are short-lived but sensitive.
        extract_to: stepDef.extract_to,
        code_generated: true,
      },
    ),
    new_side_effects: [],
    generated_updates: { [stepDef.extract_to]: code },
  };
}
