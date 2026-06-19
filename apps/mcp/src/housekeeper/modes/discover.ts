// Discovery-bot wiring — closed-loop strategy Phase 6 follow-up.
//
// Glues the discovery loop's injected `runUniversalBot` callback to
// the actual universal signup bot. Replicates the minimum of
// provision-any.ts's runSignupTask that we need (machine token +
// account id + inbox alias + LLM pair + bot) without going through
// the MCP-tool indirection (the tool reads session.json from disk;
// the verifier worker is operator-driven, not user-driven).
//
// Env required:
//   TRUSTY_SQUIRE_API_BASE       (default https://trusty-squire-api.fly.dev)
//   TRUSTY_SQUIRE_MACHINE_TOKEN  (operator machine token for the LLM proxy + inbox)
//   TRUSTY_SQUIRE_ACCOUNT_ID     (operator account id for inbox alias scoping)
//
// On a successful signup, the function fires auto-promote (when
// TRUSTY_SQUIRE_AUTO_PROMOTE is set — default-on as of rc.14) so
// the captured corpus becomes a pending-review skill the verifier
// will later promote on the first verifier success.

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UniversalSignupBot, type SignupResult } from "../../bot/index.js";
import { pickLLMPair } from "../../bot/llm-client.js";
import { InboxClient } from "../../bot/inbox-client.js";
import {
  isAutoPromoteEnabled,
  runAutoPromote,
  buildExtractFailureUploader,
  buildRoundUploader,
} from "../../tools/provision-any.js";
import { emitProvisionEvent, postCaptchaEvent } from "../../tools/signup-telemetry.js";
import { clientFromEnv, generateProvisionId } from "../../skill-registry-client.js";
import type { HousekeeperTask } from "../queues/index.js";
import type { HousekeeperOpts } from "../orchestrator.js";
import {
  loadIdentities,
  loadUsage,
  pickUnspentIdentities,
  recordSpent,
  acquireIdentityLease,
  releaseIdentity,
  type VerifyIdentity,
} from "../identity-pool.js";
import {
  classifyProvisionState,
  unknownStateSignature,
  type ProvisionState,
} from "@trusty-squire/skill-schema";
import { replenishVerifyPool } from "../robot-replenish.js";

// The verify identity pool, abstracted behind a seam so tests can inject a
// deterministic fleet + usage notebook without touching the operator's
// ~/.trusty-squire/verify-identities.json. The default reads the on-disk pool
// (identity-pool.ts). Discover REUSES the verify pool for OAuth signups
// (operator-confirmed) so each Google-OAuth discover run logs in as ONE warm
// robot identity and takes the deterministic pickChooserAccount branch instead
// of the blind first-card chooser.
export interface IdentityPoolPort {
  /** Unspent (identity, service) robots for `service`, capped at `n`. */
  pick(service: string, n: number): VerifyIdentity[];
  /** Mark (identity, service) spent so the same robot isn't reused there. */
  markSpent(identityId: string, service: string): void;
}

function defaultIdentityPool(): IdentityPoolPort {
  return {
    // Discover OAuth is Google-only (the robots are Cloud Identity Free Google
    // accounts; github discover keeps the shared-profile fallback).
    // Return unspent candidates only; resolveProfilePlan owns the actual
    // in-flight lease acquisition. Keeping the lease boundary there means a
    // contested identity becomes a typed discovery outcome, not a silent
    // continuation on a shared robot/profile.
    pick: (service, n) =>
      pickUnspentIdentities(loadIdentities(), loadUsage(), service, "google", n),
    markSpent: (identityId, service) =>
      recordSpent(identityId, service, new Date().toISOString()),
  };
}

export interface DiscoveryBotConfig {
  // Override env-read defaults — used by tests.
  machineToken?: string;
  apiBase?: string;
  accountId?: string;
  // For tests: mock the bot. Production constructs UniversalSignupBot.
  bot?: { signup: UniversalSignupBot["signup"] };
  // For tests: mock the inbox client.
  inboxClient?: { createAlias: InboxClient["createAlias"] };
  // For tests: skip the auto-promote network call.
  skipAutoPromote?: boolean;
  // For tests: inject a deterministic identity pool. Production reads the
  // on-disk verify pool.
  identityPool?: IdentityPoolPort;
  // For tests: mock the just-in-time robot re-warm. Production shells
  // tools/google-login-fleet.mjs to re-establish a stale Google session.
  // Returns true when the robot's session was successfully re-warmed.
  warmIdentity?: (identityId: string) => Promise<boolean>;
}

export type DiscoveryBotOutcome =
  | {
      kind: "ok";
      reason: string;
      credential_kind?: string;
      // 0.8.2-rc.4 — surface the auto-promote outcome to the
      // orchestrator's summary counter. Undefined means
      // auto-promote didn't run (env disabled). Otherwise carries
      // the discriminated result from runAutoPromote so the
      // batch summary can credit promoted=N accurately.
      auto_promote?: import("../../tools/provision-any.js").AutoPromoteResult;
      state?: ProvisionState;
    }
  // The named provision state drives the orchestrator's per-state policy.
  // `signature` is set only for `state: "unknown"` — the bucket key the
  // single-escalation tracker counts attempts against.
  | { kind: "blocked"; reason: string; state?: ProvisionState }
  | { kind: "failed"; reason: string; state?: ProvisionState; signature?: string };

// Dumps the bot's step trail to stderr so the housekeeper log shows
// the full planner/inventory/Plan trace alongside the discover
// outcome. Without this, run_timeout / bot_crash failures look
// opaque ("exceeded 600s") with no diagnostic surface.
function flushStepTrail(steps: readonly string[], service: string): void {
  if (steps.length === 0) {
    process.stderr.write(`[housekeeper] ${service}: (no step trail captured)\n`);
    return;
  }
  process.stderr.write(
    `[housekeeper] ${service} step trail (${steps.length} step(s)):\n`,
  );
  for (const s of steps) {
    process.stderr.write(`  ${s}\n`);
  }
}

// Fix D1 — the per-REQUEST anti-bot risk-score rejections that a clean-state
// retry (fresh profile + rotated identity) can clear. These are TRANSIENT
// bounces, distinct from deterministic walls/rot/extraction failures (a retry
// of those just burns ~6min for the same answer). Matched by the error's HEAD
// token so a suffixed message ("anti_bot_blocked: Cloudflare on SSO callback")
// still hits. agent.ts emits `anti_bot_blocked` + `oauth_session_not_persisted`
// (see OAuthSessionNotPersistedError); `anti_bot` is the bare-marker variant.
const CLEAN_STATE_RETRY_KINDS: ReadonlySet<string> = new Set([
  "anti_bot",
  "anti_bot_blocked",
  "oauth_session_not_persisted",
]);

// The error's leading token — the bot's terminal vocabulary stems a message
// at "<kind>: <detail>", so the first `:`/whitespace-delimited token IS the
// failure kind. Shared by the D1 and JIT-warm remediation gates.
function headTokenOf(error: string | undefined): string {
  return (error ?? "").trim().toLowerCase().split(/[:\s]/, 1)[0] ?? "";
}

function shouldCleanStateRetry(error: string | undefined): boolean {
  if (error === undefined) return false;
  // Controlled-experiment escape: skip the D1 retry so each attempt consumes
  // exactly one identity (the retry rotates to a second robot, which doubles
  // pool consumption and muddies single-attempt matrices like the egress
  // direct-vs-proxy proof). Unset in normal operation — D1 stays on.
  if (/^(1|true|on)$/i.test(process.env.UNIVERSAL_BOT_NO_CLEAN_STATE_RETRY ?? "")) {
    return false;
  }
  return CLEAN_STATE_RETRY_KINDS.has(headTokenOf(error));
}

// Just-in-time robot re-warm. needs_login means the picked verify-pool robot
// landed on Google's sign-in form — ITS warmed session went stale. (The heal
// replenish only warms freshly-MINTED robots, so an existing robot's session
// drifts stale over days; the back half of a long discover queue, where the
// fresh identities were already spent up front, is where this bites.) The
// remedy is not rotation — the next robot may be just as stale — but warming
// THIS robot's session on demand, then retrying the same identity, which keeps
// the one-shot-per-(identity, service) invariant (no second seat consumed).
// Default shells the operator login-fleet tool; failure is non-fatal (the
// caller logs "warm-retry skipped" and keeps the original needs_login).
function defaultWarmIdentity(): (identityId: string) => Promise<boolean> {
  return async (identityId) => {
    try {
      execFileSync("node", ["tools/google-login-fleet.mjs", identityId], {
        cwd: process.cwd(),
        timeout: 240_000,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
}

// Emit the same telemetry the provision router emits, so harvest runs
// show up in the operator dashboard's funnel + failure views (they were
// previously blind — DESIGN-antibot-hardening.md D1). Dispatch is always
// bot→bot (the discover worker never replays a skill). Fire-and-forget +
// fail-open: a telemetry error never changes the discover outcome. We
// deliberately do NOT emit a UniversalBotFailureRecord here — that table
// is the end-user demand signal this worker's own queue consumes, and
// self-feeding it would make the bot re-harvest its own failures.
// AWAITED, unlike the provision server's fire-and-forget: the housekeeper
// `--once` process calls process.exit() right after the batch, so an
// un-awaited POST is killed before it lands (this is exactly why early
// discover runs recorded NOTHING). We await both emits here, bounded by
// the clients' own timeouts, so the events flush before the process exits.
async function recordDiscoverTelemetry(
  input: { service: string; signupUrl?: string },
  result: SignupResult,
  ctx: {
    accountId: string;
    apiBase: string;
    machineToken: string;
    provisionId: string;
    startedAt: number;
    stepsSink: readonly string[];
  },
): Promise<void> {
  try {
    const registry = clientFromEnv(ctx.accountId);
    if (registry !== null) {
      await emitProvisionEvent(registry, {
        service: input.service,
        provisionId: ctx.provisionId,
        startedAt: ctx.startedAt,
        initialStrategy: "bot",
        finalStrategy: "bot",
        replayOutcome: "na",
        result,
        ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
        ...(ctx.stepsSink.length > 0 ? { stepTrail: ctx.stepsSink.join("\n") } : {}),
        replayServed: false,
        // Memory-overhaul Phase 1 — this is the housekeeper discover worker;
        // stamp the mode + the captcha summary (same data postCaptchaEvent
        // sends to the API in detail) into the firehose.
        mode: "discover",
        ...(result.captcha !== undefined
          ? {
              captcha: {
                kind: result.captcha.kind,
                variant: result.captcha.variant,
                blocked: result.captcha.blocked,
              },
            }
          : {}),
      });
    }
    if (result.captcha !== undefined) {
      await postCaptchaEvent(ctx.apiBase, ctx.machineToken, {
        service: input.service,
        captcha_kind: result.captcha.kind,
        blocked: result.captcha.blocked,
        proxied: result.proxied ?? false,
        captcha_variant: result.captcha.variant,
        challenge_rendered: result.captcha.challenge_rendered,
        signup_succeeded: result.success,
        ...(result.stealth_profile !== undefined
          ? { stealth_profile: result.stealth_profile }
          : {}),
      });
    }
  } catch (err) {
    process.stderr.write(
      `[housekeeper] ${input.service}: telemetry emit failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

export async function runDiscover(
  input: {
    service: string;
    oauthProvider?: "google" | "github";
    /** Canonical signup URL (curated YAML override). */
    signupUrl?: string;
    /**
     * Force the email/password form path (skip OAuth) so the run hits the
     * form-side captcha. From the YAML `force_form` or the
     * UNIVERSAL_BOT_FORCE_FORM env (ad-hoc A/B runs).
     */
    forceForm?: boolean;
    /**
     * Extra OAuth scopes the operator pre-approves for THIS service (curated
     * YAML `allow_extra_oauth_scopes`). Without it the bot aborts
     * oauth_consent_needs_review on any non-basic scope — correct for an
     * end-user, but the operator's own discovery run for a service that
     * legitimately needs e.g. GitHub `read:org` (defang) should proceed.
     * Opt-in per service; the DOM danger-phrase scraper still hard-aborts on
     * sensitive grants (Drive/Gmail/contacts) regardless.
     */
    allowExtraOAuthScopes?: readonly string[];
  },
  cfg: DiscoveryBotConfig = {},
): Promise<DiscoveryBotOutcome> {
  // Env override lets an ad-hoc `--service=…` A/B run force the form path
  // without editing the YAML.
  const forceForm =
    input.forceForm === true || process.env.UNIVERSAL_BOT_FORCE_FORM === "1";
  const machineToken = cfg.machineToken ?? process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  const apiBase =
    cfg.apiBase ??
    process.env.TRUSTY_SQUIRE_API_BASE ??
    "https://trusty-squire-api.fly.dev";
  const accountId = cfg.accountId ?? process.env.TRUSTY_SQUIRE_ACCOUNT_ID;

  if (machineToken === undefined || machineToken.length === 0) {
    return {
      kind: "failed",
      reason:
        "TRUSTY_SQUIRE_MACHINE_TOKEN is not set — discovery worker needs an operator machine token to use the LLM proxy + inbox service",
    };
  }
  if (accountId === undefined || accountId.length === 0) {
    return {
      kind: "failed",
      reason:
        "TRUSTY_SQUIRE_ACCOUNT_ID is not set — discovery worker needs an operator account id to scope inbox aliases + auto-promote attribution",
    };
  }

  const inboxClient =
    cfg.inboxClient ?? new InboxClient({ baseUrl: apiBase, apiKey: machineToken });

  // run_id is VarChar(26) on the inbox EmailAlias model. Keep the
  // prefix short ("hk-" for housekeeper) so timestamp + entropy fit.
  // Mirrors the `mcp-<ts>-<rand>` shape provision-any.ts produces,
  // which already fits comfortably.
  const runId =
    `hk-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

  let alias: string;
  try {
    alias = await inboxClient.createAlias({
      account_id: accountId,
      service: input.service,
      run_id: runId,
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `createAlias failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // pickLLMPair honors UNIVERSAL_BOT_LLM_TIER — verifier deploys
  // typically run with =free.
  const llm = pickLLMPair({ preferCheap: true });
  const stepsSink: string[] = [];

  const bot = cfg.bot ?? new UniversalSignupBot();
  const pool = cfg.identityPool ?? defaultIdentityPool();
  const usingDefaultIdentityPool = cfg.identityPool === undefined;
  const warmIdentity = cfg.warmIdentity ?? defaultWarmIdentity();
  // Telemetry correlation + duration baseline — shared by the success,
  // failure, and crash emits below.
  const provisionId = generateProvisionId();
  const startedAt = Date.now();
  const telemetryCtx = {
    accountId,
    apiBase,
    machineToken,
    provisionId,
    startedAt,
    stepsSink,
  };

  // ── Fix B: per-run, single-account profile isolation ─────────────────
  //
  // Every shared-profile discover run reused ~/.trusty-squire/chrome-profile
  // (2.2GB, holding BOTH google+github sessions) and took the BLIND first-card
  // chooser path — ~22% of OAuth discover runs bounced
  // (oauth_stuck_on_chooser / oauth_loop_detected /
  // no_credentials_after_already_signed_in). The fix: bind each run to ONE
  // account.
  //   • Google-OAuth services → an UNSPENT verify-pool robot. Its warm Google
  //     session means the chooser takes the deterministic pickChooserAccount
  //     branch (single targeted card click) instead of the blind first card.
  //   • email/password services → a throwaway ephemeral profile, torn down
  //     after the run so thousands of small dirs don't accumulate.
  // github-OAuth keeps the shared-profile fallback (the robot fleet is Google).
  const explicitOAuthProvider = input.oauthProvider;
  const autoOAuth = explicitOAuthProvider === undefined;
  const isGoogleOAuth = explicitOAuthProvider === "google" || autoOAuth;
  const isGithubOAuth = explicitOAuthProvider === "github";

  // Tracks every ephemeral dir we created so the `finally` reaps them even when
  // a retry created a second one.
  const ephemeralDirs: string[] = [];
  // Tracks the (identity) robots actually used so we recordSpent EXACTLY the
  // ones we consumed — and so the retry can pick a DIFFERENT one (rotation).
  const usedIdentityIds: string[] = [];

  // Resolve the profile binding for one attempt. `excludeIdentityIds` lets the
  // D1 retry rotate to a fresh robot. Returns null on pool exhaustion so the
  // caller can surface insufficient_identities (mirrors fresh-verify).
  const resolveProfilePlan = async (
    excludeIdentityIds: readonly string[],
  ): Promise<
    | {
        profileDir?: string;
        oauthAccountEmail?: string;
        identityId?: string;
      }
    | { exhausted: true }
    | { leaseConflict: string }
  > => {
    if (isGoogleOAuth) {
      // BOT_FORCE_IDENTITY pins a specific robot regardless of spent-state —
      // for controlled experiments (e.g. the concurrent-OAuth-from-one-IP A/B,
      // where each parallel slot must take a DIFFERENT robot rather than the
      // pool's deterministic first-unspent, which would collide all slots on
      // one account) and for debugging a single robot. Off in normal operation.
      const forced = process.env.BOT_FORCE_IDENTITY;
      if (forced !== undefined && forced.length > 0) {
        const pinned = loadIdentities().find((i) => i.id === forced);
        if (pinned !== undefined && !excludeIdentityIds.includes(pinned.id)) {
          const lease = acquireIdentityLease(pinned.id);
          if (!lease.ok) return { leaseConflict: pinned.id };
          return {
            profileDir: pinned.profileDir,
            oauthAccountEmail: pinned.email,
            identityId: pinned.id,
          };
        }
      }
      // Pick a few unspent so we can skip any already used this invocation
      // (the picker is pool-wide; usedIdentityIds is the in-run exclusion).
      const candidates = pool
        .pick(input.service, excludeIdentityIds.length + 8)
        .filter((i) => !excludeIdentityIds.includes(i.id));
      let sawLeaseConflict = false;
      let identity: VerifyIdentity | undefined;
      for (const candidate of candidates) {
        const lease = acquireIdentityLease(candidate.id);
        if (lease.ok) {
          identity = candidate;
          break;
        }
        sawLeaseConflict = true;
      }
      if (identity === undefined) {
        return sawLeaseConflict ? { leaseConflict: "all_candidates_claimed" } : { exhausted: true };
      }
      return {
        profileDir: identity.profileDir,
        oauthAccountEmail: identity.email,
        identityId: identity.id,
      };
    }
    if (isGithubOAuth) {
      // GitHub OAuth uses the operator-maintained shared profile. The login
      // command stores the github.com session there; putting GitHub discover
      // in an ephemeral profile makes every curated GitHub service look logged
      // out even after `mcp login --provider=github` succeeds.
      return {};
    }
    // email/password (and the no-provider default): a throwaway profile so the
    // run starts from clean state with no accumulated cross-service sessions.
    const root = join(homedir(), ".trusty-squire", "profiles");
    mkdirSync(root, { recursive: true });
    const dir = await mkdtemp(join(root, `discover-${input.service}-`));
    ephemeralDirs.push(dir);
    return { profileDir: dir };
  };

  // One signup attempt against a resolved profile plan. Returns the bot's
  // SignupResult, or a sentinel on crash (mapped to a failed outcome upstream).
  const describeProfilePlan = (plan: {
    profileDir?: string;
    oauthAccountEmail?: string;
    identityId?: string;
  }): string => {
    const mode =
      plan.identityId !== undefined
        ? "robot"
        : plan.profileDir !== undefined
          ? "ephemeral"
          : isGithubOAuth
            ? "shared-github"
            : "shared-default";
    return [
      `[discovery] profile-plan service=${input.service}`,
      `mode=${mode}`,
      `oauth_provider=${explicitOAuthProvider ?? "auto"}`,
      `identity_id=${plan.identityId ?? "none"}`,
      `oauth_account=${plan.oauthAccountEmail ?? "none"}`,
      `profile_dir=${plan.profileDir ?? "shared"}`,
    ].join(" ");
  };

  const attemptSignup = async (plan: {
    profileDir?: string;
    oauthAccountEmail?: string;
    identityId?: string;
  }): Promise<{ result: SignupResult } | { crash: string }> => {
    if (plan.identityId !== undefined && !usedIdentityIds.includes(plan.identityId)) {
      usedIdentityIds.push(plan.identityId);
    }
    stepsSink.push(describeProfilePlan(plan));
    try {
      const result = await bot.signup({
        service: input.service,
        email: alias,
        inbox: inboxClient as InboxClient,
        llm,
        stepsSink,
        machineToken,
        apiBase,
        // Memory-overhaul Phase 2 — the discover worker now uploads its
        // per-round DOM/screenshot chain AND extract-failure snapshots to the
        // registry (redacted), keyed by provisionId. Previously only the
        // end-user provision path wired these, so a discovery failure
        // (oauth_onboarding_failed / needs_login / captcha_blocked) left no
        // central evidence — the groq case, crackable only because a LOCAL
        // capture happened to survive. Both are fire-and-forget + redacted.
        extractFailureUploader: buildExtractFailureUploader(accountId, provisionId),
        roundUploader: buildRoundUploader(accountId, provisionId),
        // Per-run profile binding (Fix B). Absent (github / no plan) →
        // browser.ts falls back to the shared CHROME_PROFILE_DIR.
        ...(plan.profileDir !== undefined ? { profileDir: plan.profileDir } : {}),
        // Targeted account selection — drives the deterministic
        // pickChooserAccount branch (agent.ts) instead of the blind first card.
        ...(plan.oauthAccountEmail !== undefined
          ? { oauthAccountEmail: plan.oauthAccountEmail }
          : {}),
        // YAML-declared OAuth hint forces the bot's OAuth-first scan
        // to look for THIS provider. Without it the scan falls back
        // on the bot profile's logged-in-providers cache, which is
        // often empty (the cache only writes after a successful prior
        // OAuth handshake — chicken-and-egg for fresh services).
        ...(explicitOAuthProvider !== undefined
          ? { oauthProvider: explicitOAuthProvider }
          : {}),
        // YAML-declared signup URL overrides guessSignupUrl(slug). The
        // guess defaults to https://<slug>.com/signup which gets the
        // wrong host for any non-`.com` service (ipinfo.io, anthropic
        // console subdomain, etc.). Five oauth_required failures in the
        // overnight batch were really wrong-URL navigations to parked
        // / unrelated `.com` pages that didn't have the OAuth button.
        ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
        ...(forceForm ? { forceForm: true } : {}),
        ...(input.allowExtraOAuthScopes !== undefined && input.allowExtraOAuthScopes.length > 0
          ? { allowExtraOAuthScopes: input.allowExtraOAuthScopes }
          : {}),
        // The housekeeper is the operator provisioning on their OWN behalf,
        // so approve a benign OAuth consent (email/profile) blind instead of
        // pausing oauth_consent_needs_review when the scopes aren't readable
        // from the URL (Google's opaque part=-token consents — meilisearch,
        // uploadcare). The DOM danger-phrase scraper still HARD-ABORTS on
        // sensitive scope-grant verbs (Drive/Gmail/contacts), so this only
        // auto-approves basic sign-in consent.
        allowBlindOAuthConsent: true,
      });
      return { result };
    } catch (err) {
      return { crash: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── Run the attempt(s), then reap ephemeral profiles in `finally`. ───
  let result: SignupResult;
  try {
    let firstPlan = await resolveProfilePlan([]);
    if ("exhausted" in firstPlan) {
      if (usingDefaultIdentityPool) {
        stepsSink.push(
          `[discovery] insufficient_identities for ${input.service} — attempting on-demand verify-pool replenish`,
        );
        await replenishVerifyPool({
          log: (line) => stepsSink.push(`[discovery] ${line}`),
          force: true,
          maxPerPass: 1,
        }).catch((err) => {
          stepsSink.push(
            `[discovery] pool replenish failed (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return "";
        });
        firstPlan = await resolveProfilePlan([]);
      }
    }
    if ("exhausted" in firstPlan) {
      // Pool exhausted for this service after an on-demand replenish attempt —
      // every robot has already signed up here, or replenishment could not run.
      // Surface a clear status; never fall back to the blind shared profile.
      return {
        kind: "failed",
        reason: `insufficient_identities: no unspent Google verify-pool robot left for ${input.service} — refill the pool`,
      };
    }
    if ("leaseConflict" in firstPlan) {
      return {
        kind: "failed",
        reason:
          `identity_lease_conflict: Google verify-pool robot ${firstPlan.leaseConflict} ` +
          `is already leased by another in-flight discover slot for ${input.service}`,
      };
    }

    const first = await attemptSignup(firstPlan);
    if ("crash" in first) {
      flushStepTrail(stepsSink, input.service);
      await recordDiscoverTelemetry(
        input,
        { success: false, error: "bot_crash", steps: [...stepsSink] },
        telemetryCtx,
      );
      return { kind: "failed", reason: `bot crash: ${first.crash}` };
    }
    result = first.result;

    // ── Fix D1: clean-state retry on the anti-bot tail ─────────────────
    //
    // anti_bot_blocked / oauth_session_not_persisted is the per-REQUEST risk-
    // score rejection — a transient bounce, not a deterministic block. Roughly
    // half clear on a clean retry: a FRESH profile + a ROTATED identity (a
    // different unspent robot for OAuth; a new ephemeral dir for email/pw). We
    // do NOT retry rot/step_failed/extraction failures — those are
    // deterministic, so a retry just burns ~6min for the same answer. Capped at
    // ONE retry.
    if (!result.success && shouldCleanStateRetry(result.error)) {
      const retryPlan = await resolveProfilePlan(usedIdentityIds);
      if ("exhausted" in retryPlan) {
        stepsSink.push(
          `[discovery] D1 clean-state retry skipped: no second unspent robot to rotate to for ${input.service}`,
        );
      } else if ("leaseConflict" in retryPlan) {
        stepsSink.push(
          `[discovery] D1 clean-state retry skipped: identity lease conflict (${retryPlan.leaseConflict})`,
        );
      } else {
        stepsSink.push(
          `[discovery] D1 clean-state retry: first attempt returned ${result.error ?? "?"} — ` +
            `retrying ONCE from clean state${
              retryPlan.oauthAccountEmail !== undefined
                ? ` (rotated identity ${retryPlan.oauthAccountEmail})`
                : " (fresh ephemeral profile)"
            }.`,
        );
        const second = await attemptSignup(retryPlan);
        if ("crash" in second) {
          stepsSink.push(`[discovery] D1 retry crashed: ${second.crash}`);
          // Keep the original (non-crash) terminal result — a crashed retry is
          // no more informative than the first transient bounce.
        } else {
          result = second.result;
        }
      }
    }

    // ── JIT re-warm on needs_login ─────────────────────────────────────
    //
    // The picked robot's Google session went stale (landed on the sign-in
    // form). Re-warm THIS robot's session on demand, then retry the same
    // identity once — no rotation (the next robot may be just as stale) and no
    // second seat consumed (the one-shot invariant holds). Only meaningful for
    // a Google-OAuth attempt that actually bound a robot identity; warming is
    // best-effort and a failed/absent re-warm leaves the needs_login intact.
    // JIT re-warm shells a SECOND Chrome on the robot's profile. Under
    // concurrency (HOUSEKEEPER_CONCURRENCY>1) that risks contention with the
    // batch's other in-flight Chromes / a profile a sibling slot may touch, and
    // the warm-during-batch is what corrupted a profile in the first 3-wide run
    // (Google "deletedaccount" state). So skip JIT-warm in concurrent mode and
    // surface the stale robot for an OFFLINE re-warm instead.
    const concurrentBatch =
      (Number.parseInt(process.env.HOUSEKEEPER_CONCURRENCY ?? "1", 10) || 1) > 1;
    if (
      !result.success &&
      headTokenOf(result.error) === "needs_login" &&
      firstPlan.identityId !== undefined &&
      !concurrentBatch
    ) {
      const robot = firstPlan.oauthAccountEmail ?? firstPlan.identityId;
      stepsSink.push(
        `[discovery] needs_login: robot ${robot} session stale — re-warming ` +
          `just-in-time and retrying the same identity once.`,
      );
      const warmed = await warmIdentity(firstPlan.identityId).catch(() => false);
      if (warmed) {
        const reheated = await attemptSignup(firstPlan);
        if ("crash" in reheated) {
          stepsSink.push(`[discovery] needs_login warm-retry crashed: ${reheated.crash}`);
        } else {
          result = reheated.result;
        }
      } else {
        stepsSink.push(
          `[discovery] needs_login warm-retry skipped: re-warm of ${robot} failed ` +
            `or the login-fleet tool is unavailable on this host.`,
        );
      }
    }
  } finally {
    // Mark every robot we actually consumed as spent (one-shot per
    // (identity, service)). Squire-side attribution stays the OPERATOR
    // account (TRUSTY_SQUIRE_ACCOUNT_ID) — the robot identity is purely the
    // Google login used to sign up at the service, not the skill owner.
    for (const id of usedIdentityIds) {
      try {
        pool.markSpent(id, input.service);
      } catch (err) {
        stepsSink.push(
          `[discovery] recordSpent(${id}, ${input.service}) failed (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Release the in-flight claim so the robot is available to a later slot
      // (it's now recorded spent for THIS service, so it won't be re-picked here).
      releaseIdentity(id);
    }
    // Reap ephemeral profiles so thousands of small dirs don't accumulate.
    for (const dir of ephemeralDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Always flush — operator wants to see what happened on success
  // (to vet the capture) AND on failure (to diagnose).
  flushStepTrail(stepsSink, input.service);

  // Emit ProvisionEvent (+ CaptchaEvent when a captcha was hit) for the
  // finished run. Awaited so the POSTs land before the --once process
  // exits (see recordDiscoverTelemetry).
  await recordDiscoverTelemetry(input, result, telemetryCtx);

  // Auto-promote on success — same pipeline provision-any.ts fires
  // for end-user signups (Phase 2 makes this land as pending-review).
  let promoteOutcome:
    | import("../../tools/provision-any.js").AutoPromoteResult
    | undefined;
  if (result.success && cfg.skipAutoPromote !== true && isAutoPromoteEnabled(process.env)) {
    // Snapshot the sink length so we can flush ONLY the auto-promote
    // additions to stderr. Before this fix the bot's step trail was
    // flushed above and then auto-promote silently pushed new entries
    // onto the same array — they never reached stderr, so operators
    // saw `promoted=0` in the batch summary and had no diagnostic
    // surface for why every successful capture failed to publish.
    const sinkLenBeforePromote = stepsSink.length;
    try {
      promoteOutcome = await runAutoPromote({
        service: input.service,
        stepsSink,
        accountId,
      });
    } catch (err) {
      // Auto-promote failure is annotated but the discovery outcome
      // is still 'ok' — we did successfully discover a path through
      // the service, it just didn't reach the registry.
      stepsSink.push(
        `[discovery] auto-promote raised: ${err instanceof Error ? err.message : String(err)}`,
      );
      promoteOutcome = { kind: "rejected", reason: "unexpected_throw" };
    }
    const promoteSteps = stepsSink.slice(sinkLenBeforePromote);
    if (promoteSteps.length > 0) {
      process.stderr.write(
        `[housekeeper] ${input.service} auto-promote (${promoteSteps.length} step(s)):\n`,
      );
      for (const s of promoteSteps) {
        process.stderr.write(`  ${s}\n`);
      }
    }
  }

  if (result.success) {
    const credCount =
      result.credentials !== undefined ? Object.keys(result.credentials).length : 0;
    return {
      kind: "ok",
      reason: `signed up via ${result.via ?? "bot"}; extracted ${credCount} credential(s)`,
      ...(promoteOutcome !== undefined ? { auto_promote: promoteOutcome } : {}),
      state: "success",
    };
  }

  // Map the bot's terminal-error vocabulary to a named ProvisionState (the
  // single source of truth — provision-state.ts). The orchestrator then applies
  // the per-state policy. `wall` → blocked (auto-skip; don't keep hammering a
  // service that needs human-side action); everything else → failed (the loop's
  // retryable bucket), tagged with the state. `unknown` additionally carries a
  // signature so the single-escalation tracker can count attempts.
  //
  // email_otp_required / oauth_required stay failed (= fixable, not walls): the
  // bot polls the operator inbox for the code, and oauth_required is usually a
  // wrong-URL nav bug. Both classify as transient/email_pending, never wall.
  const error = result.error ?? "unknown_failure";
  const state = classifyProvisionState({ failure_kind: error, credential_present: false });
  if (state === "wall") {
    return { kind: "blocked", reason: error, state };
  }
  if (state === "unknown") {
    // Bucket by (entry url path + the error's HEAD token) so repeats of the
    // SAME novel terminal on the SAME service share a 3-attempt count, while a
    // different novel state is its own fresh count.
    const headToken = error.trim().split(/[:\s]/, 1)[0] ?? error;
    const signature = unknownStateSignature({
      ...(input.signupUrl !== undefined ? { url: input.signupUrl } : {}),
      element_fingerprints: [headToken],
    });
    return { kind: "failed", reason: error, state, signature };
  }
  return { kind: "failed", reason: error, state };
}

export type DiscoveryBotRunner = (input: {
  service: string;
  oauthProvider?: "google" | "github";
  signupUrl?: string;
  allowExtraOAuthScopes?: readonly string[];
}) => Promise<DiscoveryBotOutcome>;

// Per-task dispatcher the orchestrator invokes for 'discover' tasks.
export async function handleDiscover(
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
    ...(task.signupUrl !== undefined ? { signupUrl: task.signupUrl } : {}),
    ...(task.forceForm === true ? { forceForm: true } : {}),
    ...(task.allowExtraOAuthScopes !== undefined
      ? { allowExtraOAuthScopes: task.allowExtraOAuthScopes }
      : {}),
  });
  log(`discover end:   ${task.service} → ${outcome.kind} (${outcome.reason.slice(0, 120)})`);
  return outcome;
}
