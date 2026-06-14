// fresh-verify mode — verify a service by FRESH-signing-up as N independent
// robot identities and driving the verdict off the BOUNDED SEQUENTIAL-CONFIDENCE
// SAMPLER (D2), instead of a fixed 2-of-N count. See ../fresh-verify.ts for the
// sampler + orchestration core and ../identity-pool.ts for the fleet model.
//
// The verdict is computed HERE (housekeeper-side): the sampler updates a Beta
// posterior over the recipe's pass-rate from each genuine signup outcome,
// dropping flakes as non-observations, and converges to promote / reject / hold.
// We carry that whole posterior to the registry (samples, successes, failures,
// LCB/UCB, verdict, failure_kind) so the registry trusts the producer's
// converged verdict rather than re-deriving from a single success count.
//
// v1 scope: pure-OAuth Google services (the robots are Cloud Identity Free, no
// mailbox for email-OTP). Email-signup services keep using the alias path.

import { UniversalSignupBot, type SignupResult } from "../../bot/index.js";
import { pickLLMPair } from "../../bot/llm-client.js";
import { InboxClient } from "../../bot/inbox-client.js";
import type { OAuthProviderId } from "../../bot/oauth-providers.js";
import {
  loadIdentities,
  loadUsage,
  recordSpent,
  verifyPoolConfigured,
} from "../identity-pool.js";
import {
  freshVerifyService,
  freshVerifyConfidenceFromEnv,
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
  | { kind: "not_configured"; service: string };

export interface RunFreshVerifyInput {
  service: string;
  signupUrl?: string;
  oauthProvider?: OAuthProviderId; // default "google"
  skillId?: string; // when set, the converged verdict is reported to the registry
  // Sampler bounds override. Defaults to freshVerifyConfidenceFromEnv() so an
  // operator can calibrate promoteFloor / rejectCeiling / maxSamples via env
  // (FRESH_VERIFY_*) without a deploy. See ../fresh-verify.ts for the UNTUNED
  // default bounds and the calibration note.
  confidence?: ConfidenceOpts;
}

export interface RunFreshVerifyConfig {
  machineToken?: string;
  apiBase?: string;
  accountId?: string;
  bot?: { signup: UniversalSignupBot["signup"] };
  inboxClient?: { createAlias: InboxClient["createAlias"] };
  registry?: { postOutcome: VerifierRegistryClient["postOutcome"] };
  log?: (msg: string) => void;
}

// Pull the first credential value out of a successful SignupResult.
function firstCredential(result: SignupResult): string | undefined {
  if (!result.success || result.credentials === undefined) return undefined;
  const vals = Object.values(result.credentials).filter((v) => typeof v === "string" && v.length > 0);
  return vals.length > 0 ? vals[0] : undefined;
}

export async function runFreshVerify(
  input: RunFreshVerifyInput,
  cfg: RunFreshVerifyConfig = {},
): Promise<RunFreshVerifyResult> {
  const log = cfg.log ?? ((m: string) => console.error(m));
  const provider = input.oauthProvider ?? "google";
  const confidence = input.confidence ?? freshVerifyConfidenceFromEnv();

  if (!verifyPoolConfigured()) {
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
  const bot = cfg.bot ?? new UniversalSignupBot();
  const identities = loadIdentities();
  const usage = loadUsage();

  // The signup closure the orchestrator runs per identity: drive the bot through
  // THIS robot's profile (its logged-in Google session) + egress. A fresh alias
  // per run covers any incidental email step; OAuth identity is the Google
  // session in profileDir.
  const runSignup = async (identity: (typeof identities)[number]) => {
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
    const result = await bot.signup({
      service: input.service,
      ...(input.signupUrl !== undefined ? { signupUrl: input.signupUrl } : {}),
      email: alias,
      inbox: inboxClient as InboxClient,
      llm: pickLLMPair({ preferCheap: true }),
      oauthProvider: provider,
      machineToken,
      apiBase,
      // The robots are the operator's own identities — approve a benign
      // (identity-only) OAuth consent blind, exactly like the discover path.
      // The DOM danger-phrase scraper still HARD-ABORTS on sensitive scope
      // grants (Drive/Gmail/contacts), so this only auto-approves name/email.
      allowBlindOAuthConsent: true,
      // Sign up AS this robot's own Google account if its profile ever shows a
      // chooser (robot profiles are single-account, so this is belt-and-braces).
      oauthAccountEmail: identity.email,
      // The identity binding — THE point of fresh-verify.
      profileDir: identity.profileDir,
      ...(identity.proxyUrl !== undefined ? { proxyUrl: identity.proxyUrl } : {}),
    });
    const cred = firstCredential(result);
    return {
      success: result.success === true && cred !== undefined,
      ...(cred !== undefined ? { credential: cred } : {}),
      ...(result.success !== true ? { reason: result.error ?? "signup_failed" } : {}),
    };
  };

  const result = await freshVerifyService({
    service: input.service,
    provider,
    confidence,
    identities,
    usage,
    runSignup,
    markSpent: (id, svc) => recordSpent(id, svc, new Date().toISOString()),
    log,
  });

  // Report the converged posterior + verdict to the registry (D2.C). A `hold`
  // is NOT reported — it means "not enough signal this pass"; reporting it as a
  // failure would feed the demote path on no evidence. `promote` posts a
  // success outcome carrying verdict=promote; `reject` posts a failure carrying
  // the informative failure_kind so a genuine 0/N fresh failure can demote
  // instead of defaulting `transient`. The wire fields are additive — an older
  // registry that ignores them falls back to the count-based path on `kind`.
  if (input.skillId !== undefined && result.kind === "verified") {
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
        skill_id: input.skillId,
        kind: result.verdict === "promote" ? "success" : "failure",
        reason:
          `fresh-verify ${result.verdict} ` +
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
          `for skill ${input.skillId} → ${res.transition}`,
      );
      return { ...result, transition: res.transition };
    } catch (err) {
      log(`[fresh-verify] ${input.service}: outcome report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
