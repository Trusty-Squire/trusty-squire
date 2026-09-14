// Login guidance built from the user's ACTUAL live sessions (the bot knows
// which providers are authenticated — detectSessionProviders). Google is
// preferred when multiple sessions exist. This is session-state, so it's
// composed at provision_start.

import type { OAuthProviderId } from "./oauth-providers.js";

export function loginSessionGuidance(liveProviders: readonly OAuthProviderId[]): string {
  if (liveProviders.length === 0) {
    return (
      `- login: use whichever method the page offers (Google / GitHub / Microsoft / ` +
      `email). The account may already exist — log IN, don't re-sign-up.`
    );
  }
  const preferred: OAuthProviderId = liveProviders.includes("google")
    ? "google"
    : (liveProviders[0] as OAuthProviderId);
  const ordered = [preferred, ...liveProviders.filter((p) => p !== preferred)];
  // Hedge on what the PAGE offers — this is session-state, composed before the
  // page is seen, so it can't assume an OAuth button exists. Telling the agent to
  // "use google" on an email-only signup (Postmark) sent it chasing a button that
  // wasn't there. Prefer the session provider IF offered; else fall back to email.
  return (
    `- login: the user has a live session for ${ordered.join(", ")} (prefer "${preferred}"). ` +
    `IF the page offers one of those as a sign-in option, use it — the account may already ` +
    `exist, so log IN, don't re-sign-up. If there's no such button, sign up with email.`
  );
}