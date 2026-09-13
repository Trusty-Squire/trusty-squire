import { BrowserController } from "../browser.js";
import { recognizedPaymentProviderFrame, scopedOrderSummaryText } from "../browser.js";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";

// ── Defect B ────────────────────────────────────────────────────────────────
// The cart page's only payable amount is 小計 (subtotal) with 送料無料 (free
// shipping), buried among ~30 ショップ内の関連商品 recommendation prices. The
// order-summary scoper must drop the recommendation tail so 小計 is selected,
// and readCheckoutSummary must source that 小計 (not a recommendation price).

describe("Defect B — scoped order-summary total vs recommendation noise", () => {
  it("strips the related-products tail before parsing", () => {
    const raw =
      "カート\n商品A 1,000円\n商品B 1,803円\n小計 2,803円\n送料 送料無料\n\n" +
      "ショップ内の関連商品\nおすすめA 1,980円\n関連商品B 合計 1,980円\nおすすめC 2,480円";
    const scoped = scopedOrderSummaryText(raw);
    expect(scoped).not.toContain("関連商品");
    expect(scoped).toContain("小計 2,803円");
    expect(scoped).toContain("送料 送料無料");
  });

  it("keeps a checkout with no recommendations unchanged", () => {
    const clean = "小計 3,872 円\n送料 送料無料";
    expect(scopedOrderSummaryText(clean)).toBe(clean);
  });

  it("strips a counted related-products heading", () => {
    expect(scopedOrderSummaryText("小計 2,803円\n送料 送料無料\n関連商品（3）\n商品 9,999円")).toBe(
      "小計 2,803円\n送料 送料無料",
    );
  });

  it("does not truncate on an おすすめ word inside a long product sentence", () => {
    const line =
      "この商品はおすすめですのでぜひ合わせてお買い求めください。内容量はたっぷりあります";
    expect(scopedOrderSummaryText(`${line}\n小計 2,803円`)).toContain("小計 2,803円");
  });

  it("does not truncate on a real cart item whose name merely starts with 関連商品 and has a price", () => {
    // A cart item line "関連商品セット 1,000円" carries a price, so it is never
    // mistaken for the recommendation section heading.
    const cart = "関連商品セット 1,000円\n小計 2,803円\n送料 送料無料";
    expect(scopedOrderSummaryText(cart)).toBe(cart);
  });

  it.each(["おすすめ商品ギフトセット", "関連商品セット"])(
    "does not truncate a digit-free cart item title: %s",
    (title) => {
      const cart = `${title}\n1,000円\n小計 2,803円\n送料 送料無料`;
      expect(scopedOrderSummaryText(cart)).toBe(cart);
    },
  );

  it("sources the cart's 小計 (payable) from a Rakuten-style split cart amid recommendation prices", async () => {
    const browser = new BrowserController({ humanize: false });
    const noise =
      "カート\n商品A 1,000円\n商品B 1,803円\n小計 2,803円\n送料 送料無料\n\n" +
      "ショップ内の関連商品\nおすすめA 合計 1,980円\nおすすめB 2,480円";
    const frame = { evaluate: vi.fn().mockResolvedValue(noise) };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Rakuten Cart", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => "https://cart.step.rakuten.co.jp/cart",
    };
    Object.defineProperty(browser, "page", { value: page });

    // Without the scoper the reader would pick the recommendation 合計 1,980円;
    // with it, it sources the cart's 小計 2,803円.
    await expect(browser.readCheckoutSummary("JPY")).resolves.toMatchObject({
      amount_cents: 2_803,
      currency: "JPY",
      checkout_origin: "https://cart.step.rakuten.co.jp",
    });
  });

  it("refuses a subtotal when shipping is not free", async () => {
    const browser = new BrowserController({ humanize: false });
    const frame = { evaluate: vi.fn().mockResolvedValue("小計 2,803円\n送料 500円") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Rakuten Cart", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => "https://cart.step.rakuten.co.jp/cart",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutSummary("JPY")).rejects.toThrow(
      "payment_checkout_total_not_found",
    );
  });

  it("does not treat a free-shipping subtotal as the final confirmation total", async () => {
    const browser = new BrowserController({ humanize: false });
    const frame = { evaluate: vi.fn().mockResolvedValue("小計 2,803円\n送料 送料無料") };
    const page = {
      evaluate: vi.fn().mockResolvedValue({ title: "Rakuten Confirm", siteName: "" }),
      mainFrame: () => frame,
      frames: () => [frame],
      url: () => "https://cart.step.rakuten.co.jp/confirm",
    };
    Object.defineProperty(browser, "page", { value: page });

    await expect(browser.readCheckoutConfirmSummary()).rejects.toThrow(
      "payment_checkout_total_not_found",
    );
  });
});

// ── Defect C ────────────────────────────────────────────────────────────────
// Fillable hosted card fields take precedence over express wallets, including
// fields that mount during the existing bounded readiness wait.

describe("Defect C — PayPal guard keys off the actual card-field frame", () => {
  it("recognizes Shopify PCI card-field frames as fillable", () => {
    expect(
      recognizedPaymentProviderFrame(
        "https://checkout.pci.shopifyinc.com/card-fields",
        "https://acme.myshopify.com/checkout",
      ),
    ).toBe(true);
  });

  const cardFrame = (url: string, body = '<input autocomplete="cc-number">', name = "") => ({
    url,
    body,
    name,
  });

  it.each([
    {
      name: "does NOT refuse Shopify PCI beside a PayPal express button",
      frames: [
        cardFrame("https://checkout.pci.shopifyinc.com/card-fields"),
        cardFrame("https://www.paypal.com/smart/buttons", "<button>PayPal</button>"),
      ],
      refused: false,
    },
    {
      name: "still refuses a genuine PayPal wallet-host card surface",
      frames: [cardFrame("https://www.paypal.com/card-fields")],
      refused: true,
    },
    {
      name: "accepts Braintree hosted card fields identified by frame name",
      frames: [
        cardFrame(
          "https://assets.braintreegateway.com/card-fields",
          '<input id="opaque-input">',
          "braintree-hosted-field-number",
        ),
      ],
      refused: false,
    },
    {
      name: "accepts Stripe Elements card fields",
      frames: [cardFrame("https://js.stripe.com/card-fields", '<input name="cardnumber">')],
      refused: false,
    },
    {
      name: "refuses a wallet-only checkout after the card readiness wait",
      frames: [cardFrame("https://www.paypal.com/smart/buttons", "<button>PayPal</button>")],
      refused: true,
    },
    {
      name: "reports false when neither a card nor a wallet is present",
      frames: [],
      refused: false,
    },
  ])(
    "$name",
    async ({ frames, refused }) => {
      const engine = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      try {
        const page = await engine.newPage();
        await page.route("**/*", async (route) => {
          const frame = frames.find((candidate) => candidate.url === route.request().url());
          await route.fulfill({
            contentType: "text/html",
            body:
              frame?.body ??
              frames
                .map(
                  (candidate) =>
                    `<iframe name="${candidate.name}" src="${candidate.url}"></iframe>`,
                )
                .join(""),
          });
        });
        await page.goto("https://acme.myshopify.com/checkout");
        const browser = new BrowserController({ humanize: false });
        Object.defineProperty(browser, "page", { value: page });
        await expect(browser.isPayPalHostedCheckout()).resolves.toBe(refused);
      } finally {
        await engine.close();
      }
    },
    20_000,
  );
});
