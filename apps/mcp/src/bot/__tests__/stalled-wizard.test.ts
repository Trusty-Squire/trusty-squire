// isStalledOnActions — the deterministic breaker for a broken onboarding
// wizard that re-presents itself (the axiom case): the planner keeps
// correctly clicking a visibly-unfilled card, but the click never
// registers, so the page is identical round after round. Without the
// breaker the run burns all 24 post-verify rounds + LLM budget.

import { describe, expect, it } from "vitest";
import { isStalledOnActions } from "../agent.js";

const a = (kind: string, pageUnchanged: boolean) => ({ kind, pageUnchanged });

describe("isStalledOnActions", () => {
  it("fires when 3 consecutive page-mutating actions left the page unchanged (axiom)", () => {
    expect(
      isStalledOnActions([a("click", true), a("click", true), a("click", true)]),
    ).toBe(true);
  });

  it("counts mixed action kinds (click/select/check) toward the stall", () => {
    expect(
      isStalledOnActions([a("click", true), a("select", true), a("check", true)]),
    ).toBe(true);
  });

  it("does NOT fire below the threshold", () => {
    expect(isStalledOnActions([a("click", true), a("click", true)])).toBe(false);
  });

  it("does NOT fire if any of the last 3 actions DID change the page", () => {
    expect(
      isStalledOnActions([a("click", true), a("click", false), a("click", true)]),
    ).toBe(false);
  });

  it("excludes navigate/wait/extract — they legitimately don't mutate the current DOM", () => {
    // A navigate changes the URL not the DOM; it must not count as a stall.
    expect(
      isStalledOnActions([a("click", true), a("navigate", true), a("click", true)]),
    ).toBe(false);
    expect(
      isStalledOnActions([a("wait", true), a("wait", true), a("wait", true)]),
    ).toBe(false);
  });

  it("uses only the most recent `threshold` effects (a stall after earlier progress still fires)", () => {
    expect(
      isStalledOnActions([
        a("click", false), // earlier progress
        a("click", true),
        a("click", true),
        a("click", true),
      ]),
    ).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(isStalledOnActions([a("click", true), a("click", true)], 2)).toBe(true);
  });
});
