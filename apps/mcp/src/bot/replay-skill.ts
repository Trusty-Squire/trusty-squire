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

import { appendFileSync, mkdirSync } from "node:fs";
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
  const isMultiCred = skill.steps.some(
    (s) =>
      s.kind === "extract_via_copy_button_named" ||
      s.kind === "extract_via_regex_named",
  );
  const expectedProduces = new Set<string>(
    skill.steps
      .filter(
        (s): s is Extract<SkillStep, { produces: string }> =>
          s.kind === "extract_via_copy_button_named" ||
          s.kind === "extract_via_regex_named",
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

    // Pre-validate: would this step resolve cleanly against the
    // current page? If not, hand to the LLM fallback.
    const validation = await preValidateStep(step, browser, templateValues);
    let stepToExecute = step;
    if (!validation.ok) {
      const fallbackResult = await tryFallback(
        step,
        validation.reason,
        browser,
        i,
        skill,
        llmFallback,
        candidatesDir,
      );
      if (fallbackResult.kind === "use_substitute") {
        stepToExecute = fallbackResult.substitute;
      } else if (fallbackResult.kind === "needs_login") {
        return { kind: "needs_login", provider: fallbackResult.provider, stepIndex: i };
      } else if (
        step.kind === "click" &&
        isSkippableAbsentClick(
          step,
          i,
          await countClickMatches(step, browser),
          skill.steps,
        )
      ) {
        // Account-state-dependent setup click (hookdeck "Create
        // Project" class): the target button only existed in the
        // original signup's account state. It's wholly absent now AND
        // it isn't the credential-creating click — skip it and continue
        // rather than hard-failing a replay that can still reach the
        // credential. Step-trail note so the skip is visible to anyone
        // triaging the run (and so a genuinely-required vanished button
        // isn't silently swallowed without a paper trail).
        console.error(
          `[replay] step ${i} (click text_match=${JSON.stringify(step.text_match)}) ` +
            `target absent from page; skipping as optional setup step. ` +
            `Reason: ${validation.reason}`,
        );
        continue;
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
      } else {
        return {
          kind: "step_failed",
          stepIndex: i,
          reason: markReturningUser(validation.reason, skippedOnboardingFill),
          capturedStep: step,
        };
      }
    }

    // Execute. If execution itself throws (a transient browser fault),
    // surface it as a step failure with the underlying message —
    // the router can decide whether to retry or fall through to the
    // universal bot.
    try {
      const execOutcome = await executeStep(stepToExecute, browser, templateValues, skill);
      if (execOutcome.kind === "needs_login") {
        return { kind: "needs_login", provider: execOutcome.provider, stepIndex: i };
      }
      if (execOutcome.kind === "extract_ok") {
        // We extracted a credential successfully. Validate it before
        // declaring victory — the synthesizer's shape inference is a
        // best-guess, and the credential validator catches the
        // Railway-class "wrong UUID on the page" failure (C5).
        const credSpec = skill.credentials[0]!;
        const validatorResult = await validateCredential(execOutcome.value, credSpec, input.fetchFn);
        if (!validatorResult.ok) {
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
          skippedOnboardingFill,
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

    case "click_oauth_button": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => matchesClickHint(el, step.text_match));
      if (matches.length === 0) {
        return {
          ok: false,
          reason: `No element matches text_match=${JSON.stringify(step.text_match)} for ${step.provider} OAuth button.`,
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
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => matchesClickHint(el, step.text_match));
      const filtered = step.role_hint
        ? matches.filter((el) => matchesRole(el, step.role_hint!))
        : matches;
      if (filtered.length === 0) {
        // href fallback: a nav-link target whose text rendered as an icon
        // on replay (or whose URL slug differs) won't match by text but
        // still resolves by its stable href path tail. Only links carry
        // href_hint, so this never fires for button/checkbox steps.
        if (step.href_hint !== undefined) {
          const byHref = inventory.filter((el) => matchesHrefHint(el, step.href_hint!));
          if (byHref.length === 1) return { ok: true, match: byHref[0]! };
        }
        if (matches.length > 0) {
          return {
            ok: false,
            reason:
              `text_match=${JSON.stringify(step.text_match)} matched ${matches.length} elements, ` +
              `but role_hint=${step.role_hint} filtered them all out.`,
          };
        }
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
      const matches = inventory.filter((el) => isFillable(el) && matchesLabelHint(el, step.label_hint));
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
      return {
        ok: false,
        reason:
          `${copyButtons.length} Copy buttons visible; ${disambiguated.length} match near_text_hint — ambiguous.`,
      };
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
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = norm(label);
  const b = norm(hint);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
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
): Promise<ExecutionOutcome> {
  switch (step.kind) {
    case "navigate": {
      await browser.goto(step.url);
      // Tiny settle for SPA-style apps that fire route handlers
      // post-DOMContentLoaded. The bot's runPrewarm waits 2s
      // post-navigate too.
      await browser.wait(2);
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
      const driftReason = detectNavigationDrift(landedUrl, step.url);
      if (driftReason !== null) {
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
        const recovered = await attemptOAuthRecovery(browser, step.url);
        if (recovered.kind === "ok") {
          return { kind: "navigated" };
        }
        return { kind: "needs_login", provider: recovered.provider };
      }
      return { kind: "navigated" };
    }

    case "click_oauth_button": {
      // Profile-session guard. If the user hasn't run `mcp login` for
      // this provider, the click would still happen but we'd land on
      // a credential-entry form (provider's needs_login state), and
      // the replay engine can't fill that — only the user can. Bail
      // early with needs_login so the router fast-paths to the
      // universal bot.
      const profiles = loggedInProviders();
      if (!profiles.includes(step.provider)) {
        return { kind: "needs_login", provider: step.provider };
      }
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
      return { kind: "clicked" };
    }

    case "click": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => matchesClickHint(el, step.text_match));
      const filtered = step.role_hint
        ? matches.filter((el) => matchesRole(el, step.role_hint!))
        : matches;
      if (filtered.length === 0) {
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
          const dest = rebaseHrefOntoCurrentUrl(step.href_hint, browser.currentUrl());
          if (dest !== null) {
            await browser.goto(dest);
            await browser.wait(1);
            return { kind: "clicked" };
          }
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
        : filterByNearTextHint(filtered, step.near_text_hint, inventory);
      const target =
        narrowed.length === 1 ? narrowed[0]! : pickClickPriority(narrowed);
      await browser.click(target.selector);
      // Settle so any post-click navigation finishes before the next
      // pre-validation reads inventory.
      await browser.wait(1);
      return { kind: "clicked" };
    }

    case "fill": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => isFillable(el) && matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
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

    case "select": {
      const inventory = await browser.extractInteractiveElements();
      // 0.8.2-rc.3 — apply near_text_hint filter when present so
      // Sentry-grid rows land on the right <select>. The original
      // `inventory.find` would unilaterally pick the first match.
      //
      // 0.8.2-rc.21 — also restrict to fillable elements (input /
      // textarea / select). Without this, a Railway-class form where
      // a `<label for="select-X">` shares labelText with its
      // `<select id="select-X">` would silently pick the label —
      // and selectOption(label, …) would then route into the
      // combobox path and fail because native selects don't reveal
      // options via DOM patterns. Pre-validation already filters
      // this way; the executor was lagging.
      const allMatches = inventory.filter(
        (el) => isFillable(el) && matchesLabelHint(el, step.label_hint),
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
            const polled = await browser.extractCredentialCandidates();
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
        await browser.click(target.selector);
        await browser.wait(1);
      }
      // BrowserController.extractCredentialCandidates pulls visible
      // candidates (input values + direct text); it does NOT read the
      // clipboard yet. We use it as the primary source and fall back
      // to the full body text for regex matching when the candidate
      // list yields nothing recognisable.
      const candidates = await browser.extractCredentialCandidates();
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
      const text = await browser.extractText();
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
        const clip = await browser.readClipboard();
        if (clip && clip.length > 0) {
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
        }
      } catch {
        // Clipboard read failed (permission denied, no clipboard
        // contents). Fall through to the canonical error.
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
          const cands = await browser.extractCredentialCandidates();
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
      const diag =
        ` [url=${browser.currentUrl()} inventory=${inventory.length} copyButtons=${copyButtons.length}]`;
      const failureReason =
        target === undefined
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
      if (candidateSatisfiesValidatorShape(cand, validator)) return cand;
    }
  } catch {
    // Non-fatal — caller falls through to its canonical failure.
  }
  return null;
}

async function validateCredential(
  value: string,
  spec: SkillCredentialSpec,
  fetchFn?: typeof globalThis.fetch,
): Promise<ValidatorOk | ValidatorFail> {
  const validator = spec.post_extract_validator;
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
): Promise<FallbackResult> {
  // If the captured step is an OAuth click and the user has no session,
  // fall back to the bot's needs_login flow instead of asking the
  // planner — there's nothing to substitute, the user must `mcp login`.
  if (capturedStep.kind === "click_oauth_button") {
    const profiles = loggedInProviders();
    if (!profiles.includes(capturedStep.provider)) {
      return { kind: "needs_login", provider: capturedStep.provider };
    }
  }

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

function matchesClickHint(el: InteractiveElement, hint: string): boolean {
  const lowerHint = hint.toLowerCase();
  const text = (el.visibleText ?? "").toLowerCase();
  const aria = (el.ariaLabel ?? "").toLowerCase();
  if (text.includes(lowerHint) || aria.includes(lowerHint)) return true;
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
  const looksLikeSlug = /\d/.test(first) || /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(first);
  const tail = looksLikeSlug ? segs.slice(1) : segs;
  return tail.map((s) => s.toLowerCase());
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
  // When both the captured path and the current URL lead with a slug-shaped
  // segment, swap in the replay account's slug so the destination resolves
  // under the right workspace. Otherwise navigate the captured path as-is.
  if (firstSegmentIsSlug(capSegs[0]) && firstSegmentIsSlug(curSegs[0])) {
    capSegs[0] = curSegs[0]!;
  }
  return `${cur.origin}/${capSegs.join("/")}`;
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

// Tag a step_failed reason when it fires AFTER we skipped an absent onboarding
// fill — the operator account is already registered, so the credential step
// diverged from the fresh-signup capture. The verifier matches this marker
// (failure-taxonomy isReturningUserDivergence) and downgrades the kind off the
// rot/demote path. Without the skip, the reason is returned verbatim — a
// genuine stale selector on a fresh account still counts as rot.
function markReturningUser(reason: string, skippedOnboardingFill: boolean): string {
  if (!skippedOnboardingFill) return reason;
  return `${reason} [returning-user: onboarding fill was absent; credential step diverged from fresh-signup capture]`;
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
      k === "extract_via_regex_named"
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
  // Same-origin redirect to a login-shaped path — covers Railway's
  // /login fallback when /account/tokens is hit unauthenticated.
  if (cur.hostname === exp.hostname && cur.pathname !== exp.pathname) {
    if (LOGIN_PATH_RE.test(cur.pathname)) {
      return `same-origin redirect to login path ${cur.pathname}`;
    }
  }
  return null;
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
  const name = /^(continue|allow|authorize|approve|accept|agree|i agree)$/i;
  for (const role of ["button", "link"] as const) {
    try {
      const loc = page.getByRole(role, { name }).first();
      await loc.waitFor({ state: "visible", timeout: 2000 });
      await loc.click({ timeout: 3000 });
      return true;
    } catch {
      /* try the next role */
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
): Promise<"ok" | "needs_login"> {
  const provider = OAUTH_PROVIDERS[providerId];
  const MAX_NAV = 6;
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
    const state = provider.classifyAuthState(url, body);
    console.error(`[replay-oauth] state=${state} url=${url.slice(0, 100)}`);
    if (state === "not_provider") return "ok"; // flow left the provider
    if (state === "challenge" || state === "needs_login") return "needs_login";
    // state === "consent": scope-gate it. Only auto-approve identity-basic
    // scopes — verify must never grant a sensitive scope blind.
    const scopes = extractOAuthScopes(url);
    const basic =
      scopes !== null
        ? provider.scopesAreBasic(scopes)
        : // Google hides scopes behind an opaque part= token; fall back to
          // the visible DOM — basic only when NO scope-grant phrases show.
          providerId === "google" && scrapeGoogleScopePhrases(body).length === 0;
    if (!basic) {
      console.error("[replay-oauth] consent scopes not basic/unreadable — needs_login");
      return "needs_login";
    }
    const beforeUrl = browser.currentUrl();
    const clicked = await clickConsentAffordance(browser);
    if (!clicked) return "needs_login";
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

async function attemptOAuthRecovery(
  browser: BrowserController,
  expectedUrl: string,
): Promise<
  { kind: "ok" } | { kind: "needs_login"; provider: OAuthProviderId }
> {
  const profiles = loggedInProviders();
  if (profiles.length === 0) {
    return { kind: "needs_login", provider: "google" };
  }
  // Find an OAuth button matching a provider we have a cached session for.
  // Retry: SPA login pages (posthog, kinde) render the OAuth buttons a beat
  // after domcontentloaded, so a single inventory races them → false
  // "no button" needs_login. Re-inventory a few times before giving up.
  let pickedProvider: OAuthProviderId | null = null;
  let pickedButton: ReturnType<typeof findOAuthButton> | null = null;
  for (let attempt = 0; attempt < 4 && pickedButton === null; attempt++) {
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
  }
  if (pickedProvider === null || pickedButton === null) {
    // The page may genuinely be a non-OAuth login form (some services
    // also offer password auth). The replay can't synthesize a
    // password; surface needs_login with a guess based on the URL.
    const guess = inferProviderFromUrl(browser.currentUrl()) ?? "google";
    return { kind: "needs_login", provider: guess };
  }
  // Drive the click, then deterministically walk the account-chooser +
  // consent screens (the old code clicked and only WAITED, so any
  // interstitial stalled it into needs_login).
  await browser.startOAuth(pickedButton.selector);
  const walk = await walkOAuthConsent(browser, pickedProvider);
  if (walk === "needs_login") {
    return { kind: "needs_login", provider: pickedProvider };
  }
  // Confirm we're back: poll for the round-trip, then re-navigate to the
  // exact expected URL so the rest of the skill runs against the captured
  // page (not a /welcome or /dashboard landing).
  const expectedHost = new URL(expectedUrl).hostname;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await browser.wait(1);
    if (browser.oauthPageClosed()) break;
    let host: string;
    try {
      host = new URL(browser.currentUrl()).hostname;
    } catch {
      continue;
    }
    if (host === expectedHost) break;
  }
  await browser.goto(expectedUrl);
  await browser.wait(2);
  const drift = detectNavigationDrift(browser.currentUrl(), expectedUrl);
  if (drift !== null) {
    // Round-trip didn't unlock the destination — session genuinely
    // expired/challenged. The operator needs to re-run `mcp login`.
    return { kind: "needs_login", provider: pickedProvider };
  }
  return { kind: "ok" };
}
