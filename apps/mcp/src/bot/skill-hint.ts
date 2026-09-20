// Login guidance can reflect live providers when a caller already has that
// information. Ordinary provision_start deliberately passes an empty list so
// starting unrelated browser work never probes Google identity.

import type { OAuthProviderId } from "./oauth-providers.js";

export function loginSessionGuidance(liveProviders: readonly OAuthProviderId[]): string {
  if (liveProviders.length === 0) {
    return (
      `- login: use whichever method the page offers (Google / GitHub / Microsoft / ` +
      `email). The account may already exist — log IN, don't re-sign-up.\n` +
      `- goal: for a signup or checkout goal, call operate_drive with the goal and ` +
      `facts rather than driving each click/type yourself; resume the same session ` +
      `with answer and/or added facts if it hands back.`
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
    `exist, so log IN, don't re-sign-up. If there's no such button, sign up with email.\n` +
    `- goal: for a signup or checkout goal, call operate_drive with the goal and ` +
    `facts rather than driving each click/type yourself; resume the same session ` +
    `with answer and/or added facts if it hands back.`
  );
}
