// wait_for_email_with_code — wait_for_email + extract an OTP code
// into ${generated.<extract_to>}.
//
// `code_pattern` from chunk-2 is a string. We try parsing it as a
// regex literal (`/.../flags`), fall back to treating it as the
// regex source. An empty pattern uses the inbox's default OTP
// pattern set (priority-ordered).

import type { WaitForEmailWithCodeStepDef } from "@trusty-squire/adapter-sdk";
import { EmailTimeoutError, type InboxService } from "@trusty-squire/inbox";
import {
  type BaseStepCtx,
  makeError,
  newStepRecord,
  nowIso,
  parseAsRegexLiteral,
  toInboxMatcher,
} from "./_helpers.js";
import type { Run, StepError, StepRecord } from "../types.js";

export interface WaitForEmailWithCodeContext extends BaseStepCtx {
  inbox: InboxService;
}

export type WaitForEmailWithCodeResult =
  | {
      kind: "success";
      step: StepRecord;
      new_side_effects: never[];
      generated_updates: Record<string, string>;
    }
  | { kind: "failure"; step: StepRecord; error: StepError };

export async function executeWaitForEmailWithCode(
  stepDef: WaitForEmailWithCodeStepDef,
  run: Run,
  ctx: WaitForEmailWithCodeContext,
): Promise<WaitForEmailWithCodeResult> {
  const startedAt = nowIso(ctx);
  const alias = run.context.email_alias;
  const matcher = toInboxMatcher(stepDef.match);
  const codeRegex = parseCodePattern(stepDef.code_pattern);
  const requestRecord = {
    alias,
    timeout_seconds: stepDef.timeout_seconds,
    extract_to: stepDef.extract_to,
    code_pattern: stepDef.code_pattern,
  };

  try {
    const email = await ctx.inbox.waitForEmail({
      alias,
      matcher,
      timeout_seconds: stepDef.timeout_seconds,
    });
    const code = await ctx.inbox.parseCode(
      email,
      codeRegex !== null ? codeRegex : undefined,
    );
    if (code === null) {
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
          {
            message_id: email.message_id,
            from: email.from_address,
            subject: email.subject,
            code_extracted: false,
          },
        ),
        // No code in an otherwise-matched email = something structural
        // is off (provider changed format, the wrong template hit our
        // inbox). Tier escalation lets a tier-2 (browser) fallback pick
        // up the code from the page directly.
        error: makeError("STEP_PARSE_FAILED: no code found in email", {
          causes_tier_escalation: true,
        }, { code: "STEP_PARSE_FAILED" }),
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
          message_id: email.message_id,
          from: email.from_address,
          subject: email.subject,
          // Don't echo the code in the persisted response — the
          // audit trail is queryable and OTPs are sensitive in flight.
          code_extracted: true,
          extract_to: stepDef.extract_to,
        },
      ),
      new_side_effects: [],
      generated_updates: { [stepDef.extract_to]: code },
    };
  } catch (err) {
    if (err instanceof EmailTimeoutError) {
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
        error: makeError(`EMAIL_TIMEOUT: ${err.message}`, {}, { code: "EMAIL_TIMEOUT" }),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
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
      error: makeError(message, {}, { code: "EMAIL_WAIT_FAILED" }),
    };
  }
}

function parseCodePattern(pattern: string): RegExp | null {
  if (pattern.length === 0) return null;
  const literal = parseAsRegexLiteral(pattern);
  if (literal !== null) return literal;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
