// label-target.ts — turn a real stuck-page capture into a committed,
// REDACTED target eval case (docs/DESIGN-planner-navigation-eval.md, A4).
// DEV HARNESS, not shipped.
//
// The target set is the generalization signal: the ~20 N1 services whose
// post-OAuth navigation the planner gets stuck on. Each case is one captured
// page + the SET of acceptable next-step kinds (and the explicitly-wrong
// ones). Labeling is human judgement; this harness does the mechanical part —
// it copies the page substrate, RUNS IT THROUGH THE SAME R3 REDACTION as the
// regress builder (target cases are committed too, so a planted key on the
// page must never land here), and writes the case to the right tune/holdout
// bucket with a stable content-hash id.
//
//   Run (operator supplies the label after reading the page):
//     cd apps/mcp && npx tsx src/bot/label-target.ts \
//       <capture.json> --theme=create-resource --accept=click,navigate \
//       --reject=done,extract --selectors='#create-key' \
//       --rationale='keys-empty page — must click Create, not give up'
//
//   --holdout writes to target/holdout/ (sealed; report-only, never tuned on).
//   --source defaults to "human"; pass "llm_proposed_human_confirmed" when an
//   LLM proposed the label and a human confirmed it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  caseId,
  identityTokensForCase,
  pageSignature,
  redactInventory,
  redactPageState,
} from "./build-corpus.js";
import {
  EVAL_CORPUS_ROOT,
  type EvalCaseFile,
  type EvalSource,
} from "./eval-corpus.js";
import type { OnboardingCaseFile } from "./onboarding-capture.js";
import type { PostVerifyStep } from "./agent.js";

type StepKind = PostVerifyStep["kind"];

const VALID_KINDS: ReadonlySet<string> = new Set([
  "click",
  "fill",
  "navigate",
  "extract",
  "select",
  "done",
  "login",
  "wait",
  "scroll",
]);

export interface LabelInput {
  acceptKinds: StepKind[];
  rejectKinds?: StepKind[];
  selectorsAnyOf?: string[];
  theme?: string;
  rationale?: string;
  source?: EvalSource;
  holdout?: boolean;
}

// Build a redacted target case from a raw capture + a human label. Pure +
// exported for testing. Throws on an empty/invalid acceptKinds set — a target
// case with no accepted answer can't measure anything.
export function buildTargetCase(
  capture: OnboardingCaseFile,
  label: LabelInput,
): EvalCaseFile {
  if (label.acceptKinds.length === 0) {
    throw new Error("acceptKinds must be non-empty — a target case needs a correct answer");
  }
  for (const k of [...label.acceptKinds, ...(label.rejectKinds ?? [])]) {
    if (!VALID_KINDS.has(k)) throw new Error(`unknown step kind: ${k}`);
  }
  const sig = pageSignature(capture.service, capture.state, capture.inventory);
  const idTokens = identityTokensForCase(capture.state, capture.inventory);
  return {
    id: caseId(sig),
    service: capture.service,
    set: "target",
    source: label.source ?? "human",
    ...(label.holdout !== undefined ? { holdout: label.holdout } : {}),
    ...(label.theme !== undefined ? { theme: label.theme } : {}),
    ...(label.rationale !== undefined ? { rationale: label.rationale } : {}),
    name: `${capture.service} — ${capture.state.title || capture.state.url}`,
    oauth: capture.oauth,
    state: redactPageState(capture.state, idTokens),
    inventory: redactInventory(capture.inventory, idTokens),
    expect: {
      acceptKinds: [...label.acceptKinds].sort(),
      ...(label.rejectKinds && label.rejectKinds.length > 0
        ? { rejectKinds: [...label.rejectKinds].sort() }
        : {}),
      ...(label.selectorsAnyOf && label.selectorsAnyOf.length > 0
        ? { selectorsAnyOf: label.selectorsAnyOf }
        : {}),
    },
  };
}

function parseList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function flag(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

function main(): void {
  const captureFile = process.argv[2];
  if (captureFile === undefined || captureFile.startsWith("--")) {
    console.error("usage: label-target.ts <capture.json> --theme=… --accept=… [--reject=…] [--selectors=…] [--rationale=…] [--holdout] [--source=…]");
    process.exitCode = 2;
    return;
  }
  const accept = parseList(flag("accept"));
  if (accept === undefined || accept.length === 0) {
    console.error("--accept is required (comma-separated step kinds)");
    process.exitCode = 2;
    return;
  }
  const capture = JSON.parse(readFileSync(captureFile, "utf8")) as OnboardingCaseFile;
  const holdout = process.argv.includes("--holdout");
  const reject = parseList(flag("reject"));
  const selectors = parseList(flag("selectors"));
  const theme = flag("theme");
  const rationale = flag("rationale");
  const source = flag("source");
  const label: LabelInput = {
    acceptKinds: accept as StepKind[],
    holdout,
    ...(reject !== undefined ? { rejectKinds: reject as StepKind[] } : {}),
    ...(selectors !== undefined ? { selectorsAnyOf: selectors } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(source !== undefined ? { source: source as EvalSource } : {}),
  };
  const evalCase = buildTargetCase(capture, label);
  const outDir = join(EVAL_CORPUS_ROOT, "target", holdout ? "holdout" : "tune");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${evalCase.id}.json`);
  writeFileSync(outFile, `${JSON.stringify(evalCase, null, 2)}\n`);
  console.error(`[label-target] wrote ${outFile} (${evalCase.service}, accept=${evalCase.expect.acceptKinds.join("/")})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
