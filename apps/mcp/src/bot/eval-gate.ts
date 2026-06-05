// eval-gate.ts — the gated runner (docs/DESIGN-planner-navigation-eval.md,
// A5). DEV HARNESS, not shipped. Loads the committed eval corpus, runs the
// post-OAuth navigation planner at temp 0 (A1) over every case, and prints:
//
//   regress: X/X · target-tune: a/b · target-holdout: c/d
//
// Exit code is non-zero when the REGRESS bucket isn't perfect — that's the
// merge gate (A6 wires it into CI). Target buckets are the generalization
// signal (report-only; never block).
//
//   Run: cd apps/mcp && UNIVERSAL_BOT_LLM_TIER=free npx tsx src/bot/eval-gate.ts
//   (needs an LLM — a real planner call per case. Deterministic at temp 0.)

import { SignupAgent, type PostVerifyStep } from "./agent.js";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { pickLLMPair } from "./llm-client.js";
import {
  loadEvalCorpus,
  regressGatePassed,
  scoreBucket,
  scoreRegress,
  type EvalCaseFile,
  type GateBucketResult,
} from "./eval-corpus.js";

type PlanInput = {
  service: string;
  round: number;
  maxRounds: number;
  state: EvalCaseFile["state"];
  oauth: boolean;
  inventory: InteractiveElement[];
  priorActions?: readonly string[];
};

// Returns a plan function that scoreBucket drives over each case. Each case
// gets a FRESH SignupAgent: the agent holds a per-signup LLM-call circuit
// breaker (MAX_LLM_CALLS_PER_SIGNUP, default 15), and a shared agent would
// accumulate that counter across cases — so once the corpus passes ~15 cases
// every later case spuriously fails with "exceeded LLM call budget". The
// planner never touches the browser, so a dummy controller is safe; the LLM
// clients are stateless and shared across agents.
function makePlanner(): (c: EvalCaseFile) => Promise<PostVerifyStep> {
  const dummyBrowser = {} as unknown as BrowserController;
  const llm = pickLLMPair({ preferCheap: true });
  return (c: EvalCaseFile) => {
    const agent = new SignupAgent(dummyBrowser, llm);
    const planFor = (
      agent as unknown as { planPostVerifyStep: (i: PlanInput) => Promise<PostVerifyStep> }
    ).planPostVerifyStep.bind(agent);
    return planFor({
      service: c.service,
      round: 0,
      maxRounds: 8,
      state: c.state,
      oauth: c.oauth,
      inventory: c.inventory,
      ...(c.priorActions !== undefined ? { priorActions: c.priorActions } : {}),
    });
  };
}

function printFailures(label: string, bucket: GateBucketResult): void {
  for (const f of bucket.failures) {
    console.log(`  ${label} FAIL  ${f.service} ${f.id} — ${f.detail}`);
  }
}

async function main(): Promise<void> {
  const { regress, targetTune, targetHoldout } = loadEvalCorpus();
  if (regress.length === 0) {
    console.error(
      "[eval-gate] regress set is empty — run build-corpus first (no captures yet?)",
    );
  }
  const plan = makePlanner();
  // Regress is REJECT-driven (R1): fail only on a known-wrong action, never on
  // differing from the one historical accept kind. Target is accept+reject.
  const r = await scoreBucket(regress, plan, scoreRegress);
  const tt = await scoreBucket(targetTune, plan);
  const th = await scoreBucket(targetHoldout, plan);

  console.log(
    `regress: ${r.passed}/${r.total} · ` +
      `target-tune: ${tt.passed}/${tt.total} · ` +
      `target-holdout: ${th.passed}/${th.total}`,
  );
  printFailures("REGRESS", r);
  printFailures("target", tt);
  printFailures("target", th);

  // Only the regress bucket gates. An empty regress set passes vacuously but
  // we warned above — CI (A6) treats an empty corpus as a configuration error
  // separately.
  process.exitCode = regressGatePassed(r) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
