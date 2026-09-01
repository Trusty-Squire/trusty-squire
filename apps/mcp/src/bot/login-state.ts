// login-state.ts — records which OAuth providers the bot holds a
// session for. `mcp login` establishes the session in the persistent
// Chrome profile; this marker lets the signup bot know — without an
// expensive provider round-trip — which providers it can auto-prefer
// for OAuth-first signup.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHROME_PROFILE_DIR,
  currentProfileHolderPid,
  launchWithProfileGate,
  profileProcessIdentity,
  ProfileBusyError,
  withProfileOperationGuard,
} from "./profile.js";
import { type OAuthProviderId } from "./oauth-providers.js";
import { invalidateCanonicalGoogleIdentity, isSessionStateArtifact } from "./session-state.js";
import { closeBrowserContextWithin, registerLocalBrowserLaunch } from "./browser.js";
import {
  bindOwnerBrowserLaunch,
  markOwnerBrowserLaunchTerminal,
  terminateOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "./owner-process-reaper.js";

interface ProviderCookieContext {
  cookies(): Promise<Array<{ name: string; domain: string; path: string }>>;
  clearCookies(options: { name: string; domain: string; path: string }): Promise<void>;
  close(): Promise<void>;
}

function cookieBelongsToProvider(domain: string, provider: OAuthProviderId): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  const root = provider === "google" ? "google.com" : "github.com";
  return normalized === root || normalized.endsWith(`.${root}`);
}

export async function clearProviderCookiesFromContext(
  context: ProviderCookieContext,
  provider?: OAuthProviderId,
): Promise<boolean> {
  const belongs = (domain: string): boolean =>
    provider === undefined
      ? cookieBelongsToProvider(domain, "google") || cookieBelongsToProvider(domain, "github")
      : cookieBelongsToProvider(domain, provider);
  const targets = (await context.cookies()).filter((cookie) => belongs(cookie.domain));
  for (const cookie of targets) {
    await context.clearCookies({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
    });
  }
  return !(await context.cookies()).some((cookie) => belongs(cookie.domain));
}

// PR3 signin-vault: the email of the account logged into the profile, per
// provider, captured AT LOGIN (the one moment it's certain). The operator fills
// this as the signup email so accounts are user-owned, and it is the SAME
// account whose inbox awaitVerification reads (browser-sourced → fill-email and
// read-inbox are consistent by construction). Separate file so the provider
// array format above is unchanged.
function emailMarkerPath(profileDir: string): string {
  return join(profileDir, "provider-emails.json");
}

// The captured email for `provider`, or null. Best-effort; never throws.
export function loggedInEmail(
  provider: OAuthProviderId,
  profileDir: string = CHROME_PROFILE_DIR,
): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(emailMarkerPath(profileDir), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const v = (parsed as Record<string, unknown>)[provider];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// Record the logged-in email for `provider`. Idempotent overwrite. Best-effort.
export function recordProviderEmail(
  provider: OAuthProviderId,
  email: string,
  profileDir: string = CHROME_PROFILE_DIR,
): void {
  if (email.length === 0) return;
  try {
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(emailMarkerPath(profileDir), "utf8"));
      if (parsed !== null && typeof parsed === "object")
        current = parsed as Record<string, unknown>;
    } catch {
      /* no marker yet */
    }
    current[provider] = email;
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(emailMarkerPath(profileDir), JSON.stringify(current), "utf8");
  } catch {
    /* best-effort — provision can still proceed, just without a pre-known email */
  }
}

// Wipe Google + GitHub cookies through a short-lived Chrome context. This uses
// Chrome's own cookie API, so it works on every supported Node version and can
// verify the targeted rows are actually gone before the plain, non-CDP OAuth
// browser starts.
export async function clearProviderCookies(
  profileDir: string = CHROME_PROFILE_DIR,
  provider?: OAuthProviderId,
  runtime: {
    loadChromium?: () => Promise<{
      launchPersistentContext(
        profileDir: string,
        options: Record<string, unknown>,
      ): Promise<ProviderCookieContext>;
    }>;
    registerLaunch?: typeof registerLocalBrowserLaunch;
    markTerminal?: typeof markOwnerBrowserLaunchTerminal;
    terminate?: typeof terminateOwnerBrowserLaunch;
    untrack?: typeof untrackOwnerBrowserLaunch;
    bindLaunch?: (marker: string, profileDir: string) => boolean;
    closeTimeoutMs?: number;
  } = {},
): Promise<boolean> {
  return await withProfileOperationGuard(profileDir, async () => {
    let context: ProviderCookieContext | null = null;
    let ownership: { marker: string; env: NodeJS.ProcessEnv } | null = null;
    let cleared = false;
    let lifecycleClosed = true;
    try {
      const chromium = (await runtime.loadChromium?.()) ?? (await import("patchright")).chromium;
      context = await launchWithProfileGate(
        profileDir,
        () => {
          ownership = (runtime.registerLaunch ?? registerLocalBrowserLaunch)(profileDir);
          return chromium.launchPersistentContext(profileDir, {
            channel: "chrome",
            headless: true,
            env: ownership.env,
          });
        },
        { failFast: true },
      );
      const registeredOwnership = ownership as {
        marker: string;
        env: NodeJS.ProcessEnv;
      } | null;
      const bindLaunch =
        runtime.bindLaunch ??
        ((marker: string, ownedProfileDir: string): boolean => {
          if (process.platform !== "linux") return true;
          const holderPid = currentProfileHolderPid(ownedProfileDir);
          const identity =
            holderPid === null ? null : profileProcessIdentity(holderPid, ownedProfileDir);
          return identity !== null && bindOwnerBrowserLaunch(marker, identity);
        });
      if (registeredOwnership === null || !bindLaunch(registeredOwnership.marker, profileDir)) {
        throw new Error("cookie-clear browser identity could not be bound to owner custody");
      }
      cleared = await clearProviderCookiesFromContext(context, provider);
      if (!cleared) return false;
      if (provider === undefined || provider === "google") {
        cleared = await invalidateCanonicalGoogleIdentity(profileDir);
      }
    } catch (err) {
      if (err instanceof ProfileBusyError) throw err;
      cleared = false;
    } finally {
      const registeredOwnership = ownership as {
        marker: string;
        env: NodeJS.ProcessEnv;
      } | null;
      if (registeredOwnership === null) {
        if (context !== null) await closeBrowserContextWithin(context, runtime.closeTimeoutMs);
      } else {
        const marker = registeredOwnership.marker;
        (runtime.markTerminal ?? markOwnerBrowserLaunchTerminal)(marker);
        if (context !== null) await closeBrowserContextWithin(context, runtime.closeTimeoutMs);
        lifecycleClosed = await (runtime.terminate ?? terminateOwnerBrowserLaunch)(
          marker,
          profileDir,
        ).catch(() => false);
        if (lifecycleClosed) (runtime.untrack ?? untrackOwnerBrowserLaunch)(marker);
      }
    }
    return cleared && lifecycleClosed;
  });
}

// Wipe the whole bot Chrome profile. Used only for `connect --force-relogin`:
// switching accounts must clear provider cookies AND Trusty Squire's own app
// session, otherwise the confirm page can reuse the old account and skip the
// Google credential prompt.
export function clearBrowserProfile(profileDir: string = CHROME_PROFILE_DIR): void {
  try {
    mkdirSync(profileDir, { recursive: true });
    for (const entry of readdirSync(profileDir)) {
      if (isSessionStateArtifact(entry)) continue;
      rmSync(join(profileDir, entry), { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}
