// T14 — covers scoreOnboardingStep, the pure scoring core of the
// post-OAuth onboarding eval harness. The runner itself needs a live
// LLM and is exercised by running eval-onboarding.ts directly.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreOnboardingStep, type OnboardingExpectation } from "../eval-onboarding.js";
import { captureOnboardingRound } from "../onboarding-capture.js";
import type { PostVerifyStep } from "../agent.js";

const extract: PostVerifyStep = { kind: "extract", reason: "key visible" };
const done: PostVerifyStep = { kind: "done", reason: "stuck" };
const navigate: PostVerifyStep = {
  kind: "navigate",
  url: "https://x.test/account",
  reason: "go to account settings",
};
const clickCreate: PostVerifyStep = {
  kind: "click",
  selector: "#create-key",
  reason: "create a key",
};
const clickOther: PostVerifyStep = {
  kind: "click",
  selector: "#docs",
  reason: "open docs",
};
const login: PostVerifyStep = { kind: "login", reason: "sign in" };

describe("scoreOnboardingStep", () => {
  it("passes a step whose kind is in acceptKinds", () => {
    const exp: OnboardingExpectation = { acceptKinds: ["extract"] };
    expect(scoreOnboardingStep(extract, exp).pass).toBe(true);
  });

  it("fails a step whose kind is not accepted", () => {
    const exp: OnboardingExpectation = { acceptKinds: ["extract"] };
    const score = scoreOnboardingStep(done, exp);
    expect(score.pass).toBe(false);
    expect(score.detail).toMatch(/expected one of/);
  });

  it("fails a step whose kind is explicitly rejected (the masked-key trap)", () => {
    // extract is the wrong move on a masked-key page even though
    // navigation is accepted — rejectKinds documents the trap.
    const exp: OnboardingExpectation = {
      acceptKinds: ["click", "navigate"],
      rejectKinds: ["extract", "done"],
    };
    const score = scoreOnboardingStep(extract, exp);
    expect(score.pass).toBe(false);
    expect(score.detail).toMatch(/explicitly wrong/);
  });

  it("rejects `login` on an OAuth run even off acceptKinds (T9 guarantee)", () => {
    const exp: OnboardingExpectation = {
      acceptKinds: ["navigate", "done"],
      rejectKinds: ["login"],
    };
    expect(scoreOnboardingStep(login, exp).pass).toBe(false);
  });

  it("enforces selectorsAnyOf for a click step", () => {
    const exp: OnboardingExpectation = {
      acceptKinds: ["click"],
      selectorsAnyOf: ["#create-key"],
    };
    expect(scoreOnboardingStep(clickCreate, exp).pass).toBe(true);
    const miss = scoreOnboardingStep(clickOther, exp);
    expect(miss.pass).toBe(false);
    expect(miss.detail).toMatch(/expected one of #create-key/);
  });

  it("does not apply selectorsAnyOf to a non-click step", () => {
    // A navigate step is accepted on kind alone — selectorsAnyOf only
    // constrains click/fill (navigation states have many valid links).
    const exp: OnboardingExpectation = {
      acceptKinds: ["click", "navigate"],
      selectorsAnyOf: ["#create-key"],
    };
    expect(scoreOnboardingStep(navigate, exp).pass).toBe(true);
  });
});

describe("captureOnboardingRound", () => {
  const sample = {
    service: "Acme",
    round: 0,
    oauth: true,
    state: { url: "https://acme.test/x", title: "T", html: "<html></html>", screenshot: "" },
    inventory: [],
    observed: { kind: "extract", reason: "key visible" } as PostVerifyStep,
  };

  it("is a no-op when TRUSTY_SQUIRE_ONBOARDING_CAPTURE is unset", () => {
    const saved = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    try {
      expect(() => captureOnboardingRound(sample)).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = saved;
    }
  });

  it("writes an eval-corpus-shaped file with expect:null when the dir is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-capture-"));
    const saved = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = dir;
    try {
      captureOnboardingRound(sample);
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const parsed = JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8"));
      expect(parsed.service).toBe("Acme");
      expect(parsed.oauth).toBe(true);
      expect(parsed.expect).toBeNull(); // a curator fills this in
      expect(parsed.observed.kind).toBe("extract");
      expect(parsed.state.url).toBe("https://acme.test/x");
    } finally {
      if (saved === undefined) delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
      else process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
