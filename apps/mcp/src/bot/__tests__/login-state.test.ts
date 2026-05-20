// Tests for the OAuth login-state marker — the signup bot reads this
// to decide which providers it can auto-prefer for OAuth-first signup.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loggedInProviders, markProviderLoggedIn } from "../login-state.js";

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
