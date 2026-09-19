// `connect`'s post-ceremony success gate must not fail BECAUSE the ceremony
// won the broker path: the broker's Chrome still holds the profile operation
// lease when the probe runs, so the live-probe attempt comes back
// ProfileBusyError. The gate then falls back to the committed-cookie snapshot,
// polling past Chrome's ~30s cookie-commit lag — the same presence-only
// evidence class the preflight "Already connected" answer already accepts. A
// non-busy probe failure is NOT a pass (null).

import { describe, expect, it, vi } from "vitest";
import { ProfileBusyError } from "../profile.js";
import { probeProviderSessionsAfterCeremony } from "../google-login.js";
import type { OAuthProviderId } from "../oauth-providers.js";

describe("probeProviderSessionsAfterCeremony", () => {
  it("returns the live probe when the profile is free", async () => {
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => ["google"],
    });
    expect(result).toEqual(["google"]);
  });

  it("returns null when the live probe fails for a non-busy reason", async () => {
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new Error("boom");
      },
    });
    expect(result).toBeNull();
  });

  it("falls back to the cookie snapshot when the profile is busy", async () => {
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => ["github"]);
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 5_000,
    });
    expect(result).toEqual(["github"]);
    expect(snapshot).toHaveBeenCalled();
  });

  it("keeps polling the snapshot while the commit window is open", async () => {
    let calls = 0;
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => {
      calls++;
      return calls >= 3 ? ["google"] : [];
    });
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 10_000,
      pollMs: 1,
    });
    expect(result).toEqual(["google"]);
    expect(calls).toBe(3);
  });

  it("reports an honest negative once the window closes with nothing committed", async () => {
    const snapshot = vi.fn(async () => []);
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 30,
      pollMs: 10,
    });
    expect(result).toEqual([]);
  });

  it("keeps polling until the AWAITED provider commits, not just any provider", async () => {
    // The scoped --force-relogin github refresh: Google's days-old cookies
    // are already committed, so a first-non-empty early return would accept
    // ["google"] and fail the gate for the provider the run refreshed.
    let calls = 0;
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => {
      calls++;
      return calls >= 3 ? ["google", "github"] : ["google"];
    });
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 10_000,
      pollMs: 1,
      awaitProviders: ["github"],
    });
    expect(result).toEqual(["google", "github"]);
    expect(calls).toBe(3);
  });

  it("returns the partial snapshot when the awaited provider never commits in the window", async () => {
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => ["google"]);
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 30,
      pollMs: 10,
      awaitProviders: ["github"],
    });
    expect(result).toEqual(["google"]);
  });

  it("returns null — not a definite negative — when every snapshot read throws", async () => {
    // The review round-11 fix: `.catch(() => [])` turned a snapshot READ
    // FAILURE into "no provider session", collapsing the absent-vs-unreadable
    // distinction. A store that exists and cannot be read is unknown, and
    // unknown is not a pass and not a re-pair trigger.
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => {
      throw new Error("database disk image is malformed");
    });
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 30,
      pollMs: 10,
    });
    expect(result).toBeNull();
  });

  it("keeps polling past a failed read and recovers when a later one succeeds", async () => {
    let calls = 0;
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => {
      calls++;
      if (calls === 1) throw new Error("store busy");
      return ["google"];
    });
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 10_000,
      pollMs: 1,
    });
    expect(result).toEqual(["google"]);
    expect(calls).toBe(2);
  });

  it("keeps polling through failed reads and returns the last good read at the deadline", async () => {
    let calls = 0;
    const snapshot = vi.fn(async (): Promise<OAuthProviderId[]> => {
      calls++;
      return calls <= 2 ? ["google"] : await Promise.reject(new Error("store busy"));
    });
    const result = await probeProviderSessionsAfterCeremony("/unused", {
      live: async () => {
        throw new ProfileBusyError("busy");
      },
      snapshot,
      windowMs: 30,
      pollMs: 10,
      awaitProviders: ["github"],
    });
    expect(result).toEqual(["google"]);
  });
});
