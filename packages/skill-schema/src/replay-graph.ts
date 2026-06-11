// Static replay-completeness contract for a Skill's step graph.
//
// The verifier (live replay → active) and the router's dry-run validate a
// skill BEHAVIORALLY — does it still work against the live site. They are
// the wrong tool for STRUCTURAL impossibility: a graph that can never
// replay (an await_email_code with nothing to send it a code, a signup_url
// carrying a per-run email) would burn a ~3-4 min live signup just to
// discover what a millisecond static check catches. The registry enforces
// this at POST /skills so such skills are rejected at the trust boundary
// instead of rotting in pending-review; the synthesizer reuses it to fail
// fast locally.
//
// Pure + dependency-free so both the registry server and the mcp client
// validate against one contract.

import type { Skill, SkillStep } from "./skill.js";

export type ReplayGraphCheck =
  | { ok: true }
  | { ok: false; code: ReplayGraphErrorCode; reason: string };

export type ReplayGraphErrorCode =
  | "await_code_without_email_dispatch"
  | "per_run_signup_url_param";

// Query params that encode a per-run identity/session and must never be
// baked into a skill's signup_url — a replay on a fresh alias would carry
// the ORIGINAL run's email/session and dead-end. Mirrors the synthesizer's
// EPHEMERAL_URL_PARAM so the contract is consistent on both ends.
const PER_RUN_SIGNUP_PARAM =
  /^(psid|sid|session|session_id|sessionid|token|access_token|auth|state|code|redirect_to|continue|ticket|nonce|email|signup_email|user_email)$/i;

function fillSendsEmail(step: SkillStep): boolean {
  return step.kind === "fill" && /\$\{EMAIL_ALIAS\}/.test(step.value_template);
}

/**
 * Assert a skill's step graph is structurally replayable. Behavioral
 * correctness (does the live site still match) is the verifier's job; this
 * only rejects graphs that CANNOT replay regardless of the live site.
 */
export function validateReplayGraph(skill: Skill): ReplayGraphCheck {
  const steps = skill.steps;

  // 1. An await_email_code step needs the code to have been DISPATCHED
  //    earlier in the same replay: the run's alias must be entered (a fill
  //    referencing ${EMAIL_ALIAS}) AND a click must follow it to submit /
  //    send the code. Without that, the step polls an inbox nothing ever
  //    mailed. This is the zilliz-class gap: a capture that began on the
  //    post-signup verify page, so the email-fill + send-code were never
  //    recorded.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.kind !== "await_email_code") continue;
    const before = steps.slice(0, i);
    const emailFillIdx = before.findIndex(fillSendsEmail);
    if (emailFillIdx === -1) {
      return {
        ok: false,
        code: "await_code_without_email_dispatch",
        reason:
          `Step ${i} is await_email_code but no preceding step fills the run's ` +
          `email (a fill referencing \${EMAIL_ALIAS}). Nothing dispatches a ` +
          `verification code on replay, so the step can only time out. The ` +
          `capture likely began on the post-signup verify page — it must ` +
          `include the signup-form fill (email + password) and the send-code ` +
          `click before await_email_code.`,
      };
    }
    const hasSubmitAfterEmail = before
      .slice(emailFillIdx + 1)
      .some((s) => s.kind === "click");
    if (!hasSubmitAfterEmail) {
      return {
        ok: false,
        code: "await_code_without_email_dispatch",
        reason:
          `Step ${i} is await_email_code and the email is filled at step ` +
          `${emailFillIdx}, but no click follows it to submit the form / send ` +
          `the code. A code is never dispatched, so the step can only time out.`,
      };
    }
  }

  // 2. signup_url must be generalized — no per-run identity/session params.
  //    `/signup/verify?email=ghall284@…` would point a fresh replay at the
  //    ORIGINAL run's verify page.
  try {
    const u = new URL(skill.signup_url);
    for (const key of u.searchParams.keys()) {
      if (PER_RUN_SIGNUP_PARAM.test(key)) {
        return {
          ok: false,
          code: "per_run_signup_url_param",
          reason:
            `signup_url carries a per-run param "${key}" ` +
            `(${skill.signup_url}). A replay on a fresh alias would inherit ` +
            `the original run's value. Strip it during synthesis.`,
        };
      }
    }
  } catch {
    // Relative/malformed signup_url — the schema already constrains shape;
    // the entry navigate covers it. Not a replay-graph concern here.
  }

  return { ok: true };
}
