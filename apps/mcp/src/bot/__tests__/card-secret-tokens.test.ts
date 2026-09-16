import { describe, expect, it } from "vitest";
import type { CheckoutCard } from "../browser.js";
import {
  cardTokenVocabulary,
  referencesCardToken,
  substituteCardTokens,
} from "../card-secret-tokens.js";

const CARD: CheckoutCard = {
  name: "Synthetic Buyer",
  pan: "4111111111111111",
  exp_month: "12",
  exp_year: "2030",
  cvv: "123",
} as CheckoutCard;

describe("card secret tokens", () => {
  it("substitutes whole-value and per-digit tokens at the keystroke boundary", () => {
    expect(substituteCardTokens(CARD, "{{pan}}")).toBe("4111111111111111");
    expect(substituteCardTokens(CARD, "{{cvv}}")).toBe("123");
    expect(substituteCardTokens(CARD, "{{pan:1}}{{pan:2}}{{pan:3}}")).toBe("411");
    expect(substituteCardTokens(CARD, "{{pan:16}}")).toBe("1");
    expect(substituteCardTokens(CARD, "{{cvv:3}}")).toBe("3");
    expect(
      substituteCardTokens(CARD, "pay with {{pan}} and code {{cvv:1}}{{cvv:2}}{{cvv:3}}"),
    ).toBe("pay with 4111111111111111 and code 123");
  });

  it("preserves literal text around tokens byte-for-byte", () => {
    const text = "  {{pan}}  \n\ttab {{cvv}} end";
    expect(substituteCardTokens(CARD, text)).toBe(
      "  4111111111111111  \n\ttab 123 end",
    );
    // A text with no tokens is returned unchanged (same reference semantics:
    // equality is enough; the type path passes it straight on).
    expect(substituteCardTokens(CARD, "12/30")).toBe("12/30");
    expect(substituteCardTokens(CARD, "Daeun Lee")).toBe("Daeun Lee");
  });

  it("never leaks digits when a token is malformed or out of range", () => {
    expect(() => substituteCardTokens(CARD, "{{pan:0}}")).toThrow(/out of range/);
    expect(() => substituteCardTokens(CARD, "{{pan:17}}")).toThrow(/out of range/);
    expect(() => substituteCardTokens(CARD, "{{cvv:0}}")).toThrow(/out of range/);
    expect(() => substituteCardTokens(CARD, "{{cvv:4}}")).toThrow(/out of range/);
    expect(() => substituteCardTokens(CARD, "{{pan:99}}")).toThrow(/out of range/);
    expect(() => substituteCardTokens(CARD, "{{cvv:99}}")).toThrow(/out of range/);
    for (const bad of ["{{pan", "{{pan:}}", "{{nope}}", "{{pan:1"]) {
      // Unrecognized or unterminated syntax passes through untouched rather
      // than guessing; the agent sees its own literal echoed back.
      expect(substituteCardTokens(CARD, bad)).toBe(bad);
    }
    // Error messages name the token, never the digits it would have produced.
    try {
      substituteCardTokens(CARD, "{{pan:17}}");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("{{pan:17}}");
      expect(message).not.toContain("4111");
      expect(message).not.toContain("123");
    }
  });

  it("token placement works for one- and two-digit months/years too", () => {
    // The vocabulary is derived from the released card, not a fixed 16/3 shape.
    const short: CheckoutCard = { ...CARD, pan: "378282246310005", cvv: "1234" } as CheckoutCard;
    expect(substituteCardTokens(short, "{{pan:15}}")).toBe("5");
    expect(() => substituteCardTokens(short, "{{pan:16}}")).toThrow(/out of range/);
    expect(substituteCardTokens(short, "{{cvv:4}}")).toBe("4");
    expect(() => substituteCardTokens(short, "{{cvv:5}}")).toThrow(/out of range/);
  });

  it("vocabulary describes shapes and lengths but never carries digits", () => {
    const vocabulary = cardTokenVocabulary(CARD);
    expect(vocabulary).toEqual({
      pan: "{{pan}}",
      pan_digit: "{{pan:N}}",
      cvv: "{{cvv}}",
      cvv_digit: "{{cvv:N}}",
      pan_length: 16,
      cvv_length: 3,
    });
    const serialized = JSON.stringify(vocabulary);
    expect(serialized).not.toContain("4111");
    expect(serialized).not.toContain(CARD.cvv);
    expect(serialized).not.toContain(CARD.name);
    expect(serialized).not.toContain(CARD.exp_month);
    expect(serialized).not.toContain(CARD.exp_year);
  });

  it("referencesCardToken detects token usage in agent text", () => {
    expect(referencesCardToken("{{pan}}")).toBe(true);
    expect(referencesCardToken("type {{cvv:2}} then enter")).toBe(true);
    expect(referencesCardToken("plain 12/30")).toBe(false);
    expect(referencesCardToken("{{pan:1")).toBe(false);
  });
});
