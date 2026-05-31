// Verify mode — the closed-loop verifier (formerly the verifier
// worker). Drives a captured skill against its live page via skill
// replay, runs token cleanup on success, and posts the outcome to the
// registry's verifier endpoint. The outcome drives promote / retire /
// demote transitions.
//
// Two pieces live here:
//   - createReplayRunner: the factory that builds the ReplayRunner the
//     orchestrator calls per task. Owns the BrowserController lifecycle
//     and the verifier-only template-value synthesis.
//   - handleReplay: the per-task dispatcher the orchestrator invokes
//     for 'replay' tasks (fetch skill → replay → cleanup → postOutcome).

import type { Skill } from "@trusty-squire/skill-schema";
import { BrowserController } from "../../bot/browser.js";
import { replaySkill, type ReplayOutcome } from "../../bot/replay-skill.js";
import {
  SkillSchemaDriftError,
  type VerifierOutcomeResponse,
} from "../registry-client.js";
import type { HousekeeperTask } from "../queues/index.js";
import { runCleanup } from "../cleanup.js";
import type { HousekeeperOpts } from "../orchestrator.js";

// Replay mode applies to the verifier path. 'full' actually
// generates a credential (proves the path still produces one);
// 'dry' walks selectors without firing the credential-creating
// click — useful for services that can't safely re-issue tokens.
export type ReplayMode = "dry" | "full";

export type ReplayRunner = (input: {
  skill: Skill;
  mode: ReplayMode;
  // 0.8.2-rc.19 — verifier-queue replays target pending-review (and
  // sometimes demoted) skills by design — that's the whole point of
  // the verifier loop, to gather replay outcomes that drive promote/
  // demote transitions. The router's "active-only" guard inside
  // replaySkill() blocks these by default. Set true on the verifier
  // path to bypass that guard. Always false (default) on the router
  // path, where a non-active skill must never be replayed.
  bypassStatusGuard?: boolean;
}) => Promise<ReplayOutcome>;

export type ReplayResult =
  | "skipped" // schema drift; task left in queue for next worker rev
  | {
      outcome: "success" | "failure";
      reason: string;
      transition: VerifierOutcomeResponse["transition"];
    };

// Build the ReplayRunner the CLI wires into HousekeeperOpts.replay.
//
// 0.8.3 — dropped the eager pickLLMClient() preflight that used to
// live in cli.ts. The verifier path doesn't pass an LLM into
// replaySkill (the replay engine only calls LLM via llmFallback,
// which we don't wire here), so the preflight was forcing every
// verifier-only run to require a machine token / OPENROUTER_API_KEY /
// ANTHROPIC_API_KEY for no actual reason. The discover path still
// calls pickLLMClient indirectly via runDiscover — that's where a
// missing LLM should fail loud.
export function createReplayRunner(): ReplayRunner {
  return async (input: {
    skill: Skill;
    mode: "dry" | "full";
    bypassStatusGuard?: boolean;
  }): Promise<ReplayOutcome> => {
    const browser = new BrowserController({});
    try {
      await browser.start();
      // 0.8.2-rc.22 — synthesize template values for verifier replays.
      // The provision path supplies these (TOKEN_NAME, EMAIL_ALIAS)
      // from the live signup context; the verifier has no such
      // context — without defaults, substituteTemplate leaves
      // `${TOKEN_NAME}` literal and services like Railway reject the
      // invalid name silently, leaving the post-Create form unchanged
      // and the credential-extract step thinking "no Copy button on
      // page."
      //
      // 0.8.3 — the previous `verifier-${tag}-${ts}` pattern produced
      // 24-char alphanumeric+dash strings that LOOK credential-shaped
      // to the post-Create extract step. On services that render the
      // token name in the listing alongside a masked key, the
      // validator-blind extract tier picked up the NAME instead of
      // the key, and the resulting capture poisoned the next
      // synthesizer run with a fake "credential" that was actually
      // the bot's own input.
      //
      // 0.8.3-rc.1 — earlier sub-revision swapped dashes for DOTS to
      // make the names un-credential-like (`if (cand.includes("."))
      // continue` in the validator-blind tier). That worked for
      // self-poisoning but broke services with strict name validators
      // — Baseten's API-key form rejects dotted names and leaves the
      // submit button disabled, so every replay step_failed at the
      // submit click. Replacement uses dash-separated DIGIT-FREE
      // names instead: the validator-blind tier requires a digit
      // (`if (!/\d/.test(cand)) continue;`), so removing all digits
      // from our synthesized values keeps self-poisoning protection
      // intact while staying compatible with strict alphanumeric-
      // plus-dash validators. Each base36 digit gets remapped to a
      // letter (0→a, 1→b, …, 9→j) so uniqueness is preserved.
      const digitFree = (s: string): string =>
        s.replace(/[0-9]/g, (d) =>
          String.fromCharCode(97 + parseInt(d, 10)),
        );
      const verifierTag = digitFree(input.skill.skill_id.slice(-6).toLowerCase());
      const tsTag = digitFree(Date.now().toString(36));
      return await replaySkill({
        skill: input.skill,
        browser,
        mode: input.mode,
        templateValues: {
          TOKEN_NAME: `verifier-${verifierTag}-${tsTag}`,
          EMAIL_ALIAS: `verifier-${verifierTag}-${tsTag}@trustysquire.com`,
          USER_DISPLAY_NAME: `Verifier-${verifierTag}`,
        },
        ...(input.bypassStatusGuard === true ? { bypassStatusGuard: true } : {}),
      });
    } finally {
      try {
        await browser.close();
      } catch {
        // shutdown noise — replay outcome is already captured
      }
    }
  };
}

export async function handleReplay(
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
    const replay = await opts.replay({
      skill,
      mode: opts.replayMode ?? "full",
      // Verifier mode is the one place a non-active skill IS a valid
      // replay target. Pending-review skills need replay outcomes to
      // get promoted to active in the first place — the chicken-and-
      // egg the router-side guard would otherwise create.
      bypassStatusGuard: opts.queue.name === "verifier",
    });
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
