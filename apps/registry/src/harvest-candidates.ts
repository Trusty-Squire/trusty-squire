// Demand-weighted harvest candidate selection (design Decision 4 + 6).
//
// Merges two complementary signals into one ranked harvest queue:
//   - DEMAND  (ProvisionEvent volume): "lots of users want this service"
//   - FAILURE (UniversalBotFailureRecord): "users keep hitting walls here"
// Dedupes by service, excludes services that already have an active
// skill, applies the captcha-wall damper, and ranks demand-first. Pure
// + unit-tested; consumed by GET /admin/discovery-candidates (which the
// housekeeper harvest queue reads) and the operator dashboard.

import type { DemandRow } from "./provision-event-store.js";
import type { DiscoveryCandidate } from "./bot-failure-store.js";

export interface HarvestCandidate {
  service: string;
  volume: number; // total provisions in the window
  distinct_failures: number; // distinct accounts that failed (0 if demand-only)
  top_error_kind: string; // "" when there's no failure signal
  most_recent_at: Date | null;
  wall_ratio: number; // fraction of failures that were captcha/anti-bot walls
  source: "demand" | "failure" | "both";
}

// A service whose failures are MORE than this fraction walls is damped
// out of the queue — harvesting it would just grind on a captcha wall.
export const WALL_DOMINANCE_THRESHOLD = 0.5;

export function mergeHarvestCandidates(args: {
  demandRows: readonly DemandRow[];
  failureCandidates: readonly DiscoveryCandidate[];
  activeServices: ReadonlySet<string>;
  limit: number;
}): HarvestCandidate[] {
  const { demandRows, failureCandidates, activeServices, limit } = args;
  const demandByService = new Map(demandRows.map((d) => [d.service, d]));
  const failureByService = new Map(failureCandidates.map((c) => [c.service, c]));
  const services = new Set<string>([
    ...demandRows.map((d) => d.service),
    ...failureCandidates.map((c) => c.service),
  ]);

  const out: HarvestCandidate[] = [];
  for (const service of services) {
    // Only hunt for NEW skills — a service with an active skill is
    // already served by replay.
    if (activeServices.has(service)) continue;
    const d = demandByService.get(service);
    const f = failureByService.get(service);
    const wall_ratio = d !== undefined && d.failed > 0 ? d.wall_failed / d.failed : 0;
    // Wall damper (Decision 6): skip services whose failures are
    // dominated by captcha/anti-bot walls. Unknown failure kinds don't
    // count as walls, so a novel-string service stays eligible.
    if (wall_ratio > WALL_DOMINANCE_THRESHOLD) continue;
    out.push({
      service,
      volume: d?.volume ?? 0,
      distinct_failures: f?.distinct_failures ?? 0,
      top_error_kind: f?.top_error_kind ?? "",
      most_recent_at: f?.most_recent_at ?? null,
      wall_ratio,
      source: d !== undefined && f !== undefined ? "both" : f !== undefined ? "failure" : "demand",
    });
  }
  // Demand-weighted: volume first, distinct failures as the tiebreak.
  out.sort((a, b) => b.volume - a.volume || b.distinct_failures - a.distinct_failures);
  return out.slice(0, Math.max(1, limit));
}
