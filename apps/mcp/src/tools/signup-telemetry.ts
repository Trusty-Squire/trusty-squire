// Shared post-signup telemetry emit — the one place a finished bot run
// turns into registry + API analytics events. BOTH call paths funnel
// through here so the event shapes can't drift:
//   - the `provision` MCP tool (provision-any.ts, end-user signups)
//   - the housekeeper discover worker (modes/discover.ts, operator harvest)
//
// Before this module the captcha-event POST lived only in provision-any,
// so the discover path emitted NEITHER a ProvisionEvent NOR a
// CaptchaEvent — the operator dashboard was blind to every harvest run
// (Codex review, DESIGN-antibot-hardening.md D1). Everything here is
// fire-and-forget + fail-open: it never blocks or fails a signup.

import { isWallFailure } from "@trusty-squire/skill-schema";
import { detectAsn, type CaptchaVariant, type CaptchaKind } from "../bot/index.js";
import { VERSION } from "../version.js";
import type { SkillRegistryClient } from "../skill-registry-client.js";

// A "wall" failure (terminal anti-bot challenge → blocked, not failed)
// is classified by the shared failure taxonomy in
// @trusty-squire/skill-schema — the SAME definition the registry demand
// damper and demotion classifier use, so they can't drift. isWallFailure
// matches the leading token, so suffixed kinds
// ("anti_bot_blocked: Cloudflare on SSO callback") still classify as
// walls. See DESIGN-antibot-hardening.md + DESIGN-closed-loop-remediation.md.
export function finalOutcomeOf(result: {
  success: boolean;
  error?: string;
}): "ok" | "failed" | "blocked" {
  if (result.success) return "ok";
  return isWallFailure(result.error) ? "blocked" : "failed";
}

// Single ProvisionEvent emit (design Decision 1). Every terminal path —
// replay-served, bot, and the housekeeper discover worker — funnels
// through this one mapper so the event shape can't drift across call
// sites. Fail-open. Observation only; auto-demote still rides on
// postReplayOutcome (the source-of-truth rule).
//
// Returns the underlying POST promise so callers choose their completion
// model: the long-running `provision` server fire-and-forgets
// (`void emitProvisionEvent(...)`); the housekeeper `--once` path AWAITS
// it, because that process calls process.exit() right after the batch and
// would otherwise kill the in-flight POST before it lands.
export function emitProvisionEvent(
  registry: SkillRegistryClient,
  args: {
    service: string;
    provisionId: string;
    startedAt: number;
    initialStrategy: "replay" | "bot";
    finalStrategy: "replay" | "bot";
    replayOutcome: "ok" | "miss" | "na";
    result: { success: boolean; error?: string };
    signupUrl?: string;
    stepTrail?: string;
    replayServed: boolean;
    // Memory-overhaul Phase 1 — housekeeper context ("discover"|"verify"|
    // "replay") + captcha summary (partial fold; same data the detailed
    // CaptchaEvent carries to the API). Both optional.
    mode?: "discover" | "verify" | "replay";
    captcha?: { kind?: string; variant?: string; blocked?: boolean };
  },
): Promise<unknown> {
  return registry.recordProvisionEvent({
    service: args.service,
    status: args.result.success ? "success" : "failed",
    initialStrategy: args.initialStrategy,
    finalStrategy: args.finalStrategy,
    replayOutcome: args.replayOutcome,
    finalOutcome: finalOutcomeOf(args.result),
    ...(args.result.success === false && args.result.error !== undefined
      ? { failureKind: args.result.error }
      : {}),
    ...(args.signupUrl !== undefined ? { signupUrl: args.signupUrl } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.captcha?.kind !== undefined ? { captchaKind: args.captcha.kind } : {}),
    ...(args.captcha?.variant !== undefined ? { captchaVariant: args.captcha.variant } : {}),
    ...(args.captcha?.blocked !== undefined ? { captchaBlocked: args.captcha.blocked } : {}),
    provisionId: args.provisionId,
    ...(args.stepTrail !== undefined ? { stepTrail: args.stepTrail } : {}),
    // Replay is LLM/captcha-free → known-zero cost. The bot path leaves
    // these unset; USD cost is tracked server-side (LLMUsageEvent), not
    // known here.
    ...(args.replayServed ? { llmCost: 0, captchaCost: 0 } : {}),
    mcpVersion: VERSION,
    durationMs: Date.now() - args.startedAt,
  });
}

// Best-effort POST to /v1/captcha-events. We don't care about the
// response — at worst the event is lost, which is no worse than the
// pre-instrumentation state. Captures fresh asn at event time when
// possible; the API also falls back to the install-time asn from the
// MachineToken row if we can't supply one here. `stealth_profile` tags
// which launcher ran so the CDP-hardening A/B is measurable.
export async function postCaptchaEvent(
  apiBase: string,
  machineToken: string,
  event: {
    service: string;
    captcha_kind: CaptchaKind;
    blocked: boolean;
    proxied: boolean;
    captcha_variant: CaptchaVariant;
    challenge_rendered: boolean;
    signup_succeeded: boolean;
    stealth_profile?: "baseline" | "cdp_hardened";
  },
): Promise<void> {
  try {
    const asn = await detectAsn();
    const body = {
      service: event.service,
      captcha_kind: event.captcha_kind,
      blocked: event.blocked,
      proxied: event.proxied,
      captcha_variant: event.captcha_variant,
      challenge_rendered: event.challenge_rendered,
      signup_succeeded: event.signup_succeeded,
      ...(event.stealth_profile !== undefined
        ? { stealth_profile: event.stealth_profile }
        : {}),
      ...(asn !== null
        ? {
            asn: { class: asn.class, org: asn.org, country: asn.country, number: asn.asn },
          }
        : {}),
    };
    await fetch(`${apiBase}/v1/captcha-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-machine-token": machineToken,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[signup-telemetry] captcha event report failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
