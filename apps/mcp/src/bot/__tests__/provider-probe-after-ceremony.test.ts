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
});
