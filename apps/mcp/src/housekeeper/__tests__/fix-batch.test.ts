import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFixBatch,
  computeSignature,
  readFixBatch,
  type FixBatchMeta,
} from "../fix-batch.js";
import type { InteractiveElement } from "../../bot/browser.js";
import type { PostVerifyStep } from "../../bot/agent.js";
import type { OnboardingOutcomeFile } from "../../bot/onboarding-capture.js";

const META: FixBatchMeta = {
  batchId: "batch-1",
  botVersion: "0.9.1-rc.1",
  generatedAt: "2026-06-09T00:00:00.000Z",
};

function el(partial: Partial<InteractiveElement>): InteractiveElement {
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
    selector: "button",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...partial,
  };
}

function outcome(
  service: string,
  runId: string,
  ok: boolean,
  stage: OnboardingOutcomeFile["outcome"]["failure_stage"],
  terminalRound: number | null = 0,
): OnboardingOutcomeFile {
  return {
    capture_format_version: 1,
    service,
    run_id: runId,
    outcome: {
      ok,
      credential_present: ok,
      credential_fields: ok ? ["api_key"] : [],
      failure_stage: stage,
      terminal_round: terminalRound,
    },
  };
}

describe("computeSignature", () => {
  it("is stable across inventory reordering (sorted descriptors)", () => {
    const a = [el({ role: "button", ariaLabel: "Create key" }), el({ role: "link", visibleText: "Docs" })];
    const b = [el({ role: "link", visibleText: "Docs" }), el({ role: "button", ariaLabel: "Create key" })];
    expect(computeSignature(a)).toBe(computeSignature(b));
  });
  it("ignores element names — the same role shape across services collides", () => {
    // groq's "Create key" button and render's "Generate token" button are the
    // same structural shape; the signature must not split them by wording, or
    // shared-root-cause failures shatter into per-service singletons.
    const groq = [el({ role: "button", ariaLabel: "Create key" }), el({ role: "textbox", ariaLabel: "Email" })];
    const render = [el({ role: "button", ariaLabel: "Generate token" }), el({ role: "textbox", ariaLabel: "Work email" })];
    expect(computeSignature(groq)).toBe(computeSignature(render));
  });
  it("differs when the structural role shape differs", () => {
    const oneButton = [el({ role: "button", ariaLabel: "Go" })];
    const twoButtons = [el({ role: "button", ariaLabel: "Go" }), el({ role: "button", ariaLabel: "Back" })];
    expect(computeSignature(oneButton)).not.toBe(computeSignature(twoButtons));
  });
});

describe("buildFixBatch", () => {
  const step: PostVerifyStep = { kind: "click", selector: "#k", reason: "open keys" };
  const resolve = (o: OnboardingOutcomeFile) => ({
    capture_refs: [`/cap/${o.service}-${o.run_id}-r0.json`],
    terminal: {
      url: `https://${o.service}.com/keys`,
      inventory: [el({ role: "button", ariaLabel: "Create key" })],
      observed: step,
    },
  });

  it("keeps only failures (drops ok and stage=none)", () => {
    const batch = buildFixBatch(
      [
        outcome("a", "r1", true, "none"),
        outcome("b", "r2", false, "extract"),
        outcome("c", "r3", false, "none"), // contradictory but excluded by stage
      ],
      META,
      resolve,
    );
    expect(batch.failures.map((f) => f.service)).toEqual(["b"]);
    expect(batch.stats.totalRuns).toBe(3);
  });

  it("carries signature, capture refs and planner reasoning", () => {
    const batch = buildFixBatch([outcome("b", "r2", false, "extract")], META, resolve);
    const f = batch.failures[0]!;
    expect(f.capture_refs).toEqual(["/cap/b-r2-r0.json"]);
    expect(f.planner_reasoning).toBe("click: open keys");
    expect(f.signature).toHaveLength(16);
  });

  it("counts reproduce_count for shared (service, signature)", () => {
    const batch = buildFixBatch(
      [outcome("b", "r1", false, "extract"), outcome("b", "r2", false, "extract")],
      META,
      resolve,
    );
    expect(batch.failures.every((f) => f.reproduce_count === 2)).toBe(true);
  });

  it("falls back to a stage-based signature when no terminal round resolves", () => {
    const batch = buildFixBatch([outcome("b", "r2", false, "extract")], META, () => ({
      capture_refs: [],
    }));
    const f = batch.failures[0]!;
    expect(f.signature).toHaveLength(16);
    expect(f.planner_reasoning).toBeUndefined();
    expect(f.capture_refs).toEqual([]);
  });
});

describe("readFixBatch (IO)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("joins outcome sidecars with round files from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixbatch-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    // a failing run with two rounds; terminal_round=1
    const round = (r: number) => ({
      capture_format_version: 1,
      name: `svc round ${r}`,
      service: "svc",
      oauth: true,
      state: { url: "https://svc.com/onboard", title: "t", html: "<html>", screenshot: "" },
      inventory: [el({ role: "button", ariaLabel: "Next" })],
      observed: { kind: "click", selector: "#next", reason: `round ${r}` } satisfies PostVerifyStep,
      expect: null,
      prev_hash: null,
      content_hash: "h",
    });
    writeFileSync(join(dir, "svc-run9-r0.json"), JSON.stringify(round(0)));
    writeFileSync(join(dir, "svc-run9-r1.json"), JSON.stringify(round(1)));
    writeFileSync(
      join(dir, "svc-run9.outcome.json"),
      JSON.stringify(outcome("svc", "run9", false, "planner_loop", 1)),
    );

    const batch = readFixBatch(dir, META);
    expect(batch.failures).toHaveLength(1);
    const f = batch.failures[0]!;
    expect(f.capture_refs).toHaveLength(2);
    expect(f.planner_reasoning).toBe("click: round 1");
  });
});
