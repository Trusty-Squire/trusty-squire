import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  CHECKOUT_TOTAL_UNREADABLE,
  parseCheckoutAmount,
  readPageCheckoutTexts,
  resolveDriveApprovalAmount,
} from "../checkout-total.js";
import { DRIVE_EVALUATE_BUDGET_MS } from "../drive-evaluate.js";

function wedgedPage(): Page {
  return {
    evaluate: async () => await new Promise(() => undefined),
    mainFrame: () => ({}),
    context: () => ({
      newCDPSession: async () => ({
        send: async () => undefined,
        detach: async () => undefined,
      }),
    }),
  } as unknown as Page;
}

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

  it("marks a total the approval API would reject unknown instead of blocking the mint", () => {
    expect(resolveDriveApprovalAmount(["Total $25,000,000.00 USD"], {})).toEqual({
      amount_cents: 0,
      currency: "USD",
      unknown: true,
    });
    expect(resolveDriveApprovalAmount(["Total $21,000,000.00 USD"], {})).toEqual({
      amount_cents: 2_100_000_000,
      currency: "USD",
      unknown: false,
    });
  });

  it("gives up on a wedged renderer within the drive evaluate budget", async () => {
    vi.useFakeTimers();
    try {
      const texts = readPageCheckoutTexts(wedgedPage());
      await vi.advanceTimersByTimeAsync(DRIVE_EVALUATE_BUDGET_MS);
      await expect(texts).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a Pay now $68 button as the order total", () => {
    expect(parseCheckoutAmount(["Pay now\n$68.00", "Back to finalize order"])).toBeNull();
  });
});
