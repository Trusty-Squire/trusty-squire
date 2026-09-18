import { describe, expect, it } from "vitest";
import type { CheckoutCard } from "../../bot/browser.js";
import { cardTokenVocabulary } from "../../bot/card-secret-tokens.js";
import { releasedCardPublicFields } from "../inject-card.js";

const CARD: CheckoutCard = {
  pan: "4111111111111111",
  cvv: "123",
  exp_month: "12",
  exp_year: "2030",
  name: "Synthetic Buyer",
  billing: {
    line1: "1 Test Street",
    line2: "Suite 4",
    city: "Testville",
    state: "CA",
    postal_code: "94105",
    country: "US",
  },
};

function cardInjectedShape(card: CheckoutCard) {
  return {
    status: "card_injected",
    last4: card.pan.slice(-4),
    ...releasedCardPublicFields(card),
    card_tokens: cardTokenVocabulary(card),
    fields: { pan: { status: "filled" }, cvv: { status: "filled" } },
    complete: true,
  };
}

describe("inject_card result after release", () => {
  it("returns expiry, cardholder name, and stored billing alongside last4", () => {
    const result = cardInjectedShape(CARD);
    expect(result).toMatchObject({
      status: "card_injected",
      last4: "1111",
      exp_month: "12",
      exp_year: "2030",
      name: "Synthetic Buyer",
      billing: {
        line1: "1 Test Street",
        line2: "Suite 4",
        city: "Testville",
        state: "CA",
        postal_code: "94105",
        country: "US",
      },
    });
  });

  it("never includes PAN or CVV in the released public fields or full result", () => {
    const publicFields = releasedCardPublicFields(CARD);
    expect(Object.keys(publicFields).sort()).toEqual(["billing", "exp_month", "exp_year", "name"]);
    const serialized = JSON.stringify(cardInjectedShape(CARD));
    expect(serialized).toContain('"exp_month":"12"');
    expect(serialized).toContain('"name":"Synthetic Buyer"');
    expect(serialized).not.toContain(CARD.pan);
    expect(serialized).not.toContain(CARD.cvv);
    expect(serialized).not.toMatch(/"pan"\s*:\s*"4111/);
    expect(serialized).not.toMatch(/"cvv"\s*:\s*"123"/);
  });

  it("copies billing so the session card cannot be mutated through the result", () => {
    const publicFields = releasedCardPublicFields(CARD);
    publicFields.billing.city = "Mutated";
    publicFields.name = "Mutated";
    expect(CARD.billing.city).toBe("Testville");
    expect(CARD.name).toBe("Synthetic Buyer");
  });
});
