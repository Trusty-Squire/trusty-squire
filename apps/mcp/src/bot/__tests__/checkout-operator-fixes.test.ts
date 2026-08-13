import { BrowserController } from "../browser.js";
import {
  isFailFastScopeAbort,
  recognizedPaymentProviderFrame,
  requestHostInScope,
  scopedOrderSummaryText,
} from "../browser.js";
import { describe, expect, it, vi } from "vitest";

// ── Defect A ────────────────────────────────────────────────────────────────
// A) same-registrable-domain merchant API siblings are in scope (reachable)
//    without hand-enumerating each subdomain; B) a genuinely out-of-scope
//    in-page XHR/fetch fails fast (abort/net-error) instead of hanging.

const RAKUTEN_CHECKOUT_HOSTS = ["cart.step.rakuten.co.jp"];

describe("Defect A — same-registrable-domain scope + fail-fast", () => {
  it("treats the checkout's own sibling API subdomain as in scope", () => {
    // cart-api.step.rakuten.co.jp shares the rakuten.co.jp registrable domain
    // with the trusted cart.step.rakuten.co.jp checkout host.
    expect(
      requestHostInScope("https://cart-api.step.rakuten.co.jp/cart/items", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(true);
  });

  it("auto-scopes any subdomain of the same registrable domain, not a listed host only", () => {
    expect(
      requestHostInScope("https://random-x.step.rakuten.co.jp/api", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(true);
  });

  it("does NOT broaden egress to a different registrable domain", () => {
    // gateway-api.global.rakuten.com is rakuten.com — a DIFFERENT registrable
    // domain from rakuten.co.jp — so it must NOT be auto-scoped.
    expect(
      requestHostInScope("https://gateway-api.global.rakuten.com/x", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(false);
    expect(
      requestHostInScope("https://tracker.third-party.example/b", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(false);
  });

  it("keeps auth + captcha/payment + recognized provider hosts reachable", () => {
    expect(
      requestHostInScope("https://www.google.com/recaptcha/api.js", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(true);
    expect(
      requestHostInScope(
        "https://payment.global.rakuten.com/hosted-fields",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(true);
  });

  it("a blocked/dropped out-of-scope XHR is flagged for a prompt abort — no hang", () => {
    // The load-bearing half: a dropped request that never resolves is the
    // wedge. An out-of-scope XHR/fetch must be aborted fast.
    expect(
      isFailFastScopeAbort(
        "https://tracker.third-party.example/beacon",
        "xhr",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(true);
  });

  it("never fails-fast-blocks an in-scope or same-registrable-domain API sibling", () => {
    expect(
      isFailFastScopeAbort(
        "https://cart-api.step.rakuten.co.jp/cart",
        "fetch",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(false);
  });

  it("never blocks page-load resource types (scripts/styles/images/frames)", () => {
    expect(
      isFailFastScopeAbort(
        "https://tracker.third-party.example/app.js",
        "script",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(false);
  });

  it("is inert when no session scope is set (harness/replay)", () => {
    expect(isFailFastScopeAbort("https://tracker.third-party.example/beacon", "xhr", null)).toBe(
      false,
    );
  });
});

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
});

// ── Defect C ────────────────────────────────────────────────────────────────
// operate_pay must refuse PayPal/Braintree-hosted card fields ONLY when the
// ACTUAL card field lives in one — a PayPal express button on an otherwise
// fillable Shopify-PCI checkout must not cause a false-positive refusal.

describe("Defect C — PayPal guard keys off the actual card-field frame", () => {
  it("recognizes Shopify PCI card-field frames as fillable", () => {
    expect(
      recognizedPaymentProviderFrame(
        "https://checkout.pci.shopifyinc.com/card-fields",
        "https://acme.myshopify.com/checkout",
      ),
    ).toBe(true);
  });

  const panFrame = (url: string, panFields = 1) => ({
    url: () => url,
    locator: () => ({
      count: async () => panFields,
      nth: () => ({ isVisible: async () => true, isEnabled: async () => true }),
    }),
  });

  const browserWith = (frames: Array<{ url: () => string; locator: () => unknown }>) => {
    const browser = new BrowserController({ humanize: false });
    const page = {
      frames: () => frames,
      url: () => "https://acme.myshopify.com/checkout",
    };
    Object.defineProperty(browser, "page", { value: page });
    return browser;
  };

  it("does NOT refuse a Shopify-PCI checkout that merely has a PayPal express button", async () => {
    const browser = browserWith([
      panFrame("https://acme.myshopify.com/checkout", 0),
      panFrame("https://checkout.pci.shopifyinc.com/card-fields", 1),
      panFrame("https://www.paypal.com/smart/buttons", 0),
    ]);
    await expect(browser.isPayPalHostedCheckout()).resolves.toBe(false);
  });

  it("still refuses when the card field itself is a genuine PayPal hosted-fields frame", async () => {
    const browser = browserWith([
      panFrame("https://www.paypal.com/vault/card-fields", 0),
      panFrame("https://www.paypal.com/card-fields", 1),
    ]);
    await expect(browser.isPayPalHostedCheckout()).resolves.toBe(true);
  });

  it("still refuses Braintree hosted fields", async () => {
    const browser = browserWith([panFrame("https://assets.braintreegateway.com/card-fields", 1)]);
    await expect(browser.isPayPalHostedCheckout()).resolves.toBe(true);
  });

  it("reports false when no card (PAN) field is present yet", async () => {
    const browser = browserWith([
      panFrame("https://acme.myshopify.com/checkout", 0),
      panFrame("https://www.paypal.com/smart/buttons", 0),
    ]);
    await expect(browser.isPayPalHostedCheckout()).resolves.toBe(false);
  });
});
