import { describe, expect, it } from "vitest";
import {
  CHECKOUT_TOTAL_UNREADABLE,
  parseCheckoutAmount,
  resolveDriveApprovalAmount,
} from "../checkout-total.js";

describe("checkout total from page text", () => {
  it("reads a Shopify-style Total 76.00 USD with no amount fact", () => {
    const page = `Subtotal
$68.00
Shipping
$8.00
Total
$76.00 USD`;
    expect(resolveDriveApprovalAmount([page], {})).toEqual({
      amount_cents: 7600,
      currency: "USD",
      unknown: false,
    });
  });

  it("treats a facts amount as confirmation only, never a replacement", () => {
    const page = ["Total $76.00 USD"];
    expect(resolveDriveApprovalAmount(page, { amount_cents: "6800" })).toEqual({
      amount_cents: 7600,
      currency: "USD",
      unknown: false,
    });
    expect(resolveDriveApprovalAmount(page, { amount_cents: "99999" })).toEqual({
      amount_cents: 7600,
      currency: "USD",
      unknown: false,
    });
    expect(resolveDriveApprovalAmount(page, { amount_cents: "0" })).toEqual({
      amount_cents: 7600,
      currency: "USD",
      unknown: false,
    });
  });

  it("marks the amount unknown instead of inventing 0 from a missing total", () => {
    expect(resolveDriveApprovalAmount(["Card number\nPay now"], {})).toEqual({
      amount_cents: 0,
      currency: "USD",
      unknown: true,
    });
    expect(CHECKOUT_TOTAL_UNREADABLE).toBe("total not readable");
  });

  it("does not treat a Pay now $68 button as the order total", () => {
    expect(parseCheckoutAmount(["Pay now\n$68.00", "Back to finalize order"])).toBeNull();
  });
});
