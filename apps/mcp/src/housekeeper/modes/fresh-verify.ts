// fresh-verify mode — verify a service by FRESH-signing-up as N independent
// robot identities (2-of-N agreement), instead of replaying the recipe against
// the one returning-user account. See ../fresh-verify.ts for the orchestration
// core and ../identity-pool.ts for the fleet model.
//
// The 2-of-N agreement gate is enforced HERE (housekeeper-side): we only report
// a `success` verifier-outcome to the registry when `agreement` independent
// identities each produced a credential. So the registry's existing
// promote-on-success path keeps working, but "success" now means "N independent
// fresh users agreed" — a strictly higher bar — with no registry-app change.
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
import { freshVerifyService, type FreshVerifyResult } from "../fresh-verify.js";
import { VerifierRegistryClient } from "../registry-client.js";

export interface RunFreshVerifyInput {
  service: string;
  signupUrl?: string;
  oauthProvider?: OAuthProviderId; // default "google"
  skillId?: string; // when set, the consolidated verdict is reported to the registry
  agreement?: number; // default 2
  // Extra identities spent retrying TRANSIENT failures (timing flakes) toward the
  // agreement bar before giving up — kills per-run variance where one unlucky
  // robot fails a recipe that reproduces. Hard walls (no signup, SSO, anti-bot)
  // still short-circuit. Default 2.
  retryBudget?: number;
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
): Promise<FreshVerifyResult | { kind: "not_configured"; service: string }> {
  const log = cfg.log ?? ((m: string) => console.error(m));
  const provider = input.oauthProvider ?? "google";
  const agreement = input.agreement ?? 2;
  const retryBudget = input.retryBudget ?? 2;

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
    agreement,
    retryBudget,
    identities,
    usage,
    runSignup,
    markSpent: (id, svc) => recordSpent(id, svc, new Date().toISOString()),
    log,
  });

  // Report the consolidated verdict (the 2-of-N gate) to the registry.
  if (input.skillId !== undefined && result.kind === "verified") {
    const adminBearer = process.env.REGISTRY_ADMIN_BEARER;
    if (cfg.registry === undefined && (adminBearer === undefined || adminBearer.length === 0)) {
      log(`[fresh-verify] ${input.service}: no REGISTRY_ADMIN_BEARER — verdict computed (${result.promoted ? "PROMOTE" : "hold"}) but not reported`);
      return result;
    }
    try {
      const registry =
        cfg.registry ??
        new VerifierRegistryClient({
          baseUrl: process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? "https://registry.trustysquire.ai",
          adminBearer: adminBearer ?? "",
        });
      const agreed = result.outcomes.filter((o) => o.success).length;
      await registry.postOutcome({
        skill_id: input.skillId,
        kind: result.promoted ? "success" : "failure",
        reason: `fresh-verify ${agreed}/${agreement} independent identities agreed (${result.outcomes
          .map((o) => `${o.identityId}:${o.success ? "ok" : "fail"}`)
          .join(", ")})`,
      });
      log(`[fresh-verify] ${input.service}: reported ${result.promoted ? "success" : "failure"} for skill ${input.skillId}`);
    } catch (err) {
      log(`[fresh-verify] ${input.service}: outcome report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
