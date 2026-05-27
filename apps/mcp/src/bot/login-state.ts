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

// Drop `provider` from the confirmed-session marker. Called when an
// OAuth flow aborted with needs_login — the previously-recorded
// session is no longer usable. Next signup then falls back to
// form-fill instead of optimistically retrying OAuth and failing the
// same way. Idempotent + best-effort.
export function clearProviderLoggedIn(
  provider: OAuthProviderId,
  profileDir: string = CHROME_PROFILE_DIR,
): void {
  try {
    const providers = loggedInProviders(profileDir).filter((p) => p !== provider);
    writeFileSync(markerPath(profileDir), JSON.stringify(providers), "utf8");
  } catch {
    /* best-effort */
  }
}

// Wipe the marker entirely. Used by `connect --force-relogin` so the
// step-2/2 prompt reflects THIS run's actual cookie state instead of
// silently relying on the union of every prior session. Best-effort.
export function clearAllProviderMarkers(
  profileDir: string = CHROME_PROFILE_DIR,
): void {
  try {
    writeFileSync(markerPath(profileDir), JSON.stringify([]), "utf8");
  } catch {
    /* best-effort */
  }
}

// Wipe Google + GitHub cookies from the Chrome profile's SQLite
// Cookies DB. Used by `connect --force-relogin` so the next OAuth
// flow actually runs (instead of short-circuiting because the
// provider session is still cached). MUST be called BEFORE Chrome
// starts — the DB is locked while Chrome is running. Best-effort:
// any error (no DB yet, locked, sqlite unavailable) is swallowed
// so the install can still proceed.
export async function clearProviderCookies(
  profileDir: string = CHROME_PROFILE_DIR,
): Promise<void> {
  const dbPath = join(profileDir, "Default", "Cookies");
  try {
    // Use node:sqlite (Node 22+). Falls back to a no-op if the
    // module isn't available on this Node version.
    const sqlite = await import("node:sqlite").catch(() => null);
    if (sqlite === null) return;
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec(
        "DELETE FROM cookies WHERE " +
          "host_key LIKE '%google.com%' OR " +
          "host_key LIKE '%github.com%';",
      );
    } finally {
      db.close();
    }
  } catch {
    /* best-effort — Chrome might be holding the lock, or the DB
       doesn't exist yet on first install. The OAuth flow will still
       work; it just won't be forced this run. */
  }
}
