import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserController,
  CHECKOUT_SUBMIT_LABEL_RE,
  classifyStripePaymentIntentStatus,
  hasPayPalHostedCheckoutFrame,
  PaymentCardFillCleanupError,
  PaymentSubmitOutcomeUnknownError,
  parseCheckoutAmount,
  parseCheckoutAmounts,
  parseStructuredCheckoutTotal,
  parseStripeChallengeParams,
  recognizedPaymentProviderFrame,
  UnrecognizedPaymentFrameError,
} from "../browser.js";
import {
  cartAdd,
  closeAllProvisionSessions,
  startHarnessProvisionSession,
} from "../provision-session.js";

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

describe("charge-verb label recognition (CHECKOUT_SUBMIT_LABEL_RE)", () => {
  it("recognizes English charge verbs (regression)", () => {
    for (const label of [
      "Pay now",
      "Pay",
      "Place order",
      "Complete order",
      "Complete purchase",
      "Submit payment",
      "Buy now",
      "Confirm order",
      "Confirm payment",
    ]) {
      expect(CHECKOUT_SUBMIT_LABEL_RE.test(label), label).toBe(true);
    }
  });

  it("does not treat English navigation labels as charge verbs (regression)", () => {
    for (const label of ["Continue", "Next", "Add to cart", "Back", "Continue to review"]) {
      expect(CHECKOUT_SUBMIT_LABEL_RE.test(label), label).toBe(false);
    }
  });

  it("recognizes Japanese charge/confirm-order verbs", () => {
    for (const label of [
      "ご注文を確定する",
      "注文を確定する",
      "注文を確定",
      "ご注文の確定",
      "注文する",
      "注文内容を確定する",
      "確定する",
      "確定",
      "購入する",
      "購入を確定",
      "購入",
      "今すぐ購入",
      "今すぐ支払う",
      "支払う",
      "お支払い",
      "支払い",
      "お支払いを確定する",
    ]) {
      expect(CHECKOUT_SUBMIT_LABEL_RE.test(label), label).toBe(true);
    }
  });

  it("does not treat Japanese non-charge labels as charge verbs", () => {
    for (const label of [
      "戻る",
      "カートに追加",
      "お支払い方法を変更する",
      "購入手続きへ",
      "注文内容を確認する",
      "レジに進む",
      "クーポンを利用する",
    ]) {
      expect(CHECKOUT_SUBMIT_LABEL_RE.test(label), label).toBe(false);
    }
  });
});

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
    ["合計 8,950円 ※送料無料", 8_950],
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

  it.each([
    ["小計 2,904 円\n送料 送料無料", 2_904],
    ["合計 968円", 968],
    ["ご請求金額 ¥1,065", 1_065],
    ["請求金額 1,065円", 1_065],
    ["総額 1,468円", 1_468],
    ["税込 1,468円", 1_468],
    ["税込み総額 1,468円", 1_468],
  ])("parses Rakuten Japanese checkout amount: %s", (text, cents) => {
    expect(parseCheckoutAmount([text])).toEqual({
      amount_cents: cents,
      currency: "JPY",
    });
  });

  it("keeps all Japanese checkout matches so review selection uses the settled final total", () => {
    expect(parseCheckoutAmounts(["小計 2,904円\n送料 送料無料", "合計 1,468円"])).toEqual([
      { amount_cents: 2_904, currency: "JPY" },
      { amount_cents: 1_468, currency: "JPY" },
    ]);
  });

  it("uses a Rakuten card-step subtotal when no final payable label exists", () => {
    expect(parseCheckoutAmount(["小計 3,872 円\n送料 送料無料"])).toEqual({
      amount_cents: 3_872,
      currency: "JPY",
    });
  });

  it("refuses a subtotal when shipping is paid or unknown", () => {
    expect(parseCheckoutAmount(["小計 3,872 円\n送料 500円"])).toBeNull();
    expect(parseCheckoutAmount(["小計 3,872 円"])).toBeNull();
  });

  it("skips a merchandise subtotal (商品合計) and resolves the payable total", () => {
    expect(parseCheckoutAmount(["商品合計 968円", "お支払い金額 1,468円"])).toEqual({
      amount_cents: 1_468,
      currency: "JPY",
    });
  });

  it.each([
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
    ["合計 税抜価格 8,950円"],
    ["合計 8,950 税抜"],
    ["合計 8,950 税別"],
    ["合計 8,950 税別価格"],
    ["合計 8,950円（価格は税抜）"],
    ["合計 8,950円 ※税抜"],
    ["合計数量: 3"],
    ["合計ポイント: 500"],
    ["商品ご注文合計 8,950円"],
    ["会員お支払い金額 8,950円"],
    ["ご注文金額合計 8,950円"],
    ["ここに合計はない"],
  ])("refuses non-total or tax-exclusive Japanese lines: %s", (text) => {
    expect(parseCheckoutAmount([text], "JPY")).toBeNull();
  });

  it.each([
    ["合計 3点"],
    ["合計 3点分"],
    ["合計 3個口"],
    ["合計 500ポイント"],
    ["合計500円分のクーポンをプレゼント"],
  ])("never treats a Japanese count/points line as a payable amount: %s", (text) => {
    expect(parseCheckoutAmount([text], "JPY")).toBeNull();
  });

  it("applies tax-exclusive and count guards to every checkout amount", () => {
    expect(
      parseCheckoutAmounts(
        [
          "合計 8,950円（税抜）",
          "合計 8,950円 ※税抜",
          "合計 税抜 8,950円",
          "合計 税抜価格 8,950円",
          "合計 8,950 税別",
          "合計 8,950 税別価格",
          "合計 3点",
          "合計 3点分",
          "合計 3個口",
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
    const frame = { evaluate: vi.fn().mockResolvedValue("合計 1,468円税込") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
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
    const frame = { evaluate: vi.fn().mockResolvedValue("Order total 98.45") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
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
    const frame = { evaluate: vi.fn().mockResolvedValue(text) };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
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
    "submits a Japanese checkout via its ご注文を確定する charge button, skipping non-charge buttons",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <form id="checkout">
          <input autocomplete="cc-number">
          <input autocomplete="cc-exp">
          <input autocomplete="cc-csc">
          <input autocomplete="cc-name">
          <button type="button" id="change-payment">お支払い方法を変更する</button>
          <button type="button" id="back">戻る</button>
          <button type="submit" id="charge">ご注文を確定する</button>
        </form>
        <script>
          document.querySelector("#change-payment").addEventListener("click", () => {
            document.body.dataset.wrongClick = "change-payment";
          });
          document.querySelector("#back").addEventListener("click", () => {
            document.body.dataset.wrongClick = "back";
          });
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
            country: "JP",
          },
        });

        expect(await page.locator("body").getAttribute("data-submitted")).toBe("true");
        expect(await page.locator("body").getAttribute("data-wrong-click")).toBeNull();
        expect(result.three_ds_required).toBe(true);
      } finally {
        await browser.close();
      }
    },
    30_000,
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
          <input id="alternate-billing-city" name="billing_city" value="Alternate Billing">
          <section id="selected-card-fields">
            <input autocomplete="cc-number">
            <input inputmode="numeric" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <input autocomplete="cc-name">
            <input id="selected-billing-city" name="billing_city">
            <input id="self-tagged-alternate-billing-city" name="billing_city" data-payment-method="paypal" value="Alternate Payment Billing">
          </section>
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
            document.body.dataset.selectedBillingAtSubmit =
              document.querySelector("#selected-billing-city").value;
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
        expect(await page.locator("body").getAttribute("data-selected-billing-at-submit")).toBe(
          "Testville",
        );
        expect(result.three_ds_required).toBe(true);
        expect(await page.locator('input[data-ts-sealed-payment="1"]').count()).toBe(0);
        expect(await page.locator("#alternate-billing-city").inputValue()).toBe(
          "Alternate Billing",
        );
        expect(await page.locator("#selected-billing-city").inputValue()).toBe("");
        expect(await page.locator("#self-tagged-alternate-billing-city").inputValue()).toBe(
          "Alternate Payment Billing",
        );
        expect(
          await page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).toEqual(["", "Alternate Billing", "", "", "", "", "", "Alternate Payment Billing"]);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "keeps non-selected checkout controls intact while clearing the selected Shopify payment form",
    async () => {
      const pciUrl = "https://checkout.pci.shopifyinc.test/card-fields";
      const playwrightBrowser = await chromium.launch({ headless: true });
      try {
        const page = await playwrightBrowser.newPage();
        await page.route("**/*", async (route) => {
          if (route.request().url() === "https://merchant.test/checkout") {
            return route.fulfill({ contentType: "text/html", body: "" });
          }
          if (route.request().url() !== pciUrl) return route.continue();
          return route.fulfill({
            contentType: "text/html",
            body: `
              <style>
                #card-layer { position: relative; height: 200px; }
                #card-layer form { inset: 0; position: absolute; }
                #active-card { z-index: 2; }
              </style>
              <section id="card-layer">
                <form id="covered-card">
                  <input autocomplete="cc-number">
                  <input autocomplete="cc-exp">
                  <input autocomplete="cc-csc">
                  <input autocomplete="cc-name">
                  <input id="covered-billing-line1" name="billing_address1" value="Covered Billing">
                </form>
                <form id="active-card">
                  <input autocomplete="cc-number">
                  <input autocomplete="cc-exp">
                  <input autocomplete="cc-csc">
                  <input autocomplete="cc-name">
                  <input id="active-billing-line1" name="billing_address1">
                </form>
              </section>
              <script>
                document.querySelector("#active-billing-line1").addEventListener("input", (event) => {
                  document.body.dataset.activeBillingLine1 = event.target.value;
                });
              </script>`,
          });
        });
        await page.goto("https://merchant.test/checkout");
        await page.setContent(`
          <style>
            #merchant-layer { min-height: 180px; position: relative; }
            #covered-merchant-form, #active-merchant-surface { inset: 0; position: absolute; }
            #active-merchant-surface { background: white; z-index: 2; }
          </style>
          <input id="shipping-address" autocomplete="address-line1" value="1-2-3 Shibuya">
          <input id="shipping-city" autocomplete="address-level2" value="Tokyo">
          <input id="shipping-postal" autocomplete="postal-code" value="150-0002">
          <select id="shipping-country" autocomplete="country"><option value="JP" selected>Japan</option></select>
          <input id="outside-billing-city" name="billing_city" value="Outside Billing">
          <section style="display: none">
            <input id="hidden-billing-postal" name="billing_postal" value="Hidden Billing">
          </section>
          <section id="payment-method">
            <div id="merchant-layer">
              <form id="covered-merchant-form">
                <input id="covered-merchant-billing" name="billing_city" value="Covered Merchant Billing">
              </form>
              <div id="active-merchant-surface">
                <iframe src="${pciUrl}"></iframe>
                <input id="active-billing-city" name="billing_city">
              </div>
            </div>
            <input id="direct-sibling-alternate-postal" name="billing_postal" data-payment-method="paypal" value="Alternate Postal">
            <section data-payment-method="paypal">
              <input id="alternate-payment-billing-city" name="billing_city" value="Alternate Payment Billing">
            </section>
          </section>
          <button id="pay-now">Pay now</button>
          <script>
            document.querySelector("#active-billing-city").addEventListener("input", (event) => {
              document.body.dataset.activeBillingCity = event.target.value;
            });
            document.querySelector("#direct-sibling-alternate-postal").addEventListener("input", (event) => {
              document.body.dataset.directSiblingAlternatePostal = event.target.value;
            });
            document.querySelector("#pay-now").addEventListener("click", () => {
              history.pushState({}, "", "/receipt/ORD-12345");
              document.body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>");
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: true });

        expect(await page.locator("#shipping-address").inputValue()).toBe("1-2-3 Shibuya");
        expect(await page.locator("#shipping-city").inputValue()).toBe("Tokyo");
        expect(await page.locator("#shipping-postal").inputValue()).toBe("150-0002");
        expect(await page.locator("#shipping-country").inputValue()).toBe("JP");
        expect(await page.locator("#outside-billing-city").inputValue()).toBe("Outside Billing");
        expect(await page.locator("#hidden-billing-postal").inputValue()).toBe("Hidden Billing");
        expect(await page.locator("#covered-merchant-billing").inputValue()).toBe(
          "Covered Merchant Billing",
        );
        expect(await page.locator("#alternate-payment-billing-city").inputValue()).toBe(
          "Alternate Payment Billing",
        );
        expect(
          await page.locator("body").getAttribute("data-direct-sibling-alternate-postal"),
        ).toBeNull();
        expect(await page.locator("#direct-sibling-alternate-postal").inputValue()).toBe(
          "Alternate Postal",
        );
        expect(await page.locator("body").getAttribute("data-active-billing-city")).toBe(
          "Billingville",
        );
        expect(await page.locator("#active-billing-city").inputValue()).toBe("");
        const pciFrame = page.frames().find((frame) => frame.url() === pciUrl)!;
        expect(await pciFrame.locator("#covered-billing-line1").inputValue()).toBe(
          "Covered Billing",
        );
        expect(await pciFrame.locator("body").getAttribute("data-active-billing-line1")).toBe(
          "123 Billing Street",
        );
        expect(await pciFrame.locator("#active-billing-line1").inputValue()).toBe("");
        expect(await pciFrame.locator('#active-card [autocomplete="cc-number"]').inputValue()).toBe(
          "",
        );
        expect(await page.locator('[data-ts-sealed-payment="1"]').count()).toBe(0);
      } finally {
        await playwrightBrowser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "fills billing controls owned by a unique leaf cross-frame payment boundary",
    async () => {
      const pciUrl = "https://checkout.pci.shopifyinc.test/leaf-card-fields";
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/checkout", async (route) =>
          route.fulfill({ contentType: "text/html", body: "" }),
        );
        await page.route(pciUrl, async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <form>
                <input autocomplete="cc-number">
                <input autocomplete="cc-exp">
                <input autocomplete="cc-csc">
                <input autocomplete="cc-name">
              </form>`,
          }),
        );
        await page.goto("https://merchant.test/checkout");
        await page.setContent(`
          <section id="payment-method">
            <div class="card-fields">
              <iframe src="${pciUrl}"></iframe>
            </div>
            <div class="billing-address">
              <input id="leaf-billing-city" name="billing_city">
            </div>
          </section>
          <button id="pay-now">Pay now</button>
          <script>
            document.querySelector("#leaf-billing-city").addEventListener("input", (event) => {
              document.body.dataset.leafBillingCity = event.target.value;
            });
            document.querySelector("#pay-now").addEventListener("click", () => {
              history.pushState({}, "", "/receipt/ORD-12345");
              document.body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>");
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "",
              city: "Billingville",
              postal_code: "",
              country: "",
            },
          }),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: true });

        expect(await page.locator("body").getAttribute("data-leaf-billing-city")).toBe(
          "Billingville",
        );
        expect(await page.locator("#leaf-billing-city").inputValue()).toBe("");
        expect(await page.locator('[data-ts-sealed-payment="1"]').count()).toBe(0);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "prefers a new merchant order confirmation over a simultaneous 3DS signal",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/checkout", async (route) =>
          route.fulfill({ contentType: "text/html", body: "" }),
        );
        await page.goto("https://merchant.test/checkout");
        await page.setContent(`
          <button id="pay">Pay now</button>
          <script>
            document.querySelector("#pay").addEventListener("click", () => {
              history.pushState({}, "", "/receipt/ORD-12345");
              document.body.insertAdjacentHTML(
                "beforeend",
                '<p>Order confirmed</p><iframe title="3D Secure"></iframe>',
              );
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: true,
        });
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "recognizes a plain visible countdown in Shopify's PCI frame",
    async () => {
      const pciUrl = "https://checkout.pci.shopifyinc.com/plain-countdown";
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route(pciUrl, async (route) =>
          route.fulfill({ contentType: "text/html", body: "<div>60 seconds to confirm</div>" }),
        );
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
              setTimeout(() => {
                const frame = document.createElement("iframe");
                frame.src = "${pciUrl}";
                document.body.append(frame);
              }, 50);
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toMatchObject({ three_ds_required: true, order_confirmed: false });
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "recognizes visible DBS bank-app approval copy without hidden challenge metadata",
    async () => {
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
              setTimeout(() => {
                document.body.insertAdjacentHTML(
                  "beforeend",
                  "<div>Approve this payment in your DBS digibank app</div>",
                );
              }, 50);
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toMatchObject({ three_ds_required: true, order_confirmed: false });
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "does not use Shopify's PCI host alone as a 3DS signal",
    async () => {
      const pciUrl = "https://checkout.pci.shopifyinc.com/card-fields";
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(15_000);
      try {
        const page = await browser.newPage();
        await page.route(pciUrl, async (route) =>
          route.fulfill({ contentType: "text/html", body: "<div>Card entry ready</div>" }),
        );
        await page.setContent(`
          <button id="pay">Pay now</button>
          <script>
            document.querySelector("#pay").addEventListener("click", () => {
              const frame = document.createElement("iframe");
              frame.src = "${pciUrl}";
              document.body.append(frame);
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "ignores ordinary, hidden, and covered merchant countdowns",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <style>
            #covered-countdown { position: relative; }
            #countdown-cover { background: white; inset: 0; pointer-events: none; position: absolute; z-index: 2; }
            #offscreen-authentication-challenge {
              align-items: flex-end;
              display: flex;
              height: 300vh;
              left: 500px;
              position: absolute;
              top: 0;
              width: 180px;
            }
          </style>
          <div>60 seconds to confirm</div>
          <section id="bank-transfer-approval"><div>60 seconds to confirm</div></section>
          <section id="identity-review"><div>Verify your identity</div></section>
          <div style="display:none" id="dbs-bank-app-challenge">60 seconds to confirm</div>
          <section id="covered-countdown">
            <div id="shopify-bank-app-challenge">60 seconds to confirm<div id="countdown-cover">Merchant offer</div></div>
          </section>
          <div id="offscreen-authentication-challenge">60 seconds to confirm</div>
          <form id="checkout">
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>document.querySelector("#checkout").addEventListener("submit", (event) => event.preventDefault());</script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "ignores a merchant confirmation signal that predates the Pay now click",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <p id="existing-confirmation">Order confirmed</p>
          <form id="checkout">
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.querySelector("#existing-confirmation").innerHTML =
                "<span>Order confirmed</span><span>.</span>";
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: false });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "ignores merchant confirmation evidence that appears before Pay dispatch",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="decoy">Continue</button>
          <button id="pay-now">Pay now</button>
          <script>
            const decoy = document.querySelector("#decoy");
            const getAttribute = decoy.getAttribute.bind(decoy);
            decoy.getAttribute = (name) => {
              if (name === "aria-label" && !document.querySelector("#early-confirmation")) {
                document.body.insertAdjacentHTML(
                  "beforeend",
                  '<p id="early-confirmation">Order confirmed</p>',
                );
              }
              return getAttribute(name);
            };
            document.querySelector("#pay-now").addEventListener("click", () => {
              document.body.dataset.earlyConfirmationAtPay = String(
                document.querySelector("#early-confirmation") !== null,
              );
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
        expect(await page.locator("body").getAttribute("data-early-confirmation-at-pay")).toBe(
          "true",
        );
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "does not treat generic terminal-shaped evidence as a placed order",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        for (const clickAction of [
          'history.pushState({}, "", "/receipt")',
          'history.pushState({}, "", "/orders/confirmation")',
          'history.pushState({}, "", "/thank_you")',
          'history.pushState({}, "", "/orders/pending/confirmation")',
          'history.pushState({}, "", "/orders/confirmation/thank-you")',
          'history.pushState({}, "", "/thank-you/loading")',
          'history.pushState({}, "", "/receipt/0")',
          'history.pushState({}, "", "/receipt/payment-pending")',
          'history.pushState({}, "", "/receipt/****1234")',
          'history.pushState({}, "", "/orders/pending-123/confirmation")',
          'history.pushState({}, "", "/blank/receipt/123")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number:</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt # 0</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number: processing</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number: xxxx1234</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number: ORD-XXXX1234</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number: 1234****</p>")',
          'document.body.insertAdjacentHTML("beforeend", "<p>Receipt number: 1234 ****</p>")',
        ]) {
          const now = vi
            .spyOn(Date, "now")
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(1)
            .mockReturnValue(15_000);
          const page = await browser.newPage();
          try {
            await page.route("https://merchant.test/**", async (route) =>
              route.fulfill({
                contentType: "text/html",
                body: `
                  <button id="pay-now">Pay now</button>
                  <script>
                    document.querySelector("#pay-now").addEventListener("click", () => {
                      ${clickAction};
                    });
                  </script>`,
              }),
            );
            await page.goto("https://merchant.test/checkout");
            const controller = new BrowserController({ humanize: false });
            (controller as unknown as { page: Page }).page = page;

            await expect(controller.submitFilledCheckout()).resolves.toEqual({
              three_ds_required: false,
              order_confirmed: false,
            });
          } finally {
            now.mockRestore();
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm an order when only a terminal URL query or hash changes",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/receipt/123?attempt=2#retry");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/receipt/123?attempt=1");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm an existing order token when its route becomes terminal",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/orders/ORD-123/confirmation");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/orders/ORD-123");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm an order token already present in the checkout query",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/orders/ORD-123/confirmation");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkout?order_id=ORD-123");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm an order token already present in a hash route",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/orders/ORD-123/confirmation");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkout#/payment?receipt_token=ORD-123");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm an order token already present in a merchant frame",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          await route.fulfill({
            contentType: "text/html",
            body:
              pathname === "/order-context"
                ? "<p>Checkout context</p>"
                : `
                    <iframe src="/order-context?receipt_id=ORD-123"></iframe>
                    <button id="pay-now">Pay now</button>
                    <script>
                      document.querySelector("#pay-now").addEventListener("click", () => {
                        history.replaceState({}, "", "/orders/ORD-123/confirmation");
                      });
                    </script>`,
          });
        });
        await page.goto("https://merchant.test/checkout");
        await page.locator("iframe").contentFrame().locator("body").waitFor();
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not confirm a checkout token reused by a terminal route",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/checkout/ORD-123/thank_you");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkout/ORD-123");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "confirms a genuinely new order token on a terminal route",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://merchant.test/**", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay-now">Pay now</button>
              <script>
                document.querySelector("#pay-now").addEventListener("click", () => {
                  history.replaceState({}, "", "/orders/ORD-456/confirmation");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/orders/ORD-123");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.submitFilledCheckout()).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: true,
        });
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps a click failure pre-dispatch when no charge event fired",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(250);
        await page.setContent(`
          <button id="pay-now">Pay now</button>
          <script>
            const button = document.querySelector("#pay-now");
            const addEventListener = button.addEventListener.bind(button);
            button.addEventListener = (type, listener, options) => {
              addEventListener(type, listener, options);
              if (type === "click") queueMicrotask(() => button.remove());
            };
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const error = await controller.submitFilledCheckout().catch((caught) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PaymentSubmitOutcomeUnknownError);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fails closed when pre-submit payment signal baselines cannot be read",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <p>Order confirmed</p>
          <p>Payment declined</p>
          <form id="checkout">
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              const challenge = document.createElement("iframe");
              challenge.id = "bank-app";
              challenge.title = "Issuer authentication";
              challenge.srcdoc = "<div>60 seconds to confirm</div>";
              document.body.append(challenge);
            });
          </script>
        `);
        await page.evaluate(() => {
          const originalCreateTreeWalker = document.createTreeWalker.bind(document);
          let remainingFailures = 2;
          Object.defineProperty(document, "createTreeWalker", {
            configurable: true,
            value(root: Node, whatToShow?: number, filter?: NodeFilter | null) {
              if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new Error("synthetic baseline read failure");
              }
              return originalCreateTreeWalker(root, whatToShow, filter);
            },
          });
        });
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toMatchObject({ three_ds_required: true, order_confirmed: false });

        await page.locator("#bank-app").evaluate((element) => element.remove());
        let clock = 0;
        const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
        const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
          clock += timeout;
        });
        try {
          await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("unconfirmed");
        } finally {
          wait.mockRestore();
          now.mockRestore();
        }
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "does not treat issuer-frame success copy as merchant confirmation after 3DS",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <form id="checkout">
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              const challenge = document.createElement("iframe");
              challenge.id = "bank-app";
              challenge.title = "Issuer authentication";
              challenge.srcdoc = "<div>60 seconds to confirm</div>";
              document.body.append(challenge);
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toMatchObject({ three_ds_required: true, order_confirmed: false });

        const bankFrame = page.frames().find((frame) => frame !== page.mainFrame())!;
        await bankFrame.locator("body").evaluate((body) => {
          body.textContent = "Payment successful";
        });
        let clock = 0;
        const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
        const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
          clock += timeout;
        });
        try {
          await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("unconfirmed");
        } finally {
          wait.mockRestore();
          now.mockRestore();
        }
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "ignores newly mounted hidden and covered merchant confirmation copy",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1)
        .mockReturnValue(15_000);
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <style>
            #covered-confirmation { display: block; position: relative; }
            #confirmation-cover { background: white; inset: 0; pointer-events: none; position: absolute; z-index: 2; }
            #offscreen-confirmation {
              align-items: flex-end;
              display: flex;
              height: 300vh;
              left: 500px;
              position: absolute;
              top: 0;
              width: 180px;
            }
          </style>
          <form id="checkout">
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.insertAdjacentHTML(
                "beforeend",
                '<p style="display:none">Order confirmed</p>' +
                  '<p style="opacity:0">Order confirmed</p>' +
                  '<p id="covered-confirmation">Order confirmed<span id="confirmation-cover">Still processing</span></p>' +
                  '<p id="offscreen-confirmation">Order confirmed</p>',
              );
            });
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(
          controller.fillAndSubmitCheckout({
            pan: "4242424242424242",
            exp_month: "12",
            exp_year: "30",
            cvv: "123",
            name: "Synthetic Cardholder",
            billing: {
              line1: "123 Billing Street",
              city: "Billingville",
              postal_code: "10001",
              country: "US",
            },
          }),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: false });
      } finally {
        now.mockRestore();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "fills and submits a single-page checkout whose card fields mount in a cross-origin iframe AFTER the call starts",
    async () => {
      const pciUrl = "https://checkout.pci.shopifyinc.test/card-fields";
      const playwrightBrowser = await chromium.launch({ headless: true });
      try {
        const page = await playwrightBrowser.newPage();
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === pciUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: `
                <input autocomplete="cc-number">
                <input inputmode="numeric" placeholder="MM/YY">
                <input autocomplete="cc-csc">
                <input autocomplete="cc-name">`,
            });
          }
          return route.continue();
        });
        await page.setContent(`
          <title>Kobee Japan</title>
          <div>Order total 4,900円</div>
          <button type="button" id="place-order">Place order</button>
          <script>
            // The PCI iframe mounts only once the payment section renders —
            // absent on first load, appearing well after the call to fill it
            // has already started.
            setTimeout(() => {
              const frame = document.createElement("iframe");
              frame.src = "${pciUrl}";
              document.body.append(frame);
            }, 500);
            document.querySelector("#place-order").addEventListener("click", () => {
              document.body.dataset.submitted = "true";
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
            country: "JP",
          },
        });

        expect(result.three_ds_required).toBe(false);
        expect(await page.locator("body").getAttribute("data-submitted")).toBe("true");
        const pciFrame = page.frames().find((frame) => frame.url() === pciUrl)!;
        expect(await pciFrame.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
      } finally {
        await playwrightBrowser.close();
      }
    },
    30_000,
  );
});

function orderJsonLd(due: Record<string, unknown>): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Order",
    totalPaymentDue: due,
  });
}

function structuredCheckoutController(text: string, structured: unknown): BrowserController {
  const browser = new BrowserController({ humanize: false });
  const mainFrame = {
    evaluate: vi.fn(async (fn: () => unknown) =>
      String(fn).includes("ld+json") ? structured : text,
    ),
  };
  const page = {
    evaluate: vi.fn().mockResolvedValue({ title: "Synthetic Shop", siteName: "" }),
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    url: () => "https://shop.example.test/checkout",
  };
  Object.defineProperty(browser, "page", { value: page });
  return browser;
}

describe("structured-data checkout totals", () => {
  it("reads a JSON-LD Order.totalPaymentDue price specification", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            orderJsonLd({
              "@type": "PriceSpecification",
              price: "149.90",
              priceCurrency: "USD",
            }),
          ],
          microdata: [],
        },
      ]),
    ).toEqual({ amount_cents: 14_990, currency: "USD" });
  });

  it("reads an Invoice MonetaryAmount with numeric value in a zero-decimal currency", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Invoice",
              totalPaymentDue: { "@type": "MonetaryAmount", value: 1_468, currency: "JPY" },
            }),
          ],
          microdata: [],
        },
      ]),
    ).toEqual({ amount_cents: 1_468, currency: "JPY" });
  });

  it("finds an Order nested inside @graph", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "WebPage", name: "Checkout" },
                {
                  "@type": "https://schema.org/Order",
                  totalPaymentDue: { price: "25.00", priceCurrency: "EUR" },
                },
              ],
            }),
          ],
          microdata: [],
        },
      ]),
    ).toEqual({ amount_cents: 2_500, currency: "EUR" });
  });

  it("reads a microdata order total", () => {
    expect(
      parseStructuredCheckoutTotal([
        { jsonLd: [], microdata: [{ price: "89.99", currency: "GBP" }] },
      ]),
    ).toEqual({ amount_cents: 8_999, currency: "GBP" });
  });

  it("never treats an Offer or Product price as the checkout total", () => {
    // Offer.price is a UNIT price; treating it as the payable total would
    // charge-approve the wrong amount on any quantity > 1 or multi-item cart.
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Product",
              name: "Synthetic Widget",
              offers: { "@type": "Offer", price: "49.00", priceCurrency: "USD" },
            }),
          ],
          microdata: [],
        },
      ]),
    ).toBeNull();
  });

  it("rejects an Offer assigned to Order.totalPaymentDue", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [orderJsonLd({ "@type": "Offer", price: "49.00", priceCurrency: "USD" })],
          microdata: [],
        },
      ]),
    ).toBeNull();
  });

  it.each([
    ["malformed JSON", { jsonLd: ["{not json"], microdata: [] }],
    ["missing currency", { jsonLd: [orderJsonLd({ price: "25.00" })], microdata: [] }],
    [
      "unknown currency code",
      { jsonLd: [orderJsonLd({ price: "25.00", priceCurrency: "ZZZ" })], microdata: [] },
    ],
    [
      "symbol instead of ISO code",
      { jsonLd: [orderJsonLd({ price: "25.00", priceCurrency: "$" })], microdata: [] },
    ],
    [
      "zero amount (template default risk)",
      { jsonLd: [orderJsonLd({ price: 0, priceCurrency: "USD" })], microdata: [] },
    ],
    [
      "negative amount",
      { jsonLd: [orderJsonLd({ price: -5, priceCurrency: "USD" })], microdata: [] },
    ],
    [
      "comma-decimal notation",
      { jsonLd: [orderJsonLd({ price: "1.468,00", priceCurrency: "EUR" })], microdata: [] },
    ],
    [
      "currency-prefixed price string",
      { jsonLd: [orderJsonLd({ price: "$25.00", priceCurrency: "USD" })], microdata: [] },
    ],
    [
      "fractional minor units for a zero-decimal currency",
      { jsonLd: [orderJsonLd({ price: "96.8", priceCurrency: "JPY" })], microdata: [] },
    ],
    ["non-conforming extract shape", "合計 1,468円"],
    ["null extract (frame evaluate failed)", null],
  ])("refuses %s", (_label, extract) => {
    expect(parseStructuredCheckoutTotal([extract])).toBeNull();
  });

  it("refuses disagreeing structured totals as ambiguous", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            orderJsonLd({ price: "25.00", priceCurrency: "USD" }),
            orderJsonLd({ price: "30.00", priceCurrency: "USD" }),
          ],
          microdata: [],
        },
      ]),
    ).toBeNull();
  });

  it("refuses a valid total alongside an invalid totalPaymentDue claim", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            orderJsonLd({ price: "25.00", priceCurrency: "USD" }),
            orderJsonLd({ price: "30.00" }),
          ],
          microdata: [],
        },
      ]),
    ).toBeNull();
  });

  it("refuses conflicting aliases within one totalPaymentDue claim", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [
            orderJsonLd({
              price: "25.00",
              value: "30.00",
              priceCurrency: "USD",
              currency: "USD",
            }),
          ],
          microdata: [],
        },
      ]),
    ).toBeNull();
  });

  it("refuses a valid total alongside incomplete microdata", () => {
    expect(
      parseStructuredCheckoutTotal([
        {
          jsonLd: [orderJsonLd({ price: "25.00", priceCurrency: "USD" })],
          microdata: [{ price: "30.00", currency: "" }],
        },
      ]),
    ).toBeNull();
  });

  it("accepts duplicate agreeing candidates across frames and sources", () => {
    expect(
      parseStructuredCheckoutTotal([
        { jsonLd: [orderJsonLd({ price: "25.00", priceCurrency: "USD" })], microdata: [] },
        { jsonLd: [], microdata: [{ price: "25.00", currency: "USD" }] },
      ]),
    ).toEqual({ amount_cents: 2_500, currency: "USD" });
  });

  it("rescues a total the text parser cannot label, in both readers", async () => {
    // "Genel Toplam" (Turkish) is not a recognized text label; the structured
    // order total is the only readable source.
    const structured = {
      jsonLd: [orderJsonLd({ price: "149.90", priceCurrency: "TRY" })],
      microdata: [],
    };
    await expect(
      structuredCheckoutController("Genel Toplam 149,90 TL", structured).readCheckoutSummary(),
    ).resolves.toMatchObject({ amount_cents: 14_990, currency: "TRY" });
    await expect(
      structuredCheckoutController(
        "Genel Toplam 149,90 TL",
        structured,
      ).readCheckoutReviewSummary(),
    ).resolves.toMatchObject({ amount_cents: 14_990, currency: "TRY" });
  });

  it("requires a visible labeled total with live currency for charge confirmation", async () => {
    const structured = {
      jsonLd: [orderJsonLd({ price: "149.90", priceCurrency: "USD" })],
      microdata: [],
    };
    await expect(
      structuredCheckoutController("Genel Toplam 149,90", structured).readCheckoutConfirmSummary(),
    ).rejects.toThrow("payment_checkout_total_not_found");
    await expect(
      structuredCheckoutController("Order total 149.90", structured).readCheckoutConfirmSummary(),
    ).rejects.toThrow("payment_checkout_total_not_found");
    await expect(
      structuredCheckoutController(
        "Order total US$ 149.90",
        structured,
      ).readCheckoutConfirmSummary(),
    ).resolves.toMatchObject({ amount_cents: 14_990, currency: "USD" });
  });

  it("requires unambiguous live currency notation only for charge confirmation", async () => {
    const structured = { jsonLd: [], microdata: [] };
    await expect(
      structuredCheckoutController("Order total $39.99", structured).readCheckoutConfirmSummary(),
    ).rejects.toThrow("payment_checkout_currency_unresolved");
    await expect(
      structuredCheckoutController("Order total ¥3,999", structured).readCheckoutConfirmSummary(),
    ).rejects.toThrow("payment_checkout_currency_unresolved");
    await expect(
      structuredCheckoutController("Order total US$39.99", structured).readCheckoutConfirmSummary(),
    ).resolves.toMatchObject({ amount_cents: 3_999, currency: "USD" });
    await expect(
      structuredCheckoutController(
        "Order total JPY 3,999",
        structured,
      ).readCheckoutConfirmSummary(),
    ).resolves.toMatchObject({ amount_cents: 3_999, currency: "JPY" });
    expect(parseCheckoutAmount(["Order total $39.99"])).toEqual({
      amount_cents: 3_999,
      currency: "USD",
    });
  });

  it.each([
    ["CA$", "CAD"],
    ["C$", "CAD"],
    ["CAD$", "CAD"],
    ["A$", "AUD"],
    ["AU$", "AUD"],
    ["NZ$", "NZD"],
    ["HK$", "HKD"],
    ["SG$", "SGD"],
    ["MX$", "MXN"],
  ])("resolves unambiguous %s notation during confirmation", async (notation, currency) => {
    await expect(
      structuredCheckoutController(`Order total ${notation}39.99`, {
        jsonLd: [],
        microdata: [],
      }).readCheckoutConfirmSummary(),
    ).resolves.toMatchObject({ amount_cents: 3_999, currency });
  });

  it("uses the final visible payable total during confirmation", async () => {
    await expect(
      structuredCheckoutController("Items total USD 39.99\nOrder total USD 49.99", {
        jsonLd: [],
        microdata: [],
      }).readCheckoutConfirmSummary(),
    ).resolves.toMatchObject({ amount_cents: 4_999, currency: "USD" });
  });

  it("keeps the visible labeled total when structured data disagrees", async () => {
    // Stale server-rendered JSON-LD must not override the total the user sees.
    await expect(
      structuredCheckoutController("Order total US$ 98.45", {
        jsonLd: [orderJsonLd({ price: "80.00", priceCurrency: "USD" })],
        microdata: [],
      }).readCheckoutSummary(),
    ).resolves.toMatchObject({ amount_cents: 9_845, currency: "USD" });
  });

  it("keeps the final clean review total after earlier unresolved currency", async () => {
    await expect(
      structuredCheckoutController("Order total 98.45 kr\nOrder total US$ 100.00", {
        jsonLd: [orderJsonLd({ price: "80.00", priceCurrency: "USD" })],
        microdata: [],
      }).readCheckoutReviewSummary("USD"),
    ).resolves.toMatchObject({ amount_cents: 10_000, currency: "USD" });
  });

  it.each(["readCheckoutSummary", "readCheckoutReviewSummary"] as const)(
    "keeps the currency-unresolved guard in %s when a structured total exists",
    async (reader) => {
      const controller = structuredCheckoutController("Order total 98.45 kr", {
        jsonLd: [orderJsonLd({ price: "98.45", priceCurrency: "SEK" })],
        microdata: [],
      });
      await expect(controller[reader]("USD")).rejects.toMatchObject({
        message: "payment_checkout_currency_unresolved",
      });
    },
  );

  it.each(["readCheckoutSummary", "readCheckoutReviewSummary"] as const)(
    "keeps the fallback-scale-mismatch guard in %s when a structured total exists",
    async (reader) => {
      const controller = structuredCheckoutController("Order total 98.45", {
        jsonLd: [orderJsonLd({ price: "98", priceCurrency: "JPY" })],
        microdata: [],
      });
      await expect(controller[reader]("JPY")).rejects.toMatchObject({
        message: "payment_checkout_currency_unresolved_scale_mismatch",
      });
    },
  );

  it("falls through when malformed JSON-LD accompanies an otherwise valid total", async () => {
    await expect(
      structuredCheckoutController("Genel Toplam 25,00", {
        jsonLd: [orderJsonLd({ price: "25.00", priceCurrency: "USD" }), "{broken"],
        microdata: [],
      }).readCheckoutSummary(),
    ).rejects.toThrow("payment_checkout_total_not_found");
  });

  it("still reports total_not_found when only an Offer price is structured", async () => {
    await expect(
      structuredCheckoutController("Synthetic Widget — great value!", {
        jsonLd: [
          JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            offers: { "@type": "Offer", price: "49.00", priceCurrency: "USD" },
          }),
        ],
        microdata: [],
      }).readCheckoutSummary("USD"),
    ).rejects.toThrow("payment_checkout_total_not_found");
  });

  it("resolves Japanese text totals unchanged when no structured total is present", async () => {
    await expect(
      structuredCheckoutController("合計 1,468円", {
        jsonLd: ["{not json"],
        microdata: [],
      }).readCheckoutSummary(),
    ).resolves.toMatchObject({ amount_cents: 1_468, currency: "JPY" });
  });

  it.skipIf(!chromiumAvailable)(
    "extracts JSON-LD and microdata order totals from a live page",
    async () => {
      const playwrightBrowser = await chromium.launch({ headless: true });
      try {
        const page = await playwrightBrowser.newPage();
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        // JSON-LD order total, no text label the prose parser recognizes.
        await page.setContent(`
          <title>Synthetic Shop</title>
          <script type="application/ld+json">
            ${orderJsonLd({ "@type": "PriceSpecification", price: "149.90", priceCurrency: "USD" })}
          </script>
          <div>Genel Toplam 149,90</div>
        `);
        await expect(controller.readCheckoutSummary()).resolves.toMatchObject({
          amount_cents: 14_990,
          currency: "USD",
        });

        // Microdata order total.
        await page.setContent(`
          <title>Synthetic Shop</title>
          <div itemscope itemtype="https://schema.org/Order">
            <div itemprop="totalPaymentDue" itemscope itemtype="https://schema.org/PriceSpecification">
              <meta itemprop="price" content="89.99">
              <meta itemprop="priceCurrency" content="GBP">
            </div>
          </div>
          <div>Genel Toplam 89,99</div>
        `);
        await expect(controller.readCheckoutSummary()).resolves.toMatchObject({
          amount_cents: 8_999,
          currency: "GBP",
        });

        await page.setContent(`
          <title>Synthetic Shop</title>
          <div itemscope itemtype="https://schema.org/Order">
            <div itemprop="totalPaymentDue" itemscope itemtype="https://schema.org/PriceSpecification">
              <div itemscope itemtype="https://schema.org/Offer">
                <meta itemprop="price" content="49.00">
                <meta itemprop="priceCurrency" content="USD">
              </div>
              <meta itemprop="price" content="89.99">
              <meta itemprop="priceCurrency" content="GBP">
            </div>
          </div>
          <div>Genel Toplam 89,99</div>
        `);
        await expect(controller.readCheckoutSummary()).resolves.toMatchObject({
          amount_cents: 8_999,
          currency: "GBP",
        });

        await page.setContent(`
          <title>Synthetic Shop</title>
          <div itemscope itemtype="https://schema.org/Order">
            <div itemprop="totalPaymentDue" itemscope itemtype="https://schema.org/Offer">
              <meta itemprop="price" content="49.00">
              <meta itemprop="priceCurrency" content="USD">
            </div>
          </div>
          <div>Genel Toplam 49,00</div>
        `);
        await expect(controller.readCheckoutSummary()).rejects.toThrow(
          "payment_checkout_total_not_found",
        );

        // Product-page unit price is never a total; the text label wins.
        await page.setContent(`
          <title>Synthetic Shop</title>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer","price":"49.00","priceCurrency":"USD"}}
          </script>
          <div>Order total US$ 98.45</div>
        `);
        await expect(controller.readCheckoutSummary()).resolves.toMatchObject({
          amount_cents: 9_845,
          currency: "USD",
        });

        // Malformed JSON-LD falls through to the #466 Japanese text path.
        await page.setContent(`
          <title>Synthetic Shop</title>
          <script type="application/ld+json">{broken</script>
          <div>合計 1,468円</div>
        `);
        await expect(controller.readCheckoutSummary()).resolves.toMatchObject({
          amount_cents: 1_468,
          currency: "JPY",
        });
      } finally {
        await playwrightBrowser.close();
      }
    },
  );
});

describe("3-D Secure resolution", () => {
  const setupChallenge = async (
    initialMerchantHtml = "",
  ): Promise<{
    browser: Browser;
    page: Page;
    controller: BrowserController;
  }> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route("https://issuer.test/**", async (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Payment declined</p>" }),
    );
    await page.route("https://merchant.test/**", async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
          ${initialMerchantHtml}
          <button id="pay">Pay now</button>
          <script>
            document.querySelector("#pay").addEventListener("click", () => {
              const frame = document.createElement("iframe");
              frame.id = "bank-approval";
              frame.title = "DBS bank approval";
              frame.srcdoc = "<div>60 seconds to confirm</div>";
              document.body.append(frame);
            });
          </script>`,
      }),
    );
    await page.goto("https://merchant.test/checkout");
    const controller = new BrowserController({ humanize: false });
    (controller as unknown as { page: Page }).page = page;
    await expect(controller.submitFilledCheckout()).resolves.toMatchObject({
      three_ds_required: true,
      order_confirmed: false,
    });
    return { browser, page, controller };
  };

  it.skipIf(!chromiumAvailable)(
    "does not treat an unchanged checkout confirmation URL as success",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      const wait = vi.spyOn(page, "waitForTimeout").mockResolvedValue();
      try {
        await page.evaluate(() => history.replaceState({}, "", "/checkout?success_url=/done"));
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("timeout");
      } finally {
        wait.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not accept merchant order-confirmation text without a terminal route",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      try {
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await page.locator("body").evaluate((body) => {
          body.insertAdjacentHTML("beforeend", "<p>Thank you <strong>for your order</strong></p>");
        });
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("unconfirmed");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("accepts a transitioned merchant receipt URL", async () => {
    const { browser, page, controller } = await setupChallenge();
    try {
      await page.locator("#bank-approval").evaluate((element) => element.remove());
      await page.evaluate(() => history.pushState({}, "", "/receipt/123"));
      await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("succeeded");
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "does not accept a merchant receipt number without a terminal route",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      try {
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await page.locator("body").evaluate((body) => {
          body.insertAdjacentHTML("beforeend", "<p>Receipt number: ORD-12345</p>");
        });
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("unconfirmed");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "returns unconfirmed for payment-only DOM and URL states",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      let clock = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
      });
      try {
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await page.evaluate(() => {
          history.pushState({}, "", "/payment_success");
          document.body.insertAdjacentHTML(
            "beforeend",
            "<p>Payment created</p><p>Payment processing</p><p>Payment successful</p><p>Failed payment creation</p>",
          );
        });
        await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("unconfirmed");
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps waiting through a transient challenge gap and delayed order confirmation",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      await page.locator("#bank-approval").evaluate((element) => element.remove());
      let clock = 0;
      let waits = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
        waits += 1;
        if (waits === 1) {
          await page.locator("body").evaluate((body) => {
            body.insertAdjacentHTML(
              "beforeend",
              '<iframe id="bank-approval" title="DBS bank approval" srcdoc="<div>60 seconds to confirm</div>"></iframe>',
            );
          });
        }
        if (waits === 2) {
          await page.locator("#bank-approval").evaluate((element) => element.remove());
        }
        if (waits === 3) {
          await page.locator("body").evaluate((body) => {
            history.pushState({}, "", "/receipt/ORD-12345");
            body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>");
          });
        }
      });
      try {
        await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("succeeded");
        expect(waits).toBe(3);
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "lets a new merchant order confirmation win over simultaneous failure text",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      try {
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await page.evaluate(() => {
          history.pushState({}, "", "/receipt/123");
          document.body.insertAdjacentHTML(
            "beforeend",
            "<p>Order confirmed</p><p>Payment declined</p>",
          );
        });
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("succeeded");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("ignores pre-submit visible payment failure text", async () => {
    const { browser, page, controller } = await setupChallenge("<p>Payment declined</p>");
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
      clock += timeout;
    });
    try {
      await page.locator("#bank-approval").evaluate((element) => element.remove());
      await page.getByText("Payment declined", { exact: true }).evaluate((element) => {
        element.textContent = "Payment   declined.";
      });
      await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("unconfirmed");
    } finally {
      wait.mockRestore();
      now.mockRestore();
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "returns unconfirmed when a short 3DS wait ends after challenge resolution",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      let clock = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
      });
      try {
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await expect(controller.waitForThreeDsResolution(500)).resolves.toBe("unconfirmed");
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps a pre-submit issuer failure stable across URL query and hash changes",
    async () => {
      const { browser, page, controller } = await setupChallenge(
        '<iframe id="issuer-error" src="https://issuer.test/error?attempt=1"></iframe>',
      );
      try {
        const issuerFrame = page
          .frames()
          .find((frame) => frame.url().startsWith("https://issuer.test/error"))!;
        await issuerFrame.evaluate(() => {
          history.replaceState({}, "", "/error?attempt=2#retry");
        });
        await page.locator("#bank-approval").evaluate((element) => element.remove());
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("unconfirmed");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("returns failed for new visible payment failure text", async () => {
    const { browser, page, controller } = await setupChallenge();
    try {
      await page.locator("#bank-approval").evaluate((element) => element.remove());
      await page.locator("body").evaluate((body) => {
        body.insertAdjacentHTML("beforeend", "<p>Payment declined</p>");
      });
      await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("failed");
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)("ignores new hidden payment failure text", async () => {
    const { browser, page, controller } = await setupChallenge();
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
      clock += timeout;
    });
    try {
      await page.locator("#bank-approval").evaluate((element) => element.remove());
      await page.locator("body").evaluate((body) => {
        body.insertAdjacentHTML("beforeend", '<p style="display:none">Payment declined</p>');
      });
      await expect(controller.waitForThreeDsResolution(10_000)).resolves.toBe("unconfirmed");
    } finally {
      wait.mockRestore();
      now.mockRestore();
      await browser.close();
    }
  });
});

describe("recognized payment-provider frames", () => {
  const PAGE = "https://shop.rakuten.co.jp/checkout/payment";

  it("allows the merchant's own registrable domain (payment subdomain included)", () => {
    expect(
      recognizedPaymentProviderFrame(
        "https://pay.shop.example.com/fields",
        "https://shop.example.com/checkout",
      ),
    ).toBe(true);
  });

  it("allows curated processors across registrable domains (the Rakuten split case)", () => {
    // rakuten.co.jp (co.jp is a public suffix) vs rakuten.com are DIFFERENT
    // registrable domains — exactly why the live run's secret-fill refused it.
    expect(
      recognizedPaymentProviderFrame(
        "https://static-content.payment.global.rakuten.com/card-form",
        PAGE,
      ),
    ).toBe(true);
    expect(recognizedPaymentProviderFrame("https://js.stripe.com/v3/elements", PAGE)).toBe(true);
    expect(
      recognizedPaymentProviderFrame("https://checkoutshopper-live.adyen.com/fields", PAGE),
    ).toBe(true);
    expect(
      recognizedPaymentProviderFrame("https://assets.braintreegateway.com/hosted-fields", PAGE),
    ).toBe(true);
  });

  it("refuses arbitrary cross-origin frames, look-alikes, and non-https", () => {
    expect(recognizedPaymentProviderFrame("https://rogue-payments.example.net/f", PAGE)).toBe(
      false,
    );
    // A look-alike host CONTAINING a processor name is not that processor.
    expect(recognizedPaymentProviderFrame("https://stripe.com.evil.net/f", PAGE)).toBe(false);
    expect(recognizedPaymentProviderFrame("https://evilstripe.com/f", PAGE)).toBe(false);
    // The whole of rakuten.com is a marketplace, not a processor — only the
    // payment platform subdomain qualifies.
    expect(recognizedPaymentProviderFrame("https://www.rakuten.com/deals", PAGE)).toBe(false);
    expect(recognizedPaymentProviderFrame("http://js.stripe.com/v3/elements", PAGE)).toBe(false);
    expect(
      recognizedPaymentProviderFrame(
        "http://shop.rakuten.co.jp/checkout/payment",
        "http://shop.rakuten.co.jp/checkout/payment",
      ),
    ).toBe(false);
    expect(recognizedPaymentProviderFrame("about:blank", PAGE)).toBe(false);
    expect(recognizedPaymentProviderFrame("", PAGE)).toBe(false);
  });
});

// Real-Chromium split-checkout fill: route interception serves fake domains so
// the payment iframe is genuinely cross-origin, no network required.
describe("split-checkout card fill (real browser)", () => {
  const CARD = {
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
  };

  const FRAME_FORM = `
    <form id="card-form">
      <input autocomplete="cc-number">
      <input inputmode="numeric" placeholder="MM/YY">
      <input autocomplete="cc-csc">
      <input autocomplete="cc-name">
      <button type="submit">Pay now</button>
    </form>
    <script>
      document.querySelector("#card-form").addEventListener("submit", (event) => {
        event.preventDefault();
        document.body.dataset.submitted = "true";
      });
    </script>`;

  const TOPMOST_SPLIT_PAN_STYLE = `
    <style>
      #combined [autocomplete="cc-number"],
      [form="combined"][autocomplete="cc-number"],
      #split [autocomplete="cc-number"],
      [form="split"][autocomplete="cc-number"] {
        left: 0;
        position: absolute;
        top: 0;
      }
      #split [autocomplete="cc-number"],
      [form="split"][autocomplete="cc-number"] {
        z-index: 1;
      }
    </style>`;

  async function servePages(pages: Record<string, string>): Promise<{
    page: Page;
    browser: Browser;
  }> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      const body = pages[url];
      if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
      return route.fulfill({ contentType: "text/html", body });
    });
    return { page, browser };
  }

  it.skipIf(!chromiumAvailable)(
    "post-verifies the exact requested variant through the live DOM",
    async () => {
      const pageUrl = "https://shop.example.test/cart";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Synthetic Shop</title>
          <div data-testid="line-item-m" data-product-identity="sku:tiara" data-options-hash="size=M">
            <a href="/products/tiara">Tiara</a>
            <span>Size M</span>
            <input name="quantity-m" value="0">
          </div>
          <div data-testid="line-item-l" data-product-identity="sku:tiara" data-options-hash="size=L">
            <a href="/products/tiara">Tiara</a>
            <span>Size L</span>
            <input name="quantity-l" value="1">
          </div>
          <div>Subtotal USD 20.00 Shipping USD 5.00 Order total USD 25.00</div>
          <button id="add">Add to Cart</button>
          <script>
            document.querySelector("#add").addEventListener("click", () => {
              const quantity = document.querySelector('[name="quantity-m"]');
              quantity.value = String(Number(quantity.value) + 1);
              document.body.dataset.addClicks = String(Number(document.body.dataset.addClicks || "0") + 1);
            });
          </script>`,
      });
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;
      try {
        const started = await startHarnessProvisionSession({
          serviceUrl: pageUrl,
          browser: controller,
        });

        const added = await cartAdd(started.session_id, "sku:tiara", "size=M", "tiara-m");
        const retried = await cartAdd(started.session_id, "sku:tiara", "size=M", "tiara-m");
        const lines = await controller.readCheckoutReviewLineItems(true);

        expect(added).toMatchObject({ status: "added", cart_delta: "+1" });
        expect(retried).toMatchObject({ status: "already_in_cart", cart_delta: "0" });
        expect(lines).toEqual([
          expect.objectContaining({
            title: "Tiara",
            quantity: 1,
            product_identities: expect.arrayContaining(["sku:tiara"]),
            option_signatures: expect.arrayContaining(["size=M"]),
          }),
          expect.objectContaining({
            title: "Tiara",
            quantity: 1,
            product_identities: expect.arrayContaining(["sku:tiara"]),
            option_signatures: expect.arrayContaining(["size=L"]),
          }),
        ]);
        expect(await page.locator('[name="quantity-m"]').inputValue()).toBe("1");
        expect(await page.locator('[name="quantity-l"]').inputValue()).toBe("1");
        expect(await page.locator("body").getAttribute("data-add-clicks")).toBe("1");
      } finally {
        await closeAllProvisionSessions();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "refuses card fill on a non-HTTPS main page before writing any field",
    async () => {
      const pageUrl = "http://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({ [pageUrl]: FRAME_FORM });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_checkout_https_required",
        );
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fills a recognized payment-provider iframe on a page with NO total, without submitting",
    async () => {
      const frameUrl = "https://static-content.payment.global.rakuten.com/card-form";
      const { page, browser } = await servePages({
        "https://shop.rakuten.co.jp/checkout/payment": `
          <title>Payment method</title>
          <p>Choose your payment method. The order total is shown on the next step.</p>
          <iframe src="${frameUrl}"></iframe>
          <button>Next</button>`,
        [frameUrl]: FRAME_FORM,
      });
      try {
        await page.goto("https://shop.rakuten.co.jp/checkout/payment");
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);

        const frame = page.frames().find((f) => f.url() === frameUrl)!;
        // The card landed inside the payment-provider frame…
        expect(await frame.locator('[autocomplete="cc-number"]').inputValue()).toBe(CARD.pan);
        expect(await frame.locator('[autocomplete="cc-csc"]').inputValue()).toBe(CARD.cvv);
        // No formatter script in the frame, so the four typed digits remain raw.
        expect(await frame.locator('[placeholder="MM/YY"]').inputValue()).toBe("1230");
        // …every filled field is marked sealed so observations mask it…
        expect(await frame.locator('[data-ts-sealed-payment="1"]').count()).toBeGreaterThanOrEqual(
          4,
        );
        // …and NOTHING was submitted: filling is not charging.
        expect(await frame.locator("body").getAttribute("data-submitted")).toBeNull();
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fills the more complete Shopify card form coherently when two variants are mounted",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/two-card-forms";
      const { page, browser } = await servePages({
        [pageUrl]: `<title>Kobee Japan</title><iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          ${TOPMOST_SPLIT_PAN_STYLE}
          <form id="combined">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
          </form>
          <form id="split">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);

        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        expect(await frame.locator("#combined [autocomplete=cc-number]").inputValue()).toBe("");
        expect(await frame.locator("#combined [autocomplete=cc-name]").inputValue()).toBe("");
        expect(await frame.locator("#combined [autocomplete=cc-exp]").inputValue()).toBe("");
        expect(await frame.locator("#combined [autocomplete=cc-csc]").inputValue()).toBe("");
        expect(await frame.locator("#split [autocomplete=cc-number]").inputValue()).toBe(CARD.pan);
        expect(await frame.locator("#split [autocomplete=cc-name]").inputValue()).toBe(CARD.name);
        expect(await frame.locator("#split [autocomplete=cc-exp-month]").inputValue()).toBe("12");
        expect(await frame.locator("#split [autocomplete=cc-exp-year]").inputValue()).toBe("30");
        expect(await frame.locator("#split [autocomplete=cc-csc]").inputValue()).toBe(CARD.cvv);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "submits only the selected Shopify card form when both variants have pay controls",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          ${TOPMOST_SPLIT_PAN_STYLE}
          <form id="combined">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <form id="split">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <script>
            for (const form of document.querySelectorAll("form")) {
              form.addEventListener("submit", (event) => {
                event.preventDefault();
                document.body.dataset.submittedForm = form.id;
                document.body.dataset.submittedValues = JSON.stringify(
                  Array.from(form.querySelectorAll("input"), (input) => input.value),
                );
                const challenge = document.createElement("iframe");
                challenge.title = "3D Secure";
                challenge.style.cssText =
                  "position:fixed;inset:0;width:100%;height:100%;z-index:9999";
                document.body.append(challenge);
              });
            }
          </script>
        `);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const result = await controller.fillAndSubmitCheckout(CARD);

        expect(result.three_ds_required).toBe(true);
        expect(await page.locator("body").getAttribute("data-submitted-form")).toBe("split");
        expect(
          JSON.parse((await page.locator("body").getAttribute("data-submitted-values")) ?? "null"),
        ).toEqual([CARD.pan, CARD.name, "12", "30", CARD.cvv]);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "uses the topmost PAN to fill and submit the live-style Shopify PCI form",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/live-two-card-forms";
      const { page, browser } = await servePages({
        [pageUrl]: `<title>Kobee Japan</title><iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          <style>
            #card-layer { position: relative; height: 240px; }
            #card-layer form {
              display: grid;
              gap: 8px;
              inset: 0;
              position: absolute;
            }
            #card-number-network-selector-name-on-card-expiry { z-index: 2; }
          </style>
          <section id="card-layer">
            <form id="credit-card-number-name-on-card-expiry-month-exp">
              <input autocomplete="cc-number">
              <input autocomplete="cc-name">
              <input autocomplete="cc-exp">
              <input autocomplete="cc-exp-month">
              <input autocomplete="cc-exp-year">
              <input autocomplete="cc-csc">
              <input name="issue-date">
              <input name="issue-number">
              <button type="submit">Pay now</button>
            </form>
            <form id="card-number-network-selector-name-on-card-expiry">
              <input autocomplete="cc-number">
              <input autocomplete="cc-name">
              <input autocomplete="cc-exp">
              <input autocomplete="cc-exp-month">
              <input autocomplete="cc-exp-year">
              <input autocomplete="cc-csc">
              <input name="issue-date">
              <input name="issue-number">
              <button type="submit">Pay now</button>
            </form>
          </section>
          <script>
            for (const form of document.querySelectorAll("form")) {
              form.addEventListener("submit", (event) => {
                event.preventDefault();
                document.body.dataset.submittedForm = form.id;
                document.body.dataset.submittedValues = JSON.stringify(
                  Array.from(form.querySelectorAll("input"), (input) => input.value),
                );
                const challenge = document.createElement("iframe");
                challenge.title = "3D Secure";
                challenge.style.cssText =
                  "position:fixed;inset:0;width:100%;height:100%;z-index:9999";
                document.body.append(challenge);
              });
            }
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        const panTopmost = async (formId: string): Promise<boolean> =>
          await frame.locator(`#${formId} [autocomplete=cc-number]`).evaluate((input) => {
            const rect = input.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return hit === input;
          });
        await expect(panTopmost("card-number-network-selector-name-on-card-expiry")).resolves.toBe(
          true,
        );
        await expect(panTopmost("credit-card-number-name-on-card-expiry-month-exp")).resolves.toBe(
          false,
        );

        const result = await controller.fillAndSubmitCheckout(CARD);

        expect(result.three_ds_required).toBe(true);
        expect(await frame.locator("body").getAttribute("data-submitted-form")).toBe(
          "card-number-network-selector-name-on-card-expiry",
        );
        await expect(
          frame
            .locator("#credit-card-number-name-on-card-expiry-month-exp input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", "", "", ""]);
        expect(
          JSON.parse((await frame.locator("body").getAttribute("data-submitted-values")) ?? "null"),
        ).toEqual([CARD.pan, CARD.name, "", "12", "30", CARD.cvv, "", ""]);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "permits a parent checkout control outside both Shopify card forms",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/two-card-forms-parent-submit";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Kobee Japan</title>
          <iframe src="${frameUrl}"></iframe>
          <button id="place-order">Place order</button>
          <script>
            document.querySelector("#place-order").addEventListener("click", () => {
              document.body.dataset.submitted = "true";
              const challenge = document.createElement("iframe");
              challenge.title = "3D Secure";
              document.body.append(challenge);
            });
          </script>`,
        [frameUrl]: `
          ${TOPMOST_SPLIT_PAN_STYLE}
          <form id="combined">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
          </form>
          <form id="split">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const result = await controller.fillAndSubmitCheckout(CARD);

        expect(result.three_ds_required).toBe(true);
        expect(await page.locator("body").getAttribute("data-submitted")).toBe("true");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "retains the selected Shopify card form through split confirmation",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const { page, browser } = await servePages({
        [pageUrl]: `
          ${TOPMOST_SPLIT_PAN_STYLE}
          <form id="combined">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <form id="split">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <script>
            for (const form of document.querySelectorAll("form")) {
              form.addEventListener("submit", (event) => {
                event.preventDefault();
                document.body.dataset.submittedForm = form.id;
                document.body.dataset.submittedValues = JSON.stringify(
                  Array.from(form.querySelectorAll("input"), (input) => input.value),
                );
                const challenge = document.createElement("iframe");
                challenge.title = "3D Secure";
                document.body.append(challenge);
              });
            }
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);
        const result = await controller.submitFilledCheckout();

        expect(result.three_ds_required).toBe(true);
        expect(await page.locator("body").getAttribute("data-submitted-form")).toBe("split");
        expect(
          JSON.parse((await page.locator("body").getAttribute("data-submitted-values")) ?? "null"),
        ).toEqual([CARD.pan, CARD.name, "12", "30", CARD.cvv]);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps externally associated card fields and submit controls in their owning form",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const { page, browser } = await servePages({
        [pageUrl]: `
          ${TOPMOST_SPLIT_PAN_STYLE}
          <form id="combined"></form>
          <form id="split"></form>
          <input form="combined" autocomplete="cc-number">
          <input form="combined" autocomplete="cc-name">
          <input form="combined" autocomplete="cc-exp" placeholder="MM/YY">
          <input form="combined" autocomplete="cc-csc">
          <input form="split" autocomplete="cc-number">
          <input form="split" autocomplete="cc-name">
          <input form="split" autocomplete="cc-exp-month">
          <input form="split" autocomplete="cc-exp-year">
          <input form="split" autocomplete="cc-csc">
          <button type="submit" form="combined">Pay now</button>
          <button type="submit" form="split">Pay now</button>
          <script>
            for (const form of document.querySelectorAll("form")) {
              form.addEventListener("submit", (event) => {
                event.preventDefault();
                document.body.dataset.submittedForm = form.id;
                document.body.dataset.submittedValues = JSON.stringify(
                  Array.from(form.elements)
                    .filter(
                      (element) =>
                        element instanceof HTMLInputElement && element.type !== "submit",
                    )
                    .map((input) => input.value),
                );
                const challenge = document.createElement("iframe");
                challenge.title = "3D Secure";
                document.body.append(challenge);
              });
            }
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);
        const result = await controller.submitFilledCheckout();

        expect(result.three_ds_required).toBe(true);
        expect(await page.locator("body").getAttribute("data-submitted-form")).toBe("split");
        expect(
          JSON.parse((await page.locator("body").getAttribute("data-submitted-values")) ?? "null"),
        ).toEqual([CARD.pan, CARD.name, "12", "30", CARD.cvv]);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "ignores a selected Shopify card form hidden by an ancestor",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/hidden-selected-card-form";
      const { page, browser } = await servePages({
        [pageUrl]: `<title>Kobee Japan</title><iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          <section style="opacity: 0">
            <form id="stale" aria-selected="true">
              <input autocomplete="cc-number">
              <input autocomplete="cc-name">
              <input autocomplete="cc-exp" placeholder="MM/YY">
              <input autocomplete="cc-csc">
            </form>
          </section>
          <form id="visible">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);

        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        await expect(
          frame
            .locator("#stale input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", ""]);
        expect(await frame.locator("#visible [autocomplete=cc-number]").inputValue()).toBe(
          CARD.pan,
        );
        expect(await frame.locator("#visible [autocomplete=cc-name]").inputValue()).toBe(CARD.name);
        expect(await frame.locator("#visible [autocomplete=cc-exp]").inputValue()).toBe("1230");
        expect(await frame.locator("#visible [autocomplete=cc-csc]").inputValue()).toBe(CARD.cvv);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "refuses ambiguous Shopify card forms without mixing any fields",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/ambiguous-card-forms";
      const form = (id: string) => `
        <form id="${id}">
          <input autocomplete="cc-number">
          <input autocomplete="cc-name">
          <input autocomplete="cc-exp" placeholder="MM/YY">
          <input autocomplete="cc-csc">
        </form>`;
      const { page, browser } = await servePages({
        [pageUrl]: `<title>Kobee Japan</title><iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `${form("first")}${form("second")}`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_card_form_ambiguous",
        );

        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        await expect(
          frame
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "accepts confirmation totals only from visible trusted frames",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/review";
      const trustedUrl = "https://shop.example.test/checkout/summary";
      const rogueUrl = "https://rogue-payments.example.net/summary";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Review order</title>
          <div id="trusted-parent" style="opacity: 0">
            <iframe id="trusted" hidden style="opacity: 0" src="${trustedUrl}"></iframe>
          </div>
          <iframe id="rogue" src="${rogueUrl}"></iframe>`,
        [trustedUrl]: "Order total USD 39.99",
        [rogueUrl]: "Order total USD 39.99",
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutConfirmSummary()).rejects.toThrow(
          "payment_checkout_total_not_found",
        );
        await page.locator("#trusted").evaluate((element) => element.removeAttribute("hidden"));
        await expect(controller.readCheckoutConfirmSummary()).rejects.toThrow(
          "payment_checkout_total_not_found",
        );
        await page.locator("#trusted").evaluate((element) => {
          element.style.opacity = "1";
        });
        await expect(controller.readCheckoutConfirmSummary()).rejects.toThrow(
          "payment_checkout_total_not_found",
        );
        await page.locator("#trusted-parent").evaluate((element) => {
          element.style.opacity = "1";
        });
        await expect(controller.readCheckoutConfirmSummary()).resolves.toMatchObject({
          amount_cents: 3_999,
          currency: "USD",
        });
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps the main checkout total authoritative over injected frame totals",
    async () => {
      const pageUrl = "https://shop.rakuten.co.jp/checkout/payment";
      const rogueUrl = "https://rogue-payments.example.net/summary";
      const trustedUrl = "https://static-content.payment.global.rakuten.com/summary";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <title>Rakuten</title>
          <div>合計 ¥3,404</div>
          <iframe src="${rogueUrl}"></iframe>`,
        [rogueUrl]: '<meta charset="utf-8">合計 ¥9',
        [trustedUrl]: '<meta charset="utf-8">合計 ¥9',
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutSummary("JPY")).resolves.toMatchObject({
          amount_cents: 3_404,
          currency: "JPY",
        });

        await Promise.all([
          page.waitForEvent("framenavigated", (frame) => frame.url() === trustedUrl),
          page.evaluate((url) => {
            const frame = document.createElement("iframe");
            frame.src = url;
            document.body.append(frame);
          }, trustedUrl),
        ]);

        await expect(controller.readCheckoutSummary("JPY")).rejects.toThrow(
          "payment_checkout_total_not_found",
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps the main payable total authoritative and refuses trusted-frame conflicts",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/review";
      const trustedUrl = "https://shop.example.test/checkout/summary";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Review order</title>
          <div>Order total USD 49.99</div>
          <iframe src="${trustedUrl}"></iframe>`,
        [trustedUrl]: "Order total USD 39.99",
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutConfirmSummary()).rejects.toThrow(
          "payment_checkout_total_conflict",
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "ignores opacity-hidden confirmation totals inside a visible checkout frame",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/review";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Review order</title>
          <section id="hidden" style="opacity: 0">
            <div>Order total USD 39.99</div>
          </section>
          <button>Place order</button>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutConfirmSummary()).rejects.toThrow(
          "payment_checkout_total_not_found",
        );
        await page.locator("#hidden").evaluate((element) => {
          element.style.opacity = "1";
        });
        await expect(controller.readCheckoutConfirmSummary()).resolves.toMatchObject({
          amount_cents: 3_999,
          currency: "USD",
        });
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "fills only billing-scoped address fields during split card entry",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <input id="shipping-line1" autocomplete="shipping address-line1" value="9 Delivery Road">
          <input id="ambiguous-city" autocomplete="address-level2" value="Delivery City">
          <section id="payment-method">
            <div id="selected-card-surface">
              ${FRAME_FORM}
              <input id="billing-line1" autocomplete="billing address-line1">
              <input id="billing-city" name="billing_city">
              <input id="billing-postal" autocomplete="billing postal-code">
              <input id="billing-country" name="billing_country">
            </div>
          </section>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);

        expect(await page.locator("#shipping-line1").inputValue()).toBe("9 Delivery Road");
        expect(await page.locator("#ambiguous-city").inputValue()).toBe("Delivery City");
        expect(await page.locator("#billing-line1").inputValue()).toBe(CARD.billing.line1);
        expect(await page.locator("#billing-city").inputValue()).toBe(CARD.billing.city);
        expect(await page.locator("#billing-postal").inputValue()).toBe(CARD.billing.postal_code);
        expect(await page.locator("#billing-country").inputValue()).toBe(CARD.billing.country);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "rechecks a payment frame origin immediately before writing card data",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const frameUrl = "https://static-content.payment.global.rakuten.com/card-form";
      const rogueUrl = "https://rogue-payments.example.net/card-form";
      const { page, browser } = await servePages({
        [pageUrl]: `<iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          ${FRAME_FORM}
          <script>
            const pan = document.querySelector('[autocomplete="cc-number"]');
            new MutationObserver(() => {
              pan.disabled = true;
              setTimeout(() => location.replace("${rogueUrl}"), 0);
            }).observe(pan, {
              attributes: true,
              attributeFilter: ["data-ts-sealed-payment"],
            });
          </script>`,
        [rogueUrl]: FRAME_FORM,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toMatchObject({
          message: "payment_frame_not_recognized",
          frameOrigin: "https://rogue-payments.example.net",
        });
        const rogueFrame = page.frames().find((frame) => frame.url() === rogueUrl)!;
        expect(await rogueFrame.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await rogueFrame.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "clears semantic card fields after sealed nodes are replaced",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({ [pageUrl]: FRAME_FORM });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        await controller.fillCheckoutCardFields(CARD);
        await page.evaluate(() => {
          for (const original of Array.from(
            document.querySelectorAll<HTMLInputElement>('[data-ts-sealed-payment="1"]'),
          )) {
            const replacement = original.cloneNode(true) as HTMLInputElement;
            replacement.removeAttribute("data-ts-sealed-payment");
            replacement.value = original.value;
            original.replaceWith(replacement);
          }
        });

        await controller.clearCheckoutCardFields();

        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-name"]').inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "semantically clears a partial fill after the PAN node is replaced",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <input id="pan" autocomplete="cc-number">
          <input placeholder="MM/YY">
          <input autocomplete="cc-name">
          <script>
            document.addEventListener("input", (event) => {
              const input = event.target;
              if (!(input instanceof HTMLInputElement) || input.id !== "pan") return;
              if (input.value === "" || document.body.dataset.replaced === "true") return;
              document.body.dataset.replaced = "true";
              const replacement = input.cloneNode(true);
              replacement.removeAttribute("data-ts-sealed-payment");
              replacement.value = input.value;
              input.replaceWith(replacement);
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:cvv",
        );
        expect(await page.locator("#pan").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "reports unproven cleanup when a controlled PAN field restores its value",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <input id="pan" autocomplete="cc-number">
          <input placeholder="MM/YY">
          <input autocomplete="cc-name">
          <script>
            let stored = "";
            document.addEventListener("input", (event) => {
              const input = event.target;
              if (!(input instanceof HTMLInputElement) || input.id !== "pan") return;
              if (input.value !== "") stored = input.value;
              const replacement = input.cloneNode(true);
              replacement.removeAttribute("data-ts-sealed-payment");
              replacement.value = input.value === "" ? stored : input.value;
              input.replaceWith(replacement);
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toBeInstanceOf(
          PaymentCardFillCleanupError,
        );
        expect(await page.locator("#pan").inputValue()).toBe(CARD.pan);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "reports unproven cleanup when a visible PAN preview survives field clearing",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <input id="pan" autocomplete="cc-number">
          <input placeholder="MM/YY">
          <input autocomplete="cc-name">
          <div id="preview"></div>
          <script>
            document.querySelector("#pan").addEventListener("input", (event) => {
              if (event.target.value === "") return;
              document.querySelector("#preview").textContent =
                event.target.value.replace(/(\\d{4})(?=\\d)/g, "$1|");
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toBeInstanceOf(
          PaymentCardFillCleanupError,
        );
        expect(await page.locator("#pan").inputValue()).toBe("");
        expect(await page.locator("#preview").innerText()).toBe("4242|4242|4242|4242");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "reports unproven failed-fill cleanup when a labeled CVV preview survives",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <input autocomplete="cc-number">
          <input placeholder="MM/YY">
          <input autocomplete="cc-name">
          <div id="preview"></div>
          <script>
            document.querySelector('[autocomplete="cc-number"]').addEventListener("input", (event) => {
              if (event.target.value !== "") document.querySelector("#preview").textContent = "CVV 123";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toBeInstanceOf(
          PaymentCardFillCleanupError,
        );
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator("#preview").innerText()).toBe("CVV 123");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps terminal cleanup sealed when a labeled CVV preview survives",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `${FRAME_FORM}
          <div id="preview"></div>
          <script>
            document.querySelector('[autocomplete="cc-csc"]').addEventListener("input", (event) => {
              if (event.target.value !== "") document.querySelector("#preview").textContent = "Security code 123";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        await controller.fillCheckoutCardFields(CARD);

        await expect(controller.clearCheckoutCardFields()).rejects.toThrow(
          "payment_fields_not_cleared",
        );
        expect(await page.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
        expect(await page.locator("#preview").innerText()).toBe("Security code 123");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "keeps cleanup sealed when card data survives in interactive metadata",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/payment";
      const { page, browser } = await servePages({
        [pageUrl]: `${FRAME_FORM}
          <button id="preview" aria-label="Card preview"></button>
          <script>
            document.querySelector('[autocomplete="cc-number"]').addEventListener("input", event => {
              if (event.target.value) {
                document.querySelector("#preview").setAttribute(
                  "aria-label",
                  "Card " + event.target.value,
                );
              }
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        await controller.fillCheckoutCardFields(CARD);

        await expect(controller.clearCheckoutCardFields()).rejects.toThrow(
          "payment_fields_not_cleared",
        );
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator("#preview").getAttribute("aria-label")).toContain(CARD.pan);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "refuses the same fill when the card fields live in an UNRECOGNIZED cross-origin iframe",
    async () => {
      const rogueUrl = "https://rogue-payments.example.net/card-form";
      const { page, browser } = await servePages({
        "https://shop.example.test/checkout/payment": `
          <title>Payment method</title>
          <iframe src="${rogueUrl}"></iframe>
          <button>Next</button>`,
        [rogueUrl]: FRAME_FORM,
      });
      try {
        await page.goto("https://shop.example.test/checkout/payment");
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toMatchObject({
          message: "payment_frame_not_recognized",
          frameOrigin: "https://rogue-payments.example.net",
        });
        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toBeInstanceOf(
          UnrecognizedPaymentFrameError,
        );

        const frame = page.frames().find((f) => f.url() === rogueUrl)!;
        // Not one byte of the card reached the rogue frame, and nothing sealed
        // was left behind.
        expect(await frame.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await frame.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
        expect(await frame.locator('[data-ts-sealed-payment="1"]').count()).toBe(0);
        expect(await frame.locator("body").getAttribute("data-submitted")).toBeNull();
      } finally {
        await browser.close();
      }
    },
  );
});

const STRIPE_CHALLENGE_URL =
  "https://hooks.stripe.com/3d_secure_2/hosted?payment_intent=pi_synthetic123&payment_intent_client_secret=pi_synthetic123_secret_abc&publishable_key=pk_live_synthetic&stripe_account=acct_synthetic";

describe("Stripe decoupled/OOB 3DS challenge parsing", () => {
  it("extracts payment intent id, client secret, and publishable key from a hosted challenge URL", () => {
    expect(parseStripeChallengeParams(STRIPE_CHALLENGE_URL)).toEqual({
      paymentIntentId: "pi_synthetic123",
      clientSecret: "pi_synthetic123_secret_abc",
      publishableKey: "pk_live_synthetic",
      accountId: "acct_synthetic",
    });
  });

  it("accepts a non-Connect challenge without a Stripe account", () => {
    expect(
      parseStripeChallengeParams(
        "https://hooks.stripe.com/3d_secure_2/hosted?payment_intent=pi_x&payment_intent_client_secret=pi_x_secret_y&publishable_key=pk_live_z",
      ),
    ).toEqual({
      paymentIntentId: "pi_x",
      clientSecret: "pi_x_secret_y",
      publishableKey: "pk_live_z",
    });
  });

  it("refuses a malformed connected-account id", () => {
    expect(
      parseStripeChallengeParams(
        "https://hooks.stripe.com/3d_secure_2/hosted?payment_intent=pi_x&payment_intent_client_secret=pi_x_secret_y&publishable_key=pk_live_z&stripe_account=not_an_account",
      ),
    ).toBeUndefined();
  });

  it("refuses a non-Stripe host even if the query params match", () => {
    expect(
      parseStripeChallengeParams(
        "https://evil.test/3d_secure_2/hosted?payment_intent=pi_x&payment_intent_client_secret=pi_x_secret_y&publishable_key=pk_live_z",
      ),
    ).toBeUndefined();
  });

  it("refuses when a required param is missing", () => {
    expect(
      parseStripeChallengeParams("https://hooks.stripe.com/3d_secure_2/hosted?payment_intent=pi_x"),
    ).toBeUndefined();
  });

  it.each([
    ["requires_action", "pending"],
    ["succeeded", "authenticated"],
    ["processing", "authenticated"],
    ["requires_capture", "authenticated"],
    ["requires_payment_method", "failed"],
    ["canceled", "failed"],
    ["requires_confirmation", "unknown"],
  ] as const)("classifies PaymentIntent status %s as %s", (status, expected) => {
    expect(classifyStripePaymentIntentStatus(status)).toBe(expected);
  });
});

function controllerWithOobResolutionPage(options: {
  confirmAfterReload?: boolean;
  dialogDuringReload?: boolean;
}): {
  controller: BrowserController;
  dismissDialog: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
} {
  const currentUrl = "https://merchant.test/checkout";
  let reloaded = false;
  let dialogHandler: ((dialog: { dismiss: () => Promise<void> }) => Promise<void>) | undefined;
  const dismissDialog = vi.fn(async () => undefined);
  const reload = vi.fn(async () => {
    if (options.dialogDuringReload === true && dialogHandler !== undefined) {
      await dialogHandler({ dismiss: dismissDialog });
    }
    reloaded = true;
  });
  const page = {
    url: () => currentUrl,
    frames: () => [],
    waitForTimeout: async () => undefined,
    reload,
    on: vi.fn(
      (event: string, handler: (dialog: { dismiss: () => Promise<void> }) => Promise<void>) => {
        if (event === "dialog") dialogHandler = handler;
      },
    ),
    off: vi.fn(
      (event: string, handler: (dialog: { dismiss: () => Promise<void> }) => Promise<void>) => {
        if (event === "dialog" && dialogHandler === handler) dialogHandler = undefined;
      },
    ),
  };
  const controller = new BrowserController({ humanize: false });
  (controller as unknown as { page: Page }).page = page as unknown as Page;
  Object.assign(controller, {
    captureCheckoutOutcomeBaseline: async () => ({
      url: currentUrl,
      orderUrlIdentities: [],
      terminalUrlIdentity: null,
    }),
    captureVisibleCheckoutFailureSignals: async () => ({}),
    hasConfirmedCheckoutOutcome: async () => reloaded && options.confirmAfterReload === true,
    hasNewVisibleCheckoutFailure: async () => false,
    detectThreeDsChallenge: async () => ({
      three_ds_required: true,
      order_confirmed: false,
      challenge_url: STRIPE_CHALLENGE_URL,
    }),
  });
  return { controller, dismissDialog, reload };
}

describe("decoupled/out-of-band (app-push) 3DS completion", () => {
  it("polls the PaymentIntent, reloads once authenticated, and fails closed if the order never confirms", async () => {
    const statuses = ["requires_action", "succeeded"];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: statuses.shift() ?? "succeeded" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller, dismissDialog, reload } = controllerWithOobResolutionPage({
      dialogDuringReload: true,
    });
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_500;
      return now;
    });

    try {
      await expect(
        controller.waitForThreeDsResolution(120_000, STRIPE_CHALLENGE_URL),
      ).resolves.toBe("authenticated_pending_order");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("pi_synthetic123"),
        expect.objectContaining({
          headers: {
            Authorization: "Bearer pk_live_synthetic",
            "Stripe-Account": "acct_synthetic",
          },
        }),
      );
      expect(dismissDialog).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reports success once the reloaded checkout shows a genuine merchant completion", async () => {
    const statuses = ["requires_action", "succeeded"];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: statuses.shift() ?? "succeeded" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller } = controllerWithOobResolutionPage({
      confirmAfterReload: true,
    });
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_500;
      return now;
    });

    try {
      await expect(
        controller.waitForThreeDsResolution(120_000, STRIPE_CHALLENGE_URL),
      ).resolves.toBe("succeeded");
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("polls non-Connect PaymentIntents without a Stripe-Account header", async () => {
    const statuses = ["requires_action", "succeeded"];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: statuses.shift() ?? "succeeded" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller } = controllerWithOobResolutionPage({});
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_500;
      return now;
    });
    const challengeUrl = STRIPE_CHALLENGE_URL.replace("&stripe_account=acct_synthetic", "");

    try {
      await expect(controller.waitForThreeDsResolution(120_000, challengeUrl)).resolves.toBe(
        "authenticated_pending_order",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: "Bearer pk_live_synthetic" },
        }),
      );
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("returns failed when the issuer-side PaymentIntent lands in a terminal failure state", async () => {
    const statuses = ["requires_action", "requires_payment_method"];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: statuses.shift() ?? "requires_payment_method" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller, reload } = controllerWithOobResolutionPage({});
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_500;
      return now;
    });

    try {
      await expect(
        controller.waitForThreeDsResolution(120_000, STRIPE_CHALLENGE_URL),
      ).resolves.toBe("failed");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not reload unless it observes this PaymentIntent leave requires_action", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "succeeded" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { controller, reload } = controllerWithOobResolutionPage({});
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3_500;
      return now;
    });

    try {
      await expect(controller.waitForThreeDsResolution(10_000, STRIPE_CHALLENGE_URL)).resolves.toBe(
        "timeout",
      );
      expect(fetchMock).toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("never polls Stripe or reloads for the ordinary in-frame challenge (no challenge_url)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { controller, reload } = controllerWithOobResolutionPage({});

    try {
      await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("timeout");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
