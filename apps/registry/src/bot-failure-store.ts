// Store for UniversalBotFailureRecord — closed-loop strategy Phase 5.
//
// Bot failures land here as fire-and-forget telemetry from end-user
// MCPs. The discovery worker (Phase 6) reads them via the aggregation
// method to pick new services to iterate against. Keeps a separate
// store interface so the SkillStore stays focused on skill-record CRUD.

export interface UniversalBotFailureRecord {
  id: string;
  service: string;
  error_kind: string;
  reason: string;
  account_id: string;
  mcp_version: string;
  reported_at: Date;
}

export interface InsertBotFailureInput {
  service: string;
  error_kind: string;
  reason: string;
  account_id: string;
  mcp_version: string;
}

export interface DiscoveryCandidate {
  service: string;
  // Distinct accounts that reported failures for this service inside
  // the lookback window. The >=3 threshold is enforced by the
  // aggregation query, not the caller.
  distinct_failures: number;
  // Most common error_kind for this service (helps the discovery
  // worker prioritize which class of failure to attack first).
  top_error_kind: string;
  // Most recent failure within the window.
  most_recent_at: Date;
}

export interface ListDiscoveryCandidatesOpts {
  // The aggregation window. Default 14 days.
  sinceDays?: number;
  // Skill table reference. The candidate query excludes services
  // that already have an active skill — the discovery worker only
  // hunts for new ones. Production wires this to a lookup against
  // SkillRecord; tests pass a Set.
  excludeServices: Set<string>;
  // ≥N distinct accounts. Default 3.
  minDistinct?: number;
  // Limit the result set.
  limit?: number;
  // Deterministic time injection.
  now?: Date;
}

export interface BotFailureStore {
  insert(input: InsertBotFailureInput): Promise<UniversalBotFailureRecord>;

  /**
   * Distinct-account failure count per service in the lookback window,
   * filtered to services not already in the active-skill set, sorted
   * by distinct_failures descending. Surfaces the discovery worker's
   * queue.
   */
  listDiscoveryCandidates(
    opts: ListDiscoveryCandidatesOpts,
  ): Promise<DiscoveryCandidate[]>;

  /**
   * Count failures reported by an account in the recent window. Backs
   * a per-account rate limit on the POST endpoint.
   */
  countRecentByAccount(account_id: string, since: Date): Promise<number>;

  /**
   * Retention pruner — drops rows older than the cutoff. Called from
   * the same hourly cron that prunes ExtractFailureSnapshot.
   */
  pruneOlderThan(cutoff: Date): Promise<number>;
}
