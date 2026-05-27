import { describe, it, expect } from "vitest";
import {
  findPersistentFailures,
  buildEscalationIssueBody,
  escalationLabels,
  escalationTitle,
} from "../escalation.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-05-31T12:00:00Z");

function halt(opts) {
  return {
    ts: opts.ts,
    service: opts.service,
    failure_category: opts.category ?? "environment",
    bot_status: opts.status ?? "captcha_blocked",
    error_message: opts.error ?? "Cloudflare Turnstile timeout",
  };
}

describe("findPersistentFailures", () => {
  it("returns nothing on empty halts list", () => {
    expect(findPersistentFailures([], { nowMs: NOW })).toEqual([]);
  });

  it("identifies a (service, environment) pair with 3+ occurrences over half-window", () => {
    const halts = [
      halt({ service: "railway", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 4 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    const result = findPersistentFailures(halts, { nowMs: NOW });
    expect(result.length).toBe(1);
    expect(result[0].service).toBe("railway");
    expect(result[0].category).toBe("environment");
    expect(result[0].occurrences.length).toBe(3);
  });

  it("rejects bursts that span less than half the window", () => {
    // 5 occurrences within 1 hour (way less than 3.5d span) — should
    // be filtered as a burst, not a persistent issue
    const base = NOW - 1 * DAY;
    const halts = Array.from({ length: 5 }, (_, i) =>
      halt({
        service: "railway",
        ts: new Date(base + i * 10 * 60_000).toISOString(),
      }),
    );
    expect(findPersistentFailures(halts, { nowMs: NOW })).toEqual([]);
  });

  it("rejects below-threshold counts", () => {
    const halts = [
      halt({ service: "railway", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    expect(findPersistentFailures(halts, { nowMs: NOW })).toEqual([]);
  });

  it("ignores halts outside the 7d window", () => {
    const halts = [
      // 14d ago — outside window
      halt({ service: "railway", ts: new Date(NOW - 14 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 10 * DAY).toISOString() }),
      // 6d ago — inside
      halt({ service: "railway", ts: new Date(NOW - 6 * DAY).toISOString() }),
    ];
    expect(findPersistentFailures(halts, { nowMs: NOW })).toEqual([]);
  });

  it("ignores non-environment categories", () => {
    const halts = [
      halt({ service: "x", category: "code_bug", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "x", category: "code_bug", ts: new Date(NOW - 4 * DAY).toISOString() }),
      halt({ service: "x", category: "code_bug", ts: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    expect(findPersistentFailures(halts, { nowMs: NOW })).toEqual([]);
  });

  it("groups by (service, category) — independent services don't merge", () => {
    const halts = [
      halt({ service: "railway", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 4 * DAY).toISOString() }),
      halt({ service: "railway", ts: new Date(NOW - 1 * DAY).toISOString() }),
      halt({ service: "resend", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "resend", ts: new Date(NOW - 3 * DAY).toISOString() }),
      halt({ service: "resend", ts: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    const result = findPersistentFailures(halts, { nowMs: NOW });
    const slugs = result.map((g) => g.service).sort();
    expect(slugs).toEqual(["railway", "resend"]);
  });

  it("respects custom thresholds via opts", () => {
    const halts = [
      // 2 halts 5d apart — meets span check (3.5d) AND custom min (2)
      halt({ service: "x", ts: new Date(NOW - 6 * DAY).toISOString() }),
      halt({ service: "x", ts: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    // Below default min (3) but meets custom min (2)
    const result = findPersistentFailures(halts, {
      nowMs: NOW,
      minOccurrences: 2,
    });
    expect(result.length).toBe(1);
  });
});

describe("buildEscalationIssueBody", () => {
  const group = {
    service: "railway",
    category: "environment",
    occurrences: [
      {
        ts: "2026-05-25T10:00:00Z",
        bot_status: "captcha_blocked",
        error_message: "turnstile challenge did not resolve",
      },
      {
        ts: "2026-05-28T10:00:00Z",
        bot_status: "captcha_blocked",
        error_message: "turnstile challenge did not resolve",
      },
      {
        ts: "2026-05-30T10:00:00Z",
        bot_status: "anti_bot_blocked",
        error_message: "Cloudflare interstitial wouldn't clear",
      },
    ],
  };

  it("includes the persistent-failure summary line", () => {
    const body = buildEscalationIssueBody(group);
    expect(body).toContain("Persistent environment failure");
    expect(body).toContain("railway");
    expect(body).toContain("3 attempts");
  });

  it("breaks down bot statuses with counts", () => {
    const body = buildEscalationIssueBody(group);
    expect(body).toContain("`captcha_blocked`: 2");
    expect(body).toContain("`anti_bot_blocked`: 1");
  });

  it("includes oldest and newest timestamps", () => {
    const body = buildEscalationIssueBody(group);
    expect(body).toContain("2026-05-25T10:00:00.000Z");
    expect(body).toContain("2026-05-30T10:00:00.000Z");
  });

  it("references the halt-report file path for digging deeper", () => {
    const body = buildEscalationIssueBody(group);
    expect(body).toContain("halts/*-railway.json");
  });

  it("includes actionable next-steps guidance", () => {
    const body = buildEscalationIssueBody(group);
    expect(body).toContain("residential proxy");
    expect(body).toContain("real-GPU");
    expect(body).toContain("status: skip");
  });
});

describe("escalationLabels + escalationTitle", () => {
  it("labels include all 4 required tags", () => {
    const labels = escalationLabels({ service: "railway", category: "environment" });
    expect(labels).toContain("skill-harvester");
    expect(labels).toContain("harvester:investigate");
    expect(labels).toContain("service:railway");
    expect(labels).toContain("category:environment");
  });

  it("title is stable per (service, category) for idempotent lookup", () => {
    const title = escalationTitle({ service: "railway", category: "environment" });
    expect(title).toBe("[harvester:investigate] railway — persistent environment failures");
  });
});
