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
//      universal bot's `provision_any_service` is a one-shot operation
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

  // Router-level guard: a demoted or pending-review skill is not
  // replay-eligible. The router should have filtered these out, but
  // we double-check at the boundary in case something hand-feeds us
  // a skill record from a stale cache.
  if (skill.status !== "active") {
    return {
      kind: "skill_demoted",
      reason: `Skill status is ${skill.status}; replay is only valid for status=active.`,
    };
  }

  // Walk the step graph. Dry mode stops before the last action that
  // would create the credential — that's typically the step
  // immediately before the first extract_* step. Compute the cutoff
  // up front so the loop's stopping condition stays local.
  const dryStopAt = mode === "dry" ? computeDryStopIndex(skill.steps) : skill.steps.length;

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
      const matches = inventory.filter((el) => matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
        return {
          ok: false,
          reason: `No input matches label_hint=${JSON.stringify(step.label_hint)}.`,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          reason:
            `label_hint=${JSON.stringify(step.label_hint)} matched ${matches.length} inputs; ` +
            `cannot uniquely identify the fill target.`,
        };
      }
      return { ok: true, match: matches[0]! };
    }

    case "select": {
      const inventory = await browser.extractInteractiveElements();
      const matches = inventory.filter((el) => matchesLabelHint(el, step.label_hint));
      if (matches.length === 0) {
        return {
          ok: false,
          reason: `No select matches label_hint=${JSON.stringify(step.label_hint)}.`,
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          reason: `label_hint=${JSON.stringify(step.label_hint)} matched ${matches.length} selects.`,
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
  }
}

// ── Step execution ───────────────────────────────────────────────────

type ExecutionOutcome =
  | { kind: "navigated" }
  | { kind: "clicked" }
  | { kind: "filled" }
  | { kind: "selected" }
  | { kind: "extract_ok"; value: string; via: "copy_button" | "regex" }
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
      const match = inventory.find((el) => matchesLabelHint(el, step.label_hint));
      if (match === undefined) {
        throw new Error(`No input matches label_hint=${step.label_hint}`);
      }
      const value = substituteTemplate(step.value_template, templateValues);
      await browser.type(match.selector, value);
      return { kind: "filled" };
    }

    case "select": {
      const inventory = await browser.extractInteractiveElements();
      const match = inventory.find((el) => matchesLabelHint(el, step.label_hint));
      if (match === undefined) {
        throw new Error(`No select matches label_hint=${step.label_hint}`);
      }
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
      throw new Error(
        "Copy button clicked but no credential matched the regex library in candidates or body text.",
      );
    }

    case "extract_via_regex": {
      const text = await browser.extractText();
      const extracted = extractApiKeyFromText(text);
      if (extracted === null) {
        throw new Error(`No credential matching pattern ${step.pattern_name} found on page.`);
      }
      return { kind: "extract_ok", value: extracted, via: "regex" };
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

function matchesRole(el: InteractiveElement, role: "button" | "link" | "tab" | "menuitem"): boolean {
  if (role === "button") return el.tag === "button" || el.role === "button";
  if (role === "link") return el.tag === "a" || el.role === "link";
  return el.role === role;
}

function isCopyButton(el: InteractiveElement): boolean {
  const text = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""}`.trim();
  return /^\s*copy(?:\b|\s|$)|copy\s+(?:api\s*key|secret|token|key|to\s+clipboard)\b/i.test(text);
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
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.kind === "extract_via_copy_button" || step.kind === "extract_via_regex") {
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
