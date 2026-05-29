// deriveAllowedHosts — service-name → default host allowlist seeding.

import { describe, expect, it } from "vitest";
import { deriveAllowedHosts, KNOWN_SERVICE_HOSTS } from "../service-hosts.js";

describe("deriveAllowedHosts", () => {
  it("maps a known service to its hosts", () => {
    expect(deriveAllowedHosts("openai")).toEqual(["api.openai.com"]);
    expect(deriveAllowedHosts("github")).toEqual(["api.github.com"]);
  });

  it("is case- and separator-insensitive", () => {
    expect(deriveAllowedHosts("OpenAI")).toEqual(["api.openai.com"]);
    expect(deriveAllowedHosts("open-ai")).toEqual(["api.openai.com"]);
    expect(deriveAllowedHosts("Open AI")).toEqual(["api.openai.com"]);
  });

  it("returns an empty list for unknown / missing services", () => {
    expect(deriveAllowedHosts("some-random-saas")).toEqual([]);
    expect(deriveAllowedHosts("")).toEqual([]);
    expect(deriveAllowedHosts(null)).toEqual([]);
    expect(deriveAllowedHosts(undefined)).toEqual([]);
  });

  it("returns a fresh array each call (callers mutate it)", () => {
    const a = deriveAllowedHosts("openai");
    const b = deriveAllowedHosts("openai");
    expect(a).not.toBe(b);
    a.push("evil.example.com");
    expect(deriveAllowedHosts("openai")).toEqual(["api.openai.com"]);
    // The frozen table is never handed out directly.
    expect(a).not.toBe(KNOWN_SERVICE_HOSTS.openai);
  });
});
