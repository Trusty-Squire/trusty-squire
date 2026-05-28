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
} from "@trusty-squire/adapter-sdk";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { loggedInProviders } from "./login-state.js";
import { isTruncatedCapture, extractApiKeyFromText } from "./agent.js";

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
      via: Record<string, "copy_button" | "regex">;
    }
  | { kind: "step_failed"; stepIndex: number; reason: string; capturedStep: SkillStep }
  | { kind: "validator_failed"; stepIndex: number; got: string; reason: string }
  | { kind: "extraction_failed"; stepIndex: number; reason: string }
  | { kind: "needs_login"; provider: "google" | "github"; stepIndex: number }
  | { kind: "skill_demoted"; reason: string }
  | { kind: "dry_pass"; stepsWalked: number };

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
  // (set by housekeeper-loop on the verifier queue) so it can gather
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
  const viaBundle: Record<string, "copy_button" | "regex"> = {};

  let stepsWalked = 0;
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
      } else {
        return {
          kind: "step_failed",
          stepIndex: i,
          reason: validation.reason,
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
        reason: err instanceof Error ? err.message : String(err),
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
          reason: `No element matches text_match=${JSON.stringify(step.text_match)}.`,
        };
      }
      if (filtered.length > 1) {
        // Ambiguity disambiguator: prefer the first non-link button.
        // If still ambiguous, that's an LLM-fallback case (C3).
        const buttons = filtered.filter((el) => el.tag === "button");
        if (buttons.length === 1) return { ok: true, match: buttons[0]! };
        return {
          ok: false,
          reason:
            `text_match=${JSON.stringify(step.text_match)} matched ${filtered.length} elements; ` +
            `cannot uniquely identify the click target.`,
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
        return { ok: false, reason: "No Copy button visible on page." };
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
  }
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
      via: "copy_button" | "regex";
    }
  | { kind: "needs_login"; provider: "google" | "github" };

async function executeStep(
  step: SkillStep,
  browser: BrowserController,
  templateValues: Record<string, string>,
  skill: Skill,
): Promise<ExecutionOutcome> {
  switch (step.kind) {
    case "navigate":
      await browser.goto(step.url);
      // Tiny settle for SPA-style apps that fire route handlers
      // post-DOMContentLoaded. The bot's runPrewarm waits 2s
      // post-navigate too.
      await browser.wait(2);
      return { kind: "navigated" };

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
        throw new Error(`No element matches text_match=${step.text_match}`);
      }
      const target = filtered.length === 1 ? filtered[0]! : pickClickPriority(filtered);
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
      const allMatches = inventory.filter((el) => matchesLabelHint(el, step.label_hint));
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
      const inventory = await browser.extractInteractiveElements();
      const copyButtons = inventory.filter(isCopyButton);
      const target = copyButtons.length === 1
        ? copyButtons[0]!
        : copyButtons.find((btn) => nearTextHintMatches(btn, step.near_text_hint, inventory))!;
      if (target === undefined) {
        throw new Error("Copy button disappeared between pre-validation and execution.");
      }
      // Click the Copy button. The bot already does this in
      // tryCopyButtonExtraction; we mirror the contract: click, brief
      // wait, then read navigator.clipboard.readText() via the page
      // context. clipboardText() on BrowserController would be ideal
      // but doesn't exist yet — we use page.evaluate via the
      // extractCredentialCandidates pathway, falling back to text
      // scan if clipboard access is denied.
      await browser.click(target.selector);
      await browser.wait(1);
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
      throw new Error(
        "Copy button clicked but no credential matched the regex library in candidates, body text, or clipboard.",
      );
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
      const deadline = Date.now() + 8000;
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
            return { kind: "extract_ok", value: cand, via: "regex" };
          }
        } catch {
          // Fall through to the canonical error below.
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
      if (extracted === null) {
        throw new Error(
          `No credential matching pattern ${step.pattern_name} (for ${step.produces}) found on page.`,
        );
      }
      return {
        kind: "extract_named_ok",
        produces: step.produces,
        value: extracted,
        via: "regex",
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

async function validateCredential(
  value: string,
  spec: SkillCredentialSpec,
  fetchFn?: typeof globalThis.fetch,
): Promise<ValidatorOk | ValidatorFail> {
  const validator = spec.post_extract_validator;
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
  // Substring match in either field. Exact match scored higher upstream;
  // this returns true for any candidate, and the disambiguator (C3)
  // narrows further.
  return text.includes(lowerHint) || aria.includes(lowerHint);
}

function matchesLabelHint(el: InteractiveElement, hint: string): boolean {
  const lowerHint = hint.toLowerCase();
  const label = (el.labelText ?? "").toLowerCase();
  const placeholder = (el.placeholder ?? "").toLowerCase();
  const aria = (el.ariaLabel ?? "").toLowerCase();
  return (
    label === lowerHint ||
    placeholder === lowerHint ||
    aria === lowerHint
  );
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

// 0.8.2-rc.3 — narrow ambiguous fill/select matches by the schema-
// level near_text_hint. When the hint is absent (old skills),
// matches pass through unchanged. When set, we score each match by
// the SIGNED distance to the nearest occurrence of the hint, with
// "hint just before the match" (positive small distance) ranked
// above "hint just after the match" (negative small distance).
//
// This mirrors how row labels work in the DOM: the typical layout is
//   [Row N label] [Row N input] [Row N+1 label] [Row N+1 input]
// so the hint text for row N sits immediately BEFORE row N's input.
// Sentry's permission grid follows this; so does most grid/form
// markup. Right-aligned column layouts (label after input) are
// supported as a tiebreaker — the closest-preceding wins, but if
// nothing precedes within window the closest-following wins.
function filterByNearTextHint(
  matches: readonly InteractiveElement[],
  hint: string | undefined,
  inventory: readonly InteractiveElement[],
): InteractiveElement[] {
  if (hint === undefined || hint.length === 0) return [...matches];
  const lower = hint.toLowerCase();

  // For each match, compute (signedDist, absDist) for the nearest
  // hint occurrence. signedDist > 0 → hint precedes match (preferred);
  // signedDist < 0 → hint follows match (acceptable fallback). The
  // tiebreaker is the smallest absolute distance — closest wins.
  type Scored = {
    el: InteractiveElement;
    bestPreceding: number; // smallest "hint at i < elIdx" distance
    bestFollowing: number; // smallest "hint at i > elIdx" distance
  };
  const scored: Scored[] = matches.map((el) => {
    const elIdx = inventory.findIndex((x) => x.selector === el.selector);
    let bestPreceding = Number.POSITIVE_INFINITY;
    let bestFollowing = Number.POSITIVE_INFINITY;
    if (elIdx !== -1) {
      for (let i = 0; i < inventory.length; i++) {
        const text = (
          inventory[i]!.visibleText ?? inventory[i]!.ariaLabel ?? ""
        ).toLowerCase();
        if (!text.includes(lower)) continue;
        const d = elIdx - i; // positive when hint precedes match
        if (d > 0 && d < bestPreceding) bestPreceding = d;
        if (d < 0 && -d < bestFollowing) bestFollowing = -d;
      }
    }
    return { el, bestPreceding, bestFollowing };
  });

  // No match sees the hint anywhere — caller treats as "no valid
  // disambiguation".
  if (
    scored.every(
      (s) =>
        !Number.isFinite(s.bestPreceding) && !Number.isFinite(s.bestFollowing),
    )
  ) {
    return [];
  }

  // First pass: pick the unique winner by closest PRECEDING hint.
  // Most grid layouts disambiguate cleanly here.
  let minPreceding = Number.POSITIVE_INFINITY;
  for (const s of scored)
    if (s.bestPreceding < minPreceding) minPreceding = s.bestPreceding;
  if (Number.isFinite(minPreceding)) {
    const winners = scored.filter((s) => s.bestPreceding === minPreceding);
    if (winners.length === 1) return [winners[0]!.el];
  }

  // Second pass: fall back to closest FOLLOWING hint (label after
  // input, rare).
  let minFollowing = Number.POSITIVE_INFINITY;
  for (const s of scored)
    if (s.bestFollowing < minFollowing) minFollowing = s.bestFollowing;
  if (Number.isFinite(minFollowing)) {
    const winners = scored.filter((s) => s.bestFollowing === minFollowing);
    if (winners.length === 1) return [winners[0]!.el];
  }

  // Genuine tie — defer to the caller's legacy heuristic disambiguator
  // by returning all matches that have the hint in their ±5 window.
  const windowFiltered = matches.filter((el) =>
    nearTextHintMatches(el, hint, inventory),
  );
  return windowFiltered.length > 0 ? windowFiltered : [...matches];
}

function nearTextHintMatches(
  copyButton: InteractiveElement,
  hint: string,
  inventory: readonly InteractiveElement[],
): boolean {
  // Walk the inventory looking for any element whose visibleText
  // contains the hint. The bot's inventory is roughly DOM-ordered,
  // so "near" means "within a small window". We use ±5 entries
  // around the copy button's index — generous enough to span a card
  // (heading + body + button) without false-positiving across a long
  // form.
  const copyIdx = inventory.findIndex((el) => el.selector === copyButton.selector);
  if (copyIdx === -1) return false;
  const lowerHint = hint.toLowerCase();
  const start = Math.max(0, copyIdx - 5);
  const end = Math.min(inventory.length, copyIdx + 6);
  for (let i = start; i < end; i++) {
    const el = inventory[i]!;
    const text = (el.visibleText ?? el.ariaLabel ?? "").toLowerCase();
    if (text.includes(lowerHint)) return true;
  }
  return false;
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

function computeDryStopIndex(steps: SkillStep[]): number {
  // The credential-creating click is the click immediately before the
  // first extract step. Dry mode stops at that click — pre-validates
  // it (confirms the button is on the page), but does not execute it.
  // If the skill has no extract step (shouldn't happen — synthesizer
  // rejects), we just walk everything.
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
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (
      step.kind === "extract_via_copy_button" ||
      step.kind === "extract_via_regex" ||
      step.kind === "extract_via_copy_button_named" ||
      step.kind === "extract_via_regex_named"
    ) {
      // Find the last click before this extract.
      for (let j = i - 1; j >= 0; j--) {
        const prev = steps[j]!;
        if (prev.kind === "click" || prev.kind === "click_oauth_button") {
          return j; // stop before this click
        }
      }
      // No click before extract — stop at the extract itself.
      return i;
    }
  }
  return steps.length;
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
