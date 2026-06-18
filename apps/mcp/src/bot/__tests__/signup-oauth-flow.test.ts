import { describe, expect, it, vi } from "vitest";
import type { OAuthProviderId } from "../oauth-providers.js";
import { SignupOAuthFlow } from "../signup-oauth-flow.js";

function markerStore(initial: OAuthProviderId[] = []) {
  let providers = [...initial];
  return {
    loggedInProviders: vi.fn(() => [...providers]),
    markProviderLoggedIn: vi.fn((provider: OAuthProviderId) => {
      if (!providers.includes(provider)) providers.push(provider);
    }),
    clearProviderLoggedIn: vi.fn((provider: OAuthProviderId) => {
      providers = providers.filter((p) => p !== provider);
    }),
    snapshot: () => [...providers],
  };
}

describe("SignupOAuthFlow provider session truth", () => {
  it("uses live browser sessions as truth and reconciles stale markers", async () => {
    const markers = markerStore(["github"]);
    const flow = new SignupOAuthFlow(
      {
        detectSessionProviders: vi.fn(
          async (): Promise<OAuthProviderId[]> => ["google"],
        ),
      },
      markers,
    );

    await expect(flow.effectiveLoggedInProviders()).resolves.toEqual(["google"]);
    expect(markers.markProviderLoggedIn).toHaveBeenCalledWith("google");
    expect(markers.clearProviderLoggedIn).toHaveBeenCalledWith("github");
    expect(markers.snapshot()).toEqual(["google"]);
  });

  it("falls back to markers when the live provider probe fails", async () => {
    const markers = markerStore(["github"]);
    const flow = new SignupOAuthFlow(
      {
        detectSessionProviders: vi.fn(async () => {
          throw new Error("probe failed");
        }),
      },
      markers,
    );

    await expect(flow.effectiveLoggedInProviders()).resolves.toEqual(["github"]);
    expect(markers.markProviderLoggedIn).not.toHaveBeenCalled();
    expect(markers.clearProviderLoggedIn).not.toHaveBeenCalled();
  });
});
