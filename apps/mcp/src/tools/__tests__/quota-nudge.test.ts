// Quota runway nudge band logic (#2 from the paywall office-hours pass).

import { describe, expect, it } from "vitest";
import { quotaNudge } from "../provision-any.js";

describe("quotaNudge", () => {
  it("nudges inside the runway band (1..3)", () => {
    expect(quotaNudge(3)).toContain("3 free signups left");
    expect(quotaNudge(2)).toContain("2 free signups left");
  });

  it("uses the singular for exactly one left", () => {
    const msg = quotaNudge(1);
    expect(msg).toContain("1 free signup left");
    expect(msg).not.toContain("signups");
  });

  it("does NOT nudge at 0 — a paid (unlimited) account reports 0, and a free account at 0 hits the wall next run anyway", () => {
    expect(quotaNudge(0)).toBeNull();
  });

  it("does NOT nudge above the band (plenty of runway left)", () => {
    expect(quotaNudge(4)).toBeNull();
    expect(quotaNudge(10)).toBeNull();
  });

  it("respects a custom threshold", () => {
    expect(quotaNudge(5, 5)).toContain("5 free signups left");
    expect(quotaNudge(6, 5)).toBeNull();
  });
});
