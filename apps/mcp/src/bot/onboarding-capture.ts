// onboarding-capture.ts — capture post-OAuth onboarding rounds into
// the E1 eval-corpus format, with integrity-chained hashes.
//
// Building per-service onboarding adapters needs many iterations, but
// re-running the live OAuth handshake is rate-limited by Google
// anti-abuse (see the plan's Post-Build Findings). The escape: capture
// each onboarding round's real page state ONCE, then iterate the
// onboarding planner offline against the capture via eval-onboarding.ts.
//
// This is the capture half. Each round of postVerifyLoop is dumped as
// one JSON file shaped like an eval-onboarding.ts OnboardingEvalCase —
// minus `expect`, which is a human judgement (the correct next step).
// A curator fills `expect` in to make the case scorable; the eval
// harness loads only cases that have it.
//
// **0.7.0 — integrity chain.** The Skill Promoter (docs/
// DESIGN-skill-promoter.md, finding E1) signs its output skills but
// trusted unsigned local JSON as input. Anyone running
// `pnpm skill:promote` could hand-edit `r*.json` before publishing,
// and the signature would attest to the tampered output. Fix: each
// round carries `content_hash` (SHA-256 of its own normalized
// payload) and `prev_hash` (the previous round's content_hash, or
// null for round 0). The promoter verifies the chain before
// synthesizing — hand-edits break the chain and the promoter
// refuses.
//
// **0.7.0 — versioning.** `capture_format_version` is dumped on every
// file. The promoter rejects unknown versions explicitly (E2) rather
// than failing midway through synthesis on a shape it can't parse.
//
// **0.6.14-rc.11 — default-on.** Previously inert unless
// TRUSTY_SQUIRE_ONBOARDING_CAPTURE named a directory; we kept finding
// stuck-loop bugs (e.g. Railway token-create click no-op) where no
// captures existed on disk because the env var was never set. Now
// defaults to `$HOME/.trusty-squire/corpus/onboarding` when the env
// var is unset or empty. Set the env to a custom path to override;
// set it to `off` to opt out entirely.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep, SignupResult } from "./agent.js";
import { classifyFailureStage, type FailureStage } from "./failure-stage.js";
import {
  classifySemanticFailure,
  inferSemanticTransition,
  type SemanticFailureBucket,
  type SemanticFaultClass,
  type SemanticTransitionRecord,
} from "./semantic-transition.js";

// Capture format version. Bumped when round-shape changes incompatibly.
// The promoter rejects unknown versions (E2). Same-major minor changes
// (new optional fields) stay forward-compatible.
export const CAPTURE_FORMAT_VERSION = 1 as const;

// Per-service run ids. Housekeeper discovery can run several services in one
// process; a module-global runId lets one signup's reset erase another
// in-flight signup's capture state before auto-promote reads it.
const runIds = new Map<string, string>();

function slugOf(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function runIdFor(service: string): string {
  const slug = slugOf(service);
  const existing = runIds.get(slug);
  if (existing !== undefined) return existing;
  const next = Date.now().toString(36);
  runIds.set(slug, next);
  return next;
}

// Read the in-process runId. Auto-promote needs to know which run's
// captures to promote after a successful signup. Returns undefined
// when no rounds have been captured yet — auto-promote then skips
// with a useful message rather than promoting nothing.
export function currentRunId(service?: string): string | undefined {
  if (service !== undefined) return runIds.get(slugOf(service));
  if (runIds.size === 1) return [...runIds.values()][0];
  return undefined;
}

// rc.17 — reset the per-process capture chain state at the start of a
// new signup. runId is module-scoped and was previously set once per
// process; back-to-back signups in one bot process then shared the
// same runId, so the second signup's round-0 looked up the first
// signup's last hash via chainHead and wrote a non-null prev_hash —
// which the chain verifier then rejected as prev_hash_mismatch (Run
// #3 of the Railway closed-loop test was the canonical case).
// Called from UniversalSignupBot.runSession() before the bot's first
// captureOnboardingRound call.
export function resetCaptureChain(service?: string): void {
  if (service === undefined) {
    runIds.clear();
    chainHead.clear();
    lastRounds.clear();
    extractCaptured.clear();
    return;
  }
  const slug = slugOf(service);
  runIds.delete(slug);
  lastRounds.delete(slug);
  for (const key of [...chainHead.keys()]) {
    if (key.startsWith(`${slug}|`)) chainHead.delete(key);
  }
  for (const key of [...extractCaptured]) {
    if (key.startsWith(`${slug}|`)) extractCaptured.delete(key);
  }
}

// Per-(service, runId) chain head. Each new round's `prev_hash` is the
// previous round's `content_hash`; round 0's `prev_hash` is null. The
// promoter walks the chain forward and rejects on any break.
//
// Map key is `${service}|${runId}` so cross-service concurrent
// captures don't bleed into each other. Cleared at process exit by
// being process-scoped (no persistence — captures restart fresh on
// next process).
const chainHead = new Map<string, string>();

// Highest round index captured this run, or undefined if no rounds yet.
// captureRunOutcome reads this to stamp `terminal_round` — the round the
// run reached (where a failure got stuck, or the last onboarding step on
// success). Reset alongside runId/chainHead at the start of each signup.
const lastRounds = new Map<string, number>();

// True once a `kind:"extract"` round has been captured for the current
// (slug, runId). The synthesizer REJECTS a capture with no extract step
// (no_extract_step) even when the run obtained a credential — the bot's
// credential-tracker/background extraction can populate `credentials` without
// a planner `extract` action ever running, so the on-disk rounds end on a
// `done`/`click` and the skill can't be synthesized. The discover loop reads
// this at its success return to write a salvage extract round when one is
// missing. Keyed by `${slug}|${runId}`, reset alongside the chain.
const extractCaptured = new Set<string>();

// True iff an extract round has already been captured for THIS run of the
// service. Lets the discover loop avoid a redundant salvage round (and only
// salvage when genuinely missing).
export function hasCapturedExtractRound(service: string): boolean {
  return extractCaptured.has(`${slugOf(service)}|${runIdFor(service)}`);
}

// True iff ANY round has been captured this run. A salvage extract round is only
// worth writing when there are prior signup-flow rounds to chain it onto — a
// LONE extract round has no navigate/OAuth steps and can't be replayed (the
// no_rounds class). Callers gate the salvage on this.
export function hasCapturedAnyRound(service: string): boolean {
  return lastRounds.has(slugOf(service));
}

// The next round index to use for a synthesized/salvage capture round — one past
// the highest captured round (0 when none captured yet).
export function nextCaptureRound(service: string): number {
  return (lastRounds.get(slugOf(service)) ?? -1) + 1;
}

export interface OnboardingRoundCapture {
  service: string;
  round: number;
  oauth: boolean;
  state: { url: string; title: string; html: string; screenshot: string };
  inventory: readonly InteractiveElement[];
  // The step the planner actually chose this round — a reference for
  // the curator, NOT ground truth (the planner may have been wrong).
  observed: PostVerifyStep;
  // Fix C4 — the model/provider the LLM backend actually served for this
  // round's plan. Optional: undefined when the backend didn't report one,
  // or on an older client. Persisted so model-swap flakiness is
  // attributable from the corpus (which round used which backend).
  resolved_model?: string;
  resolved_provider?: string;
  // Machine-readable semantic contract for this planner transition. The raw
  // observed step remains the source of truth for replay synthesis; this is the
  // planner-correctness/eval surface.
  semantic?: SemanticTransitionRecord;
}

// Wire shape of one dumped round. `expect: null` is the curator slot;
// `prev_hash` and `content_hash` form the integrity chain (E1).
export interface OnboardingCaseFile {
  capture_format_version: typeof CAPTURE_FORMAT_VERSION;
  name: string;
  service: string;
  oauth: boolean;
  state: OnboardingRoundCapture["state"];
  inventory: readonly InteractiveElement[];
  observed: PostVerifyStep;
  // Fix C4 — served model/provider for this round (see
  // OnboardingRoundCapture). Optional + only written when present, so the
  // integrity hash of an older round (no resolved_* keys) is unaffected
  // and the format stays forward-compatible.
  resolved_model?: string;
  resolved_provider?: string;
  // Additive semantic transition metadata. Optional so old captures remain
  // readable and future semantic schema versions can coexist.
  semantic?: SemanticTransitionRecord;
  expect: null;
  prev_hash: string | null;
  content_hash: string;
}

// Compute the round's SHA-256 hash. Hash is over the JSON-stringified
// payload with `content_hash` and `expect` omitted (those would be
// circular / mutable). Stable across machines because JSON.stringify
// with no replacer + no spaces produces a canonical-enough form —
// we don't sort keys because TypeScript object insertion order is
// preserved and we control every key here.
function computeContentHash(
  payload: Omit<OnboardingCaseFile, "content_hash" | "expect">,
): string {
  const hasher = createHash("sha256");
  hasher.update(JSON.stringify(payload));
  return hasher.digest("hex");
}

// Resolve the capture directory. Order:
//   1. Explicit env var (TRUSTY_SQUIRE_ONBOARDING_CAPTURE) — including
//      the literal "off" / "0" / "false" which suppress capture.
//   2. Default fallback: `$HOME/.trusty-squire/corpus/onboarding`,
//      EXCEPT under vitest (NODE_ENV=test or VITEST=true) where
//      defaulting on would pollute every test runner's home dir with
//      stray captures from agent-loop tests. Tests that exercise the
//      capture explicitly set the env var via the withCaptureDir
//      helper.
// Exported so the round-uploader (provision-any.ts) can read the same
// resolved path without re-implementing the policy.
export function resolveCaptureDir(): string | null {
  const envValue = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  if (envValue !== undefined) {
    const trimmed = envValue.trim();
    if (trimmed.length === 0) return isTestEnv() ? null : defaultCaptureDir();
    if (trimmed === "off" || trimmed === "0" || trimmed === "false") return null;
    return trimmed;
  }
  if (isTestEnv()) return null;
  return defaultCaptureDir();
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function defaultCaptureDir(): string | null {
  try {
    const home = homedir();
    if (home.length === 0) return null;
    return join(home, ".trusty-squire", "corpus", "onboarding");
  } catch {
    return null;
  }
}

// Dump one onboarding round to the capture directory.
// Best-effort: a capture failure must never break a signup run.
export function captureOnboardingRound(entry: OnboardingRoundCapture): void {
  const dir = resolveCaptureDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const runId = runIdFor(entry.service);
    const slug = slugOf(entry.service);
    const file = join(dir, `${slug}-${runId}-r${entry.round}.json`);

    const chainKey = `${slug}|${runId}`;
    const prevHash = chainHead.get(chainKey) ?? null;

    // Build everything BUT content_hash first, hash it, then assemble
    // the final wire record. This keeps the hash deterministic — if
    // it were computed over a record that included itself, ordering
    // would matter.
    const payload: Omit<OnboardingCaseFile, "content_hash" | "expect"> = {
      capture_format_version: CAPTURE_FORMAT_VERSION,
      name: `${entry.service} — onboarding round ${entry.round + 1}`,
      service: entry.service,
      oauth: entry.oauth,
      state: entry.state,
      inventory: entry.inventory,
      observed: entry.observed,
      semantic:
        entry.semantic ??
        inferSemanticTransition({
          state: entry.state,
          inventory: entry.inventory,
          observed: entry.observed,
          oauth: entry.oauth,
        }),
      // Only set when present so a round that has no resolved_* (older
      // client / backend that didn't report) hashes identically to before
      // — this keeps the integrity chain forward-compatible.
      ...(entry.resolved_model !== undefined ? { resolved_model: entry.resolved_model } : {}),
      ...(entry.resolved_provider !== undefined ? { resolved_provider: entry.resolved_provider } : {}),
      prev_hash: prevHash,
    };
    const contentHash = computeContentHash(payload);

    const corpusCase: OnboardingCaseFile = {
      ...payload,
      expect: null,
      content_hash: contentHash,
    };
    writeFileSync(file, JSON.stringify(corpusCase, null, 2));

    chainHead.set(chainKey, contentHash);
    lastRounds.set(slug, Math.max(lastRounds.get(slug) ?? -1, entry.round));
    if (entry.observed.kind === "extract") extractCaptured.add(chainKey);
  } catch {
    // best-effort — capture is diagnostic, never load-bearing
  }
}

// Patch the semantic verdict for the most recently-written round before the
// next round extends the hash chain. This keeps the existing "one capture per
// planner step" contract while letting the executor fill in the post-action
// predicate verdict after it observes the resulting browser state.
export function updateCapturedRoundSemantic(
  service: string,
  round: number,
  semantic: SemanticTransitionRecord,
): void {
  const dir = resolveCaptureDir();
  const runId = currentRunId(service);
  if (dir === null || runId === undefined) return;
  try {
    const slug = slugOf(service);
    const file = join(dir, `${slug}-${runId}-r${round}.json`);
    const current = JSON.parse(readFileSync(file, "utf8")) as OnboardingCaseFile;
    const payload: Omit<OnboardingCaseFile, "content_hash" | "expect"> = {
      capture_format_version: current.capture_format_version,
      name: current.name,
      service: current.service,
      oauth: current.oauth,
      state: current.state,
      inventory: current.inventory,
      observed: current.observed,
      semantic,
      ...(current.resolved_model !== undefined ? { resolved_model: current.resolved_model } : {}),
      ...(current.resolved_provider !== undefined ? { resolved_provider: current.resolved_provider } : {}),
      prev_hash: current.prev_hash,
    };
    const contentHash = computeContentHash(payload);
    const updated: OnboardingCaseFile = {
      ...payload,
      expect: current.expect,
      content_hash: contentHash,
    };
    writeFileSync(file, JSON.stringify(updated, null, 2));
    chainHead.set(`${slug}|${runId}`, contentHash);
  } catch {
    // best-effort — semantic verdicts are diagnostic, never load-bearing
  }
}

// ── Run-outcome sidecar (A2) ────────────────────────────────────────
//
// The captured rounds record what the planner *did*; they don't record
// whether the run as a whole *succeeded*. The offline eval (A3) needs
// that join: rounds from a SUCCESSFUL run are trustworthy next-step
// examples (they led to a credential); rounds from a FAILED run are the
// opposite — the planner's `observed` step there is a candidate for the
// REJECT list (it's a move that did NOT make progress). We write one
// `<slug>-<runId>.outcome.json` sidecar per run, joined to the rounds by
// the shared `<slug>-<runId>` stem.
//
// REDACTION (R3, P0): the sidecar carries credential FIELD NAMES only
// (e.g. ["api_key"]) — never values. The eval only needs "did we extract
// a credential"; persisting the value would write a live secret into the
// corpus that ships nowhere but is trivially leakable.

export interface RunOutcomeRecord {
  ok: boolean;
  // True when the run produced at least one non-empty credential field.
  credential_present: boolean;
  // The credential field NAMES (api_key / username / …) — safe labels,
  // never the secret values. See the REDACTION note above.
  credential_fields: readonly string[];
  // Which terminal stage a failed run stopped at (B1 taxonomy). "none" on
  // success. See classifyFailureStage in failure-stage.ts.
  failure_stage: FailureStage;
  // Coarse semantic diagnosis for the terminal failure. These fields make the
  // denominator explicit: planner-correctable failures are separate from
  // executor/transition failures and external walls/infra.
  semantic_failure_bucket?: SemanticFailureBucket;
  semantic_fault_class?: SemanticFaultClass;
  // Highest captured round index, or null if the run captured no rounds.
  terminal_round: number | null;
}

export interface OnboardingOutcomeFile {
  capture_format_version: typeof CAPTURE_FORMAT_VERSION;
  service: string;
  run_id: string;
  // Git commit of the bot code that produced this outcome. Older captures do
  // not have it; autoloop treats missing/non-current commits as stale.
  source_commit?: string;
  outcome: RunOutcomeRecord;
}

function currentSourceCommit(): string | undefined {
  const env = process.env.TRUSTY_SQUIRE_SOURCE_COMMIT?.trim();
  if (env !== undefined && env.length > 0) return env;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// True when this run captured at least one post-verify round. Lets the
// finalizer derive `reachedOnboarding` for the failure-stage classifier
// without re-reading the disk.
export function capturedAnyRound(): boolean {
  return lastRounds.size > 0;
}

export function capturedAnyRoundForService(service: string): boolean {
  return lastRounds.has(slugOf(service));
}

// Redaction-safe summary of a finished run. Pure + exported for tests.
export function summarizeRunOutcome(
  result: SignupResult,
  reachedOnboarding: boolean,
  terminalRound: number | null,
): RunOutcomeRecord {
  const creds = result.credentials;
  const fields = creds
    ? Object.keys(creds).filter((k) => {
        const v = creds[k];
        return typeof v === "string" && v.length > 0;
      })
    : [];
  const failureStage = classifyFailureStage(result, reachedOnboarding);
  const semantic =
    failureStage === "none"
      ? undefined
      : classifySemanticFailure({
          failureStage,
          ...(result.error !== undefined ? { error: result.error } : {}),
          reachedOnboarding,
        });
  return {
    ok: result.success,
    credential_present: fields.length > 0,
    credential_fields: fields,
    failure_stage: failureStage,
    ...(semantic !== undefined
      ? {
          semantic_failure_bucket: semantic.bucket,
          semantic_fault_class: semantic.fault_class,
        }
      : {}),
    terminal_round: terminalRound,
  };
}

// Write the run-outcome sidecar. Best-effort, like the round capture.
// Even zero-round runs get an outcome sidecar: the repair ledger uses later
// successes to suppress stale failures, and fast-path successes (credentials
// found immediately after OAuth) may not capture any post-verify rounds.
export function captureRunOutcome(service: string, result: SignupResult): void {
  const dir = resolveCaptureDir();
  if (dir === null) return;
  try {
    mkdirSync(dir, { recursive: true });
    const runId = runIdFor(service);
    const slug = slugOf(service);
    const lastRound = lastRounds.get(slug);
    const file = join(dir, `${slug}-${runId}.outcome.json`);
    const sourceCommit = currentSourceCommit();
    const record: OnboardingOutcomeFile = {
      capture_format_version: CAPTURE_FORMAT_VERSION,
      service,
      run_id: runId,
      ...(sourceCommit !== undefined ? { source_commit: sourceCommit } : {}),
      outcome: summarizeRunOutcome(result, lastRound !== undefined, lastRound ?? null),
    };
    writeFileSync(file, JSON.stringify(record, null, 2));
  } catch {
    // best-effort — outcome capture is diagnostic, never load-bearing
  }
}

// ── Promoter-side verification helpers ──────────────────────────────
//
// The synthesizer (Phase 2, apps/mcp/src/bot/promote-to-skill.ts) calls
// `verifyCaptureChain` before reading any round's content. The
// guarantee: if verification passes, the rounds came out of the bot
// exactly as captured, with no hand-edits. If verification fails, the
// promoter refuses to synthesize from this run and points at the
// offending round.

export type ChainVerification =
  | { ok: true; rounds: OnboardingCaseFile[] }
  | {
      ok: false;
      reason:
        | "unknown_version"
        | "hash_mismatch"
        | "prev_hash_mismatch"
        | "missing_round"
        | "no_rounds"
        | "parse_error";
      offending_round?: number;
      detail?: string;
    };

/**
 * Read every `*-r<n>.json` file for the given run from `dir`, parse
 * each, and verify both the per-round `content_hash` and the chain
 * via `prev_hash`. Returns the parsed rounds in order on success;
 * a structured rejection otherwise.
 *
 * The promoter (Phase 2) uses this as its very first step in Stage 1.
 * A failure here is logged as a synthesizer rejection with stage=
 * "synthesis" and error_kind matching `reason`.
 */
export function verifyCaptureChain(
  dir: string,
  service: string,
  runId: string,
): ChainVerification {
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const prefix = `${slug}-${runId}-r`;

  let entries: string[];
  try {
    entries = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .sort((a, b) => {
        // Numeric sort by round index — string sort would order
        // r10 before r2, which would break the chain check below.
        const aIdx = Number.parseInt(a.slice(prefix.length, -".json".length), 10);
        const bIdx = Number.parseInt(b.slice(prefix.length, -".json".length), 10);
        return aIdx - bIdx;
      });
  } catch (err) {
    return {
      ok: false,
      reason: "missing_round",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (entries.length === 0) {
    return { ok: false, reason: "no_rounds" };
  }

  const rounds: OnboardingCaseFile[] = [];
  let expectedPrevHash: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const expectedIndex = i;
    const filename = entries[i];
    if (filename === undefined) {
      return { ok: false, reason: "missing_round", offending_round: i };
    }
    const actualIndex = Number.parseInt(
      filename.slice(prefix.length, -".json".length),
      10,
    );
    if (actualIndex !== expectedIndex) {
      // Gap in the chain — a round was deleted between captures.
      return { ok: false, reason: "missing_round", offending_round: expectedIndex };
    }

    let parsed: OnboardingCaseFile;
    try {
      parsed = JSON.parse(readFileSync(join(dir, filename), "utf8")) as OnboardingCaseFile;
    } catch (err) {
      return {
        ok: false,
        reason: "parse_error",
        offending_round: expectedIndex,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (parsed.capture_format_version !== CAPTURE_FORMAT_VERSION) {
      return {
        ok: false,
        reason: "unknown_version",
        offending_round: expectedIndex,
        detail: `got version ${String(parsed.capture_format_version)}, expected ${CAPTURE_FORMAT_VERSION}`,
      };
    }

    if (parsed.prev_hash !== expectedPrevHash) {
      return {
        ok: false,
        reason: "prev_hash_mismatch",
        offending_round: expectedIndex,
        detail: `prev_hash=${String(parsed.prev_hash)}, chain expected ${String(expectedPrevHash)}`,
      };
    }

    // Recompute the content hash and verify it matches what's on disk.
    // Hand-edits to any field except expect/content_hash will be
    // caught here.
    const { content_hash: storedHash, expect: _expect, ...rest } = parsed;
    const recomputed = computeContentHash(rest);
    if (recomputed !== storedHash) {
      return {
        ok: false,
        reason: "hash_mismatch",
        offending_round: expectedIndex,
        detail: `stored=${storedHash}, recomputed=${recomputed}`,
      };
    }

    rounds.push(parsed);
    expectedPrevHash = storedHash;
  }

  return { ok: true, rounds };
}
