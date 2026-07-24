import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserController, parseCheckoutAmount } from "../browser.js";

// The real-browser checkout-fill test needs a Playwright Chromium binary. The
// main CI install downloads it, but the lean mcp-only publish-verify install
// does not — skip there rather than fail the release. The pure parsing tests
// below always run.
let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

describe("checkout payment parsing", () => {
  it("uses the selected currency precision for a comma decimal", () => {
    expect(parseCheckoutAmount(["Total 12,345"], "KWD")).toEqual({
      amount_cents: 12_345,
      currency: "KWD",
    });
  });

  it("keeps a three-digit group for two-decimal currencies", () => {
    expect(parseCheckoutAmount(["Total USD 12,345"])).toEqual({
      amount_cents: 1_234_500,
      currency: "USD",
    });
  });

  it("uses Intl minor-unit precision for zero-decimal currencies", () => {
    expect(parseCheckoutAmount(["Total JPY 1,000"])).toEqual({
      amount_cents: 1_000,
      currency: "JPY",
    });
  });

  it.skipIf(!chromiumAvailable)("submits a visible button using its text when its value is empty", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <form id="checkout">
          <input autocomplete="cc-number">
          <input autocomplete="cc-exp">
          <input autocomplete="cc-csc">
          <input autocomplete="cc-name">
          <button type="submit">Pay now</button>
        </form>
        <script>
          document.querySelector("#checkout").addEventListener("submit", (event) => {
            event.preventDefault();
            document.body.dataset.submitted = "true";
            setTimeout(() => {
              const challenge = document.createElement("iframe");
              challenge.title = "3D Secure";
              document.body.append(challenge);
            }, 200);
          });
        </script>
      `);
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;

      const result = await controller.fillAndSubmitCheckout({
        pan: "4242424242424242",
        exp_month: "12",
        exp_year: "30",
        cvv: "123",
        name: "Synthetic Cardholder",
        billing: {
          line1: "123 Synthetic Street",
          city: "Testville",
          postal_code: "10001",
          country: "US",
        },
      });

      expect(await page.locator("body").getAttribute("data-submitted")).toBe("true");
      expect(result.three_ds_required).toBe(true);
      expect(await page.locator('input[data-ts-sealed-payment="1"]').count()).toBe(0);
      expect(
        await page
          .locator("input")
          .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
      ).toEqual(["", "", "", ""]);
    } finally {
      await browser.close();
    }
  });
});
