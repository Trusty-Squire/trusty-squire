// A3 (build-corpus) + A5 (gated runner) — docs/DESIGN-planner-navigation-eval.md.
//   - redactText scrubs provider keys / JWTs / emails / high-entropy tokens
//   - buildRegressCases unions accept KINDS across successful runs and derives
//     reject KINDS from failed-run terminal rounds (never rejecting a good kind)
//   - emitted cases are redacted and screenshot-stripped (R3, P0)
//   - readCaptureGroups round-trips the A2 capture+outcome writers
//   - self-consistency: replaying the gold-path scores the regress bucket 100%;
//     a deliberately-wrong step trips the gate

import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRegressCases,
  collectIdentityTokens,
  identityTokensForCase,
  pageSignature,
  readCaptureGroups,
  redactText,
  type CapturedRound,
  type RunGroup,
} from "../build-corpus.js";
import {
  captureOnboardingRound,
  captureRunOutcome,
  resetCaptureChain,
  type OnboardingCaseFile,
  type OnboardingOutcomeFile,
} from "../onboarding-capture.js";
import { scoreBucket, regressGatePassed, type EvalCaseFile } from "../eval-corpus.js";
import type { PostVerifyStep, SignupResult } from "../agent.js";
import type { InteractiveElement } from "../browser.js";

// ── redaction (R3) ──────────────────────────────────────────────────

describe("redactText", () => {
  it("scrubs provider keys, JWTs, slack/aws/github tokens, emails (labeled)", () => {
    const cases: Array<[string, string]> = [
      ["here is sk-ABCDwxyz0123456789 done", "ABCDwxyz0123456789"],
      ["bearer eyJhbGci0i.eyJzdWIi0i.SflKxwRJSMabc tail", "SflKxwRJSM"],
      ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 x", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
      ["aws AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
      ["mail to alias+tag@trustysquire.ai please", "alias+tag@trustysquire.ai"],
    ];
    for (const [input, secret] of cases) {
      const out = redactText(input);
      expect(out).not.toContain(secret);
      expect(out).toMatch(/\[REDACTED_/);
    }
  });

  it("scrubs unprefixed high-entropy tokens to a neutral marker (no TOKEN label)", () => {
    // The high-entropy sweep mostly hits CSS-hash noise; its replacement must
    // NOT read as an extractable token (it biased the planner toward extract).
    const out = redactText("raw abc123DEF456ghi789JKL012mno345PQR678 z");
    expect(out).not.toContain("abc123DEF456ghi789JKL012mno345PQR678");
    expect(out).not.toContain("REDACTED_TOKEN");
    expect(out).toBe("raw x z");
  });

  it("leaves benign prose untouched", () => {
    const benign = "Create your first API key in Settings, then click Done.";
    expect(redactText(benign)).toBe(benign);
  });

  it("scrubs an operator handle that appears as a bare username (no @)", () => {
    // the email is on the page (→ identity token), the handle leaks elsewhere
    const tokens = collectIdentityTokens("signed in as lunchboxfortwo@gmail.com");
    expect(tokens.has("lunchboxfortwo")).toBe(true);
    const html = '<a href="/teams/lunchboxfortwo">Llunchboxfortwo’s team</a>';
    const out = redactText(html, tokens);
    expect(out).not.toContain("lunchboxfortwo");
    expect(out).toContain("[REDACTED_ID]");
  });

  it("does not treat generic role local-parts as identities", () => {
    const tokens = collectIdentityTokens("mailto:support@acme.com and noreply@acme.com");
    expect(tokens.size).toBe(0);
  });

  it("identityTokensForCase pulls handles from inventory + state together", () => {
    const tokens = identityTokensForCase(
      { url: "https://x.test/u/janedoe123", title: "T", html: "<b>hi</b>", screenshot: "" },
      [el({ visibleText: "janedoe123@corp.io" })],
    );
    expect(tokens.has("janedoe123")).toBe(true);
  });
});

// ── fixtures ────────────────────────────────────────────────────────

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

function step(kind: StepKindLike, selector?: string): PostVerifyStep {
  return {
    kind,
    ...(selector !== undefined ? { selector } : {}),
    reason: `synthetic ${kind}`,
  } as unknown as PostVerifyStep;
}
type StepKindLike = PostVerifyStep["kind"];

function mkRound(
  service: string,
  url: string,
  observed: PostVerifyStep,
  inv: InteractiveElement[],
  html = "<h1>page</h1>",
): OnboardingCaseFile {
  return {
    capture_format_version: 1,
    name: `${service} — onboarding round 1`,
    service,
    oauth: true,
    state: { url, title: "T", html, screenshot: "SCREENSHOT-MARKER" },
    inventory: inv,
    observed,
    expect: null,
    prev_hash: null,
    content_hash: "x",
  } as OnboardingCaseFile;
}

function mkOutcome(ok: boolean, terminal: number | null): OnboardingOutcomeFile {
  return {
    capture_format_version: 1,
    service: "svc",
    run_id: "r",
    outcome: {
      ok,
      credential_present: ok,
      credential_fields: ok ? ["api_key"] : [],
      failure_stage: ok ? "none" : "planner_loop",
      terminal_round: terminal,
    },
  };
}

function group(
  service: string,
  rounds: CapturedRound[],
  outcome: OnboardingOutcomeFile | null,
): RunGroup {
  return { service, runId: `${service}-run`, rounds, outcome };
}

// ── builder ─────────────────────────────────────────────────────────

describe("buildRegressCases", () => {
  const inv = [el({ visibleText: "Create API Key", selector: "#create" })];
  const url = "https://svc.test/settings/api";

  it("unions accept KINDS across successful runs of the equivalent page", () => {
    const runA = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("click", "#create"), inv) }],
      mkOutcome(true, 0),
    );
    const runB = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("navigate"), inv) }],
      mkOutcome(true, 0),
    );
    const cases = buildRegressCases([runA, runB]);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.expect.acceptKinds).toEqual(["click", "navigate"]);
    expect(cases[0]!.set).toBe("regress");
    expect(cases[0]!.source).toBe("gold_path");
  });

  it("derives reject KINDS from a failed run's terminal round, never rejecting a good kind", () => {
    const ok = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("click", "#create"), inv) }],
      mkOutcome(true, 0),
    );
    // failed run stuck on the same page choosing "done" (give up) — a reject;
    // and a second failed run that chose "click" (a KNOWN-GOOD kind) — NOT a reject.
    const failDone = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("done"), inv) }],
      mkOutcome(false, 0),
    );
    const failClick = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("click", "#create"), inv) }],
      mkOutcome(false, 0),
    );
    const cases = buildRegressCases([ok, failDone, failClick]);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.expect.acceptKinds).toEqual(["click"]);
    expect(cases[0]!.expect.rejectKinds).toEqual(["done"]);
  });

  it("preserves distinct state variants (same URL, different inventory)", () => {
    const empty = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("click", "#create"), [el({ selector: "#create" })]) }],
      mkOutcome(true, 0),
    );
    const populated = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("extract"), [el({ selector: "#copy" })]) }],
      mkOutcome(true, 0),
    );
    const cases = buildRegressCases([empty, populated]);
    expect(cases).toHaveLength(2); // not collapsed — different selectors → different page
  });

  it("redacts emitted case state + strips the screenshot (R3)", () => {
    const secretHtml = "<code>sk-LIVEsecretKEY0123456789</code>";
    const g = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("extract"), inv, secretHtml) }],
      mkOutcome(true, 0),
    );
    const cases = buildRegressCases([g]);
    const json = JSON.stringify(cases[0]);
    expect(json).not.toContain("sk-LIVEsecretKEY0123456789");
    expect(json).not.toContain("SCREENSHOT-MARKER");
    expect(cases[0]!.state.html).toMatch(/\[REDACTED_/);
  });

  it("ignores rounds from failed runs for the accept set", () => {
    const onlyFailed = group(
      "svc",
      [{ index: 0, case: mkRound("svc", url, step("done"), inv) }],
      mkOutcome(false, 0),
    );
    expect(buildRegressCases([onlyFailed])).toHaveLength(0);
  });

  it("scrubs the extracted credential VALUE from a regress case's html (R3)", () => {
    // a SUCCESS page shows the real key; the planner quoted it in its extract
    // reason. Both the page html AND the reason carry the value — neither may
    // reach the committed corpus. The IPInfo case: a 14-hex token under the
    // 32-char high-entropy floor.
    const tok = "f9a062f02fadf5"; // 14 hex
    const observed = { kind: "extract", reason: `access_token='${tok}' is visible` } as PostVerifyStep;
    const html = `<code>access_token: ${tok}</code><button>Done</button>`;
    const g = group(
      "ipinfo",
      [{ index: 0, case: mkRound("ipinfo", "https://ipinfo.io/account/token", observed, inv, html) }],
      mkOutcome(true, 0),
    );
    const json = JSON.stringify(buildRegressCases([g])[0]);
    expect(json).not.toContain(tok);
  });
});

describe("pageSignature", () => {
  it("ignores query/fragment and trailing slash but splits on selectors", () => {
    const inv = [el({ selector: "#a" })];
    const s1 = pageSignature("svc", { url: "https://x.test/p/?q=1#h", title: "", html: "", screenshot: "" }, inv);
    const s2 = pageSignature("svc", { url: "https://x.test/p", title: "", html: "", screenshot: "" }, inv);
    expect(s1).toBe(s2);
    const s3 = pageSignature("svc", { url: "https://x.test/p", title: "", html: "", screenshot: "" }, [el({ selector: "#b" })]);
    expect(s3).not.toBe(s2);
  });
});

// ── A2 → A3 round-trip through the real writers ─────────────────────

function mockResult(over: Partial<SignupResult> = {}): SignupResult {
  return { success: false, steps: [], ...over };
}

describe("readCaptureGroups (A2 writers → A3 reader)", () => {
  it("groups round files with their outcome sidecar and orders by index", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-corpus-test-"));
    const prev = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
    try {
      resetCaptureChain();
      const svc = "roundtripsvc";
      const baseInv = [el({ visibleText: "Create", selector: "#c" })];
      captureOnboardingRound({
        service: svc,
        round: 0,
        oauth: true,
        state: { url: "https://x.test/a", title: "A", html: "<a>", screenshot: "s" },
        inventory: baseInv,
        observed: step("click", "#c"),
      });
      captureOnboardingRound({
        service: svc,
        round: 1,
        oauth: true,
        state: { url: "https://x.test/b", title: "B", html: "<b>", screenshot: "s" },
        inventory: baseInv,
        observed: step("extract"),
      });
      captureRunOutcome(svc, mockResult({ success: true, credentials: { api_key: "k" } }));

      const groups = readCaptureGroups(dir);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.rounds.map((r) => r.index)).toEqual([0, 1]);
      expect(groups[0]!.outcome?.outcome.ok).toBe(true);

      // ensure the outcome sidecar was NOT mistaken for a round
      const roundFiles = readdirSync(dir).filter((f) => /-r\d+\.json$/.test(f));
      expect(roundFiles).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
      else process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = prev;
    }
  });
});

// ── A5 gate: self-consistency + wrong-step trip ─────────────────────

describe("regress gate (A5)", () => {
  const inv = [el({ visibleText: "Create", selector: "#create" })];
  const url = "https://svc.test/api";
  const builtCases: EvalCaseFile[] = buildRegressCases([
    group("svc", [{ index: 0, case: mkRound("svc", url, step("click", "#create"), inv) }], mkOutcome(true, 0)),
    group("svc", [{ index: 0, case: mkRound("svc", url, step("navigate"), inv) }], mkOutcome(true, 0)),
    group("svc", [{ index: 0, case: mkRound("svc", url, step("done"), inv) }], mkOutcome(false, 0)),
  ]);

  it("scores 100% replaying the gold path (self-consistency)", async () => {
    const plan = async (c: EvalCaseFile) => step(c.expect.acceptKinds[0]!);
    const bucket = await scoreBucket(builtCases, plan);
    expect(bucket.passed).toBe(bucket.total);
    expect(regressGatePassed(bucket)).toBe(true);
  });

  it("trips the gate on a deliberately-wrong (reject) step", async () => {
    const plan = async () => step("done"); // "done" is the derived reject kind
    const bucket = await scoreBucket(builtCases, plan);
    expect(regressGatePassed(bucket)).toBe(false);
    expect(bucket.failures.length).toBeGreaterThan(0);
  });
});
