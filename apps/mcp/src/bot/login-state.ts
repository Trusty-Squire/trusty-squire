// login-state.ts — records which OAuth providers the bot holds a
// session for. `mcp login` establishes the session in the persistent
// Chrome profile; this marker lets the signup bot know — without an
// expensive provider round-trip — which providers it can auto-prefer
// for OAuth-first signup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHROME_PROFILE_DIR } from "./profile.js";
import { isOAuthProviderId, type OAuthProviderId } from "./oauth-providers.js";

function markerPath(profileDir: string): string {
  return join(profileDir, "logged-in-providers.json");
}

// Providers with a confirmed session in the profile. Best-effort: a
// missing or malformed marker yields []. Never throws.
export function loggedInProviders(
  profileDir: string = CHROME_PROFILE_DIR,
): OAuthProviderId[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath(profileDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is OAuthProviderId =>
        typeof v === "string" && isOAuthProviderId(v),
    );
  } catch {
    return [];
  }
}

// Record that `provider` has a confirmed session. Idempotent. Best-
// effort: a write failure is swallowed — the bot still works, it just
// won't auto-prefer this provider until the next successful login.
export function markProviderLoggedIn(
  provider: OAuthProviderId,
  profileDir: string = CHROME_PROFILE_DIR,
): void {
  try {
    const providers = new Set(loggedInProviders(profileDir));
    if (providers.has(provider)) return;
    providers.add(provider);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(markerPath(profileDir), JSON.stringify([...providers]), "utf8");
  } catch {
    /* best-effort — auto-prefer just won't kick in for this provider */
  }
}
