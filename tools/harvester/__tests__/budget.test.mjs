import { describe, it, expect } from "vitest";
import {
  recordCallsToday,
  isOverBudget,
  summarizeBudget,
  DEFAULT_BUDGET_USD,
} from "../budget.mjs";

const TODAY = "2026-05-24";
const FRESH = {
  date: TODAY,
  llm_calls_total: 0,
  estimated_cost_usd: 0,
  attempts: 0,
};

describe("recordCallsToday", () => {
  it("adds llm calls to today's total when date matches", () => {
    const next = recordCallsToday(FRESH, 10, TODAY);
    expect(next.llm_calls_total).toBe(10);
    expect(next.estimated_cost_usd).toBeCloseTo(0.006, 4);
    expect(next.attempts).toBe(1);
    expect(next.date).toBe(TODAY);
  });

  it("treats undefined/null/non-positive call counts as zero", () => {
    expect(recordCallsToday(FRESH, undefined, TODAY).llm_calls_total).toBe(0);
    expect(recordCallsToday(FRESH, null, TODAY).llm_calls_total).toBe(0);
    expect(recordCallsToday(FRESH, -1, TODAY).llm_calls_total).toBe(0);
    expect(recordCallsToday(FRESH, "lots", TODAY).llm_calls_total).toBe(0);
    // attempts still increments — we ran SOMETHING even if it didn't
    // report calls
    expect(recordCallsToday(FRESH, undefined, TODAY).attempts).toBe(1);
  });

  it("accumulates across multiple attempts", () => {
    let s = FRESH;
    s = recordCallsToday(s, 5, TODAY);
    s = recordCallsToday(s, 7, TODAY);
    s = recordCallsToday(s, 3, TODAY);
    expect(s.llm_calls_total).toBe(15);
    expect(s.attempts).toBe(3);
  });

  it("resets when the stored date != today (midnight rollover)", () => {
    const yesterday = {
      date: "2026-05-23",
      llm_calls_total: 500,
      estimated_cost_usd: 0.3,
      attempts: 20,
    };
    const next = recordCallsToday(yesterday, 5, TODAY);
    expect(next.date).toBe(TODAY);
    expect(next.llm_calls_total).toBe(5);
    expect(next.attempts).toBe(1);
  });

  it("does not mutate the input state", () => {
    const snapshot = JSON.stringify(FRESH);
    recordCallsToday(FRESH, 10, TODAY);
    expect(JSON.stringify(FRESH)).toBe(snapshot);
  });
});

describe("isOverBudget", () => {
  it("under budget on a fresh day", () => {
    expect(isOverBudget(FRESH).over).toBe(false);
  });

  it("over budget when cost meets the cap exactly", () => {
    const at = { ...FRESH, estimated_cost_usd: DEFAULT_BUDGET_USD };
    const v = isOverBudget(at);
    expect(v.over).toBe(true);
    expect(v.reason).toMatch(/daily LLM spend/);
  });

  it("over budget when cost exceeds the cap", () => {
    const over = { ...FRESH, estimated_cost_usd: 10, llm_calls_total: 100, attempts: 5 };
    const v = isOverBudget(over, 5);
    expect(v.over).toBe(true);
    expect(v.reason).toContain("100 LLM calls");
    expect(v.reason).toContain("5 attempts");
  });

  it("uses caller-supplied cap when provided", () => {
    const s = { ...FRESH, estimated_cost_usd: 1 };
    expect(isOverBudget(s, 2).over).toBe(false);
    expect(isOverBudget(s, 0.5).over).toBe(true);
  });
});

describe("summarizeBudget", () => {
  it("formats a human-readable line", () => {
    const s = { date: TODAY, llm_calls_total: 250, estimated_cost_usd: 0.15, attempts: 12 };
    const line = summarizeBudget(s, 5);
    expect(line).toMatch(/\$0\.15.*\/.*\$5\.00/);
    expect(line).toContain("3%");
    expect(line).toContain("12 attempts");
    expect(line).toContain("250 LLM calls");
  });
});
