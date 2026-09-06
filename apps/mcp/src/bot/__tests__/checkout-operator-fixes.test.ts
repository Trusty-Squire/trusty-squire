import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, type Browser, type BrowserContext } from "playwright";
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
let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

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

  it("does not derive sibling scope from a mid-session declared host", () => {
    const allowedHosts = [...RAKUTEN_CHECKOUT_HOSTS, "api.partner.example"];
    expect(
      requestHostInScope("https://api.partner.example/data", allowedHosts, RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(true);
    expect(
      requestHostInScope(
        "https://vault.partner.example/secrets",
        allowedHosts,
        RAKUTEN_CHECKOUT_HOSTS,
      ),
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

  it("does not allow a third-party host through path or query marker spoofing", () => {
    expect(
      requestHostInScope("https://tracker.example/api/recaptcha", RAKUTEN_CHECKOUT_HOSTS),
    ).toBe(false);
    expect(
      requestHostInScope(
        "https://tracker.example/api?next=gstatic.com/recaptcha",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(false);
    expect(
      requestHostInScope(
        "https://www.gstatic.com/recaptcha/releases/widget.js",
        RAKUTEN_CHECKOUT_HOSTS,
      ),
    ).toBe(true);
    expect(requestHostInScope("https://www.gstatic.com/merchant-api", RAKUTEN_CHECKOUT_HOSTS)).toBe(
      false,
    );
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

  it.skipIf(!chromiumAvailable)(
    "makes an actual blocked fetch reject promptly before network egress",
    async () => {
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end("reachable");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let playwrightBrowser: Browser | null = null;
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing test server");
        playwrightBrowser = await chromium.launch({ headless: true });
        const context = await playwrightBrowser.newContext();
        const controller = new BrowserController({ humanize: false });
        (controller as unknown as { context: BrowserContext }).context = context;
        await controller.setHostScopeAllowedHosts(() => RAKUTEN_CHECKOUT_HOSTS);
        const page = await context.newPage();
        await page.setContent("<title>scope guard</title>");
        const outcome = await page.evaluate(async (url) => {
          return await Promise.race([
            fetch(url).then(
              () => "resolved",
              () => "rejected",
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
          ]);
        }, `http://127.0.0.1:${address.port}/blocked`);
        expect(outcome).toBe("rejected");
        expect(requestCount).toBe(0);
      } finally {
        try {
          await playwrightBrowser?.close();
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          );
        }
      }
    },
  );

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
