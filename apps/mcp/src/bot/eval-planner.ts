// F3 T7 — planner pick-accuracy eval. DEV HARNESS, not shipped
// (excluded from the published build in tsconfig.build.json, like
// cli.ts). It measures the rework's core bet: given a correct
// DOM-grounded inventory, does the planner pick the right element
// for each role? That number is the go/no-go signal, isolated from
// extraction / submit / captcha noise.
//
// The fixture corpus starts small (seed cases below). Grow it by
// running extractInteractiveElements() against the 16-service
// re-sweep pages and recording, per page: the inventory plus the
// correct role→selector answers. Run:  tsx src/bot/eval-planner.ts
//
// scorePlanPicks is pure and exported so it can be unit-tested; the
// runner needs a live LLM and is invoked only from main().

import { SignupAgent, type SignupPlan } from "./agent.js";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { pickLLMPair } from "./llm-client.js";

export type Role = "email" | "password" | "name" | "username" | "tos" | "submit";

export interface PlannerEvalCase {
  name: string;
  service: string;
  url: string;
  inventory: InteractiveElement[];
  // The known-correct selector for each role the page actually has.
  expect: ReadonlyArray<{ role: Role; selector: string }>;
}

// Compare a produced plan against the known-correct answers. A role
// is "correct" when the plan targets exactly the expected selector.
export function scorePlanPicks(
  plan: SignupPlan,
  expectations: PlannerEvalCase["expect"],
): { correct: number; total: number; misses: string[] } {
  const misses: string[] = [];
  let correct = 0;
  for (const exp of expectations) {
    let picked: string | undefined;
    if (exp.role === "submit") {
      picked = plan.submit_selector;
    } else if (exp.role === "tos") {
      picked = plan.actions.find((a) => a.kind === "check")?.selector;
    } else {
      picked = plan.actions.find(
        (a) => a.kind === "fill" && a.value_kind === exp.role,
      )?.selector;
    }
    if (picked === exp.selector) {
      correct += 1;
    } else {
      misses.push(`${exp.role}: expected ${exp.selector}, got ${picked ?? "(none)"}`);
    }
  }
  return { correct, total: expectations.length, misses };
}

// ── seed corpus ── replace/extend with real captured inventories.
function seedCases(): PlannerEvalCase[] {
  const el = (over: Partial<InteractiveElement>): InteractiveElement => ({
    index: 0,
    tag: "input",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  });
  return [
    {
      name: "plain email+password form",
      service: "Example",
      url: "https://example.test/signup",
      inventory: [
        el({ tag: "input", type: "email", name: "email", labelText: "Email", selector: "#email" }),
        el({ tag: "input", type: "password", name: "password", labelText: "Password", selector: "#password" }),
        el({ tag: "input", type: "checkbox", labelText: "I agree to the Terms", selector: "#tos" }),
        el({ tag: "button", type: "submit", visibleText: "Create account", selector: "#go" }),
      ],
      expect: [
        { role: "email", selector: "#email" },
        { role: "password", selector: "#password" },
        { role: "tos", selector: "#tos" },
        { role: "submit", selector: "#go" },
      ],
    },
  ];
}

async function main(): Promise<void> {
  const cases = seedCases();
  // The eval only exercises planSignupForm, which never touches the
  // browser — a dummy controller is safe here (dev harness only).
  const dummyBrowser = {} as unknown as BrowserController;
  const agent = new SignupAgent(dummyBrowser, pickLLMPair({ preferCheap: true }));
  const planFor = (
    agent as unknown as {
      planSignupForm: (i: {
        service: string;
        url: string;
        inventory: InteractiveElement[];
        screenshot: string;
      }) => Promise<SignupPlan>;
    }
  ).planSignupForm.bind(agent);

  let correct = 0;
  let total = 0;
  for (const c of cases) {
    try {
      const plan = await planFor({
        service: c.service,
        url: c.url,
        inventory: c.inventory,
        screenshot: "",
      });
      const s = scorePlanPicks(plan, c.expect);
      correct += s.correct;
      total += s.total;
      console.log(
        `${c.name}: ${s.correct}/${s.total}` +
          (s.misses.length > 0 ? ` — ${s.misses.join("; ")}` : ""),
      );
    } catch (err) {
      console.log(`${c.name}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nplanner pick accuracy: ${correct}/${total}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
