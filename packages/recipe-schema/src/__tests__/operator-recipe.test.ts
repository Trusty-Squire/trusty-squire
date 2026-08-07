import { describe, expect, it } from "vitest";
import {
  isRecipeShareEligible,
  operatorRecipeDomain,
  operatorRecipeKey,
  parseOperatorRecipe,
  type OperatorRecipe,
} from "../operator-recipe.js";

function baseRecipe(overrides: Partial<OperatorRecipe> = {}): OperatorRecipe {
  return parseOperatorRecipe({
    name: "get_api_key--example.com",
    schema_version: 1,
    goal: "Get an API key from Example",
    verb: "get_api_key",
    domain: "example.com",
    entry_url: "https://example.com/signup",
    allowed_hosts: [],
    trace: [
      { action: { kind: "goto", url_template: "https://example.com/signup" } },
      {
        action: {
          kind: "type",
          text_match: "Email",
          value: { hole: "contact.email" },
        },
      },
      {
        action: {
          kind: "click",
          text_match: "Continue",
        },
      },
      {
        action: {
          kind: "extract",
          slot: "api_key",
        },
      },
    ],
    secrets: [{ slot: "api_key", stored: false }],
    postcondition: {
      kind: "execute_capability",
      describe: "the dashboard shows an API key",
      success_signal: { text_present: "API Key" },
    },
    ...overrides,
  });
}

describe("operatorRecipeDomain / operatorRecipeKey", () => {
  it("derives the eTLD+1 and the (verb, domain) key", () => {
    expect(operatorRecipeDomain("https://sub.example.com/a/b?x=1")).toBe("example.com");
    expect(operatorRecipeKey("signup", "https://sub.example.com/a")).toBe("signup--example.com");
  });
});

describe("isRecipeShareEligible", () => {
  it("accepts a recipe whose only literal values are site-constant button text", () => {
    const result = isRecipeShareEligible(baseRecipe());
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it("rejects a recipe missing the (verb, domain) key", () => {
    const recipe = baseRecipe({ verb: undefined, domain: undefined });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("(verb, domain) key"))).toBe(true);
  });

  it("rejects an untagged literal email address anywhere in the recipe", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Email",
            value: "jordan.rivera@example.com",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("email"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a person's name", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            value: "Jordan Rivera",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("name"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a street address", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Address",
            value: "500 Market Street",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("address"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a phone number", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Phone",
            value: "415-555-1234",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("phone"))).toBe(true);
  });

  it("rejects long freeform literal text", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Company description",
            value: "We build durable widgets for the modern supply chain, est. 1990.",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("freeform"))).toBe(true);
  });

  it("accepts a hole-tagged value even when its shape would otherwise be flagged", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            value: { hole: "contact.name" },
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(true);
  });

  it("rejects a secret-shaped literal anywhere in the recipe as defense in depth", () => {
    const recipe = baseRecipe({
      allowed_hosts: [],
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "click",
            text_match: "Continue",
            // A literal that leaked into a hint field would still be caught by
            // the blanket scan, independent of which field it's in.
            target: { href_hint: "https://example.com/callback?token=sk-abcdefghijklmnopqrst" },
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("secret-shaped"))).toBe(true);
  });

  it("ignores short site-constant literals like button text", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "select",
            text_match: "Country",
            value: "United States",
          },
        },
      ],
    });
    // "United States" is title-case-two-words shaped, which this
    // conservative classifier flags as name-shaped — an accepted false
    // positive: the recipe just stays local instead of being shared.
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
  });
});
