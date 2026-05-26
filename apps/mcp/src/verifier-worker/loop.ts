// Verifier-worker loop — closed-loop strategy Phase 3.
//
// Pulls the registry's verifier queue (pending-review + freshness-due
// skills), replays each in a headless browser, posts the outcome
// back. The registry handles all status transitions atomically; this
// worker is just the bot that drives the replay and reports what
// happened.
//
// LLM choice: defaults to UNIVERSAL_BOT_LLM_TIER=free (the chain we
// shipped earlier — Gemini 2.0 Flash exp:free → Llama 3.2 90B
// Vision:free → paid escape on 503). Operators flip the env to
// cheap/premium when they want higher accuracy at higher cost.
//
// Concurrency: one skill at a time per worker process. Multiple
// workers can run safely because every transition runs in a Prisma
// transaction. The registry is the source of truth.
//
// Scheduling: `--once` runs a single batch and exits (the cron-style
// path). Without --once it loops forever with a sleep between
// batches; ops can run that on a Fly machine with no scheduler.

import type { Skill } from "@trusty-squire/adapter-sdk";
import {
  VerifierRegistryClient,
  SkillSchemaDriftError,
  type VerifierQueueItem,
  type VerifierOutcomeResponse,
} from "./registry-client.js";
import type { ReplayOutcome } from "../bot/replay-skill.js";
import { runCleanup, type CleanupOutcome } from "./cleanup.js";

// Mode: 'dry' walks the skill without firing the credential-creating
// click — useful when re-verifying skills against services that can't
// safely re-issue tokens. 'full' is the default — it generates a real
// token to prove the path still produces credentials.
export type VerifierReplayMode = "dry" | "full";

// Injection seam for tests + for the future "skill replay engine
// extracted to a shared package" refactor. The CLI wires this to a
// real Playwright-driven replaySkill; tests pass a stub that returns
// canned outcomes without spinning up a browser.
export type ReplayRunner = (input: {
  skill: Skill;
  mode: VerifierReplayMode;
}) => Promise<ReplayOutcome>;

export interface RunVerifierOpts {
  client: VerifierRegistryClient;
  replay: ReplayRunner;
  // How many skills to pull per batch. Maps to the registry's limit.
  limit?: number;
  // 'dry' or 'full' replay. 'full' is the right default for verifier
  // promotion — we want proof the path still produces credentials.
  mode?: VerifierReplayMode;
  // When the inter-batch loop sleeps, this delivers the sleep. Tests
  // pass a no-op to skip real waiting; production passes setTimeout.
  sleep?: (ms: number) => Promise<void>;
  // ms between batches. Default twice daily ≈ 12h.
  intervalMs?: number;
  // True → run one batch and return. False/undefined → infinite loop.
  once?: boolean;
  // For step-trail / debug logging. Tests pass an array push; the CLI
  // passes a console.log adapter.
  log?: (line: string) => void;
  // Phase 4: token cleanup. Optional override of globalThis.fetch
  // used by api_delete cleanup. Tests inject a mock; production
  // leaves undefined.
  cleanupFetchFn?: typeof globalThis.fetch;
  // Phase 4: dashboard cleanup runner. Optional — when present, the
  // loop invokes it for `strategy=dashboard_steps` cleanup. The CLI
  // wires this to a Playwright-backed runner; tests skip it.
  runDashboardCleanup?: (
    skill: Skill,
    steps: Skill["steps"],
  ) => Promise<CleanupOutcome>;
}

export interface BatchSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  // Aggregated by transition kind from the registry's response.
  transitions: {
    promoted: number;
    retired: number;
    demoted: number;
    none: number;
  };
}

export async function runOneBatch(opts: RunVerifierOpts): Promise<BatchSummary> {
  const log = opts.log ?? ((line: string) => console.log(`[verifier] ${line}`));
  const limit = opts.limit ?? 20;
  const mode: VerifierReplayMode = opts.mode ?? "full";
  const queue = await opts.client.fetchQueue(limit);
  log(`fetched queue: ${queue.length} skill(s)`);
  const summary: BatchSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    transitions: { promoted: 0, retired: 0, demoted: 0, none: 0 },
  };
  for (const item of queue) {
    summary.attempted += 1;
    const startMs = Date.now();
    let outcomeKind: "success" | "failure" = "failure";
    let outcomeReason = "uncaught";
    // Phase 3 follow-up — when the registry returns a skill we can't
    // parse (schema drift between worker and writer), DO NOT post an
    // outcome. The skill stays in the queue for the next sweep, and
    // when the worker is updated to match the schema it'll be picked
    // up cleanly. Posting a failure here would demote good skills.
    let skill: Skill;
    try {
      log(`replay start: ${item.service} (skill_id=${item.skill_id}, status=${item.status})`);
      skill = await opts.client.fetchSkill(item.skill_id);
    } catch (err) {
      if (err instanceof SkillSchemaDriftError) {
        log(
          `SKIP: ${item.service} (skill_id=${item.skill_id}) — ${err.message} — leaving in queue for the next worker rev`,
        );
        continue;
      }
      // Network/HTTP error — fall through to the failure path below
      // (a 500 from the registry IS a worker problem, but treating
      // it as a skill failure errs on the safe side: the skill stays
      // in the queue and three consecutive errors retire it; an
      // operator notices long before that).
      outcomeReason = `fetch_error: ${err instanceof Error ? err.message : String(err)}`;
      try {
        await opts.client.postOutcome({
          skill_id: item.skill_id,
          kind: "failure",
          reason: outcomeReason,
          duration_ms: Date.now() - startMs,
        });
      } catch {
        // If the registry is unreachable both ways, the loop logs
        // and moves on — same as the post-replay error path below.
      }
      log(`fetch error: ${item.service} — ${outcomeReason}`);
      summary.failed += 1;
      summary.transitions.none += 1;
      continue;
    }
    try {
      const replay = await opts.replay({ skill, mode });
      const isOk =
        replay.kind === "ok" ||
        replay.kind === "ok_multi" ||
        replay.kind === "dry_pass";
      outcomeKind = isOk ? "success" : "failure";
      outcomeReason = describeReplayOutcome(replay);

      // Phase 4 — token cleanup. Only when replay actually produced a
      // credential (skip dry_pass and multi-credential for now; the
      // latter wants per-credential cleanup which we haven't speced).
      // Best-effort: cleanup failures append to the reason string but
      // do NOT downgrade the verifier success classification.
      if (isOk && replay.kind === "ok") {
        const cleanup = await runCleanup({
          skill,
          credential: replay.credential,
          ...(opts.cleanupFetchFn !== undefined
            ? { fetchFn: opts.cleanupFetchFn }
            : {}),
          ...(opts.runDashboardCleanup !== undefined
            ? {
                runDashboardCleanup: (steps) =>
                  opts.runDashboardCleanup!(skill, steps),
              }
            : {}),
        });
        if (cleanup.kind === "failed") {
          outcomeReason += ` | cleanup_failed(${cleanup.strategy}): ${cleanup.reason}`.slice(0, 800);
        } else if (cleanup.kind === "ok") {
          outcomeReason += ` | cleanup_ok(${cleanup.strategy})`;
        }
      }
    } catch (err) {
      outcomeKind = "failure";
      outcomeReason = `verifier_error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const duration_ms = Date.now() - startMs;
    let postRes: VerifierOutcomeResponse | undefined;
    try {
      postRes = await opts.client.postOutcome({
        skill_id: item.skill_id,
        kind: outcomeKind,
        reason: outcomeReason,
        duration_ms,
      });
    } catch (err) {
      // A failed POST doesn't change reality — the skill stays in the
      // queue for the next sweep. Log loud so ops notices the registry
      // is unreachable rather than silently no-op'ing.
      log(
        `WARN: postOutcome ${item.skill_id} failed (${err instanceof Error ? err.message : String(err)}) — ${item.service} stays in queue`,
      );
    }
    if (outcomeKind === "success") summary.succeeded += 1;
    else summary.failed += 1;
    const transition = postRes?.transition ?? "none";
    summary.transitions[transition] += 1;
    log(
      `replay end:   ${item.service} (skill_id=${item.skill_id}, outcome=${outcomeKind}, transition=${transition}, ${duration_ms}ms) — ${outcomeReason.slice(0, 120)}`,
    );
  }
  log(
    `batch done: attempted=${summary.attempted} ok=${summary.succeeded} fail=${summary.failed} ` +
      `promoted=${summary.transitions.promoted} retired=${summary.transitions.retired} ` +
      `demoted=${summary.transitions.demoted}`,
  );
  return summary;
}

export async function runVerifierLoop(opts: RunVerifierOpts): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(`[verifier] ${line}`));
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 12 * 60 * 60 * 1000;
  for (;;) {
    try {
      await runOneBatch(opts);
    } catch (err) {
      // A batch can fail end-to-end (registry unreachable, etc.). Log,
      // sleep, retry on the next interval — don't crash the worker.
      log(
        `ERROR: batch failed (${err instanceof Error ? err.message : String(err)}) — sleeping until next interval`,
      );
    }
    if (opts.once === true) return;
    log(`sleeping ${Math.round(intervalMs / 1000)}s until next batch…`);
    await sleep(intervalMs);
  }
}

function describeReplayOutcome(outcome: ReplayOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return `ok via=${outcome.via}; credential bytes verified`;
    case "ok_multi":
      return `ok_multi via=${Object.entries(outcome.via).map(([k, v]) => `${k}:${v}`).join(",")}`;
    case "dry_pass":
      return `dry_pass walked=${outcome.stepsWalked} step(s)`;
    case "step_failed":
      return `step_failed step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "validator_failed":
      return `validator_failed step=${outcome.stepIndex} got="${outcome.got.slice(0, 40)}" ${outcome.reason}`.slice(0, 800);
    case "extraction_failed":
      return `extraction_failed step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "needs_login":
      return `needs_login provider=${outcome.provider} step=${outcome.stepIndex}`;
    case "skill_demoted":
      return `skill_demoted ${outcome.reason}`;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
