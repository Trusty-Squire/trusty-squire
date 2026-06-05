// A4 (label-target) — turning a real stuck-page capture into a redacted,
// committed target eval case. The load-bearing guarantees:
//   - the page substrate is redacted (R3) and the screenshot stripped
//   - an empty / invalid accept set is rejected (a target case needs an answer)
//   - the committed corpus always loads with a valid expect (invariant)

import { describe, expect, it } from "vitest";
import { buildTargetCase, type LabelInput } from "../label-target.js";
import { loadEvalCorpus } from "../eval-corpus.js";
import type { OnboardingCaseFile } from "../onboarding-capture.js";
import type { InteractiveElement } from "../browser.js";

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

function capture(over: Partial<OnboardingCaseFile> = {}): OnboardingCaseFile {
  return {
    capture_format_version: 1,
    name: "Svc — round 1",
    service: "Svc",
    oauth: true,
    state: {
      url: "https://svc.test/settings/api",
      title: "API Keys",
      html: "<h1>API Keys</h1><code>sk-LIVEsecret012345678</code><span>me@x.test</span>",
      screenshot: "REAL-SCREENSHOT-BYTES",
    },
    inventory: [el({ visibleText: "Create API Key", selector: "#create" })],
    observed: { kind: "click", selector: "#create", reason: "x" } as OnboardingCaseFile["observed"],
    expect: null,
    prev_hash: null,
    content_hash: "x",
    ...over,
  } as OnboardingCaseFile;
}

describe("buildTargetCase", () => {
  const label: LabelInput = {
    acceptKinds: ["click", "navigate"],
    rejectKinds: ["done", "login"],
    theme: "create-resource",
    rationale: "must click create",
    holdout: false,
  };

  it("redacts the page + strips the screenshot (R3)", () => {
    const c = buildTargetCase(capture(), label);
    const json = JSON.stringify(c);
    expect(json).not.toContain("sk-LIVEsecret012345678");
    expect(json).not.toContain("me@x.test");
    expect(json).not.toContain("REAL-SCREENSHOT-BYTES");
    expect(c.state.html).toMatch(/\[REDACTED_/);
    // 1x1 transparent PNG sentinel
    expect(c.state.screenshot.startsWith("iVBORw0KGgo")).toBe(true);
  });

  it("carries set/source/theme/holdout + a sorted accept set", () => {
    const c = buildTargetCase(capture(), { ...label, acceptKinds: ["navigate", "click"], holdout: true });
    expect(c.set).toBe("target");
    expect(c.source).toBe("human");
    expect(c.theme).toBe("create-resource");
    expect(c.holdout).toBe(true);
    expect(c.expect.acceptKinds).toEqual(["click", "navigate"]); // sorted
    expect(c.expect.rejectKinds).toEqual(["done", "login"]);
  });

  it("rejects an empty accept set", () => {
    expect(() => buildTargetCase(capture(), { acceptKinds: [] })).toThrow(/non-empty/);
  });

  it("rejects an unknown step kind", () => {
    expect(() =>
      buildTargetCase(capture(), { acceptKinds: ["teleport" as LabelInput["acceptKinds"][number]] }),
    ).toThrow(/unknown step kind/);
  });

  it("is deterministic — same page → same id", () => {
    expect(buildTargetCase(capture(), label).id).toBe(buildTargetCase(capture(), label).id);
  });
});

describe("committed eval corpus invariant", () => {
  it("loads with a valid, non-empty accept set on every case", () => {
    const { regress, targetTune, targetHoldout } = loadEvalCorpus();
    for (const c of [...regress, ...targetTune, ...targetHoldout]) {
      expect(Array.isArray(c.expect.acceptKinds)).toBe(true);
      expect(c.expect.acceptKinds.length).toBeGreaterThan(0);
      // redaction invariant: no committed case may carry a real screenshot
      expect(c.state.screenshot.startsWith("iVBORw0KGgo")).toBe(true);
    }
  });
});
