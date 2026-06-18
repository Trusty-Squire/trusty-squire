// Router classification — the gate that keeps the autonomous fix-agent pointed
// only at deterministic, in-fence failures and routes everything else away.

import { describe, it, expect } from "vitest";
import {
  classifyCluster,
  RETRY_VARIANCE_FLAKY,
  type RouterInput,
} from "../fix-router.js";

const base: RouterInput = {
  service: "svc",
  coarseKind: "oauth_onboarding_failed",
  stage: "planner_loop",
  retryVariance: 0,
  dnsAlive: true,
  curatedNeedsManual: false,
};

describe("classifyCluster", () => {
  it("curated needs-manual → wall (highest precedence)", () => {
    expect(classifyCluster({ ...base, curatedNeedsManual: true }).route).toBe("wall");
  });

  it("dead DNS → wall (even for an in-fence stage)", () => {
    expect(classifyCluster({ ...base, dnsAlive: false }).route).toBe("wall");
  });

  it("flaky (retry-variance high) → drain, overriding an in-fence stage", () => {
    const v = classifyCluster({ ...base, retryVariance: 0.5 });
    expect(v.route).toBe("drain");
    expect(v.reason).toMatch(/flaky/);
  });

  it("deterministic post-OAuth nav (planner_loop) → fix", () => {
    expect(classifyCluster({ ...base, stage: "planner_loop" }).route).toBe("fix");
  });

  it("deterministic extract-stage (reached key page, no credential) → fix", () => {
    expect(classifyCluster({ ...base, stage: "extract" }).route).toBe("fix");
  });

  it("timing stages → drain (retry, not a fix)", () => {
    for (const stage of ["proxy_timeout", "run_timeout", "hydration"] as const) {
      expect(classifyCluster({ ...base, stage }).route).toBe("drain");
    }
  });

  it("faculty-needed stages → wall", () => {
    for (const stage of ["phone", "payment", "manual"] as const) {
      expect(classifyCluster({ ...base, stage }).route).toBe("wall");
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
      expect(v.reason).toMatch(/out-of-fence/);
    }
  });

  it("the flaky threshold is exclusive-below / inclusive-at", () => {
    // Just under the threshold + an in-fence stage → fix (deterministic enough).
    expect(
      classifyCluster({ ...base, retryVariance: RETRY_VARIANCE_FLAKY - 0.01 }).route,
    ).toBe("fix");
    // At the threshold → drain.
    expect(classifyCluster({ ...base, retryVariance: RETRY_VARIANCE_FLAKY }).route).toBe(
      "drain",
    );
  });
});
