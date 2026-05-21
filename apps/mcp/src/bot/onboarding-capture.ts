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
// Inert unless TRUSTY_SQUIRE_ONBOARDING_CAPTURE names a directory —
// production never sets it (same env-gated pattern as debug.ts).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";

// Capture format version. Bumped when round-shape changes incompatibly.
// The promoter rejects unknown versions (E2). Same-major minor changes
// (new optional fields) stay forward-compatible.
export const CAPTURE_FORMAT_VERSION = 1 as const;

// One run-scoped id so a multi-service process (the batch harness)
// keeps each service's rounds grouped without collisions.
let runId: string | undefined;

// Per-(service, runId) chain head. Each new round's `prev_hash` is the
// previous round's `content_hash`; round 0's `prev_hash` is null. The
// promoter walks the chain forward and rejects on any break.
//
// Map key is `${service}|${runId}` so cross-service concurrent
// captures don't bleed into each other. Cleared at process exit by
// being process-scoped (no persistence — captures restart fresh on
// next process).
const chainHead = new Map<string, string>();

export interface OnboardingRoundCapture {
  service: string;
  round: number;
  oauth: boolean;
  state: { url: string; title: string; html: string; screenshot: string };
  inventory: readonly InteractiveElement[];
  // The step the planner actually chose this round — a reference for
  // the curator, NOT ground truth (the planner may have been wrong).
  observed: PostVerifyStep;
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

// Dump one onboarding round to the capture directory, if configured.
// Best-effort: a capture failure must never break a signup run.
export function captureOnboardingRound(entry: OnboardingRoundCapture): void {
  const dir = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  if (dir === undefined || dir.trim().length === 0) return;
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
  } catch {
    // best-effort — capture is diagnostic, never load-bearing
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
