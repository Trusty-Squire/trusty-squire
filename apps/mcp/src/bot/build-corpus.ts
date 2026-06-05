// build-corpus.ts — auto-derive the REGRESS eval set from live captures
// (docs/DESIGN-planner-navigation-eval.md, A3). DEV SCRIPT, not shipped.
//
//   Run:  cd apps/mcp && npx tsx src/bot/build-corpus.ts [captureDir]
//   (captureDir defaults to the onboarding capture dir; output goes to
//    apps/mcp/corpus/eval/regress/. Excluded from the published dist.)
//
// Pipeline:
//   1. Walk the raw capture dir: round files (`<slug>-<runId>-r<N>.json`) +
//      outcome sidecars (`<slug>-<runId>.outcome.json`, from A2).
//   2. Group by `<slug>-<runId>`; join each run's rounds to its outcome.
//   3. For SUCCESSFUL runs, group rounds by an equivalent-page signature and
//      UNION their observed step KINDS → acceptKinds. For FAILED runs, the
//      terminal (stuck) round's kind is a reject candidate — kept only if it
//      was never a good kind on that page (R1: never reject a known-good move).
//   4. REDACT every emitted case (R3, P0) — see redactText — and DROP the
//      screenshot (unredactable, may show a secret). Write redacted cases to
//      the committed regress dir. The raw captures themselves stay in $HOME
//      (gitignored); only the redacted corpus is committed.
//
// Determinism: case ids are content hashes of the page signature (stable git
// diffs, no timestamps).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";
import {
  resolveCaptureDir,
  type OnboardingCaseFile,
  type OnboardingOutcomeFile,
} from "./onboarding-capture.js";
import { EVAL_CORPUS_ROOT, type EvalCaseFile } from "./eval-corpus.js";
import type { OnboardingEvalCase } from "./eval-onboarding.js";

type StepKind = PostVerifyStep["kind"];

// A 1x1 transparent PNG — replaces every captured screenshot in the committed
// corpus. Screenshots can embed a freshly-revealed key in the rendered page;
// they cannot be regex-redacted, so they are dropped wholesale.
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ── Redaction (R3, P0) ──────────────────────────────────────────────
//
// Captures are real page DOMs from real signups — they contain the run's
// email/alias and, on a key page, the actual provisioned secret. None of that
// may land in a committed file. We redact by SHAPE (provider key prefixes,
// JWTs, emails) and by ENTROPY (long mixed-alnum runs catch unprefixed
// tokens). Over-redaction only blurs the page slightly; under-redaction leaks
// a live secret — so the entropy sweep is deliberately aggressive.

const SECRET_PATTERNS: readonly RegExp[] = [
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  // GitHub tokens
  /\bgh[posru]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer header values
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
  // Prefixed provider keys (sk-/pk_/rnd_/tsq_/re_/key-/api_/token_ …)
  /\b(?:sk|pk|rk|ak|sb|re|rnd|tsq|key|api|tok|token|secret|access)[-_][A-Za-z0-9]{12,}\b/gi,
  // Long hex runs — API tokens / hashes that carry no prefix and fall under
  // the 32-char high-entropy floor (e.g. IPInfo's 14-hex access token). 12+
  // pure-hex is overwhelmingly a token/hash, not page text.
  /\b[0-9a-f]{12,}\b/gi,
];
// Email / alias — both the local and inbound trustysquire aliases plus any
// other address present in the page.
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// High-entropy catch-all: a >=32-char run of [A-Za-z0-9_-] that contains at
// least one digit AND one letter (excludes plain words and pure hex class
// hashes that the planner might key on are still caught — acceptable).
const HIGH_ENTROPY_PATTERN =
  /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

// Generic email local-parts that are roles, not identities — never scrub these
// as PII (they'd over-redact legitimate page text).
const GENERIC_LOCALPARTS: ReadonlySet<string> = new Set([
  "support",
  "contact",
  "noreply",
  "no-reply",
  "account",
  "billing",
  "security",
  "notifications",
]);

// Collect identity tokens from a case's full text: the local-part of every
// email present (e.g. "lunchboxfortwo" from "lunchboxfortwo@gmail.com"). The
// operator's handle leaks as a bare username in team names ("lunchboxfortwo's
// team") and URL paths ("/users/lunchboxfortwo/…") that carry no "@", so the
// email pattern alone misses them. We scrub the local-part everywhere it
// appears. Length >=6 + the generic-role denylist keeps us off common words.
export function collectIdentityTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(EMAIL_PATTERN)) {
    const local = m[0].split("@")[0];
    if (local === undefined) continue;
    const lc = local.toLowerCase();
    if (lc.length >= 6 && !GENERIC_LOCALPARTS.has(lc)) tokens.add(lc);
  }
  return tokens;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(
  input: string,
  identityTokens: ReadonlySet<string> = new Set(),
): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED_SECRET]");
  out = out.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  // Identity handles: substring (not word-boundary) so "Llunchboxfortwo" and
  // "/teams/lunchboxfortwo" are both caught. Tokens are >=6-char distinct
  // account handles, so substring scrubbing won't hit common words.
  for (const tok of identityTokens) {
    out = out.replace(new RegExp(escapeRegExp(tok), "gi"), "[REDACTED_ID]");
  }
  // High-entropy catch-all → "x". The sweep mostly fires on CSS-in-JS class
  // hashes and data-attrs (page NOISE), not real secrets, and a page littered
  // with "[REDACTED_TOKEN]" strings misleads the planner into reaching for
  // {"kind":"extract"} — an eval artifact that doesn't happen on the real
  // (unredacted) page. A neutral "x" still removes any unprefixed secret while
  // not reading as an extractable token. (Prefixed keys / JWTs / emails keep
  // their explicit labels above — those are few and meaningful.)
  out = out.replace(HIGH_ENTROPY_PATTERN, "x");
  return out;
}

// Operator handles to ALWAYS scrub, regardless of whether the email
// co-occurs on the page. The operator's stable identity (a GitHub/Google
// handle like "lunchboxfortwo") shows up as an avatar alt / username / URL
// path on services where the full email never appears, so the email-local-part
// derivation alone misses it. Configured, not hardcoded:
//   TRUSTY_SQUIRE_REDACT_IDENTITIES=lunchboxfortwo,otherhandle
export function envIdentityTokens(): string[] {
  const raw = process.env.TRUSTY_SQUIRE_REDACT_IDENTITIES;
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
}

// Gather every identity token across a whole capture (state + inventory text)
// so the local-part of an email in one field scrubs the bare handle in another,
// plus any operator handles from the env denylist.
export function identityTokensForCase(
  state: OnboardingCaseFile["state"],
  inventory: readonly InteractiveElement[],
): Set<string> {
  const parts: string[] = [state.url, state.title, state.html];
  for (const e of inventory) {
    for (const v of [
      e.id, e.name, e.placeholder, e.ariaLabel, e.labelText, e.visibleText,
      e.selector, e.href, e.iconLabel, e.title, e.value, e.selectedOptionText,
    ]) {
      if (typeof v === "string") parts.push(v);
    }
  }
  const tokens = collectIdentityTokens(parts.join("\n"));
  for (const t of envIdentityTokens()) tokens.add(t);
  return tokens;
}

export function redactInventory(
  inv: readonly InteractiveElement[],
  identityTokens: ReadonlySet<string> = new Set(),
): InteractiveElement[] {
  const r = (v: string | null): string | null => (v === null ? null : redactText(v, identityTokens));
  return inv.map((e) => ({
    ...e,
    id: r(e.id),
    name: r(e.name),
    placeholder: r(e.placeholder),
    ariaLabel: r(e.ariaLabel),
    labelText: r(e.labelText),
    visibleText: r(e.visibleText),
    selector: redactText(e.selector, identityTokens),
    ...(e.href !== undefined ? { href: r(e.href ?? null) } : {}),
    ...(e.iconLabel !== undefined ? { iconLabel: r(e.iconLabel ?? null) } : {}),
    ...(e.title !== undefined ? { title: r(e.title ?? null) } : {}),
    ...(e.value !== undefined ? { value: r(e.value ?? null) } : {}),
    ...(e.selectedOptionText !== undefined
      ? { selectedOptionText: r(e.selectedOptionText ?? null) }
      : {}),
    ...(e.selectOptions != null
      ? {
          selectOptions: e.selectOptions.map((o) => ({
            value: redactText(o.value, identityTokens),
            text: redactText(o.text, identityTokens),
          })),
        }
      : {}),
  }));
}

export function redactPageState(
  state: OnboardingCaseFile["state"],
  identityTokens: ReadonlySet<string> = new Set(),
): OnboardingEvalCase["state"] {
  return {
    url: redactText(state.url, identityTokens),
    title: redactText(state.title, identityTokens),
    html: redactText(state.html, identityTokens),
    screenshot: BLANK_PNG,
  };
}

// ── Page-equivalence signature (R5 semantic dedup) ──────────────────
//
// Two captures are the "same page" when same service + same URL path + same
// set of actionable selectors. Differing inventories → distinct cases, so
// genuine state variants (e.g. keys-present vs keys-empty on one URL) are
// preserved rather than collapsed.

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return (url.split(/[?#]/)[0] ?? url).replace(/\/+$/, "");
  }
}

export function pageSignature(
  service: string,
  state: OnboardingCaseFile["state"],
  inventory: readonly InteractiveElement[],
): string {
  const selectors = inventory.map((e) => e.selector).sort().join("|");
  return `${service.toLowerCase()}::${normalizeUrl(state.url)}::${selectors}`;
}

export function caseId(signature: string): string {
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

// ── Build ───────────────────────────────────────────────────────────

// One captured round paired with its authoritative 0-based index (from the
// `-r<N>` filename, not the case body — the body has no numeric round).
export interface CapturedRound {
  index: number;
  case: OnboardingCaseFile;
}

export interface RunGroup {
  service: string;
  runId: string;
  rounds: CapturedRound[]; // sorted ascending by index
  outcome: OnboardingOutcomeFile | null;
}

interface AcceptAgg {
  kinds: Set<StepKind>;
  sample: OnboardingCaseFile; // first capture of this signature — the substrate
}

// Credential VALUES a successful run surfaced — the regress redactor must
// scrub them from the success-page html, because a regress case is built FROM
// a successful run and that page shows the extracted key. The planner quotes
// the value in its extract-step reason ("access_token='f9a0…'"); such values
// are often short / unprefixed (a 14-char IPInfo token) and would slip the
// generic sweeps, but they are REAL secrets and must never reach the committed
// corpus. Substring-scrubbed (case-insensitive), so over-inclusion of a
// non-secret reason word is a harmless no-op unless it's literally on the page.
const REASON_TOKEN = /[`'"=:\s(]([A-Za-z0-9][A-Za-z0-9_.\-]{7,})[`'")]?/g;
export function credentialValuesFromRuns(groups: readonly RunGroup[]): Set<string> {
  const values = new Set<string>();
  for (const g of groups) {
    if (g.outcome?.outcome.ok !== true) continue; // only success pages show keys
    for (const r of g.rounds) {
      const obs = r.case.observed as { reason?: string };
      const reason = typeof obs.reason === "string" ? obs.reason : "";
      for (const m of reason.matchAll(REASON_TOKEN)) {
        const v = m[1];
        if (v !== undefined && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) values.add(v);
      }
    }
  }
  return values;
}

// Derive regress cases from grouped runs. Pure — exported for unit testing.
export function buildRegressCases(groups: readonly RunGroup[]): EvalCaseFile[] {
  // Global secret denylist — extracted credential values across all successful
  // runs, scrubbed from EVERY emitted case's html (a no-op where absent).
  const credentialValues = credentialValuesFromRuns(groups);
  const accept = new Map<string, AcceptAgg>();
  const stuck = new Map<string, Set<StepKind>>();

  for (const g of groups) {
    const ok = g.outcome?.outcome.ok === true;
    const terminal = g.outcome?.outcome.terminal_round ?? null;
    for (const r of g.rounds) {
      const sig = pageSignature(g.service, r.case.state, r.case.inventory);
      if (ok) {
        let agg = accept.get(sig);
        if (agg === undefined) {
          agg = { kinds: new Set(), sample: r.case };
          accept.set(sig, agg);
        }
        agg.kinds.add(r.case.observed.kind);
      } else if (terminal !== null && r.index === terminal) {
        // The action on a failed run's terminal round did NOT advance.
        const set = stuck.get(sig) ?? new Set<StepKind>();
        set.add(r.case.observed.kind);
        stuck.set(sig, set);
      }
    }
  }

  const cases: EvalCaseFile[] = [];
  for (const [sig, agg] of accept) {
    const acceptKinds = [...agg.kinds].sort();
    const stuckKinds = stuck.get(sig);
    // R1: a kind is only a reject if it stuck a failed run AND was never a
    // good kind on this page. Never reject a known-good move.
    const rejectKinds = stuckKinds
      ? [...stuckKinds].filter((k) => !agg.kinds.has(k)).sort()
      : [];
    const id = caseId(sig);
    const idTokens = identityTokensForCase(agg.sample.state, agg.sample.inventory);
    for (const v of credentialValues) idTokens.add(v);
    cases.push({
      id,
      service: agg.sample.service,
      set: "regress",
      source: "gold_path",
      name: `${agg.sample.service} — ${normalizeUrl(agg.sample.state.url)}`,
      oauth: agg.sample.oauth,
      state: redactPageState(agg.sample.state, idTokens),
      inventory: redactInventory(agg.sample.inventory, idTokens),
      expect: {
        acceptKinds,
        ...(rejectKinds.length > 0 ? { rejectKinds } : {}),
      },
    });
  }
  // Deterministic order so the committed corpus diffs cleanly.
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}

// ── Capture-dir reader ──────────────────────────────────────────────

const ROUND_RE = /^(.+)-r(\d+)\.json$/;
const OUTCOME_SUFFIX = ".outcome.json";

// Read a raw capture dir into grouped runs. Best-effort: a malformed file is
// skipped, not fatal.
export function readCaptureGroups(dir: string): RunGroup[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const byStem = new Map<string, { rounds: CapturedRound[]; outcome: OnboardingOutcomeFile | null }>();
  const ensure = (stem: string) => {
    let g = byStem.get(stem);
    if (g === undefined) {
      g = { rounds: [], outcome: null };
      byStem.set(stem, g);
    }
    return g;
  };

  for (const f of files) {
    try {
      if (f.endsWith(OUTCOME_SUFFIX)) {
        const stem = f.slice(0, -OUTCOME_SUFFIX.length);
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as OnboardingOutcomeFile;
        ensure(stem).outcome = parsed;
        continue;
      }
      const m = ROUND_RE.exec(f);
      if (m === null) continue;
      const stem = m[1]!;
      const index = Number.parseInt(m[2]!, 10);
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as OnboardingCaseFile;
      ensure(stem).rounds.push({ index, case: parsed });
    } catch {
      // skip malformed
    }
  }

  const groups: RunGroup[] = [];
  for (const [stem, g] of byStem) {
    if (g.rounds.length === 0) continue; // outcome with no rounds — nothing to build
    const rounds = g.rounds.sort((a, b) => a.index - b.index);
    groups.push({
      service: rounds[0]!.case.service,
      runId: stem,
      rounds,
      outcome: g.outcome,
    });
  }
  return groups;
}

function writeCases(cases: readonly EvalCaseFile[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const c of cases) {
    writeFileSync(join(outDir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
  }
}

async function main(): Promise<void> {
  const argDir = process.argv[2];
  const captureDir = argDir ?? resolveCaptureDir();
  if (captureDir === null) {
    console.error("[build-corpus] no capture dir (capture disabled?) — pass one as argv[2]");
    process.exitCode = 2;
    return;
  }
  const groups = readCaptureGroups(captureDir);
  const successful = groups.filter((g) => g.outcome?.outcome.ok === true).length;
  console.error(
    `[build-corpus] ${groups.length} run(s) in ${captureDir} (${successful} successful)`,
  );
  const cases = buildRegressCases(groups);
  const outDir = join(EVAL_CORPUS_ROOT, "regress");
  writeCases(cases, outDir);
  console.error(`[build-corpus] wrote ${cases.length} redacted regress case(s) → ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
