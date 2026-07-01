// Shared helpers for the operator-hints reconciliation (docs/DESIGN-operator-hints.md):
//   - isIdentityFieldLabel: PII classifier shared by the mcp synthesis scrub and
//     the registry backfill of pre-scrub skills.
//   - orderedOAuthProviders: the replay/verify provider fallback that lets a
//     menu-skill (available[]) verify against a session that doesn't match the
//     pinned provider.

import { describe, expect, it } from "vitest";
import { isIdentityFieldLabel, orderedOAuthProviders } from "../skill.js";

describe("isIdentityFieldLabel", () => {
  it("flags real-name / company / org fields", () => {
    for (const l of ["Full name", "First Name", "last-name", "Company", "Organisation", "Business name"]) {
      expect(isIdentityFieldLabel(l)).toBe(true);
    }
  });
  it("does NOT flag non-identity or billing/address fields", () => {
    for (const l of ["API key name", "Token name", "Zip code", "City", "Country", "Subdomain", "Project"]) {
      expect(isIdentityFieldLabel(l)).toBe(false);
    }
  });
});

describe("orderedOAuthProviders", () => {
  it("prefers the recorded provider when its session exists", () => {
    expect(orderedOAuthProviders({ provider: "google", available: ["google", "github"] }, ["google", "github"]))
      .toEqual(["google", "github"]);
  });
  it("falls back to an available provider when the pinned one has no session", () => {
    expect(orderedOAuthProviders({ provider: "google", available: ["google", "github"] }, ["github"]))
      .toEqual(["github"]);
  });
  it("returns empty (→ needs_login) when no offered provider has a session", () => {
    expect(orderedOAuthProviders({ provider: "google", available: ["google", "github"] }, [])).toEqual([]);
  });
  it("with no available[] menu, only the pinned provider is eligible", () => {
    expect(orderedOAuthProviders({ provider: "google" }, ["google", "github"])).toEqual(["google"]);
    // github session alone can't rescue a single-provider skill — it wasn't offered.
    expect(orderedOAuthProviders({ provider: "google" }, ["github"])).toEqual([]);
  });
});
