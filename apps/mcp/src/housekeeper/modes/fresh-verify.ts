// fresh-verify mode — verify a stored registry Skill by replaying its exact
// steps as N independent fresh robot identities and driving the verdict off the
// BOUNDED SEQUENTIAL-CONFIDENCE SAMPLER (D2), instead of a fixed 2-of-N count.
// See ../fresh-verify.ts for the sampler + orchestration core and
// ../identity-pool.ts for the fleet model.
//
// Important trust boundary: discover/planner may CREATE a pending skill, but
// fresh-verify may only PROMOTE by replaying the stored Skill graph. It must not
// invoke UniversalSignupBot or any planner path, otherwise the registry learns
// "the service is solvable" instead of "this stored recipe is replayable."
//
// v1 scope: pure-OAuth Google services (the robots are Cloud Identity Free, no
// mailbox for email-OTP). Email-signup services keep using the alias path.

import type { Skill } from "@trusty-squire/skill-schema";
import { BrowserController } from "../../bot/browser.js";
import { makeEmailCodeFetcher } from "../../bot/email-code-fetcher.js";
import { InboxClient } from "../../bot/inbox-client.js";
import type { OAuthProviderId } from "../../bot/oauth-providers.js";
import { CHROME_PROFILE_DIR } from "../../bot/profile.js";
import { replaySkill, type ReplayOutcome } from "../../bot/replay-skill.js";
import {
  loadIdentities,
  loadUsage,
  recordSpent,
  recordUnspent,
  verifyPoolConfigured,
} from "../identity-pool.js";
import { replenishVerifyPool } from "../robot-replenish.js";
import { passwordForRobot } from "../verify-passwords.js";
import {
  freshVerifyService,
  freshVerifyConfidenceFromEnv,
  isProviderCapabilityBlocker,
  type ConfidenceOpts,
  type FreshVerifyResult,
} from "../fresh-verify.js";
import {
  VerifierRegistryClient,
  type VerifierOutcomeResponse,
} from "../registry-client.js";

// The fresh-verify result, plus the registry's transition when the verdict was
// reported (D2.D — lets the heal pass fold the outcome into its batch summary).
// `transition` is undefined when nothing was reported (no skillId, hold, or no
// admin bearer).
export type RunFreshVerifyResult =
  | (FreshVerifyResult & { transition?: VerifierOutcomeResponse["transition"] })
  | {
      kind: "returning_verified";
      service: string;
      skillId: string;
      success: boolean;
      credential?: string;
      reason?: string;
      outcome: ReplayOutcome;
    }
  | { kind: "not_configured"; service: string };

export interface RunFreshVerifyInput {
  service: string;
  // Deprecated compatibility field: fresh verification replays skill.signup_url
  // from the stored Skill. A changed URL must be synthesized as a new pending
  // skill, not slipped into the verifier at runtime.
  signupUrl?: string;
  oauthProvider?: OAuthProviderId; // default "google"
  skillId?: string; // when set, the converged verdict is reported to the registry
  skill?: Skill; // preferred: caller already fetched the exact registry payload
  // Sampler bounds override. Defaults to freshVerifyConfidenceFromEnv() so an
  // operator can calibrate promoteFloor / rejectCeiling / maxSamples via env
  // (FRESH_VERIFY_*) without a deploy. See ../fresh-verify.ts for the UNTUNED
  // default bounds and the calibration note.
  confidence?: ConfidenceOpts;
  // "fresh" is the only mode allowed to drive registry promotion/demotion.
  // "returning" is a component check for authenticated post-OAuth navigation
  // and credential extraction. It uses the shared profile and never reports a
  // verifier outcome, so it cannot pretend virgin signup still works.
  profileMode?: "fresh" | "returning";
}

export interface RunFreshVerifyConfig {
  machineToken?: string;
  apiBase?: string;
  accountId?: string;
  replay?: (input: FreshSkillReplayInput) => Promise<ReplayOutcome>;
  fetchSkill?: (skillId: string) => Promise<Skill>;
  inboxClient?: { createAlias: InboxClient["createAlias"] };
  registry?: { postOutcome: VerifierRegistryClient["postOutcome"] };
  poolConfigured?: () => boolean;
  loadPool?: () => {
    identities: ReturnType<typeof loadIdentities>;
    usage: ReturnType<typeof loadUsage>;
  };
  replenish?: typeof replenishVerifyPool;
  log?: (msg: string) => void;
}

type FreshVerifyIdentity = ReturnType<typeof loadIdentities>[number];

export interface FreshSkillReplayInput {
  skill: Skill;
  identity: FreshVerifyIdentity;
  emailAlias: string;
  preferredOAuthProvider?: OAuthProviderId;
  replayTimeoutMs?: number;
  fetchEmailCode?: (input: { alias: string }) => Promise<string | null>;
}

async function resolveSkill(
  input: RunFreshVerifyInput,
  cfg: RunFreshVerifyConfig,
): Promise<Skill> {
  if (input.skill !== undefined) return input.skill;
  if (input.skillId === undefined || input.skillId.length === 0) {
    throw new Error("fresh-verify needs a stored skill or --skill-id; planner-only verification is forbidden");
  }
  if (cfg.fetchSkill !== undefined) return await cfg.fetchSkill(input.skillId);
  const registry = new VerifierRegistryClient({
    baseUrl: process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
    adminBearer: process.env.REGISTRY_ADMIN_BEARER ?? "",
  });
  return await registry.fetchSkill(input.skillId);
}

function inferOAuthProviderFromSteps(skill: Skill): OAuthProviderId | undefined {
  for (const step of skill.steps) {
    if (step.kind === "click_oauth_button") return step.provider;
  }
  return undefined;
}

function firstCredentialFromReplay(outcome: ReplayOutcome): string | undefined {
  if (outcome.kind === "ok") return outcome.credential;
  if (outcome.kind === "ok_multi") {
    const vals = Object.values(outcome.credentials).filter((v) => v.length > 0);
    return vals.length > 0 ? vals[0] : undefined;
  }
  return undefined;
}

function skillCreatesFreshCredentialBeforeExtract(skill: Skill): boolean {
  for (const step of skill.steps) {
    if (step.kind === "extract_via_copy_button" || step.kind === "extract_via_regex") {
      return false;
    }
    if (step.kind !== "click") continue;
    const label = `${step.text_match ?? ""} ${step.dom_hint?.testid ?? ""} ${step.dom_hint?.id ?? ""}`;
    if (/\b(?:create|generate|new|issue|rotate|regenerate)\b/i.test(label)) {
      return true;
    }
  }
  return false;
}

function describeReplayOutcomeForFreshVerify(outcome: ReplayOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return `stored-skill replay ok via=${outcome.via}`;
    case "ok_multi":
      return `stored-skill replay ok_multi fields=${Object.keys(outcome.credentials).join(",")}`;
    case "dry_pass":
      return `stored-skill replay dry_pass steps=${outcome.stepsWalked}`;
    case "step_failed":
      return `step_failed: stored-skill replay step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "validator_failed":
      return `validator_failed: stored-skill replay step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "extraction_failed":
      return `extraction_failed: stored-skill replay step=${outcome.stepIndex} ${outcome.reason}`.slice(0, 800);
    case "needs_login":
      // `after_oauth` marks a needs_login that hit AFTER an OAuth step already
      // authed — a deterministic mid-flow re-auth wall, not the per-robot
      // session-freshness variance of a handshake-step needs_login. The sampler
      // keys off this to HOLD immediately instead of redrawing/rotating.
      return (
        `needs_login: stored-skill replay provider=${outcome.provider} step=${outcome.stepIndex}` +
        (outcome.afterOAuth ? " after_oauth" : "")
      );
    case "skill_demoted":
      return `skill_demoted: stored-skill replay ${outcome.reason}`;
  }
}

function digitFree(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(97 + parseInt(d, 10)));
}

function returningVerifyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RETURNING_VERIFY_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
}

function verifierTemplateValues(skill: Skill, emailAlias: string): Record<string, string> {
  const verifierTag = digitFree(skill.skill_id.slice(-6).toLowerCase());
  const tsTag = digitFree(Date.now().toString(36));
  return {
    TOKEN_NAME: `verifier-${verifierTag}-${tsTag}`,
    EMAIL_ALIAS: emailAlias,
    USER_DISPLAY_NAME: `Verifier-${verifierTag}`,
  };
}

async function defaultReplayStoredSkill(
  input: FreshSkillReplayInput,
): Promise<ReplayOutcome> {
  const browser = new BrowserController(
    input.identity.proxyUrl !== undefined
      ? { profileDir: input.identity.profileDir, proxyUrl: input.identity.proxyUrl }
      : { profileDir: input.identity.profileDir },
  );
  try {
    await browser.start();
    const preferredOAuthProvider =
      input.preferredOAuthProvider ?? input.identity.providers[0];
    // Inline OAuth login drive: when the walk hits a Google identifier/password
    // screen, type the robot's credential through instead of bailing
    // needs_login — the discover bot would do exactly this, and a freshly-minted
    // robot account lands on the identifier page the first time a given relying
    // party requests OAuth even with a live session. Google-only for now (the
    // pool is Cloud Identity / google-provider); other providers fall through.
    const robotPassword = passwordForRobot({
      id: input.identity.id,
      email: input.identity.email,
    });
    const driveOAuthLogin =
      robotPassword !== null
        ? async (provider: OAuthProviderId): Promise<boolean> => {
            if (provider !== "google") return false;
            return browser.loginGoogleInline(input.identity.email, robotPassword);
          }
        : undefined;
    const replay = replaySkill({
      skill: input.skill,
      browser,
      mode: "full",
      bypassStatusGuard: true,
      profileDir: input.identity.profileDir,
      templateValues: verifierTemplateValues(input.skill, input.emailAlias),
      ...(preferredOAuthProvider !== undefined ? { preferredOAuthProvider } : {}),
      ...(input.fetchEmailCode !== undefined ? { fetchEmailCode: input.fetchEmailCode } : {}),
      ...(driveOAuthLogin !== undefined ? { driveOAuthLogin } : {}),
    });
    if (input.replayTimeoutMs === undefined) return await replay;
    return await Promise.race([
      replay,
      new Promise<ReplayOutcome>((resolve) =>
        setTimeout(
          () =>
            resolve({
              kind: "step_failed",
              stepIndex: 0,
              reason: `returning replay timed out after ${input.replayTimeoutMs}ms`,
              capturedStep: input.skill.steps[0] ?? {
                kind: "navigate",
                url: input.skill.signup_url,
                provenance: { run_id: "timeout", round_index: 0 },
              },
            }),
          input.replayTimeoutMs,
        ),
      ),
    ]);
  } finally {
    try {
      await browser.close();
    } catch {
      // shutdown noise — replay outcome is already captured
    }
  }
}

export async function runFreshVerify(
  input: RunFreshVerifyInput,
  cfg: RunFreshVerifyConfig = {},
): Promise<RunFreshVerifyResult> {
  const log = cfg.log ?? ((m: string) => console.error(m));
  const confidence = input.confidence ?? freshVerifyConfidenceFromEnv();
  const skill = await resolveSkill(input, cfg);
  if (skill.service !== input.service) {
    throw new Error(
      `fresh-verify service mismatch: input=${input.service} skill=${skill.service} (${skill.skill_id})`,
    );
  }
  const provider =
    input.oauthProvider ?? skill.oauth_provider ?? inferOAuthProviderFromSteps(skill) ?? "google";
  const skillId = input.skillId ?? skill.skill_id;
  const profileMode = input.profileMode ?? "fresh";

  if (profileMode === "returning") {
    const replay = cfg.replay ?? defaultReplayStoredSkill;
    const showOnceNames = skill.credentials
      .filter((c) => c.visibility === "show_once_at_creation")
      .map((c) => c.name ?? c.env_var_suggestion)
      .filter((v) => v.length > 0);
    if (showOnceNames.length > 0 && !skillCreatesFreshCredentialBeforeExtract(skill)) {
      const reason =
        `show_once_renewal_required: credential(s) [${showOnceNames.join(", ")}] ` +
        `are only visible at creation; returning verify must create a fresh app/key ` +
        `and extract the newly shown secret(s), not reread an old app.`;
      log(`[returning-verify] ${input.service}: ${reason}`);
      return {
        kind: "returning_verified",
        service: input.service,
        skillId,
        success: false,
        reason,
        outcome: {
          kind: "step_failed",
          stepIndex: 0,
          reason,
          capturedStep: skill.steps[0] ?? {
            kind: "navigate",
            url: skill.signup_url,
            provenance: { run_id: "show_once", round_index: 0 },
          },
        },
      };
    }
    const identity: FreshVerifyIdentity = {
      id: "returning-profile",
      email: "returning-profile@local",
      profileDir: CHROME_PROFILE_DIR,
      providers: [provider],
    };
    const emailAlias = `returning.${Date.now()}@trustysquire.com`;
    log(
      `[returning-verify] ${input.service}: replaying skill ${skillId} with shared profile ` +
        `${CHROME_PROFILE_DIR}`,
    );
    const outcome = await replay({
      skill,
      identity,
      emailAlias,
      preferredOAuthProvider: provider,
      replayTimeoutMs: returningVerifyTimeoutMs(),
    });
    const credential = firstCredentialFromReplay(outcome);
    const reason =
      credential === undefined ? describeReplayOutcomeForFreshVerify(outcome) : undefined;
    log(
      `[returning-verify] ${input.service}: ${credential !== undefined ? "PASS" : "FAIL"}` +
        (reason !== undefined ? ` (${reason})` : ""),
    );
    return {
      kind: "returning_verified",
      service: input.service,
      skillId,
      success: credential !== undefined,
      ...(credential !== undefined ? { credential } : {}),
      ...(reason !== undefined ? { reason } : {}),
      outcome,
    };
  }

  const poolConfigured = cfg.poolConfigured ?? verifyPoolConfigured;
  if (!poolConfigured()) {
    log(`[fresh-verify] no identity pool configured (verify-identities.json) — skipping ${input.service}`);
    return { kind: "not_configured", service: input.service };
  }

  const machineToken = cfg.machineToken ?? process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  const apiBase =
    cfg.apiBase ?? process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
  const accountId = cfg.accountId ?? process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
  if (machineToken === undefined || machineToken.length === 0) {
    throw new Error("fresh-verify needs TRUSTY_SQUIRE_MACHINE_TOKEN (LLM proxy + inbox)");
  }
  if (accountId === undefined || accountId.length === 0) {
    throw new Error("fresh-verify needs TRUSTY_SQUIRE_ACCOUNT_ID (inbox alias scope)");
  }

  const inboxClient = cfg.inboxClient ?? new InboxClient({ baseUrl: apiBase, apiKey: machineToken });
  const replay = cfg.replay ?? defaultReplayStoredSkill;
  const fetchEmailCode = makeEmailCodeFetcher(inboxClient as InboxClient);
  const loadPool =
    cfg.loadPool ??
    (() => ({
      identities: loadIdentities(),
      usage: loadUsage(),
    }));
  const replenish = cfg.replenish ?? replenishVerifyPool;
  const { identities, usage } = loadPool();

  // The sampler closure runs the stored Skill through THIS robot's profile (its
  // logged-in provider session) + egress. A fresh alias per run covers email
  // verification steps, but promotion evidence still comes only from replaying
  // the registry payload's steps.
  const runSignup = async (identity: FreshVerifyIdentity) => {
    let alias: string;
    try {
      alias = await inboxClient.createAlias({
        account_id: accountId,
        service: input.service,
        run_id: `${identity.id}-${Date.now()}`,
      });
    } catch {
      alias = `${identity.id}.${Date.now()}@trustysquire.com`; // best-effort; OAuth doesn't need it
    }
    const outcome = await replay({
      skill,
      identity,
      emailAlias: alias,
      preferredOAuthProvider: provider,
      fetchEmailCode,
    });
    const cred = firstCredentialFromReplay(outcome);
    return {
      success: cred !== undefined,
      ...(cred !== undefined ? { credential: cred } : {}),
      ...(cred === undefined ? { reason: describeReplayOutcomeForFreshVerify(outcome) } : {}),
    };
  };

  const runSampler = (
    pool: {
      identities: ReturnType<typeof loadIdentities>;
      usage: ReturnType<typeof loadUsage>;
    },
  ) =>
    freshVerifyService({
    service: input.service,
    provider,
    confidence,
    identities: pool.identities,
    usage: pool.usage,
    runSignup,
    markSpent: (id, svc) => recordSpent(id, svc, new Date().toISOString()),
    markUnspent: (id, svc) => recordUnspent(id, svc),
    log,
  });

  let result = await runSampler({ identities, usage });
  if (result.kind === "insufficient_identities") {
    log(
      `[fresh-verify] ${input.service}: insufficient identities — attempting on-demand verify-pool replenish`,
    );
    await replenish({
      log,
      force: true,
      rotateAll: true,
      maxPerPass: confidence.maxSamples,
    });
    result = await runSampler(loadPool());
  }
  if (
    result.kind === "verified" &&
    result.verdict === "hold" &&
    result.samples === 0 &&
    result.outcomes.length > 0 &&
    result.outcomes.every((o) => o.observation === "non_observation")
  ) {
    if (result.outcomes.some((o) => isProviderCapabilityBlocker(o.reason, provider))) {
      log(
        `[fresh-verify] ${input.service}: no informative samples because replay hit a ` +
          `provider/session blocker — not rotating the pool`,
      );
    } else {
    log(
      `[fresh-verify] ${input.service}: no informative samples after ${result.outcomes.length} ` +
        `robot attempt(s) — rotating verify pool and retrying once`,
    );
    await replenish({
      log,
      force: true,
      rotateAll: true,
      maxPerPass: confidence.maxSamples,
    });
    result = await runSampler(loadPool());
    }
  }

  // Report the converged posterior + verdict to the registry (D2.C). A `hold`
  // is NOT reported — it means "not enough signal this pass"; reporting it as a
  // failure would feed the demote path on no evidence. `promote` posts a
  // success outcome carrying verdict=promote; `reject` posts a failure carrying
  // the informative failure_kind so a genuine 0/N fresh failure can demote
  // instead of defaulting `transient`. The wire fields are additive — an older
  // registry that ignores them falls back to the count-based path on `kind`.
  if (result.kind === "verified") {
    if (result.verdict === "hold") {
      log(
        `[fresh-verify] ${input.service}: HOLD (LCB ${result.passRateLcb.toFixed(2)}/UCB ` +
          `${result.passRateUcb.toFixed(2)}, ${result.samples} sample(s)) — not reported (no-op)`,
      );
      return result;
    }
    const adminBearer = process.env.REGISTRY_ADMIN_BEARER;
    if (cfg.registry === undefined && (adminBearer === undefined || adminBearer.length === 0)) {
      log(
        `[fresh-verify] ${input.service}: no REGISTRY_ADMIN_BEARER — verdict computed ` +
          `(${result.verdict.toUpperCase()}) but not reported`,
      );
      return result;
    }
    try {
      const registry =
        cfg.registry ??
        new VerifierRegistryClient({
          baseUrl: process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
          adminBearer: adminBearer ?? "",
        });
      const trail = result.outcomes
        .map((o) => `${o.identityId}:${o.success ? "ok" : "fail"}/${o.observation}`)
        .join(", ");
      const res = await registry.postOutcome({
        skill_id: skillId,
        kind: result.verdict === "promote" ? "success" : "failure",
        reason:
          `fresh-skill-replay ${result.verdict} ` +
          `(${result.successes}✓/${result.failures}✗, LCB ${result.passRateLcb.toFixed(2)}/` +
          `UCB ${result.passRateUcb.toFixed(2)}, ${result.samples} sample(s)) [${trail}]`,
        verdict: result.verdict,
        samples: result.samples,
        successes: result.successes,
        failures: result.failures,
        pass_rate_lcb: result.passRateLcb,
        pass_rate_ucb: result.passRateUcb,
        ...(result.failureKind !== undefined ? { failure_kind: result.failureKind } : {}),
      });
      log(
        `[fresh-verify] ${input.service}: reported ${result.verdict.toUpperCase()} ` +
          `for skill ${skillId} → ${res.transition}`,
      );
      return { ...result, transition: res.transition };
    } catch (err) {
      log(`[fresh-verify] ${input.service}: outcome report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
