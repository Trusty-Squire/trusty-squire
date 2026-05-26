// Discovery loop — closed-loop strategy Phase 6.
//
// Pulls the registry's discovery-candidate queue (services where
// ≥3 distinct users have hit terminal universal-bot failures in the
// lookback window AND no active skill exists), drives the universal
// bot against each, lets the bot's existing auto-promote pipeline
// write any successful capture into the registry as pending-review.
//
// The verifier worker (Phase 3) then picks it up and promotes after
// N=2 fresh successes.
//
// The actual `runUniversalBot` invocation is injected — the CLI
// wires it to provisionAnyTool.handler in production; tests stub it.
// This keeps the loop testable and lets us iterate on the wiring
// (operator credentials, parallelism) without rewriting the queue
// logic.

import { VerifierRegistryClient } from "./registry-client.js";

export interface DiscoveryCandidateItem {
  service: string;
  distinct_failures: number;
  top_error_kind: string;
  most_recent_at: string;
}

export interface DiscoveryBotResult {
  // 'ok' means the bot reached `success: true` and auto-promote
  // (existing pipeline) wrote a pending-review skill to the
  // registry. The verifier worker will validate it.
  kind: "ok" | "failed" | "blocked";
  // Free-text for logging. Typically the bot's terminal status
  // (no_credentials, oauth_onboarding_failed, etc.).
  reason: string;
}

export type DiscoveryBotRunner = (input: {
  service: string;
}) => Promise<DiscoveryBotResult>;

export interface RunDiscoveryOpts {
  // Same admin-bearer-backed registry client the verifier uses.
  client: VerifierRegistryClient;
  // Injection point. Production wires this to provisionAnyTool.handler;
  // tests pass a canned function.
  runUniversalBot: DiscoveryBotRunner;
  // How many candidates to attempt per batch. Default 5 — discovery is
  // slow per-service and we want to spread budget across many.
  limit?: number;
  // Aggregation window forwarded to GET /admin/discovery-candidates.
  sinceDays?: number;
  // Distinct-failure threshold forwarded to the endpoint.
  minDistinct?: number;
  // Loop pacing — same shape as the verifier loop.
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  once?: boolean;
  log?: (line: string) => void;
}

export interface DiscoveryBatchSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  blocked: number;
}

export async function runDiscoveryBatch(opts: RunDiscoveryOpts): Promise<DiscoveryBatchSummary> {
  const log = opts.log ?? ((line: string) => console.log(`[discovery] ${line}`));
  const limit = opts.limit ?? 5;
  const candidates = await opts.client.fetchDiscoveryCandidates({
    limit,
    ...(opts.sinceDays !== undefined ? { sinceDays: opts.sinceDays } : {}),
    ...(opts.minDistinct !== undefined ? { minDistinct: opts.minDistinct } : {}),
  });
  log(`fetched candidates: ${candidates.length}`);
  const summary: DiscoveryBatchSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
  };
  for (const candidate of candidates) {
    summary.attempted += 1;
    log(
      `discover start: ${candidate.service} (${candidate.distinct_failures} distinct users hit ${candidate.top_error_kind})`,
    );
    try {
      const result = await opts.runUniversalBot({ service: candidate.service });
      log(`discover end:   ${candidate.service} → ${result.kind} (${result.reason.slice(0, 120)})`);
      if (result.kind === "ok") summary.succeeded += 1;
      else if (result.kind === "blocked") summary.blocked += 1;
      else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      log(
        `discover error: ${candidate.service} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  log(
    `discovery batch done: attempted=${summary.attempted} ok=${summary.succeeded} ` +
      `failed=${summary.failed} blocked=${summary.blocked}`,
  );
  return summary;
}

export async function runDiscoveryLoop(opts: RunDiscoveryOpts): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(`[discovery] ${line}`));
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000; // daily
  for (;;) {
    try {
      await runDiscoveryBatch(opts);
    } catch (err) {
      log(`ERROR: batch failed (${err instanceof Error ? err.message : String(err)}) — sleeping`);
    }
    if (opts.once === true) return;
    log(`sleeping ${Math.round(intervalMs / 1000)}s until next batch…`);
    await sleep(intervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
