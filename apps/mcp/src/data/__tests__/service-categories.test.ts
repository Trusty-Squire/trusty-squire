// T44 — service-category map lookup tests. The data lives as a
// TypeScript constant (no yaml read at runtime); these tests pin
// down the public lookup contract.

import { describe, expect, it } from "vitest";
import {
  SERVICE_CATEGORIES,
  categoryFor,
  categoryPeersOf,
} from "../service-categories.js";

describe("service-categories — lookup", () => {
  it("returns the category for a known slug", () => {
    expect(categoryFor("resend")).toBe("email-transactional");
    expect(categoryFor("openrouter")).toBe("llm-api");
    expect(categoryFor("pinecone")).toBe("vector-db");
  });

  it("is case-insensitive on the lookup slug", () => {
    expect(categoryFor("Resend")).toBe("email-transactional");
    expect(categoryFor("ANTHROPIC-API")).toBe("llm-api");
  });

  it("returns null for an unknown slug", () => {
    expect(categoryFor("not-a-real-service")).toBeNull();
    expect(categoryFor("")).toBeNull();
  });

  it("returns category peers excluding the requested slug itself", () => {
    const peers = categoryPeersOf("resend");
    expect(peers.length).toBeGreaterThan(2);
    expect(peers).not.toContain("resend");
    expect(peers).toContain("postmark");
    expect(peers).toContain("mailgun");
  });

  it("returns empty array for an unknown slug", () => {
    expect(categoryPeersOf("not-a-real-service")).toEqual([]);
  });

  it("returns category peers for a single-member category as empty", () => {
    // `comms` has only twilio in the v1 map.
    expect(categoryPeersOf("twilio")).toEqual([]);
  });

  it("all category groups have at least one entry", () => {
    const categories = new Set(SERVICE_CATEGORIES.map((e) => e.category));
    for (const c of categories) {
      const members = SERVICE_CATEGORIES.filter((e) => e.category === c);
      expect(members.length).toBeGreaterThan(0);
    }
  });

  it("no duplicate slugs", () => {
    const slugs = SERVICE_CATEGORIES.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("all slugs are lowercase kebab", () => {
    for (const e of SERVICE_CATEGORIES) {
      expect(e.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});
