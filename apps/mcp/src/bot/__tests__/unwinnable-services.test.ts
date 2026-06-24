// AB6 — the unwinnable-service denylist + its normalized matching.

import { describe, expect, it } from "vitest";
import { classifyUnwinnable } from "../unwinnable-services.js";

describe("classifyUnwinnable", () => {
  it("routes the known 0% services to manual with a gate + reason", () => {
    expect(classifyUnwinnable("cloudflare")?.gate).toBe("max_antibot");
    expect(classifyUnwinnable("vercel")?.gate).toBe("sms_phone");
    expect(classifyUnwinnable("circleci")?.gate).toBe("credit_card");
    expect(classifyUnwinnable("northflank")?.gate).toBe("github_2fa");
    for (const svc of ["cloudflare", "vercel", "betterstack"]) {
      expect((classifyUnwinnable(svc)?.reason.length ?? 0)).toBeGreaterThan(10);
    }
  });

  it("clerk is no longer denylisted (stale spa_broken flag removed 2026-06-24)", () => {
    expect(classifyUnwinnable("clerk")).toBeNull();
  });

  it("normalizes slugs (case / separators / spaces)", () => {
    expect(classifyUnwinnable("BetterStack")?.gate).toBe("credit_card");
    expect(classifyUnwinnable("better-stack")?.gate).toBe("credit_card");
    expect(classifyUnwinnable("Better Stack")?.gate).toBe("credit_card");
    expect(classifyUnwinnable("MailerSend")?.gate).toBe("sms_phone");
  });

  it("returns null for winnable services (the bot should run)", () => {
    for (const svc of ["ipinfo", "netlify", "baseten", "resend", "qdrant"]) {
      expect(classifyUnwinnable(svc)).toBeNull();
    }
  });
});
