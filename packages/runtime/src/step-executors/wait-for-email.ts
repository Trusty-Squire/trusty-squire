// wait_for_email — pause until a matching message arrives at the
// run's inbox alias.
//
// The alias comes from `run.context.email_alias` (allocated when the
// run was created). The matcher is built from chunk-2's EmailMatch.
// On success we record an emit-friendly response shape so subsequent
// steps can interpolate `${steps.<id>.message_id}`, `${steps.<id>.subject}`
// etc. Body bodies aren't placed in the response (they can be large
// and would bloat the audit trail).

import type { WaitForEmailStepDef } from "@trusty-squire/adapter-sdk";
import { EmailTimeoutError, type InboxService } from "@trusty-squire/inbox";
import {
  type BaseStepCtx,
  makeError,
  newStepRecord,
  nowIso,
  toInboxMatcher,
} from "./_helpers.js";
import type { Run, StepError, StepRecord } from "../types.js";

export interface WaitForEmailContext extends BaseStepCtx {
  inbox: InboxService;
}

export type WaitForEmailResult =
  | { kind: "success"; step: StepRecord; new_side_effects: never[] }
  | { kind: "failure"; step: StepRecord; error: StepError };

export async function executeWaitForEmail(
  stepDef: WaitForEmailStepDef,
  run: Run,
  ctx: WaitForEmailContext,
): Promise<WaitForEmailResult> {
  const startedAt = nowIso(ctx);
  const alias = run.context.email_alias;
  const matcher = toInboxMatcher(stepDef.match);
  const requestRecord = { alias, matcher: serialiseMatcher(matcher), timeout_seconds: stepDef.timeout_seconds };

  try {
    const email = await ctx.inbox.waitForEmail({
      alias,
      matcher,
      timeout_seconds: stepDef.timeout_seconds,
    });
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
          links: email.parsed_links,
          codes: email.parsed_codes,
        },
      ),
      new_side_effects: [],
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
        // Timeouts are fatal — no point retrying; the email either
        // didn't arrive or the matcher is wrong.
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

// Serialise an EmailMatcher for the audit record — RegExp values
// get turned into their source/flags so the trail stays JSON-safe.
function serialiseMatcher(m: ReturnType<typeof toInboxMatcher>): unknown {
  const out: Record<string, unknown> = {};
  if (m.from !== undefined) out.from = m.from instanceof RegExp ? m.from.toString() : m.from;
  if (m.subject !== undefined)
    out.subject = m.subject instanceof RegExp ? m.subject.toString() : m.subject;
  if (m.body_contains !== undefined)
    out.body_contains =
      m.body_contains instanceof RegExp ? m.body_contains.toString() : m.body_contains;
  return out;
}
