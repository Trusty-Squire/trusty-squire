// T6 — demand-weighted harvest candidate selection + wall damper.

import { describe, expect, it } from "vitest";
import { mergeHarvestCandidates } from "../harvest-candidates.js";
import type { DemandRow } from "../provision-event-store.js";
import type { DiscoveryCandidate } from "../bot-failure-store.js";

const demand = (service: string, volume: number, failed = 0, wall_failed = 0): DemandRow => ({
  service,
  volume,
  failed,
  wall_failed,
});
const failure = (service: string, distinct_failures: number, top = "verification_not_sent"): DiscoveryCandidate => ({
  service,
  distinct_failures,
  top_error_kind: top,
  most_recent_at: new Date("2026-05-30T00:00:00Z"),
});

describe("mergeHarvestCandidates", () => {
  it("ranks demand-first and dedupes services present in both signals", () => {
    const out = mergeHarvestCandidates({
      demandRows: [demand("supabase", 2000), demand("railway", 1400, 10, 1)],
      failureCandidates: [failure("railway", 8)],
      activeServices: new Set(),
      limit: 10,
    });
    expect(out.map((c) => c.service)).toEqual(["supabase", "railway"]);
    const railway = out.find((c) => c.service === "railway")!;
    expect(railway.source).toBe("both");
    expect(railway.distinct_failures).toBe(8);
    expect(railway.volume).toBe(1400);
  });

  it("includes a failure-only service (no demand row) with volume 0", () => {
    const out = mergeHarvestCandidates({
      demandRows: [],
      failureCandidates: [failure("cloudflarePages", 5)],
      activeServices: new Set(),
      limit: 10,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ service: "cloudflarePages", volume: 0, source: "failure" });
  });

  it("excludes services that already have an active skill", () => {
    const out = mergeHarvestCandidates({
      demandRows: [demand("resend", 5000), demand("supabase", 2000)],
      failureCandidates: [],
      activeServices: new Set(["resend"]),
      limit: 10,
    });
    expect(out.map((c) => c.service)).toEqual(["supabase"]);
  });

  it("damps a wall-dominated service (>50% wall failures)", () => {
    const out = mergeHarvestCandidates({
      // cloudflare: 10 failures, 9 of them walls → 90% → damped.
      demandRows: [demand("cloudflare", 12, 10, 9), demand("supabase", 8, 2, 0)],
      failureCandidates: [],
      activeServices: new Set(),
      limit: 10,
    });
    expect(out.map((c) => c.service)).toEqual(["supabase"]);
  });

  it("keeps a service at exactly 50% walls (threshold is strictly greater)", () => {
    const out = mergeHarvestCandidates({
      demandRows: [demand("borderline", 10, 4, 2)], // 2/4 = 0.5
      failureCandidates: [],
      activeServices: new Set(),
      limit: 10,
    });
    expect(out.map((c) => c.service)).toEqual(["borderline"]);
  });

  it("respects the limit after ranking", () => {
    const out = mergeHarvestCandidates({
      demandRows: [demand("a", 100), demand("b", 80), demand("c", 60)],
      failureCandidates: [],
      activeServices: new Set(),
      limit: 2,
    });
    expect(out.map((c) => c.service)).toEqual(["a", "b"]);
  });

  it("breaks volume ties by distinct_failures", () => {
    const out = mergeHarvestCandidates({
      demandRows: [demand("x", 50), demand("y", 50)],
      failureCandidates: [failure("y", 7)],
      activeServices: new Set(),
      limit: 10,
    });
    expect(out.map((c) => c.service)).toEqual(["y", "x"]);
  });
});
