import { describe, expect, it } from "vitest";
import {
  canonicalizeServiceSlug,
  equivalentServiceSlugs,
  serviceSlugLookupOrder,
} from "../service-slugs.js";

describe("service slug canonicalization", () => {
  it("maps the legacy Anthropic slug to the active API skill slug", () => {
    expect(canonicalizeServiceSlug("anthropic")).toBe("anthropic-api");
    expect(canonicalizeServiceSlug("Anthropic API")).toBe("anthropic-api");
  });

  it("maps the legacy Together slug to the registry canonical slug", () => {
    expect(canonicalizeServiceSlug("together")).toBe("together-ai");
    expect(canonicalizeServiceSlug("Together AI")).toBe("together-ai");
  });

  it("maps registry-backed legacy slugs to canonical active skill slugs", () => {
    expect(canonicalizeServiceSlug("fireworks")).toBe("fireworks-ai");
    expect(canonicalizeServiceSlug("Fireworks AI")).toBe("fireworks-ai");
    expect(canonicalizeServiceSlug("fly")).toBe("fly-io");
    expect(canonicalizeServiceSlug("Fly.io")).toBe("fly-io");
  });

  it("returns all equivalent slugs for exclusion sets", () => {
    expect(equivalentServiceSlugs("anthropic-api")).toEqual(["anthropic-api", "anthropic"]);
    expect(equivalentServiceSlugs("fireworks-ai")).toEqual(["fireworks-ai", "fireworks"]);
  });

  it("looks up canonical first, then the normalized original slug", () => {
    expect(serviceSlugLookupOrder("anthropic")).toEqual(["anthropic-api", "anthropic"]);
  });
});
