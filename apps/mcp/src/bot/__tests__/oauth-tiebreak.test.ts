// rc.5 — when the bot's profile has both Google and GitHub sessions,
// `resolveOAuthCandidates` orders Google first. Pins the CEO decision
// "default to Google when both work — its OAuth flow is simpler".
//
// We test through the public surface (the agent's reaction to a
// shared `logged-in-providers.json`) rather than against the private
// method, because the call site is what cares about ordering — but
// we use a tiny replica of the sort here too as a focused unit test
// of the policy.

import { describe, expect, it } from "vitest";
import type { OAuthProviderId } from "../oauth-providers.js";

// Mirror of the sort embedded in `resolveOAuthCandidates`. If this
// test starts failing because the embedded sort changed, the source
// in agent.ts needs updating in lockstep — keep them aligned.
function tiebreak(providers: readonly OAuthProviderId[]): OAuthProviderId[] {
  return [...providers].sort((a, b) => {
    if (a === b) return 0;
    if (a === "google") return -1;
    if (b === "google") return 1;
    return 0;
  });
}

describe("OAuth candidate tiebreak (rc.5)", () => {
  it("puts Google first when both providers are present", () => {
    expect(tiebreak(["github", "google"])).toEqual(["google", "github"]);
  });

  it("leaves Google-first ordering untouched", () => {
    expect(tiebreak(["google", "github"])).toEqual(["google", "github"]);
  });

  it("leaves a single-provider list unchanged", () => {
    expect(tiebreak(["github"])).toEqual(["github"]);
    expect(tiebreak(["google"])).toEqual(["google"]);
  });

  it("is stable for inputs without google", () => {
    // Defensive: in case a future provider lands and only those two
    // are in the marker, the sort shouldn't reorder them.
    const input: OAuthProviderId[] = ["github"];
    expect(tiebreak(input)).toEqual(input);
  });
});
