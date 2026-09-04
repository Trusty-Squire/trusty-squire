import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserClickDispatchError,
  BrowserController,
  CHECKOUT_SUBMIT_LABEL_RE,
  hasPayPalHostedCheckoutFrame,
  PaymentCardFillCleanupError,
  PaymentSubmitOutcomeUnknownError,
  parseCheckoutAmount,
  parseCheckoutAmounts,
  parseStructuredCheckoutTotal,
  recognizedPaymentProviderFrame,
  runCaptureConfirmedPaymentSubmit,
  type CheckoutSubmitResult,
  UnrecognizedPaymentFrameError,
} from "../browser.js";
import {
  cartAdd,
  claimActivePaymentForOperatePay,
  closeAllProvisionSessions,
  finishProvisionSession,
  observe,
  releaseActivePaymentLease,
  startHarnessProvisionSession,
  withPaymentSessionCall,
} from "../provision-session.js";

// The real-browser checkout-fill test needs a Playwright Chromium binary. The
// main CI install downloads it, but the lean mcp-only publish-verify install
// does not — skip there rather than fail the release. The pure parsing tests
// below always run.
let chromiumAvailable = false;
const APPROVAL_CARD = {
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
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

describe("captured payment submit dispatch", () => {
  it("does not report dispatch when the click fails before capture", async () => {
    const onSubmitDispatched = vi.fn();
    const clear = vi.fn().mockResolvedValue(undefined);

    await expect(
      runCaptureConfirmedPaymentSubmit({
        click: async () => {
          throw new Error("element detached");
        },
        readEvidence: async () => ({ baseline: null, dispatched: false }),
        clear,
        onSubmitDispatched,
      }),
    ).rejects.toThrow("element detached");

    expect(clear).toHaveBeenCalledOnce();
    expect(onSubmitDispatched).not.toHaveBeenCalled();
  });

  it("reports capture-confirmed dispatch before returning an unknown outcome", async () => {
    const onSubmitDispatched = vi.fn();

    await expect(
      runCaptureConfirmedPaymentSubmit({
        click: async () => {
          throw new Error("navigation interrupted click completion");
        },
        readEvidence: async () => ({ baseline: { url: "before" }, dispatched: true }),
        clear: async () => undefined,
        onSubmitDispatched,
      }),
    ).rejects.toBeInstanceOf(PaymentSubmitOutcomeUnknownError);

    expect(onSubmitDispatched).toHaveBeenCalledOnce();
  });

  it("keeps the outcome unknown without claiming dispatch when click evidence is absent", async () => {
    const onSubmitDispatched = vi.fn();

    await expect(
      runCaptureConfirmedPaymentSubmit({
        click: async (markInputDispatchPossible) => {
          markInputDispatchPossible();
          throw new Error("target closed after input dispatch");
        },
        readEvidence: async () => ({ baseline: null, dispatched: false }),
        clear: async () => undefined,
        onSubmitDispatched,
      }),
    ).rejects.toBeInstanceOf(PaymentSubmitOutcomeUnknownError);

    expect(onSubmitDispatched).not.toHaveBeenCalled();
  });

  it("preserves a proven pre-dispatch approval rejection", async () => {
    const onSubmitDispatched = vi.fn();

    await expect(
      runCaptureConfirmedPaymentSubmit({
        click: async (markInputDispatchPossible) => {
          markInputDispatchPossible();
          throw new BrowserClickDispatchError(
            "not_dispatched",
            new Error("payment_approval_expired"),
          );
        },
        readEvidence: async () => ({ baseline: null, dispatched: false }),
        clear: async () => undefined,
        onSubmitDispatched,
      }),
    ).rejects.toThrow("payment_approval_expired");

    expect(onSubmitDispatched).not.toHaveBeenCalled();
  });

  it("does not convert trusted input completion into submit evidence", async () => {
    const onSubmitDispatched = vi.fn();

    await expect(
      runCaptureConfirmedPaymentSubmit({
        click: async () => undefined,
        readEvidence: async () => ({ baseline: null, dispatched: false }),
        clear: async () => undefined,
        onSubmitDispatched,
      }),
    ).rejects.toBeInstanceOf(PaymentSubmitOutcomeUnknownError);

    expect(onSubmitDispatched).not.toHaveBeenCalled();
  });
});

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
    const frame = { evaluate: vi.fn().mockResolvedValue("合計 3点") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutReviewSummary("JPY")).rejects.toThrow(
      "payment_checkout_total_not_found",
    );
  });

  it("resolves against the already-approved currency when yen evidence is glued to unparseable trailing text", async () => {
    // 円税込 is currency evidence the token resolver cannot read on its own —
    // currency ambiguity no longer blocks the read, it falls through to the
    // already-approved currency instead (here JPY, the currency actually
    // approved for this purchase, so the resolved amount stays correct).
    const browser = new BrowserController({ humanize: false });
    const frame = { evaluate: vi.fn().mockResolvedValue("合計 1,468円税込") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => "https://flowers.example.test/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutSummary("JPY")).resolves.toMatchObject({
      amount_cents: 1_468,
      currency: "JPY",
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

  it("does not mint a scale-mismatched total from a bare number against a zero-decimal fallback", async () => {
    // A Japan-based approval is not evidence that a bare 98.45 total is JPY —
    // the mismatched-scale candidate is skipped (never minted as JPY 9,845),
    // and since nothing else on the page resolves, the read now fails with
    // total_not_found rather than a currency-specific refusal.
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
      "payment_checkout_total_not_found",
    );
  });

  it.each([
    "Order total R$ 98.45",
    "Order total 98.45 R$",
    "Order total 98.45 kr",
    "Order total 98.45 ₺",
    "Order total JPY$98.45",
  ])(
    "resolves against the approved currency when a total uses unresolved currency notation: %s",
    async (text) => {
      // A notation the resolver can't pin to an ISO currency on its own no
      // longer blocks the read — it resolves against the already-approved
      // currency, same as a plain unlabeled number would.
      const browser = new BrowserController({ humanize: false });
      const frame = { evaluate: vi.fn().mockResolvedValue(text) };
      const page = {
        evaluate: vi.fn().mockResolvedValue({ title: "Japan Flower Shop", siteName: "" }),
        mainFrame: () => frame,
        frames: () => [frame],
        url: () => "https://flowers.example.test/checkout",
      };
      Object.defineProperty(browser, "page", { value: page });

      await expect(browser.readCheckoutSummary("USD")).resolves.toMatchObject({
        amount_cents: 9_845,
        currency: "USD",
      });
    },
  );

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

  type CheckoutControl = "native" | "external" | "role";
  interface CheckoutDispatchHarnessOptions {
    control: CheckoutControl;
    required?: boolean;
    action: string;
    responses?: Record<string, { body?: string; contentType?: string; delayMs?: number }>;
  }

  async function runCheckoutDispatchHarness(options: CheckoutDispatchHarnessOptions): Promise<{
    dispatches: number;
    error?: unknown;
    invalid: boolean;
    requests: string[];
    result?: CheckoutSubmitResult;
  }> {
    const checkoutUrl = "https://merchant.test/checkout";
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const requests: string[] = [];
      const controlMarkup =
        options.control === "native"
          ? '<button type="submit">Pay now</button>'
          : options.control === "external"
            ? '<button type="button">Pay now</button>'
            : '<div role="button" tabindex="0">Pay now</div>';
      const controlSelector = options.control === "role" ? '[role="button"]' : "button";
      const formControl = options.control === "native" ? controlMarkup : "";
      const externalControl = options.control === "native" ? "" : controlMarkup;
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === checkoutUrl) {
          await route.fulfill({
            contentType: "text/html",
            body: `
              <form id="checkout">
                ${options.required === true ? '<input id="required-field" required>' : ""}
                ${formControl}
              </form>
              ${externalControl}
              <script>
                const form = document.querySelector("#checkout");
                const control = document.querySelector(${JSON.stringify(controlSelector)});
                document.querySelector("#required-field")?.addEventListener("invalid", () => {
                  document.body.dataset.invalid = "true";
                });
                const run = async (event) => {
                  if (event.type === "submit") event.preventDefault();
                  ${options.action}
                };
                ${options.control === "native" ? 'form.addEventListener("submit", run);' : 'control.addEventListener("click", run);'}
              </script>`,
          });
          return;
        }
        requests.push(url);
        const response = options.responses?.[url];
        if (response === undefined) {
          await route.fulfill({ status: 404, body: "not found" });
          return;
        }
        if (response.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, response.delayMs));
        }
        await route.fulfill({
          body: response.body ?? "ok",
          contentType: response.contentType ?? "text/plain",
        });
      });
      await page.goto(checkoutUrl);
      const controller = BrowserController.fromHarnessPage(page);
      const onSubmitDispatched = vi.fn();
      let result: CheckoutSubmitResult | undefined;
      let error: unknown;
      try {
        result = await (
          controller as unknown as {
            submitFilledCheckoutInScope: (
              cardGroup: undefined,
              onDispatched: () => void,
            ) => Promise<CheckoutSubmitResult>;
          }
        ).submitFilledCheckoutInScope(undefined, onSubmitDispatched);
      } catch (caught) {
        error = caught;
      }
      return {
        dispatches: onSubmitDispatched.mock.calls.length,
        ...(error !== undefined ? { error } : {}),
        invalid: (await page.locator("body").getAttribute("data-invalid")) === "true",
        requests,
        ...(result !== undefined ? { result } : {}),
      };
    } finally {
      await browser.close();
    }
  }

  it.skipIf(!chromiumAvailable)(
    "keeps native, external, and role-button validation blocks outside the charge boundary",
    async () => {
      const cases: CheckoutDispatchHarnessOptions[] = [
        { control: "native", required: true, action: "" },
        {
          control: "external",
          required: true,
          action: 'await fetch("/v1/payment_methods", { method: "POST" }); form.requestSubmit();',
          responses: { "https://merchant.test/v1/payment_methods": {} },
        },
        {
          control: "role",
          required: true,
          action: 'await fetch("/analytics/orders", { method: "POST" }); form.requestSubmit();',
          responses: { "https://merchant.test/analytics/orders": {} },
        },
      ];
      for (const testCase of cases) {
        const observed = await runCheckoutDispatchHarness(testCase);
        expect(observed.error, testCase.control).toBeInstanceOf(PaymentSubmitOutcomeUnknownError);
        expect(observed.invalid, testCase.control).toBe(true);
        expect(observed.dispatches, testCase.control).toBe(0);
      }
    },
    60_000,
  );

  it.skipIf(!chromiumAvailable)(
    "tracks concrete charge traffic across native, external, and role controls",
    async () => {
      const cases: CheckoutDispatchHarnessOptions[] = [
        {
          control: "native",
          action:
            'await fetch("/charge", { method: "POST" }); history.pushState({}, "", "/receipt/REST-1");',
          responses: { "https://merchant.test/charge": {} },
        },
        {
          control: "external",
          action:
            'await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "CompleteCheckout" }) }); history.pushState({}, "", "/receipt/GQL-1");',
          responses: { "https://merchant.test/graphql": {} },
        },
        {
          control: "role",
          action:
            'await fetch("/v1/payment_methods", { method: "POST" }); await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "CompleteCheckout" }) }); history.pushState({}, "", "/receipt/DELAY-1");',
          responses: {
            "https://merchant.test/v1/payment_methods": { delayMs: 100 },
            "https://merchant.test/graphql": {},
          },
        },
      ];
      for (const testCase of cases) {
        const observed = await runCheckoutDispatchHarness(testCase);
        expect(observed.error, testCase.control).toBeUndefined();
        expect(observed.result, testCase.control).toEqual({
          three_ds_required: false,
          order_confirmed: true,
        });
        expect(observed.dispatches, testCase.control).toBe(1);
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "keeps observing after nonterminal navigation until a late order request",
    async () => {
      const observed = await runCheckoutDispatchHarness({
        control: "external",
        action: 'window.location.href = "/processing";',
        responses: {
          "https://merchant.test/processing": {
            contentType: "text/html",
            body: '<script>void (async () => { await fetch("/api/orders", { method: "POST" }); history.pushState({}, "", "/receipt/LATE-1"); })();</script>',
          },
          "https://merchant.test/api/orders": {},
        },
      });
      expect(observed.error).toBeUndefined();
      expect(observed.result).toEqual({ three_ds_required: false, order_confirmed: true });
      expect(observed.requests).toContain("https://merchant.test/api/orders");
      expect(observed.dispatches).toBe(1);
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "runs the approval fence immediately before the charge click",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
          <form>
            <input autocomplete="cc-number"><input autocomplete="cc-exp">
            <input autocomplete="cc-csc"><input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>`);
        const controller = BrowserController.fromHarnessPage(page);
        const beforeSubmitDispatch = vi.fn(() => {
          throw new Error("payment_approval_expired");
        });
        await expect(
          controller.fillAndSubmitCheckout(APPROVAL_CARD, { beforeSubmitDispatch }),
        ).rejects.toThrow("payment_approval_expired");
        expect(beforeSubmitDispatch).toHaveBeenCalledOnce();
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "holds the payment action lease across a submit-associated SPA charge and 3DS follow-up",
    async () => {
      const browser = await chromium.launch({ headless: true });
      let sessionId: string | undefined;
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        let analyticsRequests = 0;
        let chargeRequests = 0;
        let releaseChargeResponse!: () => void;
        const chargeResponseAllowed = new Promise<void>((resolve) => {
          releaseChargeResponse = resolve;
        });
        let reportChargeStarted!: () => void;
        const chargeStarted = new Promise<void>((resolve) => {
          reportChargeStarted = resolve;
        });
        let leaseHeldDuringCharge = false;
        let activeSession: Parameters<typeof claimActivePaymentForOperatePay>[1];
        await context.route("https://merchant.test/checkout", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `
              <form id="checkout">
                <input autocomplete="cc-number">
                <input autocomplete="cc-exp">
                <input autocomplete="cc-csc">
                <input autocomplete="cc-name">
                <button type="submit">Pay now</button>
              </form>
              <script>
                document.querySelector("#checkout").addEventListener("submit", async (event) => {
                  event.preventDefault();
                  void fetch("/analytics").catch(() => undefined);
                  await fetch("/charge", { method: "POST" });
                  document.body.insertAdjacentHTML("beforeend", "<p>Authenticate payment</p>");
                });
              </script>
            `,
          });
        });
        await context.route("https://merchant.test/analytics", async (route) => {
          analyticsRequests += 1;
          await route.fulfill({ body: "ok" });
        });
        await context.route("https://merchant.test/charge", async (route) => {
          chargeRequests += 1;
          try {
            claimActivePaymentForOperatePay(undefined, activeSession);
          } catch (error) {
            leaseHeldDuringCharge =
              error instanceof Error &&
              /another payment operation is already in progress/.test(error.message);
          }
          reportChargeStarted();
          await chargeResponseAllowed;
          await route.fulfill({ body: "ok" });
        });
        const controller = BrowserController.fromHarnessPage(page);
        const started = await startHarnessProvisionSession({
          serviceUrl: "https://merchant.test/checkout",
          browser: controller,
        });
        sessionId = started.session_id;

        let leaseReleased = false;
        const action = withPaymentSessionCall(sessionId, async (session) => {
          activeSession = session;
          const claim = claimActivePaymentForOperatePay(undefined, session);
          if (claim.kind !== "lease") throw new Error("expected payment action lease");
          try {
            return await controller.fillAndSubmitCheckout(APPROVAL_CARD, {
              beforeSubmitDispatch: () => 100,
            });
          } finally {
            leaseReleased = releaseActivePaymentLease(claim.lease, true, session);
          }
        });

        await chargeStarted;
        expect(leaseHeldDuringCharge).toBe(true);
        const observation = await observe(sessionId, "full");
        expect(JSON.stringify(observation)).not.toContain(APPROVAL_CARD.pan);
        expect(JSON.stringify(observation)).not.toContain(`"value":"${APPROVAL_CARD.cvv}"`);
        releaseChargeResponse();

        await expect(action).resolves.toMatchObject({
          three_ds_required: true,
          order_confirmed: false,
        });

        expect(analyticsRequests).toBe(1);
        expect(chargeRequests).toBe(1);
        expect(leaseReleased).toBe(true);
        await withPaymentSessionCall(sessionId, async (session) => {
          const fresh = claimActivePaymentForOperatePay(undefined, session);
          if (fresh.kind !== "lease") throw new Error("expected released payment lease");
          expect(releaseActivePaymentLease(fresh.lease, true, session)).toBe(true);
        });
      } finally {
        if (sessionId !== undefined) {
          await finishProvisionSession(sessionId).catch(() => undefined);
        }
        await browser.close();
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)(
    "holds the payment action lease across native charge navigation and its 3DS follow-up",
    async () => {
      const browser = await chromium.launch({ headless: true });
      let sessionId: string | undefined;
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        let threeDsRequests = 0;
        let releaseThreeDsResponse!: () => void;
        const threeDsResponseAllowed = new Promise<void>((resolve) => {
          releaseThreeDsResponse = resolve;
        });
        let reportThreeDsStarted!: () => void;
        const threeDsStarted = new Promise<void>((resolve) => {
          reportThreeDsStarted = resolve;
        });
        let leaseHeldDuringThreeDs = false;
        let activeSession: Parameters<typeof claimActivePaymentForOperatePay>[1];
        await context.route("https://merchant.test/checkout", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `
              <form action="https://merchant.test/charge" method="post">
                <input autocomplete="cc-number">
                <input autocomplete="cc-exp">
                <input autocomplete="cc-csc">
                <input autocomplete="cc-name">
                <button type="submit">Pay now</button>
              </form>
            `,
          });
        });
        await context.route("https://merchant.test/charge", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<script>
              void (async () => {
                await fetch("https://merchant.test/3ds");
                document.body.textContent = "Authenticate payment";
              })();
            </script>`,
          });
        });
        await context.route("https://merchant.test/3ds", async (route) => {
          threeDsRequests += 1;
          try {
            claimActivePaymentForOperatePay(undefined, activeSession);
          } catch (error) {
            leaseHeldDuringThreeDs =
              error instanceof Error &&
              /another payment operation is already in progress/.test(error.message);
          }
          reportThreeDsStarted();
          await threeDsResponseAllowed;
          await route.fulfill({ body: "ok" });
        });
        const controller = BrowserController.fromHarnessPage(page);
        const started = await startHarnessProvisionSession({
          serviceUrl: "https://merchant.test/checkout",
          browser: controller,
        });
        sessionId = started.session_id;

        let leaseReleased = false;
        const action = withPaymentSessionCall(sessionId, async (session) => {
          activeSession = session;
          const claim = claimActivePaymentForOperatePay(undefined, session);
          if (claim.kind !== "lease") throw new Error("expected payment action lease");
          try {
            return await controller.fillAndSubmitCheckout(APPROVAL_CARD, {
              beforeSubmitDispatch: () => 100,
            });
          } finally {
            leaseReleased = releaseActivePaymentLease(claim.lease, true, session);
          }
        });

        await threeDsStarted;
        expect(leaseHeldDuringThreeDs).toBe(true);
        releaseThreeDsResponse();

        const result = await action;
        expect(result).toMatchObject({
          three_ds_required: true,
          order_confirmed: false,
        });
        expect(JSON.stringify(result)).not.toContain(APPROVAL_CARD.pan);
        expect(JSON.stringify(result)).not.toContain(APPROVAL_CARD.cvv);
        expect(threeDsRequests).toBe(1);
        expect(leaseReleased).toBe(true);
        await withPaymentSessionCall(sessionId, async (session) => {
          const fresh = claimActivePaymentForOperatePay(undefined, session);
          if (fresh.kind !== "lease") throw new Error("expected released payment lease");
          expect(releaseActivePaymentLease(fresh.lease, true, session)).toBe(true);
        });
      } finally {
        if (sessionId !== undefined) {
          await finishProvisionSession(sessionId).catch(() => undefined);
        }
        await browser.close();
      }
    },
    60_000,
  );

  it.skipIf(!chromiumAvailable)(
    "allows 3DS follow-up after an authorized SPA charge dispatch",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        let threeDsRequests = 0;
        await context.route("https://merchant.test/charge", async (route) => {
          await route.fulfill({ body: "charge accepted" });
        });
        await context.route("https://merchant.test/3ds", async (route) => {
          threeDsRequests += 1;
          await route.fulfill({ body: "ok" });
        });
        await context.route("https://merchant.test/checkout", async (route) => {
          await route.fulfill({ body: "checkout" });
        });
        await page.goto("https://merchant.test/checkout");
        await page.setContent(`
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-exp">
            <input autocomplete="cc-csc">
            <input autocomplete="cc-name">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("form").addEventListener("submit", async (event) => {
              event.preventDefault();
              await fetch("https://merchant.test/charge", { method: "POST" });
              setTimeout(async () => {
                await fetch("https://merchant.test/3ds");
                history.pushState({}, "", "/thank-you/order-123");
              }, 150);
            });
          </script>
        `);
        const controller = BrowserController.fromHarnessPage(page);

        await expect(
          controller.fillAndSubmitCheckout(APPROVAL_CARD, { beforeSubmitDispatch: () => 100 }),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: true });
        expect(threeDsRequests).toBe(1);
        await context.close();
      } finally {
        await browser.close();
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
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
    "does not use CardinalCommerce device collection as a 3DS signal",
    async () => {
      const collectionUrl = "https://centinelapi.cardinalcommerce.com/V1/Cruise/Collect";
      const browser = await chromium.launch({ headless: true });
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(15_000);
      try {
        const page = await browser.newPage();
        await page.route(collectionUrl, async (route) =>
          route.fulfill({ contentType: "text/html", body: "<div>Device data ready</div>" }),
        );
        await page.setContent(`
          <button id="pay">Pay now</button>
          <script>
            document.querySelector("#pay").addEventListener("click", () => {
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
              const frame = document.createElement("iframe");
              frame.src = ${JSON.stringify(collectionUrl)};
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

  it.skipIf(!chromiumAvailable).each([
    ["CardinalCommerce", "https://centinelapi.cardinalcommerce.com/V2/Cruise/StepUp"],
    ["Stripe", "https://hooks.stripe.com/3d_secure_2/hosted"],
  ])("detects a %s challenge frame from its host structure", async (_provider, challengeUrl) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route(challengeUrl, async (route) =>
        route.fulfill({ contentType: "text/html", body: "<div>Approve in your bank app</div>" }),
      );
      await page.setContent(`
          <button id="pay">Pay now</button>
          <script>
            document.querySelector("#pay").addEventListener("click", () => {
              const frame = document.createElement("iframe");
              frame.src = ${JSON.stringify(challengeUrl)};
              document.body.append(frame);
            });
          </script>
        `);
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;

      await expect(controller.submitFilledCheckout()).resolves.toMatchObject({
        three_ds_required: true,
        order_confirmed: false,
      });
    } finally {
      await browser.close();
    }
  });

  // A hidden EMV 3DS Method pre-auth frame can use the same ACS-shaped URL as a
  // challenge. It must not interrupt polling for a later frictionless order
  // confirmation because it presents no user interaction.
  it.skipIf(!chromiumAvailable)(
    "does not flag a hidden 3DS-method ping frame and still confirms a frictionless order",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const methodUrl = "https://issuer.example.test/acs/method";
      try {
        const page = await browser.newPage();
        await page.route(methodUrl, async (route) =>
          route.fulfill({ contentType: "text/html", body: "" }),
        );
        await page.route("https://merchant.test/checkout", async (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `
              <button id="pay">Pay now</button>
              <script>
                document.querySelector("#pay").addEventListener("click", () => {
                  const frame = document.createElement("iframe");
                  frame.src = ${JSON.stringify(methodUrl)};
                  frame.style.cssText = "display:none;width:0;height:0;border:0";
                  frame.width = "0";
                  frame.height = "0";
                  document.body.append(frame);
                  setTimeout(() => history.pushState({}, "", "/checkouts/abc123/thank_you"), 200);
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkout");
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
    20_000,
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
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                      void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
    "confirms Shopify's nested thank-you route only with visible order confirmation evidence",
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
                  history.replaceState({}, "", "/checkouts/cn/token-123/en-us/thank-you");
                  document.body.insertAdjacentHTML(
                    "beforeend",
                    "<h1>Thank you, Ken!</h1><p>Confirmation #8WV06PY0A</p><p>Your order is confirmed</p>",
                  );
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkouts/cn/token-123/en-us");
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
    "does not confirm a declined payment that remains on checkout",
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
                  document.body.insertAdjacentHTML("beforeend", "<p>Payment was declined</p>");
                });
              </script>`,
          }),
        );
        await page.goto("https://merchant.test/checkouts/cn/token-123/en-us");
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                        void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
                  void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
    "keeps a click failure unknown when no charge evidence fired",
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
        expect(error).toBeInstanceOf(PaymentSubmitOutcomeUnknownError);
      } finally {
        await browser.close();
      }
    },
    20_000,
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
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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

  it("resolves an ambiguous live currency notation against the approved currency at charge confirmation", async () => {
    const structured = { jsonLd: [], microdata: [] };
    // A bare "$"/"¥" symbol is shared by several locales and can't be pinned
    // to one ISO currency from the page alone (the eBay-style international-
    // shipping currency-selector shape) — it no longer refuses the confirm
    // read, it resolves against the currency already approved for this
    // purchase instead.
    await expect(
      structuredCheckoutController("Order total $39.99", structured).readCheckoutConfirmSummary(
        "USD",
      ),
    ).resolves.toMatchObject({ amount_cents: 3_999, currency: "USD" });
    await expect(
      structuredCheckoutController("Order total ¥3,999", structured).readCheckoutConfirmSummary(
        "JPY",
      ),
    ).resolves.toMatchObject({ amount_cents: 3_999, currency: "JPY" });
    // With no approved currency to fall back on, an ambiguous notation still
    // yields no amount for that occurrence — payment_checkout_total_not_found,
    // never a currency-specific refusal, is the remaining failure mode.
    await expect(
      structuredCheckoutController("Order total $39.99", structured).readCheckoutConfirmSummary(),
    ).rejects.toThrow("payment_checkout_total_not_found");
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

  it("confirms cleanly against the displayed total on an international currency-selector checkout (eBay shape)", async () => {
    // eBay International Shipping (and similarly shaped Shopify Markets /
    // other FX-preview checkouts) shows a currency-choice module near the
    // order summary — "Select a currency for this purchase … Japanese Yen
    // (JPY) - ¥ … Exchange rate: ¥…" plus a persistent "Pay in the currency
    // of your choice — Change currency" control. That must not block confirm:
    // the buyer selected USD, the page's own labeled "Order total $88.87" is
    // the displayed value, and it resolves against the approved currency.
    const text = `Select a currency for this purchase
United States Dollar (USD) - $
Japanese Yen (JPY) - ¥
Exchange rate: ¥141.16 = $1.00
Pay in the currency of your choice — Change currency
Order total $88.87`;
    await expect(
      structuredCheckoutController(text, { jsonLd: [], microdata: [] }).readCheckoutConfirmSummary(
        "USD",
      ),
    ).resolves.toMatchObject({ amount_cents: 8_887, currency: "USD" });
    await expect(
      structuredCheckoutController(text, { jsonLd: [], microdata: [] }).readCheckoutSummary("USD"),
    ).resolves.toMatchObject({ amount_cents: 8_887, currency: "USD" });
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
    "resolves an unresolved-notation text total against the fallback in %s, never consulting a disagreeing structured total",
    async (reader) => {
      // "kr" can't be pinned to one ISO currency on its own, so it resolves
      // against the USD fallback (the currency already approved for this
      // purchase) — the text total is what the buyer actually sees, so the
      // disagreeing structured SEK total is never consulted (same
      // stale-JSON-LD precedence as any other clean visible total).
      const controller = structuredCheckoutController("Order total 98.45 kr", {
        jsonLd: [orderJsonLd({ price: "98.45", priceCurrency: "SEK" })],
        microdata: [],
      });
      await expect(controller[reader]("USD")).resolves.toMatchObject({
        amount_cents: 9_845,
        currency: "USD",
      });
    },
  );

  it.each(["readCheckoutSummary", "readCheckoutReviewSummary"] as const)(
    "rescues a scale-mismatched text total from structured data in %s instead of refusing",
    async (reader) => {
      // "98.45" against a zero-decimal JPY fallback is skipped as a
      // mismatched-scale candidate (never minted as JPY 9,845); since nothing
      // else on the page resolves, the structured JPY 98 total rescues it —
      // structured data only ever rescues a would-be total_not_found, so this
      // cannot override a clean visible total, only fill in for a missing one.
      const controller = structuredCheckoutController("Order total 98.45", {
        jsonLd: [orderJsonLd({ price: "98", priceCurrency: "JPY" })],
        microdata: [],
      });
      await expect(controller[reader]("JPY")).resolves.toMatchObject({
        amount_cents: 98,
        currency: "JPY",
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
  // The browser completes 3-D Secure natively (including out-of-band
  // bank-app pushes) — waitForThreeDsResolution only classifies the
  // outcome afterward. It never manipulates, intercepts, or gates on the
  // challenge frame itself; it just polls the same terminal-order-route
  // signal a plain non-3DS checkout uses, plus passive decline-text reads.
  const setupChallenge = async (
    initialMerchantHtml = "",
  ): Promise<{
    browser: Browser;
    page: Page;
    controller: BrowserController;
  }> => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
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
              frame.title = "3D Secure authentication";
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

  // Gateway-token override fixture: the checkout accepts newly-filled fields,
  // but its synthetic backend deliberately chooses a stored ENBD token and
  // renders that token's ACS. No network or charge is involved. Exercise both
  // ways an ACS can be surfaced by real gateways.
  const detectTokenOverride = async (
    topLevel: boolean,
    challengeCopy: string,
    issuerSource: "bin_metadata" | null = "bin_metadata",
    label = "Travel",
  ) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(
      topLevel
        ? `<main><p>3D Secure authentication — ${challengeCopy}</p></main>`
        : `<main>Complete your payment securely</main><iframe title="3D Secure authentication" srcdoc="<p>${challengeCopy}</p>"></iframe>`,
    );
    if (!topLevel) {
      await page.waitForFunction(
        () => document.querySelector("iframe")?.contentDocument?.body?.innerText.length !== 0,
      );
    }
    const controller = new BrowserController({ humanize: false });
    (controller as unknown as { page: Page }).page = page;
    try {
      return await (
        controller as unknown as {
          detectThreeDsChallenge: (card: {
            pan: string;
            issuer?: string;
            issuer_source?: "bin_metadata";
            label?: string;
          }) => Promise<CheckoutSubmitResult>;
        }
      ).detectThreeDsChallenge({
        pan: "5555555555559192",
        ...(issuerSource !== null ? { issuer: "DBS", issuer_source: issuerSource } : { label }),
      });
    } finally {
      await browser.close();
    }
  };

  it.skipIf(!chromiumAvailable)(
    "warns when a top-level token-override ACS names another issuer",
    async () => {
      await expect(detectTokenOverride(true, "Approve in your ENBDX app")).resolves.toMatchObject({
        three_ds_required: true,
        payment_instrument_mismatch: {
          kind: "payment_instrument_mismatch",
          expected: { last4: "9192", issuer: "DBS" },
          observed: { issuer: "ENBDX" },
          provenance: {
            expected: { last4: "released_card", issuer: "bin_metadata" },
            observed: "3ds_challenge",
          },
        },
      });
    },
  );

  it.skipIf(!chromiumAvailable)(
    "warns when an iframe token-override ACS names another issuer",
    async () => {
      await expect(detectTokenOverride(false, "Approve in your ENBDX app")).resolves.toMatchObject({
        payment_instrument_mismatch: { observed: { issuer: "ENBDX" } },
      });
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not warn when the ACS evidence matches the released card",
    async () => {
      await expect(
        detectTokenOverride(false, "Approve in your DBS app for card ending 9192"),
      ).resolves.toMatchObject({
        three_ds_required: true,
      });
      const result = await detectTokenOverride(
        false,
        "Approve in your DBS app for card ending 9192",
      );
      expect(result).not.toHaveProperty("payment_instrument_mismatch");
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not treat an editable card label as issuer evidence",
    async () => {
      const result = await detectTokenOverride(false, "Approve in your ENBDX app", null);
      expect(result).not.toHaveProperty("payment_instrument_mismatch");
    },
  );

  it.skipIf(!chromiumAvailable)("marks comparable label evidence as low confidence", async () => {
    await expect(
      detectTokenOverride(false, "Approve in your ENBDX app", null, "DBS Mastercard"),
    ).resolves.toMatchObject({
      payment_instrument_mismatch: {
        confidence: "low",
        evidence_used: ["issuer"],
        expected: { issuer: "DBS", label: "DBS Mastercard" },
        observed: { issuer: "ENBDX" },
        provenance: { expected: { issuer: "vault_label" } },
      },
    });
  });

  it.skipIf(!chromiumAvailable)("canonicalizes qualified vault network metadata", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent("<p>3D Secure authentication — Mastercard Identity Check</p>");
    const controller = new BrowserController({ humanize: false });
    (controller as unknown as { page: Page }).page = page;
    try {
      const result = await (
        controller as unknown as {
          detectThreeDsChallenge: (card: {
            pan: string;
            network: string;
          }) => Promise<CheckoutSubmitResult>;
        }
      ).detectThreeDsChallenge({ pan: "5555555555559192", network: "Mastercard DBS" });
      expect(result).not.toHaveProperty("payment_instrument_mismatch");
      await page.setContent("<p>3D Secure authentication — Approve in your ENBDX app</p>");
      await expect(
        (
          controller as unknown as {
            detectThreeDsChallenge: (card: {
              pan: string;
              network: string;
            }) => Promise<CheckoutSubmitResult>;
          }
        ).detectThreeDsChallenge({ pan: "5555555555559192", network: "Mastercard World Elite" }),
      ).resolves.not.toHaveProperty("payment_instrument_mismatch");
      await expect(
        (
          controller as unknown as {
            detectThreeDsChallenge: (card: {
              pan: string;
              network: string;
            }) => Promise<CheckoutSubmitResult>;
          }
        ).detectThreeDsChallenge({ pan: "5555555555559192", network: "Mastercard DBS" }),
      ).resolves.toMatchObject({
        payment_instrument_mismatch: {
          confidence: "low",
          evidence_used: ["issuer"],
          expected: { issuer: "DBS", network: "Mastercard DBS" },
          observed: { issuer: "ENBDX" },
          provenance: { expected: { issuer: "vault_metadata" } },
        },
      });
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "observes mismatch evidence that renders during an existing 3DS wait",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(
        '<iframe title="3D Secure authentication" srcdoc="<p>3D Secure authentication — Loading</p>"></iframe>',
      );
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;
      const privateController = controller as unknown as {
        detectThreeDsChallenge: (card: {
          pan: string;
          issuer: string;
          issuer_source: "bin_metadata";
        }) => Promise<CheckoutSubmitResult>;
      };
      try {
        const initial = await privateController.detectThreeDsChallenge({
          pan: "5555555555559192",
          issuer: "DBS",
          issuer_source: "bin_metadata",
        });
        expect(initial).not.toHaveProperty("payment_instrument_mismatch");
        await page
          .frameLocator('iframe[title="3D Secure authentication"]')
          .locator("p")
          .evaluate((element) => {
            element.textContent = "3D Secure authentication — Approve in your ENBDX app";
          });
        await controller.waitForThreeDsResolution(0);
        expect(controller.paymentInstrumentMismatch()).toMatchObject({
          observed: { issuer: "ENBDX" },
          provenance: { observed: "3ds_challenge" },
        });
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "resolves succeeded from the outer page's own order route while the challenge frame stays open and unresponsive",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      try {
        // The ACS iframe remains open and unresponsive. Only the merchant's
        // own JS (here, a plain pushState) drives completion.
        await page.evaluate(() => history.pushState({}, "", "/receipt/123"));
        await expect(controller.waitForThreeDsResolution(5_000)).resolves.toBe("succeeded");
        expect(await page.locator("#bank-approval").count()).toBe(1);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)("returns failed for visible decline text", async () => {
    const { browser, page, controller } = await setupChallenge();
    const wait = vi.spyOn(page, "waitForTimeout");
    try {
      await page.locator("body").evaluate((body) => {
        body.insertAdjacentHTML("beforeend", "<p>Payment declined</p>");
      });
      await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("failed");
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "ignores captcha failure text when no 3DS challenge is detected",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.route("https://merchant.test/**", async (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<iframe src="https://newassets.hcaptcha.com/captcha/frame"></iframe>',
        }),
      );
      await page.route("https://newassets.hcaptcha.com/**", async (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<iframe srcdoc="<p>Authentication failed</p>"></iframe>',
        }),
      );
      await page.goto("https://merchant.test/checkout");
      await page.waitForLoadState("networkidle");
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;
      let clock = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
      });
      try {
        await expect(
          (
            controller as unknown as {
              detectThreeDsChallenge: () => Promise<CheckoutSubmitResult>;
            }
          ).detectThreeDsChallenge(),
        ).resolves.toEqual({ three_ds_required: false, order_confirmed: false });
        await expect(controller.waitForThreeDsResolution(2_500)).resolves.toBe("timeout");
        expect(wait.mock.calls.map(([timeout]) => timeout)).toEqual([1_000, 1_000, 500]);
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "reports a pending challenge when neither an order route nor a decline appears",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      let clock = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
      });
      try {
        await expect(controller.waitForThreeDsResolution(5_000)).resolves.toBe("challenge_pending");
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "does not treat an unchanged checkout confirmation URL as success",
    async () => {
      const { browser, page, controller } = await setupChallenge();
      let clock = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      const wait = vi.spyOn(page, "waitForTimeout").mockImplementation(async (timeout) => {
        clock += timeout;
      });
      try {
        await page.evaluate(() => history.replaceState({}, "", "/checkout?success_url=/done"));
        await expect(controller.waitForThreeDsResolution(5_000)).resolves.toBe("challenge_pending");
      } finally {
        wait.mockRestore();
        now.mockRestore();
        await browser.close();
      }
    },
  );

  // REGRESSION: Gumroad collects "Full name" in its own form field, outside
  // the Stripe card box our selectors reach — the name field is never found.
  // That used to hard-abort the whole payment (payment_field_not_found:name).
  // Only the essential card fields (number, expiry, CVC) may block a charge.
  it.skipIf(!chromiumAvailable)(
    "submits the payment even when no cardholder-name field is present",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(`
        <form id="checkout">
          <input autocomplete="cc-number">
          <input autocomplete="cc-exp">
          <input autocomplete="cc-csc">
          <button type="submit">Pay now</button>
        </form>
        <script>
          document.querySelector("#checkout").addEventListener("submit", (event) => {
            event.preventDefault();
            void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
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
            country: "US",
          },
        });

        expect(await page.locator("body").getAttribute("data-submitted")).toBe("true");
        expect(result.three_ds_required).toBe(false);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );
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

  it.skipIf(!chromiumAvailable)(
    "retains expected evidence when submit dispatch becomes uncertain",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(FRAME_FORM);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        (
          controller as unknown as {
            submitFilledCheckoutInScope: () => Promise<CheckoutSubmitResult>;
          }
        ).submitFilledCheckoutInScope = async () => {
          throw new PaymentSubmitOutcomeUnknownError();
        };

        await expect(
          controller.fillAndSubmitCheckout({ ...CARD, network: "Mastercard" }),
        ).rejects.toBeInstanceOf(PaymentSubmitOutcomeUnknownError);
        await page.setContent(
          '<iframe title="3D Secure authentication" srcdoc="<p>Card ending 0005</p>"></iframe>',
        );
        await controller.waitForThreeDsResolution(0);
        expect(controller.paymentInstrumentMismatch()).toMatchObject({
          expected: { last4: "4242", network: "Mastercard" },
          observed: { last4: "0005" },
        });
      } finally {
        await browser.close();
      }
    },
  );

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
    "waits for Shopify's trusted PCI PAN instead of an earlier untrusted checkout-frame decoy",
    async () => {
      const pageUrl = "https://whitejade.example.test/checkout";
      const transientShopifyFrameUrl = "https://checkout.shopify.com/payment-shell";
      const pciUrl = "https://checkout.pci.shopifyinc.com/build/number-ltr.html";
      const hydrationUrl = "https://whitejade.example.test/checkout-hydration";
      let releaseHydration!: () => void;
      const hydrationPending = new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>White Jade checkout</title>
          <iframe src="${transientShopifyFrameUrl}"></iframe>
          <script>
            void fetch(${JSON.stringify(hydrationUrl)});
          </script>`,
        // Shopify's checkout shell is not an approved card-egress surface. It
        // can transiently expose card-shaped controls while it hydrates the
        // actual checkout.pci.shopifyinc.com hosted fields.
        [transientShopifyFrameUrl]: '<input autocomplete="cc-number">',
        [pciUrl]: FRAME_FORM,
      });
      try {
        await page.route(hydrationUrl, async (route) => {
          await hydrationPending;
          await route.fulfill({ status: 204 });
        });
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const fill = controller.fillCheckoutCardFields(CARD);
        await page.evaluate((url) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          document.body.append(frame);
        }, pciUrl);
        await fill;
        releaseHydration();

        const pciFrame = page.frames().find((frame) => frame.url() === pciUrl)!;
        expect(await pciFrame.locator('[autocomplete="cc-number"]').inputValue()).toBe(CARD.pan);
        expect(await pciFrame.locator('[autocomplete="cc-csc"]').inputValue()).toBe(CARD.cvv);
        const transientFrame = page
          .frames()
          .find((frame) => frame.url() === transientShopifyFrameUrl)!;
        expect(await transientFrame.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
    20_000,
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

  // Regression (ts-operator-3ds-completion): fillAndSubmitCheckout's post-submit
  // cleanup used to re-derive its frame list from a fresh this.page.frames() call
  // taken AFTER submission, so a 3-D Secure method/challenge iframe attached by
  // the time cleanup ran got its DOM scanned and any card-shaped field cleared —
  // corrupting the in-flight device-fingerprint hand-off to the real ACS on real
  // EbisuMart/JP checkouts. Cleanup must reuse the exact frame snapshot fill
  // wrote into (captured before the submit click): an unrecognized 3DS-provider
  // frame that only attaches afterward must never be touched, even if one of
  // its fields happens to look card-shaped.
  it.skipIf(!chromiumAvailable)(
    "never clears fields inside an unrecognized 3-D Secure frame during post-submit cleanup",
    async () => {
      const pageUrl = "https://hibiyakadan.test/cart_seisan.html";
      const methodUrl = "https://methodurl.vcas-issuer.test/DeviceFingerprintWeb/method";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <title>Hibiya Kadan</title>
          <form id="card-form">
            <input name="CREDIT_NO">
            <input name="CREDIT_NAME">
            <input name="SECURITY_CD">
            <select name="CREDIT_LIMIT_MONTH"><option value=""></option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value=""></option><option value="30">30</option></select>
          </form>
          <button id="place-order">注文する</button>
          <script>
            document.querySelector("#place-order").addEventListener("click", () => {
              const frame = document.createElement("iframe");
              frame.src = ${JSON.stringify(methodUrl)};
              frame.style.cssText = "display:none;width:0;height:0;border:0";
              frame.width = "0";
              frame.height = "0";
              document.body.append(frame);
              setTimeout(() => history.pushState({}, "", "/checkouts/order987/thank_you"), 300);
            });
          </script>`,
        [methodUrl]: `
          <input type="hidden" id="acs-cardnumber-token" value="untouched-fingerprint-token">
          <p>3DS method</p>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillAndSubmitCheckout(CARD);

        const acsFrame = page.frames().find((candidate) => candidate.url() === methodUrl);
        expect(acsFrame).toBeDefined();
        expect(await acsFrame!.locator("#acs-cardnumber-token").inputValue()).toBe(
          "untouched-fingerprint-token",
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "never clears fields after a filled frame navigates to a 3-D Secure document",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout";
      const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields-navigation";
      const acsUrl = "https://issuer-stronghold.test/acs/challenge";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Kobee Japan</title>
          <iframe src="${frameUrl}"></iframe>
          <button id="place-order">Place order</button>
          <script>
            document.querySelector("#place-order").addEventListener("click", () => {
              document.querySelector("iframe").src = ${JSON.stringify(acsUrl)};
            });
          </script>`,
        [frameUrl]: `
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
          </form>`,
        [acsUrl]: `
          <title>3-D Secure authentication</title>
          <input type="hidden" id="acs-cardnumber-token" value="untouched-challenge-token">
          <p>Authenticate payment</p>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const originalPaymentFrame = page.frames().find((frame) => frame.url() === frameUrl);
        expect(originalPaymentFrame).toBeDefined();
        const result = await controller.fillAndSubmitCheckout(CARD);

        expect(result.three_ds_required).toBe(true);
        const acsFrame = page.frames().find((frame) => frame.url() === acsUrl);
        expect(acsFrame).toBe(originalPaymentFrame);
        expect(await acsFrame!.locator("#acs-cardnumber-token").inputValue()).toBe(
          "untouched-challenge-token",
        );
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "never retargets cleanup when a filled frame navigates during cleanup",
    async () => {
      const pageUrl = "https://store.kobeejapan.net/checkout-cleanup-race";
      const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields-cleanup-race";
      const challengeUrl = "https://challenge-signal.test/3ds/challenge";
      const acsUrl = "https://issuer-stronghold.test/acs/delayed-challenge";
      const auxiliaryFrames = Array.from(
        { length: 8 },
        (_, index) => `<iframe srcdoc="<p>auxiliary-${index}</p>"></iframe>`,
      ).join("");
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Kobee Japan</title>
          ${auxiliaryFrames}
          <iframe id="payment-frame" src="${frameUrl}"></iframe>
          <button id="place-order">Place order</button>
          <script>
            window.addEventListener("message", (event) => {
              if (event.data === "cleanup-navigation-started") {
                document.body.dataset.cleanupNavigationStarted = "true";
              }
            });
            document.querySelector("#place-order").addEventListener("click", () => {
              document.querySelector("#payment-frame").contentWindow.postMessage(
                "arm-cleanup-navigation",
                "*",
              );
              const challenge = document.createElement("iframe");
              challenge.src = ${JSON.stringify(challengeUrl)};
              challenge.title = "3D Secure";
              challenge.style.cssText = "display:block;width:320px;height:240px";
              document.body.append(challenge);
            });
          </script>`,
        [frameUrl]: `
          <form>
            <input id="card-number" autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
          </form>
          <script>
            let cleanupNavigationArmed = false;
            window.addEventListener("message", (event) => {
              if (event.data === "arm-cleanup-navigation") cleanupNavigationArmed = true;
            });
            new MutationObserver((records) => {
              if (
                cleanupNavigationArmed &&
                records.some((record) => record.attributeName === "data-ts-jp-card-field")
              ) {
                cleanupNavigationArmed = false;
                parent.postMessage("cleanup-navigation-started", "*");
                location.href = ${JSON.stringify(acsUrl)};
              }
            }).observe(document.querySelector("#card-number"), {
              attributes: true,
              attributeFilter: ["data-ts-jp-card-field"],
            });
          </script>`,
        [challengeUrl]: `<p>3-D Secure challenge</p>`,
        [acsUrl]: `
          <title>Issuer ACS</title>
          <input type="hidden" id="acs-cardnumber-token" value="untouched-race-token">
          <p>Authenticate payment</p>`,
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        const originalPaymentFrame = page.frames().find((frame) => frame.url() === frameUrl);
        expect(originalPaymentFrame).toBeDefined();
        const acsNavigation = page.waitForEvent("framenavigated", {
          predicate: (frame) => frame.url() === acsUrl,
          timeout: 10_000,
        });

        const result = await controller.fillAndSubmitCheckout(CARD);
        const acsFrame = await acsNavigation;

        expect(result.three_ds_required).toBe(true);
        expect(acsFrame).toBe(originalPaymentFrame);
        expect(await page.locator("body").getAttribute("data-cleanup-navigation-started")).toBe(
          "true",
        );
        expect(await acsFrame.locator("#acs-cardnumber-token").inputValue()).toBe(
          "untouched-race-token",
        );
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[payment-cleanup]"));
      } finally {
        consoleError.mockRestore();
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "still clears card fields after same-document order confirmation navigation",
    async () => {
      const pageUrl = "https://merchant-garden.test/checkout";
      const receiptUrl = "https://merchant-garden.test/receipt/ORD-12345";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp-month">
            <input autocomplete="cc-exp-year">
            <input autocomplete="cc-csc">
            <button type="button" id="place-order">Place order</button>
          </form>
          <script>
            document.querySelector("#place-order").addEventListener("click", () => {
              history.pushState({}, "", "/receipt/ORD-12345");
              document.body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>");
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        const originalMainFrame = page.mainFrame();
        const result = await controller.fillAndSubmitCheckout(CARD);

        expect(result).toEqual({ three_ds_required: false, order_confirmed: true });
        expect(page.mainFrame()).toBe(originalMainFrame);
        expect(page.url()).toBe(receiptUrl);
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-name"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-exp-month"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-exp-year"]').inputValue()).toBe("");
        expect(await page.locator('[autocomplete="cc-csc"]').inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
    30_000,
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
    "keeps the main review total authoritative over an untrusted ambiguous frame total",
    async () => {
      const pageUrl = "https://shop.example.test/checkout/review";
      const rogueUrl = "https://rogue-payments.example.net/summary";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <title>Review order</title>
          <div>Order total USD 88.87</div>
          <iframe src="${rogueUrl}"></iframe>`,
        [rogueUrl]: "Order total 98.45 kr",
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.readCheckoutReviewSummary("USD")).resolves.toMatchObject({
          amount_cents: 8_887,
          currency: "USD",
        });
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
        await expect(controller.readCheckoutReviewSummary()).rejects.toThrow(
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
    "semantically clears controlled split expiry after terminal fill failure",
    async () => {
      const pageUrl = "https://shop.example.test/terminal-controlled-expiry";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form>
            <input autocomplete="cc-number" id="pan">
            <select name="CREDIT_LIMIT_MONTH" id="month">
              <option value=""></option><option value="12">December</option>
            </select>
            <select name="CREDIT_LIMIT_YEAR" id="year">
              <option value=""></option><option value="30">Two thousand thirty</option>
            </select>
            <input autocomplete="cc-csc" id="cvv">
            <input autocomplete="cc-name" id="holder">
          </form>
          <script>
            for (const id of ["month", "year"]) {
              const select = document.getElementById(id);
              let stored = "";
              select.addEventListener("change", () => { stored = select.value; });
              new MutationObserver(() => { select.value = stored; }).observe(select, {
                attributes: true,
                attributeFilter: ["data-ts-sealed-payment"],
              });
            }
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_submit_not_found",
        );
        const values = await page
          .locator("input,select")
          .evaluateAll((controls) =>
            controls.map((control) => (control as HTMLInputElement | HTMLSelectElement).value),
          );
        expect(values.every((value) => value === "")).toBe(true);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "preserves a terminal submit failure when card cleanup also fails",
    async () => {
      const pageUrl = "https://shop.example.test/terminal-primary-error";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-exp">
            <input autocomplete="cc-csc">
            <input autocomplete="cc-name">
          </form>
          <div id="preview"></div>
          <script>
            document.querySelector('[autocomplete="cc-number"]').addEventListener("input", (event) => {
              if (event.target.value !== "") {
                document.querySelector("#preview").textContent = "Card " + event.target.value;
              }
            });
          </script>`,
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_submit_not_found",
        );
        expect(consoleError).toHaveBeenCalledWith("[payment-cleanup] payment_fields_not_cleared");
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator("#preview").innerText()).toContain(CARD.pan);
      } finally {
        consoleError.mockRestore();
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "preserves a confirmed payment outcome when card cleanup also fails",
    async () => {
      const pageUrl = "https://shop.example.test/terminal-confirmed-cleanup-failure";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-exp">
            <input autocomplete="cc-csc">
            <input autocomplete="cc-name">
            <button type="button" id="pay-now">Pay now</button>
          </form>
          <div id="preview"></div>
          <script>
            document.querySelector('[autocomplete="cc-number"]').addEventListener("input", (event) => {
              if (event.target.value !== "") {
                document.querySelector("#preview").textContent = "Card " + event.target.value;
              }
            });
            document.querySelector("#pay-now").addEventListener("click", () => {
              history.pushState({}, "", "/receipt/ORD-12345");
              document.body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>");
            });
          </script>`,
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        const onSubmitDispatched = vi.fn();

        await expect(
          controller.fillAndSubmitCheckout(CARD, { onSubmitDispatched }),
        ).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: true,
        });
        expect(onSubmitDispatched).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith("[payment-cleanup] payment_fields_not_cleared");
        expect(await page.locator('[autocomplete="cc-number"]').inputValue()).toBe("");
        expect(await page.locator("#preview").innerText()).toContain(CARD.pan);
      } finally {
        consoleError.mockRestore();
        await browser.close();
      }
    },
    30_000,
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

  it.skipIf(!chromiumAvailable)(
    "fills a Hibiya-Kadan-shaped EbisuMart checkout (CREDIT_NO/CREDIT_NAME/SECURITY_CD + select expiry) without touching an unrelated month/year select",
    async () => {
      const pageUrl = "https://shop.example.test/cart_seisan.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <title>ご注文の入力</title>
          <form id="seisanForm" action="https://shop.example.test/submit">
            <div>
              <dt>カード名義</dt>
              <dd><input type="text" name="CREDIT_NAME" id="CREDIT_NAME"></dd>
            </div>
            <div>
              <dt>カード番号</dt>
              <dd><input type="text" name="CREDIT_NO" id="CREDIT_NO" placeholder="0123456789012345"></dd>
            </div>
            <div>
              <dt>お支払い回数</dt>
              <dd><select name="CREDIT_COUNT"><option value="1">一括払い</option></select></dd>
            </div>
            <div>
              <dt>有効期限</dt>
              <dd>
                <select name="CREDIT_LIMIT_MONTH" id="CREDIT_LIMIT_MONTH">
                  <option value="" selected>月を指定</option>
                  <option value="01">1</option><option value="02">2</option><option value="03">3</option>
                  <option value="04">4</option><option value="05">5</option><option value="06">6</option>
                  <option value="07">7</option><option value="08">8</option><option value="09">9</option>
                  <option value="10">10</option><option value="11">11</option><option value="12">12</option>
                </select>
                <select name="CREDIT_LIMIT_YEAR" id="CREDIT_LIMIT_YEAR">
                  <option value="" selected>年を指定</option>
                  <option value="26">2026</option><option value="27">2027</option><option value="28">2028</option>
                  <option value="29">2029</option><option value="30">2030</option><option value="31">2031</option>
                </select>
              </dd>
            </div>
            <div>
              <dt>セキュリティコード</dt>
              <dd><input type="text" name="SECURITY_CD" id="SECURITY_CD"></dd>
            </div>
            <!-- unrelated month/year select + a hidden lookalike name the broadened
                 selectors must NOT match, guarding against a wrong-field fill. -->
            <div>
              <dt>お届け希望日</dt>
              <dd>
                <select name="SEND_HOPE_DATE_MONTH" id="SEND_HOPE_DATE_MONTH"><option value="" selected>--</option><option value="9">9</option></select>
                <select name="SEND_HOPE_DATE_YEAR" id="SEND_HOPE_DATE_YEAR"><option value="" selected>--</option><option value="2026">2026</option></select>
              </dd>
            </div>
            <input type="hidden" name="MASKED_TOKEN_CREDIT_NO" value="">
            <button type="submit">ご注文を確定する</button>
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        // A 4-digit exp_year exercises the select's value="26"-miss /
        // label="2026"-hit fallback already built into fillFirst's select branch.
        await controller.fillCheckoutCardFields({ ...CARD, exp_year: "2030" });

        expect(await page.locator("#CREDIT_NO").inputValue()).toBe(CARD.pan);
        expect(await page.locator("#CREDIT_NAME").inputValue()).toBe(CARD.name);
        expect(await page.locator("#SECURITY_CD").inputValue()).toBe(CARD.cvv);
        expect(await page.locator("#CREDIT_LIMIT_MONTH").inputValue()).toBe("12");
        expect(await page.locator("#CREDIT_LIMIT_YEAR").inputValue()).toBe("30");
        expect(await page.locator("#SEND_HOPE_DATE_MONTH").inputValue()).toBe("");
        expect(await page.locator("#SEND_HOPE_DATE_YEAR").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)(
    "fills a JP checkout via the dt/dd label-text fallback when field names carry no card hint at all",
    async () => {
      const pageUrl = "https://shop.example.test/checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <title>ご注文の入力</title>
          <form id="checkoutForm" action="https://shop.example.test/submit">
            <dl>
              <dt><span class="title">カード番号</span></dt>
              <dd class="table-content"><div class="input-wrapper"><input type="text" name="f_1" id="f_1"></div></dd>
            </dl>
            <dl>
              <dt><span class="title">カード名義</span></dt>
              <dd class="table-content"><input type="text" name="f_2" id="f_2"></dd>
            </dl>
            <dl>
              <dt><span class="title">有効期限</span></dt>
              <dd class="table-content">
                <select name="f_3" id="f_3">
                  <option value="" selected>月を指定</option>
                  <option value="01">1</option><option value="02">2</option><option value="03">3</option>
                  <option value="04">4</option><option value="05">5</option><option value="06">6</option>
                  <option value="07">7</option><option value="08">8</option><option value="09">9</option>
                  <option value="10">10</option><option value="11">11</option><option value="12">12</option>
                </select>
                <select name="f_4" id="f_4">
                  <option value="" selected>年を指定</option>
                  <option value="26">2026</option><option value="27">2027</option><option value="28">2028</option>
                  <option value="29">2029</option><option value="30">2030</option><option value="31">2031</option>
                </select>
              </dd>
            </dl>
            <dl>
              <dt><span class="title">セキュリティコード</span></dt>
              <dd class="table-content"><input type="text" name="f_5" id="f_5"></dd>
            </dl>
            <button type="submit">確定する</button>
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);

        expect(await page.locator("#f_1").inputValue()).toBe(CARD.pan);
        expect(await page.locator("#f_2").inputValue()).toBe(CARD.name);
        expect(await page.locator("#f_5").inputValue()).toBe(CARD.cvv);
        expect(await page.locator("#f_3").inputValue()).toBe(CARD.exp_month.padStart(2, "0"));
        expect(await page.locator("#f_4").inputValue()).toBe(CARD.exp_year);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "excludes non-card CVV identities and JP labels",
    async () => {
      const cases = [
        {
          name: "gift-cvv-identity",
          cvv: '<input type="text" name="GIFT_SECURITY_CD" id="false-cvv">',
        },
        {
          name: "security-cd-note",
          cvv: '<input type="text" name="SECURITY_CD_NOTE" id="false-field">',
        },
        {
          name: "gift-cvv-label",
          cvv: '<dl><dt>ギフトセキュリティコード</dt><dd><input type="text" id="field-z"></dd></dl>',
        },
      ];
      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <meta charset="utf-8">
            <form>
              <input type="text" autocomplete="cc-number" id="pan">
              <input type="text" autocomplete="cc-name" id="holder">
              <input type="text" autocomplete="cc-exp" id="expiry">
              ${testCase.cvv}
            </form>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
            "payment_field_not_found:cvv",
          );
          await expect(
            page
              .locator("input")
              .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
          ).resolves.toEqual(["", "", "", ""]);
        } finally {
          await browser.close();
        }
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)(
    "leaves non-card holder identity and label candidates untouched",
    async () => {
      const pageUrl = "https://shop.example.test/gift-holder-fields.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <input type="text" autocomplete="cc-number" id="pan">
            <input type="text" autocomplete="cc-exp" id="expiry">
            <input type="text" autocomplete="cc-csc" id="cvv">
            <input type="text" name="GIFT_CREDIT_NAME" id="gift-holder">
            <input type="text" name="CARD_NAME_NOTE" id="holder-note">
            <dl><dt>ギフトカード名義</dt><dd><input type="text" id="field-holder"></dd></dl>
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillCheckoutCardFields(CARD);
        expect(await page.locator("#gift-holder").inputValue()).toBe("");
        expect(await page.locator("#holder-note").inputValue()).toBe("");
        expect(await page.locator("#field-holder").inputValue()).toBe("");
        expect(await page.locator("#pan").inputValue()).toBe(CARD.pan);
        expect(await page.locator("#cvv").inputValue()).toBe(CARD.cvv);
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "preserves legacy Western combined and split expiry detection",
    async () => {
      const cases = [
        {
          name: "combined",
          expiry: '<input name="payment_expiration" id="expiry">',
          expected: async (page: Page) => {
            expect(await page.locator("#expiry").inputValue()).toBe("1230");
          },
        },
        {
          name: "split",
          expiry: `
            <select name="payment_exp_month" id="month">
              <option value=""></option><option value="12">December</option>
            </select>
            <select name="payment_exp_year" id="year">
              <option value=""></option><option value="30">2030</option>
            </select>`,
          expected: async (page: Page) => {
            expect(await page.locator("#month").inputValue()).toBe("12");
            expect(await page.locator("#year").inputValue()).toBe("30");
          },
        },
      ];
      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/legacy-western-${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <form>
              <input autocomplete="cc-number" id="pan">
              <input autocomplete="cc-name" id="holder">
              ${testCase.expiry}
              <input autocomplete="cc-csc" id="cvv">
            </form>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await controller.fillCheckoutCardFields(CARD);
          await testCase.expected(page);
          expect(await page.locator("#pan").inputValue()).toBe(CARD.pan);
          expect(await page.locator("#cvv").inputValue()).toBe(CARD.cvv);
        } finally {
          await browser.close();
        }
      }
    },
  );

  it.skipIf(!chromiumAvailable)("preserves legacy Western number-input PAN detection", async () => {
    const pageUrl = "https://shop.example.test/legacy-number-pan.html";
    const { page, browser } = await servePages({
      [pageUrl]: `
          <form>
            <input type="number" name="cardnumber" id="legacy-pan">
            <input autocomplete="cc-name" id="holder">
            <input autocomplete="cc-exp" id="expiry">
            <input autocomplete="cc-csc" id="cvv">
          </form>`,
    });
    try {
      await page.goto(pageUrl);
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;

      await controller.fillCheckoutCardFields(CARD);
      expect(await page.locator("#legacy-pan").inputValue()).toBe(CARD.pan);
      expect(await page.locator("#cvv").inputValue()).toBe(CARD.cvv);
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "refuses ambiguous and unrelated expiry topologies before filling",
    async () => {
      const cases = [
        {
          name: "combined-and-split",
          expiry: `
            <input type="text" autocomplete="cc-exp" id="card-expiry">
            <select name="card_exp_month"><option value=""></option><option value="12">12</option></select>
            <select name="card_exp_year"><option value=""></option><option value="30">30</option></select>`,
        },
        {
          name: "same-split-control",
          expiry: '<input type="text" name="exp_month_exp_year" id="shared-expiry">',
        },
        {
          name: "different-split-groups",
          expiry: `
            <select name="credit_limit_month" id="credit-month"><option value=""></option></select>
            <input type="text" name="card_exp_year" id="card-year">`,
        },
      ];
      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <meta charset="utf-8">
            <form>
              <input type="text" autocomplete="cc-number" id="pan">
              <input type="text" autocomplete="cc-name" id="holder">
              ${testCase.expiry}
              <input type="text" autocomplete="cc-csc" id="cvv">
            </form>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
            "payment_card_form_ambiguous",
          );
          const values = await page
            .locator("input,select")
            .evaluateAll((controls) =>
              controls.map((control) => (control as HTMLInputElement | HTMLSelectElement).value),
            );
          expect(values.every((value) => value === "")).toBe(true);
        } finally {
          await browser.close();
        }
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses non-card expiry identities and JP labels before filling",
    async () => {
      const cases = [
        {
          name: "membership-expiry",
          jpIdentity: false,
          expiry: `
            <select name="membership_exp_month"><option value=""></option><option value="12">12</option></select>
            <select name="membership_exp_year"><option value=""></option><option value="30">30</option></select>`,
        },
        {
          name: "gift-card-expiry-label",
          jpIdentity: false,
          expiry: `
            <dl>
              <dt>ギフトカード有効期限</dt>
              <dd>
                <select id="field-a"><option value="">月を指定</option><option value="12">12</option></select>
                <select id="field-b"><option value="">年を指定</option><option value="30">2030</option></select>
              </dd>
            </dl>`,
        },
        {
          name: "order-expiration-note",
          jpIdentity: true,
          expiry: '<input type="text" name="order_expiration_note" id="false-expiry">',
        },
      ];
      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <meta charset="utf-8">
            <form>
              <input type="text" ${testCase.jpIdentity ? 'name="CREDIT_NO"' : 'autocomplete="cc-number"'} id="pan">
              <input type="text" ${testCase.jpIdentity ? 'name="CREDIT_NAME"' : 'autocomplete="cc-name"'} id="holder">
              ${testCase.expiry}
              <input type="text" ${testCase.jpIdentity ? 'name="SECURITY_CD"' : 'autocomplete="cc-csc"'} id="cvv">
            </form>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
            "payment_field_not_found:expiry",
          );
          const values = await page
            .locator("input,select")
            .evaluateAll((controls) =>
              controls.map((control) => (control as HTMLInputElement | HTMLSelectElement).value),
            );
          expect(values.every((value) => value === "")).toBe(true);
        } finally {
          await browser.close();
        }
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses legacy expiry and CVV sibling candidates on JP-only card forms",
    async () => {
      const cases = [
        {
          name: "legacy-expiry-siblings",
          controls: `
            <select name="order_exp_month" id="false-month">
              <option value=""></option><option value="12">12</option>
            </select>
            <select name="order_exp_year" id="false-year">
              <option value=""></option><option value="30">30</option>
            </select>
            <input name="SECURITY_CD" id="cvv">`,
          expectedError: "payment_field_not_found:expiry",
        },
        {
          name: "legacy-cvv-sibling",
          controls: `
            <select name="CREDIT_LIMIT_MONTH" id="month">
              <option value=""></option><option value="12">12</option>
            </select>
            <select name="CREDIT_LIMIT_YEAR" id="year">
              <option value=""></option><option value="30">2030</option>
            </select>
            <input name="CVC_NOTE" id="false-cvv">`,
          expectedError: "payment_field_not_found:cvv",
        },
      ];
      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <form>
              <input name="CREDIT_NO" id="pan">
              <input name="CREDIT_NAME" id="holder">
              ${testCase.controls}
            </form>
            <script>
              for (const id of ["false-month", "false-year"]) {
                const field = document.getElementById(id);
                if (field) field.addEventListener("change", (event) => {
                  if (event.target.value) document.body.dataset.falseExpiryTouched = "true";
                });
              }
              const falseCvv = document.getElementById("false-cvv");
              if (falseCvv) falseCvv.addEventListener("input", (event) => {
                if (event.target.value) document.body.dataset.falseCvvTouched = "true";
              });
            </script>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
            testCase.expectedError,
          );
          expect(await page.locator("body").getAttribute("data-false-expiry-touched")).toBeNull();
          expect(await page.locator("body").getAttribute("data-false-cvv-touched")).toBeNull();
          const values = await page
            .locator("input,select")
            .evaluateAll((controls) =>
              controls.map((control) => (control as HTMLInputElement | HTMLSelectElement).value),
            );
          expect(values.every((value) => value === "")).toBe(true);
        } finally {
          await browser.close();
        }
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "rejects a trailing-token PAN identity beside segmented card inputs",
    async () => {
      const pageUrl = "https://shop.example.test/card-no-note-and-segmented.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <input name="CARD_NO_NOTE" id="false-pan">
            <dl>
              <dt>カード番号</dt>
              <dd>
                <input id="pan-1"><input id="pan-2">
                <input id="pan-3"><input id="pan-4">
              </dd>
            </dl>
            <input name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value=""></option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value=""></option><option value="30">2030</option></select>
            <input name="SECURITY_CD" id="cvv">
          </form>
          <script>
            document.getElementById("false-pan").addEventListener("input", (event) => {
              if (event.target.value) document.body.dataset.falsePanValue = event.target.value;
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:pan",
        );
        expect(await page.locator("body").getAttribute("data-false-pan-value")).toBeNull();
        const values = await page
          .locator("input")
          .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
        expect(values.every((value) => value === "")).toBe(true);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a JP card-number label associated with four visible PAN segments",
    async () => {
      const pageUrl = "https://shop.example.test/segmented-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <dl>
              <dt>カード番号</dt>
              <dd>
                <input type="text" id="f_1"><input type="text" id="f_2">
                <input type="text" id="f_3"><input type="text" id="f_4">
              </dd>
            </dl>
            <dl><dt>カード名義</dt><dd><input type="text" id="f_5"></dd></dl>
            <dl>
              <dt>有効期限</dt>
              <dd>
                <select id="f_6"><option value="">月を指定</option><option value="12">12</option></select>
                <select id="f_7"><option value="">年を指定</option><option value="30">2030</option></select>
              </dd>
            </dl>
            <dl><dt>セキュリティコード</dt><dd><input type="text" id="f_8"></dd></dl>
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:pan",
        );
        await expect(
          page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses ambiguous same-form JP PAN substring candidates before filling",
    async () => {
      const pageUrl = "https://shop.example.test/ambiguous-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <input type="text" name="BACKUP_CARD_NO" id="backup-card">
            <input type="text" name="CREDIT_NO" id="credit-card">
            <input type="text" name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value="">月を指定</option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value="">年を指定</option><option value="30">2030</option></select>
            <input type="text" name="SECURITY_CD" id="cvv">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_card_form_ambiguous",
        );
        expect(await page.locator("#backup-card").inputValue()).toBe("");
        expect(await page.locator("#credit-card").inputValue()).toBe("");
        expect(await page.locator("#holder").inputValue()).toBe("");
        expect(await page.locator("#cvv").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a gift-card false singleton beside a segmented JP PAN",
    async () => {
      const pageUrl = "https://shop.example.test/gift-and-segmented-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <input type="text" name="GIFT_CARD_NO" id="gift-card">
            <dl>
              <dt>カード番号</dt>
              <dd>
                <input type="text" id="pan-1"><input type="text" id="pan-2">
                <input type="text" id="pan-3"><input type="text" id="pan-4">
              </dd>
            </dl>
            <input type="text" name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value="">月を指定</option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value="">年を指定</option><option value="30">2030</option></select>
            <input type="text" name="SECURITY_CD" id="cvv">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:pan",
        );
        await expect(
          page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a compound gift-card label beside a segmented JP PAN",
    async () => {
      const pageUrl = "https://shop.example.test/gift-label-and-segmented-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <dl><dt>ギフトカード番号</dt><dd><input type="text" id="opaque-token"></dd></dl>
            <dl>
              <dt>カード番号</dt>
              <dd>
                <input type="text" id="pan-1"><input type="text" id="pan-2">
                <input type="text" id="pan-3"><input type="text" id="pan-4">
              </dd>
            </dl>
            <input type="text" name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value="">月を指定</option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value="">年を指定</option><option value="30">2030</option></select>
            <input type="text" name="SECURITY_CD" id="cvv">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:pan",
        );
        await expect(
          page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a token-prefix false singleton beside a segmented JP PAN",
    async () => {
      const pageUrl = "https://shop.example.test/card-note-and-segmented-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            <input type="text" name="CARD_NOTE" id="unrelated-note">
            <dl>
              <dt>カード番号</dt>
              <dd>
                <input type="text" id="pan-1"><input type="text" id="pan-2">
                <input type="text" id="pan-3"><input type="text" id="pan-4">
              </dd>
            </dl>
            <input type="text" name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value="">月を指定</option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value="">年を指定</option><option value="30">2030</option></select>
            <input type="text" name="SECURITY_CD" id="cvv">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillCheckoutCardFields(CARD)).rejects.toThrow(
          "payment_field_not_found:pan",
        );
        await expect(
          page
            .locator("input")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ).resolves.toEqual(["", "", "", "", "", "", ""]);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "counts visible PAN candidates beyond the first ten before filling",
    async () => {
      const pageUrl = "https://shop.example.test/long-ambiguous-checkout.html";
      const hiddenPans = Array.from(
        { length: 9 },
        (_, index) =>
          `<input type="text" name="CARD_NO_HIDDEN_${index}" autocomplete="cc-number" hidden>`,
      ).join("");
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form>
            ${hiddenPans}
            <input type="text" name="CREDIT_NO" id="credit-card">
            <input type="text" name="BACKUP_CARD_NO" id="backup-card">
            <input type="text" name="CREDIT_NAME" id="holder">
            <select name="CREDIT_LIMIT_MONTH"><option value="">月を指定</option><option value="12">12</option></select>
            <select name="CREDIT_LIMIT_YEAR"><option value="">年を指定</option><option value="30">2030</option></select>
            <input type="text" name="SECURITY_CD" id="cvv">
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_form_ambiguous",
        );
        expect(await page.locator("#credit-card").inputValue()).toBe("");
        expect(await page.locator("#backup-card").inputValue()).toBe("");
        expect(await page.locator("#holder").inputValue()).toBe("");
        expect(await page.locator("#cvv").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "discovers complete card groups beyond the first ten PAN anchors",
    async () => {
      const pageUrl = "https://shop.example.test/long-multi-form-checkout.html";
      const hiddenPans = Array.from(
        { length: 9 },
        () => '<input type="text" autocomplete="cc-number" hidden>',
      ).join("");
      const form = (prefix: string): string => `
        <form>
          <input type="text" autocomplete="cc-number" id="${prefix}-pan">
          <input type="text" autocomplete="cc-name" id="${prefix}-holder">
          <input type="text" autocomplete="cc-exp-month" id="${prefix}-month">
          <input type="text" autocomplete="cc-exp-year" id="${prefix}-year">
          <input type="text" autocomplete="cc-csc" id="${prefix}-cvv">
        </form>`;
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <style>main { display: flex; gap: 24px } form { width: 280px }</style>
          <main>${form("first")}${hiddenPans}${form("second")}</main>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_form_ambiguous",
        );
        expect(await page.locator("#first-pan").inputValue()).toBe("");
        expect(await page.locator("#second-pan").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
  );

  it.skipIf(!chromiumAvailable)(
    "positively selects the new-card radio and completes on the filled card, deselecting the competing saved card",
    async () => {
      // EbisuMart-shaped repeat-customer checkout: a "new card" fieldset (what
      // we fill, matching card_ref) alongside a DEFAULT-CHECKED "use my saved
      // card" radio for a DIFFERENT stored card. Money-fence: the released and
      // audited card must be the one that is actually charged. The captain's
      // decision (2026-08-23) is to actively resolve this rather than refuse:
      // click the new-card radio (deselecting the saved one via normal
      // radio-group semantics), verify the filled fields survived and the
      // saved card is no longer selected, THEN submit — never guess, never
      // silently leave the saved card able to win.
      const pageUrl = "https://hibiyakadan.example.test/cart_seisan.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form id="checkout">
            <label>
              <input id="saved-radio" type="radio" name="payment_method" value="saved" checked>
              Card on file: Visa •••• 9012
            </label>
            <label>
              <input id="new-radio" type="radio" name="payment_method" value="new">
              Use a different card
            </label>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Place order</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillAndSubmitCheckout(CARD);

        // Submitted on the FIRST attempt (no retry/re-fill) with the radio
        // flip already resolved — the same fill that was verified intact
        // right before the click, per resolveCompetingSavedCardSelection's
        // own field-value check.
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBe("true");
        expect(await page.locator("#saved-radio").isChecked()).toBe(false);
        expect(await page.locator("#new-radio").isChecked()).toBe(true);
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "positively selects the new-card radio when the filled card fields live in a recognized hosted-fields iframe",
    async () => {
      // EbisuMart-adjacent split topology: the merchant-owned saved/new-card
      // radio group lives in the MAIN frame while the card fields it controls
      // live in a recognized hosted-fields iframe. The sealed-field evidence
      // that gates positive resolution is aggregated ACROSS frames, so this
      // must resolve — refusal here would make the cross-frame repeat-customer
      // checkout a dead end even though exactly one new-card candidate exists.
      const pageUrl = "https://shop.example.test/cross-frame-new-card-checkout.html";
      const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <label>
            <input id="saved-radio" type="radio" name="payment_method" value="saved" checked>
            Card on file: Visa •••• 9012
          </label>
          <label>
            <input id="new-radio" type="radio" name="payment_method" value="new">
            Use a different card
          </label>
          <iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          <form id="card-form">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#card-form").addEventListener("submit", (event) => {
              event.preventDefault();
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillAndSubmitCheckout(CARD);

        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        expect(await frame.locator("body").getAttribute("data-submitted")).toBe("true");
        expect(await page.locator("#saved-radio").isChecked()).toBe(false);
        expect(await page.locator("#new-radio").isChecked()).toBe(true);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it.skipIf(!chromiumAvailable)(
    "still refuses when the new-card radio's choice group has two equally-plausible non-saved candidates",
    async () => {
      // Genuinely unresolvable: no structural (sealed-field-owning) or
      // sole-candidate signal picks between "Use a different card" and
      // "Corporate card" — guessing between them risks the SAME wrong-card
      // charge #572 fixed. Refusal must still be the last resort here.
      const pageUrl = "https://shop.example.test/multi-candidate-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form id="checkout">
            <label><input type="radio" name="payment_method" value="saved" checked>Card on file •••• 9012</label>
            <label><input type="radio" name="payment_method" value="new">Use a different card</label>
            <label><input type="radio" name="payment_method" value="corporate">Corporate card</label>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
        expect(await page.locator("[autocomplete='cc-number']").inputValue()).toBe("");
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses (never re-fills) when selecting the new-card radio itself clears the filled fields",
    async () => {
      // A framework that resets the "new card" fieldset's own state when its
      // radio is (re-)selected — verification must catch this and refuse,
      // never attempt to re-fill (the raw card bytes are gone by this point
      // in the call chain anyway).
      const pageUrl = "https://shop.example.test/reset-on-toggle-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form id="checkout">
            <label><input type="radio" name="payment_method" value="saved" checked>Card on file •••• 9012</label>
            <label><input id="new-radio" type="radio" name="payment_method" value="new">Use a different card</label>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            document.querySelector("#new-radio").addEventListener("change", () => {
              for (const el of document.querySelectorAll(
                "[autocomplete='cc-number'],[autocomplete='cc-csc']",
              )) {
                el.value = "";
              }
            });
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a saved-card selection in a different frame from the filled card fields",
    async () => {
      const pageUrl = "https://shop.example.test/cross-frame-checkout.html";
      const frameUrl = "https://checkout.pci.shopifyinc.com/card-fields";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <label>
            <input type="radio" name="payment_method" value="saved" checked>
            Saved card •••• 9012
          </label>
          <iframe src="${frameUrl}"></iframe>`,
        [frameUrl]: `
          <form id="card-form">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay now</button>
          </form>
          <script>
            document.querySelector("#card-form").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        await page.waitForLoadState("networkidle");
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        const frame = page.frames().find((candidate) => candidate.url() === frameUrl)!;
        expect(await frame.locator("body").getAttribute("data-submitted")).toBeNull();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a saved-card radio associated to the card form from outside its subtree",
    async () => {
      const pageUrl = "https://shop.example.test/form-associated-radio-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form id="checkout">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <input id="saved-card" form="checkout" type="radio" name="payment_method" value="saved" checked>
          <label for="saved-card">Card on file ending in 9012</label>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a selected saved-card option alongside the filled card fields",
    async () => {
      const pageUrl = "https://shop.example.test/saved-card-select-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form id="checkout">
            <label for="payment-source">Payment source</label>
            <select id="payment-source">
              <option value="saved" selected>Saved card •••• 9012</option>
              <option value="new">New card</option>
            </select>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "excludes the exact filled expiry select from saved-card option detection",
    async () => {
      const pageUrl = "https://shop.example.test/filled-expiry-select-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form id="checkout">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <select autocomplete="cc-exp-month"><option value="12">12</option></select>
            <select autocomplete="cc-exp-year"><option value="30">Saved card •••• 30</option></select>
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillAndSubmitCheckout(CARD);
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBe("true");
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses a saved-card selection nested in open shadow roots",
    async () => {
      const pageUrl = "https://shop.example.test/shadow-saved-card-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <saved-card-source id="saved-source"></saved-card-source>
          <form id="checkout">
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            const outer = document.querySelector("#saved-source").attachShadow({ mode: "open" });
            outer.innerHTML = '<saved-card-choice id="saved-choice"></saved-card-choice>';
            const inner = outer.querySelector("#saved-choice").attachShadow({ mode: "open" });
            inner.innerHTML =
              '<input id="saved-card" type="radio" checked>' +
              '<label for="saved-card">Saved card •••• 9012</label>';
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await expect(controller.fillAndSubmitCheckout(CARD)).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "refuses submission when saved-card inspection cannot complete",
    async () => {
      const pageUrl = "https://shop.example.test/detached-card-inspection.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <form>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;
        await controller.fillCheckoutCardFields(CARD);
        const evaluate = vi.spyOn(page.mainFrame(), "evaluate");
        evaluate.mockRejectedValueOnce(new Error("frame detached during inspection"));

        await expect(controller.submitFilledCheckout()).rejects.toThrow(
          "payment_card_selection_ambiguous",
        );
        evaluate.mockRestore();
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "still submits when the checked payment-method option is an unrelated non-card choice",
    async () => {
      // A "Credit Card" vs. "PayPal" method toggle is a legitimate, unrelated
      // selection (no masked PAN, no saved-card marker) — must not false-
      // positive the competing-saved-card refusal.
      const pageUrl = "https://shop.example.test/method-toggle-checkout.html";
      const { page, browser } = await servePages({
        [pageUrl]: `
          <meta charset="utf-8">
          <form id="checkout">
            <label><input type="radio" name="payment_method" value="card" checked> Credit Card</label>
            <label><input type="radio" name="payment_method" value="paypal"> PayPal</label>
            <input autocomplete="cc-number">
            <input autocomplete="cc-name">
            <input autocomplete="cc-exp" placeholder="MM/YY">
            <input autocomplete="cc-csc">
            <button type="submit">Pay</button>
          </form>
          <script>
            document.querySelector("#checkout").addEventListener("submit", (event) => {
              event.preventDefault();
              void fetch("https://merchant.test/charges", { method: "POST", mode: "no-cors" });
              document.body.dataset.submitted = "true";
            });
          </script>`,
      });
      try {
        await page.goto(pageUrl);
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { page: Page }).page = page;

        await controller.fillAndSubmitCheckout(CARD);
        expect(await page.evaluate(() => document.body.dataset.submitted)).toBe("true");
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "resolves label-for and wrapped-label JP expiry pairs and cleans replaced selects",
    async () => {
      const expiryOptions = `
        <option value="">月を指定</option><option value="12">December</option>`;
      const yearOptions = `
        <option value="">年を指定</option><option value="30">Two thousand thirty</option>`;
      const cases = [
        {
          name: "label-for",
          expiry: `
            <label for="field-a">有効期限</label>
            <select id="field-a">${expiryOptions}</select>
            <select id="field-b">${yearOptions}</select>`,
        },
        {
          name: "wrapped-label",
          expiry: `
            <label>有効期限
              <select id="field-a">${expiryOptions}</select>
              <select id="field-b">${yearOptions}</select>
            </label>`,
        },
      ];

      for (const testCase of cases) {
        const pageUrl = `https://shop.example.test/${testCase.name}.html`;
        const { page, browser } = await servePages({
          [pageUrl]: `
            <meta charset="utf-8">
            <form>
              <input autocomplete="cc-number">
              <input autocomplete="cc-name">
              ${testCase.expiry}
              <input autocomplete="cc-csc">
            </form>`,
        });
        try {
          await page.goto(pageUrl);
          const controller = new BrowserController({ humanize: false });
          (controller as unknown as { page: Page }).page = page;

          await controller.fillCheckoutCardFields(CARD);
          expect(await page.locator("#field-a").inputValue()).toBe("12");
          expect(await page.locator("#field-b").inputValue()).toBe("30");

          await page.locator("select").evaluateAll((selects) => {
            for (const original of selects) {
              const replacement = original.cloneNode(true) as HTMLSelectElement;
              replacement.removeAttribute("data-ts-sealed-payment");
              replacement.removeAttribute("data-ts-jp-card-exp");
              replacement.removeAttribute("data-ts-jp-card-exp-group");
              replacement.removeAttribute("data-ts-jp-card-field");
              replacement.value = (original as HTMLSelectElement).value;
              original.replaceWith(replacement);
            }
          });
          await controller.clearCheckoutCardFields();

          expect(await page.locator("#field-a").inputValue()).toBe("");
          expect(await page.locator("#field-b").inputValue()).toBe("");
        } finally {
          await browser.close();
        }
      }
    },
    15_000,
  );
});
describe("3DS detection vs captcha frames", () => {
  async function detectInRealPage(
    browser: Browser,
    options: {
      frameUrl?: string;
      frameAttributes?: string;
      frameHtml?: string;
      merchantHtml?: string;
    },
  ): Promise<CheckoutSubmitResult> {
    const page = await browser.newPage();
    const merchantUrl = "https://merchant.test/checkout";
    const frameMarkup =
      options.frameUrl === undefined
        ? ""
        : `<iframe ${options.frameAttributes ?? ""} src="${options.frameUrl}"></iframe>`;
    try {
      await page.route("**/*", async (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            route.request().url() === merchantUrl
              ? `${options.merchantHtml ?? ""}${frameMarkup}`
              : (options.frameHtml ?? "<div>Authentication frame</div>"),
        }),
      );
      await page.goto(merchantUrl);
      await page.waitForLoadState("networkidle");
      const controller = new BrowserController({ humanize: false });
      (controller as unknown as { page: Page }).page = page;
      return await (
        controller as unknown as { detectThreeDsChallenge: () => Promise<CheckoutSubmitResult> }
      ).detectThreeDsChallenge();
    } finally {
      await page.close();
    }
  }

  it.skipIf(!chromiumAvailable)(
    "keeps every retained cross-processor 3DS signal",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const cases = [
        {
          frameUrl: "https://0merchantacsstag.cardinalcommerce.com/V1/Cruise/StepUp",
        },
        { frameUrl: "https://hooks.stripe.com/3d_secure/authenticate/src_1" },
        { frameUrl: "https://issuer.example.test/acs/challenge?provider=hcaptcha.com" },
        { frameUrl: "https://issuer.example.test/flow/3d-secure/start" },
        { frameUrl: "https://issuer.example.test/flow/three-d-secure/start" },
        { frameUrl: "https://issuer.example.test/3ds2/authenticate" },
        {
          frameUrl: "https://issuer.example.test/authenticate",
          frameAttributes: 'title="3D Secure authentication"',
        },
        {
          frameUrl: "https://issuer.example.test/authenticate",
          frameHtml: '<form><input type="hidden" name="creq"><button>Authorize</button></form>',
        },
        { merchantHtml: "<p>Please authenticate this payment using 3-D Secure</p>" },
      ];
      try {
        for (const testCase of cases) {
          await expect(detectInRealPage(browser, testCase)).resolves.toMatchObject({
            three_ds_required: true,
          });
        }
      } finally {
        await browser.close();
      }
    },
    15_000,
  );

  it.skipIf(!chromiumAvailable)("rejects captcha and removed bare challenge signals", async () => {
    const browser = await chromium.launch({ headless: true });
    const cases = [
      { frameUrl: "https://issuer.example.test/challenge" },
      {
        frameUrl: "https://issuer.example.test/authenticate",
        frameAttributes: 'name="payment-challenge"',
      },
      {
        frameUrl:
          "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=challenge&id=xyz",
        frameHtml: "<p>Please authenticate this payment using 3-D Secure</p>",
      },
      {
        frameUrl:
          "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=nested&id=xyz",
        frameHtml:
          '<iframe srcdoc="<p>Please verify your identity</p><input name=&quot;creq&quot;>"></iframe>',
      },
      // EMV 3DS "3DS Method" pre-auth ping — a real ACS-shaped URL, but a
      // hidden 0x0 iframe with no user interaction, not a challenge.
      {
        frameUrl: "https://issuer.example.test/acs/method",
        frameAttributes: 'style="display:none;width:0;height:0;border:0" width="0" height="0"',
      },
    ];
    try {
      for (const testCase of cases) {
        await expect(detectInRealPage(browser, testCase)).resolves.toEqual({
          three_ds_required: false,
          order_confirmed: false,
        });
      }
    } finally {
      await browser.close();
    }
  });

  it.skipIf(!chromiumAvailable)(
    "ignores 3DS signals hidden by their element or an ancestor",
    async () => {
      const browser = await chromium.launch({ headless: true });
      const cases = [
        {
          merchantHtml:
            '<div style="opacity:0"><iframe src="https://issuer.example.test/acs/method" width="100" height="100"></iframe></div>',
        },
        {
          merchantHtml:
            '<div style="visibility:hidden"><iframe title="3D Secure authentication" src="https://issuer.example.test/authenticate"></iframe></div>',
        },
        {
          merchantHtml:
            '<div style="display:none"><form action="https://issuer.example.test/acs/challenge"><button>Authorize</button></form></div>',
        },
        {
          merchantHtml:
            '<div style="opacity:0"><p>Please authenticate this payment using 3-D Secure</p></div>',
        },
        { merchantHtml: '<input type="hidden" name="creq">' },
        {
          merchantHtml:
            '<div style="width:0;height:0;overflow:hidden"><iframe title="3D Secure authentication" src="https://issuer.example.test/acs/method" width="100" height="100"></iframe></div>',
        },
      ];
      try {
        for (const testCase of cases) {
          await expect(detectInRealPage(browser, testCase)).resolves.toEqual({
            three_ds_required: false,
            order_confirmed: false,
          });
        }
      } finally {
        await browser.close();
      }
    },
    15_000,
  );
});
