// promote-to-skill.ts — Stage 1 of the Skill Promoter pipeline.
//
// See docs/DESIGN-skill-promoter.md. The synthesizer is the bridge
// between "the bot captured something" (PostVerifyStep + DOM-grounded
// inventory dumps) and "the registry has a Skill" (text-based replay
// graph + credential spec).
//
// Pure function: chain-verified captures in, Skill out (or a structured
// rejection). No filesystem writes — the CLI layer (Phase 7) handles
// persistence of the result + rejection records.
//
// Three load-bearing translations happen here:
//
//   1. Selectors → text matches. The bot's PostVerifyStep uses raw CSS
//      selectors that point into the inventory. The Skill's SkillStep
//      uses visible-text/aria-label hints that survive page redesigns.
//      For each captured step, we look up the inventory entry by
//      selector and pull its visibleText/ariaLabel/labelText/placeholder
//      as the hint. Empty/duplicate text → rejection.
//
//   2. Extract step → SkillCredentialSpec. The bot's `extract` action
//      is opaque — it just runs the regex library. We infer credential
//      shape from the page text near the extract: a Copy button nearby
//      → extract_via_copy_button; a known prefix on the page →
//      extract_via_regex with a named pattern; otherwise uuid/opaque
//      with a sentinel HTTP check left for the operator to fill in.
//
//   3. signup_url + oauth_provider. The first round's state.url is the
//      signup URL. The OAuth provider is inferred from whether any
//      step is `click_oauth_button` and its provider field.
//
// The synthesizer is deterministic: same captures in, byte-identical
// skill out (modulo the skill_id, which is itself derived from the
// content hash of the synthesized skill so it stays stable across
// re-runs).

import { createHash } from "node:crypto";
import {
  parseSkill,
  SKILL_SCHEMA_VERSION,
  type Skill,
  type SkillCredentialSpec,
  type SkillStep,
  type SkillStepProvenance,
} from "@trusty-squire/adapter-sdk";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";
import {
  verifyCaptureChain,
  type OnboardingCaseFile,
} from "./onboarding-capture.js";

// ── Public API ───────────────────────────────────────────────────────

export interface PromoteInput {
  /** Directory containing the `<service>-<run_id>-r*.json` capture files. */
  dir: string;
  /** Canonical service slug (lowercase-with-dashes). */
  service: string;
  /** Which run within `dir` to promote (the bot writes one per signup). */
  run_id: string;
  /**
   * Optional override for the env-var suggestion. When absent, the
   * synthesizer derives `${SERVICE}_API_KEY` (e.g. RAILWAY_API_KEY).
   */
  env_var_suggestion?: string;
}

export type PromoteResult =
  | { kind: "ok"; skill: Skill }
  | PromoteRejection;

/**
 * Structured rejection. Mirrors the rejection.json shape the CLI writes
 * to `corpus/skills-failed/<id>/` (D2). Every rejection identifies the
 * stage that caught it, the error kind, and (where applicable) the
 * offending step or round.
 */
export interface PromoteRejection {
  kind: "rejected";
  stage: "chain_verification" | "synthesis" | "schema_validation";
  error_kind:
    | "unknown_version"
    | "hash_mismatch"
    | "prev_hash_mismatch"
    | "missing_round"
    | "no_rounds"
    | "parse_error"
    | "no_extract_step"
    | "ambiguous_text_match"
    | "missing_text_hint"
    | "unsupported_step_kind"
    | "inventory_entry_not_found"
    | "credential_spec_inference_failed"
    | "schema_invalid"
    // Multi-credential paths (Phase C per docs/DESIGN-multi-credential.md).
    // `duplicate_credential_produces`: two extract rounds derived the
    // same `produces` name (e.g. both labeled "API Key"). Operator
    // fixes by hand-editing the capture labels or re-running the
    // signup with a clearer planner prompt.
    // `unparseable_credential_label`: an extract round's hint reduced
    // to an empty `produces` after normalization (just "Copy", say).
    | "duplicate_credential_produces"
    | "unparseable_credential_label";
  message: string;
  offending_round?: number;
  offending_step?: number;
  detail?: string;
  synthesizer_version: typeof SYNTHESIZER_VERSION;
}

/**
 * Synthesizer version. Bumped when the translation logic changes in a
 * way that would produce different output from the same input. The
 * rejection record carries this so historical rejections can be
 * triaged in light of synthesizer fixes.
 */
export const SYNTHESIZER_VERSION = 1 as const;

// ── Top-level pipeline ───────────────────────────────────────────────

export function promoteToSkill(input: PromoteInput): PromoteResult {
  // Stage 1.a — verify the capture chain. Hand-edits to any round
  // break the chain; the promoter refuses to proceed.
  const verification = verifyCaptureChain(input.dir, input.service, input.run_id);
  if (!verification.ok) {
    return {
      kind: "rejected",
      stage: "chain_verification",
      error_kind: verification.reason,
      message: chainRejectionMessage(verification.reason, verification.offending_round),
      ...(verification.offending_round !== undefined
        ? { offending_round: verification.offending_round }
        : {}),
      ...(verification.detail !== undefined ? { detail: verification.detail } : {}),
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Stage 1.b — synthesize the SkillStep array. Always emits single-
  // cred extract kinds; the multi-cred upgrade happens in Stage 1.c.5
  // below as a post-pass. This keeps step synthesis single-purpose.
  const stepsResult = synthesizeSteps(verification.rounds, input.run_id);
  if (stepsResult.kind !== "ok") return stepsResult;

  // Stage 1.c — infer signup_url + oauth_provider from round 0 + steps.
  const firstRound = verification.rounds[0]!;
  const signupUrl = firstRound.state.url;
  const oauthProvider = inferOAuthProvider(stepsResult.steps);

  // rc.24 — guarantee the first step is a navigate. When the captured
  // bot got "lucky" — landed on a page that already showed the
  // credential because methoxine had a prior session — the planner
  // picks `extract` on round 0 and the synthesizer produces a skill
  // whose first step is `extract_via_regex`. Replay can't reproduce
  // that: the replay engine starts with a fresh browser context, runs
  // step 0 against `about:blank`, extractText returns empty, step
  // fails. Symptom on `ipinfo` skill F7W8…: "Page extractText returned
  // no content." A prepended `navigate` step using the skill's own
  // signup_url + the captured profile gets the page back to the state
  // the synthesis was based on, and the subsequent extract works.
  // Idempotent: if the chain already starts with a navigate, nothing
  // changes.
  if (
    stepsResult.steps.length > 0 &&
    stepsResult.steps[0]!.kind !== "navigate" &&
    stepsResult.steps[0]!.kind !== "click_oauth_button"
  ) {
    stepsResult.steps.unshift({
      kind: "navigate",
      url: signupUrl,
      provenance: {
        run_id: input.run_id,
        round_index: 0,
      },
    });
  }

  // Stage 1.c.5 — multi-cred dispatch (Phase B/C per docs/DESIGN-
  // multi-credential.md). Count extract-class steps; if >1 AND each
  // has a distinct derivable `produces` name, upgrade to the multi-
  // cred shape (named extract kinds + multiple credentials). On any
  // failure (collision, unparseable label) we REJECT rather than
  // silently fall back to single-cred — a multi-cred capture with
  // ambiguous labels is operator-fix territory.
  const extractStepIndices = stepsResult.steps
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
    );
  const multiCred = extractStepIndices.length > 1;
  let steps: SkillStep[] = stepsResult.steps;
  let credentials: SkillCredentialSpec[];

  if (multiCred) {
    const multiResult = upgradeToMultiCred(
      stepsResult.steps,
      verification.rounds,
      input.service,
    );
    if (multiResult.kind !== "ok") return multiResult;
    steps = multiResult.steps;
    credentials = multiResult.credentials;
  } else {
    // Stage 1.d (single-cred) — infer one credential spec from the
    // sole extract step + page. UNCHANGED from pre-multi-cred.
    const credentialResult = inferCredentialSpec(
      verification.rounds,
      stepsResult.steps,
      input.service,
      input.env_var_suggestion,
    );
    if (credentialResult.kind !== "ok") return credentialResult;
    credentials = [credentialResult.spec];
  }

  // Stage 1.e — assemble the candidate skill and validate via Zod.
  // skill_id is derived deterministically from the assembled content
  // so the same captures always produce the same skill_id (test
  // determinism + the registry idempotency on (service, skill_id)).
  const createdAt = firstRound.state.url; // placeholder unused; created_at sourced from generator
  void createdAt;

  const candidate: Omit<Skill, "skill_id"> = {
    schema_version: SKILL_SCHEMA_VERSION,
    service: input.service,
    version: "v1",
    signup_url: signupUrl,
    oauth_provider: oauthProvider,
    steps,
    credentials,
    source_run_ids: [input.run_id],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: deriveTimestampFromRounds(verification.rounds),
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };

  const skillId = deriveSkillId(candidate);
  const full: Skill = { ...candidate, skill_id: skillId };

  try {
    const parsed = parseSkill(full);
    return { kind: "ok", skill: parsed };
  } catch (err) {
    return {
      kind: "rejected",
      stage: "schema_validation",
      error_kind: "schema_invalid",
      message:
        "Synthesizer produced a skill that failed schema validation. " +
        "This is a synthesizer bug — please file an issue with the " +
        "rejection.json + capture directory.",
      detail: err instanceof Error ? err.message : String(err),
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }
}

// ── Step synthesis ───────────────────────────────────────────────────

interface StepsOk {
  kind: "ok";
  steps: SkillStep[];
}

function synthesizeSteps(
  rounds: OnboardingCaseFile[],
  runId: string,
): StepsOk | PromoteRejection {
  const steps: SkillStep[] = [];

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i]!;
    // Build the provenance once — every step in this round shares the
    // same (run_id, round_index) pair. The run_id comes from the
    // promoter's input rather than being derived from the round, so
    // forensics on a published skill point back at the actual run dir
    // (`<service>-<run_id>-r*.json`) rather than a placeholder hash.
    const provenance: SkillStepProvenance = {
      run_id: runId,
      round_index: i,
    };

    const translated = translateStep(round.observed, round.inventory, provenance, i, round.state.html);
    if (translated.kind !== "ok") return translated;
    if (translated.step !== null) steps.push(translated.step);
  }

  // A valid skill needs at least one step. The bot may emit a "done"
  // round (which we drop above), so a capture with only done is
  // effectively empty.
  if (steps.length === 0) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "no_extract_step",
      message:
        "Capture contains no actionable steps — every round was a " +
        "done/wait/login marker. Cannot synthesize a replay graph.",
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Force the existence of at least one extract step. Without one, the
  // skill has no credential extraction path and the validator stage
  // below would reject — better to fail here with a precise error.
  const hasExtract = steps.some(
    (s) => s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
  );
  if (!hasExtract) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "no_extract_step",
      message:
        "Capture has no `extract` step — the run reached a dashboard " +
        "but never captured a credential. The skill cannot be replayed " +
        "to produce a credential.",
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  return { kind: "ok", steps };
}

// Returns { step: null } for kinds the synthesizer intentionally drops
// (done, wait, login). Returns a rejection for kinds we can't translate.
function translateStep(
  observed: PostVerifyStep,
  inventory: readonly InteractiveElement[],
  provenance: SkillStepProvenance,
  roundIndex: number,
  roundHtml: string,
): { kind: "ok"; step: SkillStep | null } | PromoteRejection {
  switch (observed.kind) {
    case "done":
    case "wait":
    case "login":
      // These are flow-control kinds the bot's planner emits; they
      // don't translate to replay steps. The replay engine doesn't
      // need them — it executes the graph linearly and stops when it
      // hits a credential.
      return { kind: "ok", step: null };

    case "navigate":
      return {
        kind: "ok",
        step: { kind: "navigate", url: observed.url, provenance },
      };

    case "click": {
      const hintResult = resolveClickHint(observed.selector, inventory, roundIndex);
      if (hintResult.kind !== "ok") return hintResult;

      // OAuth button detection: if the matched element's text mentions
      // a known provider AND we haven't already navigated to that
      // provider's auth host, emit a click_oauth_button instead. The
      // distinction matters because the replay engine handles OAuth
      // clicks specially (checks loggedInProviders before clicking).
      const oauthProvider = detectOAuthProvider(hintResult.hint);
      if (oauthProvider !== null) {
        return {
          kind: "ok",
          step: {
            kind: "click_oauth_button",
            provider: oauthProvider,
            text_match: hintResult.hint,
            provenance,
          },
        };
      }

      return {
        kind: "ok",
        step: {
          kind: "click",
          text_match: hintResult.hint,
          ...(hintResult.role_hint !== undefined ? { role_hint: hintResult.role_hint } : {}),
          provenance,
        },
      };
    }

    case "fill": {
      const hintResult = resolveLabelHint(observed.selector, inventory, roundIndex);
      if (hintResult.kind !== "ok") return hintResult;
      // rc.17 — if the captured value looks like the unique-name
      // shape the rc.15 planner prompt told the bot to use
      // (e.g. "agent-zp9q", "ts-x9k2", "mcp-a3b9c2f1"), templatize
      // it to ${TOKEN_NAME} so each replay generates a fresh name.
      // Without this, every promoted skill bakes in the literal
      // name from its capture run — and the very next replay fails
      // at the credential-creating click because that name now
      // already exists on the service (Railway's silent duplicate-
      // name rejection was the canonical case).
      const literal = observed.value;
      const looksGenerated = /^[a-z]{3,15}-[a-z0-9]{4,12}$/.test(literal);
      const valueTemplate = looksGenerated ? "${TOKEN_NAME}" : literal;
      return {
        kind: "ok",
        step: {
          kind: "fill",
          label_hint: hintResult.hint,
          value_template: valueTemplate,
          provenance,
        },
      };
    }

    case "select": {
      const hintResult = resolveLabelHint(observed.selector, inventory, roundIndex);
      if (hintResult.kind !== "ok") return hintResult;
      // `option_text` is optional in PostVerifyStep — the planner may
      // emit a `select` step without specifying which option to pick.
      // The skill schema requires it (the replay engine needs to know
      // what to click). Reject when missing — the operator should
      // re-capture or hand-edit the skill.
      if (observed.option_text === undefined || observed.option_text.length === 0) {
        return {
          kind: "rejected",
          stage: "synthesis",
          error_kind: "missing_text_hint",
          message:
            `Captured 'select' step at round ${roundIndex} has no option_text. ` +
            `The replay engine cannot determine which option to select. ` +
            `Re-capture with a tighter planner prompt or hand-edit the skill.`,
          offending_round: roundIndex,
          synthesizer_version: SYNTHESIZER_VERSION,
        };
      }
      return {
        kind: "ok",
        step: {
          kind: "select",
          label_hint: hintResult.hint,
          option_text: observed.option_text,
          provenance,
        },
      };
    }

    case "check": {
      // `check` translates to a click on the checkbox — replay engine
      // handles the styled-checkbox case via browser.check internally.
      // We don't model a separate kind because skills target visible
      // intent ("agree to ToS"), not browser primitives.
      const hintResult = resolveClickHint(observed.selector, inventory, roundIndex);
      if (hintResult.kind !== "ok") return hintResult;
      return {
        kind: "ok",
        step: {
          kind: "click",
          text_match: hintResult.hint,
          provenance,
        },
      };
    }

    case "scroll":
      // Scroll-to-bottom is a flow-control action like done; the
      // replay engine knows to scroll modals into view automatically
      // when a subsequent click can't reach its target.
      return { kind: "ok", step: null };

    case "extract":
      return synthesizeExtractStep(observed, inventory, provenance, roundIndex, roundHtml);

    default: {
      // Exhaustiveness check. TypeScript narrows `observed` to `never`
      // here when every PostVerifyStep variant is covered above. If
      // PostVerifyStep grows a new kind, the `_exhaustive: never`
      // assignment fails at compile time — a forcing function to
      // update this switch. The runtime branch only fires when a
      // malformed capture file slips past Zod parsing with an
      // unrecognised `kind`.
      const _exhaustive: never = observed;
      const unknownKind = (_exhaustive as unknown as { kind: string }).kind;
      return {
        kind: "rejected",
        stage: "synthesis",
        error_kind: "unsupported_step_kind",
        message: `Capture contains a step kind the synthesizer does not handle: ${unknownKind}`,
        offending_round: roundIndex,
        synthesizer_version: SYNTHESIZER_VERSION,
      };
    }
  }
}

// ── Text-match resolution ────────────────────────────────────────────
//
// A click step needs a `text_match` that uniquely identifies the
// target element on the page. The captured PostVerifyStep has the raw
// selector that resolved at capture time; we look up the matching
// inventory entry and pull its visible text. If the same text appears
// on multiple inventory elements, the match is ambiguous and we
// reject — the user needs to add a more specific capture (which they
// can do by re-running the bot with a tighter scope_hint), rather
// than have the replay engine guess at runtime.

interface ClickHintOk {
  kind: "ok";
  hint: string;
  role_hint?: "button" | "link" | "tab" | "menuitem";
}

function resolveClickHint(
  selector: string,
  inventory: readonly InteractiveElement[],
  roundIndex: number,
): ClickHintOk | PromoteRejection {
  const match = inventory.find((e) => e.selector === selector);
  if (match === undefined) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "inventory_entry_not_found",
      message:
        `Captured click selector ${JSON.stringify(selector)} does not appear in this round's inventory. ` +
        `The capture is inconsistent — either the inventory was stale or the planner invented a selector.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  const hint = pickClickText(match);
  if (hint === null) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "missing_text_hint",
      message:
        `Inventory element at ${JSON.stringify(selector)} has no visibleText / ariaLabel — ` +
        `cannot synthesize a text-based replay hint. Consider expanding inventory capture to ` +
        `include innerText, or skip this capture.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Ambiguity check: does this exact hint resolve to more than one
  // element in this round? If yes, the replay engine will need a
  // disambiguator we don't have. Reject so the operator can either
  // re-capture with a better-scoped page or hand-edit the skill.
  const duplicates = inventory.filter(
    (e) => pickClickText(e) === hint && e.selector !== selector,
  );
  if (duplicates.length > 0) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "ambiguous_text_match",
      message:
        `Text hint ${JSON.stringify(hint)} matches ${duplicates.length + 1} elements in this round's inventory. ` +
        `Cannot uniquely identify the click target by text. Either the page genuinely has multiple ` +
        `same-named controls (skill needs hand-editing with a role_hint or near_text_hint) or the ` +
        `capture saw a transient state with duplicate labels.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  const role = inferRoleHint(match);
  const result: ClickHintOk = { kind: "ok", hint };
  if (role !== undefined) result.role_hint = role;
  return result;
}

function pickClickText(el: InteractiveElement): string | null {
  // Prefer visibleText (what humans read); fall back to ariaLabel for
  // icon-only buttons. Trim and drop empty strings.
  const text = (el.visibleText ?? el.ariaLabel ?? "").trim();
  if (text.length === 0) return null;
  // Truncate exceptionally long text — a 500-char button label is
  // almost certainly a paragraph picked up by the inventory scraper.
  // Cap at 80 chars; the replay engine matches by substring so the
  // first 80 chars are plenty for disambiguation.
  return text.length > 80 ? text.slice(0, 80) : text;
}

function inferRoleHint(
  el: InteractiveElement,
): "button" | "link" | "tab" | "menuitem" | undefined {
  if (el.tag === "button" || el.role === "button") return "button";
  if (el.tag === "a" || el.role === "link") return "link";
  if (el.role === "tab") return "tab";
  if (el.role === "menuitem") return "menuitem";
  return undefined;
}

interface LabelHintOk {
  kind: "ok";
  hint: string;
}

function resolveLabelHint(
  selector: string,
  inventory: readonly InteractiveElement[],
  roundIndex: number,
): LabelHintOk | PromoteRejection {
  const match = inventory.find((e) => e.selector === selector);
  if (match === undefined) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "inventory_entry_not_found",
      message:
        `Captured fill/select selector ${JSON.stringify(selector)} does not appear in this round's inventory.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Resolution order for fill/select: matching <label for=> text,
  // then placeholder, then aria-label, then the nearest preceding
  // visible text. Inventory carries the first three directly; the
  // bot's element-extraction logic already does the <label for=>
  // matching, so labelText is authoritative when present.
  const hint =
    (match.labelText ?? match.placeholder ?? match.ariaLabel ?? "")
      .trim();
  if (hint.length === 0) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "missing_text_hint",
      message:
        `Inventory element at ${JSON.stringify(selector)} has no labelText / placeholder / ariaLabel — ` +
        `cannot synthesize a fill/select label hint.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Ambiguity check — same as click resolver.
  const duplicates = inventory.filter(
    (e) =>
      e.selector !== selector &&
      (e.labelText?.trim() === hint ||
        e.placeholder?.trim() === hint ||
        e.ariaLabel?.trim() === hint),
  );
  if (duplicates.length > 0) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "ambiguous_text_match",
      message:
        `Label hint ${JSON.stringify(hint)} matches ${duplicates.length + 1} input/select elements. ` +
        `Cannot uniquely identify the fill target by label.`,
      offending_round: roundIndex,
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  return { kind: "ok", hint };
}

// ── Extract step + credential spec inference ─────────────────────────

function synthesizeExtractStep(
  observed: Extract<PostVerifyStep, { kind: "extract" }>,
  inventory: readonly InteractiveElement[],
  provenance: SkillStepProvenance,
  roundIndex: number,
  roundHtml: string,
): { kind: "ok"; step: SkillStep } | PromoteRejection {
  // Strategy: prefer extract_via_copy_button when a Copy button is
  // visibly available on the same page. The clipboard path is regex-
  // free and survives the Railway-class bug (bare UUIDs the regex
  // library doesn't recognize). Fall back to extract_via_regex with
  // a UUID pattern by default — the most permissive named pattern.
  const copyButton = findCopyButton(inventory);
  if (copyButton !== null) {
    const near = pickNearTextHint(copyButton, observed.reason);
    return {
      kind: "ok",
      step: {
        kind: "extract_via_copy_button",
        near_text_hint: near,
        provenance,
      },
    };
  }

  // No Copy button. Use a regex extraction. The pattern_name picked
  // here decides which regex the replay engine fires at extract time;
  // if it's wrong (e.g. uuid_token for IPInfo's 14-char opaque key),
  // the replay can never find the value. detectKnownCredentialPattern
  // scans the captured page text for the actual credential and picks
  // the matching named pattern. Falls back to uuid_token only when no
  // recognized prefix or UUID is on the page — the historical default,
  // preserved for sites whose key has no distinguishing prefix that
  // happens to also not be a UUID (rare; operator hand-edits).
  const detected = detectKnownCredentialPattern(roundHtml);
  return {
    kind: "ok",
    step: {
      kind: "extract_via_regex",
      pattern_name: detected,
      provenance,
    },
  };
  void roundIndex;
}

// Scan the captured HTML for a credential value matching any of the
// patterns the replay engine's extractApiKeyFromText knows about.
// Returns the matching pattern_name; falls back to "uuid_token"
// when nothing recognizable is on the page (the historical default).
//
// Order matters — sk-or-v1- before sk- because both could match the
// same string and we want the more-specific one to win, matching
// agent.ts's extractApiKeyFromText order.
function detectKnownCredentialPattern(
  html: string,
): "stripe_secret" | "stripe_publishable" | "resend" | "sendgrid" | "mailgun" | "render" | "sentry_token" | "openrouter" | "anthropic" | "openai_legacy" | "openai_project" | "uuid_token" {
  if (/\bre_[a-zA-Z0-9_]{20,}\b/.test(html)) return "resend";
  if (/\bsk_(?:live|test)_[a-zA-Z0-9]{20,}\b/.test(html)) return "stripe_secret";
  if (/\bsk-or-v1-[a-f0-9]{40,80}/i.test(html)) return "openrouter";
  if (/\bsk-ant-[a-zA-Z0-9_-]{40,120}/.test(html)) return "anthropic";
  if (/\bsk-proj-[a-zA-Z0-9_-]{40,200}/.test(html)) return "openai_project";
  if (/\bsk-[a-zA-Z0-9]{40,60}/.test(html)) return "openai_legacy";
  if (/\bkey-[a-f0-9]{32}\b/.test(html)) return "mailgun";
  if (/\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\b/.test(html)) return "sendgrid";
  if (/\brnd_[a-zA-Z0-9]{20,}\b/.test(html)) return "render";
  if (/\bsntry[su]_[A-Za-z0-9_=\-]{20,}/.test(html)) return "sentry_token";
  // UUID — Railway-class flows. Last among prefixed checks because a
  // UUID can co-appear with prefixed keys on the same page (e.g. a
  // dashboard showing a key plus a request-id).
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(html)) {
    return "uuid_token";
  }
  // No known prefix and no UUID. Default to uuid_token so the schema
  // accepts the skill — replay engine's rc.8 fallback path will pick
  // the value up via extractCredentialCandidates if the validator is
  // set tightly enough (and the synthesizer DOES set it tightly when
  // it observed a short alphanumeric below).
  return "uuid_token";
}

function findCopyButton(
  inventory: readonly InteractiveElement[],
): InteractiveElement | null {
  for (const el of inventory) {
    // rc.19 — also include title (icon-only buttons like Railway's
    // "Copy Code" modal button carry the label there) and iconLabel
    // (which folds in descendant SVG/img alt/aria-label). Without
    // this, the synthesizer picks extract_via_regex for Railway-
    // class flows, then the replay's regex library can't match a
    // bare UUID and the skill replay-fails forever.
    const text = `${el.visibleText ?? ""} ${el.ariaLabel ?? ""} ${el.title ?? ""} ${el.iconLabel ?? ""}`.trim();
    // Same vocabulary as agent.ts:tryCopyButtonExtraction.
    if (/^\s*copy(?:\b|\s|$)|copy\s+(?:api\s*key|secret|token|code|key|to\s+clipboard)\b/i.test(text)) {
      return el;
    }
  }
  // rc.29 — selector-based fallback. Modern dashboards ship icon-only
  // copy buttons with NO text/aria-label/title/iconLabel (IPInfo's
  // dashboard is the canonical case — every text signal is empty,
  // the copy affordance is purely visual). When the vocabulary pass
  // above finds nothing, walk the inventory again looking at the
  // *selector* — which captures CSS classes and IDs in the path. A
  // class/id containing "copy" is a strong signal for a copy button
  // even when no label survives. False positives are bounded: a
  // signup flow doesn't ship many elements named ".copy-…" outside
  // of clipboard affordances.
  for (const el of inventory) {
    if (el.tag !== "button" && el.role !== "button") continue;
    // Walks tag/class/id/data-* in the captured selector. Pattern:
    // a word boundary on either side of "copy" in any case, in any
    // CSS segment. Excludes "policy", "copyright", "copywriter" by
    // requiring "copy" be either standalone or followed by
    // separator characters that CSS class/id naming uses.
    if (/(?:^|[\s.#\[])copy(?:[\s.\-_\]]|$)/i.test(el.selector)) {
      return el;
    }
  }
  return null;
}

function pickNearTextHint(
  copyButton: InteractiveElement,
  observedReason: string,
): string {
  // The Copy button's own text is a poor hint — every credential
  // modal has a "Copy" button. We want the *nearby* heading or label
  // that disambiguates ("New Token" vs "Project ID"). The observed
  // reason field from the planner often quotes the surrounding text;
  // we use it as a hint source. Fall back to the copy button's
  // visible text when nothing better is available.
  const reasonText = observedReason.trim();
  if (reasonText.length > 0 && reasonText.length <= 120) {
    // Extract section-heading-like phrases from the planner's reason.
    // Common patterns: "in the 'New Token' section", "under 'New Token'",
    // "after creation". We pull the first quoted phrase if any.
    const quoted = /['"]([^'"]{3,40})['"]/.exec(reasonText);
    if (quoted !== null && quoted[1] !== undefined) return quoted[1];
  }
  const fallback = (copyButton.visibleText ?? copyButton.ariaLabel ?? "Copy").trim();
  return fallback.length > 0 ? fallback : "Copy";
}

interface CredentialSpecOk {
  kind: "ok";
  spec: SkillCredentialSpec;
}

function inferCredentialSpec(
  rounds: OnboardingCaseFile[],
  steps: SkillStep[],
  service: string,
  envVarOverride?: string,
): CredentialSpecOk | PromoteRejection {
  const extractStep = steps.find(
    (s) => s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
  );
  if (extractStep === undefined) {
    return {
      kind: "rejected",
      stage: "synthesis",
      error_kind: "credential_spec_inference_failed",
      message:
        "No extract step found while inferring credential spec. " +
        "This is a synthesizer invariant violation — synthesizeSteps " +
        "should have rejected upstream.",
      synthesizer_version: SYNTHESIZER_VERSION,
    };
  }

  // Determine the credential shape. For extract_via_regex steps, the
  // pattern name maps to a known shape_hint. For extract_via_copy_button
  // steps, we scan the page text in the extract round and try to
  // pattern-match against the credential library; if nothing matches,
  // default to "opaque" — the operator can hand-edit the validator to
  // tighten it.
  const shapeHint = inferShapeHint(extractStep, rounds);

  const envVar = envVarOverride ?? deriveEnvVar(service);

  // Validator ranges per shape_hint. Tight ranges keep the replay
  // engine's rc.8 candidate-fallback path from accepting wrong-shaped
  // strings as credentials. For shapes where the value's length is
  // service-defined, we use the typical-observed range; the operator
  // can hand-edit if a service's keys turn out to be wider than the
  // default. A sentinel_http_check is NOT auto-populated — that would
  // require knowing the service's /whoami URL, which the synthesizer
  // can't infer. Operators set it via skill:edit (C5).
  const validator = validatorForShape(shapeHint, rounds);
  const spec: SkillCredentialSpec = {
    type: "api_key",
    shape_hint: shapeHint,
    env_var_suggestion: envVar,
    post_extract_validator: validator,
  };
  return { kind: "ok", spec };
}

function validatorForShape(
  shape: SkillCredentialSpec["shape_hint"],
  rounds: OnboardingCaseFile[],
): { min_length: number; max_length: number } {
  switch (shape) {
    case "uuid":
      return { min_length: 36, max_length: 36 };
    case "prefix:re_":
      return { min_length: 24, max_length: 64 };
    case "prefix:sk_live":
    case "prefix:sk_test":
      return { min_length: 28, max_length: 128 };
    case "prefix:sk-or-v1-":
      return { min_length: 30, max_length: 120 };
    case "prefix:sk-ant-":
      return { min_length: 60, max_length: 200 };
    case "prefix:sk-":
      return { min_length: 40, max_length: 80 };
    case "prefix:key-":
      return { min_length: 36, max_length: 40 };
    case "prefix:SG.":
      return { min_length: 50, max_length: 100 };
    case "prefix:rnd_":
      return { min_length: 28, max_length: 64 };
    case "prefix:sntry":
      return { min_length: 30, max_length: 200 };
    case "opaque":
      // Opaque means: no recognized prefix or UUID, but we still
      // landed on a credential page. Use the last-round HTML to find
      // the most-likely value's length. IPInfo's 14-char API token
      // is the canonical case. Fall back to a wide range if no
      // value can be inferred (rare).
      return inferOpaqueValidatorFromHtml(rounds) ?? { min_length: 8, max_length: 64 };
    case "username_password":
      return { min_length: 8, max_length: 256 };
  }
}

// Scan the last round's HTML for short alphanumeric tokens that look
// like credentials (digits + letters, no surrounding label glue
// detectable). Pick the longest plausible candidate's length to
// anchor the validator's range. Returns null when nothing plausibly
// credential-shaped is found.
function inferOpaqueValidatorFromHtml(
  rounds: OnboardingCaseFile[],
): { min_length: number; max_length: number } | null {
  const html = rounds[rounds.length - 1]?.state.html ?? "";
  // Look for "API Token" / "Token" / "API Key" label followed by an
  // alphanumeric run of 8-64 chars. The replay engine's
  // extractCredentialCandidates fallback uses validator length to
  // filter, so we want a tight ±2-char range around the observed
  // length to keep nav strings ("Dashboard", "Downloads") out.
  const labeled = /(?:API[\s_-]?Token|API[\s_-]?Key|Token|Secret)\s*[:=]?\s*([a-zA-Z0-9_-]{8,64})/i.exec(html);
  if (labeled !== null && labeled[1] !== undefined) {
    const len = labeled[1].length;
    return { min_length: Math.max(8, len - 2), max_length: len + 2 };
  }
  return null;
}

function inferShapeHint(
  extractStep: SkillStep,
  rounds: OnboardingCaseFile[],
): SkillCredentialSpec["shape_hint"] {
  if (extractStep.kind === "extract_via_regex") {
    // Map pattern name → shape hint. Closed enum so we cover every
    // pattern_name value.
    switch (extractStep.pattern_name) {
      case "resend":
        return "prefix:re_";
      case "stripe_secret":
        return "prefix:sk_live"; // best guess; live is the dominant production case
      case "stripe_publishable":
        return "opaque"; // publishable keys aren't extracted by the universal bot
      case "sendgrid":
        return "prefix:SG.";
      case "mailgun":
        return "prefix:key-";
      case "render":
        return "prefix:rnd_";
      case "sentry_token":
        return "prefix:sntry";
      case "openrouter":
        return "prefix:sk-or-v1-";
      case "anthropic":
        return "prefix:sk-ant-";
      case "openai_legacy":
        return "prefix:sk-";
      case "openai_project":
        return "prefix:sk-";
      case "uuid_token": {
        // uuid_token is the synthesizer's fallback when no recognized
        // prefix was found in the HTML. Two sub-cases:
        //   1. UUID actually present (Railway-class) → shape "uuid"
        //   2. No UUID present (IPInfo-class opaque short token) →
        //      shape "opaque" so the validator isn't forced to 36/36
        //      and inferOpaqueValidatorFromHtml picks the observed
        //      length range. The replay engine's rc.8 candidate
        //      fallback then uses that validator to find the value.
        const html = rounds[rounds.length - 1]?.state.html ?? "";
        if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(html)) {
          return "uuid";
        }
        return "opaque";
      }
    }
  }

  // extract_via_copy_button: scan the latest round's HTML for a known
  // prefix or a UUID. UUID detection is the dominant case for novel
  // services since they hit the copy-button path precisely because
  // they don't have a recognizable prefix.
  const lastRound = rounds[rounds.length - 1]!;
  const html = lastRound.state.html;
  if (/\bre_[a-zA-Z0-9_]{20,}/.test(html)) return "prefix:re_";
  if (/\bsk_live_/.test(html)) return "prefix:sk_live";
  if (/\bsk_test_/.test(html)) return "prefix:sk_test";
  if (/\bsk-or-v1-/.test(html)) return "prefix:sk-or-v1-";
  if (/\bsk-ant-/.test(html)) return "prefix:sk-ant-";
  if (/\bsk-[a-zA-Z0-9]{40,}/.test(html)) return "prefix:sk-";
  if (/\bkey-[a-f0-9]{32}/.test(html)) return "prefix:key-";
  if (/\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}/.test(html)) return "prefix:SG.";
  if (/\brnd_[a-zA-Z0-9]{20,}/.test(html)) return "prefix:rnd_";
  if (/\bsntry[su]_/.test(html)) return "prefix:sntry";
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(html)) {
    return "uuid";
  }
  return "opaque";
}

// ── OAuth provider detection ─────────────────────────────────────────

function detectOAuthProvider(hint: string): "google" | "github" | null {
  const lower = hint.toLowerCase();
  // Word-boundary match prevents "Foogle" or "GitTub" false positives.
  if (/\bgoogle\b/.test(lower)) return "google";
  if (/\bgithub\b/.test(lower)) return "github";
  return null;
}

function inferOAuthProvider(steps: SkillStep[]): "google" | "github" | null {
  // The first click_oauth_button step's provider wins. If there isn't
  // one, the signup is email/password (null).
  for (const step of steps) {
    if (step.kind === "click_oauth_button") return step.provider;
  }
  return null;
}

// ── Multi-credential upgrade (Phase C) ──────────────────────────────
//
// Post-pass that takes the single-cred output of synthesizeSteps and
// promotes it into multi-cred shape when the capture has >1 extract
// rounds. The single-cred path skips this entirely — `upgradeToMultiCred`
// is only called when extract-step count > 1.
//
// For each extract step:
//   1. Derive a `produces` name from its near_text_hint (or pattern_name
//      for regex extracts) — lowercase_snake_case.
//   2. Replace the step kind with its `_named` counterpart.
//   3. Build a SkillCredentialSpec per `produces`, with name +
//      service-aware env var (TWITTER_API_KEY_SECRET etc.).
//
// Rejects on:
//   - duplicate_credential_produces: two steps derived the same name
//   - unparseable_credential_label: a hint reduced to empty after norm

interface MultiCredOk {
  kind: "ok";
  steps: SkillStep[];
  credentials: SkillCredentialSpec[];
}

function upgradeToMultiCred(
  inputSteps: SkillStep[],
  rounds: OnboardingCaseFile[],
  service: string,
): MultiCredOk | PromoteRejection {
  const seen = new Set<string>();
  const outSteps: SkillStep[] = [];
  const credentialsByName = new Map<string, SkillCredentialSpec>();

  for (let i = 0; i < inputSteps.length; i++) {
    const step = inputSteps[i]!;

    if (step.kind === "extract_via_copy_button") {
      const produces = deriveProducesFromHint(step.near_text_hint);
      if (produces === null) {
        return {
          kind: "rejected",
          stage: "synthesis",
          error_kind: "unparseable_credential_label",
          message:
            `Extract step at index ${i} has a hint (${JSON.stringify(step.near_text_hint)}) ` +
            `that doesn't normalize to a usable credential name. ` +
            `Multi-credential skills require each extract to name what it produces.`,
          offending_step: i,
          synthesizer_version: SYNTHESIZER_VERSION,
        };
      }
      if (seen.has(produces)) {
        return {
          kind: "rejected",
          stage: "synthesis",
          error_kind: "duplicate_credential_produces",
          message:
            `Two extract steps derived the same credential name ` +
            `(${JSON.stringify(produces)}). A multi-credential skill ` +
            `must produce N distinctly-named values; relabel the capture or ` +
            `re-run the signup so each credential gets a unique near-text hint.`,
          offending_step: i,
          synthesizer_version: SYNTHESIZER_VERSION,
        };
      }
      seen.add(produces);
      outSteps.push({
        kind: "extract_via_copy_button_named",
        near_text_hint: step.near_text_hint,
        produces,
        provenance: step.provenance,
      });
      credentialsByName.set(
        produces,
        buildCredentialSpecForMulti(produces, "opaque", service),
      );
      continue;
    }

    if (step.kind === "extract_via_regex") {
      // Regex extracts on a multi-cred page derive `produces` from the
      // pattern_name (e.g. "stripe_secret" → "stripe_secret"). The
      // pattern_name is already snake_case and unique per credential
      // type, so it's a natural identifier.
      const produces = step.pattern_name.toLowerCase();
      if (seen.has(produces)) {
        return {
          kind: "rejected",
          stage: "synthesis",
          error_kind: "duplicate_credential_produces",
          message:
            `Two extract steps target the same regex pattern (` +
            `${produces}). Multi-credential extracts must use distinct ` +
            `patterns; if two credentials share a shape, switch one to ` +
            `a copy_button extraction with a distinguishing near-text hint.`,
          offending_step: i,
          synthesizer_version: SYNTHESIZER_VERSION,
        };
      }
      seen.add(produces);
      outSteps.push({
        kind: "extract_via_regex_named",
        pattern_name: step.pattern_name,
        produces,
        provenance: step.provenance,
      });
      // Shape hint follows the pattern's known prefix.
      const shape = patternToShapeHint(step.pattern_name);
      credentialsByName.set(
        produces,
        buildCredentialSpecForMulti(produces, shape, service),
      );
      continue;
    }

    // Non-extract steps pass through unchanged.
    outSteps.push(step);
  }

  // Capture rounds + ordering preserved so a future caller can correlate
  // step index → round (used by the in-flight schema validator later).
  void rounds;

  return {
    kind: "ok",
    steps: outSteps,
    credentials: Array.from(credentialsByName.values()),
  };
}

// Normalize a free-text credential label into a snake_case `produces`
// identifier. "API Key Secret" → "api_key_secret". Returns null when
// the result is empty or doesn't start with a letter (the schema
// requires `^[a-z][a-z0-9_]*$`).
function deriveProducesFromHint(hint: string): string | null {
  const normalized = hint
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) return null;
  if (!/^[a-z]/.test(normalized)) return null;
  // The schema regex allows only [a-z][a-z0-9_]*. Filter again for safety;
  // any character that slipped through means a unicode edge case.
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) return null;
  // Truncate to a reasonable length — avoid pathological inputs producing
  // 200-char `produces` names.
  return normalized.slice(0, 64);
}

function patternToShapeHint(patternName: string): SkillCredentialSpec["shape_hint"] {
  switch (patternName) {
    case "stripe_secret":
      return "prefix:sk_live";
    case "stripe_publishable":
      return "prefix:sk_live";
    case "resend":
      return "prefix:re_";
    case "sendgrid":
      return "prefix:SG.";
    case "mailgun":
      return "prefix:key-";
    case "render":
      return "prefix:rnd_";
    case "sentry_token":
      return "prefix:sntry";
    case "openrouter":
      return "prefix:sk-or-v1-";
    case "anthropic":
      return "prefix:sk-ant-";
    case "openai_legacy":
      return "prefix:sk-";
    default:
      return "opaque";
  }
}

function buildCredentialSpecForMulti(
  name: string,
  shape: SkillCredentialSpec["shape_hint"],
  service: string,
): SkillCredentialSpec {
  // Env var: <SERVICE>_<PRODUCES>. Twitter + api_key_secret →
  // TWITTER_API_KEY_SECRET. Maintains the "<SERVICE>_<CRED>" convention
  // and disambiguates the multiple credentials in a multi-cred bundle.
  const upperService = service.toUpperCase().replace(/-/g, "_");
  const upperName = name.toUpperCase();
  const envVar = `${upperService}_${upperName}`;
  return {
    name,
    type: "api_key",
    shape_hint: shape,
    env_var_suggestion: envVar,
    post_extract_validator: {
      min_length: shape === "uuid" ? 36 : 16,
      max_length: shape === "uuid" ? 36 : 512,
    },
  };
}

// ── Deterministic helpers ────────────────────────────────────────────

function deriveEnvVar(service: string): string {
  // Convention: <SERVICE>_API_KEY. Service slug is lowercase-with-
  // dashes; convert to UPPER_SNAKE_CASE.
  const upper = service.toUpperCase().replace(/-/g, "_");
  return `${upper}_API_KEY`;
}

function deriveTimestampFromRounds(rounds: OnboardingCaseFile[]): string {
  // Use the chain head's content_hash as a deterministic seed for
  // created_at. We can't read a real timestamp from the capture
  // (it isn't in the schema), but tests need determinism. Hash the
  // last round's content_hash and project into the year 2026.
  const seed = rounds[rounds.length - 1]!.content_hash;
  const hash = createHash("sha256").update(seed).digest("hex");
  // Take 8 hex chars → 32-bit int → ms offset within 2026.
  const offsetMs = parseInt(hash.slice(0, 8), 16) % (365 * 24 * 60 * 60 * 1000);
  return new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();
}

export function deriveSkillId(candidate: Omit<Skill, "skill_id">): string {
  // Skill IDs are ULID-shaped. We derive a deterministic 26-char
  // string from the candidate's hash so that the same captures
  // produce the same skill_id across runs (test determinism +
  // registry-side idempotency).
  //
  // ULID alphabet: Crockford Base32 — 0-9 then A-Z minus I, L, O, U.
  const json = JSON.stringify(candidate);
  const hash = createHash("sha256").update(json).digest();
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) {
    out += alphabet[hash[i % hash.length]! % alphabet.length];
  }
  return out;
}

function chainRejectionMessage(
  reason: string,
  offendingRound: number | undefined,
): string {
  const where = offendingRound !== undefined ? ` at round ${offendingRound}` : "";
  switch (reason) {
    case "unknown_version":
      return `Capture format version is not supported by this synthesizer (v${SYNTHESIZER_VERSION})${where}.`;
    case "hash_mismatch":
      return `Capture content hash does not match the stored value${where}. The capture has been modified after writing — refusing to synthesize.`;
    case "prev_hash_mismatch":
      return `Capture chain is broken${where}: this round's prev_hash does not match the previous round's content_hash.`;
    case "missing_round":
      return `Capture chain has a gap${where}: a round is missing from the sequence.`;
    case "no_rounds":
      return "No capture rounds found for this (service, run_id) — nothing to synthesize.";
    case "parse_error":
      return `Capture file could not be parsed as JSON${where}.`;
    default:
      return `Chain verification failed: ${reason}.`;
  }
}
