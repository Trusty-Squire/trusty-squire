// fresh-verify.ts — verify a service by FRESH-signing-up as N independent robot
// identities and driving the verdict off a BOUNDED SEQUENTIAL-CONFIDENCE
// SAMPLER, instead of a fixed 2-of-N count. Each picked identity is a distinct
// Cloud Identity Free Google robot with its own profile + egress, so every run
// is a genuine fresh signup matching the recorded recipe's context.
//
// Why a confidence sampler and not a count (D2):
//   The old `meetsAgreement` returned `successes >= agreement`. That makes 2/2
//   (100% observed pass-rate) and 2/4 (50%) report the IDENTICAL verdict
//   (promoted=true) — a count, not a confidence estimate. "Promoted" should mean
//   "the lower-confidence-bound on the pass-rate is high", not "passed once".
//   We model pass-rate as a Beta posterior over informative attempts and stop as
//   soon as the 95% Wilson interval clears a promote floor or a reject ceiling,
//   or HOLD honestly when the budget/pool runs out before convergence.
//
// The single unifying rule (D2.B): classifiers become PRIORS / NON-OBSERVATIONS.
// Each attempt maps to exactly one of:
//   - INFORMATIVE-SUCCESS  → genuine credential; updates the posterior (α+1)
//   - INFORMATIVE-FAILURE  → genuine rot; updates the posterior (β+1)
//   - NON-OBSERVATION      → transient/nav/onboarding flake; DROPPED, draw again
//   - HARD-WALL            → deterministic across identities; immediate reject
// This is the one rule that subsumes both the old "retryBudget refuses to count
// a flake" and the taxonomy's "transient never demotes": a flake is simply not
// an observation about the recipe's pass-rate.
//
// The signup itself is INJECTED (`runSignup`) so this module is pure-logic +
// testable; the housekeeper provides the closure that drives UniversalSignupBot
// through the identity's profile/proxy.

import {
  acquireIdentityLease,
  pickUnspentIdentities,
  releaseIdentity,
  type IdentityProvider,
  type UsageRecord,
  type VerifyIdentity,
} from "./identity-pool.js";

export interface FreshVerifyOutcome {
  identityId: string;
  success: boolean;
  credential?: string;
  reason?: string;
  // How this attempt was mapped into the sampler (D2.B). `non_observation`
  // attempts were DROPPED (a flake) and did not move the posterior; the rest
  // are informative or the terminal hard wall.
  observation: AttemptObservation;
}

// The bounded sampler's verdict over the recipe's pass-rate.
export type ConfidenceVerdict = "promote" | "reject" | "sample_more" | "hold";

export interface FreshVerifyResult {
  kind: "verified" | "insufficient_identities";
  service: string;
  // The converged producer verdict the registry trusts (D2.C). `promote` /
  // `reject` / `hold` — never `sample_more` (that's an internal loop state).
  verdict: Exclude<ConfidenceVerdict, "sample_more">;
  // Kept for log/back-compat readability: promote ⇔ verdict === "promote".
  promoted: boolean;
  // The posterior at the point the loop stopped.
  successes: number;
  failures: number;
  samples: number; // informative attempts (successes + failures)
  passRateLcb: number;
  passRateUcb: number;
  // The failure kind that drove a reject/hold, when there was one (the most
  // recent informative-failure or hard-wall reason's leading code). Carried to
  // the registry so a 0/N fresh failure demotes instead of defaulting transient.
  failureKind?: string;
  available?: number; // set on insufficient_identities
  outcomes: FreshVerifyOutcome[];
}

// ── D2.A: the bounded sequential-confidence sampler ──────────────────────────

export type AttemptObservation =
  | "informative_success"
  | "informative_failure"
  | "non_observation"
  | "hard_wall";

export interface ConfidenceOpts {
  // PROMOTE once the 95% lower bound on pass-rate exceeds this.
  promoteFloor: number;
  // REJECT once the 95% upper bound on pass-rate falls below this.
  rejectCeiling: number;
  // Hard cap on INFORMATIVE samples before we stop drawing (also bounded by the
  // available identity pool at the call site).
  maxSamples: number;
}

// DEFAULTS — these are STARTING POINTS, not final, tuned values. They MUST be
// calibrated against the measured heal-run pass-rate distribution before the
// verdict is fully trusted: pick promoteFloor so a genuinely-working recipe
// clears it within maxSamples informative attempts, and rejectCeiling so a
// genuinely-broken one is rejected without wasting the pool. Do not present
// these as authoritative. Env-overridable (see freshVerifyConfidenceFromEnv).
//
// WHY 0.2 / 0.2 AND NOT (e.g.) 0.6 / 0.3: with the EXACT Wilson 95% interval
// (z=1.96) at the small n we operate in, the lower bound is conservative — even
// a perfect 5/5 only reaches LCB ≈ 0.57, 2/2 only LCB ≈ 0.34, and 1/1 only
// LCB ≈ 0.21. A floor of
// 0.6 would therefore be UNREACHABLE inside maxSamples=4 informative draws, so
// nothing would ever promote. These defaults are chosen so the intended
// behavior holds against the honest math: one full fresh browser success can
// promote (matching the registry's verifier threshold of 1), 2/2 promotes
// strongly, while a 2/4 does NOT (LCB 0.15 < 0.20) — i.e. "promoted" means "high
// lower-confidence-bound pass-rate", not "passed once". When the heal-run
// distribution is measured, RE-DERIVE these (and/or relax z / raise maxSamples)
// rather than trusting the round numbers. Tracked as the calibration TODO.
export const DEFAULT_PROMOTE_FLOOR = 0.2;
export const DEFAULT_REJECT_CEILING = 0.2;
export const DEFAULT_MAX_SAMPLES = 4;

// Read the sampler bounds from the environment, falling back to the (untuned)
// defaults above. Documented in CLAUDE.md's bot-env table.
export function freshVerifyConfidenceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConfidenceOpts {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim().length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    promoteFloor: num(env.FRESH_VERIFY_PROMOTE_FLOOR, DEFAULT_PROMOTE_FLOOR),
    rejectCeiling: num(env.FRESH_VERIFY_REJECT_CEILING, DEFAULT_REJECT_CEILING),
    maxSamples: Math.max(
      1,
      Math.floor(num(env.FRESH_VERIFY_MAX_SAMPLES, DEFAULT_MAX_SAMPLES)),
    ),
  };
}

// Wilson score interval for a binomial proportion at z = 1.96 (95%). Closed
// form, no external stats dep. With n = 0 it returns the full [0, 1] — maximum
// uncertainty, which is exactly the "no signal yet" we want the loop to keep
// sampling on. The Wilson interval (vs the naive normal approximation) is
// well-behaved at the extremes (0/n and n/n) and for tiny n, which is the whole
// regime we operate in (≤ maxSamples informative attempts).
export function wilsonInterval(
  successes: number,
  failures: number,
  z = 1.96,
): { lcb: number; ucb: number } {
  const n = successes + failures;
  if (n === 0) return { lcb: 0, ucb: 1 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  const lcb = (center - margin) / denom;
  const ucb = (center + margin) / denom;
  // Clamp out floating-point spill past [0, 1].
  return {
    lcb: Math.max(0, Math.min(1, lcb)),
    ucb: Math.max(0, Math.min(1, ucb)),
  };
}

// Pure: given the informative counts so far + how many MORE informative draws
// the budget/pool can afford, return the sequential verdict. This is the single
// decision rule every verdict path shares (D2). The Beta posterior is
// Beta(α = 1 + successes, β = 1 + failures); we summarize it with the Wilson
// 95% interval over the observed proportion (equivalent in spirit, closed-form,
// and stable at small n) rather than pulling in a Beta-quantile dependency.
export function evaluateConfidence(
  successes: number,
  failures: number,
  opts: ConfidenceOpts & { drawsRemaining: number },
): {
  verdict: ConfidenceVerdict;
  lcb: number;
  ucb: number;
  samples: number;
} {
  const samples = successes + failures;
  const { lcb, ucb } = wilsonInterval(successes, failures);
  // Converged toward promote/reject?
  if (lcb > opts.promoteFloor) return { verdict: "promote", lcb, ucb, samples };
  if (ucb < opts.rejectCeiling) return { verdict: "reject", lcb, ucb, samples };
  // Not converged. Can we afford another informative draw?
  const capReached = samples >= opts.maxSamples;
  // A full-budget replay sweep with zero successes is not "insufficient
  // signal"; it is exactly the signal the verifier was asked to collect. The
  // Wilson UCB is intentionally conservative at tiny N, but letting 0/4 HOLD
  // means structurally-bad stored skills never report failure to the registry
  // and stay in pending-review forever. Keep mixed outcomes conservative, but
  // reject a recipe that spent the whole informative budget without producing a
  // single credential.
  if (capReached && successes === 0 && failures > 0) {
    return { verdict: "reject", lcb, ucb, samples };
  }
  if (capReached || opts.drawsRemaining <= 0) {
    // Budget/pool exhausted before the interval cleared a threshold → HOLD.
    // NOT reject — an honest "not enough signal", so a working recipe that just
    // didn't get enough fresh identities this pass isn't punished.
    return { verdict: "hold", lcb, ucb, samples };
  }
  return { verdict: "sample_more", lcb, ucb, samples };
}

// ── D2.B: map a raw signup outcome to an observation class ────────────────────

// The leading error code of a failure reason (the bot emits "<code>: detail").
function failureCode(reason: string | undefined): string {
  if (reason === undefined) return "";
  return reason.split(/[:\s]/, 1)[0]?.toLowerCase() ?? "";
}

// Classify one attempt into the sampler's observation space. A success is always
// informative. A failure is a HARD-WALL (deterministic — reject now), or a
// NON-OBSERVATION (transient/nav/onboarding flake — drop, draw again), or an
// INFORMATIVE-FAILURE (genuine rot — counts toward the posterior).
export function classifyAttempt(res: {
  success: boolean;
  reason?: string;
}): AttemptObservation {
  if (res.success) return "informative_success";
  if (isHardFailure(res.reason)) return "hard_wall";
  if (isNonObservation(res.reason)) return "non_observation";
  return "informative_failure";
}

// Run a fresh-identity verification for one service. Picks unspent identities and
// signs up as each (SEQUENTIAL — one shared-profile-lock + don't burst one egress
// IP), driving the loop off `evaluateConfidence`. A genuine credential updates
// the posterior; a flake is dropped and re-drawn (within budget); a hard wall
// rejects immediately. The caller reports the converged `verdict` to the
// registry (D2.C).
export async function freshVerifyService(opts: {
  service: string;
  provider: IdentityProvider;
  // Sampler bounds. Defaults to the (untuned) module defaults; the runner wires
  // freshVerifyConfidenceFromEnv() so operators can calibrate without a deploy.
  confidence?: ConfidenceOpts;
  identities: readonly VerifyIdentity[];
  usage: readonly UsageRecord[];
  runSignup: (
    identity: VerifyIdentity,
  ) => Promise<{ success: boolean; credential?: string; reason?: string }>;
  markSpent: (identityId: string, service: string) => void;
  // Inverse of markSpent — reclaim a robot the verifier marked spent up-front
  // but which then bailed at the PROVIDER login (needs_login), never touching
  // the service. Optional: callers without an unspend store keep the
  // burn-on-attempt behaviour.
  markUnspent?: (identityId: string, service: string) => void;
  log?: (msg: string) => void;
}): Promise<FreshVerifyResult> {
  const confidence = opts.confidence ?? {
    promoteFloor: DEFAULT_PROMOTE_FLOOR,
    rejectCeiling: DEFAULT_REJECT_CEILING,
    maxSamples: DEFAULT_MAX_SAMPLES,
  };
  const log = opts.log ?? (() => undefined);

  // The pool bounds how many INFORMATIVE samples we could ever gather, but
  // non-observations (flakes) consume identities WITHOUT advancing the posterior.
  // We therefore pull the whole spendable pool up to maxSamples worth of
  // informative draws, generously padded for expected flake attrition. Capping
  // the pull at maxSamples + a flake allowance keeps one service from draining
  // the fleet while still letting a couple of flakes be re-drawn.
  const flakeAllowance = confidence.maxSamples; // up to 1 redraw per informative slot
  const maxPull = confidence.maxSamples + flakeAllowance;
  let candidates = pickUnspentIdentities(
    opts.identities,
    opts.usage,
    opts.service,
    opts.provider,
    maxPull,
  );
  // Need at least ONE identity to gather any signal. (The old code required
  // `agreement` here; with the sampler, a single informative attempt is enough
  // to start moving the posterior — and a 1-identity 0/1 still HOLDs rather than
  // rejecting on no signal.)
  if (candidates.length === 0) {
    log(
      `[fresh-verify] ${opts.service}: no unspent ${opts.provider} identities — pool ` +
        `exhausted for this service; mint more robots or fall back to refetch`,
    );
    return {
      kind: "insufficient_identities",
      service: opts.service,
      verdict: "hold",
      promoted: false,
      successes: 0,
      failures: 0,
      samples: 0,
      passRateLcb: 0,
      passRateUcb: 1,
      available: candidates.length,
      outcomes: [],
    };
  }

  const outcomes: FreshVerifyOutcome[] = [];
  let successes = 0;
  let failures = 0;
  let hardWalls = 0;
  let needsLoginRedraws = 0;
  let failureKind: string | undefined;
  let lastEval = evaluateConfidence(0, 0, { ...confidence, drawsRemaining: 1 });

  let attemptedAnyIdentity = false;
  for (let i = 0; i < candidates.length; i++) {
    const identity = candidates[i]!;
    const lease = acquireIdentityLease(identity.id);
    if (!lease.ok) {
      log(
        `[fresh-verify] ${opts.service}: ${identity.id} is already leased by another verifier task — skipping this pass`,
      );
      continue;
    }
    attemptedAnyIdentity = true;
    log(`[fresh-verify] ${opts.service}: signing up as ${identity.id} (${identity.email})`);
    let res: { success: boolean; credential?: string; reason?: string };
    // Robot scratchpad: once a robot is assigned to a service trial, record the
    // (identity, service) pair BEFORE launching the browser. If the process is
    // killed, Chrome hangs, or the machine reboots mid-run, the robot may have
    // reached the service and become a returning user; reusing it for the same
    // service would violate the fresh-identity invariant. recordSpent is
    // idempotent, so recording up-front is safe and makes interrupted trials
    // visible to later verifier passes.
    opts.markSpent(identity.id, opts.service);
    try {
      res = await opts.runSignup(identity);
    } catch (err) {
      res = { success: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      releaseIdentity(identity.id);
    }

    const observation = classifyAttempt(res);
    outcomes.push({
      identityId: identity.id,
      success: res.success,
      ...(res.credential !== undefined ? { credential: res.credential } : {}),
      ...(res.reason !== undefined ? { reason: res.reason } : {}),
      observation,
    });
    log(
      `[fresh-verify] ${opts.service}: ${identity.id} → ${res.success ? "success" : "fail"} ` +
        `[${observation}]` +
        (res.reason !== undefined ? ` (${res.reason})` : ""),
    );

    // A hard wall should be deterministic across identities, but a single
    // captcha/anti-bot timeout can be per-run reputation noise. Require two
    // independent wall observations before reporting a terminal reject; the
    // first wall is held as suspicion and does not move the posterior.
    if (observation === "hard_wall") {
      hardWalls += 1;
      failureKind = failureCode(res.reason) || "anti_bot_blocked";
      if (hardWalls < 2) {
        log(
          `[fresh-verify] ${opts.service}: hard wall suspicion (${res.reason ?? "?"}) — ` +
            `drawing another identity before REJECT`,
        );
        continue;
      }
      const { lcb, ucb } = wilsonInterval(successes, failures);
      log(
        `[fresh-verify] ${opts.service}: hard wall confirmed (${res.reason ?? "?"}) — REJECT ` +
          `(2 independent wall observations)`,
      );
      return {
        kind: "verified",
        service: opts.service,
        verdict: "reject",
        promoted: false,
        successes,
        failures,
        samples: successes + failures,
        passRateLcb: lcb,
        passRateUcb: ucb,
        failureKind,
        outcomes,
      };
    }

    // A non-observation (flake) is dropped: it does NOT move the posterior. Most
    // flakes can be re-drawn, but provider/session blockers are not per-identity
    // evidence about the stored skill. If replay reaches a provider login wall,
    // spending more robots only burns the fleet until the provider capability is
    // fixed (e.g. GitHub-warmed robots or a repaired Google session).
    if (observation === "non_observation") {
      const code = failureCode(res.reason);
      const requiredProvider = nonObservationRequiredProvider(res.reason);
      // needs_login means the robot bailed at the PROVIDER login and never
      // touched the service — it is NOT a returning user, so reclaim the seat
      // the up-front markSpent took. (step_failed AFTER OAuth means an account
      // WAS created → stays spent.)
      if (code === "needs_login") {
        opts.markUnspent?.(identity.id, opts.service);
      }
      const holdNonRedrawable = (): void => {
        lastEval = evaluateConfidence(successes, failures, {
          ...confidence,
          drawsRemaining: 0,
        });
        log(
          `[fresh-verify] ${opts.service}: non-redrawable verifier blocker ` +
            `(${res.reason ?? "unknown"}) — HOLD without spending more identities`,
        );
      };

      // CROSS-PROVIDER blocker: the stored skill wants a provider this robot
      // lacks (needs_login provider=github while sampling google, or an
      // explicit needs_oauth_provider_session). Reroute to a capable identity;
      // if the pool has none, it's a genuine capability gap → non-redrawable.
      if (
        (code === "needs_login" || code === "needs_oauth_provider_session") &&
        requiredProvider !== undefined &&
        requiredProvider !== opts.provider
      ) {
        const capableAlreadyQueued = candidates.some(
          (candidate, idx) => idx > i && candidate.providers.includes(requiredProvider),
        );
        if (capableAlreadyQueued) {
          continue; // the loop will reach the capable identity on its own
        }
        const seen = new Set(outcomes.map((o) => o.identityId));
        const rerouteCandidates = pickUnspentIdentities(
          opts.identities,
          opts.usage,
          opts.service,
          requiredProvider,
          maxPull,
        ).filter((candidate) => !seen.has(candidate.id));
        if (rerouteCandidates.length > 0) {
          candidates = [...candidates.slice(0, i + 1), ...rerouteCandidates];
          log(
            `[fresh-verify] ${opts.service}: replay discovered provider=${requiredProvider}; ` +
              `rerouting from ${opts.provider} to ${rerouteCandidates.length} ` +
              `${requiredProvider}-capable identit${rerouteCandidates.length === 1 ? "y" : "ies"}`,
          );
          continue;
        }
        holdNonRedrawable();
        break;
      }

      // SAME-PROVIDER capability gap (the robot's provider session is
      // structurally missing/stale, not per-run noise) → non-redrawable HOLD.
      if (isNonRedrawableNonObservation(res.reason)) {
        holdNonRedrawable();
        break;
      }

      // SAME-PROVIDER needs_login is per-robot session-freshness variance
      // (MEASURED 2026-06-24: chooser on some robots, identifier on others from
      // ONE pool) → redrawable, but bounded so a service where NO robot has the
      // session can't drain the fleet. After NEEDS_LOGIN_REDRAW_CAP fruitless
      // login draws, HOLD.
      if (code === "needs_login") {
        needsLoginRedraws += 1;
        if (needsLoginRedraws >= NEEDS_LOGIN_REDRAW_CAP) {
          lastEval = evaluateConfidence(successes, failures, {
            ...confidence,
            drawsRemaining: 0,
          });
          log(
            `[fresh-verify] ${opts.service}: ${needsLoginRedraws} needs_login draws without a ` +
              `session-fresh robot — HOLD (provider login wall, not a stored-skill defect)`,
          );
          break;
        }
      }
      continue;
    }

    // Informative — update the posterior.
    if (observation === "informative_success") {
      successes += 1;
    } else {
      failures += 1;
      failureKind = failureCode(res.reason) || "step_failed";
    }

    // How many MORE informative draws could the remaining pool afford? (An
    // over-estimate is fine — evaluateConfidence also caps on maxSamples.)
    const drawsRemaining = candidates.length - (i + 1);
    lastEval = evaluateConfidence(successes, failures, {
      ...confidence,
      drawsRemaining,
    });
    if (lastEval.verdict === "promote" || lastEval.verdict === "reject") break;
    // hold also stops (budget/pool exhausted); sample_more continues the loop.
    if (lastEval.verdict === "hold") break;
  }

  if (!attemptedAnyIdentity) {
    log(
      `[fresh-verify] ${opts.service}: all unspent ${opts.provider} identities are currently leased by other verifier tasks`,
    );
    return {
      kind: "insufficient_identities",
      service: opts.service,
      verdict: "hold",
      promoted: false,
      successes: 0,
      failures: 0,
      samples: 0,
      passRateLcb: 0,
      passRateUcb: 1,
      available: 0,
      outcomes: [],
    };
  }

  // Re-evaluate with no draws remaining so a loop that simply ran out of pool
  // (never hitting an explicit promote/reject/hold inside the loop) resolves to a
  // terminal verdict instead of the internal sample_more.
  const finalEval =
    lastEval.verdict === "sample_more"
      ? evaluateConfidence(successes, failures, { ...confidence, drawsRemaining: 0 })
      : lastEval;
  const verdict: Exclude<ConfidenceVerdict, "sample_more"> =
    finalEval.verdict === "sample_more" ? "hold" : finalEval.verdict;

  log(
    `[fresh-verify] ${opts.service}: ${successes}✓/${failures}✗ over ` +
      `${outcomes.length} attempt(s) — LCB ${finalEval.lcb.toFixed(2)} / UCB ` +
      `${finalEval.ucb.toFixed(2)} → ${verdict.toUpperCase()}`,
  );
  return {
    kind: "verified",
    service: opts.service,
    verdict,
    promoted: verdict === "promote",
    successes,
    failures,
    samples: successes + failures,
    passRateLcb: finalEval.lcb,
    passRateUcb: finalEval.ucb,
    ...(verdict !== "promote" && failureKind !== undefined ? { failureKind } : {}),
    outcomes,
  };
}

// ── failure-reason classification ────────────────────────────────────────────

// A failure reason that other fresh identities will deterministically hit too —
// so spending more robots is wasted. Matches on the error-code prefix the bot
// emits. (Unchanged set; now the input to classifyAttempt's HARD-WALL branch.)
const HARD_FAILURE_CODES = [
  "no_signup_link",
  "sso_restricted",
  "oauth_required",
  "payment_required",
  "onboarding_blocked",
  "anti_bot_blocked",
  "captcha_blocked",
  "unservable",
];
export function isHardFailure(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return HARD_FAILURE_CODES.includes(failureCode(reason));
}

// A failure reason that is per-run VARIANCE, not a verdict about the recipe — a
// timing flake, a transient OAuth/session bounce, an onboarding stall, a network
// blip. These are DROPPED as non-observations and re-drawn (D2.B), unifying the
// old retryBudget "don't count a flake" with the taxonomy's "transient never
// demotes". Anything that is neither a hard wall nor a known transient is taken
// as an INFORMATIVE genuine-rot failure (it moves the posterior down).
const NON_OBSERVATION_CODES = [
  // Verifier robot/session health, not a service verdict. A profile may be
  // stale, unwarmed, or logged out; re-draw another robot instead of demoting.
  "needs_login",
  "needs_oauth_provider_session",
  // Genuine per-run OAuth variance — real promotions came from re-drawing these
  // (gladia, clarifai). MUST stay non-informative.
  "oauth_loop_detected",
  "oauth_onboarding_failed",
  "oauth_session_not_persisted",
  "oauth_consent_needs_review",
  "verification_not_sent",
  // Transient session / timing / network — the page-load layer, not the recipe.
  "nav_timeout",
  "run_timeout",
  "timeout",
  "navigation",
  "econnreset",
  "econnrefused",
  "etimedout",
  // Onboarding / consent stalls that one fresh identity hit but another won't.
  "onboarding_stall",
  "transient",
  // Our-side inbox/delivery — not the recipe's fault (mirrors INFRA taxonomy).
  "inbox_empty",
  "email_delivery_failed",
];

// Some bot reasons carry the transient signal in prose rather than a leading
// code token (e.g. "form drift mid-fill", "transient onboarding stall"). Match
// those phrases too so they're dropped rather than counted as rot.
const NON_OBSERVATION_PHRASE_RE =
  /(form drift|onboarding stall|transient|mid-fill|chrome wedged|navigation timeout|timed out|wedged|profile is held|profile held|profile is busy|profile busy|profilebusyerror|returning-user|authenticated session diverged|already registered|account already exists)/i;

export function isNonObservation(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  if (NON_OBSERVATION_CODES.includes(failureCode(reason))) return true;
  return NON_OBSERVATION_PHRASE_RE.test(reason);
}

// A subset of non-observations are verifier-capability blockers, not random
// flakes. Re-drawing identities cannot prove the skill healthy or broken; it
// only consumes fresh robots until the missing provider/session capability is
// repaired out-of-band. Keep returning-user/stale-service divergence redrawable
// so a rotated clean pool can still recover those cases.
//
// `needs_login` is NOT in this set. MEASURED 2026-06-24 (meilisearch): a single
// OAuth replay pass drew robots that got the account CHOOSER (live session →
// pass) AND robots that got the identifier page (needs_login) FROM THE SAME
// POOL — it is per-robot session-freshness variance, not a uniform capability
// gap, so re-drawing genuinely CAN find a passing robot. Treating it as
// non-redrawable HELD the whole skill on one unlucky first draw. The sampler
// bounds needs_login re-draws separately (NEEDS_LOGIN_REDRAW_CAP) so a service
// where NO robot has a session still can't burn the entire fleet.
export function isNonRedrawableNonObservation(reason: string | undefined): boolean {
  if (!isNonObservation(reason)) return false;
  const code = failureCode(reason);
  return code === "needs_oauth_provider_session";
}

// A provider/session CAPABILITY blocker (rotating the pool can't fix it):
//   - needs_oauth_provider_session (any) — the provider session is structurally
//     missing for this provider, and
//   - needs_login naming a provider the RUN isn't sampling (e.g. the skill wants
//     GitHub but the pass runs Google robots) with no capable robot.
// SAME-provider needs_login is excluded — that's per-robot session-freshness
// variance, which rotating to fresh robots genuinely CAN repair. Used by the
// runFreshVerify replenish guard: rotate on variance, don't rotate on a
// capability gap (MEASURED: the gap can't be rotated away, only re-warmed/minted
// out of band).
export function isProviderCapabilityBlocker(
  reason: string | undefined,
  runProvider: IdentityProvider,
): boolean {
  if (!isNonObservation(reason)) return false;
  const code = failureCode(reason);
  if (code === "needs_oauth_provider_session") return true;
  if (code === "needs_login") {
    const required = nonObservationRequiredProvider(reason);
    return required !== undefined && required !== runProvider;
  }
  return false;
}

// How many `needs_login` re-draws a single verify pass will spend chasing a
// session-fresh robot before giving up and HOLDing. Bounded so a genuinely
// login-walled skill (no robot has the session) can't drain the pool, but high
// enough to clear per-robot variance (run5: ~3/8 robots hit the identifier
// page, so ~3 redraws reliably reaches a chooser robot).
export const NEEDS_LOGIN_REDRAW_CAP = 4;

export function nonObservationRequiredProvider(
  reason: string | undefined,
): IdentityProvider | undefined {
  if (reason === undefined) return undefined;
  const explicit = /\bprovider=(google|github)\b/i.exec(reason)?.[1]?.toLowerCase();
  if (explicit === "google" || explicit === "github") return explicit;
  const lower = reason.toLowerCase();
  if (/\bgithub\b/.test(lower)) return "github";
  if (/\bgoogle\b/.test(lower)) return "google";
  return undefined;
}
