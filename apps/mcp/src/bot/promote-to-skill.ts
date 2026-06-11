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
} from "@trusty-squire/skill-schema";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";
import { extractAllLabeledTokensFromReason } from "./agent.js";
import {
  verifyCaptureChain,
  type OnboardingCaseFile,
} from "./onboarding-capture.js";
import { filterByNearTextHint } from "./near-text-hint.js";

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
  /**
   * Starting status for the synthesized skill. Defaults to
   * `pending-review` (the two-tier registry's staging slot): the
   * verifier worker flips it to `active` after N=2 fresh signups
   * pass against the captured selectors. Callers pass `active`
   * only when explicitly bypassing the verifier — `mcp skill
   * promote --skip-verifier`.
   */
  status?: "pending-review" | "active";
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
  // Generalize per-run session params out of the captured entry URL so a stale
  // session token (kinde-class psid=, redirect_to=) doesn't make replay's first
  // navigation dead.
  const firstRound = verification.rounds[0]!;
  // Pick the entry URL for signup_url. When the capture passed through an
  // OAuth identity provider, round 0's URL can land on the provider's own
  // domain (e.g. accounts.google.com / myaccount.google.com — the bot
  // deliberately navigates to the Google app root so the service routes
  // it back to the dashboard). That domain is NOT a valid signup entry:
  // replay's first navigation would dead-end on Google instead of the
  // service. Prefer the first captured round whose host is the service's
  // own (a non-IdP domain); fall back to round 0 only if every round is on
  // an IdP domain (shouldn't happen for a real signup).
  const entryRound =
    verification.rounds.find((r) => !isIdentityProviderUrl(r.state.url)) ??
    firstRound;
  const signupUrl = generalizeCapturedUrl(entryRound.state.url);
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
  // A6 — drop a spurious uuid_token regex extract when a copy-button
  // extract co-exists (see dropSpuriousUuidExtract). PostHog/brevo/statsig
  // class: a uuid-shaped onboarding-page value (e.g. a project_id) got
  // captured as a second "credential" next to the real copy-button key,
  // and upgradeToMultiCred made both required → replay hard-fails on a
  // fresh account.
  stepsResult.steps = dropSpuriousUuidExtract(stepsResult.steps);

  const extractStepIndices = stepsResult.steps
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        s.kind === "extract_via_copy_button" || s.kind === "extract_via_regex",
    );
  const multiCred = extractStepIndices.length > 1;
  // Phase-E label-scoped multi-cred: each extract_labeled step already
  // names the credential it produces (distinct produces guaranteed by
  // collapseRedundantExtracts). Build one spec per distinct produces —
  // no upgradeToMultiCred pass (that's for the copy_button/regex shape).
  const labeledSteps = stepsResult.steps.filter(
    (s): s is Extract<SkillStep, { kind: "extract_labeled" }> =>
      s.kind === "extract_labeled",
  );
  let steps: SkillStep[] = stepsResult.steps;
  let credentials: SkillCredentialSpec[];

  if (labeledSteps.length > 0) {
    // The label-scoped extracts are the authoritative multi-cred surface.
    // Drop any stray single-cred extract_via_copy_button/regex steps — a
    // round whose reason named only one credential fell to the legacy
    // path, but that value is already covered by a labeled step (Algolia's
    // admin_api_key shows up both ways). Leaving it would orphan an
    // unnamed extract with no credential spec in the bundle.
    steps = stepsResult.steps.filter(
      (s) => s.kind !== "extract_via_copy_button" && s.kind !== "extract_via_regex",
    );
    const seen = new Set<string>();
    const specs: SkillCredentialSpec[] = [];
    for (const s of labeledSteps) {
      if (seen.has(s.produces)) continue;
      seen.add(s.produces);
      specs.push(buildCredentialSpecForMulti(s.produces, "opaque", input.service));
    }
    credentials = specs;
  } else if (multiCred) {
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
    status: input.status ?? "pending-review",
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
  // 0.8.1 — soft-drop policy for intermediate click rounds. The bot's
  // planner captures every round it tried, including failed clicks on
  // disabled buttons (Cloudinary's "card radio" rows), ambiguous
  // duplicate-label clicks (PostHog's settings nav), and no-progress
  // retries against unchanged inventory. The synthesizer used to hard-
  // reject the entire skill on any of these — even when later rounds
  // recovered with a real extract step. Now: when a click/check round
  // fails text-hint resolution we DROP it and continue, recording the
  // rejection. If we never reach a clean extract we surface the
  // first dropped rejection so the operator still sees what went
  // wrong. Fill/select rounds remain hard rejections — those are
  // load-bearing (Sentry's permission grid). The replay engine
  // tolerates a sparser step graph (it walks linearly until a
  // credential surfaces); intermediate nav clicks are largely
  // re-discoverable at replay time anyway.
  let firstSoftRejection: PromoteRejection | null = null;

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
    if (translated.kind === "ok") {
      if (translated.step !== null) {
        // 0.8.2-rc.21 — dedup consecutive identical steps. The bot
        // sometimes records a single action twice in a row (the
        // planner re-evaluates an unchanged inventory and proposes
        // the same step). Captured naively, the replay engine fails
        // on the second execution because the action has already
        // been taken (e.g. selecting the workspace that's now
        // already selected). Compare structurally on everything
        // except provenance — same kind + same load-bearing fields
        // means it's the same intent.
        //
        // Extract steps are EXEMPT from dedup: on multi-cred pages
        // (Twitter-class) two consecutive copy-button extracts can
        // resolve to the same near_text_hint while sourcing
        // genuinely different credentials. The downstream
        // duplicate_credential_produces guard is the right place to
        // surface that as a synthesis error — collapsing here would
        // hide it.
        const prev = steps.length > 0 ? steps[steps.length - 1]! : null;
        const isExtract =
          translated.step.kind === "extract_via_copy_button" ||
          translated.step.kind === "extract_via_regex" ||
          translated.step.kind === "extract_via_copy_button_named" ||
          translated.step.kind === "extract_via_regex_named";
        if (prev === null || isExtract || !stepsEquivalent(prev, translated.step)) {
          steps.push(translated.step);
        }
      }
      // Multi-cred Phase-E explode emits N label-scoped extract steps for
      // one round (step is null in that case). collapseRedundantExtracts
      // dedups the repeats across rounds by `produces`.
      if (translated.steps !== undefined) {
        for (const s of translated.steps) steps.push(s);
      }
      continue;
    }
    // Soft-drop intermediate click/check rounds with text-resolution
    // failures — see the policy comment above.
    const isSoftDroppable =
      (round.observed.kind === "click" || round.observed.kind === "check") &&
      (translated.error_kind === "missing_text_hint" ||
        translated.error_kind === "ambiguous_text_match" ||
        translated.error_kind === "inventory_entry_not_found");
    if (isSoftDroppable) {
      if (firstSoftRejection === null) firstSoftRejection = translated;
      continue;
    }
    return translated;
  }

  // A valid skill needs at least one step. The bot may emit a "done"
  // round (which we drop above), so a capture with only done is
  // effectively empty.
  if (steps.length === 0) {
    // Soft-drop preserved its first rejection — surface that instead
    // of the generic no_extract_step error so the operator sees the
    // actual diagnostic.
    if (firstSoftRejection !== null) return firstSoftRejection;
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
    (s) =>
      s.kind === "extract_via_copy_button" ||
      s.kind === "extract_via_regex" ||
      s.kind === "extract_labeled",
  );
  if (!hasExtract) {
    if (firstSoftRejection !== null) return firstSoftRejection;
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

  // 0.8.3-rc.1 — strip capture-time retry sequences. When the bot's
  // planner hit a service-side validation error (Baseten / Railway:
  // "name already in use"), it filled the same input AGAIN with a
  // different value and re-clicked submit. The capture chain shows
  // the full trail; at replay time the FIRST submit succeeds because
  // each replay generates a fresh ${TOKEN_NAME}, so the retry fill
  // has no input to find (the form already closed) and the whole
  // skill step-fails.
  //
  // Heuristic: when an input-action step (fill/select/check) at index
  // N targets the same identifying field (label_hint + near_text_hint)
  // as an earlier step at index M, the path M..N-1 is the failed
  // retry path. Drop M..N-1; keep step N onward. Repeat until no
  // retry remains.
  //
  // Why this is safe: a legitimate "fill the same input twice" flow
  // doesn't exist in token-creation pages (the bot's planner never
  // emits "fill name, click somewhere unrelated, fill name again"
  // outside a retry). For confirmation-style flows that DO re-prompt
  // (password confirmation), the two inputs have DIFFERENT
  // label_hints ("Password" vs "Confirm password"), so this pass
  // doesn't fire.
  const trimmed = stripRetrySequences(steps);
  // The inline dedup in the build loop only compares each new step to the
  // last-pushed one, so it can't see duplicates that stripRetrySequences
  // makes newly-adjacent by splicing out a failed branch between them — nor
  // duplicates an older capture recorded before the inline dedup existed
  // (porter: "Create API token" ×3, synthesizer_version=null). Run a final
  // consecutive-equivalence pass so the output is order-independent. Same
  // stepsEquivalent semantics (extract kinds exempt), so multi-cred extracts
  // and legitimately-distinct steps are untouched.
  const deduped = collapseConsecutiveDuplicateSteps(trimmed);
  const collapsed = collapseRedundantExtracts(deduped);

  return { kind: "ok", steps: collapsed };
}

// Final-pass consecutive dedup. Drops a step when it's structurally equal
// (ignoring provenance) to the previous KEPT step. Mirrors the build-loop
// inline dedup but runs after stripRetrySequences, so adjacencies that pass
// creates are collapsed too. Extract kinds are exempt (stepsEquivalent returns
// false for them) — collapseRedundantExtracts owns extract dedup by produces.
export function collapseConsecutiveDuplicateSteps(steps: SkillStep[]): SkillStep[] {
  const out: SkillStep[] = [];
  for (const step of steps) {
    const prev = out.length > 0 ? out[out.length - 1]! : null;
    if (prev !== null && stepsEquivalent(prev, step)) continue;
    out.push(step);
  }
  return out;
}

// 0.8.11 — collapse redundant extract steps that name the same
// credential. The post-verify loop re-runs the extractor each round, so
// a single-credential dashboard (Convex's "Copy" auth token, Railway's
// bare-UUID key) is frequently captured as TWO `extract` rounds against
// the same page — both resolving to the same Copy button, both deriving
// the same `produces` name.
//
// Pre-0.8.11 these survived into the multi-cred dispatch (>1 extract
// step ⇒ multi-cred), which then hit `duplicate_credential_produces`
// and rejected the whole skill — so a single-cred service that happened
// to extract twice never closed the loop.
//
// Two extract steps that derive the SAME credential name ARE the same
// credential: a skill keys credentials by name, so two same-named
// values cannot coexist as distinct credentials. The synthesizer can't
// tell them apart (findCopyButton returns the first Copy button for
// both), so a valid 2-credential skill is impossible here regardless;
// collapsing to one yields a working single-cred skill instead of a
// reject. Genuinely-distinct credentials (Phase E multi-cred) get
// distinct near-text hints from the planner ⇒ distinct `produces` ⇒
// this pass leaves them untouched and the multi-cred path proceeds.
//
// Keying by derived name (not step structure) catches NON-consecutive
// duplicates too — an extract, a nav, then a re-extract — which the
// consecutive-only stepsEquivalent dedup cannot.
function collapseRedundantExtracts(steps: SkillStep[]): SkillStep[] {
  // The credential name an extract step would produce, or null for
  // non-extract steps / unparseable copy-button hints (which we leave
  // in place so the downstream unparseable_credential_label guard can
  // surface them if the capture is genuinely multi-cred).
  const producesKey = (s: SkillStep): string | null => {
    if (s.kind === "extract_via_copy_button") {
      return deriveProducesFromHint(s.near_text_hint);
    }
    if (s.kind === "extract_via_regex") {
      return s.pattern_name.toLowerCase();
    }
    if (s.kind === "extract_labeled") {
      // Phase-E rounds re-list every credential each round, so the same
      // labeled extract repeats; dedup by the credential it produces.
      return s.produces;
    }
    return null;
  };
  const seen = new Set<string>();
  const out: SkillStep[] = [];
  for (const step of steps) {
    const key = producesKey(step);
    if (key !== null) {
      if (seen.has(key)) continue; // redundant re-extraction of the same credential
      seen.add(key);
    }
    out.push(step);
  }
  return out;
}

function stripRetrySequences(steps: SkillStep[]): SkillStep[] {
  // Identity key for retry detection: kind + load-bearing target
  // fields. Two steps with the same identity refer to the same input
  // — the later one supersedes the earlier.
  // `check` PostVerifyStep translates to `click` in the skill, so
  // identity keys here only fire for `fill` and `select`. Click steps
  // are intentionally NOT keyed — same-text-button clicks in a row
  // are legitimate flow steps (e.g. consecutive "Next" buttons in a
  // multi-page wizard would each have text_match="Next").
  const identityKey = (s: SkillStep): string | null => {
    if (s.kind === "fill" || s.kind === "select") {
      return `${s.kind}|${s.label_hint}|${s.near_text_hint ?? ""}`;
    }
    return null;
  };
  const out = [...steps];
  for (let i = 1; i < out.length; i++) {
    const curKey = identityKey(out[i]!);
    if (curKey === null) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (identityKey(out[j]!) === curKey) {
        // Drop out[j..i-1] (the failed branch INCLUDING the earlier
        // input action and any intermediate steps that were undone
        // by the retry — typically the failed submit click).
        out.splice(j, i - j);
        i = j; // re-scan from the new position
        break;
      }
    }
  }
  return out;
}

// 0.8.2-rc.21 — structural equality between two skill steps, ignoring
// `provenance` (which differs per-round even when intent is identical).
// Used to dedup consecutive duplicates emitted by the synthesizer when
// the planner re-records an unchanged action.
//
// extract_* kinds NEVER dedup HERE — this is the structural
// consecutive-dedup, and collapsing redundant extracts is the dedicated
// job of collapseRedundantExtracts (which keys on derived credential
// name, not step structure, so it also catches non-consecutive
// re-extractions). Keeping extracts out of this pass means a true
// multi-cred capture with distinct hints still reaches the multi-cred
// dispatch with all its extract steps intact.
function stepsEquivalent(a: SkillStep, b: SkillStep): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind.startsWith("extract")) return false;
  // Strip provenance + JSON-compare. Cheap, exhaustive, doesn't drift
  // when SkillStep gains new fields — every new field auto-participates.
  const stripped = (s: SkillStep): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...s };
    delete out.provenance;
    return out;
  };
  return JSON.stringify(stripped(a)) === JSON.stringify(stripped(b));
}

// True when a captured `fill` is an email-verification CODE entry: the
// value is a short numeric code AND the planner's reason describes a
// verification/OTP step. Both signals are required — a 4-8 digit value
// alone could be a postal code or an all-numeric project name, and a
// "code"-mentioning reason alone could be a coupon field.
function isOtpCodeFill(observed: PostVerifyStep): boolean {
  if (observed.kind !== "fill") return false;
  const value = observed.value.trim();
  if (!/^\d{4,8}$/.test(value)) return false;
  return /\b(verif|otp|one[\s-]?time|code|2fa|mfa)\b/i.test(observed.reason);
}

// Returns { step: null } for kinds the synthesizer intentionally drops
// (done, wait, login). Returns a rejection for kinds we can't translate.
function translateStep(
  observed: PostVerifyStep,
  inventory: readonly InteractiveElement[],
  provenance: SkillStepProvenance,
  roundIndex: number,
  roundHtml: string,
): { kind: "ok"; step: SkillStep | null; steps?: SkillStep[] } | PromoteRejection {
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
        step: { kind: "navigate", url: generalizeCapturedUrl(observed.url), provenance },
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
          ...(hintResult.near_text_hint !== undefined
            ? { near_text_hint: hintResult.near_text_hint }
            : {}),
          ...(hintResult.href_hint !== undefined ? { href_hint: hintResult.href_hint } : {}),
          ...(hintResult.dom_hint !== undefined ? { dom_hint: hintResult.dom_hint } : {}),
          provenance,
        },
      };
    }

    case "fill": {
      // Email-verification (OTP) entry → an `await_email_code` step, NOT a
      // `fill`. The captured value is a 4-8 digit code the bot fetched from
      // the inbox: baking it as a literal would replay a STALE code, and the
      // OTP input is frequently unlabeled, so resolveLabelHint would
      // hard-reject `missing_text_hint` (exactly what blocked zilliz from
      // synthesizing). The await_email_code step re-fetches a fresh code at
      // replay time and finds the input heuristically. label_hint is
      // best-effort — included only when the field happens to be labeled.
      if (isOtpCodeFill(observed)) {
        const otpHint = resolveLabelHint(observed.selector, inventory, roundIndex);
        return {
          kind: "ok",
          step: {
            kind: "await_email_code",
            ...(otpHint.kind === "ok" ? { label_hint: otpHint.hint } : {}),
            provenance,
          },
        };
      }
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
      //
      // 0.8.3-rc.1 — also templatize when the INPUT CONTEXT signals
      // a token/api-key name field, regardless of the captured
      // value's shape. The rc.17 value-shape regex missed Baseten-
      // class captures where a different planner used a name like
      // "ts-random" (no digits in tail) or "ts-agent-x9k2m" (two
      // hyphens) — the synth then baked the literal, and the form's
      // duplicate-name validation kept submit disabled on every
      // replay. Recognising the input by its label/placeholder
      // ("API key name", "production-api-key") closes that gap.
      const literal = observed.value;
      const looksGenerated = /^[a-z]{3,15}-[a-z0-9]{4,12}$/.test(literal);
      const matchedInput = inventory.find((e) => e.selector === observed.selector);
      const inputLooksLikeTokenName =
        matchedInput !== undefined && looksLikeTokenNameInput(matchedInput);
      const valueTemplate =
        looksGenerated || inputLooksLikeTokenName ? "${TOKEN_NAME}" : literal;
      return {
        kind: "ok",
        step: {
          kind: "fill",
          label_hint: hintResult.hint,
          ...(hintResult.near_text_hint !== undefined
            ? { near_text_hint: hintResult.near_text_hint }
            : {}),
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
          ...(hintResult.near_text_hint !== undefined
            ? { near_text_hint: hintResult.near_text_hint }
            : {}),
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
          ...(hintResult.role_hint !== undefined ? { role_hint: hintResult.role_hint } : {}),
          ...(hintResult.near_text_hint !== undefined
            ? { near_text_hint: hintResult.near_text_hint }
            : {}),
          ...(hintResult.href_hint !== undefined ? { href_hint: hintResult.href_hint } : {}),
          ...(hintResult.dom_hint !== undefined ? { dom_hint: hintResult.dom_hint } : {}),
          provenance,
        },
      };
    }

    case "scroll":
      // Scroll-to-bottom is a flow-control action like done; the
      // replay engine knows to scroll modals into view automatically
      // when a subsequent click can't reach its target.
      return { kind: "ok", step: null };

    case "extract": {
      // Multi-cred Phase-E reason ("application_id='…' and admin_api_key='…'")
      // explodes into N label-scoped extract steps — one per credential —
      // so each lands as its own named credential. Single-cred captures
      // keep the legacy copy_button/regex path (byte-equivalence).
      const labeled = synthesizeLabeledExtractSteps(observed, roundHtml, provenance);
      if (labeled !== null) {
        return { kind: "ok", step: null, steps: labeled };
      }
      return synthesizeExtractStep(observed, inventory, provenance, roundIndex, roundHtml);
    }

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
  // 0.8.3-rc.1 — populated when the click selector's visibleText
  // collides with another element in the same round (modal-submit-
  // shares-text-with-listing-trigger; see resolveClickHint).
  near_text_hint?: string;
  // 2026-06-07 — populated for nav-link targets so the replay engine
  // can match by href-path tail (slug-tolerant) when the link's text
  // renders differently on replay. See href_hint in the click schema.
  href_hint?: string;
  // 2026-06-09 — stable name=/id= anchor, captured only when the value
  // looks human-authored. Replay prefers a unique dom_hint match over the
  // drift-prone text_match. See dom_hint in the click schema.
  dom_hint?: { name?: string; id?: string };
}

// A name/id attribute value is a useful replay anchor ONLY when it's a
// human-authored, stable identifier — not a framework-generated hash that
// changes every render (React useId ":r3:", emotion "css-1a2b3c",
// styled-components "sc-xy12", MUI "MuiButton-root-42", uuids, long hex/digit
// runs). Those would make the hint MORE brittle than the visible text, which
// is the opposite of the point. Accept short, word/dash/underscore-shaped
// tokens; reject anything that smells generated. Exported for unit tests.
export function isStableDomAttr(value: string | null): value is string {
  if (value === null) return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 40) return false;
  if (/:r[0-9a-z]+:/i.test(v)) return false; // React useId (whole or radix-embedded)
  if (/^(?:css|sc|emotion)-[0-9a-z]{4,}/i.test(v)) return false; // css-in-js
  if (/[0-9a-f]{8,}/i.test(v)) return false; // hash / uuid chunk
  if (/\d{5,}/.test(v)) return false; // long digit run (generated index)
  // Must read as a semantic identifier: letters, with optional -, _, ., digits.
  return /^[a-z][a-z0-9._-]*$/i.test(v);
}

// Capture the element's stable name/id attributes for a replay anchor, or
// undefined when neither is stable (so the click step keeps its canonical
// bytes — same additive contract as href_hint).
export function pickStableDomHint(
  el: InteractiveElement,
): { name?: string; id?: string } | undefined {
  const hint: { name?: string; id?: string } = {};
  if (isStableDomAttr(el.name)) hint.name = el.name;
  if (isStableDomAttr(el.id)) hint.id = el.id;
  return hint.name !== undefined || hint.id !== undefined ? hint : undefined;
}

// A URL path segment that can't be reproduced on a fresh account: a UUID or a
// long opaque/hex token (a created-resource id, a session id baked into a
// path). Such a segment makes an href_hint or navigate url run-specific —
// replay lands nowhere — so we generalize it out. A normal route slug
// ("dashboard", "api-keys") is NOT ephemeral and is kept. Exported for tests.
export function hasEphemeralPathSegment(path: string): boolean {
  return path.split("/").some((seg) => {
    if (seg.length === 0) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
    if (/^[0-9a-f]{24,}$/i.test(seg)) return true; // long hex blob
    return false;
  });
}

// Query params whose VALUE is a per-run session/auth token. Stripping them
// turns a captured deep link back into a stable entry replay can reproduce.
const EPHEMERAL_URL_PARAM =
  /^(psid|sid|session|session_id|sessionid|token|access_token|auth|state|code|redirect_to|continue|ticket|nonce)$/i;

// Strip per-run session params from a captured URL, byte-preserving any URL
// that has none. Used for navigate steps + the inferred signup_url so a stale
// session token doesn't make the entry navigation dead on replay.
// Hosts that belong to an OAuth identity provider, never a service's own
// signup page. A capture that passes through one mid-OAuth must not adopt
// it as signup_url — replay would navigate to the IdP instead of the
// service. Matches the host exactly or any subdomain of it.
const IDENTITY_PROVIDER_HOSTS = [
  "google.com",
  "github.com",
  "microsoftonline.com",
  "appleid.apple.com",
  "facebook.com",
  "okta.com",
  "auth0.com",
] as const;

export function isIdentityProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return IDENTITY_PROVIDER_HOSTS.some(
      (idp) => host === idp || host.endsWith(`.${idp}`),
    );
  } catch {
    return false; // relative / malformed — not an IdP entry
  }
}

export function generalizeCapturedUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (EPHEMERAL_URL_PARAM.test(key)) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url; // relative / malformed — leave it; the prepended navigate covers entry
  }
}

// The path of a link element's href (no origin / query / hash), or null
// when the element isn't a link or has no usable in-app href. Anchors
// to external/mailto/javascript hrefs are skipped — they aren't the
// in-app nav links this fallback targets. Exported for unit tests.
export function pickHrefHint(el: InteractiveElement): string | null {
  const isLink = el.tag === "a" || el.role === "link";
  if (!isLink) return null;
  const raw = (el.href ?? "").trim();
  if (raw.length === 0) return null;
  // Skip non-navigational hrefs.
  if (/^(?:mailto:|tel:|javascript:|#)/i.test(raw)) return null;
  try {
    // Resolve against a dummy origin so a relative href ("/acme/settings")
    // and an absolute one ("https://app.x.co/acme/settings") both reduce
    // to the same pathname.
    const path = new URL(raw, "https://x.invalid").pathname;
    if (path === "/" || path.length === 0) return null;
    // Drop hrefs that carry a run-specific resource id (a created-resource
    // UUID, a session blob). They can't be reproduced on a fresh account, and
    // a stale href_hint biases replay toward a dead link; the click's
    // text_match carries it instead.
    if (hasEphemeralPathSegment(path)) return null;
    return path;
  } catch {
    return null;
  }
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
  // element in this round? If yes, attempt the same near_text_hint
  // disambiguation path that resolveLabelHint uses for fill/select.
  // The baseten-modal case: the modal's "Create API key" submit
  // button collides with the listing's "Create API key" trigger
  // still rendered behind the modal. The modal's preceding inventory
  // (form labels, "Cancel") provides a unique nearby text that pins
  // the modal context — exactly the same shape pickRowDisambiguator
  // already handles for fill/select.
  const duplicates = inventory.filter(
    (e) => pickClickText(e) === hint && e.selector !== selector,
  );
  const role = inferRoleHint(match);
  const hrefHint = pickHrefHint(match);
  if (duplicates.length > 0) {
    const nearTextHint = pickRowDisambiguator(match, duplicates, inventory);
    if (nearTextHint === null) {
      return {
        kind: "rejected",
        stage: "synthesis",
        error_kind: "ambiguous_text_match",
        message:
          `Text hint ${JSON.stringify(hint)} matches ${duplicates.length + 1} elements in this round's inventory ` +
          `AND no unique nearby visible text could be found to disambiguate via near_text_hint. ` +
          `Hand-edit the skill with a role_hint or re-capture with a tighter prompt.`,
        offending_round: roundIndex,
        synthesizer_version: SYNTHESIZER_VERSION,
      };
    }
    const result: ClickHintOk = { kind: "ok", hint, near_text_hint: nearTextHint };
    if (role !== undefined) result.role_hint = role;
    if (hrefHint !== null) result.href_hint = hrefHint;
    const domHint = pickStableDomHint(match);
    if (domHint !== undefined) result.dom_hint = domHint;
    return result;
  }

  const result: ClickHintOk = { kind: "ok", hint };
  if (role !== undefined) result.role_hint = role;
  if (hrefHint !== null) result.href_hint = hrefHint;
  const domHint = pickStableDomHint(match);
  if (domHint !== undefined) result.dom_hint = domHint;
  return result;
}

// 0.8.3-rc.1 — does this fill target look like an API-key / token
// NAME field? Used to templatize captured literals as ${TOKEN_NAME}
// even when the value itself doesn't match the rc.17 shape regex.
//
// Conservative on purpose: a plain `<input name="name">` for a person
// is NOT a token field. We require the placeholder, labelText,
// ariaLabel, id or name attribute to mention API-key/token semantics
// — "API key", "token name", "key name", "personal access token", or
// a placeholder hinting at the format ("production-api-key",
// "my-api-key"). This catches the canonical token-name inputs across
// Railway, Baseten, Resend, Vercel, OpenAI, etc. without
// false-positiving on signup forms' "Name" fields (which lack the
// surrounding API/token vocabulary).
function looksLikeTokenNameInput(el: InteractiveElement): boolean {
  const hay = [
    el.placeholder ?? "",
    el.labelText ?? "",
    el.ariaLabel ?? "",
    el.name ?? "",
    el.id ?? "",
    el.title ?? "",
  ]
    .join(" ")
    .toLowerCase();
  // Pattern A: surrounding API-key / token vocabulary.
  if (/api[\s_-]*(?:key|token)|access[\s_-]*token|personal[\s_-]*token/.test(hay)) {
    return true;
  }
  // Pattern B: explicit "<thing> name" where <thing> is token/key/secret.
  if (/\b(?:token|key|secret)[\s_-]*name\b/.test(hay)) {
    return true;
  }
  // Pattern C: well-known placeholder examples that hint at the format.
  if (/production[-_\s]*api[-_\s]*key|my[-_\s]*api[-_\s]*key/.test(hay)) {
    return true;
  }
  return false;
}

function pickClickText(el: InteractiveElement): string | null {
  // Prefer visibleText (what humans read); fall back through ariaLabel,
  // title, and iconLabel for icon-only buttons. iconLabel is the most
  // common surface for modern dashboards that ship "Sign in with X"
  // OAuth buttons as an SVG with no text — the iconLabel folds in
  // alt/aria-label from descendant <img>/<svg>. Trim and drop empties.
  const text = (
    el.visibleText ??
    el.ariaLabel ??
    el.title ??
    el.iconLabel ??
    ""
  ).trim();
  if (text.length > 0) {
    // Truncate exceptionally long text — a 500-char button label is
    // almost certainly a paragraph picked up by the inventory scraper.
    // Cap at 80 chars; the replay engine matches by substring so the
    // first 80 chars are plenty for disambiguation.
    return text.length > 80 ? text.slice(0, 80) : text;
  }
  // 0.8.3-rc.1 — last-resort fallback to stable form attributes when
  // the element has no human-readable text. Targets like mistral's
  // ToS checkbox (`<input name="terms">` with id="_R_75klubsnimdb_")
  // are otherwise unmatchable but have a stable `name`. The replay
  // engine's matchesClickHint / matchesLabelHint were extended to
  // also check `name` and stable `id`, so the synthesized hint pins
  // the right element at replay time.
  const stableAttr = pickStableAttribute(el);
  if (stableAttr !== null) return stableAttr;
  return null;
}

// 0.8.3-rc.1 — pick a stable HTML attribute we can use as a fallback
// match hint. `name` is preferred (developers set it for form fields
// and rarely change it across redesigns). `id` is accepted only when
// it doesn't match common React component-library runtime-ID patterns
// (react-aria, radix, base-ui, react-aria-utils' `_R_…` / `_r_…`).
function pickStableAttribute(el: InteractiveElement): string | null {
  const name = (el.name ?? "").trim();
  if (name.length > 0 && looksStableAttr(name)) return name;
  const id = (el.id ?? "").trim();
  if (id.length > 0 && looksStableAttr(id) && !looksLikeRuntimeId(id)) return id;
  return null;
}

function looksStableAttr(s: string): boolean {
  // Lower-case alpha-start, alnum+hyphen+underscore+dot, length 2-40.
  // Wider than HTML's strict name rules — some apps put dots in names.
  return /^[a-zA-Z][a-zA-Z0-9_\-.]{1,39}$/.test(s);
}

function looksLikeRuntimeId(s: string): boolean {
  // Common library-generated unstable IDs.
  if (/^react-aria\d+/.test(s)) return true;
  if (/^radix-/.test(s)) return true;
  if (/^base-ui-/.test(s)) return true;
  if (/_R_[a-z0-9]+_?$/i.test(s)) return true;
  if (/_r_[a-z0-9]+_?$/i.test(s)) return true;
  return false;
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
  // 0.8.2-rc.3 — schema-level disambiguator for Sentry-class permission
  // grids and any multi-row form where every row's input shares the
  // same label. When present, the replay engine narrows ambiguous
  // label_hint matches by "has unique nearby visible text containing
  // near_text_hint" before failing. Only populated when a collision
  // forced disambiguation — single-cred forms emit just `hint`.
  near_text_hint?: string;
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
  // then placeholder, then aria-label, then visibleText for combobox-
  // shaped buttons (Resend / OpenAI / many Radix-based dashboards
  // ship their selects as <button role="combobox"> with the current
  // value as visibleText and no labelText — the only stable hint is
  // that visible value text). The bot's element-extraction logic
  // already does the <label for=> matching, so labelText is
  // authoritative when present.
  const comboboxButtonText =
    match.role === "combobox" && match.tag === "button"
      ? match.visibleText ?? null
      : null;
  let hint =
    (match.labelText ?? match.placeholder ?? match.ariaLabel ?? comboboxButtonText ?? "")
      .trim();
  if (hint.length === 0) {
    // 0.8.3-rc.1 — same stable-attribute fallback as pickClickText:
    // form fields routinely have a stable `name` attribute even when
    // their visible labelText/placeholder/ariaLabel are absent
    // (the label may live in a sibling element captured separately).
    const stable = pickStableAttribute(match);
    if (stable !== null) {
      hint = stable;
    } else {
      return {
        kind: "rejected",
        stage: "synthesis",
        error_kind: "missing_text_hint",
        message:
          `Inventory element at ${JSON.stringify(selector)} has no labelText / placeholder / ariaLabel ` +
          `and no stable name/id attribute — cannot synthesize a fill/select label hint.`,
        offending_round: roundIndex,
        synthesizer_version: SYNTHESIZER_VERSION,
      };
    }
  }

  // Ambiguity check — same as click resolver. Mirror the replay
  // engine's rc.8 isFillable filter: only input/textarea/select can
  // genuinely host a fill, so don't count a labelText collision from a
  // sibling help-button as an ambiguity (OpenRouter ships a "Name"
  // tooltip button next to its #name input — both report labelText
  // "Name", but the button is not a fill target).
  const duplicates = inventory.filter(
    (e) =>
      e.selector !== selector &&
      (e.tag === "input" || e.tag === "textarea" || e.tag === "select") &&
      (e.labelText?.trim() === hint ||
        e.placeholder?.trim() === hint ||
        e.ariaLabel?.trim() === hint ||
        // 0.8.3-rc.1 — stable-attribute fallback path: if our hint
        // came from the target's `name`/`id`, a duplicate is any
        // input/textarea/select sharing that attribute value.
        e.name?.trim() === hint ||
        e.id?.trim() === hint),
  );
  if (duplicates.length === 0) {
    return { kind: "ok", hint };
  }
  // The label/placeholder hint is shared by sibling fields — the MUI/antd
  // pattern where every input carries the same generic "Please input" /
  // "Please select" placeholder and no <label for=> (zilliz's onboarding
  // form). Before reaching for a positional near-text hint, prefer a
  // UNIQUE stable attribute the target itself carries: firstName/lastName/
  // company each have a distinct `name`, and matchesLabelHint matches
  // name/id exactly at replay. pickStableAttribute already rejects
  // React-runtime ids (`:r3:`), so a field whose only id is runtime-
  // generated correctly falls through to the disambiguator below.
  const stable = pickStableAttribute(match);
  if (stable !== null && stable !== hint) {
    const stableDupes = inventory.filter(
      (e) =>
        e.selector !== selector &&
        (e.tag === "input" || e.tag === "textarea" || e.tag === "select") &&
        (e.name?.trim() === stable || e.id?.trim() === stable),
    );
    if (stableDupes.length === 0) {
      return { kind: "ok", hint: stable };
    }
  }
  // 0.8.2-rc.3 — schema-level disambiguator. Look for a unique
  // visible-text element near `match` (Sentry's grid: each row has
  // its name like "Project" / "Team" / "Member" as a heading near the
  // row's <select>). The bot's inventory is roughly DOM-ordered, so
  // "near" means within a small ±index window. We pick the FIRST
  // candidate whose text:
  //   1. is non-empty (some labels carry just whitespace),
  //   2. does NOT appear in any sibling-row's window (uniqueness),
  //   3. is short enough to be a heading (≤40 chars; longer text is
  //      typically a description paragraph, useless as a disambiguator).
  // Failure to find one means we still can't disambiguate — fall back
  // to the pre-rc.3 hard rejection.
  const nearTextHint = pickRowDisambiguator(match, duplicates, inventory);
  if (nearTextHint !== null) {
    return { kind: "ok", hint, near_text_hint: nearTextHint };
  }
  return {
    kind: "rejected",
    stage: "synthesis",
    error_kind: "ambiguous_text_match",
    message:
      `Label hint ${JSON.stringify(hint)} matches ${duplicates.length + 1} input/select elements ` +
      `AND no unique nearby visible text could be found to disambiguate via near_text_hint. ` +
      `Hand-edit the skill with a row-identifying hint, or re-capture with a tighter prompt.`,
    offending_round: roundIndex,
    synthesizer_version: SYNTHESIZER_VERSION,
  };
}

// 0.8.2-rc.3 — find a nearby visible-text snippet that uniquely
// pins `target` over `siblings`. The row-label-immediately-before-row-
// control pattern (Sentry's permission grid) is the canonical case:
//   [Project label] [Project select] [Team label] [Team select]
// "Team" sits right before the team select and right after the project
// select. Distance-equality breaks symmetry; we resolve it by
// considering ONLY texts that appear in the small window BEFORE the
// target (the typical row-header position), then checking they don't
// also appear before any sibling. Returns null when no such snippet
// exists.
function pickRowDisambiguator(
  target: InteractiveElement,
  siblings: readonly InteractiveElement[],
  inventory: readonly InteractiveElement[],
): string | null {
  const WINDOW = 5;
  const targetIdx = inventory.findIndex((e) => e.selector === target.selector);
  if (targetIdx === -1) return null;

  const visibleTextOf = (el: InteractiveElement): string =>
    (el.visibleText ?? el.ariaLabel ?? el.title ?? "").trim();

  // Collect text snippets that appear in the WINDOW entries
  // immediately PRECEDING each sibling. These are the "row labels"
  // we want to exclude from target's candidate set.
  const siblingPrecedingTexts = new Set<string>();
  for (const sib of siblings) {
    const sibIdx = inventory.findIndex((e) => e.selector === sib.selector);
    if (sibIdx === -1) continue;
    const start = Math.max(0, sibIdx - WINDOW);
    for (let i = start; i < sibIdx; i++) {
      const t = visibleTextOf(inventory[i]!).toLowerCase();
      if (t.length > 0) siblingPrecedingTexts.add(t);
    }
  }

  // Helper: a candidate hint qualifies only if filterByNearTextHint
  // applied at the FULL inventory level uniquely picks the target.
  // Local proximity isn't sufficient on its own — for the click case,
  // a sibling button's own visibleText can land "near" the target
  // within ±5 entries and still be the wrong hint at replay time
  // (the replay engine scores the same way). Validating with the same
  // function the replay engine uses makes the chosen hint correct
  // by construction.
  const candidates: InteractiveElement[] = [target, ...siblings];
  const validates = (hint: string): boolean => {
    const result = filterByNearTextHint(candidates, hint, inventory);
    return result.length === 1 && result[0]!.selector === target.selector;
  };

  // Walk backward from target picking the closest preceding visible-
  // text element whose text is unique vs. siblings' preceding texts.
  const start = Math.max(0, targetIdx - WINDOW);
  for (let i = targetIdx - 1; i >= start; i--) {
    const text = visibleTextOf(inventory[i]!);
    if (text.length === 0) continue;
    if (text.length > 40) continue;
    if (siblingPrecedingTexts.has(text.toLowerCase())) continue;
    if (!validates(text)) continue;
    return text;
  }

  // Backward sweep failed — fall back to a forward sweep within the
  // window for forms where the row label appears AFTER the input (rare
  // — typically right-aligned column-style layouts).
  const siblingFollowingTexts = new Set<string>();
  for (const sib of siblings) {
    const sibIdx = inventory.findIndex((e) => e.selector === sib.selector);
    if (sibIdx === -1) continue;
    const end = Math.min(inventory.length, sibIdx + WINDOW + 1);
    for (let i = sibIdx + 1; i < end; i++) {
      const t = visibleTextOf(inventory[i]!).toLowerCase();
      if (t.length > 0) siblingFollowingTexts.add(t);
    }
  }
  const endIdx = Math.min(inventory.length, targetIdx + WINDOW + 1);
  for (let i = targetIdx + 1; i < endIdx; i++) {
    const text = visibleTextOf(inventory[i]!);
    if (text.length === 0) continue;
    if (text.length > 40) continue;
    if (siblingFollowingTexts.has(text.toLowerCase())) continue;
    if (!validates(text)) continue;
    return text;
  }
  return null;
}

// ── Extract step + credential spec inference ─────────────────────────

// Phase-E multi-cred explode. When the planner's reason names ≥2 distinct
// labeled credentials ("application_id='…' and search_api_key='…' and
// admin_api_key='…'"), emit one label-scoped `extract_labeled` step per
// credential so each becomes its own named credential — instead of the
// legacy single copy_button/regex step that can only yield one value (and
// whose hint mis-resolves to a credential VALUE, the unparseable_credential_
// label reject). Returns null for a single-cred round so the legacy path
// (and its byte-equivalence) is preserved. Exported for unit testing.
export function synthesizeLabeledExtractSteps(
  observed: Extract<PostVerifyStep, { kind: "extract" }>,
  roundHtml: string,
  provenance: SkillStepProvenance,
): SkillStep[] | null {
  const labeled = extractAllLabeledTokensFromReason(observed.reason, roundHtml);
  // Canonical keys only (the parser already whitelists credential labels).
  const keys = Object.keys(labeled).filter((k) => /^[a-z][a-z0-9_]*$/.test(k));
  // Collapse labels that point to the SAME underlying value. Pusher's planner
  // reports one secret three ways (secret / api_secret / app_secret all carry
  // the identical token), which would synthesize three extract_labeled steps
  // for a single credential — and then fail replay, since the App Keys page
  // has ONE "Secret" field, not three. Keep the first label seen for each
  // distinct value (the planner states the on-page label first, glosses after,
  // so first-seen tends to be the real one). Genuinely distinct credentials
  // (algolia's application_id / search_api_key / admin_api_key) carry distinct
  // high-entropy values and all survive. Deterministic: Object.keys preserves
  // the reason's insertion order, so the same reason yields the same output.
  const seenValues = new Set<string>();
  const distinctKeys = keys.filter((k) => {
    const value = labeled[k]!;
    if (seenValues.has(value)) return false;
    seenValues.add(value);
    return true;
  });
  // Re-apply the multi-cred threshold on DISTINCT values: a reason that named
  // one credential under two labels (api_key + token, same value) is really
  // single-cred — return null so the legacy extract path handles it.
  if (distinctKeys.length < 2) return null;
  return distinctKeys.map((key) => ({
    kind: "extract_labeled",
    // The on-page label the replay engine matches against harvested
    // labeled-credential candidates: "application_id" → "application id"
    // (the LABEL_PHRASES form extractLabeledCredentialCandidates emits).
    label_hint: key.replace(/_/g, " "),
    produces: key,
    provenance,
  }));
}

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

// A6 — drop a spurious uuid_token regex extract when a copy-button
// extract co-exists. Auto-promote sometimes captures a uuid-shaped value
// on an onboarding page (e.g. PostHog's project_id) as a "credential"
// next to the REAL copy-button key; upgradeToMultiCred then makes BOTH
// required, so the verifier replay hard-fails on a fresh account where
// the spurious uuid isn't present (observed 2026-06-02: posthog/brevo/
// statsig). A copy-button extract is a strong, explicit credential
// signal; `uuid_token` is detectKnownCredentialPattern's DEFAULT for
// "unrecognized" — the weak/spurious one. With both present, the regex
// is almost certainly the spurious capture, so drop it. No-op when there
// is no copy-button extract (keeps a lone uuid_token skill), and leaves
// genuine multi-cred untouched (distinct copy-button fields, or non-
// uuid_token regex patterns like resend/stripe/render).
export function dropSpuriousUuidExtract(steps: SkillStep[]): SkillStep[] {
  const hasCopyButton = steps.some((s) => s.kind === "extract_via_copy_button");
  if (!hasCopyButton) return steps;
  return steps.filter(
    (s) => !(s.kind === "extract_via_regex" && s.pattern_name === "uuid_token"),
  );
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
  // Detect "shown once at creation" phrasing in the extract step's
  // captured reason + the surrounding round texts. Cloudinary,
  // Twilio auth_token-once-shown, Stripe rotation flows all surface
  // explicit warnings like "the secret will not be shown again",
  // "make sure to copy it now", "this is the only time you'll see
  // this token". When present, the router skips replay and routes
  // to fresh-signup-each-time. False positives are bounded — the
  // worst case is the router does extra signups, never the wrong
  // credentials.
  const visibility = inferVisibility(extractStep, rounds);
  const spec: SkillCredentialSpec = {
    type: "api_key",
    shape_hint: shapeHint,
    env_var_suggestion: envVar,
    // Only emit visibility when show-once — keeps canonical bytes
    // identical for the 95% of skills that are always_visible
    // (existing signed skills remain valid). Absent → treated as
    // always_visible by the replay router.
    ...(visibility === "show_once_at_creation" ? { visibility } : {}),
    post_extract_validator: validator,
  };
  return { kind: "ok", spec };
}

// Show-once vocabulary. The synthesizer scans the planner's prose
// for these markers. Captured from real-world dashboard copy across
// Cloudinary, Twilio, Stripe, AWS, GitHub PATs, etc.
const SHOW_ONCE_PHRASES: readonly RegExp[] = [
  /\b(?:will not be|won'?t be|cannot be|can'?t be|never)\s+(?:shown|displayed|visible|retrievable|recovered)\s+again\b/i,
  /\b(?:only|sole|one[- ]?time)\s+(?:time|chance|opportunity)\s+(?:you'?ll|you will|to)\s+(?:see|view|copy)\b/i,
  /\bshow(?:n|ing)?\s+(?:only\s+)?once\b/i,
  /\bdisplay(?:ed|ing)?\s+only\s+once\b/i,
  /\bmake\s+sure\s+(?:to\s+)?(?:copy|save)\s+(?:it|this|now)\b/i,
  /\bcopy\s+(?:it|this|now)\s+(?:before|now)\b/i,
  /\b(?:save|copy)\s+(?:the\s+)?(?:secret|token|key|credential)\s+now\b/i,
  /\b(?:this\s+is\s+the\s+)?(?:only|sole)\s+time\b.*\b(?:see|view|copy|displayed)\b/i,
  /\bafter\s+(?:closing|leaving|navigating|refreshing).*(?:cannot|won'?t|will not).*(?:retrieve|see|recover)\b/i,
];

function inferVisibility(
  extractStep: SkillStep,
  rounds: OnboardingCaseFile[],
): "always_visible" | "show_once_at_creation" {
  // Source 1: the extract step's planner-quoted reason (from the
  // round's `observed.reason` — we preserve this in step provenance).
  // We don't have direct access to the original reason from the
  // SkillStep alone, so scan the rounds' planner reasons up to the
  // round that produced the extract.
  const roundIndex = extractStep.provenance?.round_index;
  if (typeof roundIndex !== "number") return "always_visible";
  const haystack: string[] = [];
  for (const r of rounds) {
    const observed = r.observed as unknown as { reason?: string } | undefined;
    if (observed?.reason !== undefined && typeof observed.reason === "string") {
      haystack.push(observed.reason);
    }
    // Source 2: page html — strip tags for a coarse text view. The
    // warning banner ("the secret will not be shown again") is part
    // of the dashboard's rendered DOM at the credential-creation
    // moment, so it surfaces here even when the planner didn't quote
    // the warning explicitly in its reason.
    if (typeof r.state?.html === "string") {
      const text = r.state.html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      haystack.push(text.slice(0, 8000));
    }
  }
  const joined = haystack.join(" \n ");
  for (const re of SHOW_ONCE_PHRASES) {
    if (re.test(joined)) return "show_once_at_creation";
  }
  return "always_visible";
}

function validatorForShape(
  shape: SkillCredentialSpec["shape_hint"],
  rounds: OnboardingCaseFile[],
): { min_length: number; max_length: number } {
  switch (shape) {
    case "uuid":
      // 0.8.3 — widened from {36, 36} so we cover cases where shape
      // inference flagged the credential as "uuid" because the page
      // had an unrelated UUID-shaped distractor near a non-UUID
      // credential. Replicate captured at 36 but real keys are 40
      // chars; widening lets the validator stop rejecting the
      // actually-correct extract.
      return { min_length: 32, max_length: 80 };
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
      //
      // 0.8.3 — clamp the inferred bounds to PLAUSIBLE ranges so a
      // synthesizer mishap (capturing a 10-char masked stub like
      // "demo_token" as "the credential") doesn't lock the validator
      // to a range so tight the real 56-char key can never satisfy it.
      // Min stays low (services with short keys exist) but max never
      // drops below 64.
      return clampOpaqueValidator(
        inferOpaqueValidatorFromHtml(rounds) ?? { min_length: 8, max_length: 64 },
      );
    case "username_password":
      return { min_length: 8, max_length: 256 };
  }
}

function clampOpaqueValidator(v: {
  min_length: number;
  max_length: number;
}): { min_length: number; max_length: number } {
  return {
    min_length: Math.max(4, v.min_length),
    max_length: Math.max(64, v.max_length),
  };
}

// Scan the last round's HTML for short alphanumeric tokens that look
// like credentials (digits + letters, no surrounding label glue
// detectable). Pick the longest plausible candidate's length to
// anchor the validator's range. Returns null when nothing plausibly
// credential-shaped is found.
function inferOpaqueValidatorFromHtml(
  rounds: OnboardingCaseFile[],
): { min_length: number; max_length: number } | null {
  const rawHtml = rounds[rounds.length - 1]?.state.html ?? "";
  // Strip HTML tags + collapse whitespace so the label and value
  // appear adjacent — they're typically rendered as
  // `<div>API Token</div><span>f9a062…</span>` (IPInfo case). The
  // strip mirrors what extractText() returns at replay time, which
  // is what the labeled regex was designed against.
  const text = rawHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  // Look for "API Token" / "Token" / "API Key" label followed by an
  // alphanumeric run of 8-64 chars. The replay engine's
  // extractCredentialCandidates fallback uses validator length to
  // filter, so we want a tight ±2-char range around the observed
  // length to keep nav strings ("Dashboard", "Downloads") out.
  const labeled = /(?:API[\s_-]?Token|API[\s_-]?Key|Token|Secret)\s*[:=]?\s*([a-zA-Z0-9_-]{8,64})/i.exec(text);
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
        //   1. UUID actually present near credential context (Railway-
        //      class) → shape "uuid"
        //   2. UUID present but it's an unrelated session/tracking ID
        //      (IPInfo-class — the dashboard has a hidden analytics
        //      UUID nowhere near the api-token field) → shape "opaque"
        //      so the validator isn't forced to 36/36 and the rc.8
        //      candidate fallback finds the real value.
        //
        // 0.8.3-rc.1 — context-scoped scan. The whole-HTML UUID test
        // mis-tagged IPInfo (its real key is 14-char hex; an unrelated
        // session UUID elsewhere on the dashboard triggered "uuid"
        // shape, locking the validator out of the real value's length
        // range). Require the UUID to appear near credential-context
        // words (token/key/api/secret) within a small character window
        // before promoting to the "uuid" shape.
        const html = rounds[rounds.length - 1]?.state.html ?? "";
        if (uuidNearCredentialContext(html)) {
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
  //
  // 0.8.3-rc.1 — when the extract step carries a near_text_hint,
  // narrow the scan to a window around each occurrence of that hint.
  // The hint points at the copy-button's neighborhood (e.g. "Copy API
  // key" sits right next to the key value); shape patterns matching
  // INSIDE that window are far more likely to be the actual
  // credential than a coincidental match elsewhere on the page.
  const lastRound = rounds[rounds.length - 1]!;
  const fullHtml = lastRound.state.html;
  const nearTextHint =
    extractStep.kind === "extract_via_copy_button" ||
    extractStep.kind === "extract_via_copy_button_named"
      ? extractStep.near_text_hint
      : undefined;
  const scopedHtml =
    nearTextHint !== undefined
      ? scopeHtmlAround(fullHtml, nearTextHint)
      : fullHtml;

  // Prefer the scoped window: a prefix that hits inside the copy-
  // button's neighborhood is far more likely correct than one that
  // happens to appear in nav/footer markup elsewhere.
  const prefixInScope = detectPrefixShape(scopedHtml);
  if (prefixInScope !== null) return prefixInScope;
  // Fall back to whole-HTML prefix detection only when the scoped
  // window had no hit. This preserves the prior behavior for skills
  // whose synthesizer-emitted near_text_hint doesn't perfectly land
  // on the credential's wrapper.
  if (nearTextHint !== undefined) {
    const prefixWhole = detectPrefixShape(fullHtml);
    if (prefixWhole !== null) return prefixWhole;
  }
  // UUID-as-shape requires credential-context proximity. A bare UUID
  // somewhere on the page isn't enough — it must sit next to
  // token/key/api/secret vocabulary.
  if (uuidNearCredentialContext(scopedHtml) || uuidNearCredentialContext(fullHtml)) {
    return "uuid";
  }
  return "opaque";
}

// 0.8.3-rc.1 — true iff a UUID appears within ±200 chars of any
// credential-context word in the HTML. Tracking/session UUIDs that
// live in script payloads or footers don't satisfy this; the
// credential UUID that the dashboard renders next to its label does.
function uuidNearCredentialContext(html: string): boolean {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const CONTEXT = /\b(?:token|api[\s_-]*key|secret|access[\s_-]*key|api[\s_-]*token|personal[\s_-]*access)\b/gi;
  const WINDOW = 200;
  // Collect all context offsets first (cheap) and check each UUID
  // against them. log(n) join would be tighter; n is small enough
  // for a linear scan to be invisible.
  const contextOffsets: number[] = [];
  for (const m of html.matchAll(CONTEXT)) {
    contextOffsets.push(m.index ?? 0);
  }
  if (contextOffsets.length === 0) return false;
  for (const m of html.matchAll(UUID)) {
    const idx = m.index ?? 0;
    for (const co of contextOffsets) {
      if (Math.abs(co - idx) <= WINDOW) return true;
    }
  }
  return false;
}

// 0.8.3-rc.1 — extract a window of HTML around each occurrence of
// `anchor` so downstream shape-pattern checks only see the
// credential's vicinity, not the whole page. Returns the
// concatenated windows.
function scopeHtmlAround(html: string, anchor: string): string {
  if (anchor.length === 0) return html;
  const WINDOW = 500;
  const lowerHtml = html.toLowerCase();
  const lowerAnchor = anchor.toLowerCase();
  const parts: string[] = [];
  let from = 0;
  while (from < lowerHtml.length) {
    const idx = lowerHtml.indexOf(lowerAnchor, from);
    if (idx === -1) break;
    const start = Math.max(0, idx - WINDOW);
    const end = Math.min(html.length, idx + anchor.length + WINDOW);
    parts.push(html.slice(start, end));
    from = end;
  }
  // If we never matched the anchor (capture-time HTML differs in
  // ways the resolver normalized over), return the original HTML so
  // we don't lose the chance to detect a prefix at all.
  return parts.length === 0 ? html : parts.join("\n");
}

function detectPrefixShape(html: string): SkillCredentialSpec["shape_hint"] | null {
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
  return null;
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
    // Default to absent (== always_visible). Multi-cred skills get
    // a per-credential visibility flag added by the visibility-
    // inference pass only when show-once phrasing was detected for
    // that specific credential.
    // ID fields (application_id, org_id, account_id) are short — often a
    // numeric handle (pusher's app_id is 7 digits) — so a 16-char floor wrongly
    // rejects them. Use a low floor for *_id; keep 16 for key/secret/token.
    post_extract_validator: {
      min_length: shape === "uuid" ? 36 : /(?:^|_)id$/.test(name) ? 4 : 16,
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
