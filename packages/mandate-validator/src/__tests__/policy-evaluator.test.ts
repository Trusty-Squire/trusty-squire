// Policy evaluator tests — covers the eight short-circuit checks plus
// every step-up reason. 100% line coverage target.

import { describe, expect, it } from "vitest";
import {
  generateEd25519,
  makeDeps,
  makeMandatePayload,
  NOW,
} from "./_fixtures.js";
import { MandateValidator } from "../validator.js";
import type { EvaluationContext, ProposedAction } from "../types.js";

const PAIR = generateEd25519();

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return { now: NOW, session_anomaly_flags: [], ...overrides };
}

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    type: "provision",
    service: "resend",
    category: "email",
    plan: "free",
    cost_cents: 0,
    recurrence: "none",
    ...overrides,
  };
}

describe("evaluateAction — short-circuit rejections", () => {
  it("invalid clock in context → reject", async () => {
    const m = makeMandatePayload(PAIR);
    const r = await new MandateValidator(makeDeps()).evaluateAction(
      m,
      action(),
      ctx({ now: "not-a-date" }),
    );
    expect(r).toEqual({ kind: "reject", reason: "invalid_context_clock" });
  });

  it("mandate_invalid_window when not_before / not_after unparseable", async () => {
    const m = makeMandatePayload(PAIR, { not_before: "junk" });
    const r = await new MandateValidator(makeDeps()).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "mandate_invalid_window" });
  });

  it("mandate_not_yet_valid when now+skew < not_before", async () => {
    const m = makeMandatePayload(PAIR, {
      not_before: "2099-01-01T00:00:00.000Z",
      not_after: "2099-12-31T00:00:00.000Z",
    });
    const r = await new MandateValidator(makeDeps()).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "mandate_not_yet_valid" });
  });

  it("60s skew on not_before is forgiven", async () => {
    // Mandate becomes valid 30s after NOW; should still pass via skew.
    const notBefore = new Date(Date.parse(NOW) + 30_000).toISOString();
    const m = makeMandatePayload(PAIR, { not_before: notBefore });
    // Pre-provision so the silent path isn't blocked by novel_service /
    // new_category — we're isolating the skew check here.
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(m, action(), ctx());
    expect(r.kind).toBe("silent");
  });

  it("mandate_expired when now > not_after (no skew)", async () => {
    const m = makeMandatePayload(PAIR, { not_after: "2020-01-01T00:00:00.000Z" });
    const r = await new MandateValidator(makeDeps()).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "mandate_expired" });
  });

  it("revoked mandate → reject", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps();
    deps.revokedMandates.add(m.id);
    const r = await new MandateValidator(deps).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "mandate_revoked" });
  });

  it("category not in allowed_categories → reject", async () => {
    const m = makeMandatePayload(PAIR, { allowed_categories: ["email"] });
    const r = await new MandateValidator(makeDeps()).evaluateAction(
      m,
      action({ category: "analytics" }),
      ctx(),
    );
    expect(r).toEqual({ kind: "reject", reason: "category_not_allowed" });
  });

  it("blocked service → reject", async () => {
    const m = makeMandatePayload(PAIR, { blocked_services: ["resend"] });
    const r = await new MandateValidator(makeDeps()).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "service_blocked" });
  });

  it("service not in allowed_services (non-wildcard) → reject", async () => {
    const m = makeMandatePayload(PAIR, { allowed_services: ["postmark"] });
    const r = await new MandateValidator(makeDeps()).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "reject", reason: "service_not_allowed" });
  });

  it("monthly budget exhausted → reject", async () => {
    const m = makeMandatePayload(PAIR, { monthly_budget_cents: 1000 });
    const deps = makeDeps({ getRecentSpend: async () => 900 });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ cost_cents: 200 }),
      ctx(),
    );
    expect(r).toEqual({ kind: "reject", reason: "monthly_budget_exhausted" });
  });
});

describe("evaluateAction — silent path", () => {
  it("Free signup in allowed category → silent", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      // Service must be already-provisioned to skip novel_service.
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(m, action(), ctx());
    expect(r).toEqual({ kind: "silent", mandate_id: m.id });
  });

  it("Service in silently_approved at appropriate cost → silent (overrides novel/category)", async () => {
    const m = makeMandatePayload(PAIR, {
      silently_approved_services: [
        {
          service: "resend",
          max_monthly_cents: 5000,
          approved_at: "2026-01-01T00:00:00.000Z",
          approved_via: "initial_mandate",
        },
      ],
    });
    // Service is novel + category is novel; silently_approved skips those.
    const deps = makeDeps({
      getProvisionedServices: async () => [],
      getProvisionedCategories: async () => [],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ cost_cents: 1500, recurrence: "monthly" }),
      ctx(),
    );
    expect(r).toEqual({ kind: "silent", mandate_id: m.id });
  });
});

describe("evaluateAction — needs_approval reasons", () => {
  it("Paid above per_action_silent_max → above_silent_max", async () => {
    const m = makeMandatePayload(PAIR, { per_action_silent_max_cents: 500 });
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ cost_cents: 600 }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("above_silent_max");
    expect(r.required_confidence).toBe("medium");
  });

  it("Novel service even at $0 → novel_service", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      getProvisionedServices: async () => [],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(m, action(), ctx());
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("novel_service");
  });

  it("New category → new_category", async () => {
    const m = makeMandatePayload(PAIR, {
      allowed_categories: ["email", "analytics"],
    });
    const deps = makeDeps({
      getProvisionedServices: async () => ["mixpanel"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ service: "mixpanel", category: "analytics" }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("new_category");
  });

  it("Recurring monthly action → recurring_commitment", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ recurrence: "monthly" }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("recurring_commitment");
  });

  it("Yearly recurrence → recurring_commitment", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ recurrence: "yearly" }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("recurring_commitment");
  });

  it("Daily-spend would exceed 80% of daily limit → near_daily_limit", async () => {
    const m = makeMandatePayload(PAIR, { daily_silent_max_cents: 1000 });
    // Spend in the last 24h is 700; cost is 200; 80% threshold = 800.
    // 700 + 200 = 900 > 800 → near_daily_limit triggers.
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
      getRecentSpend: async (_a, since) => {
        // 24h window vs 30d window — distinguish by comparing since to NOW
        const ageMs = Date.parse(NOW) - since.getTime();
        return ageMs <= 24 * 60 * 60 * 1000 + 1000 ? 700 : 700;
      },
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ cost_cents: 200 }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("near_daily_limit");
  });

  it("session_anomaly_flags in context → session_anomaly", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      getProvisionedServices: async () => ["resend"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action(),
      ctx({ session_anomaly_flags: ["impossible_travel"] }),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toContain("session_anomaly");
  });

  it("Service in silently_approved but cost > remembered max → above_silent_max", async () => {
    const m = makeMandatePayload(PAIR, {
      silently_approved_services: [
        {
          service: "resend",
          max_monthly_cents: 1000,
          approved_at: "2026-01-01T00:00:00.000Z",
          approved_via: "initial_mandate",
        },
      ],
    });
    const r = await new MandateValidator(makeDeps()).evaluateAction(
      m,
      action({ cost_cents: 1500, recurrence: "monthly" }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toEqual(["above_silent_max"]);
  });

  it("required_confidence is read from mandate.confidence_requirements per action.type", async () => {
    const m = makeMandatePayload(PAIR);
    const deps = makeDeps({
      getProvisionedServices: async () => [],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ type: "amend_mandate" }),
      ctx(),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.required_confidence).toBe("high");
  });

  it("Multiple reasons accumulate in spec order", async () => {
    const m = makeMandatePayload(PAIR, { per_action_silent_max_cents: 100 });
    const deps = makeDeps({
      getProvisionedServices: async () => [],
      getProvisionedCategories: async () => [],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({
        cost_cents: 500,
        recurrence: "monthly",
        category: "monitoring",
      }),
      ctx({ session_anomaly_flags: ["weird_ip"] }),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind !== "needs_approval") return;
    expect(r.reasons).toEqual([
      "above_silent_max",
      "novel_service",
      "new_category",
      "recurring_commitment",
      "session_anomaly",
    ]);
  });
});

describe("evaluateAction — wildcard allowed_services", () => {
  it("'*' wildcard accepts any service", async () => {
    const m = makeMandatePayload(PAIR, { allowed_services: "*" });
    const deps = makeDeps({
      getProvisionedServices: async () => ["random-service"],
      getProvisionedCategories: async () => ["email"],
    });
    const r = await new MandateValidator(deps).evaluateAction(
      m,
      action({ service: "random-service" }),
      ctx(),
    );
    expect(r.kind).toBe("silent");
  });
});

describe("issueDeltaChallenge", () => {
  it("returns 64-char hex nonce + 5-minute expiry", async () => {
    const v = new MandateValidator(makeDeps());
    const c = await v.issueDeltaChallenge("01HRUNZZ", action());
    expect(c.nonce).toMatch(/^[0-9a-f]{64}$/);
    const expiresMs = Date.parse(c.expires_at);
    expect(expiresMs - Date.parse(NOW)).toBe(5 * 60 * 1000);
  });

  it("each call returns a different nonce", async () => {
    const v = new MandateValidator(makeDeps());
    const a = await v.issueDeltaChallenge("01HRUNZZ", action());
    const b = await v.issueDeltaChallenge("01HRUNZZ", action());
    expect(a.nonce).not.toBe(b.nonce);
  });
});
