// Housekeeper orchestrator — the run loop that merges the former
// verifier + discoverer + harvester tools. Mode-agnostic.
//
// One queue-agnostic loop. Pulls a batch of HousekeeperTasks from
// the configured QueueProvider, dispatches each on `task.kind` to the
// matching mode runner:
//
//   - replay   → modes/verify.ts: drive the captured skill against the
//                live page, post the outcome to the registry's verifier
//                endpoint (the old verifier worker's job)
//   - discover → modes/discover.ts: drive the universal bot at a service
//                slug, let auto-promote write any successful capture as a
//                pending-review skill (the old discoverer + harvester)
//
// Outcomes also fan out to any wired Notifier instances (telegram,
// github-issues) so the operator gets the same surfaces the harvester
// produced before the merge.

import type { Skill } from "@trusty-squire/skill-schema";
import type { VerifierRegistryClient } from "./registry-client.js";
import type { QueueProvider } from "./queues/index.js";
import type { Notifier, NotifierEvent } from "./notifier.js";
import type { CleanupOutcome } from "./cleanup.js";
import { handleReplay, type ReplayMode, type ReplayRunner } from "./modes/verify.js";
import { handleDiscover, type DiscoveryBotRunner } from "./modes/discover.js";

export type { ReplayMode, ReplayRunner } from "./modes/verify.js";
export type { DiscoveryBotRunner } from "./modes/discover.js";

export interface HousekeeperOpts {
  // Queue source (verifier / discovery / seed / ad-hoc).
  queue: QueueProvider;
  // Registry client — used for verifier-replay outcome posting AND
  // for fetching skill bodies. Discover-only runs still need it for
  // the queue provider (registry-backed providers) but skip it for
  // YAML / ad-hoc.
  client: VerifierRegistryClient;
  // Wired by the CLI to the real replaySkill + Playwright setup.
  // Optional — runs without a replay handler just won't process
  // 'replay' tasks (they're skipped with a log).
  replay?: ReplayRunner;
  // Wired by the CLI to runDiscover. Same shape; required for
  // 'discover' tasks.
  discover?: DiscoveryBotRunner;
  // Replay mode for the verifier path. Defaults to 'full'.
  replayMode?: ReplayMode;
  // Per-batch size cap.
  limit?: number;
  // Sleep injection (tests pass a no-op).
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  once?: boolean;
  log?: (line: string) => void;
  // Notifier fan-out. Each event flows to every notifier sequentially.
  // Failures from individual notifiers are swallowed + logged.
  notifiers?: Notifier[];
  // Token-cleanup hooks (Phase 4) — forwarded from the verifier path
  // when a replay produces a credential.
  cleanupFetchFn?: typeof globalThis.fetch;
  runDashboardCleanup?: (
    skill: Skill,
    steps: Skill["steps"],
  ) => Promise<CleanupOutcome>;
}

export interface HousekeeperBatchSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  blocked: number;
  skipped: number;
  // Verifier-only counters; discovery tasks roll into none.
  transitions: {
    promoted: number;
    retired: number;
    demoted: number;
    quarantined: number;
    none: number;
  };
}

export async function runOneBatch(opts: HousekeeperOpts): Promise<HousekeeperBatchSummary> {
  const log = opts.log ?? ((line: string) => console.log(`[housekeeper] ${line}`));
  const notifiers = opts.notifiers ?? [];
  const limit = opts.limit ?? 20;
  const tasks = await opts.queue.fetch(limit);
  log(`fetched queue (${opts.queue.name}): ${tasks.length} task(s)`);
  const summary: HousekeeperBatchSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    transitions: { promoted: 0, retired: 0, demoted: 0, quarantined: 0, none: 0 },
  };
  for (const task of tasks) {
    summary.attempted += 1;
    try {
      if (task.kind === "replay") {
        const outcome = await handleReplay(task, opts, log);
        if (outcome === "skipped") summary.skipped += 1;
        else if (outcome.outcome === "success") summary.succeeded += 1;
        else summary.failed += 1;
        summary.transitions[outcome === "skipped" ? "none" : outcome.transition] += 1;
        await fanOutNotifier(notifiers, log, {
          kind: "replay_outcome",
          queue: opts.queue.name,
          service: task.queueItem.service,
          skill_id: task.queueItem.skill_id,
          outcome: outcome === "skipped" ? "skipped" : outcome.outcome,
          transition: outcome === "skipped" ? "none" : outcome.transition,
          reason: outcome === "skipped" ? "schema drift — skipped" : outcome.reason,
        });
      } else {
        const outcome = await handleDiscover(task, opts, log);
        if (outcome.kind === "ok") summary.succeeded += 1;
        else if (outcome.kind === "blocked") summary.blocked += 1;
        else summary.failed += 1;
        // 0.8.2-rc.4 — credit `promoted` accurately. Pre-fix this
        // always bumped `none` even when auto-promote published a
        // skill to the registry, so the batch summary said
        // promoted=0 while skills WERE landing. Now an ok outcome
        // with a published or idempotent auto_promote result counts
        // as promoted; everything else stays in none.
        if (
          outcome.kind === "ok" &&
          outcome.auto_promote !== undefined &&
          (outcome.auto_promote.kind === "published" ||
            outcome.auto_promote.kind === "idempotent")
        ) {
          summary.transitions.promoted += 1;
        } else {
          summary.transitions.none += 1;
        }
        await fanOutNotifier(notifiers, log, {
          kind: "discover_outcome",
          queue: opts.queue.name,
          service: task.service,
          outcome: outcome.kind,
          reason: outcome.reason,
          ...(task.meta !== undefined ? { meta: task.meta } : {}),
        });
      }
    } catch (err) {
      summary.failed += 1;
      log(
        `task error (${task.kind}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  log(
    `batch done: attempted=${summary.attempted} ok=${summary.succeeded} ` +
      `fail=${summary.failed} blocked=${summary.blocked} skipped=${summary.skipped} ` +
      `promoted=${summary.transitions.promoted} retired=${summary.transitions.retired} ` +
      `demoted=${summary.transitions.demoted} quarantined=${summary.transitions.quarantined}`,
  );
  return summary;
}

// T7 — the self-healing pass. One scheduled run does verify THEN discover
// in sequence: verify demotes rotting skills (and quarantines walls);
// discover then re-skills the freshly-demoted services (T5 sourcing).
// Emits ONE digest notification so a sole operator gets an actionable
// line ("verified 12 · demoted 2 · re-skilled 1 · needs human: 3")
// instead of crawling panels. Takes both queues' opts; the discover opts
// reuse the same client/discover runner.
export interface HealPassOpts {
  verify: HousekeeperOpts; // queue.name === "verifier"
  discover: HousekeeperOpts; // queue.name === "discovery" (telemetry candidates)
  notifiers?: Notifier[];
  log?: (line: string) => void;
}

export async function runHealPass(opts: HealPassOpts): Promise<{
  verify: HousekeeperBatchSummary;
  discover: HousekeeperBatchSummary;
}> {
  const log = opts.log ?? ((line: string) => console.log(`[housekeeper] ${line}`));
  log("heal pass — phase 1/2: verify (demote rot, quarantine walls)");
  const verify = await runOneBatch(opts.verify);
  log("heal pass — phase 2/2: discover (re-skill freshly-demoted + demand)");
  const discover = await runOneBatch(opts.discover);

  // The digest: what rotted, what auto-healed, what still needs a human.
  const reskilled = discover.transitions.promoted;
  const needsHuman = verify.transitions.demoted + verify.transitions.quarantined - reskilled;
  const digest =
    `verified ${verify.attempted} · demoted ${verify.transitions.demoted} · ` +
    `quarantined ${verify.transitions.quarantined} · re-skilled ${reskilled} · ` +
    `needs human ~${Math.max(0, needsHuman)}`;
  log(`heal pass done: ${digest}`);
  await fanOutNotifier(opts.notifiers ?? [], log, {
    kind: "heal_digest",
    verified: verify.attempted,
    demoted: verify.transitions.demoted,
    quarantined: verify.transitions.quarantined,
    reskilled,
    needs_human: Math.max(0, needsHuman),
    summary: digest,
  });

  // Heartbeat the registry so the admin status panel knows the timer is
  // alive (T10). Fail-open: a missing method (test doubles) or a network
  // blip must never break the pass.
  try {
    const c = opts.verify.client as {
      postHealHeartbeat?: (i: {
        verified: number;
        demoted: number;
        quarantined: number;
        reskilled: number;
        needs_human: number;
      }) => Promise<void>;
    };
    if (typeof c.postHealHeartbeat === "function") {
      await c.postHealHeartbeat({
        verified: verify.attempted,
        demoted: verify.transitions.demoted,
        quarantined: verify.transitions.quarantined,
        reskilled,
        needs_human: Math.max(0, needsHuman),
      });
    }
  } catch (err) {
    log(`heal heartbeat failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { verify, discover };
}

export async function runHealLoop(opts: HealPassOpts & {
  once?: boolean;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(`[housekeeper] ${line}`));
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 12 * 60 * 60 * 1000;
  for (;;) {
    try {
      await runHealPass(opts);
    } catch (err) {
      log(`ERROR: heal pass failed (${err instanceof Error ? err.message : String(err)}) — sleeping`);
    }
    if (opts.once === true) return;
    log(`sleeping ${Math.round(intervalMs / 1000)}s until next heal pass…`);
    await sleep(intervalMs);
  }
}

export async function runHousekeeperLoop(opts: HousekeeperOpts): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(`[housekeeper] ${line}`));
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 12 * 60 * 60 * 1000;
  for (;;) {
    try {
      await runOneBatch(opts);
    } catch (err) {
      log(
        `ERROR: batch failed (${err instanceof Error ? err.message : String(err)}) — sleeping`,
      );
    }
    if (opts.once === true) return;
    log(`sleeping ${Math.round(intervalMs / 1000)}s until next batch…`);
    await sleep(intervalMs);
  }
}

// ── Notifier fan-out ───────────────────────────────────────────────

async function fanOutNotifier(
  notifiers: readonly Notifier[],
  log: (line: string) => void,
  event: NotifierEvent,
): Promise<void> {
  for (const n of notifiers) {
    try {
      await n.notify(event);
    } catch (err) {
      log(
        `notifier ${n.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
