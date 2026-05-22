// Planner shadow-test — the regression net for single-credential
// signups (see docs/DESIGN-multi-credential.md §"Shadow-test harness").
//
// PURPOSE: prove that every captured single-credential page (Resend,
// Sentry, Mistral, Sendpulse — the curated corpus) continues to elicit
// a single-credential action shape from the post-verify planner. Multi-
// credential extraction (Twitter, Stripe, AWS IAM) is on the roadmap;
// this harness gates every prompt change so single-cred services can't
// regress when the multi-cred vocabulary lands.
//
// TWO MODES:
//
//  1. Cheap mode (always-on CI): no LLM. Asserts corpus integrity +
//     vocabulary locks. Catches schema regressions, malformed captures,
//     and accidental multi-cred kinds slipping into single-cred
//     fixtures.
//
//  2. LLM mode (gated by RUN_LLM_SHADOW=true): runs the live planner
//     against each fixture's state, asserts the returned action kind
//     stays within the SINGLE_CRED_ACTION_KINDS set. Costs real API
//     spend per round — run weekly or pre-merge on prompt changes,
//     never on every commit.
//
// Both modes share the same fixture set: apps/mcp/corpus/onboarding/.
// Curated fixtures (those with a non-null `expect`) are the source of
// truth; raw captures are skipped.

import { describe, expect, it } from "vitest";
import { loadCorpus, type OnboardingEvalCase } from "../eval-onboarding.js";
import type { PostVerifyStep } from "../agent.js";

// ── The locked single-credential action vocabulary ──────────────────
//
// This is the EXHAUSTIVE list of PostVerifyStep kinds the current
// single-credential planner is allowed to emit. When multi-credential
// support lands, NEW kinds (e.g. `extract_named`) will join this list
// in a sibling test file (planner-shadow-multi.test.ts) — they MUST
// NOT be added here. Keeping the single-cred set frozen is what gives
// CI a clear "did the planner drift?" signal.
const SINGLE_CRED_ACTION_KINDS = new Set<PostVerifyStep["kind"]>([
  "done",
  "extract",
  "login",
  "click",
  "fill",
  "select",
  "check",
  "scroll",
  "navigate",
  "wait",
]);

// Action kinds that, if they ever appear in a single-credential
// fixture's `acceptKinds` / `rejectKinds`, indicate the fixture is
// misfiled (it's actually a multi-credential page).
//
// Phase B–D shipped: the skill schema now carries
// `extract_via_copy_button_named` and `extract_via_regex_named` step
// kinds. Phase E (planner prompt expansion to emit `extract_named`)
// hasn't shipped — the post-verify planner today does NOT emit
// `extract_named`. When Phase E lands, add "extract_named" to this
// set; the cheap-mode lockout will then catch any single-cred fixture
// that drifts to accept the new vocabulary, and the LLM-mode test
// will catch the planner emitting it on a page that shouldn't trigger.
const MULTI_CRED_KINDS: ReadonlySet<string> = new Set([
  // Skill-layer multi-cred step kinds. These should never appear in
  // the post-verify planner's PostVerifyStep vocabulary anyway (they
  // live on the SkillStep type, not PostVerifyStep), but listing them
  // here makes the lockout explicit and forward-compatible: if Phase E
  // ever adds an `extract_named` planner action that shares a name
  // with a skill step, the lockout still fires.
  "extract_via_copy_button_named",
  "extract_via_regex_named",
  // Planner-layer multi-cred action — Phase E placeholder.
  "extract_named",
]);

// Services we expect to find in the corpus. A missing service trips
// CI loud so a fixture purge can't silently shrink the regression net.
const EXPECTED_SERVICES = ["Resend", "Sentry", "Mistral"] as const;

// ── Cheap-mode tests (always on) ────────────────────────────────────

describe("planner shadow-test — corpus integrity (cheap mode)", () => {
  const corpus = loadCorpus();

  it("the curated corpus is non-empty", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it("every expected service appears in the corpus", () => {
    const services = new Set(corpus.map((c) => c.service));
    for (const expected of EXPECTED_SERVICES) {
      expect(services, `corpus missing fixtures for ${expected}`).toContain(expected);
    }
  });

  it("every fixture has a well-formed state block", () => {
    for (const c of corpus) {
      expect(c.state.url, c.name).toMatch(/^https?:\/\//);
      expect(typeof c.state.title, c.name).toBe("string");
      expect(c.state.html.length, c.name).toBeGreaterThan(0);
    }
  });

  it("every fixture has a non-empty inventory", () => {
    for (const c of corpus) {
      expect(c.inventory.length, c.name).toBeGreaterThan(0);
    }
  });

  it("every inventory element has a selector and a tag", () => {
    for (const c of corpus) {
      for (const el of c.inventory) {
        expect(typeof el.selector, `${c.name} / ${el.tag}`).toBe("string");
        expect(el.selector.length, c.name).toBeGreaterThan(0);
        expect(typeof el.tag, c.name).toBe("string");
      }
    }
  });
});

describe("planner shadow-test — single-cred vocabulary lock (cheap mode)", () => {
  const corpus = loadCorpus();

  it("every fixture's acceptKinds uses only the locked single-cred vocabulary", () => {
    for (const c of corpus) {
      for (const kind of c.expect.acceptKinds) {
        expect(
          SINGLE_CRED_ACTION_KINDS,
          `${c.name}: acceptKind "${kind}" is not in the single-cred vocabulary`,
        ).toContain(kind);
      }
    }
  });

  it("every fixture's rejectKinds uses only the locked single-cred vocabulary", () => {
    for (const c of corpus) {
      for (const kind of c.expect.rejectKinds ?? []) {
        expect(
          SINGLE_CRED_ACTION_KINDS,
          `${c.name}: rejectKind "${kind}" is not in the single-cred vocabulary`,
        ).toContain(kind);
      }
    }
  });

  it("no fixture's acceptKinds contains a multi-credential action kind", () => {
    // When MULTI_CRED_KINDS is populated (post-multi-cred-rollout),
    // this catches a single-cred fixture that accidentally lists a
    // multi-cred kind as acceptable — i.e. a misfiling that would
    // let the planner drift on a single-cred page.
    if (MULTI_CRED_KINDS.size === 0) return; // no multi vocabulary yet
    for (const c of corpus) {
      for (const kind of c.expect.acceptKinds) {
        expect(
          MULTI_CRED_KINDS.has(kind),
          `${c.name}: single-cred fixture must NOT accept multi-cred kind "${kind}"`,
        ).toBe(false);
      }
    }
  });
});

// ── LLM-mode test (RUN_LLM_SHADOW=true) ─────────────────────────────
//
// Real planner calls. Each fixture's state goes through the planner;
// the returned action's kind must be in the single-cred vocabulary.
// This catches LLM drift even when the prompt hasn't moved — model
// updates, provider routing changes, anything that shifts behavior.
//
// Skipped by default. Set RUN_LLM_SHADOW=true (and an LLM key in env)
// to run. Costs ~$0.13 per fixture round; the curated corpus is ~14
// rounds → ~$2 per full run.

const RUN_LLM_SHADOW = process.env.RUN_LLM_SHADOW === "true";

describe.skipIf(!RUN_LLM_SHADOW)(
  "planner shadow-test — single-cred planner output (LLM mode)",
  () => {
    // Lazy-import the planner so the cheap-mode pass doesn't pay the
    // cost of pulling in LLM-client transitive deps when LLM mode is
    // off. Constructed once per test run via the harness's existing
    // `planFor` pattern (eval-onboarding.ts:300-317).
    let planFor: (input: {
      service: string;
      round: number;
      maxRounds: number;
      state: OnboardingEvalCase["state"];
      oauth: boolean;
      inventory: OnboardingEvalCase["inventory"];
    }) => Promise<PostVerifyStep>;

    it("setup the live planner", async () => {
      const { SignupAgent } = await import("../agent.js");
      const { pickLLMPair } = await import("../llm-client.js");
      // planPostVerifyStep doesn't touch the browser — dummy is safe
      // per the eval-onboarding harness convention.
      const dummyBrowser = {} as unknown as import("../browser.js").BrowserController;
      const agent = new SignupAgent(dummyBrowser, pickLLMPair({ preferCheap: true }));
      planFor = (
        agent as unknown as {
          planPostVerifyStep: (i: Parameters<typeof planFor>[0]) => Promise<PostVerifyStep>;
        }
      ).planPostVerifyStep.bind(agent);
    });

    it("every corpus fixture elicits a single-cred action shape", async () => {
      const corpus = loadCorpus();
      const failures: string[] = [];
      for (const c of corpus) {
        try {
          const step = await planFor({
            service: c.service,
            round: 0,
            maxRounds: 8,
            state: c.state,
            oauth: c.oauth,
            inventory: c.inventory,
          });
          if (!SINGLE_CRED_ACTION_KINDS.has(step.kind)) {
            failures.push(
              `${c.name}: planner emitted unexpected kind "${step.kind}" ` +
                `(reason: ${step.reason})`,
            );
          }
          if (MULTI_CRED_KINDS.has(step.kind)) {
            failures.push(
              `${c.name}: SINGLE-CRED REGRESSION — planner emitted multi-cred ` +
                `kind "${step.kind}" on a single-cred page (reason: ${step.reason})`,
            );
          }
        } catch (err) {
          failures.push(
            `${c.name}: planner threw — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    }, 5 * 60 * 1000); // 5 min — ~14 fixtures × ~10s/call worst case
  },
);
