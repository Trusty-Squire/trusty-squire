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

import {
  type Skill,
  isNavNetworkFailure,
  NAV_TIMEOUT_KIND,
  isReturningUserDivergence,
  ACCOUNT_EXISTS_KIND,
  failureCountsTowardDemotion,
} from "@trusty-squire/skill-schema";
import {
  probeShowsServable,
  BRITTLE_PROBE_KIND,
} from "../probe-demotion-guard.js";
import { BrowserController } from "../../bot/browser.js";
import {
  probeAffordances,
  type PageAffordances,
} from "../../bot/affordance-probe.js";
import { replaySkill, type ReplayOutcome } from "../../bot/replay-skill.js";
import { InboxClient } from "../../bot/inbox-client.js";
import { makeEmailCodeFetcher } from "../../bot/email-code-fetcher.js";
import {
  SkillSchemaDriftError,
  type VerifierOutcomeResponse,
} from "../registry-client.js";
import type { HousekeeperTask } from "../queues/index.js";
import { runCleanup } from "../cleanup.js";
import type { HousekeeperOpts } from "../orchestrator.js";
import type { RunFreshVerifyResult } from "./fresh-verify.js";

// D2.D — the fresh-identity verifier hook. Wired by the CLI in heal mode when an
// identity pool is configured. Returns the sampler result + the registry
// transition it reported. Shaped as a function so the orchestrator stays
// decoupled from the bot/inbox wiring runFreshVerify needs.
export type FreshVerifyRunner = (input: {
  service: string;
  skillId: string;
  signupUrl?: string;
  oauthProvider?: "google" | "github";
}) => Promise<RunFreshVerifyResult>;

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

// Auto-probe-before-retire hook. Loads the skill's signup page in a fresh
// browser and reports its affordances, so the verifier can tell a brittle
// replay failure (page still servable) from genuine skill rot before letting
// a rot failure advance the demote counter. Owns its own BrowserController
// lifecycle (handleReplay holds no browser handle — the replay runner already
// opened and closed one). Injectable so the downgrade logic is unit-testable
// without a browser.
export type SignupProbeRunner = (input: {
  url: string;
}) => Promise<PageAffordances>;

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

      // Inbox wiring for `await_email_code` skills (zilliz/deepseek-class
      // email-OTP signups). The replay engine has no inbox transport; when a
      // machine token is available (the housekeeper box has one) we build a
      // REAL catch-all alias and a code poller. EMAIL_ALIAS then receives
      // mail and fetchEmailCode reads the code off it. Without a token, the
      // static alias stays and any await_email_code step fails cleanly —
      // non-OTP skills (the majority) replay exactly as before.
      const machineToken = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
      const apiBase =
        process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
      let emailAlias = `verifier-${verifierTag}-${tsTag}@trustysquire.com`;
      let fetchEmailCode:
        | ((i: { alias: string }) => Promise<string | null>)
        | undefined;
      if (machineToken !== undefined && machineToken.length > 0) {
        const inbox = new InboxClient({ baseUrl: apiBase, apiKey: machineToken });
        const accountId = process.env.TRUSTY_SQUIRE_ACCOUNT_ID ?? "verifier";
        try {
          emailAlias = await inbox.createAlias({
            account_id: accountId,
            service: input.skill.service,
            run_id: `vfy-${verifierTag}-${tsTag}`.slice(0, 26),
          });
        } catch {
          // Alias creation failed (no inbox service / network): keep the
          // static alias. await_email_code skills then fail at that step.
        }
        fetchEmailCode = makeEmailCodeFetcher(inbox);
      }

      return await replaySkill({
        skill: input.skill,
        browser,
        mode: input.mode,
        templateValues: {
          TOKEN_NAME: `verifier-${verifierTag}-${tsTag}`,
          EMAIL_ALIAS: emailAlias,
          USER_DISPLAY_NAME: `Verifier-${verifierTag}`,
        },
        ...(fetchEmailCode !== undefined ? { fetchEmailCode } : {}),
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

// Build the SignupProbeRunner the CLI wires into HousekeeperOpts.probe.
// A separate browser from the replay runner's — the replay browser is
// already torn down by the time the probe is needed, and a probe must
// load the page fresh (no replay-mutated state, no logged-in session
// from an OAuth step).
export function createProbeRunner(): SignupProbeRunner {
  return async (input: { url: string }): Promise<PageAffordances> => {
    const browser = new BrowserController({});
    try {
      await browser.start();
      return await probeAffordances(browser, input.url);
    } finally {
      try {
        await browser.close();
      } catch {
        // shutdown noise — the affordance read is already captured
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
        // A registry/network error is NOT the skill's fault — classifies
        // as transient, so it must not advance the demote counter (T4).
        failure_kind: "fetch_error",
        duration_ms: Date.now() - startMs,
      });
      transition = res.transition;
    } catch {
      // Registry both-way unreachable; counters consistent.
    }
    log(`fetch error: ${item.service} — ${reason}`);
    return { outcome: "failure", reason, transition };
  }

  // D2.D — prefer the fresh-identity confidence sampler over single-account
  // replay when the heal pass wired it AND this skill has a fresh-identity path.
  // v1 fresh-verify scope is pure-OAuth (the robots are Cloud Identity Free with
  // no mailbox), so we route only OAuth-based skills here; email-only skills and
  // unwired runs fall through to single-account replay below. This is the
  // promotion trust signal: "the lower-confidence-bound pass-rate over N
  // independent fresh signups is high", not "replayed once as a returning user".
  if (opts.freshVerify !== undefined && skill.oauth_provider !== null) {
    const fresh = await runFreshIdentityVerify(task, skill, opts, log, startMs);
    if (fresh !== "fallback") return fresh;
    // "fallback" → the fresh path couldn't run (no pool / pool exhausted);
    // fall through to single-account replay so the skill still gets verified.
  }

  let outcomeKind: "success" | "failure" = "failure";
  let outcomeReason = "uncaught";
  // Structured failure kind for the demotion classifier (T4). The replay
  // outcome's discriminant (step_failed / validator_failed /
  // extraction_failed / needs_login / …) IS the kind; only step/validator/
  // extraction classify as rot and count toward demotion.
  let failureKind: string | undefined = "uncaught";
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
    failureKind = isOk ? undefined : replay.kind;
    outcomeReason = describeReplayOutcome(replay);

    // A page-never-loaded failure (proxy blip / cold tunnel / DNS / TLS /
    // connection reset) surfaces as step_failed — the same rot kind as a
    // genuinely stale selector — but it is NOT skill rot. Downgrade it to a
    // transient kind so the registry records the stat WITHOUT advancing the
    // 3-strike demote counter. Without this, one tunnel hiccup retires a
    // pending-review skill sitting at 2 strikes (MEASURED: render, 2026-06-06).
    if (!isOk && isNavNetworkFailure(outcomeReason)) {
      failureKind = NAV_TIMEOUT_KIND;
    }

    // A signup-with-onboarding recipe replayed against the already-registered
    // operator account diverges from its fresh-signup capture: the onboarding
    // fill is absent (skipped) and the credential step then false-fails
    // step_failed. We can't tell that from genuine rot with a reused account,
    // so downgrade it to a transient kind that records the stat WITHOUT
    // advancing the 3-strike demote counter. The skill still works for a real
    // fresh user; a fresh-account discover run is the only true re-verification.
    if (!isOk && isReturningUserDivergence(outcomeReason)) {
      failureKind = ACCOUNT_EXISTS_KIND;
    }

    // Auto-probe-before-retire. A failure that WOULD still count toward
    // demotion at this point (a rot kind the two guards above didn't already
    // downgrade) might be replay brittleness against a still-servable service,
    // not genuine rot — the fly.io bug (2026-06-13): a brittle text_match
    // retired a working skill. Probe the live signup page; if it clearly shows
    // the service's entry affordances (an OAuth provider or an email-signup
    // form, no anti-bot interstitial), the failure is brittleness — downgrade
    // it to the non-demoting BRITTLE_PROBE_KIND and flag it for re-synthesis
    // instead of retiring it. Conservative: only DOWNGRADE on a clear positive;
    // a probe error or an empty/ambiguous page leaves the rot classification
    // intact.
    if (
      !isOk &&
      opts.probe !== undefined &&
      failureCountsTowardDemotion(failureKind)
    ) {
      const downgrade = await tryBrittleProbeDowngrade({
        probe: opts.probe,
        signupUrl: skill.signup_url,
        log,
        service: item.service,
      });
      if (downgrade !== null) {
        failureKind = BRITTLE_PROBE_KIND;
        outcomeReason =
          `${outcomeReason} | [brittle: probe shows servable] ${downgrade}`.slice(
            0,
            800,
          );
      }
    }

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
    failureKind = "verifier_error";
    outcomeReason = `verifier_error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const duration_ms = Date.now() - startMs;
  let transition: VerifierOutcomeResponse["transition"] = "none";
  try {
    const res = await opts.client.postOutcome({
      skill_id: item.skill_id,
      kind: outcomeKind,
      reason: outcomeReason,
      ...(failureKind !== undefined ? { failure_kind: failureKind } : {}),
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

// Run the auto-probe-before-retire check. Returns a short human summary of
// the probe result when it CLEARLY shows the page is still servable (the
// caller then downgrades the failure to non-demoting), or null otherwise — a
// probe error, an ambiguous/empty page, or a page that itself explains a wall.
// Null always means "leave the rot classification intact" (never upgrades).
async function tryBrittleProbeDowngrade(args: {
  probe: SignupProbeRunner;
  signupUrl: string;
  service: string;
  log: (line: string) => void;
}): Promise<string | null> {
  const { probe, signupUrl, service, log } = args;
  let affordances: PageAffordances;
  try {
    affordances = await probe({ url: signupUrl });
  } catch (err) {
    // Probe failed (nav/network/launch) — we learned nothing, so don't touch
    // the demoting classification. A wall/rot here is indistinguishable from
    // a transient probe blip, and the safe default is the original kind.
    log(
      `brittle-probe error: ${service} — ${err instanceof Error ? err.message : String(err)} — leaving rot classification intact`,
    );
    return null;
  }
  if (!probeShowsServable(affordances)) return null;
  const summary =
    `providers=[${affordances.providers.join(",") || "none"}] ` +
    `email=${affordances.has_email_signup} card=${affordances.card_gate} ` +
    `interstitial=${affordances.interstitial} url=${affordances.final_url}`;
  log(
    `brittle-probe: ${service} — replay failed but signup page still servable (${summary}) — downgrading, flagged for re-synthesis`,
  );
  return summary;
}

// D2.D — drive a 'replay' task through the fresh-identity confidence sampler.
// Returns a ReplayResult mapped from the sampler verdict, or the sentinel
// "fallback" when the fresh path can't run (no identity pool, pool exhausted,
// not configured) so handleReplay continues to single-account replay. The
// sampler reports its OWN outcome to the registry (carrying the verdict +
// posterior) — runFreshVerify hands back the transition the registry returned,
// which we surface in the batch summary.
async function runFreshIdentityVerify(
  task: Extract<HousekeeperTask, { kind: "replay" }>,
  skill: Skill,
  opts: HousekeeperOpts,
  log: (line: string) => void,
  startMs: number,
): Promise<ReplayResult | "fallback"> {
  const item = task.queueItem;
  const provider = skill.oauth_provider; // non-null per the caller's guard
  log(`fresh-verify start: ${item.service} (skill_id=${item.skill_id}, oauth=${provider})`);
  let fresh: RunFreshVerifyResult;
  try {
    fresh = await opts.freshVerify!({
      service: item.service,
      skillId: item.skill_id,
      ...(skill.signup_url.length > 0 ? { signupUrl: skill.signup_url } : {}),
      ...(provider !== null ? { oauthProvider: provider } : {}),
    });
  } catch (err) {
    // A crash in the fresh path is not a skill verdict — fall back to replay.
    log(
      `fresh-verify error: ${item.service} — ${err instanceof Error ? err.message : String(err)} — falling back to single-account replay`,
    );
    return "fallback";
  }

  if (fresh.kind === "not_configured") {
    log(`fresh-verify: ${item.service} — no identity pool; falling back to single-account replay`);
    return "fallback";
  }
  if (fresh.kind === "insufficient_identities") {
    log(
      `fresh-verify: ${item.service} — pool exhausted (${fresh.available ?? 0} unspent); falling back to single-account replay`,
    );
    return "fallback";
  }

  // A converged verdict. runFreshVerify already posted it to the registry (when
  // a skillId + admin bearer were present) and handed back the transition. A
  // `hold` is a deliberate no-op — surface it as a skipped task so the batch
  // doesn't count it as a pass or a fail.
  const duration_ms = Date.now() - startMs;
  const reason =
    `fresh-verify ${fresh.verdict} (${fresh.successes}✓/${fresh.failures}✗, ` +
    `LCB ${fresh.passRateLcb.toFixed(2)}/UCB ${fresh.passRateUcb.toFixed(2)}, ` +
    `${fresh.samples} sample(s), ${duration_ms}ms)`;
  log(`fresh-verify end:   ${item.service} — ${reason} → transition=${fresh.transition ?? "none"}`);
  if (fresh.verdict === "hold") return "skipped";
  return {
    outcome: fresh.verdict === "promote" ? "success" : "failure",
    reason,
    transition: fresh.transition ?? "none",
  };
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
