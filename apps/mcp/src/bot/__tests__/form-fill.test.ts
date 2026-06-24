// Unit tests for the pure form-fill no-progress / stuck-loop primitives
// (strangler slice 3 — DESIGN-form-fill-engine.md). Browser-free. Pins the F14
// behaviors that caused the kinde/Railway false-bails.

import { describe, expect, it } from "vitest";
import {
  computePageSig,
  decideFormFillStep,
  findSignupLinkOnLoginPage,
  FORM_FILL_BUDGETS as B,
  initialFormFillState,
  isStuckRepeat,
  nextNoProgressSet,
  pageMovedSince,
  pickEmailCodeSubmitSelector,
  type FormFillObservation,
  type FormFillState,
} from "../form-fill.js";

describe("computePageSig / pageMovedSince", () => {
  it("fingerprints url + the sorted selector set (selector order doesn't matter)", () => {
    expect(computePageSig("https://x/signup", ["#b", "#a"])).toBe(computePageSig("https://x/signup", ["#a", "#b"]));
  });
  it("a changed URL OR a changed selector set = page moved", () => {
    const a = computePageSig("https://x/signup", ["#a", "#b"]);
    expect(pageMovedSince(a, computePageSig("https://x/step2", ["#a", "#b"]))).toBe(true); // url changed
    expect(pageMovedSince(a, computePageSig("https://x/signup", ["#a", "#b", "#c"]))).toBe(true); // field gained
    expect(pageMovedSince(a, computePageSig("https://x/signup", ["#a", "#b"]))).toBe(false); // identical
  });
  it("no prior sig (first round) is never a move", () => {
    expect(pageMovedSince(null, computePageSig("https://x", ["#a"]))).toBe(false);
  });
});

describe("isStuckRepeat (F14)", () => {
  const dead = new Set(["#next"]);
  it("a click-only plan re-picking ONLY dead selectors is stuck", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: false, noProgressSelectors: dead })).toBe(true);
  });
  it("NOT stuck when the plan adds a new selector (legitimate exploration)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next", "#newlink"], planEditsAField: false, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck when the plan ALSO edits a field (kinde: tick box + re-click Next)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: true, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck on a pure fill plan (no clicks)", () => {
    expect(isStuckRepeat({ planClickSelectors: [], planEditsAField: true, noProgressSelectors: dead })).toBe(false);
  });
  it("NOT stuck with no dead-selector memory yet (first no-progress round)", () => {
    expect(isStuckRepeat({ planClickSelectors: ["#next"], planEditsAField: false, noProgressSelectors: new Set() })).toBe(false);
  });
});

describe("nextNoProgressSet", () => {
  it("records the click selectors after a no-progress round", () => {
    expect([...nextNoProgressSet({ planClickSelectors: ["#a", "#b"], hadFieldEdit: false })].sort()).toEqual(["#a", "#b"]);
  });
  it("a field edit clears the memory (real progress)", () => {
    expect(nextNoProgressSet({ planClickSelectors: ["#a"], hadFieldEdit: true }).size).toBe(0);
  });
});

// ── golden-transition table for decideFormFillStep (the review's T2 parity gate
// before wiring default-off → on). One block per checkpoint; asserts action +
// the counter/memory deltas that, if mis-attributed, silently regress live runs.

// minimal valid observations per checkpoint (overridable per-case)
const PRE: FormFillObservation = {
  checkpoint: "pre_plan",
  hasFillableInput: true,
  verifyWall: false,
  codeGate: false,
  oauthCandidatesPresent: false,
  oauthButtonHit: null,
  oauthScanShell: false,
  alreadySignedIn: false,
  signInAdvancePresent: false,
  signupLinkOnLoginPage: false,
  antiBotVendor: null,
  oauthOnly: false,
  oauthOnlyMissingProviders: [],
  oauthOnlyHaveSessions: [],
};
const POST_PLAN: FormFillObservation = {
  checkpoint: "post_plan",
  isDashboard: false,
  pageSig: "sig-1",
  planClickSelectors: [],
  planEditsAField: false,
  verifyMiss: null,
  verifyMissNotCheckbox: false,
};
const POST_EXEC: FormFillObservation = {
  checkpoint: "post_execute",
  clickedEmailAffordance: false,
  planClickSelectors: [],
  hadFill: true,
  hadFieldEdit: true,
  planActionCount: 2,
};
const POST_SUBMIT: FormFillObservation = {
  checkpoint: "post_submit",
  preGateBlocked: false,
  preGateKind: "",
  submitError: null,
  submitDisabled: false,
  submitTimeout: false,
  postGateBlocked: false,
  postGateKind: "",
  hasInbox: true,
  validationFailure: false,
};
const S = (patch: Partial<FormFillState> = {}): FormFillState => ({ ...initialFormFillState(), ...patch });

describe("decideFormFillStep — C1 pre_plan", () => {
  it("verify-email wall routes to the inbox-poll path", () => {
    expect(decideFormFillStep(S(), { ...PRE, verifyWall: true }).action).toEqual({ kind: "route_to_verification" });
  });
  it("code-gate only fires once committed to the email path → submitted", () => {
    expect(decideFormFillStep(S(), { ...PRE, codeGate: true }).action.kind).toBe("run_planner"); // not committed
    expect(decideFormFillStep(S({ committedToEmailPath: true }), { ...PRE, codeGate: true }).action).toEqual({
      kind: "terminal",
      outcome: { kind: "submitted" },
    });
  });
  it("an OAuth provider button hit takes the OAuth path", () => {
    const step = decideFormFillStep(S(), {
      ...PRE,
      oauthCandidatesPresent: true,
      oauthButtonHit: { selector: "#g", provider: "google" },
    });
    expect(step.action).toEqual({ kind: "terminal", outcome: { kind: "oauth", selector: "#g", provider: "google" } });
  });
  it("committedToEmailPath SUPPRESSES the OAuth-first scan (no reroute)", () => {
    const step = decideFormFillStep(S({ committedToEmailPath: true }), {
      ...PRE,
      oauthCandidatesPresent: true,
      oauthButtonHit: { selector: "#g", provider: "google" },
    });
    expect(step.action.kind).toBe("run_planner"); // scan skipped → falls through to planner
  });
  it("no provider button yet → async-render wait, retry++ (2 for a form, 8 for a shell)", () => {
    const form = decideFormFillStep(S(), { ...PRE, oauthCandidatesPresent: true, oauthScanShell: false });
    expect(form.action).toEqual({ kind: "oauth_scan_wait" });
    expect(form.nextState.oauthScanRetries).toBe(1);
    // a form page exhausts at 2; a shell keeps waiting to 8
    expect(decideFormFillStep(S({ oauthScanRetries: 2 }), { ...PRE, oauthCandidatesPresent: true, oauthScanShell: false }).action.kind).not.toBe("oauth_scan_wait");
    expect(decideFormFillStep(S({ oauthScanRetries: 2 }), { ...PRE, oauthCandidatesPresent: true, oauthScanShell: true }).action).toEqual({ kind: "oauth_scan_wait" });
  });
  it("exhausted scan + still a shell → reload once (resets scan retries)", () => {
    const step = decideFormFillStep(S({ oauthScanRetries: B.MAX_OAUTH_SCAN_RETRIES_SHELL }), {
      ...PRE,
      oauthCandidatesPresent: true,
      oauthScanShell: true,
    });
    expect(step.action).toEqual({ kind: "oauth_shell_reload" });
    expect(step.nextState.oauthShellReloads).toBe(1);
    expect(step.nextState.oauthScanRetries).toBe(0);
  });
  it("exhausted scan + already-signed-in dashboard → already_oauth", () => {
    const step = decideFormFillStep(S({ oauthScanRetries: 2, oauthShellReloads: 1 }), {
      ...PRE,
      oauthCandidatesPresent: true,
      oauthScanShell: false,
      alreadySignedIn: true,
    });
    expect(step.action).toEqual({ kind: "terminal", outcome: { kind: "already_oauth" } });
  });
  it("exhausted scan + a generic sign-in gate → advance (resets scan retries), capped at 2", () => {
    const step = decideFormFillStep(S({ oauthScanRetries: 2 }), {
      ...PRE,
      oauthCandidatesPresent: true,
      signInAdvancePresent: true,
    });
    expect(step.action).toEqual({ kind: "sign_in_advance" });
    expect(step.nextState.signInAdvanceClicks).toBe(1);
    expect(step.nextState.oauthScanRetries).toBe(0);
    // at the cap, no more advance clicks → falls through
    expect(decideFormFillStep(S({ oauthScanRetries: 2, signInAdvanceClicks: B.MAX_SIGN_IN_ADVANCE_CLICKS }), {
      ...PRE, oauthCandidatesPresent: true, signInAdvancePresent: true,
    }).action.kind).toBe("run_planner");
  });
  it("login page with a signup link advances to signup before filling credentials", () => {
    const step = decideFormFillStep(S(), { ...PRE, signupLinkOnLoginPage: true });
    expect(step.action).toEqual({ kind: "signup_link_advance" });
    expect(step.nextState.signupLinkAdvanceClicks).toBe(1);
    expect(step.nextState.committedToEmailPath).toBe(true);
    expect(
      decideFormFillStep(S({ signupLinkAdvanceClicks: B.MAX_SIGNUP_LINK_ADVANCE_CLICKS }), {
        ...PRE,
        signupLinkOnLoginPage: true,
      }).action,
    ).toEqual({ kind: "run_planner" });
  });
  it("anti-bot interstitial → anti_bot_blocked with the vendor", () => {
    expect(decideFormFillStep(S(), { ...PRE, antiBotVendor: "Cloudflare" }).action).toEqual({
      kind: "terminal",
      outcome: { kind: "anti_bot_blocked", vendor: "Cloudflare" },
    });
  });
  it("oauth-only chooser: recoverable (have a session, page wants another) → needs_oauth_provider_session", () => {
    const step = decideFormFillStep(S(), {
      ...PRE, hasFillableInput: false, oauthOnly: true,
      oauthOnlyMissingProviders: ["github"], oauthOnlyHaveSessions: ["google"],
    });
    expect(step.action).toEqual({
      kind: "terminal",
      outcome: { kind: "needs_oauth_provider_session", missingProviders: ["github"], haveSessions: ["google"] },
    });
  });
  it("oauth-only chooser: not recoverable (no sessions at all) → oauth_required", () => {
    expect(decideFormFillStep(S(), { ...PRE, hasFillableInput: false, oauthOnly: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "oauth_required" },
    });
  });
  it("nothing short-circuits → run the planner", () => {
    expect(decideFormFillStep(S(), PRE).action).toEqual({ kind: "run_planner" });
  });
});

describe("form-fill selector helpers", () => {
  it("detects the signup link on a login page without picking the sign-in submit", () => {
    const hit = findSignupLinkOnLoginPage({
      url: "https://cloud.langfuse.com/",
      title: "Sign in | Langfuse",
      htmlOrText: "Sign in to your account. No account yet? Sign up",
      inventory: [
        { tag: "button", selector: "#signin", visibleText: "Sign in", visible: true },
        { tag: "a", selector: "#signup", visibleText: "Sign up", href: "/auth/sign-up", visible: true },
      ],
    });
    expect(hit?.selector).toBe("#signup");
  });

  it("detects a 'Create one' login→signup toggle (deepinfra) over noise", () => {
    const hit = findSignupLinkOnLoginPage({
      url: "https://deepinfra.com/login",
      title: "Log In - DeepInfra",
      htmlOrText: "Log in to your account. Don't have an account? Create one",
      inventory: [
        { tag: "button", selector: "#login", visibleText: "Log in", visible: true },
        { tag: "a", selector: "#announce", visibleText: "read the announcement", href: "/blog", visible: true },
        { tag: "a", selector: "#createone", visibleText: "Create one", visible: true, inViewport: true },
        { tag: "a", selector: "#gh", visibleText: "Continue with Github", href: "/oauth/github", visible: true },
      ],
    });
    expect(hit?.selector).toBe("#createone");
  });

  it("prefers Send Code over a marketing Sign up now anchor on email-code pages", () => {
    expect(
      pickEmailCodeSubmitSelector({
        htmlOrText: "Enter your email, and we'll send you a verification code.",
        currentSubmitSelector: "#marketing",
        inventory: [
          { tag: "a", selector: "#marketing", visibleText: "Sign up now", href: "/dash", visible: true },
          { tag: "button", selector: "#send", visibleText: "Send Code", visible: true, inViewport: true },
        ],
      }),
    ).toBe("#send");
  });
});

describe("decideFormFillStep — C2 plan_error (the upstream-blip vs error-replan taxonomy)", () => {
  const ERR = (patch: Partial<Extract<FormFillObservation, { checkpoint: "plan_error" }>> = {}): FormFillObservation => ({
    checkpoint: "plan_error", isUpstreamBlip: false, reason: "bad selector", ...patch,
  });
  it("a transient blip backs off + retries WITHOUT ticking errorReplans", () => {
    const step = decideFormFillStep(S({ errorReplans: 1 }), ERR({ isUpstreamBlip: true }));
    expect(step.action).toEqual({ kind: "blip_retry" });
    expect(step.nextState.upstreamBlipRetries).toBe(1);
    expect(step.nextState.errorReplans).toBe(1); // untouched — a blip is weather, not logic
  });
  it("a SUSTAINED blip (over cap) → planning_failed (llm_proxy_unavailable)", () => {
    const step = decideFormFillStep(S({ upstreamBlipRetries: B.MAX_UPSTREAM_BLIP_RETRIES }), ERR({ isUpstreamBlip: true }));
    expect(step.action.kind).toBe("terminal");
    expect((step.action as { outcome: { kind: string; reason: string } }).outcome.reason).toContain("llm_proxy_unavailable");
  });
  it("an invalid-output error replans + ticks errorReplans; over cap → planning_failed", () => {
    const under = decideFormFillStep(S(), ERR());
    expect(under.action).toEqual({ kind: "replan", hintKind: "selector_not_in_inventory" });
    expect(under.nextState.errorReplans).toBe(1);
    expect(decideFormFillStep(S({ errorReplans: B.MAX_ERROR_REPLANS }), ERR()).action.kind).toBe("terminal");
  });
});

describe("decideFormFillStep — C3 post_plan", () => {
  it("a dashboard misread as a form → already_oauth", () => {
    expect(decideFormFillStep(S(), { ...POST_PLAN, isDashboard: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "already_oauth" },
    });
  });
  it("a moved page clears the no-progress memory (kinde domain-retry)", () => {
    const step = decideFormFillStep(
      S({ lastRoundPageSig: "old-sig", lastNoProgressClickSelectors: new Set(["#next"]) }),
      { ...POST_PLAN, pageSig: "new-sig", planClickSelectors: ["#next"], planEditsAField: false },
    );
    // re-clicking #next is NOT stuck because the page moved → memory cleared → execute
    expect(step.action).toEqual({ kind: "execute_plan" });
    expect(step.nextState.lastNoProgressClickSelectors.size).toBe(0);
    expect(step.nextState.lastRoundPageSig).toBe("new-sig");
  });
  it("re-picking only dead selectors on an UNMOVED page → planning_failed (stuck)", () => {
    const step = decideFormFillStep(
      S({ lastRoundPageSig: "sig-1", lastNoProgressClickSelectors: new Set(["#next"]) }),
      { ...POST_PLAN, pageSig: "sig-1", planClickSelectors: ["#next"], planEditsAField: false },
    );
    expect(step.action.kind).toBe("terminal");
    expect((step.action as { outcome: { kind: string } }).outcome.kind).toBe("planning_failed");
  });
  it("verifyPlan miss replans (selectors_did_not_verify); a not-a-checkbox miss says drop the check", () => {
    expect(decideFormFillStep(S(), { ...POST_PLAN, verifyMiss: "#x" }).action).toEqual({
      kind: "replan", hintKind: "selectors_did_not_verify",
    });
    expect(decideFormFillStep(S(), { ...POST_PLAN, verifyMiss: "#x not a checkbox", verifyMissNotCheckbox: true }).action).toEqual({
      kind: "replan", hintKind: "drop_the_check",
    });
    expect(decideFormFillStep(S({ errorReplans: B.MAX_ERROR_REPLANS }), { ...POST_PLAN, verifyMiss: "#x" }).action.kind).toBe("terminal");
  });
  it("a verified plan → execute_plan", () => {
    expect(decideFormFillStep(S(), POST_PLAN).action).toEqual({ kind: "execute_plan" });
  });
});

describe("decideFormFillStep — C4 post_execute", () => {
  it("clicking an email affordance sets the one-way committedToEmailPath flag", () => {
    const step = decideFormFillStep(S(), { ...POST_EXEC, clickedEmailAffordance: true });
    expect(step.nextState.committedToEmailPath).toBe(true);
  });
  it("a fill present clears the stuck tracker and goes to submit", () => {
    const step = decideFormFillStep(S({ lastNoProgressClickSelectors: new Set(["#a"]) }), POST_EXEC);
    expect(step.action).toEqual({ kind: "submit" });
    expect(step.nextState.lastNoProgressClickSelectors.size).toBe(0);
  });
  it("a check-only field edit clears the stuck tracker and goes to submit", () => {
    const step = decideFormFillStep(S({ lastNoProgressClickSelectors: new Set(["#a"]) }), {
      ...POST_EXEC,
      hadFill: false,
      hadFieldEdit: true,
      planActionCount: 1,
    });
    expect(step.action).toEqual({ kind: "submit" });
    expect(step.nextState.lastNoProgressClickSelectors.size).toBe(0);
  });
  it("a no-fill plan that revealed the page replans (progress debt) + records dead selectors", () => {
    const step = decideFormFillStep(S(), {
      ...POST_EXEC, hadFill: false, hadFieldEdit: false, planActionCount: 1, planClickSelectors: ["#reveal"],
    });
    expect(step.action).toEqual({ kind: "replan", hintKind: "page_advanced" });
    expect(step.nextState.progressReplans).toBe(1);
    expect([...step.nextState.lastNoProgressClickSelectors]).toEqual(["#reveal"]);
  });
  it("two CONSECUTIVE empty plans → planning_failed; a non-empty plan resets the counter", () => {
    const first = decideFormFillStep(S(), { ...POST_EXEC, hadFill: false, hadFieldEdit: false, planActionCount: 0 });
    expect(first.action.kind).toBe("replan");
    expect(first.nextState.emptyPlans).toBe(1);
    const second = decideFormFillStep(S({ emptyPlans: 1 }), { ...POST_EXEC, hadFill: false, hadFieldEdit: false, planActionCount: 0 });
    expect(second.action.kind).toBe("terminal");
    // a non-empty no-fill plan resets emptyPlans to 0
    expect(decideFormFillStep(S({ emptyPlans: 1 }), { ...POST_EXEC, hadFill: false, hadFieldEdit: false, planActionCount: 1 }).nextState.emptyPlans).toBe(0);
  });
  it("progress replans exhausted → planning_failed (never reached a fillable form)", () => {
    const step = decideFormFillStep(S({ progressReplans: B.MAX_PROGRESS_REPLANS }), {
      ...POST_EXEC, hadFill: false, hadFieldEdit: false, planActionCount: 1,
    });
    expect(step.action.kind).toBe("terminal");
    expect((step.action as { outcome: { reason: string } }).outcome.reason).toContain("never reached a fillable form");
  });
});

describe("decideFormFillStep — C4 post_submit", () => {
  it("a pre-submit captcha gate → captcha_blocked", () => {
    expect(decideFormFillStep(S(), { ...POST_SUBMIT, preGateBlocked: true, preGateKind: "recaptcha" }).action).toEqual({
      kind: "terminal", outcome: { kind: "captcha_blocked", captchaKind: "recaptcha" },
    });
  });
  it("submit_disabled is PROGRESS debt: replans under cap, submit_failed over cap", () => {
    const under = decideFormFillStep(S(), { ...POST_SUBMIT, submitError: "submit_disabled: x", submitDisabled: true });
    expect(under.action).toEqual({ kind: "replan", hintKind: "submit_disabled" });
    expect(under.nextState.progressReplans).toBe(1);
    expect(decideFormFillStep(S({ progressReplans: B.MAX_PROGRESS_REPLANS }), { ...POST_SUBMIT, submitError: "submit_disabled: x", submitDisabled: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "submit_failed", reason: "submit_disabled: x" },
    });
  });
  it("a stale submit selector (timeout) replans as progress debt", () => {
    const step = decideFormFillStep(S(), { ...POST_SUBMIT, submitError: "timeout", submitTimeout: true });
    expect(step.action).toEqual({ kind: "replan", hintKind: "submit_went_stale" });
    expect(step.nextState.progressReplans).toBe(1);
  });
  it("any other submit error → submit_failed", () => {
    expect(decideFormFillStep(S(), { ...POST_SUBMIT, submitError: "navigation crashed" }).action).toEqual({
      kind: "terminal", outcome: { kind: "submit_failed", reason: "navigation crashed" },
    });
  });
  it("post-submit managed Turnstile WITH an inbox flips to submitted (inbox arbitrates)", () => {
    expect(decideFormFillStep(S(), { ...POST_SUBMIT, postGateBlocked: true, postGateKind: "turnstile", hasInbox: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "submitted" },
    });
  });
  it("post-submit Turnstile with NO inbox, or any other challenge → captcha_blocked", () => {
    expect(decideFormFillStep(S(), { ...POST_SUBMIT, postGateBlocked: true, postGateKind: "turnstile", hasInbox: false }).action).toEqual({
      kind: "terminal", outcome: { kind: "captcha_blocked", captchaKind: "turnstile" },
    });
    expect(decideFormFillStep(S(), { ...POST_SUBMIT, postGateBlocked: true, postGateKind: "recaptcha", hasInbox: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "captcha_blocked", captchaKind: "recaptcha" },
    });
  });
  it("post-submit validation replans under cap, but PROCEEDS (submitted) once progress budget is spent", () => {
    const under = decideFormFillStep(S(), { ...POST_SUBMIT, validationFailure: true });
    expect(under.action).toEqual({ kind: "replan", hintKind: "post_submit_validation" });
    expect(decideFormFillStep(S({ progressReplans: B.MAX_PROGRESS_REPLANS }), { ...POST_SUBMIT, validationFailure: true }).action).toEqual({
      kind: "terminal", outcome: { kind: "submitted" },
    });
  });
  it("a clean submit → submitted", () => {
    expect(decideFormFillStep(S(), POST_SUBMIT).action).toEqual({ kind: "terminal", outcome: { kind: "submitted" } });
  });
});
