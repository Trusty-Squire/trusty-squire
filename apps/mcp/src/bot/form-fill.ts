// form-fill.ts — pure decision primitives of the signup FORM-FILL phase, carved
// out of planExecuteWithRetry (strangler slice 3 — see DESIGN-form-fill-engine.md).
// Browser-free + unit-tested. This commit is the no-progress / stuck-loop
// detector (F14 + the page-fingerprint progress check) — the highest-value,
// most self-contained piece and a recurring brittleness source (kinde/Railway
// false-bails). The full decideFormFillStep reducer is the next increment.
//
// Not yet wired into agent.ts — changing this file cannot regress the live path.

// The page "moved" between two form-fill rounds iff the URL changed OR the set of
// interactive selectors changed (a field gained/lost, a validation message
// toggled an element, a wizard step advanced). The fingerprint is url + the
// sorted selector set; ANY change means the previous round made real progress.
export function computePageSig(url: string, selectors: readonly string[]): string {
  return `${url}§${[...selectors].sort().join("|")}`;
}

export function pageMovedSince(prevSig: string | null, currSig: string): boolean {
  return prevSig !== null && currSig !== prevSig;
}

// F14 stuck-loop test: a plan that clicks ONLY selectors already proven dead last
// round (no page progress) — and edits no field — is a planner loop; bail rather
// than re-click forever. Does NOT fire when the plan adds a NEW selector
// (legitimate exploration) or edits a field this round (a fill/check alongside a
// repeated click is real progress — kinde's "tick the required box + re-click
// Next" advances the form even though the Next selector repeats). Pure.
export function isStuckRepeat(input: {
  planClickSelectors: readonly string[];
  planEditsAField: boolean; // any fill/check action this round
  noProgressSelectors: ReadonlySet<string>; // selectors that didn't advance last round
}): boolean {
  if (input.planEditsAField) return false;
  if (input.planClickSelectors.length === 0) return false;
  if (input.noProgressSelectors.size === 0) return false;
  return input.planClickSelectors.every((s) => input.noProgressSelectors.has(s));
}

// The dead-selector memory update after a NO-PROGRESS round (the page only
// revealed/advanced, no fillable form yet): a field edit this round means real
// progress → clear the set; otherwise record THIS round's click selectors so the
// next round's isStuckRepeat can catch a loop. Pure (returns a fresh set).
export function nextNoProgressSet(input: {
  planClickSelectors: readonly string[];
  hadFieldEdit: boolean;
}): Set<string> {
  return input.hadFieldEdit ? new Set() : new Set(input.planClickSelectors);
}

// ───────────────────────────────────────────────────────────────────────────
// decideFormFillStep — the PURE decision reducer for the form-fill phase, carved
// out of planExecuteWithRetry (agent.ts:4648–5392). Eng-reviewed (Claude + Codex,
// 2026-06-15, report in DESIGN-form-fill-engine.md). The review's headline:
// unlike the OAuth slice, a form-fill ROUND is NOT one observation→decision; it
// is a SEQUENCE of FOUR I/O-gated checkpoints where later I/O depends on earlier
// decisions (the LLM planner doesn't run if the OAuth-first scan short-circuits).
// So this is a PHASE-DISCRIMINATED reducer: the executor calls it at each
// checkpoint with that checkpoint's I/O-gathered facts, runs the returned
// action's I/O, then re-enters at the next phase.
//
//     decideFormFillStep(state, observation) → { action, nextState }
//
// BOUNDARY (the review's Q2): the reducer DECIDES; the executor owns ALL I/O and
// the *content* of any replan hint (e.g. the submit_disabled snapshot that lists
// concrete unchecked-checkbox candidates is a fresh buildInventory read — the
// reducer only emits the hint INTENT). The reducer never touches a browser.
//
// Faithfulness anchors (review's commit-2 checklist):
//   • the 4 checkpoints as obs.checkpoint (C3 post_plan is the only pure one).
//   • the OAuth-first nested scan's actions + budget resets (oauthScanRetries→0
//     on shell-reload AND advance-click).
//   • committedToEmailPath one-way control-state (suppresses C1's OAuth-first scan).
//   • the FOUR-debt counter taxonomy (errorReplans vs progressReplans vs
//     upstreamBlipRetries vs emptyPlans) — each ticked in its own branch.
//   • the 2 non-local terminal flips (managed-Turnstile+inbox→submitted;
//     validation w/ progress budget exhausted→submitted).

// The per-signup budget ceilings (agent.ts:4583–4616). Exported so the executor
// and the golden-transition tests share one source of truth.
export const FORM_FILL_BUDGETS = {
  MAX_ERROR_REPLANS: 2,
  MAX_PROGRESS_REPLANS: 6,
  MAX_EMPTY_PLANS: 2, // bail at the 2nd *consecutive* empty plan
  MAX_OAUTH_SCAN_RETRIES_SHELL: 8,
  MAX_OAUTH_SCAN_RETRIES_FORM: 2,
  MAX_OAUTH_SHELL_RELOADS: 1,
  MAX_UPSTREAM_BLIP_RETRIES: 8,
  MAX_SIGN_IN_ADVANCE_CLICKS: 2,
} as const;

// Loop-carried DECISION state — every var that survives across loop passes
// (agent.ts:4591–4645). I/O-timing-only state stays in the executor; everything
// that changes a DECISION lives here. `phase` is informational (the executor
// drives the checkpoint via obs.checkpoint); kept for trace/debug parity.
export interface FormFillState {
  // four-debt counter taxonomy (review Q1) — each ticked in a distinct branch:
  errorReplans: number; // invalid planner OUTPUT (parse fail / verifyPlan miss)
  progressReplans: number; // page advanced, no fill yet — ALSO submit_disabled/timeout/validation
  emptyPlans: number; // consecutive 0-action plans; reset to 0 on any non-empty plan
  upstreamBlipRetries: number; // 50x / network on the planner call — does NOT tick errorReplans
  oauthScanRetries: number; // async-render waits for a late OAuth button
  oauthShellReloads: number; // one reload to unstick a wedged loading-shell SPA
  signInAdvanceClicks: number; // click-throughs of a generic "Sign In to Continue" gate
  // page-fingerprint memory (the F14 stuck detector's inputs):
  lastRoundPageSig: string | null;
  lastNoProgressClickSelectors: ReadonlySet<string>;
  // one-way control-state (review A3): once on the email path, suppress the
  // OAuth-first scan so a two-stage chooser can't reroute back to Google.
  committedToEmailPath: boolean;
}

// The fresh FormFillState at loop entry. `forceFormFill` seeds committedToEmailPath
// (the re-route after a no-account Google bounce — agent.ts:4645).
export function initialFormFillState(forceFormFill = false): FormFillState {
  return {
    errorReplans: 0,
    progressReplans: 0,
    emptyPlans: 0,
    upstreamBlipRetries: 0,
    oauthScanRetries: 0,
    oauthShellReloads: 0,
    signInAdvanceClicks: 0,
    lastRoundPageSig: null,
    lastNoProgressClickSelectors: new Set(),
    committedToEmailPath: forceFormFill,
  };
}

// The terminal outcomes (mirror PlanExecOutcome in agent.ts). The reducer emits a
// `terminal` action carrying one of these; the executor returns it verbatim.
export type FormFillOutcome =
  | { kind: "submitted" }
  | { kind: "captcha_blocked"; captchaKind: string }
  | { kind: "submit_failed"; reason: string }
  | { kind: "planning_failed"; reason: string }
  | { kind: "oauth_required" }
  | {
      kind: "needs_oauth_provider_session";
      missingProviders: readonly string[];
      haveSessions: readonly string[];
    }
  | { kind: "anti_bot_blocked"; vendor: string }
  | { kind: "oauth"; selector: string; provider: string }
  | { kind: "already_oauth" };

// ── observations, one shape per checkpoint (discriminated by `checkpoint`) ──

// C1 pre_plan — facts read AFTER waitForFormReady + dismissConsentBanner +
// getState + buildInventory. Drives every short-circuit BEFORE the planner runs.
export interface PrePlanObservation {
  checkpoint: "pre_plan";
  hasFillableInput: boolean;
  // verify-email WALL (no fields, "check your email" copy, alias we can poll):
  verifyWall: boolean;
  // code-ENTRY gate (axiom-class passwordless: a code input, post-email-submit):
  codeGate: boolean;
  // OAuth-first scan inputs:
  oauthCandidatesPresent: boolean;
  oauthButtonHit: { selector: string; provider: string } | null;
  oauthScanShell: boolean; // loading-shell / ≤1 element / no credential input
  alreadySignedIn: boolean; // dashboard markers + no credential form
  signInAdvancePresent: boolean; // a generic "Sign In to Continue" interstitial
  // terminal classifiers:
  antiBotVendor: string | null; // detectAntiBotBlock when inventory < 10
  oauthOnly: boolean; // isOauthOnlyChooser — nothing fillable, no email option
  // The recoverable split (agent.ts:4954–4974): providers visible on the page the
  // bot has NO session for, AND the sessions it DOES have. When the missing set is
  // non-empty and the bot holds ≥1 session, surface needs_oauth_provider_session
  // (the operator can seed the missing one) instead of the opaque oauth_required.
  oauthOnlyMissingProviders: readonly string[];
  oauthOnlyHaveSessions: readonly string[];
}

// C2 plan — the planSignupForm call THREW. The executor classifies the error.
export interface PlanErrorObservation {
  checkpoint: "plan_error";
  isUpstreamBlip: boolean; // 50x / upstream_error / network — transient, not logic
  reason: string;
}

// C3 post_plan — a plan validated. The page-fingerprint + stuck check + the
// verifyPlan result. This is the ONLY genuinely-pure checkpoint (review A1).
export interface PostPlanObservation {
  checkpoint: "post_plan";
  isDashboard: boolean; // detectFormFillIsDashboard(plan) — a logged-in product page
  pageSig: string; // computePageSig(url, selectors) for THIS round
  planClickSelectors: readonly string[];
  planEditsAField: boolean; // any fill/check this round
  verifyMiss: string | null; // verifyPlan() result; null = all picks resolve
  verifyMissNotCheckbox: boolean; // the miss was a "not a checkbox" (drop-the-check hint)
}

// C4 post_execute — the plan ran. Decides commit-to-email, the empty/no-fill
// replan, then (when a fill IS present) hands to submit. `submit` + post-submit
// facts arrive in PostSubmitObservation once the executor has clicked submit.
export interface PostExecuteObservation {
  checkpoint: "post_execute";
  clickedEmailAffordance: boolean; // a click whose reason matched /\bemail\b/
  planClickSelectors: readonly string[];
  hadFill: boolean; // a fill action (promotes to submit)
  hadFieldEdit: boolean; // fill OR check (progress for the no-progress tracker)
  planActionCount: number; // 0 = the planner found nothing actionable
}

// C4 post_submit — captcha pre-gate / submit click / post-gate / validation.
export interface PostSubmitObservation {
  checkpoint: "post_submit";
  preGateBlocked: boolean;
  preGateKind: string;
  submitError: string | null; // null = clickSubmit succeeded
  submitDisabled: boolean; // submit_disabled — a required control gates submission
  submitTimeout: boolean; // the submit selector went stale (page advanced)
  postGateBlocked: boolean;
  postGateKind: string;
  hasInbox: boolean; // task.inbox !== undefined — arbitrates managed Turnstile
  validationFailure: boolean; // looksLikeValidationFailure(afterText)
}

export type FormFillObservation =
  | PrePlanObservation
  | PlanErrorObservation
  | PostPlanObservation
  | PostExecuteObservation
  | PostSubmitObservation;

// ── actions the executor performs (the I/O lives executor-side) ──
export type FormFillAction =
  | { kind: "terminal"; outcome: FormFillOutcome }
  // C1 OAuth-first scan recovery (each carries its budget side-effect in nextState):
  | { kind: "oauth_scan_wait" } // wait for async render; retry++
  | { kind: "oauth_shell_reload" } // reload once to unstick the SPA; reset scan retries
  | { kind: "sign_in_advance" } // click the "Sign In to Continue" gate; reset scan retries
  // C1 verify-email wall → route to the inbox-poll path (executor does the resend):
  | { kind: "route_to_verification" }
  // proceed to the next checkpoint's I/O (no terminal, no replan):
  | { kind: "run_planner" } // C1 fall-through → ask the LLM to plan
  | { kind: "execute_plan" } // C3 → picks verified, run executePlan
  | { kind: "submit" } // C4 post_execute → a fill is present, go to captcha+submit
  // C2 transient upstream blip — brief backoff + re-call the planner, NO hint
  // change and (deliberately) WITHOUT ticking errorReplans (agent.ts:4602–4610).
  | { kind: "blip_retry" }
  // replan with a hint INTENT (executor owns the hint CONTENT — review Q2):
  | { kind: "replan"; hintKind: FormFillHintKind };

// The KIND of replan hint; the executor renders the actual prose (and, for
// submit_disabled, runs the fresh inventory snapshot that lists candidates).
export type FormFillHintKind =
  | "selector_not_in_inventory" // C2 error replan
  | "selectors_did_not_verify" // C3 verifyPlan miss
  | "drop_the_check" // C3 miss "not a checkbox"
  | "page_advanced" // C4 no-fill replan (carries the avoid-selectors list)
  | "submit_disabled" // C4 disabled submit (carries the snapshot candidates)
  | "submit_went_stale" // C4 submit selector vanished (page advanced)
  | "post_submit_validation"; // C4 validation errors after submit

export interface FormFillStep {
  action: FormFillAction;
  nextState: FormFillState;
}

const B = FORM_FILL_BUDGETS;

// Decide the next form-fill step. PURE. Dispatches on the checkpoint and mirrors
// the live loop's branch ORDER exactly (line refs against agent.ts).
export function decideFormFillStep(
  state: FormFillState,
  obs: FormFillObservation,
): FormFillStep {
  const keep = (action: FormFillAction): FormFillStep => ({ action, nextState: state });
  const next = (action: FormFillAction, patch: Partial<FormFillState>): FormFillStep => ({
    action,
    nextState: { ...state, ...patch },
  });
  const terminal = (outcome: FormFillOutcome): FormFillStep => keep({ kind: "terminal", outcome });

  switch (obs.checkpoint) {
    // ── C1 pre_plan (agent.ts:4666–4976) ──────────────────────────────────
    case "pre_plan": {
      // Verify-email WALL: no fillable input + "check your email" copy →
      // inbox-poll path (the executor clicks Resend, then returns submitted).
      // [agent.ts:4717]
      if (obs.verifyWall) return keep({ kind: "route_to_verification" });
      // Email verification-CODE gate (only after the email was submitted). [4757]
      if (state.committedToEmailPath && obs.codeGate) {
        return terminal({ kind: "submitted" });
      }
      // OAuth-first scan — suppressed once committed to the email path. [4778]
      if (obs.oauthCandidatesPresent && !state.committedToEmailPath) {
        if (obs.oauthButtonHit !== null) {
          return terminal({
            kind: "oauth",
            selector: obs.oauthButtonHit.selector,
            provider: obs.oauthButtonHit.provider,
          });
        }
        // no provider button yet — patient async-render retries. [4827]
        const maxScan = obs.oauthScanShell
          ? B.MAX_OAUTH_SCAN_RETRIES_SHELL
          : B.MAX_OAUTH_SCAN_RETRIES_FORM;
        if (state.oauthScanRetries < maxScan) {
          return next({ kind: "oauth_scan_wait" }, { oauthScanRetries: state.oauthScanRetries + 1 });
        }
        // exhausted retries, still a shell → reload once to unstick. [4841]
        if (obs.oauthScanShell && state.oauthShellReloads < B.MAX_OAUTH_SHELL_RELOADS) {
          return next(
            { kind: "oauth_shell_reload" },
            { oauthShellReloads: state.oauthShellReloads + 1, oauthScanRetries: 0 },
          );
        }
        // already-authenticated dashboard (no form) → post-verify nav. [4863]
        if (obs.alreadySignedIn) return terminal({ kind: "already_oauth" });
        // a generic "Sign In to Continue" gate hides the provider buttons. [4879]
        if (state.signInAdvanceClicks < B.MAX_SIGN_IN_ADVANCE_CLICKS && obs.signInAdvancePresent) {
          return next(
            { kind: "sign_in_advance" },
            { signInAdvanceClicks: state.signInAdvanceClicks + 1, oauthScanRetries: 0 },
          );
        }
        // no usable provider affordance — fall through to form-fill. [4903]
      }
      // Anti-bot interstitial that wouldn't clear (tiny inventory). [4932]
      if (obs.antiBotVendor !== null) {
        return terminal({ kind: "anti_bot_blocked", vendor: obs.antiBotVendor });
      }
      // OAuth-only chooser: nothing fillable, no email-signup option. [4945]
      if (obs.oauthOnly) {
        const recoverable =
          obs.oauthOnlyMissingProviders.length > 0 && obs.oauthOnlyHaveSessions.length > 0;
        return terminal(
          recoverable
            ? {
                kind: "needs_oauth_provider_session",
                missingProviders: obs.oauthOnlyMissingProviders,
                haveSessions: obs.oauthOnlyHaveSessions,
              }
            : { kind: "oauth_required" },
        );
      }
      // Nothing short-circuited → ask the planner. [4978]
      return keep({ kind: "run_planner" });
    }

    // ── C2 plan_error (agent.ts:4988–5028) ────────────────────────────────
    case "plan_error": {
      // Transient upstream blip (50x / network): brief backoff + retry, capped,
      // and deliberately NOT charged to errorReplans (it's weather, not logic).
      if (obs.isUpstreamBlip) {
        const nextBlips = state.upstreamBlipRetries + 1;
        if (nextBlips > B.MAX_UPSTREAM_BLIP_RETRIES) {
          return terminal({
            kind: "planning_failed",
            reason: `llm_proxy_unavailable: planner request failed ${nextBlips}x on upstream proxy errors (${obs.reason}) — sustained LLM-proxy/upstream outage, not a page problem`,
          });
        }
        return next({ kind: "blip_retry" }, { upstreamBlipRetries: nextBlips });
      }
      // Invalid planner OUTPUT (parse fail / hallucinated selector): error replan.
      const nextErr = state.errorReplans + 1;
      if (nextErr > B.MAX_ERROR_REPLANS) {
        return terminal({
          kind: "planning_failed",
          reason: `planner output never validated: ${obs.reason}`,
        });
      }
      return next({ kind: "replan", hintKind: "selector_not_in_inventory" }, { errorReplans: nextErr });
    }

    // ── C3 post_plan (agent.ts:5034–5118) — the only PURE checkpoint ───────
    case "post_plan": {
      // A logged-in product/billing page misread as a signup form. [5043]
      if (obs.isDashboard) return terminal({ kind: "already_oauth" });
      // page-fingerprint progress: clear the no-progress memory if the page
      // moved since last round. [5050]
      const moved = pageMovedSince(state.lastRoundPageSig, obs.pageSig);
      const deadSelectors = moved ? new Set<string>() : state.lastNoProgressClickSelectors;
      const memoryPatch: Partial<FormFillState> = {
        lastRoundPageSig: obs.pageSig,
        lastNoProgressClickSelectors: deadSelectors,
      };
      // F14 stuck-detection (uses the just-cleared memory). [5086]
      if (
        isStuckRepeat({
          planClickSelectors: obs.planClickSelectors,
          planEditsAField: obs.planEditsAField,
          noProgressSelectors: deadSelectors,
        })
      ) {
        return next(
          {
            kind: "terminal",
            outcome: {
              kind: "planning_failed",
              reason: `stuck — planner re-picked the same click selector(s) after no-progress: ${obs.planClickSelectors.join(", ")}`,
            },
          },
          memoryPatch,
        );
      }
      // verifyPlan: a planned selector didn't resolve on the live page. [5102]
      if (obs.verifyMiss !== null) {
        const nextErr = state.errorReplans + 1;
        if (nextErr > B.MAX_ERROR_REPLANS) {
          return next(
            {
              kind: "terminal",
              outcome: { kind: "planning_failed", reason: `planned selectors kept missing: ${obs.verifyMiss}` },
            },
            memoryPatch,
          );
        }
        return next(
          { kind: "replan", hintKind: obs.verifyMissNotCheckbox ? "drop_the_check" : "selectors_did_not_verify" },
          { ...memoryPatch, errorReplans: nextErr },
        );
      }
      // picks verify → execute. [5120]
      return next({ kind: "execute_plan" }, memoryPatch);
    }

    // ── C4 post_execute (agent.ts:5122–5206) ──────────────────────────────
    case "post_execute": {
      // commit to the email path the moment an email-affordance was clicked. [5132]
      const commitPatch: Partial<FormFillState> = obs.clickedEmailAffordance
        ? { committedToEmailPath: true }
        : {};
      // a plan with no fill either advanced the page (replan) or is a dead end. [5163]
      if (!obs.hadFill) {
        let emptyPlans = state.emptyPlans;
        if (obs.planActionCount === 0) {
          emptyPlans += 1;
          if (emptyPlans >= B.MAX_EMPTY_PLANS) {
            return next(
              {
                kind: "terminal",
                outcome: {
                  kind: "planning_failed",
                  reason: "no fillable form on the page — the planner found no input fields or actionable elements",
                },
              },
              { ...commitPatch, emptyPlans },
            );
          }
        } else {
          emptyPlans = 0;
        }
        const nextProgress = state.progressReplans + 1;
        if (nextProgress > B.MAX_PROGRESS_REPLANS) {
          return next(
            { kind: "terminal", outcome: { kind: "planning_failed", reason: "never reached a fillable form" } },
            { ...commitPatch, emptyPlans },
          );
        }
        // F14 — record dead click selectors (cleared if a field edit happened). [5190]
        const dead = nextNoProgressSet({
          planClickSelectors: obs.planClickSelectors,
          hadFieldEdit: obs.hadFieldEdit,
        });
        return next(
          { kind: "replan", hintKind: "page_advanced" },
          {
            ...commitPatch,
            emptyPlans,
            progressReplans: nextProgress,
            lastNoProgressClickSelectors: dead,
          },
        );
      }
      // a fill IS present = forward progress → clear the stuck tracker, go submit. [5206]
      return next({ kind: "submit" }, { ...commitPatch, lastNoProgressClickSelectors: new Set() });
    }

    // ── C4 post_submit (agent.ts:5222–5391) ───────────────────────────────
    case "post_submit": {
      // pre-submit captcha gate. [5223]
      if (obs.preGateBlocked) {
        return terminal({ kind: "captcha_blocked", captchaKind: obs.preGateKind });
      }
      // submit click failures. [5229]
      if (obs.submitError !== null) {
        if (obs.submitDisabled) {
          const nextProgress = state.progressReplans + 1;
          if (nextProgress > B.MAX_PROGRESS_REPLANS) {
            return terminal({ kind: "submit_failed", reason: obs.submitError });
          }
          return next({ kind: "replan", hintKind: "submit_disabled" }, { progressReplans: nextProgress });
        }
        if (obs.submitTimeout) {
          const nextProgress = state.progressReplans + 1;
          if (nextProgress > B.MAX_PROGRESS_REPLANS) {
            return terminal({ kind: "submit_failed", reason: obs.submitError });
          }
          return next({ kind: "replan", hintKind: "submit_went_stale" }, { progressReplans: nextProgress });
        }
        return terminal({ kind: "submit_failed", reason: obs.submitError });
      }
      // post-submit captcha gate. [5331]
      if (obs.postGateBlocked) {
        // managed/invisible Turnstile resolves server-side; with an inbox to
        // arbitrate, proceed — a code arriving proves the submit went through.
        if (obs.postGateKind === "turnstile" && obs.hasInbox) {
          return terminal({ kind: "submitted" });
        }
        return terminal({ kind: "captcha_blocked", captchaKind: obs.postGateKind });
      }
      // post-submit validation errors → the page advanced; re-plan. [5373]
      if (obs.validationFailure) {
        const nextProgress = state.progressReplans + 1;
        // out of replan headroom → proceed; extraction is the real arbiter. [5374]
        if (nextProgress > B.MAX_PROGRESS_REPLANS) {
          return terminal({ kind: "submitted" });
        }
        return next({ kind: "replan", hintKind: "post_submit_validation" }, { progressReplans: nextProgress });
      }
      // clean submit. [5391]
      return terminal({ kind: "submitted" });
    }
  }
}
