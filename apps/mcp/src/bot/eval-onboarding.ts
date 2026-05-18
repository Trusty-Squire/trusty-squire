// T14 / E1 — post-OAuth onboarding planner eval. DEV HARNESS, not
// shipped (excluded from the published build in tsconfig.build.json,
// like eval-planner.ts).
//
// The OAuth-first pivot makes post-OAuth onboarding navigation CORE
// scope: after the OAuth handshake the bot must drive a service's
// dashboard to its API key. T12 proved that works against Render — but
// a planner tuned against one service overfits. This harness is the
// anti-overfitting instrument: a corpus of post-OAuth page states, each
// with the SET of acceptable next steps, scored against what
// planPostVerifyStep actually decides. Change the onboarding prompt,
// re-run this, and see whether you regressed the other states.
//
// The seed corpus below is synthetic but each case encodes a failure
// mode T12 surfaced — the masked-key extract-loop, workspace-vs-account
// settings, the OAuth login-wall trap. Grow it with REAL captures:
// snapshot getState() + extractInteractiveElements() on live post-OAuth
// dashboards and record, per state, the acceptable steps.
//
// scoreOnboardingStep is pure and exported for unit testing; the runner
// needs a live LLM and runs only from main().
//   Run:  OPENROUTER_API_KEY=... npx tsx src/bot/eval-onboarding.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignupAgent, type PostVerifyStep } from "./agent.js";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { pickLLMPair } from "./llm-client.js";

type StepKind = PostVerifyStep["kind"];

// A 1x1 transparent PNG — the planner always builds an image block, and
// some providers reject an empty one. Seed cases carry no real
// screenshot, so they use this placeholder and lean on text+inventory.
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface OnboardingExpectation {
  // Step kinds that count as a correct decision for this page state.
  acceptKinds: readonly StepKind[];
  // Step kinds that are explicitly WRONG here — listed so the case
  // documents the trap (e.g. "must not `extract` a masked key", "must
  // not `login` on an OAuth run"). A rejected kind fails the case.
  rejectKinds?: readonly StepKind[];
  // When set, a `click`/`fill` step must target one of these selectors.
  // Omit it when any element of the right kind is acceptable —
  // navigation states legitimately have several valid targets.
  selectorsAnyOf?: readonly string[];
}

export interface OnboardingEvalCase {
  name: string;
  service: string;
  oauth: boolean;
  state: { url: string; title: string; html: string; screenshot: string };
  inventory: InteractiveElement[];
  expect: OnboardingExpectation;
}

export interface OnboardingScore {
  pass: boolean;
  detail: string;
}

// Score one planned step against a case's acceptable-set. Pure —
// exported for unit testing, the load-bearing logic of the eval.
export function scoreOnboardingStep(
  step: PostVerifyStep,
  expect: OnboardingExpectation,
): OnboardingScore {
  if (expect.rejectKinds?.includes(step.kind) === true) {
    return {
      pass: false,
      detail: `chose "${step.kind}" — explicitly wrong for this state`,
    };
  }
  if (!expect.acceptKinds.includes(step.kind)) {
    return {
      pass: false,
      detail: `chose "${step.kind}" — expected one of ${expect.acceptKinds.join("/")}`,
    };
  }
  if (
    expect.selectorsAnyOf !== undefined &&
    (step.kind === "click" || step.kind === "fill")
  ) {
    if (!expect.selectorsAnyOf.includes(step.selector)) {
      return {
        pass: false,
        detail:
          `"${step.kind}" targeted ${step.selector} — expected one of ` +
          expect.selectorsAnyOf.join(", "),
      };
    }
  }
  return { pass: true, detail: `chose "${step.kind}" — accepted` };
}

// ── seed corpus ── synthetic, but each case encodes a real T12 lesson.
// Replace/extend with inventories captured from live dashboards.
function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

function seedCases(): OnboardingEvalCase[] {
  const page = (
    url: string,
    title: string,
    html: string,
  ): OnboardingEvalCase["state"] => ({ url, title, html, screenshot: BLANK_PNG });

  return [
    {
      // A full, untruncated key is on the page → extract it.
      name: "full API key visible",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/account/api",
        "API Keys",
        "<h1>API Keys</h1><p>Your new key — copy it now:</p>" +
          "<code>tsq_demo_FULLkeyExample0123456789abcd</code><button>Done</button>",
      ),
      inventory: [
        el({ visibleText: "Copy", selector: "#copy" }),
        el({ visibleText: "Done", selector: "#done" }),
      ],
      expect: { acceptKinds: ["extract"] },
    },
    {
      // The T12 trap: existing keys shown masked/truncated. Extracting
      // is futile — must create a fresh key to see a full value.
      name: "masked existing key — must create, not extract",
      service: "Render-like",
      oauth: true,
      state: page(
        "https://svc.test/u/settings/api-keys",
        "API Keys",
        "<h1>API Keys</h1><table><tr><td>prod-key</td>" +
          "<td>rnd_AbCd1234...</td></tr></table>" +
          "<button>Create API Key</button>",
      ),
      inventory: [
        el({ visibleText: "Create API Key", selector: "#create-key" }),
        el({ tag: "a", visibleText: "Docs", selector: "#docs" }),
      ],
      expect: {
        acceptKinds: ["click", "navigate"],
        rejectKinds: ["extract", "done"],
        selectorsAnyOf: ["#create-key"],
      },
    },
    {
      // API keys page, no keys yet, a create button → click create.
      name: "no keys yet — click create",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/account/api",
        "API Keys",
        "<h1>API Keys</h1><p>No provisioned API keys.</p>" +
          "<button>Create API Key</button>",
      ),
      inventory: [el({ visibleText: "Create API Key", selector: "#create-key" })],
      expect: { acceptKinds: ["click"], selectorsAnyOf: ["#create-key"] },
    },
    {
      // A post-OAuth onboarding modal blocks the dashboard — dismiss it
      // or head for settings; do not give up.
      name: "onboarding modal in the way",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/dashboard",
        "Dashboard",
        "<div>Welcome! Create your first service.</div>" +
          "<a>Skip</a><nav><a>Settings</a></nav>",
      ),
      inventory: [
        el({ tag: "a", visibleText: "Skip", selector: "#skip" }),
        el({ tag: "a", visibleText: "Settings", selector: "#settings" }),
      ],
      expect: { acceptKinds: ["click", "navigate"], rejectKinds: ["done"] },
    },
    {
      // Wrong settings section — workspace settings, no API keys here.
      // Must keep navigating (account settings), not give up.
      name: "wrong settings section",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/w/team/settings",
        "Workspace Settings",
        "<h1>Workspace Settings</h1><nav><a>General</a>" +
          "<a>Team Members</a><a>Account Settings</a></nav>",
      ),
      inventory: [
        el({ tag: "a", visibleText: "General", selector: "#general" }),
        el({ tag: "a", visibleText: "Team Members", selector: "#team" }),
        el({ tag: "a", visibleText: "Account Settings", selector: "#account" }),
      ],
      expect: { acceptKinds: ["click", "navigate"], rejectKinds: ["done", "extract"] },
    },
    {
      // OAuth run on a login wall — the bot is already authenticated
      // via Google; it must NEVER ask to log in (T9 guarantee).
      name: "login wall on an OAuth run — never `login`",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/login",
        "Sign in",
        "<h1>Please sign in to continue</h1>" +
          "<input type=email><input type=password><button>Log in</button>",
      ),
      inventory: [
        el({ tag: "input", type: "email", selector: "#email" }),
        el({ tag: "input", type: "password", selector: "#password" }),
        el({ visibleText: "Log in", selector: "#login" }),
      ],
      expect: { acceptKinds: ["navigate", "done"], rejectKinds: ["login"] },
    },
    {
      // A phone-verification wall — unsolvable, stop cleanly.
      name: "phone-verification wall — done",
      service: "Acme",
      oauth: true,
      state: page(
        "https://acme.test/verify-phone",
        "Verify your phone",
        "<h1>Verify your phone number</h1>" +
          "<p>Enter the code we texted you.</p><input type=tel>",
      ),
      inventory: [el({ tag: "input", type: "tel", selector: "#code" })],
      expect: { acceptKinds: ["done"] },
    },
  ];
}

// The committed corpus: raw captures from onboarding-capture.ts that a
// curator trimmed to distinct states, compacted (screenshots dropped,
// HTML reduced to its visible text) and labelled with a real `expect`.
const COMMITTED_CORPUS_DIR = fileURLToPath(
  new URL("../../corpus/onboarding", import.meta.url),
);

// Load curated corpus cases. ONBOARDING_EVAL_CORPUS overrides the
// location (e.g. to point at a fresh raw-capture dir mid-curation);
// unset, it falls back to the committed corpus. Raw captures (still
// `expect: null`) are skipped: an eval case is only scorable once a
// human has labelled the correct answer.
export function loadCorpus(): OnboardingEvalCase[] {
  const override = process.env.ONBOARDING_EVAL_CORPUS;
  const dir =
    override !== undefined && override.trim().length > 0
      ? override
      : COMMITTED_CORPUS_DIR;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    console.error(`[eval] corpus dir not readable: ${dir}`);
    return [];
  }
  const cases: OnboardingEvalCase[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      // Curated only: a real `expect`, plus the structural fields the
      // runner needs. A light shape check — this is a dev harness.
      const exp = raw["expect"];
      if (exp === null || exp === undefined || typeof exp !== "object") continue;
      if (typeof raw["state"] !== "object" || !Array.isArray(raw["inventory"])) continue;
      cases.push(raw as unknown as OnboardingEvalCase);
    } catch {
      console.error(`[eval] skipped malformed corpus file: ${f}`);
    }
  }
  if (cases.length > 0) console.error(`[eval] loaded ${cases.length} curated corpus case(s)`);
  return cases;
}

async function main(): Promise<void> {
  const cases = [...seedCases(), ...loadCorpus()];
  // planPostVerifyStep never touches the browser — a dummy controller
  // is safe (dev harness only), same as eval-planner.ts.
  const dummyBrowser = {} as unknown as BrowserController;
  const agent = new SignupAgent(dummyBrowser, pickLLMPair({ preferCheap: true }));
  const planFor = (
    agent as unknown as {
      planPostVerifyStep: (i: {
        service: string;
        round: number;
        maxRounds: number;
        state: OnboardingEvalCase["state"];
        oauth: boolean;
        inventory: InteractiveElement[];
      }) => Promise<PostVerifyStep>;
    }
  ).planPostVerifyStep.bind(agent);

  let passed = 0;
  for (const c of cases) {
    try {
      const step = await planFor({
        service: c.service,
        round: 0,
        maxRounds: 8,
        state: c.state,
        oauth: c.oauth,
        inventory: c.inventory,
      });
      const score = scoreOnboardingStep(step, c.expect);
      if (score.pass) passed += 1;
      console.log(`${score.pass ? "PASS" : "FAIL"}  ${c.name} — ${score.detail}`);
      if (!score.pass) console.log(`        reason given: ${step.reason}`);
    } catch (err) {
      console.log(
        `ERROR ${c.name} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`\nonboarding planner accuracy: ${passed}/${cases.length}`);
  process.exitCode = passed === cases.length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
