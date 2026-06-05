// unwinnable-services.ts — services the bot should NOT attempt (AB6).
//
// A handful of services are a 0% prospect for automated signup, for reasons
// that are NOT our bug and won't change by re-running: their own SPA refuses to
// initialize under automation, their own dashboard runs maximum anti-bot, or
// the API token sits behind a human gate (SMS, authenticator TOTP, a credit
// card). Driving the bot at them wastes ~6 minutes + LLM calls per run and adds
// nothing. classifyUnwinnable lets the entry point short-circuit to a clear
// `manual_signup_required` outcome before launching Chrome.
//
// This is a curated denylist, not a heuristic — edit it as gates change (e.g.
// drop the sms_phone entries once F12's relay ships and the bot can clear them).

export type ManualGate =
  // the service's own SPA won't init/complete under automation (not bot-detection)
  | "spa_broken"
  // the service's own dashboard runs maximum Turnstile + IP risk-score
  | "max_antibot"
  // phone + SMS-code wall (carrier-lookup rejects VoIP); F12 relay or operator
  | "sms_phone"
  // authenticator TOTP enrolment required
  | "totp"
  // a credit card is required before the API token is reachable
  | "credit_card"
  // GitHub install-time sudo-2FA on the OAuth app (operator-only)
  | "github_2fa";

export interface ManualRoute {
  gate: ManualGate;
  reason: string;
}

// Keyed by the normalized service slug.
const UNWINNABLE: Readonly<Record<string, ManualRoute>> = {
  clerk: {
    gate: "spa_broken",
    reason:
      "Clerk's dashboard SPA won't initialize/complete under automation " +
      "(reproduced with AND without the residential proxy — not bot-detection).",
  },
  cloudflare: {
    gate: "max_antibot",
    reason:
      "Cloudflare's own dashboard runs maximum Turnstile + IP risk-score; " +
      "manual signup is the realistic call.",
  },
  vercel: {
    gate: "sms_phone",
    reason: "API tokens gated behind phone + SMS verification — needs the F12 relay or the operator.",
  },
  mailersend: {
    gate: "sms_phone",
    reason: "Signup completes but stops at a phone-verification wall — F12 relay or operator.",
  },
  twilio: {
    gate: "sms_phone",
    reason: "Phone + SMS verification required before API access — F12 relay or operator.",
  },
  sendgrid: {
    gate: "sms_phone",
    reason: "Phone/SMS + (historically) credit-card gate before API key access.",
  },
  mailgun: {
    gate: "credit_card",
    reason: "Credit card / phone verification required before the API key is reachable.",
  },
  circleci: {
    gate: "credit_card",
    reason: "Credit-card gate on token access.",
  },
  betterstack: {
    gate: "credit_card",
    reason: "Credit-card gate before the API token.",
  },
  northflank: {
    gate: "github_2fa",
    reason:
      "Signup needs a GitHub-app install with install-time sudo-2FA — operator-only, " +
      "not automatable.",
  },
};

function normalizeSlug(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Returns the manual route for an unwinnable service, or null. Matches on the
// normalized slug AND a hyphen-stripped form so "BetterStack" / "better-stack"
// / "betterstack" all resolve.
export function classifyUnwinnable(service: string): ManualRoute | null {
  const slug = normalizeSlug(service);
  return UNWINNABLE[slug] ?? UNWINNABLE[slug.replace(/-/g, "")] ?? null;
}
