// Fix-grading ledger — the feedback half of the output loop (#1).
//
// The fix-agent (modes/fix.ts) commits a generalizing fix as an RC and records
// here WHAT it targeted (the cluster's services + signature) and at which RC.
// A later heal pass — once that RC has actually run discovery — grades the
// attempt by checking whether those same services now succeed. That closes the
// loop: a fix isn't "done" when it commits, it's done when the next run proves
// it lifted (or didn't) the rate on the services it was meant to fix.
//
// State lives next to the unknown-state store (~/.config/trusty-squire/), is
// operator-only, and is excluded from the npm tarball with the rest of
// housekeeper/. Grading is pure (gradeAttempt/applyGrades) so it's unit-tested
// without touching the filesystem; the FS wrappers are thin.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FixGrade =
  | "improved" // every re-tested target now succeeds
  | "partial" // some, not all, re-tested targets now succeed
  | "regressed" // none of the re-tested targets succeed — fix didn't help (or hurt)
  | "no_data"; // the pass didn't re-test any target — stays open for a later pass

export interface FixAttempt {
  rc_version: string; // the RC the fix shipped in (HealRun.mcp_version to match against)
  cluster_id: string;
  services: string[]; // the services the fix targeted — what we grade against
  signature: string; // the stuck-page signature the cluster shared
  summary: string; // the proposer's one-line description of the fix
  committed_at: string; // ISO
  status: "open" | "graded";
  grade?: FixGrade;
  graded_at?: string;
  graded_detail?: { tested: number; passed: number };
}

// Pure. Grade one open attempt against a map of service→succeeded captured from
// a discovery pass that ran AT/AFTER the fix's RC. Services the pass didn't
// re-test are ignored; if none were re-tested the attempt stays `no_data`.
export function gradeAttempt(
  attempt: FixAttempt,
  serviceSucceeded: ReadonlyMap<string, boolean>,
): { grade: FixGrade; tested: number; passed: number } {
  const tested = attempt.services.filter((s) => serviceSucceeded.has(s));
  if (tested.length === 0) return { grade: "no_data", tested: 0, passed: 0 };
  const passed = tested.filter((s) => serviceSucceeded.get(s) === true).length;
  if (passed === tested.length) return { grade: "improved", tested: tested.length, passed };
  if (passed === 0) return { grade: "regressed", tested: tested.length, passed };
  return { grade: "partial", tested: tested.length, passed };
}

// Pure. Apply grading to a ledger snapshot. Open attempts that resolve to a
// real grade (not no_data) flip to `graded`; no_data attempts stay open for a
// later pass. Returns the new ledger + the attempts graded THIS pass (for the
// digest line). Deliberately does NOT re-grade already-graded attempts — a
// fix's verdict is recorded once, against the first pass that re-tested it.
export function applyGrades(
  ledger: readonly FixAttempt[],
  serviceSucceeded: ReadonlyMap<string, boolean>,
  nowIso: string,
): { ledger: FixAttempt[]; newlyGraded: FixAttempt[] } {
  const newlyGraded: FixAttempt[] = [];
  const next = ledger.map((a) => {
    if (a.status !== "open") return a;
    const { grade, tested, passed } = gradeAttempt(a, serviceSucceeded);
    if (grade === "no_data") return a;
    const graded: FixAttempt = {
      ...a,
      status: "graded",
      grade,
      graded_at: nowIso,
      graded_detail: { tested, passed },
    };
    newlyGraded.push(graded);
    return graded;
  });
  return { ledger: next, newlyGraded };
}

// One human line per newly-graded attempt, for the digest.
export function describeGrade(a: FixAttempt): string {
  const mark = a.grade === "improved" ? "✓" : a.grade === "regressed" ? "✗" : "≈";
  const d = a.graded_detail;
  const ratio = d !== undefined ? ` (${d.passed}/${d.tested} targets pass)` : "";
  return `${mark} ${a.grade} · ${a.rc_version} · ${a.services.join(",")}${ratio} — ${a.summary}`;
}

function resolveLedgerPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configHome, "trusty-squire", "fix-ledger.json");
}

export function readFixLedger(path: string = resolveLedgerPath()): FixAttempt[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as FixAttempt[]) : [];
  } catch {
    return []; // corrupt ledger → start fresh rather than crash the pass
  }
}

export function writeFixLedger(ledger: readonly FixAttempt[], path: string = resolveLedgerPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), "utf8");
}

// Append freshly-committed fix attempts (status 'open') to the ledger.
export function appendFixAttempts(
  attempts: readonly FixAttempt[],
  path: string = resolveLedgerPath(),
): void {
  if (attempts.length === 0) return;
  writeFixLedger([...readFixLedger(path), ...attempts], path);
}

// Read → grade against this pass's outcomes → persist → return the newly-graded
// attempts so the caller can fold them into the digest. The full FS round-trip
// the orchestrator calls once per heal pass.
export function gradeLedgerAgainstPass(
  serviceSucceeded: ReadonlyMap<string, boolean>,
  nowIso: string,
  path: string = resolveLedgerPath(),
): FixAttempt[] {
  const { ledger, newlyGraded } = applyGrades(readFixLedger(path), serviceSucceeded, nowIso);
  if (newlyGraded.length > 0) writeFixLedger(ledger, path);
  return newlyGraded;
}
