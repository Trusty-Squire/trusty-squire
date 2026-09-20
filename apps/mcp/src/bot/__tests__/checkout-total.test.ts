import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  CHECKOUT_TEXT_READ_BUDGET_MS,
  CHECKOUT_TOTAL_UNREADABLE,
  approvalItemWithNote,
  parseCheckoutAmount,
  readPageCheckoutTexts,
  resolveDriveApprovalAmount,
} from "../checkout-total.js";
import { attachOperatorRequestAbort, withOperatorRequestContext } from "../request-cancellation.js";

function wedgedPage(): { page: Page; cdpSessions: () => number } {
  let cdpSessions = 0;
  const page = {
    evaluate: () => new Promise(() => undefined),
    mainFrame: () => ({}),
    context: () => ({
      newCDPSession: async () => {
        cdpSessions += 1;
        return { send: async () => undefined, detach: async () => undefined };
      },
    }),
  } as unknown as Page;
  return { page, cdpSessions: () => cdpSessions };
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
      note: null,
    });
  });

  it("mints the page total and notes the disagreement when a facts amount differs", () => {
    const page = ["Total $76.00 USD"];
    expect(resolveDriveApprovalAmount(page, { amount_cents: "6800" })).toEqual({
      amount_cents: 7600,
      currency: "USD",
      unknown: false,
      note: "agent expected 68.00 USD, page shows 76.00 USD",
    });
    expect(resolveDriveApprovalAmount(page, { amount_cents: "7600" }).note).toBeNull();
  });

  it("marks the amount unknown instead of inventing 0 from a missing total", () => {
    expect(resolveDriveApprovalAmount(["Card number\nPay now"], {})).toEqual({
      amount_cents: 0,
      currency: "USD",
      unknown: true,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    expect(CHECKOUT_TOTAL_UNREADABLE).toBe("total not readable");
  });

  it("marks a total the approval API would reject unknown instead of blocking the mint", () => {
    expect(resolveDriveApprovalAmount(["Total $25,000,000.00 USD"], {})).toMatchObject({
      amount_cents: 0,
      unknown: true,
    });
    expect(resolveDriveApprovalAmount(["Total $21,000,000.00 USD"], {})).toMatchObject({
      amount_cents: 2_100_000_000,
      unknown: false,
    });
  });

  it("ignores a bare number with no currency and takes the summary total below it", () => {
    expect(resolveDriveApprovalAmount(["Total 1,250 points"], {})).toMatchObject({
      amount_cents: 0,
      unknown: true,
    });
    expect(
      resolveDriveApprovalAmount(["Total 1,250 points\nOrder total\n$76.00 USD"], {}),
    ).toMatchObject({ amount_cents: 7600, currency: "USD", unknown: false });
  });

  it("takes the last labelled total, not the first one in document order", () => {
    expect(parseCheckoutAmount(["Total $10.00\nAdded shipping\nOrder total $76.00 USD"])).toEqual({
      amount_cents: 7600,
      currency: "USD",
    });
  });

  it("lets an explicit currency fact outrank an ambiguous page symbol", () => {
    expect(resolveDriveApprovalAmount(["Total $76.00"], { currency: "AUD" })).toMatchObject({
      amount_cents: 7600,
      currency: "AUD",
    });
    expect(resolveDriveApprovalAmount(["Total $76.00 USD"], { currency: "AUD" })).toMatchObject({
      amount_cents: 7600,
      currency: "USD",
    });
  });

  it("keeps a symbol only one currency uses, and its scale, over a currency fact", () => {
    expect(resolveDriveApprovalAmount(["合計 7,600円"], { currency: "USD" })).toMatchObject({
      amount_cents: 7600,
      currency: "JPY",
    });
    expect(resolveDriveApprovalAmount(["Total €76,00"], { currency: "USD" })).toMatchObject({
      amount_cents: 7600,
      currency: "EUR",
    });
  });

  it("refuses a currency fact that would rescale the number the page displays", () => {
    expect(resolveDriveApprovalAmount(["Total £76.00"], { currency: "JPY" })).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    expect(resolveDriveApprovalAmount(["Total £76.00"], { currency: "GBP" })).toMatchObject({
      amount_cents: 7600,
      currency: "GBP",
    });
  });

  it("refuses a page currency whose scale disagrees with the fraction shown", () => {
    expect(resolveDriveApprovalAmount(["Total ¥76.00"], {})).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    expect(resolveDriveApprovalAmount(["Total ¥1,234.56"], {})).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    expect(resolveDriveApprovalAmount(["Total ¥7,600"], {})).toMatchObject({
      amount_cents: 7600,
      currency: "JPY",
    });
    expect(resolveDriveApprovalAmount(["Total ¥76.00"], { currency: "CNY" })).toMatchObject({
      amount_cents: 7600,
      currency: "CNY",
    });
  });

  it("refuses a lone three-digit group under a three-minor-digit currency rather than guess", () => {
    expect(resolveDriveApprovalAmount(["Total KWD 1,234"], {})).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    expect(resolveDriveApprovalAmount(["Total 1.234 BHD"], {})).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
    // Two groups can only be thousands separators, so the total stays readable.
    expect(resolveDriveApprovalAmount(["Total KWD 1,234,567"], {})).toMatchObject({
      amount_cents: 1234567000,
      currency: "KWD",
    });
    expect(resolveDriveApprovalAmount(["Total KWD 1,234.567"], {})).toMatchObject({
      amount_cents: 1234567,
      currency: "KWD",
    });
  });

  it("reads apostrophe- and space-grouped totals instead of their leading group", () => {
    expect(resolveDriveApprovalAmount(["Total CHF 1'234.56"], {})).toMatchObject({
      amount_cents: 123456,
      currency: "CHF",
    });
    expect(resolveDriveApprovalAmount(["Total CHF 1\u2019234.56"], {})).toMatchObject({
      amount_cents: 123456,
      currency: "CHF",
    });
    expect(resolveDriveApprovalAmount(["Total EUR 1 234,56"], {})).toMatchObject({
      amount_cents: 123456,
      currency: "EUR",
    });
    expect(resolveDriveApprovalAmount(["Total EUR 1\u202f234,56"], {})).toMatchObject({
      amount_cents: 123456,
      currency: "EUR",
    });
    expect(resolveDriveApprovalAmount(["Total 1'234'567.89 CHF"], {})).toMatchObject({
      amount_cents: 123456789,
      currency: "CHF",
    });
  });

  it("refuses a grouped number whose groups are malformed rather than join the digits", () => {
    expect(resolveDriveApprovalAmount(["Total CHF 1'23.45"], {})).toMatchObject({
      amount_cents: 0,
      note: CHECKOUT_TOTAL_UNREADABLE,
    });
  });

  it("reads a total followed by a separate digit run, which groups nothing", () => {
    expect(resolveDriveApprovalAmount(["Total $76.00 3 items"], {})).toMatchObject({
      amount_cents: 7600,
      currency: "USD",
    });
    expect(resolveDriveApprovalAmount(["Total EUR 76.00 12345"], {})).toMatchObject({
      amount_cents: 7600,
      currency: "EUR",
    });
  });

  it("reports an unreadable summary total as unknown instead of a running total above it", () => {
    expect(
      resolveDriveApprovalAmount(["Item total ¥7,000\nShipping ¥600\nOrder total ¥7,600.00"], {}),
    ).toMatchObject({ amount_cents: 0, note: CHECKOUT_TOTAL_UNREADABLE });
    expect(
      resolveDriveApprovalAmount(
        ["Item total $68.00\nShipping $8.00\nOrder total $76.00 2 items"],
        {},
      ),
    ).toMatchObject({ amount_cents: 7600, currency: "USD" });
    // An unreadable running line does not condemn a summary total below it.
    expect(
      resolveDriveApprovalAmount(["Item total ¥7,000.00\nOrder total ¥7,600"], {}),
    ).toMatchObject({ amount_cents: 7600, currency: "JPY" });
  });

  it("degrades a wedged renderer to an unknown total without cancelling the drive request", async () => {
    vi.useFakeTimers();
    const wedged = wedgedPage();
    const controller = new AbortController();
    attachOperatorRequestAbort(controller.signal, (reason) => controller.abort(reason));
    try {
      const texts = withOperatorRequestContext(controller.signal, async () =>
        readPageCheckoutTexts(wedged.page),
      );
      await vi.advanceTimersByTimeAsync(CHECKOUT_TEXT_READ_BUDGET_MS);
      await expect(texts).resolves.toEqual([]);
      expect(resolveDriveApprovalAmount(await texts, {}).unknown).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      expect(wedged.cdpSessions()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a Pay now $68 button as the order total", () => {
    expect(parseCheckoutAmount(["Pay now\n$68.00", "Back to finalize order"])).toBeNull();
  });

  it("keeps the note within the amount the approval item can carry", () => {
    expect(approvalItemWithNote("whitejade order", null)).toBe("whitejade order");
    const annotated = approvalItemWithNote("x".repeat(600), CHECKOUT_TOTAL_UNREADABLE);
    expect(annotated.length).toBeLessThanOrEqual(500);
    expect(annotated.endsWith(CHECKOUT_TOTAL_UNREADABLE)).toBe(true);
  });
});
