// Housekeeper loop — the merged verifier + discoverer + harvester.
//
// One queue-agnostic loop. Pulls a batch of HousekeeperTasks from
// the configured QueueProvider, dispatches each on `task.kind`:
//
//   - replay   → drive the captured skill against the live page,
//                post the outcome to the registry's verifier endpoint
//                (the old verifier worker's job)
//   - discover → drive the universal bot at a service slug, let
//                auto-promote write any successful capture as a
//                pending-review skill (the old discoverer + harvester)
//
// Outcomes also fan out to any wired Notifier instances (telegram,
// github-issues) so the operator gets the same surfaces the harvester
// produced before the merge.

import type { Skill } from "@trusty-squire/adapter-sdk";
import {
  SkillSchemaDriftError,
  type VerifierRegistryClient,
  type VerifierOutcomeResponse,
} from "./registry-client.js";
import type { ReplayOutcome } from "../bot/replay-skill.js";
import type { QueueProvider, HousekeeperTask } from "./queue.js";
import type { Notifier, NotifierEvent } from "./notifier.js";
import type { DiscoveryBotOutcome } from "./discovery-bot.js";
import { runCleanup, type CleanupOutcome } from "./cleanup.js";

// Replay mode applies to the verifier path. 'full' actually
// generates a credential (proves the path still produces one);
// 'dry' walks selectors without firing the credential-creating
// click — useful for services that can't safely re-issue tokens.
export type ReplayMode = "dry" | "full";

export type ReplayRunner = (input: {
  skill: Skill;
  mode: ReplayMode;
}) => Promise<ReplayOutcome>;

export type DiscoveryBotRunner = (input: {
  service: string;
  oauthProvider?: "google" | "github";
}) => Promise<DiscoveryBotOutcome>;

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
  // Wired by the CLI to runDiscoveryBot. Same shape; required for
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
    transitions: { promoted: 0, retired: 0, demoted: 0, none: 0 },
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
        summary.transitions.none += 1;
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
      `demoted=${summary.transitions.demoted}`,
  );
  return summary;
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

// ── Replay path — closed-loop verifier ─────────────────────────────

type ReplayResult =
  | "skipped" // schema drift; task left in queue for next worker rev
  | {
      outcome: "success" | "failure";
      reason: string;
      transition: VerifierOutcomeResponse["transition"];
    };

async function handleReplay(
  task: Extract<HousekeeperTask, { kind: "replay" }>,
  opts: HousekeeperOpts,
  log: (line: string) => void,
): Promise<ReplayResult> {
  if (opts.replay === undefined) {
    log(
      `skip replay: ${task.queueItem.service} — no replay runner wired (queue=${opts.queue.name})`,
    );
    return "skipped";
  }
  const item = task.queueItem;
  const startMs = Date.now();
  let skill: Skill;
  try {
    log(
      `replay start: ${item.service} (skill_id=${item.skill_id}, status=${item.status})`,
    );
    skill = await opts.client.fetchSkill(item.skill_id);
  } catch (err) {
    if (err instanceof SkillSchemaDriftError) {
      log(
        `SKIP: ${item.service} (skill_id=${item.skill_id}) — ${err.message} — leaving in queue for next worker rev`,
      );
      return "skipped";
    }
    // Network/HTTP error — post a failure (the skill stays in queue;
    // three consecutive errors retire it, operator notices before
    // that).
    const reason = `fetch_error: ${err instanceof Error ? err.message : String(err)}`;
    let transition: VerifierOutcomeResponse["transition"] = "none";
    try {
      const res = await opts.client.postOutcome({
        skill_id: item.skill_id,
        kind: "failure",
        reason,
        duration_ms: Date.now() - startMs,
      });
      transition = res.transition;
    } catch {
      // Registry both-way unreachable; counters consistent.
    }
    log(`fetch error: ${item.service} — ${reason}`);
    return { outcome: "failure", reason, transition };
  }

  let outcomeKind: "success" | "failure" = "failure";
  let outcomeReason = "uncaught";
  try {
    const replay = await opts.replay({ skill, mode: opts.replayMode ?? "full" });
    const isOk =
      replay.kind === "ok" || replay.kind === "ok_multi" || replay.kind === "dry_pass";
    outcomeKind = isOk ? "success" : "failure";
    outcomeReason = describeReplayOutcome(replay);

    if (isOk && replay.kind === "ok") {
      const cleanup = await runCleanup({
        skill,
        credential: replay.credential,
        ...(opts.cleanupFetchFn !== undefined ? { fetchFn: opts.cleanupFetchFn } : {}),
        ...(opts.runDashboardCleanup !== undefined
          ? {
              runDashboardCleanup: (steps) => opts.runDashboardCleanup!(skill, steps),
            }
          : {}),
      });
      if (cleanup.kind === "failed") {
        outcomeReason += ` | cleanup_failed(${cleanup.strategy}): ${cleanup.reason}`.slice(
          0,
          800,
        );
      } else if (cleanup.kind === "ok") {
        outcomeReason += ` | cleanup_ok(${cleanup.strategy})`;
      }
    }
  } catch (err) {
    outcomeKind = "failure";
    outcomeReason = `verifier_error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const duration_ms = Date.now() - startMs;
  let transition: VerifierOutcomeResponse["transition"] = "none";
  try {
    const res = await opts.client.postOutcome({
      skill_id: item.skill_id,
      kind: outcomeKind,
      reason: outcomeReason,
      duration_ms,
    });
    transition = res.transition;
  } catch (err) {
    log(
      `WARN: postOutcome ${item.skill_id} failed (${err instanceof Error ? err.message : String(err)}) — ${item.service} stays in queue`,
    );
  }
  log(
    `replay end:   ${item.service} (skill_id=${item.skill_id}, outcome=${outcomeKind}, transition=${transition}, ${duration_ms}ms) — ${outcomeReason.slice(0, 120)}`,
  );
  return { outcome: outcomeKind, reason: outcomeReason, transition };
}

// ── Discover path — discoverer + harvester ─────────────────────────

async function handleDiscover(
  task: Extract<HousekeeperTask, { kind: "discover" }>,
  opts: HousekeeperOpts,
  log: (line: string) => void,
): Promise<DiscoveryBotOutcome> {
  if (opts.discover === undefined) {
    log(`skip discover: ${task.service} — no discover runner wired`);
    return { kind: "failed", reason: "no_discover_runner_wired" };
  }
  log(
    `discover start: ${task.service}${
      task.meta?.distinct_failures !== undefined
        ? ` (${task.meta.distinct_failures} user failures, top=${task.meta.top_error_kind})`
        : ""
    }`,
  );
  const outcome = await opts.discover({
    service: task.service,
    ...(task.oauthProvider !== undefined
      ? { oauthProvider: task.oauthProvider }
      : {}),
  });
  log(`discover end:   ${task.service} → ${outcome.kind} (${outcome.reason.slice(0, 120)})`);
  return outcome;
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

function describeReplayOutcome(outcome: ReplayOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return `ok via=${outcome.via}; credential bytes verified`;
    case "ok_multi":
      return `ok_multi via=${Object.entries(outcome.via)
        .map(([k, v]) => `${k}:${v}`)
        .join(",")}`;
    case "dry_pass":
      return `dry_pass walked=${outcome.stepsWalked} step(s)`;
    case "step_failed":
      return `step_failed step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "validator_failed":
      return `validator_failed step=${outcome.stepIndex} got="${outcome.got.slice(0, 40)}" ${outcome.reason}`.slice(
        0,
        800,
      );
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
