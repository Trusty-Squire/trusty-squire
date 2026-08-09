import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserController,
  hasPayPalHostedCheckoutFrame,
  parseCheckoutAmount,
  parseCheckoutAmounts,
} from "../browser.js";

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
  it("detects PayPal Smart Button and hosted card-field frames without entering them", () => {
    expect(
      hasPayPalHostedCheckoutFrame([
        { url: "about:blank", name: "__zoid__paypal_card_fields__uid_abc", title: "" },
      ]),
    ).toBe(true);
    expect(
      hasPayPalHostedCheckoutFrame([
        {
          url: "https://www.paypal.com/smart/buttons?client-id=synthetic",
          name: "",
          title: "PayPal",
        },
      ]),
    ).toBe(true);
    expect(
      hasPayPalHostedCheckoutFrame([
        { url: "https://merchant.test/checkout", name: "card-form", title: "Card details" },
      ]),
    ).toBe(false);
  });

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

  it("resolves unambiguous US$ notation as USD", () => {
    expect(parseCheckoutAmount(["Order total US$ 98.45"], "JPY")).toEqual({
      amount_cents: 9_845,
      currency: "USD",
    });
  });

  it("resolves Japanese yen suffix notation", () => {
    expect(parseCheckoutAmount(["Order total 9,845円"], "USD")).toEqual({
      amount_cents: 9_845,
      currency: "JPY",
    });
  });

  it("resolves Polish złoty suffix notation", () => {
    expect(parseCheckoutAmount(["Order total 98.45 zł"], "USD")).toEqual({
      amount_cents: 9_845,
      currency: "PLN",
    });
  });

  it("resolves the won symbol using zero-decimal precision", () => {
    expect(parseCheckoutAmount(["Order total ₩9,845"], "USD")).toEqual({
      amount_cents: 9_845,
      currency: "KRW",
    });
  });

  it("retains code-plus-symbol checkout parsing", () => {
    expect(parseCheckoutAmount(["Order total USD$98.45"], "JPY")).toEqual({
      amount_cents: 9_845,
      currency: "USD",
    });
  });

  it.each([
    "Order total 98.45 tax included",
    "Order total 98.45 TAX INCLUDED",
    "Order total 98.45 VAT included",
    "TOTAL DUE 98.45",
  ])("retains scale-checked fallback parsing around incidental prose: %s", (text) => {
    expect(parseCheckoutAmount([text], "USD")).toEqual({
      amount_cents: 9_845,
      currency: "USD",
    });
  });

  it("resolves a Japanese payment-amount label", () => {
    // The exact Rakuten failure behind payment_checkout_total_not_found.
    expect(parseCheckoutAmount(["支払い金額 968円"])).toEqual({
      amount_cents: 968,
      currency: "JPY",
    });
  });

  it.each([
    ["合計 8,950円", 8_950],
    ["合計 8,950円（税込）", 8_950],
    ["合計金額（税込）8,950円", 8_950],
    ["ご注文合計: 8,950円", 8_950],
    ["ご注文金額　8,950円", 8_950],
    ["お支払い金額：8,950円", 8_950],
    ["ご請求額 8,950円", 8_950],
    ["注文合計: ￥8,950", 8_950],
    ["総合計 ¥8,950", 8_950],
  ])("resolves Japanese total label: %s", (text, cents) => {
    expect(parseCheckoutAmount([text])).toEqual({
      amount_cents: cents,
      currency: "JPY",
    });
  });

  it("resolves the order total, never the subtotal or shipping, on a Japanese summary", () => {
    expect(parseCheckoutAmount(["小計 968円", "送料 500円", "合計 1,468円"])).toEqual({
      amount_cents: 1_468,
      currency: "JPY",
    });
    expect(parseCheckoutAmount(["小計 968円 送料 500円 消費税 134円 合計 1,468円"])).toEqual({
      amount_cents: 1_468,
      currency: "JPY",
    });
  });

  it("skips a merchandise subtotal (商品合計) and resolves the payable total", () => {
    expect(parseCheckoutAmount(["商品合計 968円", "お支払い金額 1,468円"])).toEqual({
      amount_cents: 1_468,
      currency: "JPY",
    });
  });

  it.each([
    ["小計 968円"],
    ["商品合計 968円"],
    ["送料 500円"],
    ["値引き 300円"],
    ["割引合計 300円"],
    ["消費税 134円"],
    ["税抜合計 8,950円"],
    ["お支払い金額（税抜）8,950円"],
    ["合計 8,950円（税抜）"],
    ["合計 8,950円(税抜き)"],
    ["合計 8,950円（本体価格）"],
    ["合計 税抜 8,950円"],
    ["合計 税抜き 8,950円"],
    ["合計 8,950 税抜"],
    ["合計 8,950 税別"],
    ["合計数量: 3"],
    ["ここに合計はない"],
  ])("refuses non-total or tax-exclusive Japanese lines: %s", (text) => {
    expect(parseCheckoutAmount([text], "JPY")).toBeNull();
  });

  it.each([["合計 3点"], ["合計 500ポイント"], ["合計500円分のクーポンをプレゼント"]])(
    "never treats a Japanese count/points line as a payable amount: %s",
    (text) => {
      expect(parseCheckoutAmount([text], "JPY")).toBeNull();
    },
  );

  it("applies tax-exclusive and count guards to every checkout amount", () => {
    expect(
      parseCheckoutAmounts(
        [
          "合計 8,950円（税抜）",
          "合計 税抜 8,950円",
          "合計 8,950 税別",
          "合計 3点",
          "お支払い金額 9,845円（税込）",
        ],
        "JPY",
      ),
    ).toEqual([{ amount_cents: 9_845, currency: "JPY" }]);
  });

  it("refuses a count-only checkout review summary", async () => {
    const browser = new BrowserController({ humanize: false });
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      frames: () => [{ evaluate: vi.fn().mockResolvedValue("合計 3点") }],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutReviewSummary("JPY")).rejects.toThrow(
      "payment_checkout_total_not_found",
    );
  });

  it("fails closed when yen evidence is glued to unparseable trailing text", async () => {
    // 円税込 is currency evidence the token resolver cannot read; trusting the
    // USD fallback here would turn ¥1,468 into $1,468.00.
    const browser = new BrowserController({ humanize: false });
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      frames: () => [{ evaluate: vi.fn().mockResolvedValue("合計 1,468円税込") }],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutSummary("USD")).rejects.toMatchObject({
      message: "payment_checkout_currency_unresolved",
    });
  });

  it("refuses a sentence-period amount instead of stripping its decimal point", () => {
    // "98.45." used to capture into the number, hit the two-dot rule, and
    // inflate to $9,845.00 — a 100× overcharge. Refusing is the safe outcome.
    expect(parseCheckoutAmount(["Order total US$ 98.45."])).toBeNull();
  });

  it("refuses a decimal total when only a zero-decimal fallback currency is available", () => {
    // A Japan-based merchant is not evidence that a bare 98.45 total is JPY.
    // Treating the dot as a group would silently mint JPY 9,845 for a USD price.
    expect(parseCheckoutAmount(["Order total 98.45"], "JPY")).toBeNull();
  });

  it("surfaces a clear capture error instead of falling back to a mismatched currency", async () => {
    const browser = new BrowserController({ humanize: false });
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      frames: () => [{ evaluate: vi.fn().mockResolvedValue("Order total 98.45") }],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutSummary("JPY")).rejects.toThrow(
      "payment_checkout_currency_unresolved_scale_mismatch",
    );
  });

  it.each([
    "Order total R$ 98.45",
    "Order total 98.45 R$",
    "Order total 98.45 kr",
    "Order total 98.45 ₺",
    "Order total JPY$98.45",
  ])("fails closed when a total uses unresolved currency notation: %s", async (text) => {
    const browser = new BrowserController({ humanize: false });
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      frames: () => [{ evaluate: vi.fn().mockResolvedValue(text) }],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutSummary("USD")).rejects.toMatchObject({
      message: "payment_checkout_currency_unresolved",
    });
  });

  it.skipIf(!chromiumAvailable)(
    "ignores struck-through totals in initial and review reads",
    async () => {
      const playwrightBrowser = await chromium.launch({ headless: true });
      try {
        const page = await playwrightBrowser.newPage();
        await page.setContent(`
          <title>Japan Flower Shop</title>
          <del>合計 968円</del>
          <s>合計 1,100円</s>
          <strike>合計 1,200円</strike>
          <div style="text-decoration: line-through">合計 1,300円</div>
          <div>合計 1,468円</div>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutSummary("JPY")).resolves.toMatchObject({
          amount_cents: 1_468,
          currency: "JPY",
        });
        await expect(controller.readCheckoutReviewSummary("JPY")).resolves.toMatchObject({
          amount_cents: 1_468,
          currency: "JPY",
        });
      } finally {
        await playwrightBrowser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "types digits into a combined numeric expiry field and lets the site format MM/YY",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <form id="checkout">
          <input id="date-of-birth" placeholder="MM/DD/YYYY">
          <input autocomplete="cc-number">
          <input inputmode="numeric" placeholder="MM/YY">
          <input autocomplete="cc-csc">
          <input autocomplete="cc-name">
          <button type="submit">Pay now</button>
        </form>
        <script>
          const expiry = document.querySelector('[placeholder="MM/YY"]');
          expiry.addEventListener("keydown", (event) => {
            if (event.key.length === 1) {
              document.body.dataset.expiryKeys =
                (document.body.dataset.expiryKeys || "") + event.key;
              if (!/\\d/.test(event.key)) event.preventDefault();
            }
          });
          expiry.addEventListener("input", () => {
            const digits = expiry.value.replace(/\\D/g, "").slice(0, 4);
            expiry.value = digits.length > 2
              ? digits.slice(0, 2) + "/" + digits.slice(2)
              : digits;
          });
          document.querySelector("#checkout").addEventListener("submit", (event) => {
            event.preventDefault();
            document.body.dataset.dobAtSubmit =
              document.querySelector("#date-of-birth").value;
            document.body.dataset.expiryAtSubmit = expiry.value;
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
        expect(await page.locator("body").getAttribute("data-dob-at-submit")).toBe("");
        expect(await page.locator("body").getAttribute("data-expiry-at-submit")).toBe("12/30");
        expect(await page.locator("body").getAttribute("data-expiry-keys")).toBe("1230");
        expect(result.three_ds_required).toBe(true);
        expect(await page.locator('input[data-ts-sealed-payment="1"]').count()).toBe(0);
        expect(
          await page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).toEqual(["", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
  );
});

function controllerWithResolutionPage(options: {
  startUrl: string;
  nextUrl?: string;
  text?: string;
}): BrowserController {
  let currentUrl = options.startUrl;
  const frame = {
    url: () => "https://issuer.synthetic.test/",
    evaluate: async (fn: () => unknown) => {
      if (String(fn).includes("querySelector")) return false;
      if (options.nextUrl !== undefined) currentUrl = options.nextUrl;
      return options.text ?? "";
    },
  };
  const page = {
    url: () => currentUrl,
    frames: () => [frame],
    waitForTimeout: async () => undefined,
  };
  const controller = new BrowserController({ humanize: false });
  (controller as unknown as { page: Page }).page = page as unknown as Page;
  return controller;
}

describe("3-D Secure resolution", () => {
  it("does not treat an unchanged checkout confirmation URL as success", async () => {
    const controller = controllerWithResolutionPage({
      startUrl: "https://merchant.test/checkout/confirm?success_url=/done",
    });

    await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("timeout");
  });

  it("accepts explicit success text without a URL transition", async () => {
    const controller = controllerWithResolutionPage({
      startUrl: "https://merchant.test/checkout",
      text: "Your payment was successful",
    });
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1);

    try {
      await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("succeeded");
    } finally {
      now.mockRestore();
    }
  });

  it("accepts a transitioned terminal success URL", async () => {
    const controller = controllerWithResolutionPage({
      startUrl: "https://merchant.test/checkout",
      nextUrl: "https://merchant.test/receipt/123",
    });

    await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("succeeded");
  });

  it("prioritizes failure text over success signals", async () => {
    const controller = controllerWithResolutionPage({
      startUrl: "https://merchant.test/checkout",
      nextUrl: "https://merchant.test/success",
      text: "Payment declined. Your payment was successful",
    });

    await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("failed");
  });
});
