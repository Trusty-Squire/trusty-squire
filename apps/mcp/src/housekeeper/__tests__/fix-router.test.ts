// Router classification — the gate that keeps the autonomous fix-agent pointed
// only at deterministic, in-fence failures and routes everything else away.

import { describe, it, expect } from "vitest";
import {
  classifyCluster,
  RECENT_GREEN_RATE_FLAKY,
  type RouterInput,
} from "../fix-router.js";

const base: RouterInput = {
  service: "svc",
  coarseKind: "oauth_onboarding_failed",
  stage: "planner_loop",
  recentGreenRate: 0,
  dnsAlive: true,
  curatedNeedsManual: false,
};

describe("classifyCluster", () => {
  it("curated needs-manual does not wall an in-fence regression", () => {
    const v = classifyCluster({ ...base, curatedNeedsManual: true });
    expect(v.route).toBe("fix");
    expect(v.reason).toMatch(/attempt fix/);
  });

  it("dead DNS does not wall an in-fence regression", () => {
    const v = classifyCluster({ ...base, dnsAlive: false });
    expect(v.route).toBe("fix");
    expect(v.reason).toMatch(/URL resolution/);
  });

  it("flaky (retry-variance high) → drain, overriding an in-fence stage", () => {
    const v = classifyCluster({ ...base, recentGreenRate: 0.5 });
    expect(v.route).toBe("drain");
    expect(v.reason).toMatch(/flaky/);
  });

  it("deterministic post-OAuth nav (planner_loop) → fix", () => {
    const v = classifyCluster({ ...base, stage: "planner_loop" });
    expect(v.route).toBe("fix");
    expect(v.owner).toBe("code");
    expect(v.disposition).toBe("attempt_fix");
  });

  it("deterministic extract-stage (reached key page, no credential) → fix", () => {
    expect(classifyCluster({ ...base, stage: "extract" }).route).toBe("fix");
  });

  it("timing stages → drain (retry, not a fix)", () => {
    for (const stage of ["proxy_timeout", "run_timeout", "hydration"] as const) {
      expect(classifyCluster({ ...base, stage }).route).toBe("drain");
    }
  });

  it("faculty-needed stages → capability_gap, not wall", () => {
    for (const stage of ["phone", "payment", "manual"] as const) {
      expect(classifyCluster({ ...base, stage }).route).toBe("capability_gap");
    }
  });

  it("deterministic but OUT-of-fence (oauth/email/captcha/form) → capability_gap", () => {
    for (const stage of [
      "oauth_handshake",
      "account_chooser",
      "consent",
      "verify_email",
      "captcha",
      "anti_bot",
      "form",
      "other",
    ] as const) {
      const v = classifyCluster({ ...base, stage });
      expect(v.route).toBe("capability_gap");
      expect(v.owner).toBe("capability");
      expect(v.disposition).toBe("needs_capability");
      expect(v.reason).toMatch(/out-of-fence/);
    }
  });

  it("routes retry and capability classes to explicit owners", () => {
    const drain = classifyCluster({ ...base, stage: "run_timeout" });
    expect(drain.route).toBe("drain");
    expect(drain.owner).toBe("retry");
    expect(drain.disposition).toBe("retry_later");

    const cap = classifyCluster({ ...base, stage: "payment" });
    expect(cap.route).toBe("capability_gap");
    expect(cap.owner).toBe("capability");
    expect(cap.disposition).toBe("needs_capability");
  });

  it("the flaky threshold is exclusive-below / inclusive-at", () => {
    // Just under the threshold + an in-fence stage → fix (deterministic enough).
    expect(
      classifyCluster({ ...base, recentGreenRate: RECENT_GREEN_RATE_FLAKY - 0.01 }).route,
    ).toBe("fix");
    // At the threshold → drain.
    expect(classifyCluster({ ...base, recentGreenRate: RECENT_GREEN_RATE_FLAKY }).route).toBe(
      "drain",
    );
  });
});
