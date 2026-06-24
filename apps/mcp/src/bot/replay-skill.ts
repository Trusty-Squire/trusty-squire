// replay-skill.ts — Stage 4 of the Skill Promoter pipeline: take a
// stored Skill and walk it against a live browser, producing either a
// credential (full mode) or a step-by-step validation pass (dry mode).
//
// See docs/DESIGN-skill-promoter.md §"The router (Tier 2 dispatch)"
// for context. This module is what makes a published Skill *useful*:
// the synthesizer (promote-to-skill.ts) produces the graph; this
// module executes it.
//
// Three load-bearing properties:
//
//   1. **Text-match resolution at runtime, not capture time.** Each
//      step's text_match / label_hint / near_text_hint is resolved
//      against the page's CURRENT inventory, not the captured one.
//      That's the whole point of skill-based replay: when Railway
//      ships a Tailwind redesign and selectors break, the visible
//      vocabulary stays roughly the same and the skill survives.
//
//   2. **Per-step LLM fallback.** When a step's pre-validation fails
//      (text resolves to 0 or >1 elements, expected URL doesn't load,
//      etc.), the replay engine asks the planner ONCE for a substitute
//      for that step, executes the substitute, and writes a
//      skill-update-candidate to disk so the next promoter run picks
//      up the new shape (T11 / D6).
//
//   3. **Dry mode stops before the credential-creating click.** The
//      universal bot's `provision` is a one-shot operation
//      on most services (Railway, Sentry, OpenRouter) — running it
//      twice burns an alias. Dry mode is the default for replay-test
//      and for the router's pre-flight validation; full mode is
//      opt-in for Stripe-class services where re-extraction is
//      possible (Decision 3, T13).
//
// What this module does NOT do:
//
//   - It doesn't *publish* skill-update-candidates (Phase 7 CLI does).
//   - It doesn't drive the OAuth handshake (the bot's existing
//     runOAuthFlow does; we just signal `needs_login` when the
//     `click_oauth_button` step's provider has no profile session).
//   - It doesn't write replay outcomes back to the registry (the
//     router does, after consuming the result).
//   - It doesn't sandbox the browser (T14 lives at the caller layer —
//     the router decides whether to spawn a fresh BrowserController
//     or reuse one).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Skill,
  SkillStep,
  SkillCredentialSpec,
} from "@trusty-squire/skill-schema";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { loggedInProviders } from "./login-state.js";
import {
  isTruncatedCapture,
  extractApiKeyFromText,
  findOAuthButton,
  isCredentialNoiseCandidate,
  detectAlreadySignedIn,
} from "./agent.js";
import { type OAuthProviderId, OAUTH_PROVIDERS, extractOAuthScopes } from "./oauth-providers.js";
import { scrapeGoogleScopePhrases } from "./google-login.js";
import type { Page } from "playwright";
import {
  filterByNearTextHint,
  nearTextHintMatches,
} from "./near-text-hint.js";

// ── Public API ───────────────────────────────────────────────────────

export interface ReplayInput {
  /** The Skill record to replay. Already-verified signed manifest. */
  skill: Skill;
  /** Live browser the replay drives. Must be started + ready. */
  browser: BrowserController;
  /**
   * Replay mode. `dry` walks every step except the credential-creating
   * click (the last click before extract); `full` executes the entire
   * graph. Default: `dry`.
   */
  mode?: "dry" | "full";
  /**
   * Per-step planner fallback. Called when a step's pre-validation
   * fails. Receives the captured step + the current inventory + a
   * reason. Should return either a substitute step the replay engine
   * can execute, or null to signal "give up". The caller (router)
   * usually wires this to the bot's existing planSignupForm / similar.
   */
  llmFallback?: (input: LLMFallbackInput) => Promise<SkillStep | null>;
  /**
   * Where to write skill-update-candidates. When provided AND the
   * llmFallback produces a different step than the captured one, the
   * substitute is appended to `<dir>/<service>-<skill_id>-candidates.jsonl`.
   * When absent (default), no write occurs — useful for the router
   * which doesn't always want to accumulate candidates.
   */
  candidatesDir?: string;
  /**
   * Runtime values for `${TEMPLATE}` substitution in fill steps. Keys
   * are uppercase (TOKEN_NAME, USER_DISPLAY_NAME, EMAIL_ALIAS,
   * PROJECT_NAME). Missing keys fall back to the literal template
   * string — the replay engine doesn't reject, but the resulting fill
   * is probably wrong.
   */
  templateValues?: Record<string, string>;
  /**
   * Override the global `fetch` used for the sentinel HTTP check
   * (C5). Production leaves this undefined (uses globalThis.fetch).
   * Tests inject a mock to avoid real network. Skills without a
   * sentinel_http_check configured never invoke this.
   */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Fetches the email verification code for an `await_email_code` step.
   * The replay engine has no inbox transport of its own (same separation
   * as `llmFallback` / `templateValues`): the caller — verify mode or the
   * live-provision router — wires this to an InboxClient poll + code
   * extraction against the run's alias (`templateValues.EMAIL_ALIAS`).
   * Resolves to the code, or null when no verification email arrived in
   * time. A skill containing an `await_email_code` step that is replayed
   * WITHOUT this callback fails that step cleanly (the caller forgot to
   * provide inbox access).
   */
  fetchEmailCode?: (input: { alias: string }) => Promise<string | null>;
  /**
   * Drives an interactive provider sign-in when the OAuth walk lands on a
   * login/identifier page instead of a chooser/consent. Replay otherwise bails
   * `needs_login` here — but the full discover bot would just type the
   * password, and a freshly-created robot account lands on the identifier page
   * the first time a given relying party requests OAuth even with a live
   * session. The verifier wires this to the robot's credentials
   * (verify-passwords.json) + `browser.loginGoogleInline`; the live-user
   * router omits it (no stored end-user password to drive). Resolves true when
   * the sign-in progressed (walk continues), false to fall through to the
   * existing needs_login bail. Same caller-injected-transport separation as
   * `fetchEmailCode`.
   */
  driveOAuthLogin?: (provider: OAuthProviderId) => Promise<boolean>;
  /**
   * Chrome profile whose OAuth-session marker should be trusted for
   * replay-time provider checks. Fresh-identity verifier replays pass the
   * robot profile; normal router replays omit this and use the default profile.
   */
  profileDir?: string;
  /**
   * Preferred provider for replay-time OAuth recovery when a navigate step
   * drifts to a login page and the stored skill has no explicit
   * click_oauth_button step. Captured click_oauth_button steps remain
   * authoritative; this only orders recovery candidates for legacy/post-auth
   * skills whose provider metadata was inferred outside the step graph.
   */
  preferredOAuthProvider?: OAuthProviderId;
  /**
   * 0.8.2-rc.19 — bypass the "skill must be active" guard. The verifier
   * loop NEEDS to replay pending-review skills (and sometimes demoted
   * ones) to gather the outcome data that drives promote/demote
   * transitions; without this flag, the loop is dead-on-arrival.
   *
   * `superseded` is still rejected even with bypass — that status
   * means a newer version is the canonical one; replaying the older
   * one is wasted effort.
   *
   * Default: false. Router (live-user provision) MUST leave it false.
   */
  bypassStatusGuard?: boolean;
}

export interface LLMFallbackInput {
  /** The Skill step whose pre-validation failed. */
  capturedStep: SkillStep;
  /** Why pre-validation failed (human-readable). */
  reason: string;
  /** The page's current inventory. */
  inventory: readonly InteractiveElement[];
  /** Step index within the skill's `steps` array. */
  stepIndex: number;
  /** The full skill for context (provider may want service name). */
  skill: Skill;
}

export type ReplayOutcome =
  | { kind: "ok"; credential: string; via: "copy_button" | "regex" | "dry_skipped" }
  // Multi-credential success — Phase D per docs/DESIGN-multi-credential.md.
  // A separate variant rather than expanding `ok`'s shape so the
  // compiler forces every caller to decide what to do with both
  // (vault write paths differ, router messaging differs). `credentials`
  // is keyed by extract step's `produces` value.
  | {
      kind: "ok_multi";
      credentials: Record<string, string>;
      via: Record<string, "copy_button" | "regex" | "labeled">;
    }
  | { kind: "step_failed"; stepIndex: number; reason: string; capturedStep: SkillStep }
  | { kind: "validator_failed"; stepIndex: number; got: string; reason: string }
  | { kind: "extraction_failed"; stepIndex: number; reason: string }
  | { kind: "needs_login"; provider: "google" | "github"; stepIndex: number }
  | { kind: "skill_demoted"; reason: string }
  | { kind: "dry_pass"; stepsWalked: number };

// Credential-reveal poll window (ms). 8s in production — a service's
// post-Create modal can take several seconds to render the key. Read from env
// per call so tests can set it tiny (the fake browser's wait() returns
// instantly, so the loop otherwise busy-spins the full 8s of wall-clock,
// dozens of times across replay-skill.test.ts → ~82s, which trips vitest's
// worker heartbeat under CI parallelism and fails the release verify job).
export function revealPollMs(): number {
  const v = Number.parseInt(process.env.UNIVERSAL_BOT_REVEAL_POLL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 8000;
}

// ── Entry point ──────────────────────────────────────────────────────

export async function replaySkill(input: ReplayInput): Promise<ReplayOutcome> {
  const { skill, browser } = input;
  const mode = input.mode ?? "dry";
  const candidatesDir = input.candidatesDir;
  const llmFallback = input.llmFallback;
  const templateValues = input.templateValues ?? {};

  // Router-level guard: a demoted, pending-review, or superseded
  // skill is not replay-eligible for end-user provisions. The router
  // should have filtered these out, but we double-check at the
  // boundary in case something hand-feeds us a skill record from a
  // stale cache.
  //
  // The verifier loop bypasses this guard via bypassStatusGuard=true
  // (set by the housekeeper verify mode on the verifier queue) so it can gather
  // replay outcomes that drive promote/demote transitions. Even with
  // bypass, `superseded` stays gated — a newer version is canonical
  // and replaying the older one is wasted effort.
  const bypass = input.bypassStatusGuard === true;
  const guardBlocks =
    skill.status === "superseded" || (!bypass && skill.status !== "active");
  if (guardBlocks) {
    return {
      kind: "skill_demoted",
      reason: bypass
        ? `Skill status is ${skill.status}; verifier replay still rejects superseded versions.`
        : `Skill status is ${skill.status}; replay is only valid for status=active.`,
    };
  }

  // Walk the step graph. Dry mode stops before the last action that
  // would create the credential — that's typically the step
  // immediately before the first extract_* step. Compute the cutoff
  // up front so the loop's stopping condition stays local.
  const dryStopAt = mode === "dry" ? computeDryStopIndex(skill.steps) : skill.steps.length;

  // Multi-credential bundle (Phase D per docs/DESIGN-multi-credential.md).
  // When the skill has named extract steps, we accumulate values into
  // this map keyed by `produces`. The outer loop returns `ok_multi`
  // once every named extract has run successfully — not on the first
  // extract like the single-cred path. Detected by skill content:
  // any *_named step → multi mode, else → single.
  // extract_labeled is ALSO a multi-cred extract (pusher: application_id /
  // app_key / secret) — it returns extract_named_ok and accumulates into the
  // bundle just like the *_named kinds. Omitting it here left isMultiCred false,
  // so a pusher skill accumulated all 3 values but never returned ok_multi and
  // fell through to "walked entire graph without producing a credential."
  const isMultiCred = skill.steps.some(
    (s) =>
      s.kind === "extract_via_copy_button_named" ||
      s.kind === "extract_via_regex_named" ||
      s.kind === "extract_labeled",
  );
  const expectedProduces = new Set<string>(
    skill.steps
      .filter(
        (s): s is Extract<SkillStep, { produces: string }> =>
          s.kind === "extract_via_copy_button_named" ||
          s.kind === "extract_via_regex_named" ||
          s.kind === "extract_labeled",
      )
      .map((s) => s.produces),
  );
  const credentialBundle: Record<string, string> = {};
  const viaBundle: Record<string, "copy_button" | "regex" | "labeled"> = {};

  let stepsWalked = 0;
  // Set once we skip an absent onboarding fill (see isSkippableAbsentFill):
  // the operator account is already registered, so the fresh-signup flow is
  // gone. Any DOWNSTREAM credential-step failure is then ambiguous — genuine
  // rot, or just returning-user divergence we can't reproduce. We tag such
  // step_failed reasons with RETURNING_USER_MARKER so the verifier downgrades
  // them off the rot/demote path (failure-taxonomy isReturningUserDivergence).
  let skippedOnboardingFill = false;
  // Set once we successfully complete an OAuth click — from that point the
  // replay is in an AUTHENTICATED returning-user session, so a later
  // "element absent" failure (e.g. brevo's "SMTP & API" nav link that the
  // returning-user dashboard renders differently) is far more likely UI
  // divergence than genuine rot. We tag such failures with the returning-user
  // marker too, so the verifier doesn't DEMOTE an active skill over it (which
  // was eroding OF#1 — measured: brevo demoted on a returning-user nav click).
  let authedViaOAuth = false;
  // Form-readiness parity with the live bot. Until the FIRST form control
  // fills/selects successfully, an "input absent" on a fill/select is far
  // more likely the SPA signup form still hydrating than a genuinely-absent
  // (already-registered) onboarding field — so we wait + reload + re-validate
  // before treating it as skippable. Once a form control succeeds the form is
  // present, and from then on absent fields keep the account-state skip.
  let reachedForm = false;
  // Post-click settle parity with the live bot. A click can kick off server
  // work BEFORE the SPA navigates (zilliz's onboarding Continue provisions a
  // default org/project/cluster, then routes to the dashboard — several
  // seconds). The live bot's LLM round-trip gave that window for free; the
  // replay engine reads the next inventory ~2s after the click, sees the OLD
  // page, and wrongly skips/fails subsequent steps as "absent". When a step
  // doesn't resolve and the most recent EXECUTED step was a click/navigate,
  // poll re-validation before the skip/fail cascade decides. Iteration-
  // bounded (not wall-clock) so stubbed tests don't spin.
  let lastExecutedWasClick = false;
  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i]!;

    // Dry-mode short circuit: walk every step before the credential-
    // creating click, then bail with dry_pass. Extract steps still
    // get pre-validated (to confirm the Copy button / regex target
    // would be visible) but not executed.
    if (mode === "dry" && i >= dryStopAt) {
      // Pre-validate the extract step so dry-mode catches the
      // Railway-class "Copy button isn't visible at all" bug.
      const validation = await preValidateStep(step, browser, templateValues);
      if (!validation.ok) {
        // Try LLM fallback for the extract step too.
        const fallbackResult = await tryFallback(
          step,
          validation.reason,
          browser,
          i,
          skill,
          llmFallback,
          candidatesDir,
          input.profileDir,
        );
        if (fallbackResult.kind === "use_substitute") {
          // We have a substitute, but in dry mode we still don't
          // execute it. Validating its presence was enough.
        } else {
          return {
            kind: "step_failed",
            stepIndex: i,
            reason: validation.reason,
            capturedStep: step,
          };
        }
      }
      stepsWalked += 1;
      // Multi-credential safety: validate any LATER extract steps
      // (Stripe-class 0.8.0) so a broken Copy-button hint on
      // credential 2+ surfaces in dry mode rather than full.
      const laterFailure = await preValidateAllExtractsInDryMode(
        skill.steps,
        i,
        browser,
        templateValues,
      );
      if (laterFailure !== null) {
        return {
          kind: "step_failed",
          stepIndex: laterFailure.stepIndex,
          reason: `multi-credential dry-mode: ${laterFailure.reason}`,
          capturedStep: skill.steps[laterFailure.stepIndex]!,
        };
      }
      return { kind: "dry_pass", stepsWalked };
    }

    if (
      isReturningUserOnboardingDismissClick(step, i, skill.steps) &&
      (await looksAuthenticatedReturningUser(browser))
    ) {
      const textMatch = step.kind === "click" ? step.text_match : "";
      console.error(
        `[replay] step ${i} (click text_match=${JSON.stringify(textMatch)}) ` +
          `is a first-run onboarding dismissal and the page is already an ` +
          `authenticated returning-user session — skipping.`,
      );
      continue;
    }

    // Pre-validate: would this step resolve cleanly against the
    // current page? If not, hand to the LLM fallback.
    let validation = await preValidateStep(step, browser, templateValues);
    // Form-readiness parity: a fill/select that doesn't resolve BEFORE we've
    // reached the form is usually the SPA still hydrating (zilliz /signup
    // renders marketing chrome then the form). Wait for hydration + reload
    // once + re-validate — mirroring the live bot's waitForFormReady +
    // reload-on-shell loop — before the skip/fail cascade decides it's a
    // genuinely-absent (already-registered) field. A fresh signup's form
    // appears; an already-registered one never does and the skip still fires.
    if (
      !validation.ok &&
      !reachedForm &&
      (step.kind === "fill" || step.kind === "select")
    ) {
      validation = await waitForFormThenRevalidate(step, browser, templateValues);
    }
    if (!validation.ok && lastExecutedWasClick) {
      for (let poll = 0; poll < 6 && !validation.ok; poll++) {
        await browser.wait(2);
        validation = await preValidateStep(step, browser, templateValues);
      }
      // One settle window per click. If the page didn't produce this step's
      // target within it, later steps shouldn't each re-pay the wait — a
      // genuinely-diverged page (returning-user skips) would otherwise
      // crawl through every remaining step at +12s apiece.
      if (!validation.ok) lastExecutedWasClick = false;
    }
    if (
      !validation.ok &&
      step.kind === "click" &&
      (await attemptAccountOnboardingGate(browser, templateValues))
    ) {
      validation = await preValidateStep(step, browser, templateValues);
    }
    if (
      !validation.ok &&
      step.kind === "click" &&
      (await attemptOptionalOnboardingSurveyGate(browser))
    ) {
      validation = await preValidateStep(step, browser, templateValues);
    }
    if (
      !validation.ok &&
      step.kind === "click" &&
      (await attemptOptionalBillingGate(browser))
    ) {
      validation = await preValidateStep(step, browser, templateValues);
    }
    if (
      !validation.ok &&
      step.kind === "click" &&
      (await attemptSimpleProjectOnboarding(browser, templateValues))
    ) {
      validation = await preValidateStep(step, browser, templateValues);
    }
    if (!validation.ok) {
      const recovered = await attemptOAuthRecoveryForFailedStep(
        browser,
        resolveReplayRecoveryEntryUrl(skill),
        input.profileDir,
        input.preferredOAuthProvider,
      );
      if (recovered.kind === "ok") {
        validation = await preValidateStep(step, browser, templateValues);
      } else if (recovered.kind === "needs_login") {
        return { kind: "needs_login", provider: recovered.provider, stepIndex: i };
      }
    }
    let stepToExecute = step;
    if (!validation.ok) {
      if (
        step.kind === "click" &&
        isSkippableAbsentClick(
          step,
          i,
          await countClickMatches(step, browser),
          skill.steps,
        ) &&
        (llmFallback === undefined || (await looksAuthenticatedReturningUser(browser)))
      ) {
        // Account-state-dependent setup click (hookdeck "Create
        // Project" / Kinde first-run wizard class): the target only
        // existed in the original signup state. If it is wholly absent
        // and a later credential step exists, skip BEFORE invoking the
        // fallback planner; otherwise returning-user verify can burn the
        // entire timeout inventing a replacement for a step that should
        // not run.
        console.error(
          `[replay] step ${i} (click text_match=${JSON.stringify(step.text_match)}) ` +
            `target absent from page; skipping as optional setup step. ` +
            `Reason: ${validation.reason}`,
        );
        continue;
      }
      const fallbackResult = await tryFallback(
        step,
        validation.reason,
        browser,
        i,
        skill,
        llmFallback,
        candidatesDir,
        input.profileDir,
      );
      if (fallbackResult.kind === "use_substitute") {
        stepToExecute = fallbackResult.substitute;
      } else if (fallbackResult.kind === "needs_login") {
        return { kind: "needs_login", provider: fallbackResult.provider, stepIndex: i };
      } else if (
        step.kind === "fill" &&
        isSkippableAbsentFill(step, validation.reason, i, skill.steps)
      ) {
        // Account-state-dependent ONBOARDING fill (cohere/deepinfra "First
        // name" class): the signup form only exists for a brand-new account.
        // The verifier's operator account is already registered, so the
        // form is skipped by the service and the input is wholly absent.
        // That's not rot — a later extract step still reaches the
        // credential, and the credential validator is the real backstop.
        // Skip the absent onboarding field rather than false-failing.
        console.error(
          `[replay] step ${i} (fill label_hint=${JSON.stringify(step.label_hint)}) ` +
            `input absent — skipping as account-state-dependent onboarding ` +
            `(account already registered; signup form gone). A later extract ` +
            `step still reaches the credential. Reason: ${validation.reason}`,
        );
        skippedOnboardingFill = true;
        continue;
      } else if (
        step.kind === "select" &&
        isSkippableAbsentSelect(step, validation.reason, i, skill.steps)
      ) {
        // Account-state-dependent ONBOARDING select (porter "Role" /
        // railway "Workspace" class): the wizard dropdown only exists for a
        // brand-new account. The verifier's operator account is already
        // registered, so the service skips the onboarding form and the
        // <select> is wholly absent — exactly the fill case above, just a
        // different control. A later extract step still reaches the
        // credential and the credential validator is the backstop, so skip
        // rather than false-failing the whole replay.
        console.error(
          `[replay] step ${i} (select label_hint=${JSON.stringify(step.label_hint)}) ` +
            `select absent — skipping as account-state-dependent onboarding ` +
            `(account already registered; signup form gone). A later extract ` +
            `step still reaches the credential. Reason: ${validation.reason}`,
        );
        skippedOnboardingFill = true;
        continue;
      } else if (
        step.kind === "click_oauth_button" &&
        (await looksAuthenticatedReturningUser(browser))
      ) {
        // Returning-user login-head skip (THE dominant verify failure — measured
        // 2026-06-12: 12/29 fails were "No element matches … for google OAuth
        // button"). The skill was recorded on a FRESH signup, so its head is
        // "click Continue with Google → consent → onboarding". The verifier's
        // operator account already exists, so navigating signup_url lands an
        // AUTHENTICATED dashboard — the provider button is simply gone. That's
        // not rot. detectAlreadySignedIn returns false if a real login chooser
        // (any "Continue with Google" affordance) is present, so a genuinely
        // rotted button still fails below; it returns true only on an actual
        // authenticated app shell. Skip the head and resume at the post-auth
        // credential-fetch tail, in returning-user mode.
        console.error(
          `[replay] step ${i} (click_oauth_button ${step.provider}) target absent, but the page ` +
            `is an authenticated returning-user session (account already exists) — skipping the ` +
            `login head and resuming at the post-auth credential tail.`,
        );
        authedViaOAuth = true;
        continue;
      } else {
        await maybeDumpReplayDebug(browser, skill, i, validation.reason);
        return {
          kind: "step_failed",
          stepIndex: i,
          reason: markReturningUser(validation.reason, skippedOnboardingFill || authedViaOAuth),
          capturedStep: step,
        };
      }
    }

    // Execute. If execution itself throws (a transient browser fault),
    // surface it as a step failure with the underlying message —
    // the router can decide whether to retry or fall through to the
    // universal bot.
    try {
      const execOutcome = await executeStep(
        stepToExecute,
        browser,
        templateValues,
        skill,
        input.fetchEmailCode,
        input.profileDir,
        input.preferredOAuthProvider,
        skill.steps[i + 1],
        input.driveOAuthLogin,
      );
      if (execOutcome.kind === "needs_login") {
        return { kind: "needs_login", provider: execOutcome.provider, stepIndex: i };
      }
      // OAuth click succeeded (needs_login already returned above) → we're in
      // an authenticated returning-user session for the rest of the replay.
      if (stepToExecute.kind === "click_oauth_button") authedViaOAuth = true;
      // Track form-readiness across DISTINCT forms. A successful fill/select
      // means the CURRENT form is present; a click/navigate may move us to a
      // NEW page whose form (zilliz's /information onboarding after the OTP)
      // can itself still be hydrating — so re-arm the retry. Without the
      // re-arm, the signup form hydrates but the next form's fields get
      // eagerly skipped as "already registered".
      if (execOutcome.kind === "filled" || execOutcome.kind === "selected") {
        reachedForm = true;
        lastExecutedWasClick = false;
      } else if (execOutcome.kind === "clicked" || execOutcome.kind === "navigated") {
        reachedForm = false;
        // Stays true across SKIPPED steps (they don't execute), so a step
        // two slots after the click still gets the settle grace.
        lastExecutedWasClick = true;
      }
      if (execOutcome.kind === "extract_ok") {
        // We extracted a credential successfully. Validate it before
        // declaring victory — the synthesizer's shape inference is a
        // best-guess, and the credential validator catches the
        // Railway-class "wrong UUID on the page" failure (C5).
        const credSpec = skill.credentials[0]!;
        const validatorResult = await validateCredential(execOutcome.value, credSpec, input.fetchFn);
        if (!validatorResult.ok) {
          if (process.env.REPLAY_DEBUG) {
            try {
              const cands = await browser.extractCredentialCandidates().catch(() => []);
              const txt = (await browser.extractText().catch(() => "")).slice(0, 2000);
              writeFileSync(
                `/tmp/replay-validator-${skill.service}.txt`,
                `url=${browser.currentUrl()}\ngot=${execOutcome.value}\nreason=${validatorResult.reason}\n` +
                  `candidates=${JSON.stringify(cands.slice(0, 20))}\n\nTEXT:\n${txt}`,
              );
              console.error(`[replay-debug] dumped /tmp/replay-validator-${skill.service}.txt`);
            } catch {
              /* best-effort */
            }
          }
          return {
            kind: "validator_failed",
            stepIndex: i,
            got: execOutcome.value,
            reason: validatorResult.reason,
          };
        }
        return { kind: "ok", credential: execOutcome.value, via: execOutcome.via };
      }
      if (execOutcome.kind === "extract_named_ok") {
        // Multi-cred: accumulate into the bundle. We do per-cred shape
        // validation here (cheap) but defer bundle_sentinel validation
        // to after the loop, when every credential is in hand.
        const credSpec = skill.credentials.find(
          (c) => c.name === execOutcome.produces,
        );
        if (credSpec === undefined) {
          // The synthesizer's job is to guarantee step.produces lines
          // up with credentials[].name; reaching this branch means
          // either a hand-edited skill or a synthesizer bug. Fail loud.
          return {
            kind: "step_failed",
            stepIndex: i,
            reason:
              `Extract step's produces=${JSON.stringify(execOutcome.produces)} ` +
              `does not reference any credential in this skill's credentials[].`,
            capturedStep: step,
          };
        }
        const validatorResult = await validateCredential(
          execOutcome.value,
          credSpec,
          input.fetchFn,
        );
        if (!validatorResult.ok) {
          return {
            kind: "validator_failed",
            stepIndex: i,
            got: execOutcome.value,
            reason: `${execOutcome.produces}: ${validatorResult.reason}`,
          };
        }
        credentialBundle[execOutcome.produces] = execOutcome.value;
        viaBundle[execOutcome.produces] = execOutcome.via;
        // Don't return early — keep walking. The bundle may still need
        // more credentials (Twitter wants 5).
      }
    } catch (err) {
      return {
        kind: "step_failed",
        stepIndex: i,
        reason: markReturningUser(
          err instanceof Error ? err.message : String(err),
          skippedOnboardingFill || authedViaOAuth,
        ),
        capturedStep: step,
      };
    }

    stepsWalked += 1;
  }

  // Loop done. Branch on multi vs single:
  //   - Multi-cred: every expected produces must be in the bundle, OR
  //     the skill has a bundle_sentinel that catches missing values.
  //     We don't run bundle_sentinel here yet (Phase F per the design
  //     doc — per-auth-scheme work). Today: assert completeness, return
  //     ok_multi. Phase F will plumb the sentinel here.
  //   - Single-cred (fall-through): we exited the loop without
  //     extracting → the skill was missing its extract step.
  if (isMultiCred) {
    const missing: string[] = [];
    for (const name of expectedProduces) {
      if (credentialBundle[name] === undefined) missing.push(name);
    }
    if (missing.length > 0) {
      // Phase G safety net (replay-side): when a multi-cred bundle is
      // incomplete, do a best-effort sweep of the page for any
      // credential-shaped strings that the named extracts didn't claim.
      // Surface them in the failure reason so operators triaging
      // "what did the replay miss?" can see the candidates the planner
      // might have skipped — without changing the outcome (still
      // extraction_failed; the data is diagnostic).
      const sweepReport = await sweepUnclaimedCandidates(
        browser,
        credentialBundle,
      ).catch(() => "");
      return {
        kind: "extraction_failed",
        stepIndex: skill.steps.length - 1,
        reason:
          `Multi-credential skill walked end-to-end but missed: ` +
          `[${missing.join(", ")}]. Expected ${expectedProduces.size} credentials, ` +
          `got ${Object.keys(credentialBundle).length}.` +
          (sweepReport.length > 0 ? `\n${sweepReport}` : ""),
      };
    }
    return {
      kind: "ok_multi",
      credentials: credentialBundle,
      via: viaBundle,
    };
  }

  // We walked every step but produced no credential. Either the skill
  // is missing an extract step (the synthesizer should have caught
  // this, but be defensive) or the extract step failed silently.
  return {
    kind: "extraction_failed",
    stepIndex: skill.steps.length - 1,
    reason: "Walked entire skill graph without producing a credential.",
  };
}

// ── Step pre-validation ──────────────────────────────────────────────

interface ValidationOk {
  ok: true;
  // `match` is set when pre-validation resolved a unique inventory
  // element. Currently advisory — execution re-resolves to handle the
  // (rare) case where the page mutated between pre-validate and
  // execute. Kept on the type so a future caller can short-circuit
  // re-resolution by passing the cached match through.
  match?: InteractiveElement;
}

interface ValidationFail {
  ok: false;
  reason: string;
}

// Wait for an SPA signup form to hydrate, then re-validate the step — the
// replay-engine analogue of the live bot's waitForFormReady + reload-on-
// shell loop. A flaky hydrating SPA (zilliz /signup) renders marketing
// chrome first, so the one-shot post-navigate validation reads a form-less
// inventory; the bot retries/reloads until the form appears, and so must
// replay before it concludes a form control is genuinely absent. Bounded:
// at most three short attempts with one mid-loop reload. Returns the first
// passing validation, else the last failure (caller then runs its skip/fail
// cascade). On an already-registered account the form never appears, so
// this is a bounded no-op and the account-state skip still fires.
async function waitForFormThenRevalidate(
  step: SkillStep,
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<ValidationOk | ValidationFail> {
  let v: ValidationOk | ValidationFail = { ok: false, reason: "form not ready" };
  for (let attempt = 0; attempt < 3; attempt++) {
    await browser.waitForAuthWidgetHydration?.().catch(() => undefined);
    await browser.wait(1.5);
    if (attempt === 1) {
      // One reload to unstick a wedged loading shell (oauthShellReloads).
      try {
        await browser.goto(browser.currentUrl());
        await browser.wait(2);
        await browser.waitForInteractiveDom?.().catch(() => undefined);
      } catch {
        // navigation hiccup — the next attempt re-validates regardless
      }
    }
    v = await preValidateStep(step, browser, templateValues);
    if (v.ok) return v;
  }
  return v;
}

async function preValidateStep(
  step: SkillStep,
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<ValidationOk | ValidationFail> {
  switch (step.kind) {
    case "navigate": {
      // Navigate steps don't have an inventory dependency. We
      // accept them at face value; the actual goto either lands or
      // doesn't, and an unexpected response is caught at execute time.
      void templateValues;
      try {
        new URL(step.url);
        return { ok: true };
      } catch {
        return { ok: false, reason: `Invalid URL in navigate step: ${step.url}` };
      }
    }

    case "await_email_code": {
      // No meaningful DOM pre-check: the code input is found heuristically
      // at execute time (it may be unlabeled), and the email may not have
      // arrived yet. Accept; the executor polls the inbox and fails cleanly
      // if no code arrives or no input is found. No useful LLM fallback
      // exists for this step (there's no captured selector to substitute).
      void templateValues;
      return { ok: true };
    }

    case "click_oauth_button": {
      let inventory = await browser.extractInteractiveElements();
      let matches = preferNonConsentClickMatches(
        inventory.filter((el) => matchesClickHint(el, step.text_match)),
        step.text_match,
      );
      // Hardening (MEASURED 2026-06-24, the verifier sweep): the synthesizer
      // hardcodes step.text_match to "Google"/"GitHub", but the OAuth button
      // often (a) renders only after the SPA hydrates, or (b) is an icon /
      // "Continue with Google" affordance the literal-word match misses — and a
      // step-1 OAuth miss kills the WHOLE replay (the dominant verifier-hold
      // mode). So when text_match finds nothing: re-read after a hydration
      // settle, then fall back to the bot's provider-based finder
      // (findOAuthButton matches by provider keyword in text/aria/href + OAuth
      // scoring — the SAME logic discover used to find this button to begin
      // with). The button identity is the provider, not a literal string.
      if (matches.length === 0) {
        await browser.wait(2);
        await browser.waitForInteractiveDom().catch(() => undefined);
        inventory = await browser.extractInteractiveElements().catch(() => inventory);
        matches = preferNonConsentClickMatches(
          inventory.filter((el) => matchesClickHint(el, step.text_match)),
          step.text_match,
        );
      }
      if (matches.length === 0) {
        const byProvider = findOAuthButton(inventory, step.provider);
        if (byProvider !== null) {
          return { ok: true, match: byProvider };
        }
        return {
          ok: false,
          reason: `No ${step.provider} OAuth button found (text_match=${JSON.stringify(step.text_match)} + provider scan).`,
        };
      }
      // Multiple matches — the disambiguator (C3) picks by role first,
      // then DOM order. If we still end up with multiple after that,
      // the replay engine accepts the first one rather than rejecting,
      // because OAuth buttons rarely have legitimate duplicates and
      // rejection here is more likely a fluke than a real bug.
      const match = matches[0]!;
      return { ok: true, match };
    }

    case "click": {
      let inventory = await browser.extractInteractiveElements();
      inventory = await maybeRefreshInventoryForHydratedClick(step, browser, inventory);
      // Stable-attribute anchor FIRST. A unique name=/id= match is the most
      // drift-resistant target — it survives the visible-text changes
      // ("Create" → "Create token") and fresh-user ambiguity ("Next" matching
      // two wizard buttons) that failed the verifier sweep under a fresh
      // identity. Only honored when it resolves to exactly one element.
      if (step.dom_hint !== undefined) {
        const byDom = inventory.filter((el) => matchesDomHint(el, step.dom_hint!));
        if (byDom.length === 1) return { ok: true, match: byDom[0]! };
      }
      const matches = preferNonConsentClickMatches(
        inventory.filter((el) => matchesClickHint(el, step.text_match)),
        step.text_match,
      );
      // role_hint is a SOFT preference, not a hard gate. When it filters out
      // every text-match — imagekit's live "Next" renders as an <a>, not the
      // captured <button> — fall back to the text matches and let the
      // disambiguator below pick. A genuinely-absent target (no text match at
      // all) still falls through to the href/token fallbacks.
      const roleFiltered = step.role_hint
        ? matches.filter((el) => matchesRole(el, step.role_hint!))
        : matches;
      const filtered = roleFiltered.length > 0 ? roleFiltered : matches;
      if (filtered.length === 0) {
        // href fallback: a nav-link target whose text rendered as an icon
        // on replay (or whose URL slug differs) won't match by text but
        // still resolves by its stable href path tail. Only links carry
        // href_hint, so this never fires for button/checkbox steps.
        if (step.href_hint !== undefined) {
          const byHref = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
          if (byHref.length === 1) return { ok: true, match: byHref[0]! };
          if (rebaseHrefOntoCurrentUrl(step.href_hint, browser.currentUrl()) !== null) {
            return { ok: true };
          }
        }
        const generatedKeyRecovery = findGenerateApiKeyRecoveryCandidate(inventory, step.text_match);
        if (generatedKeyRecovery !== null) {
          return { ok: true, match: generatedKeyRecovery };
        }
        // Last-resort token-subset fallback: the captured text_match is a
        // planner gloss ("Create Token") that doesn't substring-match the live
        // button ("Create API Token"). Resolve by token containment, honoring
        // role_hint, and accept ONLY a unique match — ambiguity is unsafe for a
        // click that may mint a credential (the validator is the backstop).
        const tokenPool = step.role_hint
          ? inventory.filter((el) => matchesRole(el, step.role_hint!))
          : inventory;
        const byTokens = tokenPool.filter((el) =>
          matchesClickHintTokens(el, step.text_match),
        );
        if (byTokens.length === 1) return { ok: true, match: byTokens[0]! };
        return {
          ok: false,
          reason:
            `No element matches text_match=${JSON.stringify(step.text_match)}` +
            (step.href_hint !== undefined
              ? ` (nor href_hint=${JSON.stringify(step.href_hint)}).`
              : `.`),
        };
      }
      if (filtered.length > 1) {
        if (step.href_hint !== undefined) {
          const byHref = filtered.filter((el) => matchesHrefHint(el, step.href_hint!));
          if (byHref.length === 1) return { ok: true, match: byHref[0]! };
          const byHrefInventory = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
          if (byHrefInventory.length === 1) return { ok: true, match: byHrefInventory[0]! };
          if (rebaseHrefOntoCurrentUrl(step.href_hint, browser.currentUrl()) !== null) {
            return { ok: true };
          }
        }
        const exact = filterExactClickHint(filtered, step.text_match);
        if (exact.length === 1) return { ok: true, match: exact[0]! };
        // 0.8.3-rc.1 — schema v1+ optional near_text_hint narrows
        // ambiguous click matches BEFORE the heuristic disambiguator
        // fires. Same shape as the fill/select path (rc.3). Emitted by
        // the synthesizer when a capture-time collision was resolved
        // by unique nearby text — modal submit button shares text
        // with the listing's open-form trigger is the canonical case.
        if (step.near_text_hint !== undefined) {
          const narrowed = filterByNearTextHint(filtered, step.near_text_hint, inventory);
          if (narrowed.length === 1) return { ok: true, match: narrowed[0]! };
          if (narrowed.length === 0) {
            return {
              ok: false,
              reason:
                `text_match=${JSON.stringify(step.text_match)} matched ${filtered.length} elements; ` +
                `near_text_hint=${JSON.stringify(step.near_text_hint)} filtered to none.`,
            };
          }
          // narrowed.length > 1 — fall through to the legacy heuristic.
        }
        // Ambiguity disambiguator: prefer the first non-link button.
        // If still ambiguous, that's an LLM-fallback case (C3).
        const buttons = filtered.filter((el) => el.tag === "button");
        if (buttons.length === 1) return { ok: true, match: buttons[0]! };
        // Multiple BUTTONS with the same text (imagekit's onboarding renders
        // two "Next" buttons): pick the first. preValidate used to hard-fail
        // while execute would happily pickClickPriority — an inconsistency that
        // failed the replay before it tried. Clicking either advances a wizard
        // and the credential validator backstops a wrong pick. Ambiguous
        // NON-button elements (two same-text links) stay a hard fail — that's
        // genuine rot the skill can't pin, not a wizard button.
        if (buttons.length > 1) return { ok: true, match: buttons[0]! };
        return {
          ok: false,
          reason:
            `text_match=${JSON.stringify(step.text_match)} matched ${filtered.length} elements; ` +
            `cannot uniquely identify the click target` +
            (step.near_text_hint !== undefined
              ? `; near_text_hint=${JSON.stringify(step.near_text_hint)} did not narrow to one.`
              : `.`),
        };
      }
      return { ok: true, match: filtered[0]! };
    }

    case "fill": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => isFillable(el) && matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
        // Fuzzy last-resort: the label_hint is a verbose gloss ("Name your
        // key:") that didn't match the live input labeled "Name". Match on
        // significant-token overlap, unique only — so a present-but-glossed
        // field is filled rather than wrongly skipped (which left anthropic's
        // submit disabled). A genuinely-absent onboarding field still matches
        // nothing here and falls through to the absent-skip path.
        const fuzzy = inventory.filter(
          (el) => isFillable(el) && el.tag !== "select" && matchesLabelHintFuzzy(el, step.label_hint),
        );
        if (fuzzy.length === 1) return { ok: true, match: fuzzy[0]! };
        return {
          ok: false,
          reason: `No input matches label_hint=${JSON.stringify(step.label_hint)}.`,
        };
      }
      if (matches.length > 1) {
        // 0.8.2-rc.3 — schema v1+ optional near_text_hint narrows
        // ambiguous rows BEFORE the heuristic disambiguator fires.
        // The synthesizer emits near_text_hint only when it observed
        // a collision at capture time, so its presence here means
        // "the original capture had the same ambiguity, and this is
        // the row identifier that resolved it then". Old skills
        // (without near_text_hint) skip straight to the heuristic
        // disambiguator — full backward compat.
        const filtered = filterByNearTextHint(matches, step.near_text_hint, inventory);
        if (filtered.length === 1) return { ok: true, match: filtered[0]! };
        if (filtered.length === 0) {
          return {
            ok: false,
            reason:
              `label_hint=${JSON.stringify(step.label_hint)} matched ${matches.length} inputs; ` +
              `near_text_hint=${JSON.stringify(step.near_text_hint)} filtered to none.`,
          };
        }
        const picked = disambiguateFillMatches(filtered);
        if (picked === null) {
          return {
            ok: false,
            reason:
              `label_hint=${JSON.stringify(step.label_hint)} matched ${filtered.length} inputs ` +
              `(after near_text_hint filter); disambiguator could not uniquely identify the fill target.`,
          };
        }
        return { ok: true, match: picked };
      }
      return { ok: true, match: matches[0]! };
    }

    case "select": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => isSelectTarget(el) && matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
        return {
          ok: false,
          reason: `No select matches label_hint=${JSON.stringify(step.label_hint)}.`,
        };
      }
      if (matches.length > 1) {
        // 0.8.2-rc.3 — same near_text_hint disambiguation path as fill,
        // for Sentry-class permission grids where every row's <select>
        // shares the same label.
        const filtered = filterByNearTextHint(matches, step.near_text_hint, inventory);
        if (filtered.length === 1) return { ok: true, match: filtered[0]! };
        return {
          ok: false,
          reason:
            `label_hint=${JSON.stringify(step.label_hint)} matched ${matches.length} selects` +
            (step.near_text_hint !== undefined
              ? `; near_text_hint=${JSON.stringify(step.near_text_hint)} filtered to ${filtered.length}.`
              : `; no near_text_hint provided.`),
        };
      }
      return { ok: true, match: matches[0]! };
    }

    case "extract_via_copy_button": {
      const inventory = await browser.extractInteractiveElements();
      const copyButtons = inventory.filter(isCopyButton);
      if (copyButtons.length === 0) {
        // 0.8.2-rc.22 — pre-validation no longer hard-fails when the
        // Copy button is missing. The executor's text-extraction
        // fallback (extractCredentialCandidates + body-text regex +
        // validator-blind tier) can still recover the credential when
        // it's rendered on the page without a Copy affordance.
        // Architecturally: pre-validation ranges over "is this step
        // attempt-able"; the executor decides if attempt-able means
        // "click and read" or "scan page text and validate."
        return { ok: true };
      }
      if (copyButtons.length === 1) {
        return { ok: true, match: copyButtons[0]! };
      }
      // Multiple Copy buttons — use near_text_hint to disambiguate.
      // The hint should narrow to exactly one; if it doesn't, fail.
      const disambiguated = copyButtons.filter((btn) =>
        nearTextHintMatches(btn, step.near_text_hint, inventory),
      );
      if (disambiguated.length === 1) return { ok: true, match: disambiguated[0]! };
      if (disambiguated.length === 0) {
        return {
          ok: false,
          reason:
            `${copyButtons.length} Copy buttons visible; none near text ${JSON.stringify(step.near_text_hint)}.`,
        };
      }
      // Ambiguous (2+ match) on a SINGLE-cred extract: the synthesizer's
      // near_text_hint was unique at capture, but the returning-user keys page
      // shows extra copyable values near the same label (planetscale renders a
      // password + a connection string under one heading). Pick the FIRST
      // match in DOM order — the credential's own copy button typically leads —
      // rather than hard-failing a reachable credential. The post-extract
      // credential validator is the backstop if the first one is wrong.
      console.error(
        `[replay] ${copyButtons.length} Copy buttons match near_text_hint=${JSON.stringify(step.near_text_hint)} — ` +
          `taking the first (validator backstops a wrong pick).`,
      );
      return { ok: true, match: disambiguated[0]! };
    }

    case "extract_via_regex": {
      // Pre-validation for regex extraction: confirm the page text
      // has at least one credential candidate. We do a permissive
      // check here — the actual regex match runs at execute time.
      const text = await browser.extractText();
      if (text.trim().length === 0) {
        return { ok: false, reason: "Page extractText returned no content." };
      }
      return { ok: true };
    }

    // Multi-credential extract steps (Phase D per docs/DESIGN-multi-credential.md).
    // Same pre-validation as the single-cred variants — the only
    // difference is what the step yields at execute time (a keyed
    // entry in a multi-credential bundle).
    case "extract_via_copy_button_named": {
      const inventory = await browser.extractInteractiveElements();
      const copyButtons = inventory.filter(isCopyButton);
      if (copyButtons.length === 0) {
        return {
          ok: false,
          reason: `No Copy button visible on page (looking for ${JSON.stringify(step.produces)}).`,
        };
      }
      // On multi-cred pages there are by definition multiple Copy
      // buttons. Use near_text_hint to pick the right one.
      const disambiguated = copyButtons.filter((btn) =>
        nearTextHintMatches(btn, step.near_text_hint, inventory),
      );
      if (disambiguated.length === 1) return { ok: true, match: disambiguated[0]! };
      if (disambiguated.length === 0) {
        return {
          ok: false,
          reason:
            `${copyButtons.length} Copy buttons visible; none near text ${JSON.stringify(step.near_text_hint)} ` +
            `(producing ${step.produces}).`,
        };
      }
      return {
        ok: false,
        reason:
          `${copyButtons.length} Copy buttons visible; ${disambiguated.length} match near_text_hint ` +
          `${JSON.stringify(step.near_text_hint)} — cannot uniquely identify the source for ${step.produces}.`,
      };
    }

    case "extract_via_regex_named": {
      const text = await browser.extractText();
      if (text.trim().length === 0) {
        return {
          ok: false,
          reason: `Page extractText returned no content (extracting ${step.produces}).`,
        };
      }
      return { ok: true };
    }

    case "extract_labeled": {
      const candidates = await browser.extractLabeledCredentialCandidates();
      const match = candidates.find((c) => labelMatchesHint(c.label, step.label_hint));
      if (match === undefined) {
        if (process.env.REPLAY_DEBUG) {
          try {
            const txt = (await browser.extractText().catch(() => "")).slice(0, 2500);
            writeFileSync(
              `/tmp/replay-labeled-${step.produces}.txt`,
              `url=${browser.currentUrl()}\nlabel_hint=${step.label_hint}\n` +
                `candidates=${JSON.stringify(candidates.map((c) => ({ label: c.label, val: (c.value ?? "").slice(0, 6) })))}\n\nTEXT:\n${txt}`,
            );
            console.error(`[replay-debug] dumped /tmp/replay-labeled-${step.produces}.txt`);
          } catch {
            /* best-effort */
          }
        }
        return {
          ok: false,
          reason:
            `No labeled credential matches label_hint=${JSON.stringify(step.label_hint)} ` +
            `(producing ${step.produces}). Labels seen: ` +
            `${JSON.stringify(candidates.map((c) => c.label).filter(Boolean))}.`,
        };
      }
      // A masked value with a reveal button is fine — execute unmasks it.
      return { ok: true };
    }
  }
}

// Normalize a label and a stored label_hint for comparison: lowercase,
// strip every non-alphanumeric. "Application ID" / "application_id" /
// "application id" all collapse to "applicationid". A null candidate
// label never matches. Exported for unit testing.
export function labelMatchesHint(label: string | null, hint: string): boolean {
  if (label === null) return false;
  // Collapse common credential-label synonyms so a skill's hint matches the
  // page's variant: pusher renders "app_id" while the skill asks for
  // "application id". Apply on the already-stripped alphanumeric string so
  // underscores ("application_id") don't defeat a word boundary.
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/application/g, "app")
      .replace(/identifier/g, "id");
  const a = norm(label);
  const b = norm(hint);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function isLikelySubmitClick(step: Extract<SkillStep, { kind: "click" }>): boolean {
  const text = step.text_match.toLowerCase();
  return /\b(create account|sign up|signup|register|submit)\b/.test(text);
}

async function autofillCommonIdentityFieldsBeforeSubmit(
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<void> {
  const displayName = (templateValues.USER_DISPLAY_NAME ?? "").trim();
  const email = (templateValues.EMAIL_ALIAS ?? "").trim();
  const projectName = (templateValues.PROJECT_NAME ?? "").trim();
  const [firstFallback, ...lastParts] = displayName.split(/\s+/).filter(Boolean);
  const firstName = firstFallback ?? "Verify";
  const lastName = lastParts.join(" ") || "Robot";
  const company = projectName || `${lastName} Labs`;
  const inventory = await browser.extractInteractiveElements().catch(() => []);
  for (const el of inventory) {
    if (!isFillable(el)) continue;
    if (el.tag === "select") continue;
    if (el.value !== "") continue;
    const signal = [el.name, el.id, el.labelText, el.placeholder, el.ariaLabel]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    let value: string | null = null;
    if (/^(firstname|givenname)$/.test(signal) || signal.includes("firstname") || signal.includes("givenname")) {
      value = firstName;
    } else if (
      /^(lastname|surname|familyname)$/.test(signal) ||
      signal.includes("lastname") ||
      signal.includes("surname") ||
      signal.includes("familyname")
    ) {
      value = lastName;
    } else if ((signal === "name" || signal === "fullname" || signal.includes("fullname")) && displayName.length > 0) {
      value = displayName;
    } else if (signal.includes("company") || signal.includes("organization") || signal.includes("organisation")) {
      value = company;
    } else if (signal === "email" || signal.includes("emailaddress")) {
      value = email.length > 0 ? email : null;
    }
    if (value !== null && value.length > 0) {
      await browser.type(el.selector, value);
    }
  }
}

async function attemptCapturedCredentialLogin(
  browser: BrowserController,
  skill: Skill,
  templateValues: Record<string, string>,
  inventory: InteractiveElement[],
): Promise<boolean> {
  const emailInput = inventory.find((el) => isFillable(el) && matchesLabelHint(el, "email"));
  const passwordInput = inventory.find(
    (el) => isFillable(el) && (el.type === "password" || matchesLabelHint(el, "password")),
  );
  const submit = inventory.find(
    (el) =>
      (el.tag === "button" || el.role === "button") &&
      /^(sign in|login|log in)$/i.test((el.visibleText ?? el.ariaLabel ?? "").trim()),
  );
  if (emailInput === undefined || passwordInput === undefined || submit === undefined) return false;
  const emailStep = skill.steps.find(
    (s): s is Extract<SkillStep, { kind: "fill" }> =>
      s.kind === "fill" &&
      (s.value_template.includes("${EMAIL_ALIAS}") || labelMatchesHint(s.label_hint, "email")),
  );
  const passwordStep = skill.steps.find(
    (s): s is Extract<SkillStep, { kind: "fill" }> =>
      s.kind === "fill" &&
      !s.value_template.includes("${EMAIL_ALIAS}") &&
      (/pass|pw/i.test(s.label_hint) || s.value_template.length >= 8),
  );
  if (emailStep === undefined || passwordStep === undefined) return false;
  await browser.type(emailInput.selector, substituteTemplate(emailStep.value_template, templateValues));
  await browser.type(passwordInput.selector, substituteTemplate(passwordStep.value_template, templateValues));
  await browser.click(submit.selector);
  await browser.wait(2);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return true;
}

async function attemptAccountOnboardingGate(
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<boolean> {
  const text = await browser.extractText().catch(async () => {
    const page = pageOf(browser);
    return page === null
      ? ""
      : await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  });
  let inventory: InteractiveElement[] = [];
  if (!looksLikeAccountOnboardingGate(text)) {
    if (!shouldProbeAccountOnboardingInventory(browser.currentUrl(), text)) return false;
    inventory = await browser.extractInteractiveElements().catch(() => []);
    if (!inventoryLooksLikeAccountOnboardingGate(inventory)) return false;
  } else {
    inventory = await browser.extractInteractiveElements().catch(() => []);
  }

  const displayName = (templateValues.USER_DISPLAY_NAME ?? "").trim() || "Verify Robot";
  const email = (templateValues.EMAIL_ALIAS ?? "").trim();
  const projectName = (templateValues.PROJECT_NAME ?? "").trim();
  const [firstFallback, ...lastParts] = displayName.split(/\s+/).filter(Boolean);
  const firstName = firstFallback ?? "Verify";
  const lastName = lastParts.join(" ") || "Robot";
  const company = projectName || `${lastName} Labs`;

  let filled = 0;
  for (const el of inventory) {
    if (!isFillable(el)) continue;
    if (el.tag === "select") continue;
    if ((el.value ?? "") !== "") continue;
    const signal = elementSignal(el);
    let value: string | null = null;
    if (signal.includes("fullname") || signal === "name" || signal.includes("yourname")) {
      value = displayName;
    } else if (signal.includes("call") || signal.includes("displayname") || signal.includes("nickname")) {
      value = firstName;
    } else if (signal.includes("firstname") || signal.includes("givenname")) {
      value = firstName;
    } else if (signal.includes("lastname") || signal.includes("surname") || signal.includes("familyname")) {
      value = lastName;
    } else if (signal.includes("company") || signal.includes("organization") || signal.includes("organisation")) {
      value = company;
    } else if (signal.includes("email")) {
      value = email.length > 0 ? email : null;
    }
    if (value !== null && value.length > 0) {
      await browser.type(el.selector, value);
      if (el.role === "combobox") {
        await browser.wait(1);
        await browser.pressKey?.("Enter").catch(() => undefined);
      }
      filled += 1;
    }
  }

  let checked = 0;
  for (const el of inventory) {
    if (!isAgreementCheckboxCandidate(el)) continue;
    const signal = elementSignal(el);
    if (
      signal.includes("agree") ||
      signal.includes("terms") ||
      signal.includes("privacy") ||
      signal.includes("policy") ||
      signal.includes("age") ||
      signal.includes("18")
    ) {
      if (el.tag === "input" && el.type === "checkbox") {
        await browser.check(el.selector).catch(() => undefined);
      } else {
        await browser.click(el.selector).catch(() => undefined);
      }
      checked += 1;
    }
  }

  const latestInventory = await browser.extractInteractiveElements().catch(() => inventory);
  const submit = latestInventory.find((el) => {
    if (el.tag !== "button" && el.role !== "button") return false;
    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
    return /^(continue|next|finish|get started|start building|submit)$/i.test(label);
  });
  if (submit === undefined) return false;
  if (filled === 0 && checked === 0) return false;
  await browser.click(submit.selector);
  await browser.wait(5);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return true;
}

function looksLikeAccountOnboardingGate(text: string): boolean {
  const normalized = normalizeVisibleWords(text.replace(/[\u200B-\u200D\uFEFF]/g, " "));
  if (!/\b(?:continue|next|finish|get started|start building)\b/.test(normalized)) return false;
  return (
    /\btell us about yourself\b/.test(normalized) ||
    /\bfull name\b/.test(normalized) ||
    /\bwhat should we call you\b/.test(normalized) ||
    /\bdisplay name\b/.test(normalized) ||
    /\bfirst name\b/.test(normalized) ||
    /\blast name\b/.test(normalized) ||
    /\baccount name\b/.test(normalized) ||
    /\bcompany name\b/.test(normalized) ||
    (/\bagree\b/.test(normalized) && /\b(?:terms|privacy|policy|18)\b/.test(normalized))
  );
}

function shouldProbeAccountOnboardingInventory(currentUrl: string, text: string): boolean {
  const normalized = normalizeVisibleWords(text.replace(/[\u200B-\u200D\uFEFF]/g, " "));
  if (/\b(?:tell us about yourself|account name|company name|first name|last name)\b/.test(normalized)) {
    return true;
  }
  try {
    const path = new URL(currentUrl).pathname;
    return /\/onboarding\/1(?:$|[/?#])/i.test(path) ||
      /\/(?:profile|account)(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

function inventoryLooksLikeAccountOnboardingGate(inventory: readonly InteractiveElement[]): boolean {
  const hasSubmit = inventory.some((el) => {
    if (!isButtonish(el)) return false;
    return /^(continue|next|finish|get started|start building|submit)$/i.test(elementClickLabel(el));
  });
  if (!hasSubmit) return false;

  const fieldSignals = new Set<string>();
  for (const el of inventory) {
    if (!isFillable(el) || el.tag === "select") continue;
    const signal = elementSignal(el);
    if (signal.includes("fullname") || signal === "name" || signal.includes("yourname")) {
      fieldSignals.add("name");
    }
    if (signal.includes("firstname") || signal.includes("givenname")) {
      fieldSignals.add("first");
    }
    if (signal.includes("lastname") || signal.includes("surname") || signal.includes("familyname")) {
      fieldSignals.add("last");
    }
    if (signal.includes("company") || signal.includes("organization") || signal.includes("organisation")) {
      fieldSignals.add("company");
    }
    if (signal.includes("accountname")) {
      fieldSignals.add("account");
    }
    if (signal.includes("email")) {
      fieldSignals.add("email");
    }
  }
  return fieldSignals.size >= 2 || fieldSignals.has("company");
}

function elementSignal(el: InteractiveElement): string {
  return [el.name, el.id, el.labelText, el.placeholder, el.ariaLabel, el.visibleText]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isAgreementCheckboxCandidate(el: InteractiveElement): boolean {
  return (el.tag === "input" && el.type === "checkbox") || el.role === "checkbox";
}

async function attemptOptionalOnboardingSurveyGate(browser: BrowserController): Promise<boolean> {
  const text = await browser.extractText().catch(async () => {
    const page = pageOf(browser);
    return page === null
      ? ""
      : await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  });
  const normalized = normalizeVisibleWords(text);
  const looksOptionalSurvey =
    /\bhelp us customize your experience\b/.test(normalized) ||
    (/\bwhat(?:'s| is) your role\b/.test(normalized) &&
      /\bwhat are you (?:building|trying to do)\b/.test(normalized));
  if (!looksOptionalSurvey && !/\/onboarding\/2(?:$|[/?#])/i.test(browser.currentUrl())) {
    return false;
  }
  const inventory = await browser.extractInteractiveElements().catch(() => []);
  const skip = inventory.find((el) => {
    if (!isButtonish(el) && el.tag !== "a" && el.role !== "link") return false;
    return /^skip$/i.test(elementClickLabel(el));
  });
  if (skip === undefined) return false;
  const page = pageOf(browser);
  if (page !== null) {
    await page.getByRole("button", { name: /^Skip$/ }).click({ timeout: 5_000 }).catch(async () => {
      await browser.click(skip.selector);
    });
  } else {
    await browser.click(skip.selector);
  }
  await browser.wait(5);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return true;
}

async function attemptOptionalBillingGate(browser: BrowserController): Promise<boolean> {
  const text = await browser.extractText().catch(async () => {
    const page = pageOf(browser);
    return page === null
      ? ""
      : await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  });
  const normalized = text.toLowerCase();
  const onBillingGate =
    /\b(?:buy credits|add credits|credit card|billing address|payment method)\b/.test(normalized) ||
    /\/(?:create\/)?credits\b/i.test(browser.currentUrl());
  if (!onBillingGate) return false;

  const inventory = await browser.extractInteractiveElements().catch(() => []);
  const skip = inventory.find((el) => {
    if (el.tag !== "button" && el.role !== "button" && el.tag !== "a" && el.role !== "link") return false;
    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
    return /^(skip|skip for now|maybe later|not now|do this later)$/i.test(label);
  });
  if (skip === undefined) return false;
  await browser.click(skip.selector);
  await browser.wait(5);
  await browser.waitForInteractiveDom().catch(() => undefined);
  await attemptVisibleCredentialNavLink(browser);
  return true;
}

async function attemptVisibleCredentialNavLink(browser: BrowserController): Promise<boolean> {
  const inventory = await browser.extractInteractiveElements().catch(() => []);
  const candidates = inventory.filter((el) => {
    if (el.tag !== "a" && el.role !== "link" && el.tag !== "button" && el.role !== "button") {
      return false;
    }
    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
    const href = el.href ?? "";
    return (
      /\bapi\s+keys?\b/i.test(label) ||
      /\bapi\s+tokens?\b/i.test(label) ||
      /(?:api[-_/]?)?keys?/i.test(href) ||
      /(?:api[-_/]?)?tokens?/i.test(href)
    );
  });
  return clickCredentialNavCandidate(browser, candidates);
}

async function clickCredentialNavCandidate(
  browser: BrowserController,
  candidates: readonly InteractiveElement[],
): Promise<boolean> {
  const link = candidates.find((el) => el.tag === "a" || el.role === "link") ?? candidates[0];
  if (link === undefined) return false;
  await browser.click(link.selector);
  await browser.wait(3);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return true;
}

async function attemptSimpleProjectOnboarding(
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<boolean> {
  const base = (templateValues.PROJECT_NAME ?? templateValues.USER_DISPLAY_NAME ?? "verify project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const project = base.length > 0 ? base : "verify-project";
  const page = pageOf(browser);
  if (page !== null) {
    const body = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    if (!/\bnew project\b/i.test(body) && !/\bcreate project\b/i.test(body)) return false;
    const input = page.locator("input[type='text'], input:not([type])").first();
    await input.waitFor({ state: "visible", timeout: 2000 }).catch(() => undefined);
    if ((await input.count().catch(() => 0)) === 0) return false;
    await input.fill(project, { timeout: 3000 });
    const create = page.getByRole("button", { name: /^create project$/i }).first();
    await create.waitFor({ state: "visible", timeout: 3000 });
    await create.click({ timeout: 5000 });
  } else {
    const text = await browser.extractText().catch(() => "");
    if (!/\bnew project\b/i.test(text) && !/\bcreate project\b/i.test(text)) return false;
    const inventory = await browser.extractInteractiveElements().catch(() => []);
    const create = inventory.find((el) => matchesClickHint(el, "Create project"));
    if (create === undefined) return false;
    const input = inventory.find((el) => isFillable(el) && el.tag !== "select" && (el.value ?? "") === "");
    if (input === undefined) return false;
    await browser.type(input.selector, project);
    await browser.wait(1);
    await browser.click(create.selector);
  }
  await browser.wait(5);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return true;
}

// ── Step execution ───────────────────────────────────────────────────

type ExecutionOutcome =
  | { kind: "navigated" }
  | { kind: "clicked" }
  | { kind: "filled" }
  | { kind: "selected" }
  | { kind: "extract_ok"; value: string; via: "copy_button" | "regex" }
  // Multi-cred extract — value carries the credential, `produces` names
  // it for the bundle accumulator in replaySkill's outer loop.
  | {
      kind: "extract_named_ok";
      produces: string;
      value: string;
      via: "copy_button" | "regex" | "labeled";
    }
  | { kind: "needs_login"; provider: "google" | "github" };

async function executeStep(
  step: SkillStep,
  browser: BrowserController,
  templateValues: Record<string, string>,
  skill: Skill,
  fetchEmailCode?: (input: { alias: string }) => Promise<string | null>,
  profileDir?: string,
  preferredOAuthProvider?: OAuthProviderId,
  nextStep?: SkillStep,
  driveOAuthLogin?: (provider: OAuthProviderId) => Promise<boolean>,
): Promise<ExecutionOutcome> {
  switch (step.kind) {
    case "navigate": {
      // Rebase a captured per-account subdomain onto the live session's
      // subdomain (kinde class): the prior step left us on the current
      // account's host, so a captured deep-nav URL with a stale subdomain
      // gets rewritten to the current one. No-op for same-host / cross-product
      // / first-navigate (about:blank) cases.
      const targetUrl = normalizeKindeReplayNavigateUrl(
        rebaseSubdomain(step.url, browser.currentUrl()),
      );
      try {
        await browser.goto(targetUrl);
      } catch (err) {
        // A goto can crash transiently ("Target page, context or browser has
        // been closed") under heavy concurrency or a redirect race. Retry once
        // before failing — a genuinely-dead context throws again and surfaces a
        // clean reason instead of a raw Playwright stack. (MEASURED 2026-06-24,
        // verifier sweep: step-2 goto crashes under 2-wide concurrency.)
        await browser.wait(1);
        await browser.goto(targetUrl);
        void err;
      }
      // Settle for SPA-style apps that fire route handlers post-
      // DOMContentLoaded. A fixed 2s under-waits heavy authenticated
      // dashboards (pusher's App Keys, imagekit's onboarding step rendered
      // blank → "0 elements" at the next step). Poll for real interactive
      // content first, with the 2s as a floor for fast/static pages.
      await browser.wait(2);
      await browser.waitForInteractiveDom().catch(() => undefined);
      // Parity with the live bot's waitForFormReady: an SPA signup page can
      // render marketing chrome (so waitForInteractiveDom is satisfied)
      // while the actual auth form is still an async spinner. Without this
      // the replay reads a form-less inventory and skips the email/password
      // fills as "absent" (zilliz /signup). Bounded; no-op once the form
      // is present.
      await browser.waitForAuthWidgetHydration?.().catch(() => undefined);
      // 0.8.2-rc.22 — URL drift detection. When a skill's signup_url
      // assumes the user is authenticated (Railway's /account/tokens
      // captured after OAuth was done in a prior session), the
      // unauthenticated bot lands on a login page instead. Downstream
      // label_hint resolution then matches login-page elements that
      // coincidentally share names with the captured page ("Name"
      // input, "Workspace" select, "Create" button — all common on
      // signup OR login forms), producing false-positive step
      // successes. The replay then fails at the LAST step ("No Copy
      // button visible") with a misleading reason. Catch the drift at
      // step 0 so the verifier reports the real cause: this skill
      // needs an OAuth step it doesn't have.
      const landedUrl = browser.currentUrl();
      const driftReason = detectNavigationDrift(landedUrl, targetUrl);
      if (driftReason !== null) {
        if (nextStep?.kind === "click_oauth_button") {
          return { kind: "navigated" };
        }
        // 0.8.2-rc.22 — drive the OAuth handshake. Captured skills
        // for OAuth-protected services (Railway, Sentry, etc.) often
        // assume an authenticated session because the original capture
        // was recorded in a profile that already had OAuth cookies.
        // At replay time the persistent profile usually has the same
        // cookies (subsequent OAuth round-trips through the provider
        // auto-approve from the cached session). Click the OAuth
        // button, wait for the round-trip to complete, re-navigate to
        // the expected URL, and continue. Only bail to needs_login
        // when no OAuth path is recoverable (no provider session, no
        // OAuth button on the page).
        const recovered = await attemptOAuthRecovery(
          browser,
          resolveReplayRecoveryTargetUrl(skill, targetUrl),
          profileDir,
          preferredOAuthProvider,
        );
        if (recovered.kind === "ok") {
          await attemptCredentialRouteLinkRecovery(browser, targetUrl);
          return { kind: "navigated" };
        }
        return { kind: "needs_login", provider: recovered.provider };
      }
      await attemptCredentialRouteLinkRecovery(browser, targetUrl);
      return { kind: "navigated" };
    }

    case "click_oauth_button": {
      // Do not trust logged-in-providers.json as a hard precondition. Fleet
      // warmers can establish a real provider session without writing that
      // marker. Click the captured OAuth affordance and let walkOAuthConsent()
      // classify the actual provider state; it returns needs_login on a real
      // credential/challenge page.
      // Resolve the button via the same pre-validation logic so we're
      // clicking the same element preValidate approved. We re-fetch
      // because the inventory may have changed between pre-validation
      // and execution.
      const inventory = await browser.extractInteractiveElements();
      const match = inventory.find((el) => matchesClickHint(el, step.text_match));
      if (match === undefined) {
        throw new Error(
          `OAuth button disappeared between pre-validation and execution: ${step.text_match}`,
        );
      }
      // OAuth click uses the bot's existing startOAuth handler so
      // popup-vs-redirect normalization is consistent with the
      // universal bot path.
      await browser.startOAuth(match.selector);
      // Generalize the skill across ACCOUNT COUNT. Skills are distilled on a
      // single-account profile, where Google auto-proceeds through OAuth (cached
      // cookies, no chooser) — so the capture never RECORDS the account-chooser
      // step. A replaying user with more than one Google account hits the chooser
      // as an unrecorded interstitial; without walking it here the next recorded
      // step runs against accounts.google.com and the replay breaks. Walk the
      // chooser + basic consent out of band so a one-account capture replays for
      // an N-account user. Fast no-op when the round-trip already auto-completed
      // (single account → first state is not_provider / popup-closed → "ok").
      const walk = await walkOAuthConsent(browser, step.provider, driveOAuthLogin);
      if (walk === "needs_login") {
        return { kind: "needs_login", provider: step.provider };
      }
      // Restore the product page. Google Identity Services (meilisearch et al.)
      // runs OAuth in a POPUP that closes once consent posts the credential back
      // to the opener; without switching `this.page` off the now-closed popup,
      // the next replay step (a navigate/extract) runs against a dead page and
      // dies "Target page, context or browser has been closed". The OAuth
      // RECOVERY path already settles; the primary click_oauth_button path did
      // not — so popup-OAuth skills broke on the very next step the moment they
      // finally cleared OAuth. No-op for the same-tab redirect transport.
      await browser.settleAfterOAuth().catch(() => undefined);
      return { kind: "clicked" };
    }

    case "click": {
      let inventory = await browser.extractInteractiveElements();
      inventory = await maybeRefreshInventoryForHydratedClick(step, browser, inventory);
      // Fill the preconditions of a disabled submit BEFORE clicking it. The
      // text-gated isLikelySubmitClick only catches "create account / sign up"
      // wording; a post-OAuth ONBOARDING SURVEY (meilisearch: a required
      // role/use-case dropdown gating a "Continue") has a neutral button label,
      // so detect the disabled-submit state directly. fillRequiredComboboxes is
      // exactly what the discover bot runs here — the replay just never did, so
      // every survey-gated skill died "target is disabled after 15s" the moment
      // it cleared OAuth. Cheap DOM check; only fills when something is actually
      // unselected.
      if (isLikelySubmitClick(step) || (await browser.hasDisabledSubmit().catch(() => false))) {
        await autofillCommonIdentityFieldsBeforeSubmit(browser, templateValues);
        const picked = await browser.fillRequiredComboboxes().catch(() => [] as string[]);
        if (picked.length > 0) {
          console.error(
            `[replay] filled ${picked.length} required combobox(es) before submit: ${picked.join(", ")}`,
          );
        }
        inventory = await browser.extractInteractiveElements().catch(() => inventory);
      }
      await checkRequiredAgreementBoxesBeforeSubmitClick(browser, step);
      if (step.href_hint !== undefined && step.role_hint === "link") {
        if (scopedHrefPrefix(step.href_hint) !== null) {
          // Scoped app routes often appear only after a post-signup redirect
          // creates the user's first project/workspace. Prefer the app's live
          // link over a synthesized deep link: some SPAs (OpenPipe) can wedge
          // on direct deep-link navigation before the workspace shell has
          // finished hydrating.
          for (let attempt = 0; attempt < 45; attempt += 1) {
            const byHref = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
            if (byHref.length === 1) {
              await browser.click(byHref[0]!.selector);
              await browser.wait(3);
              await browser.waitForInteractiveDom().catch(() => undefined);
              return { kind: "clicked" };
            }
            await browser.wait(1);
            inventory = await browser.extractInteractiveElements().catch(() => inventory);
          }
          const landing = await resolveScopedLandingDestination(browser, step.href_hint);
          if (landing !== null) {
            await gotoResolvedHref(browser, landing).catch(() => undefined);
            await browser.wait(2);
            await browser.waitForInteractiveDom().catch(() => undefined);
            for (let attempt = 0; attempt < 15; attempt += 1) {
              inventory = await browser.extractInteractiveElements().catch(() => inventory);
              const byHref = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
              if (byHref.length === 1) {
                await browser.click(byHref[0]!.selector);
                await browser.wait(3);
                await browser.waitForInteractiveDom().catch(() => undefined);
                return { kind: "clicked" };
              }
              await browser.wait(1);
            }
          }
        }
        const dest = await resolveHrefDestination(browser, step.href_hint);
        if (dest !== null) {
          await gotoResolvedHref(browser, dest);
          await browser.wait(1);
          await browser.waitForInteractiveDom().catch(() => undefined);
          await attemptCredentialRouteLinkRecovery(browser, dest);
          return { kind: "clicked" };
        }
      }
      // Stable-attribute anchor FIRST (mirrors preValidate) — a unique
      // name=/id= match is the most drift-resistant target.
      if (step.dom_hint !== undefined) {
        const byDom = inventory.filter((el) => matchesDomHint(el, step.dom_hint!));
        if (byDom.length === 1) {
          await browser.click(byDom[0]!.selector);
          await browser.wait(1);
          return { kind: "clicked" };
        }
      }
      const matches = inventory.filter((el) => matchesClickHint(el, step.text_match));
      // role_hint soft-fallback (mirrors preValidate): if it filters out every
      // text-match, trust the text matches and let the disambiguator pick.
      const roleFiltered = step.role_hint
        ? matches.filter((el) => matchesRole(el, step.role_hint!))
        : matches;
      const filtered = roleFiltered.length > 0 ? roleFiltered : matches;
      if (filtered.length === 0) {
        if (await attemptCapturedCredentialLogin(browser, skill, templateValues, inventory)) {
          inventory = await browser.extractInteractiveElements().catch(() => inventory);
          const postLoginMatches = inventory.filter((el) => matchesClickHint(el, step.text_match));
          const postLoginRoleFiltered = step.role_hint
            ? postLoginMatches.filter((el) => matchesRole(el, step.role_hint!))
            : postLoginMatches;
          const postLoginFiltered =
            postLoginRoleFiltered.length > 0 ? postLoginRoleFiltered : postLoginMatches;
          if (postLoginFiltered.length > 0) {
            const narrowed = postLoginFiltered.length === 1
              ? postLoginFiltered
              : filterByNearTextHint(postLoginFiltered, step.near_text_hint, inventory);
            const target = narrowed.length === 1 ? narrowed[0]! : pickClickPriority(narrowed);
            await browser.click(target.selector);
            await browser.wait(1);
            await browser.waitForInteractiveDom().catch(() => undefined);
            return { kind: "clicked" };
          }
        }
        // href fallback (mirrors preValidate): resolve a nav link by its
        // stable href path tail when text matching finds nothing. If even
        // that fails but we have an href_hint, navigate to it directly —
        // rebased onto the current origin + workspace slug — so a sidebar
        // link hidden behind a collapsed menu or absent for a returning
        // user still reaches its destination.
        if (step.href_hint !== undefined) {
          const byHref = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
          if (byHref.length === 1) {
            await browser.click(byHref[0]!.selector);
            await browser.wait(1);
            return { kind: "clicked" };
          }
          const dest = await resolveHrefDestination(browser, step.href_hint);
          if (dest !== null) {
            await gotoResolvedHref(browser, dest);
            await browser.wait(1);
            await attemptCredentialRouteLinkRecovery(browser, dest);
            return { kind: "clicked" };
          }
        }
        if (await attemptGenerateApiKeyRecovery(browser, inventory, step.text_match, templateValues)) {
          return { kind: "clicked" };
        }
        // Token-subset fallback — mirrors preValidate so execute clicks the
        // same gloss-resolved element preValidate approved. Unique match only.
        const tokenPool = step.role_hint
          ? inventory.filter((el) => matchesRole(el, step.role_hint!))
          : inventory;
        const byTokens = tokenPool.filter((el) =>
          matchesClickHintTokens(el, step.text_match),
        );
        if (byTokens.length === 1) {
          await browser.click(byTokens[0]!.selector);
          await browser.wait(1);
          return { kind: "clicked" };
        }
        throw new Error(
          `No element matches text_match=${step.text_match}` +
            (step.href_hint !== undefined ? ` (nor href_hint=${step.href_hint})` : ""),
        );
      }
      // 0.8.3-rc.1 — share the disambiguator with preValidate so execute
      // doesn't unilaterally fall back to pickClickPriority's first-button
      // pick when near_text_hint pins a non-first match (baseten modal
      // submit shares text with the listing trigger — pickClickPriority
      // would pick the trigger, leaving the submit unclicked).
      const narrowed = filtered.length === 1
        ? filtered
        : step.href_hint !== undefined
          ? (() => {
              const byHref = filtered.filter((el) => matchesHrefHint(el, step.href_hint!));
              if (byHref.length > 0) return byHref;
              return inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
            })()
        : filterExactClickHint(filtered, step.text_match).length === 1
          ? filterExactClickHint(filtered, step.text_match)
          : filterByNearTextHint(filtered, step.near_text_hint, inventory);
      if (narrowed.length === 0 && step.href_hint !== undefined) {
        const dest = await resolveHrefDestination(browser, step.href_hint);
        if (dest !== null) {
          await gotoResolvedHref(browser, dest);
          await browser.wait(1);
          await browser.waitForInteractiveDom().catch(() => undefined);
          await attemptCredentialRouteLinkRecovery(browser, dest);
          return { kind: "clicked" };
        }
      }
      const target =
        narrowed.length === 1 ? narrowed[0]! : pickClickPriority(narrowed);
      await browser.click(target.selector);
      // Settle so any post-click navigation/SPA route render finishes before
      // the next step reads inventory (pusher's App Keys page, imagekit's
      // onboarding step render a beat after the click → blank "0 elements").
      await browser.wait(1);
      await browser.waitForInteractiveDom().catch(() => undefined);
      return { kind: "clicked" };
    }

    case "fill": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => isFillable(el) && matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
        // Fuzzy fallback (mirrors preValidate): fill a present-but-glossed
        // input matched by significant-token overlap, unique only.
        const fuzzy = inventory.filter(
          (el) => isFillable(el) && el.tag !== "select" && matchesLabelHintFuzzy(el, step.label_hint),
        );
        if (fuzzy.length === 1) {
          const value = substituteTemplate(step.value_template, templateValues);
          await browser.type(fuzzy[0]!.selector, value);
          return { kind: "filled" };
        }
        throw new Error(`No input matches label_hint=${step.label_hint}`);
      }
      // rc.25 — share the disambiguator with preValidate so execute
      // doesn't unilaterally pick `inventory.find`'s first hit when
      // the page has more than one matching input.
      // 0.8.2-rc.3 — schema-level near_text_hint runs first (mirrors
      // preValidate). When the synthesizer emitted it, the captured
      // page had this exact ambiguity and this is the row identifier
      // that pinned the right target then; trust it here.
      const narrowed = matches.length === 1
        ? matches
        : filterByNearTextHint(matches, step.near_text_hint, inventory);
      const match =
        narrowed.length === 1 ? narrowed[0]! : disambiguateFillMatches(narrowed);
      if (match === null) {
        throw new Error(
          `label_hint=${step.label_hint} matched ${matches.length} inputs ` +
            (step.near_text_hint !== undefined
              ? `(near_text_hint=${step.near_text_hint} narrowed to ${narrowed.length}); `
              : `; `) +
            `disambiguator could not uniquely identify the fill target.`,
        );
      }
      const value = substituteTemplate(step.value_template, templateValues);
      await browser.type(match.selector, value);
      return { kind: "filled" };
    }

    case "await_email_code": {
      if (fetchEmailCode === undefined) {
        throw new Error(
          "await_email_code step requires a fetchEmailCode callback, but the " +
            "caller did not wire inbox access into the replay.",
        );
      }
      const alias = templateValues.EMAIL_ALIAS;
      if (alias === undefined || alias.length === 0) {
        throw new Error(
          "await_email_code step requires templateValues.EMAIL_ALIAS (the run's " +
            "inbox alias) to poll for the verification email.",
        );
      }
      const code = await fetchEmailCode({ alias });
      if (code === null || code.length === 0) {
        throw new Error(
          `No email verification code arrived for ${alias} within the poll window.`,
        );
      }
      const inventory = await browser.extractInteractiveElements();
      const target = findCodeInput(inventory, step.label_hint);
      if (target === null) {
        throw new Error(
          "await_email_code: could not find a verification-code input on the page.",
        );
      }
      // browser.type clicks-then-pressSequentially, which auto-distributes
      // across multi-box single-digit OTP inputs (Porter/Koyeb class) as
      // well as a single combined box.
      const otpPageUrl = browser.currentUrl();
      await browser.type(target.selector, code);
      // Auto-advance is racy: a keystroke landing during the widget's focus
      // transition gets dropped by the controlled input, leaving N-1 boxes
      // filled and the submit disabled (zilliz Verify, observed 2026-06-11).
      // Read the boxes back and re-type per-box — explicit targeting, no
      // auto-advance dependency — anything that didn't stick.
      await fixupOtpDistribution(browser, code, otpPageUrl);
      return { kind: "filled" };
    }

    case "select": {
      const inventory = await browser.extractInteractiveElements();
      // 0.8.2-rc.3 — apply near_text_hint filter when present so
      // Sentry-grid rows land on the right <select>. The original
      // `inventory.find` would unilaterally pick the first match.
      //
      // 0.8.2-rc.21 — also restrict to select targets (input /
      // textarea / select / role=combobox). Without this, a Railway-class
      // form where a `<label for="select-X">` shares labelText with its
      // `<select id="select-X">` would silently pick the label —
      // and selectOption(label, …) would then route into the
      // combobox path and fail because native selects don't reveal
      // options via DOM patterns. Pre-validation already filters
      // this way; the executor was lagging.
      const allMatches = inventory.filter(
        (el) => isSelectTarget(el) && matchesLabelHint(el, step.label_hint),
      );
      if (allMatches.length === 0) {
        throw new Error(`No select matches label_hint=${step.label_hint}`);
      }
      const narrowed = allMatches.length === 1
        ? allMatches
        : filterByNearTextHint(allMatches, step.near_text_hint, inventory);
      if (narrowed.length === 0) {
        throw new Error(
          `label_hint=${step.label_hint} matched ${allMatches.length} selects; ` +
            `near_text_hint=${step.near_text_hint ?? "<none>"} filtered to none.`,
        );
      }
      const match = narrowed[0]!;
      await browser.selectOption(match.selector, step.option_text);
      return { kind: "selected" };
    }

    case "extract_via_copy_button": {
      // 0.8.2-rc.22 — poll for the Copy button OR a validator-passing
      // candidate to appear, up to 8s. The captured skill assumes the
      // post-Create UI renders synchronously, but services like
      // Railway take 1-3s to paint the new-token row. Pre-rc.22 the
      // executor ran a single inventory inspection and gave up; that
      // cost us every replay where the credential needed a beat to
      // appear.
      //
      // Loop exits on whichever happens first:
      //   (a) target Copy button materialises → break, click + run
      //       the normal extraction tiers.
      //   (b) a credential-shaped candidate appears in
      //       extractCredentialCandidates that satisfies the skill's
      //       post_extract_validator → return it directly without
      //       needing a Copy click.
      // If neither shows up in 8s, fall through to the existing
      // candidate/body/clipboard/fallback chain with the LAST polled
      // inventory + emptiness, ending in the diagnostic throw.
      const fallbackValidatorPoll =
        skill.credentials[0]?.post_extract_validator;
      const pollDeadline = Date.now() + revealPollMs();
      let inventory = await browser.extractInteractiveElements();
      let copyButtons = inventory.filter(isCopyButton);
      let target = copyButtons.length === 1
        ? copyButtons[0]
        : copyButtons.find((btn) => nearTextHintMatches(btn, step.near_text_hint, inventory));
      while (target === undefined && Date.now() < pollDeadline) {
        // Bail-on-found: a validator-passing candidate appearing first
        // is the credential. We don't need the Copy button anymore.
        if (fallbackValidatorPoll !== undefined) {
          try {
            const polled = await extractCredentialCandidatesCapped(browser);
            for (const cand of polled) {
              if (cand.length < fallbackValidatorPoll.min_length) continue;
              if (cand.length > fallbackValidatorPoll.max_length) continue;
              if (!/\d/.test(cand)) continue;
              if (!/^[a-zA-Z0-9_\-]+$/.test(cand)) continue;
              if (isCredentialNoiseCandidate(cand)) continue; // password-manager UI
              return { kind: "extract_ok", value: cand, via: "copy_button" };
            }
          } catch {
            // Non-fatal — fall through to next poll tick.
          }
        }
        await browser.wait(0.5);
        inventory = await browser.extractInteractiveElements();
        copyButtons = inventory.filter(isCopyButton);
        target = copyButtons.length === 1
          ? copyButtons[0]
          : copyButtons.find((btn) => nearTextHintMatches(btn, step.near_text_hint, inventory));
      }
      if (target !== undefined) {
        const targetIndex = copyButtons.indexOf(target);
        const selectorOrdinal = copyButtons
          .slice(0, targetIndex + 1)
          .filter((candidate) => candidate.selector === target.selector).length - 1;
        if (typeof browser.clickNth === "function") {
          await browser.clickNth(target.selector, selectorOrdinal);
        } else {
          await browser.click(target.selector);
        }
        await browser.wait(1);
      }
      const copiedValues: string[] = [];
      // BrowserController.extractCredentialCandidates pulls visible
      // candidates (input values + direct text); it does NOT read the
      // clipboard yet. We use it as the primary source and fall back
      // to the full body text for regex matching when the candidate
      // list yields nothing recognisable.
      const candidates = await extractCredentialCandidatesCapped(browser);
      for (const candidate of candidates) {
        const hit = extractApiKeyFromText(candidate);
        if (hit !== null && !isTruncatedCapture(candidate, hit)) {
          void skill; // shape-aware ranking lives in Phase 6
          return { kind: "extract_ok", value: hit, via: "copy_button" };
        }
      }
      // Body-text fallback. Some services render the credential in a
      // node that isn't picked up as a discrete candidate (CSS-styled
      // tokens, nested spans).
      const text = await extractTextCapped(browser);
      const fromBody = extractApiKeyFromText(text);
      if (fromBody !== null && !isTruncatedCapture(text, fromBody)) {
        return { kind: "extract_ok", value: fromBody, via: "copy_button" };
      }
      // 0.6.15-rc.8 — clipboard fallback. Resend (and similar) put the
      // generated key in `navigator.clipboard` via the Copy button's
      // handler, but ONLY render a masked stub (`re_…`) on the page.
      // Candidate + body-text passes both come back empty in that
      // case. readClipboard() requests the actual copied bytes via
      // navigator.clipboard.readText() — the bot's chrome profile
      // grants clipboard-read permission at context start so this
      // works without an OS prompt.
      try {
        const clip = await readClipboardCapped(browser);
        if (clip && clip.length > 0) {
          copiedValues.push(clip.trim());
          const fromClip = extractApiKeyFromText(clip);
          if (fromClip !== null && !isTruncatedCapture(clip, fromClip)) {
            return { kind: "extract_ok", value: fromClip, via: "copy_button" };
          }
          // Last resort for clipboard: the value matches the validator
          // shape even if the regex library doesn't recognize the
          // prefix. We trust the Copy button — the user/synthesizer
          // explicitly targeted it — so a clipboard payload that
          // satisfies the validator is the credential.
          const validator = skill.credentials[0]?.post_extract_validator;
          if (validator !== undefined) {
            const trimmed = clip.trim();
            if (
              trimmed.length >= validator.min_length &&
              trimmed.length <= validator.max_length &&
              /^[a-zA-Z0-9_\-.]+$/.test(trimmed)
            ) {
              return { kind: "extract_ok", value: trimmed, via: "copy_button" };
            }
          }
          if (opaqueClipboardValueLooksCredentialLike(skill, clip.trim())) {
            return { kind: "extract_ok", value: clip.trim(), via: "copy_button" };
          }
        }
      } catch {
        // Clipboard read failed (permission denied, no clipboard
        // contents). Fall through to the canonical error.
      }
      if (copyButtons.length > 1) {
        for (let i = 0; i < copyButtons.length; i += 1) {
          const btn = copyButtons[i]!;
          if (target !== undefined && btn === target) continue;
          try {
            const selectorOrdinal = copyButtons
              .slice(0, i + 1)
              .filter((candidate) => candidate.selector === btn.selector).length - 1;
            if (selectorOrdinal > 0 && typeof browser.clickNth === "function") {
              await browser.clickNth(btn.selector, selectorOrdinal);
            } else {
              await browser.click(btn.selector);
            }
            await browser.wait(0.5);
            const clip = (await readClipboardCapped(browser)).trim();
            if (clip.length === 0 || copiedValues.includes(clip)) continue;
            copiedValues.push(clip);
            const fromClip = extractApiKeyFromText(clip);
            if (fromClip !== null && !isTruncatedCapture(clip, fromClip)) {
              return { kind: "extract_ok", value: fromClip, via: "copy_button" };
            }
            const validator = skill.credentials[0]?.post_extract_validator;
            if (
              validator !== undefined &&
              clip.length >= validator.min_length &&
              clip.length <= validator.max_length &&
              /^[a-zA-Z0-9_\-.]+$/.test(clip)
            ) {
              return { kind: "extract_ok", value: clip, via: "copy_button" };
            }
            if (opaqueClipboardValueLooksCredentialLike(skill, clip)) {
              return { kind: "extract_ok", value: clip, via: "copy_button" };
            }
          } catch {
            // Best-effort alternate copy-button probe.
          }
        }
        const planetscalePair = planetscaleServiceTokenPair(copiedValues, skill.service);
        if (planetscalePair !== null) {
          return { kind: "extract_ok", value: planetscalePair, via: "copy_button" };
        }
      }
      // 0.8.2-rc.22 — validator-filtered candidate scan. Mirrors the
      // identical tier in `extract_via_regex` so that copy_button
      // steps can recover when (a) the Copy button isn't on the
      // page at all (replay reached this step without a Copy
      // affordance — Railway-class pages where the token renders
      // inline) or (b) the click + clipboard contract didn't yield
      // a recognised prefix but a credential-shaped string IS
      // sitting on the page.
      const fallbackValidator = skill.credentials[0]?.post_extract_validator;
      if (fallbackValidator !== undefined) {
        try {
          const cands = await extractCredentialCandidatesCapped(browser);
          for (const cand of cands) {
            if (cand.length < fallbackValidator.min_length) continue;
            if (cand.length > fallbackValidator.max_length) continue;
            if (!/\d/.test(cand)) continue;
            if (!/^[a-zA-Z0-9_\-]+$/.test(cand)) continue;
            if (isCredentialNoiseCandidate(cand)) continue; // password-manager UI
            return { kind: "extract_ok", value: cand, via: "copy_button" };
          }
        } catch {
          // Fall through to the canonical error below.
        }
      }
      // Diagnostic context — keeps a short trail of "what did the bot
      // see when extract failed" so we can iterate without re-running.
      // url + inventory.length is enough to triage 90% of cases; full
      // snapshots would require a new sink and aren't worth the
      // complexity here.
      const pageTextForDiag = await extractTextCapped(browser);
      const unavailableSecretDiag =
        /\b(?:client\s+)?secret\s+is\s+not\s+applicable\b/i.test(pageTextForDiag) ||
        /\bsecret\s+(?:is\s+)?(?:not\s+available|unavailable|disabled)\b/i.test(pageTextForDiag)
          ? " credential_surface=secret_unavailable"
          : "";
      const diag =
        ` [url=${browser.currentUrl()} inventory=${inventory.length} copyButtons=${copyButtons.length}${unavailableSecretDiag}]`;
      const failureReason =
        unavailableSecretDiag !== ""
          ? `Credential page says the secret is unavailable/non-applicable; stored skill likely selected or reused a public/client-only application instead of a credential-bearing confidential/server application.${diag}`
          : target === undefined
          ? `No Copy button on page and no credential-shaped string passed the validator.${diag}`
          : `Copy button clicked but no credential matched the regex library in candidates, body text, or clipboard.${diag}`;
      throw new Error(failureReason);
    }

    case "extract_via_regex": {
      // rc.18 — poll the page text for the credential. The previous
      // step (click Create / Generate / etc.) returns after a fixed
      // 1s settle, but services like Railway render the new-token
      // row 1-3s after the click. Single-shot extract was racing
      // the DOM update and finding nothing. Poll up to 8s on a
      // 500ms tick.
      //
      // rc.19 — mirror the bot's Pass-4 copy-button colocation scan.
      // Railway's modal renders the UUID in a <span>5588…</span>
      // adjacent to an icon-only "Copy Code" button. The regex
      // library cannot match a bare UUID without a nearby label,
      // so extractApiKeyFromText returns null even though the
      // value is on the page. The bot's real extractCredentials
      // accepts a bare UUID when it is colocated with a Copy
      // affordance — that colocation IS the credential signal.
      // Replay needs the same fallback or the skill replay-fails
      // forever on Railway-class flows even with the polling above.
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const deadline = Date.now() + revealPollMs();
      while (Date.now() < deadline) {
        const text = await browser.extractText();
        const extracted = extractApiKeyFromText(text);
        if (extracted !== null) {
          return { kind: "extract_ok", value: extracted, via: "regex" };
        }
        // Pass-4: scan tokens near a Copy button. extractCredentials-
        // NearCopyButtons walks each Copy affordance's ancestor
        // subtree and tokenizes; a bare UUID-shaped token there is
        // accepted as the credential.
        try {
          for (const candidate of await browser.extractCredentialsNearCopyButtons()) {
            if (UUID_RE.test(candidate)) {
              return { kind: "extract_ok", value: candidate, via: "regex" };
            }
            const hit = extractApiKeyFromText(candidate);
            if (hit !== null) {
              return { kind: "extract_ok", value: hit, via: "regex" };
            }
          }
        } catch {
          // Non-fatal — fall through to next poll tick.
        }
        await browser.wait(0.5);
      }
      // 0.6.15-rc.8 — final fallback: scan extractCredentialCandidates()
      // filtered by the skill's post_extract_validator (length range +
      // a has-digit heuristic). Catches services whose key is rendered
      // inline as element-direct-text without a copy button (IPInfo:
      // `<div>API Token</div><span>f9a062f02fadf5</span>`). The
      // pre-existing regex paths above can't find these because
      // extractText() glues DOM elements into `"API Tokenf9a062…"`
      // with no separator, and extractCredentialsNearCopyButtons()
      // returns nothing when there's no copy affordance. This
      // surfaces them safely because:
      //   - validator.{min,max}_length anchor the shape (no wandering)
      //   - a has-digit heuristic excludes common nav-label false
      //     positives ("Dashboard", "Downloads", "Subscription")
      //   - the credential validator runs afterwards anyway, so a
      //     bad candidate gets rejected at validate-time too
      // Single-cred only (multi-cred named extractors keep their
      // explicit near_text_hint path; mixing this in would defeat the
      // per-credential disambiguation).
      const validator = skill.credentials[0]?.post_extract_validator;
      if (validator !== undefined) {
        try {
          const candidates = await browser.extractCredentialCandidates();
          for (const cand of candidates) {
            if (cand.length < validator.min_length) continue;
            if (cand.length > validator.max_length) continue;
            if (!/\d/.test(cand)) continue; // skip pure-letter nav strings
            if (!/^[a-zA-Z0-9_\-]+$/.test(cand)) continue; // sanity
            if (isCredentialNoiseCandidate(cand)) continue; // password-manager UI
            return { kind: "extract_ok", value: cand, via: "regex" };
          }
        } catch {
          // Fall through to the canonical error below.
        }
      }
      // 0.8.2-rc.21 — validator-blind last-resort tier for uuid_token.
      // The synthesizer's `uuid_token` is its FALLBACK pattern when no
      // recognised prefix matches the captured HTML. inferShapeHint
      // then sets the validator to {36, 36} if ANY uuid-shaped string
      // appears on the page — even an unrelated request/session ID.
      // On IPInfo's dashboard the actual API key is a bare 14-char
      // hex string in a <code> element AND the HTML also contains
      // an unrelated 36-char tracking UUID, so the validator above
      // narrows to 36/36 and the real 14-char value is filtered out.
      // This tier fires only when:
      //   - the captured pattern was the fallback uuid_token (so we
      //     KNOW the synthesizer guessed about the shape — never for
      //     prefix-anchored patterns like sk-or-v1-, re_, etc.)
      //   - every prior tier (labeled regex, UUID poll, copy-button
      //     colocation, validator-filtered candidate scan) failed
      // Scans structural <code>/<pre>/<kbd>/<samp>-class candidates
      // (extractCredentialCandidates filters to these explicitly so
      // page chrome / nav strings don't appear here) with a wider
      // 8-128 char range, digit-required, alphanumeric-only. The
      // registry's post_extract_validator runs downstream and rejects
      // shapes that don't satisfy the credential's published shape,
      // so a false-positive surfaces as a validator-reject rather
      // than a published bad credential.
      if (step.pattern_name === "uuid_token") {
        try {
          const candidates = await browser.extractCredentialCandidates();
          // Pattern-preference pass. This validator-blind tier accepts
          // any bare 8-128 char alphanumeric token, which means a short
          // password-manager UI word ("1Password", len 9, has a digit)
          // could win over the real prefix-keyed credential that is ALSO
          // on the page — the 0DTW2V66 render skill failed exactly this
          // way (`got="1Password" length 9 below min_length 32`; the
          // real `rnd_…` key was present but shadowed by DOM order).
          // Render the candidates through the regex library FIRST: if
          // any is a recognised credential (rnd_, re_, sk_, …), it is a
          // far stronger signal than a bare word and must win.
          for (const cand of candidates) {
            const hit = extractApiKeyFromText(cand);
            // A recognised prefix-key wins — UNLESS it fails this
            // credential's own validator. extractApiKeyFromText can return
            // a SUBSTRING of a dotted/opaque key (e.g. brevo's
            // `xkeysib.<hex>.<hex>`) that isTruncatedCapture doesn't catch;
            // handing that to the outer loop would just validator_fail.
            // Defer to the validator-shaped tier below for those.
            if (
              hit !== null &&
              !isTruncatedCapture(cand, hit) &&
              (validator === undefined ||
                candidateSatisfiesValidatorShape(hit, validator))
            ) {
              return { kind: "extract_ok", value: hit, via: "regex" };
            }
          }
          for (const cand of candidates) {
            if (cand.length < 8 || cand.length > 128) continue;
            if (!/\d/.test(cand)) continue;
            if (!/^[a-zA-Z0-9_\-]+$/.test(cand)) continue;
            // Skip values that look like a URL/path/route — those
            // show up in <code> blocks for documentation snippets.
            if (cand.includes("/") || cand.includes(".")) continue;
            // Skip password-manager / autofill UI affordances. They pass
            // every shape check above (short, alphanumeric, has a digit)
            // but are never the credential.
            if (isCredentialNoiseCandidate(cand)) continue;
            return { kind: "extract_ok", value: cand, via: "regex" };
          }
        } catch {
          // Fall through to the canonical error below.
        }
        // 0.8.4 — validator-shaped candidate fallback. The rc.21 tier
        // above uses fixed heuristics (digit-required, no dot/slash,
        // 8-128) that miss real keys whose shape doesn't fit that mould
        // (brevo's `opaque` key carries no digit guarantee; a key
        // rendered with a `.` is excluded). Defer to the credential's
        // OWN validator (length + shape_regex) as the guard instead —
        // it's the authoritative shape gate the synthesizer published
        // for this service, so accepting on it can't grab a wrong-shaped
        // token. uuid_token-only, same as the rc.21 tier.
        if (validator !== undefined) {
          const validatedCand = await findValidatedCandidate(
            browser,
            validator,
          );
          if (validatedCand !== null) {
            return { kind: "extract_ok", value: validatedCand, via: "regex" };
          }
        }
      }
      throw new Error(`No credential matching pattern ${step.pattern_name} found on page.`);
    }

    // Multi-cred extract: mirrors the single-cred copy_button executor
    // but returns extract_named_ok so the outer loop can route values
    // into the bundle accumulator under `produces`.
    case "extract_via_copy_button_named": {
      const inventory = await browser.extractInteractiveElements();
      const copyButtons = inventory.filter(isCopyButton);
      const target = copyButtons.find((btn) =>
        nearTextHintMatches(btn, step.near_text_hint, inventory),
      );
      if (target === undefined) {
        throw new Error(
          `Copy button for ${step.produces} disappeared between pre-validation and execution.`,
        );
      }
      await browser.click(target.selector);
      await browser.wait(1);
      const candidates = await browser.extractCredentialCandidates();
      for (const candidate of candidates) {
        const hit = extractApiKeyFromText(candidate);
        if (hit !== null && !isTruncatedCapture(candidate, hit)) {
          void skill;
          return {
            kind: "extract_named_ok",
            produces: step.produces,
            value: hit,
            via: "copy_button",
          };
        }
      }
      const text = await browser.extractText();
      const fromBody = extractApiKeyFromText(text);
      if (fromBody !== null && !isTruncatedCapture(text, fromBody)) {
        return {
          kind: "extract_named_ok",
          produces: step.produces,
          value: fromBody,
          via: "copy_button",
        };
      }
      throw new Error(
        `Copy button for ${step.produces} clicked but no credential matched the regex library.`,
      );
    }

    case "extract_via_regex_named": {
      const text = await browser.extractText();
      const extracted = extractApiKeyFromText(text);
      if (extracted !== null) {
        return {
          kind: "extract_named_ok",
          produces: step.produces,
          value: extracted,
          via: "regex",
        };
      }
      // 0.8.4 — validator-shaped candidate fallback, mirroring the
      // single-cred extract_via_regex tier. The named regex library
      // misses the key on a fresh-account replay when the synthesizer
      // captured `uuid_token` (its DEFAULT for an unrecognised key) but
      // the real value isn't uuid-shaped (statsig). Scan candidates and
      // accept the first that satisfies THIS credential's own validator.
      // uuid_token-only: prefix-anchored patterns stay strict and fail
      // loud rather than grabbing arbitrary candidate text.
      if (step.pattern_name === "uuid_token") {
        const credSpec = skill.credentials.find(
          (c) => c.name === step.produces,
        );
        if (credSpec !== undefined) {
          const validatedCand = await findValidatedCandidate(
            browser,
            credSpec.post_extract_validator,
          );
          if (validatedCand !== null) {
            return {
              kind: "extract_named_ok",
              produces: step.produces,
              value: validatedCand,
              via: "regex",
            };
          }
        }
      }
      throw new Error(
        `No credential matching pattern ${step.pattern_name} (for ${step.produces}) found on page.`,
      );
    }

    case "extract_labeled": {
      // Label-scoped extraction: find the value whose on-page label
      // matches this step's label_hint. Unmask first if the matched
      // candidate is masked behind a Reveal button, then re-read.
      let candidates = await browser.extractLabeledCredentialCandidates();
      let match = candidates.find((c) => labelMatchesHint(c.label, step.label_hint));
      if (match !== undefined && match.isMasked) {
        await browser.revealMaskedCredentials();
        await browser.wait(1);
        candidates = await browser.extractLabeledCredentialCandidates();
        match = candidates.find((c) => labelMatchesHint(c.label, step.label_hint));
      }
      // Current-account resource resolution (algolia class): the skill captured
      // a POST-redirect URL with the original account's resource id
      // (/apps/86WV27C86H/dashboard), so on replay it points at someone else's
      // app → no labels at all. Re-enter at the host root; a logged-in service
      // redirects to the CURRENT account's equivalent, where the creds render.
      // Only fires when the page yielded ZERO labeled candidates, so a
      // successfully-extracting skill never takes this path.
      if (match === undefined && candidates.length === 0 && (await reEnterAtAccountRoot(browser))) {
        candidates = await browser.extractLabeledCredentialCandidates();
        match = candidates.find((c) => labelMatchesHint(c.label, step.label_hint));
      }
      if (match === undefined) {
        throw new Error(
          `No labeled credential matches label_hint=${step.label_hint} (for ${step.produces}).`,
        );
      }
      if (match.isMasked || /^[•*•●\s]+$/.test(match.value)) {
        throw new Error(
          `Labeled credential ${step.produces} (label_hint=${step.label_hint}) is still masked ` +
            `after the reveal pass — value not recoverable.`,
        );
      }
      return {
        kind: "extract_named_ok",
        produces: step.produces,
        value: match.value,
        via: "labeled",
      };
    }
  }
  const _exhaustive: never = step;
  throw new Error(`Unhandled step kind: ${(_exhaustive as unknown as { kind: string }).kind}`);
}

// ── Credential validator ────────────────────────────────────────────

interface ValidatorOk {
  ok: true;
}
interface ValidatorFail {
  ok: false;
  reason: string;
}

// 0.8.4 — deterministic (non-network) half of validateCredential: the
// length bounds + shape_regex gate, minus the async sentinel HTTP probe.
// Used by the candidate-fallback tier (findValidatedCandidate) to pick
// the right value off the page BEFORE the outer loop runs the full
// validateCredential (which also fires the sentinel). Mirrors the
// length-relaxation in validateCredential exactly so the two agree on
// what "shape-valid" means — a candidate this accepts won't then be
// rejected on shape by validateCredential, only (possibly) by the
// sentinel.
function candidateSatisfiesValidatorShape(
  value: string,
  validator: SkillCredentialSpec["post_extract_validator"],
): boolean {
  const recognisedByLibrary = extractApiKeyFromText(value) === value;
  if (!recognisedByLibrary) {
    if (value.length < validator.min_length) return false;
    if (value.length > validator.max_length) return false;
  }
  if (validator.shape_regex !== undefined) {
    try {
      if (!new RegExp(validator.shape_regex).test(value)) return false;
    } catch {
      // Invalid regex on the validator itself is a schema bug, not a
      // credential rejection — matches validateCredential's pass-through.
    }
  }
  return true;
}

// 0.8.4 — candidate-fallback for the generic `uuid_token` pattern.
//
// `uuid_token` is the synthesizer's DEFAULT pattern_name in
// detectKnownCredentialPattern (promote-to-skill.ts) for a key with no
// recognised prefix. The captured extract step therefore looks for a
// uuid-shaped string via the named regex library — but on a fresh-
// account replay the real key often isn't uuid-shaped (or the original
// run saw a transient uuid that's now gone), so the named regex matches
// nothing and the step hard-fails (brevo: `opaque`; statsig: `uuid`).
//
// This recovers those cases by scanning the page's credential candidates
// and accepting the first that satisfies the credential's own validator
// (length bounds + shape_regex). The validator IS the guard: a candidate
// that doesn't match the published shape is rejected, so this can't grab
// the wrong token. Callers fire it ONLY for `uuid_token` — prefix-
// anchored patterns (resend/stripe/openrouter/…) stay strict and never
// reach here, so a mistaken empty-page capture for those still fails
// loud rather than grabbing arbitrary candidate text.
async function findValidatedCandidate(
  browser: BrowserController,
  validator: SkillCredentialSpec["post_extract_validator"],
): Promise<string | null> {
  try {
    const candidates = await browser.extractCredentialCandidates();
    for (const cand of candidates) {
      // Same noise gate the heuristic tiers apply — a password-manager
      // affordance or consent-widget word that happens to satisfy a
      // length-only validator must not shadow the real key.
      if (isCredentialNoiseCandidate(cand)) continue;
      if (candidateSatisfiesValidatorShape(cand, validator)) return cand;
    }
  } catch {
    // Non-fatal — caller falls through to its canonical failure.
  }
  return null;
}

function planetscaleServiceTokenPair(values: readonly string[], service: string): string | null {
  if (service !== "planetscale") return null;
  const cleaned = values.map((v) => v.trim()).filter((v) => v.length > 0);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = cleaned.find((v) => uuid.test(v));
  const token = cleaned.find(
    (v) =>
      v !== id &&
      v.length >= 12 &&
      !uuid.test(v) &&
      /^[A-Za-z0-9_.:-]+$/.test(v),
  );
  return id !== undefined && token !== undefined ? `${id}:${token}` : null;
}

function opaqueClipboardValueLooksCredentialLike(skill: Skill, value: string): boolean {
  if (skill.credentials[0]?.shape_hint !== "opaque") return false;
  if (value.length < 16 || value.length > 128) return false;
  if (!/\d/.test(value)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  if (isCredentialNoiseCandidate(value)) return false;
  return true;
}

async function readClipboardCapped(browser: BrowserController): Promise<string> {
  return await Promise.race([
    browser.readClipboard(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 2500)),
  ]);
}

async function extractTextCapped(browser: BrowserController): Promise<string> {
  return await Promise.race([
    browser.extractText().catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 2500)),
  ]);
}

async function extractCredentialCandidatesCapped(browser: BrowserController): Promise<string[]> {
  return await Promise.race([
    browser.extractCredentialCandidates().catch(() => []),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2500)),
  ]);
}

async function validateCredential(
  value: string,
  spec: SkillCredentialSpec,
  fetchFn?: typeof globalThis.fetch,
): Promise<ValidatorOk | ValidatorFail> {
  const validator = spec.post_extract_validator;
  if (
    /^PLANETSCALE_/i.test(spec.env_var_suggestion) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.{12,}$/i.test(value)
  ) {
    return { ok: true };
  }
  // 0.8.3 — length bounds are advisory when the regex library
  // recognises the value's shape. The synthesizer computes
  // min/max_length from a single observed example at capture time
  // and frequently misjudges (e.g. replicate captured at 36 chars
  // but real keys are 40 chars; shape inference also misidentifies
  // some prefix-keyed services as "uuid" which then locks
  // min/max=36/36). The extractApiKeyFromText library is the real
  // shape gate — if it recognises the value as a known credential
  // pattern, trust it over the per-skill length bound. Falsey
  // (no recognised prefix) → length bounds still gate, which
  // keeps "IDNameIDKeyStatusCreated"-style garbage out.
  const recognisedByLibrary = extractApiKeyFromText(value) === value;
  if (!recognisedByLibrary) {
    if (value.length < validator.min_length) {
      return {
        ok: false,
        reason: `Credential length ${value.length} is below min_length ${validator.min_length}.`,
      };
    }
    if (value.length > validator.max_length) {
      return {
        ok: false,
        reason: `Credential length ${value.length} exceeds max_length ${validator.max_length}.`,
      };
    }
  }
  if (validator.shape_regex !== undefined) {
    try {
      const re = new RegExp(validator.shape_regex);
      if (!re.test(value)) {
        return {
          ok: false,
          reason: `Credential does not match shape_regex ${validator.shape_regex}.`,
        };
      }
    } catch {
      // Invalid regex on the validator itself — treat as a schema bug,
      // not a credential rejection. Pass through.
    }
  }
  // T27 (C5) — sentinel HTTP check. Fire a live probe at the
  // service's /whoami-equivalent endpoint to confirm the extracted
  // value is the RIGHT credential, not just shape-correct. This is
  // the wall against the Railway 0.6.13 class bug (mechanical steps
  // succeed, wrong UUID extracted). When the sentinel isn't
  // configured, skip — length+regex is the only gate.
  if (validator.sentinel_http_check !== undefined) {
    const sentinelResult = await runSentinelHttpCheck(
      value,
      validator.sentinel_http_check,
      fetchFn ?? globalThis.fetch,
    );
    if (!sentinelResult.ok) return sentinelResult;
  }
  return { ok: true };
}

/**
 * Fire the sentinel HTTP check. Presents the extracted credential as
 * configured (bearer / basic / x-api-key / query_param), expects a
 * 2xx response. Any other outcome (4xx, 5xx, timeout, network error)
 * means the credential is wrong — abort the replay with
 * validator_failed.
 *
 * Bounded by sentinel.timeout_ms (default 3000, range 500-10000).
 */
async function runSentinelHttpCheck(
  credential: string,
  sentinel: NonNullable<SkillCredentialSpec["post_extract_validator"]["sentinel_http_check"]>,
  fetchFn: typeof globalThis.fetch,
): Promise<ValidatorOk | ValidatorFail> {
  const url = new URL(sentinel.url);
  const headers: Record<string, string> = {};

  switch (sentinel.auth_scheme) {
    case "bearer":
      headers["authorization"] = `Bearer ${credential}`;
      break;
    case "basic":
      // Spec assumes the credential IS the full token. Standard basic
      // would need user:pass — for skills, the bot's only credential
      // is the API key, so we send it as user with empty password
      // per the convention many APIs use (e.g. Stripe).
      headers["authorization"] = `Basic ${Buffer.from(`${credential}:`).toString("base64")}`;
      break;
    case "header_x_api_key":
      headers["x-api-key"] = credential;
      break;
    case "query_param":
      url.searchParams.set("api_key", credential);
      break;
  }

  const timeoutMs = sentinel.timeout_ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sentinel HTTP check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  let response: Response;
  try {
    response = await Promise.race([
      fetchFn(url.toString(), { method: "GET", headers }),
      timeoutPromise,
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: `sentinel HTTP check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reason: `sentinel HTTP check rejected the credential (HTTP ${response.status}).`,
    };
  }
  return { ok: true };
}

// ── LLM fallback orchestration ──────────────────────────────────────

type FallbackResult =
  | { kind: "use_substitute"; substitute: SkillStep }
  | { kind: "give_up" }
  | { kind: "needs_login"; provider: "google" | "github" };

async function tryFallback(
  capturedStep: SkillStep,
  reason: string,
  browser: BrowserController,
  stepIndex: number,
  skill: Skill,
  llmFallback: ReplayInput["llmFallback"],
  candidatesDir: string | undefined,
  profileDir: string | undefined,
): Promise<FallbackResult> {
  void profileDir;

  if (llmFallback === undefined) return { kind: "give_up" };

  const inventory = await browser.extractInteractiveElements();
  const substitute = await llmFallback({
    capturedStep,
    reason,
    inventory,
    stepIndex,
    skill,
  });
  if (substitute === null) return { kind: "give_up" };

  // Write skill-update-candidate to disk if a candidates dir was
  // configured. The next promoter run picks this up to update the
  // skill (D6).
  if (candidatesDir !== undefined) {
    writeSkillUpdateCandidate(candidatesDir, skill, stepIndex, capturedStep, substitute, reason);
  }

  return { kind: "use_substitute", substitute };
}

interface SkillUpdateCandidate {
  candidate_format_version: 1;
  skill_id: string;
  service: string;
  step_index: number;
  captured_step: SkillStep;
  substitute_step: SkillStep;
  reason: string;
  produced_at: string;
}

function writeSkillUpdateCandidate(
  candidatesDir: string,
  skill: Skill,
  stepIndex: number,
  capturedStep: SkillStep,
  substitute: SkillStep,
  reason: string,
): void {
  try {
    mkdirSync(candidatesDir, { recursive: true });
    const filename = `${skill.service}-${skill.skill_id}-candidates.jsonl`;
    const path = join(candidatesDir, filename);
    const record: SkillUpdateCandidate = {
      candidate_format_version: 1,
      skill_id: skill.skill_id,
      service: skill.service,
      step_index: stepIndex,
      captured_step: capturedStep,
      substitute_step: substitute,
      reason,
      produced_at: new Date().toISOString(),
    };
    // Append a JSON line. JSONL keeps the file safely append-only —
    // concurrent replays can each contribute without locking.
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // Best-effort. A failed write should not affect the replay.
  }
}

// ── Inventory matching helpers ──────────────────────────────────────

// Substring match that requires the needle to sit at a WORD boundary — the
// adjacent characters must not be alphanumeric or a dot. Without this, a short
// hint like "Next" matched "Next.js" (imagekit's dashboard footer), so a stale
// onboarding "Next" step false-matched framework chrome instead of being
// skipped as absent. Multi-word hints still match across internal whitespace.
function includesAtWordBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const isWordChar = (c: string): boolean => /[a-z0-9.]/i.test(c);
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx === 0 ? "" : haystack[idx - 1]!;
    const afterIdx = idx + needle.length;
    const after = afterIdx >= haystack.length ? "" : haystack[afterIdx]!;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

function matchesClickHint(el: InteractiveElement, hint: string): boolean {
  const lowerHint = normalizeVisibleWords(hint);
  const text = normalizeVisibleWords(el.visibleText ?? "");
  const aria = normalizeVisibleWords(el.ariaLabel ?? "");
  if (includesAtWordBoundary(text, lowerHint) || includesAtWordBoundary(aria, lowerHint)) {
    return true;
  }
  // 0.8.3-rc.1 — stable-attribute fallback. Form-control elements
  // routinely have a stable `name` attribute (mistral's ToS checkbox
  // ships as `<input name="terms">`) even when their visible text is
  // empty. We accept EXACT name matches (substring would over-match —
  // a "terms" hint shouldn't pin every "termsTooltip" element). The
  // stable-id check skips runtime-generated IDs the synthesizer
  // wouldn't have used as a hint in the first place.
  const name = (el.name ?? "").toLowerCase();
  if (name.length > 0 && name === lowerHint) return true;
  const id = (el.id ?? "").toLowerCase();
  if (id.length > 0 && id === lowerHint && !isRuntimeId(id)) return true;
  return false;
}

function preferNonConsentClickMatches(
  matches: InteractiveElement[],
  hint: string,
): InteractiveElement[] {
  if (matches.length <= 1) return matches;
  if (/\b(?:accept|allow|authorize|consent|cookie|necessary|preferences)\b/i.test(hint)) {
    return matches;
  }
  const outsideConsent = matches.filter((el) => !el.inConsentWidget);
  return outsideConsent.length > 0 ? outsideConsent : matches;
}

async function maybeRefreshInventoryForHydratedClick(
  step: Extract<SkillStep, { kind: "click" }>,
  browser: BrowserController,
  inventory: InteractiveElement[],
): Promise<InteractiveElement[]> {
  if (step.dom_hint === undefined) return inventory;
  const hasDomMatch =
    step.dom_hint !== undefined &&
    inventory.some((el) => matchesDomHint(el, step.dom_hint!));
  const hasTextMatch = inventory.some((el) => matchesClickHint(el, step.text_match));
  if (hasDomMatch || hasTextMatch) return inventory;
  await browser.wait(2);
  await browser.waitForInteractiveDom().catch(() => undefined);
  return await browser.extractInteractiveElements().catch(() => inventory);
}

function filterExactClickHint(
  elements: readonly InteractiveElement[],
  hint: string,
): InteractiveElement[] {
  const want = normalizeVisibleWords(hint);
  if (want.length === 0) return [];
  return elements.filter((el) => {
    const text = normalizeVisibleWords(el.visibleText ?? "");
    const aria = normalizeVisibleWords(el.ariaLabel ?? "");
    return text === want || aria === want;
  });
}

function elementClickLabel(el: InteractiveElement): string {
  return `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
}

function isButtonish(el: InteractiveElement): boolean {
  return el.tag === "button" || el.role === "button";
}

function isStaleRevealApiKeyHint(hint: string): boolean {
  const normalized = normalizeVisibleWords(hint);
  return /\b(?:reveal|show|view)\b/.test(normalized) && /\b(?:api\s+)?key\b/.test(normalized);
}

function isGenerateApiKeyAction(el: InteractiveElement): boolean {
  if (!isButtonish(el)) return false;
  const label = normalizeVisibleWords(elementClickLabel(el));
  return /^(?:generate|create)(?:\s+new)?\s+(?:api\s+)?key$/.test(label) ||
    /^new\s+(?:api\s+)?key$/.test(label);
}

function findGenerateApiKeyRecoveryCandidate(
  inventory: readonly InteractiveElement[],
  missingHint: string,
): InteractiveElement | null {
  if (!isStaleRevealApiKeyHint(missingHint)) return null;
  const candidates = inventory.filter(isGenerateApiKeyAction);
  return candidates.length === 1 ? candidates[0]! : null;
}

function generatedCredentialName(templateValues: Record<string, string>): string {
  const existing = (templateValues.TOKEN_NAME ?? templateValues.KEY_NAME ?? "").trim();
  if (existing.length > 0) return existing;
  const alias = (templateValues.EMAIL_ALIAS ?? "").trim();
  const local = alias.split("@")[0]?.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return local !== undefined && local.length > 0 ? `trusty-squire-${local}` : "trusty-squire-api-key";
}

function findGeneratedKeyNameInput(inventory: readonly InteractiveElement[]): InteractiveElement | null {
  const fillables = inventory.filter((el) => isFillable(el) && el.tag !== "select");
  const exact = fillables.filter((el) => matchesLabelHint(el, "Name"));
  if (exact.length === 1) return exact[0]!;
  const descriptive = fillables.filter((el) => {
    const text = normalizeVisibleWords(
      `${el.labelText ?? ""} ${el.placeholder ?? ""} ${el.ariaLabel ?? ""} ${el.name ?? ""} ${el.id ?? ""}`,
    );
    return /\b(?:name|label|friendly)\b/.test(text) && /\b(?:key|token|api)\b/.test(text);
  });
  if (descriptive.length === 1) return descriptive[0]!;
  return null;
}

function findModalGenerateButton(inventory: readonly InteractiveElement[]): InteractiveElement | null {
  const candidates = inventory.filter((el) => {
    if (!isButtonish(el)) return false;
    const label = normalizeVisibleWords(elementClickLabel(el));
    return label === "generate" || label === "create";
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

async function attemptGenerateApiKeyRecovery(
  browser: BrowserController,
  inventory: readonly InteractiveElement[],
  missingHint: string,
  templateValues: Record<string, string>,
): Promise<boolean> {
  const start = findGenerateApiKeyRecoveryCandidate(inventory, missingHint);
  if (start === null) return false;

  await browser.click(start.selector);
  await browser.wait(1);
  await browser.waitForInteractiveDom().catch(() => undefined);

  const modalInventory = await browser.extractInteractiveElements().catch(() => []);
  const nameInput = findGeneratedKeyNameInput(modalInventory);
  if (nameInput !== null) {
    await browser.type(nameInput.selector, generatedCredentialName(templateValues));
  }

  const submit = findModalGenerateButton(modalInventory);
  if (submit !== null) {
    await browser.click(submit.selector);
    await browser.wait(2);
    await browser.waitForInteractiveDom().catch(() => undefined);
  }
  return true;
}

// Token-subset fallback for a credential-creating click whose captured
// text_match is a planner GLOSS that doesn't substring-match the live button
// ("Create Token" vs the page's "Create API Token" / "+ Create new token").
// Matches when EVERY meaningful token (len>=3) of the hint appears among the
// element's text/aria tokens, order-independent. Deliberately looser than
// matchesClickHint's substring rule, so it is used ONLY as a last resort and
// ONLY when it resolves to a UNIQUE element (the call site enforces this) —
// pinning the wrong control on a click that may mint a credential is the risk,
// and the post-extract credential validator is the backstop if it slips.
// REPLAY_DEBUG diagnostic: on a step failure, dump the current URL + visible
// clickable/fillable inventory to /tmp/replay-debug-<service>-step<N>.json so a
// returning-user divergence can be diagnosed against the REAL authenticated
// page (which a standalone trace can't reach — it doesn't walk OAuth consent).
// No-op unless REPLAY_DEBUG is set; best-effort (never throws into replay).
async function maybeDumpReplayDebug(
  browser: BrowserController,
  skill: { service: string },
  stepIndex: number,
  reason: string,
): Promise<void> {
  if (!process.env.REPLAY_DEBUG) return;
  try {
    const inv = await browser.extractInteractiveElements();
    const interesting = inv
      .filter((e) => e.visible)
      .map((e) => ({
        tag: e.tag,
        type: e.type,
        role: e.role,
        text: (e.visibleText ?? "").slice(0, 60),
        aria: e.ariaLabel,
        label: e.labelText,
        placeholder: e.placeholder,
        href: e.href ?? null,
        selector: e.selector,
        // Field state is the diagnostic for "submit stays disabled" failures
        // (which box is actually empty?). Password values stay redacted.
        value: e.type === "password" ? (e.value ? "<redacted>" : "") : (e.value ?? null),
      }))
      .filter((e) => e.text || e.aria || e.label || e.placeholder || e.href || e.value);
    // Visible page text (toasts, validation errors, "code expired" banners)
    // — interactive inventory alone can't show WHY a page refused to move.
    const pageText = (await browser.extractText().catch(() => "")).slice(0, 1500);
    const path = `/tmp/replay-debug-${skill.service}-step${stepIndex}.json`;
    writeFileSync(
      path,
      JSON.stringify(
        { service: skill.service, stepIndex, reason, url: browser.currentUrl(), pageText, interesting },
        null,
        2,
      ),
    );
    console.error(`[replay-debug] dumped ${path} (${interesting.length} elements)`);
  } catch {
    // best-effort diagnostic only
  }
}

function matchesClickHintTokens(el: InteractiveElement, hint: string): boolean {
  const tokenize = (s: string): string[] =>
    (normalizeVisibleWords(s).match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
  const want = tokenize(hint);
  if (want.length === 0) return false;
  const have = new Set([
    ...tokenize(el.visibleText ?? ""),
    ...tokenize(el.ariaLabel ?? ""),
  ]);
  return want.every((t) => have.has(t));
}

function normalizeVisibleWords(s: string): string {
  return s
    .replace(/[\uE000-\uF8FF]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// 2026-06-07 — href-tail match for nav-link clicks. The synthesizer
// records a link target's href path (href_hint); on replay the link's
// visible text may render as an icon and its URL's leading workspace/org
// slug differs between the capturing account and the replaying one. We
// match on the path TAIL after dropping a leading slug-like segment, so
// /ts-6689-z0as/settings (captured) matches /ts-9f3a-bk21/settings
// (replay). Pure + exported for unit tests.
//
// Returns the normalized comparable path: segments with a leading
// workspace/org-slug segment dropped. A slug segment is one that looks
// account-specific — contains a digit, or is a long hyphenated token —
// which the captured/replay org slugs (ts-6689-z0as) both satisfy while
// real route words (settings, api-tokens, account) do not.
export function normalizeNavPath(path: string): string[] {
  const segs = path.split("/").filter((s) => s.length > 0);
  if (segs.length <= 1) return segs.map((s) => s.toLowerCase());
  const first = segs[0]!;
  if (
    segs.length >= 3 &&
    /^(?:p|project|projects|org|organization|organizations|workspace|workspaces)$/i.test(first)
  ) {
    return [first, ...segs.slice(2)].map((s) => s.toLowerCase());
  }
  const looksLikeSlug = /\d/.test(first) || /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(first);
  const tail = looksLikeSlug ? segs.slice(1) : segs;
  return tail.map((s) => s.toLowerCase());
}

// True when the element carries the captured stable name/id anchor. A hint
// may specify name, id, or both; an element matches when it equals EVERY
// specified attribute (case-sensitive — these are exact attribute values, not
// display text). The caller requires a UNIQUE match before trusting it.
export function matchesDomHint(
  el: InteractiveElement,
  hint: { name?: string | undefined; id?: string | undefined; testid?: string | undefined },
): boolean {
  if (hint.name === undefined && hint.id === undefined && hint.testid === undefined) return false;
  if (hint.testid !== undefined && (el.testId ?? null) !== hint.testid) return false;
  if (hint.name !== undefined && el.name !== hint.name) return false;
  if (hint.id !== undefined && el.id !== hint.id) return false;
  return true;
}

export function matchesHrefHint(el: InteractiveElement, hrefHint: string): boolean {
  const isLink = el.tag === "a" || el.role === "link";
  if (!isLink) return false;
  const raw = (el.href ?? "").trim();
  if (raw.length === 0) return false;
  let elPath: string;
  try {
    elPath = new URL(raw, "https://x.invalid").pathname;
  } catch {
    return false;
  }
  const want = normalizeNavPath(hrefHint);
  const have = normalizeNavPath(elPath);
  if (want.length === 0 || have.length === 0) return false;
  // Equal normalized paths, or one is a trailing-suffix of the other
  // (handles /settings captured vs /settings/api-tokens on replay, and
  // vice-versa). Require the LAST segment to agree and be meaningful so
  // we don't match every nav link by an empty/trivial tail.
  const last = want[want.length - 1]!;
  if (last.length < 3 || last !== have[have.length - 1]) return false;
  const shorter = want.length < have.length ? want : have;
  const longer = want.length < have.length ? have : want;
  return shorter.every((seg, i) => seg === longer[longer.length - shorter.length + i]);
}

// True when a path's first segment looks account-specific (a workspace /
// org slug) rather than a stable route word. Mirrors normalizeNavPath's
// slug test.
function firstSegmentIsSlug(seg: string | undefined): boolean {
  if (seg === undefined) return false;
  return /\d/.test(seg) || /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(seg);
}

// Build an absolute URL to navigate to from a captured href path, rebased
// onto the current page's origin and workspace slug. /ts-6689-z0as/settings
// captured + current https://app.axiom.co/ts-9f3a-bk21/x → the replay's own
// https://app.axiom.co/ts-9f3a-bk21/settings. Returns null when the current
// URL is unparseable. Exported for unit tests.
export function rebaseHrefOntoCurrentUrl(
  hrefHint: string,
  currentUrl: string,
): string | null {
  let cur: URL;
  try {
    cur = new URL(currentUrl);
  } catch {
    return null;
  }
  const capSegs = hrefHint.split("/").filter((s) => s.length > 0);
  if (capSegs.length === 0) return null;
  const curSegs = cur.pathname.split("/").filter((s) => s.length > 0);
  if (
    capSegs.length >= 2 &&
    curSegs.length >= 2 &&
    capSegs[0] === curSegs[0] &&
    /^(?:p|project|projects|org|organization|organizations|workspace|workspaces)$/i.test(capSegs[0]!)
  ) {
    capSegs[1] = curSegs[1]!;
  }
  // When both the captured path and the current URL lead with a slug-shaped
  // segment, swap in the replay account's slug so the destination resolves
  // under the right workspace. Otherwise navigate the captured path as-is.
  if (firstSegmentIsSlug(capSegs[0]) && firstSegmentIsSlug(curSegs[0])) {
    capSegs[0] = curSegs[0]!;
  }
  return `${cur.origin}/${capSegs.join("/")}`;
}

function scopedHrefPrefix(hrefHint: string): string | null {
  const segs = hrefHint.split("/").filter((s) => s.length > 0);
  if (
    segs.length >= 2 &&
    /^(?:p|project|projects|org|organization|organizations|workspace|workspaces)$/i.test(segs[0]!)
  ) {
    return segs[0]!;
  }
  return null;
}

export function rebaseScopedHrefWithCandidate(
  hrefHint: string,
  currentUrl: string,
  candidate: string,
): string | null {
  let cur: URL;
  try {
    cur = new URL(currentUrl);
  } catch {
    return null;
  }
  const segs = hrefHint.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  if (candidate.trim().length === 0) return null;
  segs[1] = candidate.trim();
  return `${cur.origin}/${segs.map((seg) => encodeURIComponent(seg)).join("/")}`;
}

async function resolveScopedLandingDestination(
  browser: BrowserController,
  hrefHint: string,
): Promise<string | null> {
  const prefix = scopedHrefPrefix(hrefHint);
  if (prefix === null) return null;
  const currentHasScope = (() => {
    try {
      return new URL(browser.currentUrl()).pathname.split("/").filter(Boolean)[0] === prefix;
    } catch {
      return false;
    }
  })();
  if (currentHasScope) return null;
  const candidates = await browser.extractScopedRouteCandidates(prefix).catch(() => []);
  const unique = Array.from(new Set(candidates));
  if (unique.length !== 1) return null;
  try {
    const cur = new URL(browser.currentUrl());
    return `${cur.origin}/${prefix}/${encodeURIComponent(unique[0]!)}`;
  } catch {
    return null;
  }
}

async function resolveHrefDestination(
  browser: BrowserController,
  hrefHint: string,
): Promise<string | null> {
  const prefix = scopedHrefPrefix(hrefHint);
  let dest = rebaseHrefOntoCurrentUrl(hrefHint, browser.currentUrl());
  if (prefix === null || dest === null) return dest;
  const currentHasScope = (() => {
    try {
      return new URL(browser.currentUrl()).pathname.split("/").filter(Boolean)[0] === prefix;
    } catch {
      return false;
    }
  })();
  if (currentHasScope) return dest;
  try {
    const cur = new URL(browser.currentUrl());
    await browser.goto(cur.origin + "/");
    await browser.wait(2);
    await browser.waitForInteractiveDom?.().catch(() => undefined);
    dest = rebaseHrefOntoCurrentUrl(hrefHint, browser.currentUrl());
    const rebasedHasScope = new URL(browser.currentUrl()).pathname.split("/").filter(Boolean)[0] === prefix;
    if (rebasedHasScope) return dest;
    const candidates = await browser.extractScopedRouteCandidates(prefix).catch(() => []);
    const unique = Array.from(new Set(candidates));
    if (unique.length === 1) {
      return rebaseScopedHrefWithCandidate(hrefHint, browser.currentUrl(), unique[0]!);
    }
    return null;
  } catch {
    return dest;
  }
}

function sameOriginPathAndSearch(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
  } catch {
    return false;
  }
}

async function gotoResolvedHref(browser: BrowserController, dest: string): Promise<void> {
  try {
    await browser.goto(dest);
  } catch (err) {
    if (sameOriginPathAndSearch(browser.currentUrl(), dest)) return;
    throw err;
  }
}

async function attemptCredentialRouteLinkRecovery(
  browser: BrowserController,
  targetUrl: string,
): Promise<boolean> {
  const intent = credentialRouteIntent(targetUrl);
  if (intent === null) return false;
  let notFoundText: string | null = null;
  if (currentUrlLooksLikeCredentialRoute(browser.currentUrl(), intent)) {
    notFoundText = await browser.extractText().catch(() => "");
    if (!pageLooksNotFound(notFoundText)) return false;
  }

  const inventory = await browser.extractInteractiveElements().catch(() => []);
  const candidates = inventory.filter((el) => {
    if (el.tag !== "a" && el.role !== "link" && el.tag !== "button" && el.role !== "button") {
      return false;
    }
    const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
    return intent.label.test(label) || (el.href != null && intent.href.test(el.href));
  });
  if (candidates.length === 0) {
    const text = notFoundText ?? await browser.extractText().catch(() => "");
    if (!pageLooksNotFound(text)) return false;
    let origin: string;
    try {
      origin = new URL(targetUrl).origin;
    } catch {
      return false;
    }
    await gotoResolvedHref(browser, origin).catch(() => undefined);
    await browser.wait(2);
    await browser.waitForInteractiveDom().catch(() => undefined);
    const reboundInventory = await browser.extractInteractiveElements().catch(() => []);
    const reboundCandidates = reboundInventory.filter((el) => {
      if (el.tag !== "a" && el.role !== "link" && el.tag !== "button" && el.role !== "button") {
        return false;
      }
      const label = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
      return intent.label.test(label) || (el.href != null && intent.href.test(el.href));
    });
    if (reboundCandidates.length === 0) return false;
    return clickCredentialNavCandidate(browser, reboundCandidates);
  }
  return clickCredentialNavCandidate(browser, candidates);
}

function pageLooksNotFound(text: string): boolean {
  return /\b(?:page not found|404|not found|does not exist)\b/i.test(text);
}

function credentialRouteIntent(targetUrl: string): { label: RegExp; href: RegExp; kind: "key" | "token" } | null {
  let path: string;
  try {
    path = new URL(targetUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\bkeys?\b|api[-_/]?keys?/.test(path)) {
    return {
      kind: "key",
      label: /\b(?:api\s+keys?|keys?)\b/i,
      href: /(?:api[-_/]?)?keys?/i,
    };
  }
  if (/\btokens?\b|api[-_/]?tokens?/.test(path)) {
    return {
      kind: "token",
      label: /\b(?:api\s+tokens?|tokens?)\b/i,
      href: /(?:api[-_/]?)?tokens?/i,
    };
  }
  return null;
}

function currentUrlLooksLikeCredentialRoute(
  currentUrl: string,
  intent: { kind: "key" | "token" },
): boolean {
  try {
    const path = new URL(currentUrl).pathname.toLowerCase();
    return intent.kind === "key"
      ? /\bkeys?\b|api[-_/]?keys?/.test(path)
      : /\btokens?\b|api[-_/]?tokens?/.test(path);
  } catch {
    return false;
  }
}

function matchesLabelHint(el: InteractiveElement, hint: string): boolean {
  const lowerHint = hint.toLowerCase();
  const label = (el.labelText ?? "").toLowerCase();
  const placeholder = (el.placeholder ?? "").toLowerCase();
  const aria = (el.ariaLabel ?? "").toLowerCase();
  if (label === lowerHint || placeholder === lowerHint || aria === lowerHint) {
    return true;
  }
  // 0.8.3-rc.1 — name/id fallback. See matchesClickHint.
  const name = (el.name ?? "").toLowerCase();
  if (name.length > 0 && name === lowerHint) return true;
  const id = (el.id ?? "").toLowerCase();
  if (id.length > 0 && id === lowerHint && !isRuntimeId(id)) return true;
  return false;
}

const LABEL_STOPWORDS = new Set([
  "your", "the", "for", "and", "please", "enter", "field", "input", "this",
]);

// Fuzzy label match for a fill/select whose captured label_hint is a verbose
// gloss that doesn't exact/substring-match the live control. anthropic's skill
// captured "Name your key:" but the live input is labeled "Name" — the exact
// matcher missed it, the field was wrongly skipped as absent, and the form's
// submit stayed disabled (precondition unmet). Matches on SIGNIFICANT-token
// overlap (len>=3, minus stopwords) between the hint and the element's
// label/placeholder/aria/name — so "Name your key:" overlaps "Name" / "Key
// name" but NOT a "Search" box. Last-resort + unique-match-only (call site),
// so it can't fill the wrong control on a multi-input form.
function significantTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !LABEL_STOPWORDS.has(t),
  );
}
function matchesLabelHintFuzzy(el: InteractiveElement, hint: string): boolean {
  const want = new Set(significantTokens(hint));
  if (want.size === 0) return false;
  const have = significantTokens(
    `${el.labelText ?? ""} ${el.placeholder ?? ""} ${el.ariaLabel ?? ""} ${el.name ?? ""}`,
  );
  return have.some((t) => want.has(t));
}

function isRuntimeId(id: string): boolean {
  // Mirror promote-to-skill.ts:looksLikeRuntimeId. Inline here to keep
  // the replay engine self-contained — the patterns rarely change and
  // a tiny duplication is cheaper than a cross-module dep.
  if (/^react-aria\d+/.test(id)) return true;
  if (/^radix-/.test(id)) return true;
  if (/^base-ui-/.test(id)) return true;
  if (/_r_[a-z0-9]+_?$/i.test(id)) return true;
  return false;
}

// Reject elements that share a labelText with the actual form
// control but aren't themselves a form control. OpenRouter's Name
// modal ships a help-button labeled "Name" next to its #name input;
// both report labelText="Name" so a label-only match returns both
// and the disambiguator's cascade fails ("matched 2"). Includes
// select for the SELECT case which also matches by labelText.
function isFillable(el: InteractiveElement): boolean {
  return el.tag === "input" || el.tag === "textarea" || el.tag === "select";
}

function isSignupSubmitLikeClick(step: Extract<SkillStep, { kind: "click" }>): boolean {
  if (step.role_hint === "link") return false;
  return /\b(?:continue|sign\s*up|register|create\s+(?:account|workspace|organization)|start(?:\s+my)?\s+free\s+trial|submit)\b/i.test(
    step.text_match,
  );
}

async function checkRequiredAgreementBoxesBeforeSubmitClick(
  browser: BrowserController,
  step: Extract<SkillStep, { kind: "click" }>,
): Promise<void> {
  if (!isSignupSubmitLikeClick(step)) return;
  const maybeBrowser = browser as BrowserController & {
    checkRequiredAgreementBoxes?: () => Promise<string[]>;
  };
  if (typeof maybeBrowser.checkRequiredAgreementBoxes !== "function") return;
  await maybeBrowser.checkRequiredAgreementBoxes().catch(() => []);
}

// A `select` step's target is broader than isFillable: MUI/Radix-class
// dropdowns render as a non-input element with role="combobox" (zilliz's
// Job Title is a <div id="mui-component-select-jobTitle" role="combobox">).
// browser.selectOption already drives those (click + pick option from the
// popup — the capture-time path); the replay matcher was the only place
// still requiring a native form tag, which made every MUI select look
// "absent" and get skipped as account-state onboarding (measured live
// 2026-06-11: zilliz replay left Job Title unselected, Continue no-opped,
// and the failure surfaced 5 steps later as a bogus returning-user
// divergence on "API Keys").
function isSelectTarget(el: InteractiveElement): boolean {
  return isFillable(el) || el.role === "combobox";
}

// Locate the verification-code input for an `await_email_code` step.
// OTP inputs are frequently UNLABELED (single-digit boxes, headless
// inputs) — that's exactly why a `fill` step can't carry them — so the
// resolution order is: (1) explicit label_hint when present, (2) an input
// whose attributes name it a code field, (3) the first code-shaped input
// on the page. (3) is safe because this step only runs at the
// verification gate the synthesizer placed it at, where the page is just
// the code input(s) + a Verify button. Returns null when no plausible
// input exists. Exported for unit tests.
export function codeInputCandidates(
  inventory: readonly InteractiveElement[],
): InteractiveElement[] {
  // Code-shaped: a visible text-entry input that is NOT an email/password/
  // checkbox/radio/etc. (type null/"" covers headless OTP boxes).
  const TEXT_ENTRY = new Set(["text", "tel", "number", "", "search"]);
  return inventory.filter(
    (el) =>
      el.tag === "input" &&
      el.visible !== false &&
      (el.type === null || TEXT_ENTRY.has(el.type)) &&
      el.type !== "email" &&
      el.type !== "password",
  );
}

// Post-typing readback for an `await_email_code` step. browser.type relies
// on the widget's auto-advance to distribute digits across multi-box OTP
// inputs; a keystroke that fires during the focus transition is silently
// dropped by the controlled input (React setState hasn't moved focus yet),
// leaving a box empty and the submit button disabled. Re-read the boxes and
// re-type any digit that didn't stick — per-box explicit targeting, so the
// corrective pass has no auto-advance dependency. No-ops when the mapping
// boxes↔digits isn't unambiguous (extra unrelated inputs on the page) or
// when the widget auto-submitted on the last digit (URL changed — the new
// page's inputs are NOT OTP boxes). Exported for unit tests.
export async function fixupOtpDistribution(
  browser: BrowserController,
  code: string,
  otpPageUrl: string,
): Promise<void> {
  // Let the widget's controlled-input state settle before reading back.
  await browser.wait(1);
  if (browser.currentUrl() !== otpPageUrl) return;
  const boxes = codeInputCandidates(await browser.extractInteractiveElements());
  if (boxes.length === 1) {
    // Single combined input: its value should be the whole code.
    if ((boxes[0]!.value ?? "") !== code) {
      await browser.type(boxes[0]!.selector, code);
    }
    return;
  }
  if (boxes.length !== code.length) return;
  for (let i = 0; i < boxes.length; i++) {
    if ((boxes[i]!.value ?? "") === code.charAt(i)) continue;
    console.error(
      `[replay] await_email_code: OTP box ${i + 1}/${boxes.length} holds ` +
        `${JSON.stringify(boxes[i]!.value ?? "")} after auto-advance typing — re-typing it directly.`,
    );
    await browser.type(boxes[i]!.selector, code.charAt(i));
  }
}

export function findCodeInput(
  inventory: readonly InteractiveElement[],
  labelHint?: string,
): InteractiveElement | null {
  const candidates = codeInputCandidates(inventory);
  if (candidates.length === 0) return null;
  if (labelHint !== undefined && labelHint.length > 0) {
    const byLabel = candidates.filter((el) => matchesLabelHint(el, labelHint));
    if (byLabel.length >= 1) return byLabel[0]!;
  }
  // Word-START boundary only (no trailing \b): "verif" must prefix-match
  // "verificationCode" / "verification_code", which a trailing \b would
  // break (it'd require "verif" to be a whole word).
  const codeRe = /\b(code|otp|verif|pin|one[\s-]?time|2fa|mfa)/i;
  const byAttr = candidates.filter((el) =>
    codeRe.test(
      `${el.name ?? ""} ${el.id ?? ""} ${el.placeholder ?? ""} ${el.ariaLabel ?? ""} ${el.labelText ?? ""}`,
    ),
  );
  if (byAttr.length >= 1) return byAttr[0]!;
  return candidates[0]!;
}

// rc.24/rc.25 — cascading fill-target disambiguator. Shared by
// preValidate and executeStep so both arrive at the same input when
// a label matches more than once (OpenRouter's "Name" input ships
// alongside a hidden React Hook Form duplicate). Filters narrow from
// most-to-least informative; the first filter that yields a unique
// winner picks it. Returns null when the cascade exhausts without
// narrowing to one — caller decides whether to fail.
function disambiguateFillMatches(
  matches: InteractiveElement[],
): InteractiveElement | null {
  const filters: Array<(el: InteractiveElement) => boolean> = [
    (el) => el.inViewport === true,
    (el) => el.visible !== false,
    (el) => el.value === "" || el.value === null || el.value === undefined,
    (el) => el.interactedThisRun !== true,
  ];
  let narrowed: InteractiveElement[] = matches;
  for (const f of filters) {
    const next = narrowed.filter(f);
    if (next.length === 1) return next[0]!;
    if (next.length > 0) narrowed = next;
  }
  return null;
}

function matchesRole(el: InteractiveElement, role: "button" | "link" | "tab" | "menuitem"): boolean {
  if (role === "button") return el.tag === "button" || el.role === "button";
  if (role === "link") return el.tag === "a" || el.role === "link";
  return el.role === role;
}

function isCopyButton(el: InteractiveElement): boolean {
  const text = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
  return /^\s*copy(?:\b|\s|$)|copy\s+(?:api\s*key|secret|token|key|to\s+clipboard)\b/i.test(text);
}

function pickClickPriority(matches: InteractiveElement[]): InteractiveElement {
  // When multiple elements still match after role filtering, prefer
  // buttons over links, and earliest DOM order otherwise. This mirrors
  // the bot's findFirstOAuthButton tiebreak.
  const buttons = matches.filter((el) => el.tag === "button");
  if (buttons.length > 0) return buttons[0]!;
  return matches[0]!;
}

// Phase G safety net: scan the visible page for credential-shaped
// strings that aren't in the multi-cred bundle. Diagnostic only —
// caller decides what to do with the report. Best-effort: any failure
// returns an empty string so the caller's primary failure message
// still surfaces.
async function sweepUnclaimedCandidates(
  browser: BrowserController,
  claimed: Record<string, string>,
): Promise<string> {
  const claimedValues = new Set(Object.values(claimed));
  const candidates = await browser.extractCredentialCandidates();
  const unclaimed: string[] = [];
  for (const candidate of candidates) {
    const hit = extractApiKeyFromText(candidate);
    if (hit === null) continue;
    if (claimedValues.has(hit)) continue;
    if (isTruncatedCapture(candidate, hit)) continue;
    // Mask the middle: an operator triaging a failure reason doesn't
    // need the full credential — just enough to recognize what shape
    // was visible. Prefix + suffix preserves the prefix-based pattern
    // signal (sk-or-v1-, sk-ant-, etc.) without leaking the secret.
    unclaimed.push(maskCredential(hit));
  }
  if (unclaimed.length === 0) {
    return "Phase G sweep: no unclaimed credential-shaped strings found on page.";
  }
  return (
    `Phase G sweep: ${unclaimed.length} credential-shaped string(s) visible on the page ` +
    `that the named extracts did NOT claim — possible planner miss: [${unclaimed.join(", ")}]`
  );
}

function maskCredential(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 4)}***`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function substituteTemplate(template: string, values: Record<string, string>): string {
  // ${TOKEN_NAME} → values["TOKEN_NAME"], left literal if missing.
  // No nested substitution, no escaping — templates in skills are
  // limited to the names listed in the schema's value_template docs.
  return template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

// ── Mode helpers ────────────────────────────────────────────────────

function isExtractStep(step: SkillStep): boolean {
  return (
    step.kind === "extract_via_copy_button" ||
    step.kind === "extract_via_regex" ||
    step.kind === "extract_via_copy_button_named" ||
    step.kind === "extract_via_regex_named"
  );
}

// Index of the credential-creating click: the LAST click (plain or
// OAuth) before the FIRST extract step. This is the load-bearing click
// — the one that mints the token the extract then reads. Returns null
// when there is no extract step, or no click precedes it. Used both by
// the dry-mode cutoff and by the absent-click skip gate (the gate must
// NEVER skip this click, since skipping it would silently bypass
// credential creation and let a hollow replay report success).
function creditCreatingClickIndex(steps: SkillStep[]): number | null {
  for (let i = 0; i < steps.length; i++) {
    if (!isExtractStep(steps[i]!)) continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = steps[j]!;
      if (prev.kind === "click" || prev.kind === "click_oauth_button") {
        return j;
      }
    }
    return null;
  }
  return null;
}

function computeDryStopIndex(steps: SkillStep[]): number {
  // Dry mode stops at the credential-creating click — pre-validates it
  // (confirms the button is on the page), but does not execute it. If
  // the skill has no extract step (shouldn't happen — synthesizer
  // rejects), we walk everything.
  //
  // Single-credential assumption (0.7.0): only the FIRST extract step
  // determines the dry-mode cutoff. Multi-credential skills (0.8.0,
  // Stripe-class) will introduce later extract steps after additional
  // credential-creating clicks; preValidateAllExtractsInDryMode()
  // catches breakage on those even though dry mode itself stops at
  // the first cutoff. When multi-credential support lands, this
  // function should return the cutoff for the LAST extract (so dry
  // mode walks far enough to validate every credential path) — but
  // that's an explicit redesign, not a drop-in change.
  const clickIdx = creditCreatingClickIndex(steps);
  if (clickIdx !== null) return clickIdx;
  // No click before the first extract — stop at the extract itself.
  const firstExtract = steps.findIndex(isExtractStep);
  return firstExtract === -1 ? steps.length : firstExtract;
}

// Absent-click skip gate (the "account-state-dependent setup step"
// class). A captured `click` step can target a button that only
// existed in the EXACT account state of the original signup — e.g.
// hookdeck's first-time-account "Create Project" setup button, which
// is simply not on the page when replay runs against a fresh or
// already-set-up account. Pre-validation returns "No element matches
// text_match=…" and, with no LLM substitute, the whole replay
// hard-fails — even though the credential is still reachable.
//
// When the target is COMPLETELY ABSENT (zero text_match matches in the
// inventory), treat the click as an optional setup step and continue.
// Safety rails, so we never mask real breakage:
//
//   - Only the `click` kind (not click_oauth_button — a missing OAuth
//     button is a genuine auth wall, handled by the needs_login path).
//   - Only true absence (matchCount === 0). An ambiguous match (>1) or
//     a role-filter-only miss means the element IS on the page but the
//     skill can't pin it — that is real rot, still a hard failure.
//   - NEVER the credential-creating click (last click before the first
//     extract). Skipping that would bypass token creation and let a
//     hollow replay report success against a stale page.
//   - ONLY when a credential-creating click actually exists downstream.
//     If the skill has no extract-anchored click at all, there's no
//     credential path to protect and the click may be the only
//     meaningful action — skipping is unsafe, so we don't.
function isSkippableAbsentClick(
  step: SkillStep,
  stepIndex: number,
  matchCount: number,
  steps: SkillStep[],
): boolean {
  if (step.kind !== "click") return false;
  if (matchCount !== 0) return false; // present-but-ambiguous = real rot
  // Never skip the credential-creating click itself.
  if (stepIndex === creditCreatingClickIndex(steps)) return false;
  // Only skip if the recipe can still reach a credential afterwards. (Was
  // gated on creditCreatingClickIndex !== null, which missed extract-via-
  // copy recipes like deepinfra whose "Finish Sign Up" is an onboarding
  // click with no create-key click.)
  return hasLaterCredentialStep(steps, stepIndex);
}

function isReturningUserOnboardingDismissClick(
  step: SkillStep,
  stepIndex: number,
  steps: SkillStep[],
): boolean {
  if (step.kind !== "click") return false;
  if (!hasLaterCredentialStep(steps, stepIndex)) return false;
  return /\b(?:no thanks|explore at my own pace|skip(?: for now)?|maybe later|not now)\b/i.test(
    step.text_match,
  );
}

// Tag a step_failed reason when it fires AFTER we skipped an absent onboarding
// fill — the operator account is already registered, so the credential step
// diverged from the fresh-signup capture. The verifier matches this marker
// (failure-taxonomy isReturningUserDivergence) and downgrades the kind off the
// rot/demote path. Without the skip, the reason is returned verbatim — a
// genuine stale selector on a fresh account still counts as rot.
function markReturningUser(reason: string, divergent: boolean): string {
  if (!divergent) return reason;
  return `${reason} [returning-user: authenticated session diverged from fresh-signup capture (onboarding/nav element absent — not rot)]`;
}

// True when the current page is an authenticated returning-user app shell — used
// to decide whether an ABSENT OAuth-button step is a returning-user login-head
// skip (account already exists → no provider button) vs genuine rot. Reuses the
// live bot's detectAlreadySignedIn, which is conservative: it returns FALSE if
// any login chooser ("Continue with Google", bare "Sign up"/"Log in") or a
// credential input is visible, so a genuinely-rotted provider button on a real
// login page still fails. A short settle first — the OAuth step is usually step
// 0/1 right after goto(signup_url), so the returning-user dashboard may still be
// painting.
async function looksAuthenticatedReturningUser(browser: BrowserController): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const inventory = await browser.extractInteractiveElements();
    if (detectAlreadySignedIn({ inventory, url: browser.currentUrl() })) return true;
    // A login chooser IS present (or nothing yet) → not a returning-user skip.
    // Give a painting dashboard one short beat, then re-check; bail fast
    // otherwise so a true login page doesn't cost three waits.
    const hasChooser = inventory.some((e) =>
      /continue with|sign ?in with|log ?in with|sign ?up/i.test(
        `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`,
      ),
    );
    if (hasChooser) return false;
    await browser.wait(2);
  }
  return false;
}

// True when an absent onboarding FILL is safe to skip: the input is wholly
// absent — the verifier's operator account is already registered, so the
// service skips the signup form (cohere/deepinfra "First name" class) — and
// a later step still yields a credential. preValidateStep reports an absent
// input as "No input matches…"; a present-but-unresolvable input is genuine
// rot and must NOT skip. The credential validator at the extract step is the
// real backstop, so skipping here can't turn a broken recipe into a pass.
function isSkippableAbsentFill(
  step: SkillStep,
  validationReason: string,
  stepIndex: number,
  steps: SkillStep[],
): boolean {
  if (step.kind !== "fill") return false;
  if (!/no input matches/i.test(validationReason)) return false;
  // EMAIL_ALIAS fills are not optional onboarding cosmetics; they dispatch the
  // verification email that an await_email_code step consumes. Skipping them
  // turns a real replay failure into a misleading returning-user branch and
  // strands fresh-identity verification waiting for an email that was never
  // requested.
  if (step.value_template.includes("${EMAIL_ALIAS}")) return false;
  return hasLaterCredentialStep(steps, stepIndex);
}

// True when an absent onboarding SELECT is safe to skip — the <select> dropdown
// equivalent of isSkippableAbsentFill. Wizard selects (porter "Role", railway
// "Workspace") only exist for a brand-new account; on a returning-user replay
// the onboarding form is gone and preValidateStep reports "No select matches…".
// A present-but-unresolvable select is genuine rot and must NOT skip; only a
// wholly-absent one is skippable, and only when a later step still yields a
// credential (the validator at the extract step is the real backstop).
function isSkippableAbsentSelect(
  step: SkillStep,
  validationReason: string,
  stepIndex: number,
  steps: SkillStep[],
): boolean {
  if (step.kind !== "select") return false;
  if (!/no select matches/i.test(validationReason)) return false;
  return hasLaterCredentialStep(steps, stepIndex);
}

// Does the recipe still reach a credential after stepIndex — a later
// extract step, or the credential-creating click still ahead?
function hasLaterCredentialStep(steps: SkillStep[], stepIndex: number): boolean {
  for (let j = stepIndex + 1; j < steps.length; j++) {
    const k = steps[j]!.kind;
    if (
      k === "extract_via_copy_button" ||
      k === "extract_via_regex" ||
      k === "extract_via_copy_button_named" ||
      k === "extract_via_regex_named" ||
      k === "extract_labeled"
    ) {
      return true;
    }
  }
  const credClickIdx = creditCreatingClickIndex(steps);
  return credClickIdx !== null && credClickIdx > stepIndex;
}

// Count how many inventory elements a click step's text_match resolves
// to BEFORE role/near-text narrowing. Zero means the target is wholly
// absent from the page (the skip-gate case); a positive count means the
// element exists but the skill can't uniquely pin it (real rot).
async function countClickMatches(
  step: Extract<SkillStep, { kind: "click" }>,
  browser: BrowserController,
): Promise<number> {
  const inventory = await browser.extractInteractiveElements();
  return inventory.filter((el) => matchesClickHint(el, step.text_match)).length;
}

// Dry-mode safety net for multi-credential skills (0.8.0). The main
// loop only pre-validates the extract step at dryStopAt; any later
// extract step (additional credential on a Stripe-class page) goes
// unchecked. This sweep runs preValidateStep against every extract
// step's selectors so a broken Copy-button hint on credential 2 of 3
// still surfaces as a dry-mode failure rather than slipping through
// to full mode. Returns the index of the first extract that failed,
// or null if all pass / there are no later extracts.
async function preValidateAllExtractsInDryMode(
  steps: SkillStep[],
  dryStopAt: number,
  browser: BrowserController,
  templateValues: Record<string, string>,
): Promise<{ stepIndex: number; reason: string } | null> {
  for (let i = dryStopAt + 1; i < steps.length; i++) {
    const step = steps[i]!;
    if (
      step.kind !== "extract_via_copy_button" &&
      step.kind !== "extract_via_regex" &&
      step.kind !== "extract_via_copy_button_named" &&
      step.kind !== "extract_via_regex_named"
    ) {
      continue;
    }
    const validation = await preValidateStep(step, browser, templateValues);
    if (!validation.ok) {
      return { stepIndex: i, reason: validation.reason };
    }
  }
  return null;
}

// ── URL-drift detection (0.8.2-rc.22) ────────────────────────────────

// Patterns that indicate the bot landed on a login/auth page instead
// of the expected target. Catches:
//   - same-domain redirects to /login, /signin, /signup, /auth/*
//   - cross-domain redirects to known OAuth providers
//   - Railway's specific /login pattern
// False-positive risk is low: signup pages with "/login" in the path
// are rare and usually intentional (e.g., the form lives at the
// `signup_url` itself), so a redirect that ends up on a path matching
// these patterns is overwhelmingly a real auth wall.
const LOGIN_PATH_RE = /\/(login|signin|sign[-_]in|auth|sso)(?:[/?#]|$)/i;
const OAUTH_PROVIDER_HOSTS = new Set([
  "accounts.google.com",
  "github.com",
  "auth0.com",
  "login.microsoftonline.com",
]);
const IDENTITY_PROVIDER_DOMAINS = [
  "google.com",
  "github.com",
  "microsoftonline.com",
  "appleid.apple.com",
  "facebook.com",
  "okta.com",
  "auth0.com",
] as const;
const EPHEMERAL_REPLAY_URL_PARAM =
  /^(psid|sid|session|session_id|sessionid|token|access_token|auth|state|code|redirect_to|continue|ticket|nonce|email|signup_email|user_email)$/i;

// A service's OWN auth/login host — the FIRST hop when the replay session has
// expired (porter's dashboard.porter.run → auth.porter.run). Distinct from
// OAUTH_PROVIDER_HOSTS (the social IdPs): this is the service bouncing us to
// log in, not the IdP handshake. Matches an auth-shaped subdomain
// (auth./login./accounts./signin./sso./id.) or a hosted-auth vendor
// (WorkOS/Auth0/Okta/Clerk/Stytch). Without this, detectNavigationDrift
// returned null for auth.porter.run, so replay marched through its steps ON
// the login page and failed at the cred-click with a misleading "nav
// divergence" reason instead of the real cause (session not present).
function looksLikeAuthHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (/^(auth|login|accounts|signin|sign-in|sso|id)\./.test(h)) return true;
  return /(^|\.)(workos|auth0|okta|clerk|stytch|onelogin|duosecurity)\.(com|io|dev|app)$/.test(h);
}

function isIdentityProviderEntryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return IDENTITY_PROVIDER_DOMAINS.some(
      (idp) => host === idp || host.endsWith(`.${idp}`),
    );
  } catch {
    return false;
  }
}

function isAuthTransactionEntryUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (path.includes("/auth/cx/")) return true;
    if (path.includes("/oauth/callback") || path.includes("/auth/callback")) return true;
    if (path.includes("/login/callback") || path.includes("/sso/callback")) return true;
    if (path.includes("/register/create-user-new-org-confirmation")) return true;
    if (path.endsWith("/confirmation") || path.endsWith("/confirm") || path.endsWith("/reserved")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function cleanReplayEntryUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (EPHEMERAL_REPLAY_URL_PARAM.test(key)) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

function isPoisonedReplayEntryUrl(url: string): boolean {
  return isIdentityProviderEntryUrl(url) || isAuthTransactionEntryUrl(url);
}

function isStableReplayNavigateUrl(url: string): boolean {
  return !isPoisonedReplayEntryUrl(url);
}

function kindeNeutralAdminUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname === "app.kinde.com" && u.pathname.includes("/auth/cx/")
      ? "https://app.kinde.com/admin"
      : null;
  } catch {
    return null;
  }
}

export function resolveReplayRecoveryEntryUrl(skill: Skill): string {
  const cleanedSignupUrl = cleanReplayEntryUrl(skill.signup_url);
  const kindeNeutral = kindeNeutralAdminUrl(cleanedSignupUrl);
  if (kindeNeutral !== null) return kindeNeutral;
  if (!isPoisonedReplayEntryUrl(cleanedSignupUrl)) return cleanedSignupUrl;
  const stableNavigate = skill.steps.find(
    (step) => step.kind === "navigate" && isStableReplayNavigateUrl(step.url),
  );
  return stableNavigate?.kind === "navigate"
    ? cleanReplayEntryUrl(stableNavigate.url)
    : cleanedSignupUrl;
}

export function resolveReplayRecoveryTargetUrl(skill: Skill, targetUrl: string): string {
  const cleanedTargetUrl = cleanReplayEntryUrl(targetUrl);
  const kindeNeutral = kindeNeutralAdminUrl(cleanedTargetUrl);
  if (kindeNeutral !== null) return kindeNeutral;
  return isPoisonedReplayEntryUrl(cleanedTargetUrl)
    ? resolveReplayRecoveryEntryUrl(skill)
    : cleanedTargetUrl;
}

// Returns null when the current URL is consistent with the requested
// URL (same origin, no login-path redirect). Returns a short reason
// string when drift is detected. Exported for unit tests.
export function detectNavigationDrift(
  currentUrl: string,
  expectedUrl: string,
): string | null {
  let cur: URL;
  let exp: URL;
  try {
    cur = new URL(currentUrl);
    exp = new URL(expectedUrl);
  } catch {
    // If either URL is unparseable, don't claim drift — the caller's
    // next step will fail with a clearer error.
    return null;
  }
  // Cross-domain landing on a known OAuth provider — unambiguous.
  if (
    cur.hostname !== exp.hostname &&
    OAUTH_PROVIDER_HOSTS.has(cur.hostname)
  ) {
    return `redirected to OAuth provider ${cur.hostname}`;
  }
  // Cross-domain landing on the service's OWN auth host (auth.porter.run,
  // a WorkOS/Auth0/etc. tenant) — the session expired, so we got bounced to
  // log in. Classify as drift so attemptOAuthRecovery can re-auth via the
  // cached provider session (or, failing that, return needs_login) instead of
  // replaying the skill onto the login page.
  if (cur.hostname !== exp.hostname && looksLikeAuthHost(cur.hostname)) {
    return `redirected to login host ${cur.hostname} (session expired / not authenticated)`;
  }
  // Same-origin redirect to a login-shaped path — covers Railway's
  // /login fallback when /account/tokens is hit unauthenticated.
  if (cur.hostname === exp.hostname && cur.pathname !== exp.pathname) {
    if (LOGIN_PATH_RE.test(cur.pathname)) {
      return `same-origin redirect to login path ${cur.pathname}`;
    }
  }
  return null;
}

// Registrable domain (eTLD+1 approximation): the last two dot-labels. Good
// enough for the single-label TLDs these services use (kinde.com, algolia.com,
// weaviate.cloud). NOT public-suffix-aware — it would treat foo.co.uk as co.uk,
// but no target service uses a multi-label TLD. Exported for tests.
export function registrableDomain(hostname: string): string {
  const parts = hostname.split(".").filter((p) => p.length > 0);
  if (parts.length <= 2) return hostname.toLowerCase();
  return parts.slice(-2).join(".").toLowerCase();
}

// Rebase a captured URL onto the live session's per-account subdomain. Services
// like kinde give every account its own subdomain (tsq688378.kinde.com); a
// skill captured under one account bakes that subdomain into its deep-nav URLs,
// so on replay (a different account → different subdomain) the navigate would
// hit the WRONG account. When the captured host and the live host share a
// registrable domain but differ — i.e. it's a per-account subdomain — rewrite
// the captured URL's host to the live one. Unchanged otherwise (same account,
// different product, or no live host yet). Exported for tests.
export function rebaseSubdomain(capturedUrl: string, liveUrl: string): string {
  let cap: URL;
  let live: URL;
  try {
    cap = new URL(capturedUrl);
    live = new URL(liveUrl);
  } catch {
    return capturedUrl;
  }
  if (cap.hostname === live.hostname) return capturedUrl;
  if (registrableDomain(cap.hostname) !== registrableDomain(live.hostname)) return capturedUrl;
  cap.hostname = live.hostname;
  return cap.toString();
}

export function normalizeKindeReplayNavigateUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".kinde.com")) return url;
    if (u.pathname === "/admin/settings/apis") {
      u.pathname = "/admin";
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// True when the URL is back on the product host AND no longer on an auth
// intermediary — i.e. a same-domain hosted login (weaviate's
// console.weaviate.cloud/signin?code=…) has finished exchanging its code and
// redirected to the real app. Compares by registrable domain so a per-account
// subdomain redirect (kinde's app.kinde.com → tsqNNN.kinde.com) still settles.
// Used to gate OAuth-recovery success so we don't re-navigate mid-handshake.
// Exported for tests.
export function settledOnProductPage(currentUrl: string, expectedHost: string): boolean {
  let u: URL;
  try {
    u = new URL(currentUrl);
  } catch {
    return false;
  }
  if (registrableDomain(u.hostname) !== registrableDomain(expectedHost)) return false;
  // Still on the service's own login/handoff path, or carrying an unconsumed
  // OAuth-callback param → the session isn't established yet.
  if (LOGIN_PATH_RE.test(u.pathname)) return false;
  if (u.searchParams.has("code") || u.searchParams.has("state")) return false;
  return true;
}

// A path segment that's an account/run-specific opaque resource id — a UUID, a
// long hex blob, or an uppercase-alphanumeric id like algolia's app id
// (86WV27C86H). A captured URL bearing one points at the ORIGINAL account's
// resource on replay. Exported for tests.
export function pathHasOpaqueResourceId(path: string): boolean {
  return path.split("/").some((seg) => {
    if (seg.length < 8) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
    if (/^[0-9a-f]{16,}$/i.test(seg)) return true; // long hex blob
    // uppercase-heavy alphanumeric id (algolia app id): has a digit, no
    // lowercase, ≥8 chars — distinguishes an opaque id from a route slug.
    if (/^[A-Z0-9]{8,}$/.test(seg) && /[0-9]/.test(seg)) return true;
    return false;
  });
}

// Re-enter at the product's host root so a logged-in service redirects to the
// CURRENT account's resource (instead of the captured account's). Returns true
// when it re-navigated (the caller should re-extract). No-op when the URL has
// no opaque resource id, so it can't perturb normal extracts.
async function reEnterAtAccountRoot(browser: BrowserController): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(browser.currentUrl());
  } catch {
    return false;
  }
  if (!pathHasOpaqueResourceId(u.pathname)) return false;
  await browser.goto(`${u.protocol}//${u.host}/`);
  await browser.wait(2);
  return true;
}

export function inferProviderFromUrl(url: string): "google" | "github" | null {
  try {
    const u = new URL(url);
    if (/^(?:.+\.)?google\.com$/i.test(u.hostname)) return "google";
    if (/^(?:.+\.)?github\.com$/i.test(u.hostname)) return "github";
  } catch {
    /* ignore */
  }
  return null;
}

// ── OAuth recovery during replay (0.8.2-rc.22) ───────────────────────

// When a navigate step lands on a login page (URL drift detected),
// the replay engine attempts to drive the OAuth handshake using the
// bot's persistent profile's cached session cookies. This is the
// non-failing path for skills captured against authenticated services
// — Railway, Sentry, Anthropic, etc. — whose synthesizer didn't emit
// an explicit `click_oauth_button` step because the original signup
// rode an existing browser session.
//
// Recovery succeeds (returns ok) when:
//   - the current page has an OAuth button matching one of the
//     profile's logged-in providers
//   - clicking the button + waiting for the round-trip leaves the
//     bot back on the expected service domain
//   - re-navigating to the expected URL doesn't drift again
//
// Otherwise returns needs_login with the best-guess provider so the
// caller surfaces a real "give the user a way to log in" signal.
//
// Cookie-driven OAuth typically completes in 2-5s end-to-end (provider
// auto-approves from the cached session). 30s budget covers slower
// providers + the rare "show the account chooser" interstitial. If the
// provider demands real user interaction (2FA challenge, missing-scope
// consent), the budget will tick down without resolution and we bail
// to needs_login — that's the "laws of physics" boundary: a verifier
// process running without a human can't complete a challenge.
// The underlying Playwright page (same cast the agent uses). The verify
// path drives a few deterministic clicks the high-level API doesn't expose.
function pageOf(browser: BrowserController): Page | null {
  return (browser as unknown as { page: Page | null }).page ?? null;
}

// Click the Google "Choose an account" card. Deterministic — mirrors the
// agent's tryClickGoogleChooserCard.
async function clickGoogleChooserCard(browser: BrowserController): Promise<boolean> {
  const page = pageOf(browser);
  if (page === null) return false;
  for (const sel of ['[data-identifier]:visible', '[role="link"]:has-text("@")', 'div[jsaction]:has-text("@")']) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: 2000 });
      await loc.click({ timeout: 3000 });
      return true;
    } catch {
      /* try the next selector */
    }
  }
  return false;
}

// Click a consent "Continue / Allow / Authorize" affordance (Google +
// GitHub render these as a button or link). Deterministic.
async function clickConsentAffordance(browser: BrowserController): Promise<boolean> {
  const page = pageOf(browser);
  if (page === null) return false;
  // Exact-name match first (safest): the approve control's accessible name IS
  // just the verb.
  const exact = /^(continue|allow|authorize|approve|accept|agree|i agree)$/i;
  for (const role of ["button", "link"] as const) {
    try {
      const loc = page.getByRole(role, { name: exact }).first();
      await loc.waitFor({ state: "visible", timeout: 3000 });
      await loc.click({ timeout: 3000 });
      return true;
    } catch {
      /* try the next role */
    }
  }
  // Fallback: Google's modern consent button carries extra accessible-name
  // text ("Continue", "Continue to kinde", a nested span) that the exact match
  // misses — so kinde/imagekit reached state=consent but this returned false
  // and the verifier bailed needs_login. Match an approve verb at the START of
  // the name, and explicitly skip negatives ("Cancel", "Don't allow", "Back").
  const approve = /^(continue|allow|authorize|approve|accept|agree)/i;
  const negative = /(cancel|deny|don'?t\s*allow|no\s*thanks|go\s*back|^back$|reject)/i;
  for (const role of ["button", "link"] as const) {
    const loc = page.getByRole(role, { name: approve });
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      const txt = ((await el.textContent().catch(() => "")) ?? "").trim();
      if (negative.test(txt)) continue;
      try {
        await el.waitFor({ state: "visible", timeout: 2000 });
        await el.click({ timeout: 3000 });
        return true;
      } catch {
        /* next candidate */
      }
    }
  }
  if (process.env.REPLAY_DEBUG) {
    try {
      const btns = await page
        .getByRole("button")
        .all()
        .then((ls) =>
          Promise.all(ls.slice(0, 25).map((l) => l.textContent().catch(() => ""))),
        )
        .catch(() => []);
      writeFileSync(
        `/tmp/replay-consent-buttons.txt`,
        `url=${page.url()}\nbuttons=${JSON.stringify(btns)}`,
      );
      console.error(`[replay-oauth-debug] consent affordance not found — dumped /tmp/replay-consent-buttons.txt`);
    } catch {
      /* best-effort */
    }
  }
  return false;
}

// Deterministically walk the provider's account-chooser + consent screens
// after the OAuth affordance is clicked, so a VERIFY replay can complete
// the handshake WITHOUT an LLM. Reuses the canonical classifiers
// (oauth-providers) + scope-gate (google-login). It rides the session the
// operator already established via `mcp login` — it does NOT log in.
// Aborts to needs_login on a real challenge (2FA / verify-it's-you) or a
// sensitive (non-basic) scope grant — both genuinely need a human.
export async function walkOAuthConsent(
  browser: BrowserController,
  providerId: OAuthProviderId,
  driveOAuthLogin?: (provider: OAuthProviderId) => Promise<boolean>,
): Promise<"ok" | "needs_login"> {
  const provider = OAUTH_PROVIDERS[providerId];
  const MAX_NAV = 6;
  // Bound the inline-login drive to ONE attempt — a credential that doesn't
  // clear the identifier/challenge after a full type-through is a real wall
  // (wrong password, 2SV the verifier can't satisfy), and re-driving would just
  // burn MAX_NAV iterations re-typing into the same dead form.
  let loginDriven = false;
  // When the provider supports an inline login drive, the identifier page is
  // recoverable, not terminal: try the credential type-through before bailing.
  const tryDriveLogin = async (): Promise<boolean> => {
    if (driveOAuthLogin === undefined || loginDriven) return false;
    loginDriven = true;
    console.error(`[replay-oauth] ${providerId} login page — driving inline sign-in`);
    const ok = await driveOAuthLogin(providerId).catch(() => false);
    console.error(`[replay-oauth] inline sign-in ${ok ? "progressed" : "did not clear the login page"}`);
    return ok;
  };
  for (let i = 0; i < MAX_NAV; i++) {
    if (browser.oauthPageClosed()) return "ok"; // popup closed → back on service
    const url = browser.currentUrl();
    let body: string;
    try {
      body = (await browser.extractText()).slice(0, 4000);
    } catch {
      await browser.wait(1); // mid-navigation between provider screens
      continue;
    }
    // Account chooser is a PICKER, not a consent — click the card.
    if (providerId === "google" && /\/(?:accountchooser|chooseaccount|oauthchooseaccount)/i.test(url)) {
      const clicked = await clickGoogleChooserCard(browser);
      // The card click works, but the navigation off the chooser takes a
      // beat. Re-reading the URL too soon re-matches the chooser and
      // re-clicks → a no-op loop (cohere burned all 6 iterations this way).
      // Wait for the URL to actually leave the chooser before continuing.
      if (clicked) {
        for (
          let w = 0;
          w < 8 && /\/(?:accountchooser|chooseaccount|oauthchooseaccount)/i.test(browser.currentUrl());
          w++
        ) {
          await browser.wait(1);
        }
      } else {
        await browser.wait(2);
      }
      console.error(
        `[replay-oauth] account chooser — ${clicked ? "clicked card" : "no card found"} → ${browser.currentUrl().slice(0, 70)}`,
      );
      continue;
    }
    if (providerId === "google" && /\/signin\/identifier\b/i.test(url)) {
      if (await tryDriveLogin()) continue;
      console.error(`[replay-oauth] google identifier page — needs_login`);
      return "needs_login";
    }
    const state = provider.classifyAuthState(url, body);
    console.error(`[replay-oauth] state=${state} url=${url.slice(0, 100)}`);
    if (state === "not_provider") return "ok"; // flow left the provider
    if (state === "challenge" || state === "needs_login") {
      // A password/identifier screen is recoverable when we hold the
      // credential — drive the sign-in once before treating it as terminal.
      // (A genuine 2SV/verify-it's-you challenge won't clear and falls through.)
      if (await tryDriveLogin()) continue;
      if (process.env.REPLAY_DEBUG) {
        try {
          writeFileSync(
            `/tmp/replay-oauth-${providerId}-${state}.txt`,
            `url=${url}\n\n${body}`,
          );
          console.error(`[replay-oauth-debug] dumped /tmp/replay-oauth-${providerId}-${state}.txt`);
        } catch {
          // best-effort
        }
      }
      return "needs_login";
    }
    // state === "consent": scope-gate it. Only auto-approve identity-basic
    // scopes — verify must never grant a sensitive scope blind.
    const scopes = extractOAuthScopes(url);
    // GitHub sensitive-scope phrases — repo/org/write/admin access. A consent
    // showing NONE is identity-basic (login). pusher's 2nd github consent
    // screen carries no scope= param (extractOAuthScopes → null), so without a
    // DOM fallback github fell straight to "not basic" and bailed.
    const githubSensitive =
      /\b(repositor|organization|act on your behalf|write|delete|admin|workflow|manage|gist|webhook|deploy)/i.test(
        body,
      );
    const basic =
      scopes !== null
        ? provider.scopesAreBasic(scopes)
        : // Scopes unreadable from the URL → fall back to the visible DOM.
          // Basic only when NO scope-grant phrases show (mirrors per-provider).
          providerId === "google"
          ? scrapeGoogleScopePhrases(body).length === 0
          : providerId === "github"
            ? !githubSensitive
            : false;
    if (!basic) {
      console.error("[replay-oauth] consent scopes not basic/unreadable — needs_login");
      return "needs_login";
    }
    const beforeUrl = browser.currentUrl();
    const clicked = await clickConsentAffordance(browser);
    if (!clicked) {
      // The consent may be auto-completing and navigating away before we can
      // click — Google's GIS flow (kinde/imagekit) redirects the consent to
      // /gsi/transform on its own for basic, previously-seen scopes, and the
      // popup then closes. Don't bail needs_login on a flow that's finishing:
      // wait a beat, then let the loop re-evaluate (oauthPageClosed /
      // not_provider → ok). If it's genuinely stuck on the consent, the loop
      // retries the click, bounded by MAX_NAV before the final needs_login.
      for (let w = 0; w < 6 && browser.currentUrl() === beforeUrl && !browser.oauthPageClosed(); w++) {
        await browser.wait(1);
      }
      continue;
    }
    // Same race as the chooser: the approve click navigates after a beat.
    // Wait for the URL to move before re-reading, or the next pass sees the
    // same consent URL, finds the affordance already consumed, and bails.
    for (let w = 0; w < 8 && browser.currentUrl() === beforeUrl && !browser.oauthPageClosed(); w++) {
      await browser.wait(1);
    }
    console.error(`[replay-oauth] consent (basic) — approved → ${browser.currentUrl().slice(0, 70)}`);
  }
  return browser.oauthPageClosed() ? "ok" : "needs_login";
}

async function clickGenericAuthBrokerButton(
  browser: BrowserController,
  inventory: InteractiveElement[],
): Promise<boolean> {
  const hasPasswordInput = inventory.some(
    (el) => isFillable(el) && (el.type === "password" || matchesLabelHint(el, "password")),
  );
  const hasEmailInput = inventory.some((el) => isFillable(el) && matchesLabelHint(el, "email"));
  if (hasPasswordInput || hasEmailInput) return false;
  const candidates = inventory.filter((el) => {
    if (!(el.visible && (el.tag === "button" || el.role === "button" || el.tag === "a"))) return false;
    const text = (el.visibleText ?? el.ariaLabel ?? "").trim();
    return /^(sign in|log in|login|continue)$/i.test(text);
  });
  if (candidates.length !== 1) return false;
  await browser.click(candidates[0]!.selector);
  return true;
}

async function attemptOAuthRecovery(
  browser: BrowserController,
  expectedUrl: string,
  profileDir?: string,
  preferredProvider?: OAuthProviderId,
): Promise<
  { kind: "ok" } | { kind: "needs_login"; provider: OAuthProviderId }
> {
  const rawProfiles = loggedInProviders(profileDir);
  // Do not treat the marker as authoritative. The fleet warmer can leave a
  // real Google session in the Chrome profile without writing the local marker
  // (or after the marker was pruned during robot rotation). The OAuth walker
  // is the real truth: if Google shows an identifier/password page it returns
  // needs_login; if it shows an account chooser/consent it can proceed.
  const rawOrDefaultProfiles =
    rawProfiles.length > 0
      ? preferredProvider !== undefined && !rawProfiles.includes(preferredProvider)
        ? [preferredProvider, ...rawProfiles]
        : rawProfiles
      : preferredProvider !== undefined
        ? [preferredProvider]
        : ["google" as const];
  // Prefer Google over GitHub when a service offers both. GitHub OAuth
  // callbacks are rejected by more anti-bot services (pusher bounces a
  // github sign-in back to /accounts/sign_in with no session, while the
  // google round-trip completes). Try the more-reliable provider first.
  const profiles = [...rawOrDefaultProfiles].sort((a, b) => {
    if (preferredProvider !== undefined) {
      if (a === preferredProvider) return -1;
      if (b === preferredProvider) return 1;
    }
    return a === "google" ? -1 : b === "google" ? 1 : 0;
  });
  // Find an OAuth button matching a provider we have a cached session for.
  // Retry: SPA login pages (posthog, kinde) render the OAuth buttons a beat
  // after domcontentloaded, so a single inventory races them → false
  // "no button" needs_login. Re-inventory a few times before giving up.
  let pickedProvider: OAuthProviderId | null = null;
  let pickedButton: ReturnType<typeof findOAuthButton> | null = null;
  let brokerClicked = false;
  let retriedExpectedUrl = false;
  for (let attempt = 0; attempt < 6 && pickedButton === null; attempt++) {
    if (attempt > 0) await browser.wait(2);
    const inventory = await browser.extractInteractiveElements();
    for (const p of profiles) {
      const btn = findOAuthButton(inventory, p);
      if (btn !== null) {
        pickedProvider = p;
        pickedButton = btn;
        break;
      }
    }
    if (pickedButton === null && rawProfiles.length === 0) {
      for (const p of ["google", "github"] as const) {
        const btn = findOAuthButton(inventory, p);
        if (btn !== null) {
          pickedProvider = p;
          pickedButton = btn;
          break;
        }
      }
    }
    if (pickedButton === null && !brokerClicked && (await clickGenericAuthBrokerButton(browser, inventory))) {
      brokerClicked = true;
      await browser.wait(2);
      await browser.waitForInteractiveDom().catch(() => undefined);
    }
    if (
      pickedButton === null &&
      !retriedExpectedUrl &&
      browser.currentUrl() !== expectedUrl
    ) {
      retriedExpectedUrl = true;
      await browser.goto(expectedUrl);
      await browser.wait(2);
      await browser.waitForInteractiveDom().catch(() => undefined);
    }
  }
  if (pickedProvider === null || pickedButton === null) {
    // The page may genuinely be a non-OAuth login form (some services
    // also offer password auth). The replay can't synthesize a
    // password; surface needs_login with a guess based on the URL.
    if (process.env.REPLAY_DEBUG) {
      try {
        const inv = await browser.extractInteractiveElements();
        const clickable = inv
          .filter((e) => e.visible && (e.tag === "button" || e.tag === "a" || e.role === "button"))
          .map((e) => ({ tag: e.tag, text: (e.visibleText ?? "").slice(0, 40), aria: e.ariaLabel, href: (e.href ?? "").slice(0, 60) }));
        writeFileSync(
          `/tmp/replay-nobutton-${browser.currentUrl().replace(/[^a-z0-9]+/gi, "_").slice(-30)}.txt`,
          `url=${browser.currentUrl()}\nprofiles=${JSON.stringify(profiles)}\nclickable=${JSON.stringify(clickable, null, 1)}`,
        );
        console.error(`[replay-oauth-debug] no OAuth button — dumped page affordances`);
      } catch {
        /* best-effort */
      }
    }
    const guess = inferProviderFromUrl(browser.currentUrl()) ?? "google";
    return { kind: "needs_login", provider: guess };
  }
  // Drive the click, then deterministically walk the account-chooser +
  // consent screens (the old code clicked and only WAITED, so any
  // interstitial stalled it into needs_login).
  await browser.startOAuth(pickedButton.selector);
  let walk = await walkOAuthConsent(browser, pickedProvider);
  if (walk === "needs_login") {
    if (await attemptKindeOrganizationSelection(browser, expectedUrl)) {
      walk = "ok";
    }
  }
  if (walk === "needs_login") {
    await browser.settleAfterOAuth().catch(() => undefined);
    return { kind: "needs_login", provider: pickedProvider };
  }
  // Confirm we're back: poll for the round-trip, then re-navigate to the
  // exact expected URL so the rest of the skill runs against the captured
  // page (not a /welcome or /dashboard landing).
  const expectedHost = new URL(expectedUrl).hostname;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await browser.wait(1);
    if (await attemptKindeOrganizationSelection(browser, expectedUrl)) {
      continue;
    }
    if (browser.oauthPageClosed()) break;
    // Wait until we're back on the product host AND clear of the auth
    // intermediary. Services that broker OAuth through their OWN domain
    // (weaviate: console.weaviate.cloud/signin?code=… → exchanges the code →
    // /overview) land back on expectedHost while still mid-handshake. Breaking
    // on hostname alone re-navigates before the session exists, bouncing right
    // back to /signin → needs_login. Require the login path to clear and no
    // lingering ?code=/?state= auth-callback param before declaring success.
    if (settledOnProductPage(browser.currentUrl(), expectedHost)) break;
  }
  // Restore this.page to the product page. The GIS popup flow (kinde/imagekit)
  // closes the OAuth popup on its own; without this, this.page stays the CLOSED
  // popup and the re-navigate below throws "Target page has been closed". Only
  // the discovery bot called settleAfterOAuth before — the replay recovery
  // never did, so every popup-based OAuth crashed here.
  const activeUrlBeforeSettle = browser.currentUrl();
  const activePageIsProduct = settledOnProductPage(activeUrlBeforeSettle, expectedHost);
  if (!activePageIsProduct) {
    await browser.settleAfterOAuth().catch(() => undefined);
    await attemptKindeOrganizationSelection(browser, expectedUrl);
  }
  const keepKindeTenantPage =
    activePageIsProduct &&
    expectedHost === "app.kinde.com" &&
    (() => {
      try {
        const active = new URL(activeUrlBeforeSettle);
        return active.hostname.endsWith(".kinde.com") && active.hostname !== "app.kinde.com";
      } catch {
        return false;
      }
    })();
  if (!keepKindeTenantPage) {
    await browser.goto(expectedUrl);
  }
  await browser.wait(2);
  const drift = detectNavigationDrift(browser.currentUrl(), expectedUrl);
  if (drift !== null) {
    // Round-trip didn't unlock the destination — session genuinely
    // expired/challenged. The operator needs to re-run `mcp login`.
    return { kind: "needs_login", provider: pickedProvider };
  }
  return { kind: "ok" };
}

async function attemptKindeOrganizationSelection(
  browser: BrowserController,
  expectedUrl: string,
): Promise<boolean> {
  let current: URL;
  try {
    current = new URL(browser.currentUrl());
  } catch {
    return false;
  }
  if (process.env.REPLAY_DEBUG) {
    console.error(`[replay-oauth-debug] Kinde org-selection probe url=${current.href.slice(0, 140)}`);
  }
  if (current.hostname !== "app.kinde.com") return false;
  if (!current.pathname.includes("/auth/cx/")) return false;
  if (!current.href.includes("organization_selection")) return false;
  let expected: URL | null = null;
  try {
    expected = new URL(expectedUrl);
  } catch {
    expected = null;
  }
  const expectedOrg =
    expected !== null &&
    expected.hostname.endsWith(".kinde.com") &&
    expected.hostname !== "app.kinde.com"
      ? expected.hostname.split(".")[0]
      : undefined;
  try {
    await browser.waitForInteractiveDom().catch(() => undefined);
    await browser.selectOption('select[name="p_org_code"]', expectedOrg);
    const inventory = await browser.extractInteractiveElements();
    const continueButton = inventory.find(
      (e) =>
        e.visible &&
        (e.tag === "button" || e.role === "button" || e.type === "submit") &&
        /\bcontinue\b/i.test(e.visibleText ?? e.ariaLabel ?? ""),
    );
    if (continueButton === undefined) return false;
    await browser.click(continueButton.selector);
    await browser.wait(3);
    await browser.waitForInteractiveDom().catch(() => undefined);
    return true;
  } catch (err) {
    if (process.env.REPLAY_DEBUG) {
      console.error(
        `[replay-oauth-debug] Kinde organization selection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return false;
  }
}

async function attemptOAuthRecoveryForFailedStep(
  browser: BrowserController,
  expectedUrl: string,
  profileDir?: string,
  preferredProvider?: OAuthProviderId,
): Promise<
  { kind: "ok" } | { kind: "needs_login"; provider: OAuthProviderId } | { kind: "not_auth_page" }
> {
  let inventory: InteractiveElement[];
  try {
    inventory = await browser.extractInteractiveElements();
  } catch {
    return { kind: "not_auth_page" };
  }
  const hasOAuthButton = (["google", "github"] as const).some(
    (provider) => findOAuthButton(inventory, provider) !== null,
  );
  if (!hasOAuthButton) return { kind: "not_auth_page" };
  return await attemptOAuthRecovery(browser, expectedUrl, profileDir, preferredProvider);
}
