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

// Capture format version. Bumped when round-shape changes incompatibly.
// The promoter rejects unknown versions (E2). Same-major minor changes
// (new optional fields) stay forward-compatible.
export const CAPTURE_FORMAT_VERSION = 1 as const;

// One run-scoped id so a multi-service process (the batch harness)
// keeps each service's rounds grouped without collisions.
let runId: string | undefined;

// Read the in-process runId. Auto-promote needs to know which run's
// captures to promote after a successful signup. Returns undefined
// when no rounds have been captured yet — auto-promote then skips
// with a useful message rather than promoting nothing.
export function currentRunId(): string | undefined {
  return runId;
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
export function resetCaptureChain(): void {
  runId = undefined;
  chainHead.clear();
  lastRound = undefined;
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
let lastRound: number | undefined;

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
    if (runId === undefined) runId = Date.now().toString(36);
    const slug = entry.service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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
    lastRound = Math.max(lastRound ?? -1, entry.round);
  } catch {
    // best-effort — capture is diagnostic, never load-bearing
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
  return lastRound !== undefined;
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
  return {
    ok: result.success,
    credential_present: fields.length > 0,
    credential_fields: fields,
    failure_stage: classifyFailureStage(result, reachedOnboarding),
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
    if (runId === undefined) runId = Date.now().toString(36);
    const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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
