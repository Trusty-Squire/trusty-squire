// Tests for the OAuth login-state marker — the signup bot reads this
// to decide which providers it can auto-prefer for OAuth-first signup.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loggedInProviders,
  markProviderLoggedIn,
  loggedInEmail,
  recordProviderEmail,
} from "../login-state.js";

describe("login-state marker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-login-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no providers when the marker is absent", () => {
    expect(loggedInProviders(dir)).toEqual([]);
  });

  it("round-trips a marked provider", () => {
    markProviderLoggedIn("google", dir);
    expect(loggedInProviders(dir)).toEqual(["google"]);
  });

  it("accumulates providers and de-duplicates", () => {
    markProviderLoggedIn("google", dir);
    markProviderLoggedIn("github", dir);
    markProviderLoggedIn("google", dir);
    expect([...loggedInProviders(dir)].sort()).toEqual(["github", "google"]);
  });

  it("drops unknown provider ids and tolerates a non-array payload", () => {
    writeFileSync(join(dir, "logged-in-providers.json"), '["google","bogus"]');
    expect(loggedInProviders(dir)).toEqual(["google"]);
    writeFileSync(join(dir, "logged-in-providers.json"), '{"x":1}');
    expect(loggedInProviders(dir)).toEqual([]);
  });
});

describe("provider-email marker (PR3 capture-at-login)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ts-provider-email-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no email marker exists", () => {
    expect(loggedInEmail("google", dir)).toBeNull();
  });

  it("round-trips a recorded email per provider", () => {
    recordProviderEmail("google", "ada@example.com", dir);
    expect(loggedInEmail("google", dir)).toBe("ada@example.com");
    expect(loggedInEmail("github", dir)).toBeNull();
  });

  it("overwrites the email on re-record (account switch)", () => {
    recordProviderEmail("google", "old@example.com", dir);
    recordProviderEmail("google", "new@example.com", dir);
    expect(loggedInEmail("google", dir)).toBe("new@example.com");
  });

  it("ignores an empty email and tolerates a malformed marker", () => {
    recordProviderEmail("google", "", dir);
    expect(loggedInEmail("google", dir)).toBeNull();
    writeFileSync(join(dir, "provider-emails.json"), "not json");
    expect(loggedInEmail("google", dir)).toBeNull();
  });

  it("keeps the provider-array marker independent of the email marker", () => {
    markProviderLoggedIn("google", dir);
    recordProviderEmail("google", "ada@example.com", dir);
    expect(loggedInProviders(dir)).toEqual(["google"]);
    expect(loggedInEmail("google", dir)).toBe("ada@example.com");
  });
});
