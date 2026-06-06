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

  it("resolves fal.ai (dotted name normalises to falai)", () => {
    const hosts = ["fal.run", "rest.alpha.fal.ai", "queue.fal.run"];
    expect(deriveAllowedHosts("fal.ai")).toEqual(hosts);
    expect(deriveAllowedHosts("fal")).toEqual(hosts);
    expect(deriveAllowedHosts("Fal.AI")).toEqual(hosts);
  });

  it("maps Alpaca to its paper, live, and data hosts", () => {
    const hosts = [
      "paper-api.alpaca.markets",
      "api.alpaca.markets",
      "data.alpaca.markets",
    ];
    expect(deriveAllowedHosts("Alpaca")).toEqual(hosts);
    expect(deriveAllowedHosts("alpaca")).toEqual(hosts);
  });

  it("maps FRED (and the stlouisfed slug) to the data host", () => {
    expect(deriveAllowedHosts("FRED")).toEqual(["api.stlouisfed.org"]);
    expect(deriveAllowedHosts("fred")).toEqual(["api.stlouisfed.org"]);
    expect(deriveAllowedHosts("St. Louis Fed")).toEqual(["api.stlouisfed.org"]);
  });

  it("maps OpenRouter to openrouter.ai", () => {
    expect(deriveAllowedHosts("OpenRouter")).toEqual(["openrouter.ai"]);
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
