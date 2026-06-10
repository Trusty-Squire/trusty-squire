// eval-page.ts — replay the post-OAuth navigation planner against ONE captured
// page and print the action it picks. DEV HARNESS, not shipped (excluded from
// tsconfig.build.json, like eval-gate.ts).
//
// The fix-agent's iterate-to-green loop runs this in a FRESH process after
// applying a fix, so the planner reflects the edited source (an in-process
// import would use the stale planner). It compares the printed action to the
// captured `observed` action to decide whether the fix unstuck the page.
//
//   Run: cd apps/mcp && UNIVERSAL_BOT_LLM_TIER=free \
//        npx tsx src/bot/eval-page.ts <path-to-capture-round.json>

import { readFileSync } from "node:fs";
import { SignupAgent, type PostVerifyStep } from "./agent.js";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { pickLLMPair } from "./llm-client.js";

// The slice of a capture round (OnboardingCaseFile) the planner needs.
interface CapturedPage {
  service: string;
  oauth: boolean;
  state: { url: string; title: string; html: string; screenshot: string };
  inventory: InteractiveElement[];
}

type PlanInput = {
  service: string;
  round: number;
  maxRounds: number;
  state: CapturedPage["state"];
  oauth: boolean;
  inventory: InteractiveElement[];
};

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("usage: eval-page.ts <capture-round.json>");
    process.exitCode = 2;
    return;
  }
  const page = JSON.parse(readFileSync(path, "utf8")) as CapturedPage;

  // Same construction as eval-gate.makePlanner: the planner never touches the
  // browser, so a dummy controller is safe; LLM clients are stateless.
  const dummyBrowser = {} as unknown as BrowserController;
  const llm = pickLLMPair({ preferCheap: true });
  const agent = new SignupAgent(dummyBrowser, llm);
  const planFor = (
    agent as unknown as { planPostVerifyStep: (i: PlanInput) => Promise<PostVerifyStep> }
  ).planPostVerifyStep.bind(agent);

  const step = await planFor({
    service: page.service,
    round: 0,
    maxRounds: 8,
    state: page.state,
    oauth: page.oauth,
    inventory: page.inventory,
  });

  // The fix-agent parses this single line. Keep it the only STEP payload.
  process.stdout.write(`STEP ${JSON.stringify(step)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
