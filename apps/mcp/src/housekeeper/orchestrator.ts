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
import { shouldEscalate, UNKNOWN_ESCALATION_THRESHOLD } from "@trusty-squire/skill-schema";
import { recordUnknownState, markEscalated } from "./unknown-state-store.js";
import type { VerifierRegistryClient } from "./registry-client.js";
import type { QueueProvider } from "./queues/index.js";
import type { Notifier, NotifierEvent } from "./notifier.js";
import type { CleanupOutcome } from "./cleanup.js";
import {
  handleReplay,
  type ReplayMode,
  type ReplayRunner,
  type SignupProbeRunner,
  type FreshVerifyRunner,
} from "./modes/verify.js";
import { RunPacer, pacingFromEnv } from "./pacing.js";
import { handleDiscover, type DiscoveryBotRunner } from "./modes/discover.js";
import { gradeLedgerAgainstPass, describeGrade } from "./fix-ledger.js";
import { VERSION } from "../version.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadIdentities, loadUsage } from "./identity-pool.js";

export type { ReplayMode, ReplayRunner, SignupProbeRunner, FreshVerifyRunner } from "./modes/verify.js";
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
  // Auto-probe-before-retire (modes/verify.ts). When wired, a replay
  // failure that would otherwise count toward demotion is first checked
  // against a live probe of the signup page: if the page still shows the
  // service's entry affordances, the failure is treated as brittleness
  // (non-demoting) rather than rot. Optional — unset leaves the existing
  // demote classification untouched.
  probe?: SignupProbeRunner;
  // Wired by the CLI to runDiscover. Same shape; required for
  // 'discover' tasks.
  discover?: DiscoveryBotRunner;
  // D2.D — fresh-identity verifier. When wired (heal mode, identity pool
  // configured), a 'replay' task for a skill with a fresh-identity path
  // (OAuth-based) routes through the bounded sequential-confidence sampler
  // (N independent fresh signups) INSTEAD of single-account replay. The sampler
  // reports its own verdict to the registry and returns the transition. Skills
  // with NO fresh-identity path (email-only, or when this hook is unwired) fall
  // back to single-account replay via handleReplay. See modes/fresh-verify.ts.
  freshVerify?: FreshVerifyRunner;
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
  // Per-service discovery outcomes (discover tasks only) — feeds the
  // fix-grading ledger so a later pass can check whether the services a fix
  // targeted now succeed (#1, fix-ledger.ts).
  serviceOutcomes: Array<{ service: string; succeeded: boolean }>;
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
    serviceOutcomes: [],
  };
  // Inter-run pacing for live (discover) signups — keeps a clean residential
  // exit clean (see pacing.ts). Replay tasks don't launch the bot, so they're
  // never paced or counted.
  const pacer = new RunPacer(pacingFromEnv(), { log });
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const isLiveSignup = task.kind !== "replay";

    if (isLiveSignup) {
      const cap = pacer.capRemaining();
      if (!cap.allowed) {
        const left = tasks.length - i;
        log(
          `[pace] daily signup cap reached (${cap.used}/${cap.cap}) — stopping batch ` +
            `to rest the IP; ${left} task(s) skipped.`,
        );
        summary.skipped += left;
        break;
      }
    }

    summary.attempted += 1;
    let pacingReason = "";
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
        pacingReason = outcome.reason ?? "";
        if (outcome.kind === "ok") summary.succeeded += 1;
        else if (outcome.kind === "blocked") summary.blocked += 1;
        else summary.failed += 1;
        // Per-service result for the fix-grading ledger (#1). A blocked wall is
        // not a "did the fix work" signal, so it's excluded; everything else
        // records succeeded = (ok), mirroring the aggregate counters above.
        if (outcome.kind !== "blocked") {
          summary.serviceOutcomes.push({ service: task.service, succeeded: outcome.kind === "ok" });
        }
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

        // THE single human-facing escalation. The discover_outcome above is
        // operational telemetry (status tracking); this is the ONE event that
        // asks a human to act, and it fires ONLY for an `unknown` provision
        // state — a DOM/outcome the classifier has never seen — after
        // UNKNOWN_ESCALATION_THRESHOLD attempts on the SAME (service,signature).
        // Walls auto-skip (blocked), transient/email/rate auto-retry (failed),
        // rot auto-demotes — none of them ever reach here.
        if (
          outcome.kind === "failed" &&
          outcome.state === "unknown" &&
          outcome.signature !== undefined
        ) {
          const rec = recordUnknownState({
            service: task.service,
            signature: outcome.signature,
            now: new Date().toISOString(),
          });
          if (!rec.alreadyEscalated && shouldEscalate("unknown", rec.attempts)) {
            await fanOutNotifier(notifiers, log, {
              kind: "unknown_state",
              service: task.service,
              failure_kind: outcome.reason,
              attempts: rec.attempts,
            });
            markEscalated(task.service, outcome.signature);
            log(`ESCALATE: unknown_state ${task.service} after ${rec.attempts} attempt(s)`);
          } else if (!rec.alreadyEscalated) {
            log(
              `unknown_state ${task.service} attempt ${rec.attempts}/${UNKNOWN_ESCALATION_THRESHOLD} — handling autonomously, not escalating yet`,
            );
          }
        }
      }
    } catch (err) {
      summary.failed += 1;
      pacingReason = err instanceof Error ? err.message : String(err);
      log(
        `task error (${task.kind}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Count the run + adaptively back off; cooldown only when another live
    // signup follows (no point sleeping after the last one).
    if (isLiveSignup) {
      pacer.recordRun(pacingReason);
      const moreLive = tasks.slice(i + 1).some((t) => t.kind !== "replay");
      if (moreLive) await pacer.cooldown();
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

// Auto-replenish the verify-robot pool during a heal pass so the loop runs for
// weeks without the operator manually rotating (the one thing that kept the
// "autonomous" loop from being autonomous — see HOUSEKEEPER-OPERATIONS.md). The
// robots are 2SV-OFF, so minting + warming is fully scriptable with NO 2FA and no
// human. Cost-FLAT: `rotate --make-room=N` is delete-before-create, so the active
// seat count never rises. Opt-IN (ROBOT_AUTO_REPLENISH=1) and gated on an
// unattended admin token existing — a no-op until the operator sets that up, so
// it's safe to ship default-off. Capped per pass (warming a robot is ~minutes)
// and best-effort: a replenish failure NEVER breaks the heal. Returns a digest
// fragment ("" when it did nothing).
async function autoReplenishVerifyPool(log: (l: string) => void): Promise<string> {
  if (!/^(1|true|on)$/i.test(process.env.ROBOT_AUTO_REPLENISH ?? "")) return "";
  const tsDir = join(homedir(), ".trusty-squire");
  if (!existsSync(join(tsDir, "admin-oauth.json")) && !existsSync(join(tsDir, "admin-sa.json"))) {
    log(
      "pool replenish: skipped — no unattended admin token " +
        "(~/.trusty-squire/admin-oauth.json). See HOUSEKEEPER-OPERATIONS.md.",
    );
    return "";
  }
  // A robot is "worn" once it's spent at >= this many distinct services (each
  // robot is one-shot per service). Retire the most-spent, mint fresh.
  const spentGe = Number(process.env.ROBOT_REPLENISH_SPENT_GE ?? 8);
  const maxPerPass = Number(process.env.ROBOT_REPLENISH_MAX_PER_PASS ?? 2);
  let worn = 0;
  try {
    const ids = loadIdentities();
    const usage = loadUsage();
    worn = ids.filter(
      (i) => new Set(usage.filter((u) => u.identityId === i.id).map((u) => u.service)).size >= spentGe,
    ).length;
  } catch (err) {
    log(`pool replenish: pool read failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
  if (worn === 0) return "";
  const n = Math.min(worn, maxPerPass);
  log(`pool replenish: ${worn} robot(s) spent at >=${spentGe} services — rotating ${n} (cost-flat, delete-before-create)`);
  const cwd = process.cwd();
  let fresh: string[] = [];
  try {
    const out = execFileSync("node", ["tools/provision-verify-robot.mjs", "rotate", `--make-room=${n}`], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
    });
    // Parse ONLY the "warm verify-NN" suggestions (the freshly-minted ids) — NOT
    // the "retire: verify-NN" line (those were just deleted).
    fresh = [...new Set([...out.matchAll(/warm (verify-\d+)/g)].map((m) => m[1] as string))];
  } catch (err) {
    log(`pool replenish: rotate failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
  let warmed = 0;
  for (const id of fresh) {
    try {
      execFileSync("node", ["tools/google-login-fleet.mjs", id], { cwd, encoding: "utf8", timeout: 240_000 });
      warmed += 1;
    } catch (err) {
      log(`pool replenish: warm ${id} failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`pool replenish: rotated ${n}, warmed ${warmed}/${fresh.length} fresh robot(s)`);
  return ` · pool +${warmed} fresh`;
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

  // Phase 3 (opt-in) — keep the verify-robot pool fresh so the loop runs
  // unattended for weeks. No-op unless ROBOT_AUTO_REPLENISH=1 + an admin token
  // exists; runs AFTER discover so the fresh robots are ready for the next pass.
  let poolLine = "";
  try {
    poolLine = await autoReplenishVerifyPool(log);
  } catch (err) {
    log(`pool replenish failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Close-the-loop (#1): grade open fix attempts whose targeted services were
  // re-tested in THIS pass's discovery. A fix committed by a prior --mode=fix
  // run is proven (or refuted) here — the feedback half of the output loop.
  const serviceSucceeded = new Map<string, boolean>();
  for (const o of discover.serviceOutcomes) serviceSucceeded.set(o.service, o.succeeded);
  let gradedLine = "";
  let fixesGraded = 0;
  let fixesImproved = 0;
  let fixesRegressed = 0;
  try {
    const graded = gradeLedgerAgainstPass(serviceSucceeded, new Date().toISOString());
    for (const g of graded) log(`fix grade: ${describeGrade(g)}`);
    fixesGraded = graded.length;
    fixesImproved = graded.filter((g) => g.grade === "improved").length;
    fixesRegressed = graded.filter((g) => g.grade === "regressed").length;
    if (fixesGraded > 0) {
      gradedLine = ` · fixes graded ${fixesGraded} (${fixesImproved}✓/${fixesRegressed}✗)`;
    }
    // #1 Part B — a regressed fix is the one output-loop outcome that warrants a
    // human look: the loop shipped an RC that did NOT fix its target (or hurt
    // it). Flag each loudly in the digest + log so the operator can revert that
    // RC; the dashboard Status zone surfaces the count too.
    if (fixesRegressed > 0) {
      gradedLine += ` ⚠ ${fixesRegressed} REGRESSED — review RC(s)`;
      for (const g of graded.filter((x) => x.grade === "regressed")) {
        log(`REGRESSED FIX: ${describeGrade(g)} — review/revert RC ${g.rc_version}`);
      }
    }
  } catch (err) {
    log(`fix grading failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // The digest: what rotted, what auto-healed, what still needs a human.
  const reskilled = discover.transitions.promoted;
  const needsHuman = verify.transitions.demoted + verify.transitions.quarantined - reskilled;
  // OF#2 — the raw discovery success rate this pass saw (succeeded / attempted).
  const discoverAttempted = discover.attempted;
  const discoverSucceeded = discover.succeeded;

  // Heartbeat the registry FIRST (before the digest) so the admin status
  // panel knows the timer is alive (T10) AND so we get back OF#1 — the
  // active-skill count, which the registry owns — to fold into the digest.
  // Fail-open: a missing method (test doubles) or a network blip must never
  // break the pass; we just omit OF#1 from the digest in that case.
  let skillsActive: number | undefined;
  let hitServed: number | undefined;
  let hitTotal: number | undefined;
  try {
    const c = opts.verify.client as {
      postHealHeartbeat?: (i: {
        verified: number;
        demoted: number;
        quarantined: number;
        reskilled: number;
        needs_human: number;
        discover_attempted: number;
        discover_succeeded: number;
        fixes_graded?: number;
        fixes_improved?: number;
        fixes_regressed?: number;
        mcp_version?: string;
      }) => Promise<{ skills_active: number; hit_served?: number; hit_total?: number }>;
    };
    if (typeof c.postHealHeartbeat === "function") {
      const res = await c.postHealHeartbeat({
        verified: verify.attempted,
        demoted: verify.transitions.demoted,
        quarantined: verify.transitions.quarantined,
        reskilled,
        needs_human: Math.max(0, needsHuman),
        discover_attempted: discoverAttempted,
        discover_succeeded: discoverSucceeded,
        // Output-loop (#1) fix grades from this pass — the dashboard trends them.
        fixes_graded: fixesGraded,
        fixes_improved: fixesImproved,
        fixes_regressed: fixesRegressed,
        // Stamp the RC the run executed (C5). Dogfooding `next` means each
        // HealRun records which release candidate produced its OF#2 — that's
        // the per-RC promote signal on the dashboard.
        mcp_version: VERSION,
      });
      if (res !== undefined && typeof res.skills_active === "number") {
        skillsActive = res.skills_active;
      }
      // OF#3 — the registry hit rate, server-stamped + echoed back for the digest.
      if (res !== undefined && typeof res.hit_total === "number") {
        hitServed = res.hit_served ?? 0;
        hitTotal = res.hit_total;
      }
    }
  } catch (err) {
    log(`heal heartbeat failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const discoverRate =
    discoverAttempted > 0
      ? ` · discover ${Math.round((100 * discoverSucceeded) / discoverAttempted)}% (${discoverSucceeded}/${discoverAttempted})`
      : "";
  const skillsLine = skillsActive !== undefined ? ` · skills ${skillsActive}` : "";
  const hitLine =
    hitTotal !== undefined && hitTotal > 0
      ? ` · hit ${Math.round((100 * (hitServed ?? 0)) / hitTotal)}% (${hitServed ?? 0}/${hitTotal})`
      : "";
  const digest =
    `verified ${verify.attempted} · demoted ${verify.transitions.demoted} · ` +
    `quarantined ${verify.transitions.quarantined} · re-skilled ${reskilled} · ` +
    `needs human ~${Math.max(0, needsHuman)}${discoverRate}${skillsLine}${hitLine}${gradedLine}${poolLine}`;
  log(`heal pass done: ${digest}`);
  await fanOutNotifier(opts.notifiers ?? [], log, {
    kind: "heal_digest",
    verified: verify.attempted,
    demoted: verify.transitions.demoted,
    quarantined: verify.transitions.quarantined,
    reskilled,
    needs_human: Math.max(0, needsHuman),
    summary: digest,
    objectives: {
      ...(skillsActive !== undefined ? { skills_active: skillsActive } : {}),
      discover_attempted: discoverAttempted,
      discover_succeeded: discoverSucceeded,
      ...(hitTotal !== undefined ? { hit_served: hitServed ?? 0, hit_total: hitTotal } : {}),
    },
  });

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
