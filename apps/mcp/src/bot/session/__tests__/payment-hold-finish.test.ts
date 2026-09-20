import { describe, expect, it } from "vitest";
import { mustHoldOpenPaymentSession } from "../lifecycle.js";
import type { Session } from "../model.js";

const released: NonNullable<Session["releasedPaymentCard"]> = {
  approvalId: "01M2ZCF57BYC6SQDMCY37WVVPG",
  approvalUrl: "https://trustysquire.ai/vault/pay/01M2ZCF57BYC6SQDMCY37WVVPG",
  checkout: {
    merchant: "whitejade.xyz",
    checkout_origin: "https://whitejade.xyz",
    amount_cents: 7600,
    currency: "USD",
  },
  cardRef: "01M1HT3QND5MA9RBZP0FXKMQBG",
  last4: "4242",
  deadline: Date.now() + 60_000,
  card: {
    pan: "4111111111111111",
    exp_month: "11",
    exp_year: "29",
    name: "Replay Evaluation",
    cvv: "123",
    billing: {
      line1: "123 Test Street",
      city: "New York",
      state: "NY",
      postal_code: "10001",
      country: "US",
    },
  },
};

describe("mustHoldOpenPaymentSession", () => {
  it("holds a released card still on checkout and lets thank-you finish", () => {
    expect(
      mustHoldOpenPaymentSession({
        activePayment: null,
        releasedPaymentCard: released,
        browser: {
          currentUrl: () => "https://whitejade.xyz/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us",
        },
      }),
    ).toBe(true);
    expect(
      mustHoldOpenPaymentSession({
        activePayment: null,
        releasedPaymentCard: released,
        browser: { currentUrl: () => "https://whitejade.xyz/thank-you" },
      }),
    ).toBe(false);
  });
});
