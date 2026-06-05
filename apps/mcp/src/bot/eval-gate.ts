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
  type EvalCaseFile,
  type GateBucketResult,
} from "./eval-corpus.js";

// Bind planPostVerifyStep off a dummy-browser agent — the planner never
// touches the browser (same pattern as eval-onboarding.ts). Returns a plan
// function that scoreBucket drives over each case.
function makePlanner(): (c: EvalCaseFile) => Promise<PostVerifyStep> {
  const dummyBrowser = {} as unknown as BrowserController;
  const agent = new SignupAgent(dummyBrowser, pickLLMPair({ preferCheap: true }));
  const planFor = (
    agent as unknown as {
      planPostVerifyStep: (i: {
        service: string;
        round: number;
        maxRounds: number;
        state: EvalCaseFile["state"];
        oauth: boolean;
        inventory: InteractiveElement[];
        priorActions?: readonly string[];
      }) => Promise<PostVerifyStep>;
    }
  ).planPostVerifyStep.bind(agent);

  return (c: EvalCaseFile) =>
    planFor({
      service: c.service,
      round: 0,
      maxRounds: 8,
      state: c.state,
      oauth: c.oauth,
      inventory: c.inventory,
      ...(c.priorActions !== undefined ? { priorActions: c.priorActions } : {}),
    });
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
  const r = await scoreBucket(regress, plan);
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
