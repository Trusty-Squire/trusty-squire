import { describe, expect, it } from "vitest";
import {
  boundCardMeta,
  brandMonogram,
  CARD_TRUST_COPY,
  cardLast4,
  type CardMeta,
  detectCardBrand,
  isLegacyCard,
} from "./wallet";

// Synthetic PANs only — never real card data in fixtures.
describe("detectCardBrand", () => {
  it("classifies the major networks from their prefix", () => {
    expect(detectCardBrand("4242 4242 4242 4242")).toBe("Visa");
    expect(detectCardBrand("5555 5555 5555 4444")).toBe("Mastercard");
    expect(detectCardBrand("2223 0000 0000 0007")).toBe("Mastercard");
    expect(detectCardBrand("3782 822463 10005")).toBe("American Express");
    expect(detectCardBrand("6011 0000 0000 0004")).toBe("Discover");
  });

  it("returns null for an unknown prefix (falls back to a generic glyph)", () => {
    expect(detectCardBrand("9999 9999 9999")).toBeNull();
    expect(detectCardBrand("")).toBeNull();
  });

  it("holds no digits, so a PAN can never be smuggled into the brand column", () => {
    const brand = detectCardBrand("4242424242424242");
    expect(brand).not.toBeNull();
    expect(brand).toMatch(/^[A-Za-z][A-Za-z \-]*$/);
  });
});

describe("cardLast4", () => {
  it("extracts the last four digits, ignoring separators", () => {
    expect(cardLast4("4242 4242 4242 4242")).toBe("4242");
    expect(cardLast4("3782-822463-10005")).toBe("0005");
  });

  it("returns null when there aren't four digits", () => {
    expect(cardLast4("42")).toBeNull();
    expect(cardLast4("")).toBeNull();
  });
});

describe("isLegacyCard", () => {
  it("is legacy when last4 is absent (pre-metadata card)", () => {
    expect(isLegacyCard({ brand: null, last4: null })).toBe(true);
  });
  it("is not legacy once last4 is stored", () => {
    expect(isLegacyCard({ brand: "Visa", last4: "4242" })).toBe(false);
    expect(isLegacyCard({ brand: null, last4: "4242" })).toBe(false);
  });
});

describe("boundCardMeta — the anti-blind-sign source of truth", () => {
  const cards: CardMeta[] = [
    { id: "card_a", label: "Personal", brand: "Visa", last4: "4242", createdAt: "2026-07-01" },
    { id: "card_b", label: "Business", brand: "Mastercard", last4: "4444", createdAt: "2026-07-02" },
  ];

  it("returns the SERVER-BOUND card, not the first or any other card", () => {
    const bound = boundCardMeta("card_b", cards);
    expect(bound?.id).toBe("card_b");
    expect(bound?.last4).toBe("4444");
    // Must never leak a different card's last4 as the review anchor.
    expect(bound?.last4).not.toBe("4242");
  });

  it("returns null for a card-less approval", () => {
    expect(boundCardMeta(null, cards)).toBeNull();
  });

  it("returns null when the bound id is not in the account's list", () => {
    expect(boundCardMeta("card_missing", cards)).toBeNull();
  });
});

describe("brandMonogram", () => {
  it("maps known brands to a short tile monogram, null to a generic glyph", () => {
    expect(brandMonogram("Visa")).toBe("V");
    expect(brandMonogram("Mastercard")).toBe("MC");
    expect(brandMonogram("American Express")).toBe("AX");
    expect(brandMonogram(null)).toBeNull();
  });
});

describe("CARD_TRUST_COPY", () => {
  it("is the honest promise — no false 'server cannot decrypt' claim", () => {
    expect(CARD_TRUST_COPY).toBe(
      "Your full card number is encrypted in this browser and never readable by our servers. We store only the last 4 digits and card brand, for display.",
    );
    expect(CARD_TRUST_COPY.toLowerCase()).not.toContain("cannot decrypt");
  });
});
