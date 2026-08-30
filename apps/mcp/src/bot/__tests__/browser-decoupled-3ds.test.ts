// Reproduction + regression coverage for the live Hibiya Kadan (EbisuMart)
// decoupled/out-of-band 3-D Secure hang: the cardholder approved the ACS's
// OOB push in ~2 seconds, yet the operator browser sat on the ACS CReq page
// indefinitely — well inside the wait budget already in place, so the hang
// was never a wait-duration problem (see the file-level comment on
// THREE_DS_ACS_NETWORK_HOSTS in browser.ts for the full root-cause writeup).
//
// A real checkout session installs a fail-closed request-scope guard
// (installHostScopeGuard / requestHostInScope) that aborts XHR/fetch calls
// to hosts outside the session's allowlist. The ACS's own decoupled-approval
// status poll is exactly such a call, and cardinalcommerce.com — a host our
// OWN detectThreeDsChallenge already treats as a legitimate 3DS authority —
// was never in that allowlist. So the ACS page's client-side JS could never
// learn the issuer had already approved, and never redirected or
// auto-submitted its CRes, no matter how long waitForThreeDsResolution kept
// watching.
//
// This fixture reproduces the exact topology with a local mock ACS (no real
// network, no real charge): a merchant page that, on submit, either
// navigates the TOP-LEVEL page to the ACS host or attaches it as a
// cross-origin iframe; the mock ACS polls its own backend for approval
// status via fetch, and — once it sees approval, at t+2s — either redirects
// (top-level topology) or auto-submits a `target="_top"` form (the real
// EMV 3DS2 CRes mechanic, iframe topology) back to the merchant's
// order-confirmation route. Both topologies are wired through the SAME
// request-scope guard production sessions install, with the SAME kind of
// merchant-only allowlist a real session would have (no ACS host — the
// exact gap the fix closes).
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController, requestHostInScope, isFailFastScopeAbort } from "../browser.js";

// See browser-payment.test.ts's identical guard: the lean mcp-only
// publish-verify install has no Playwright Chromium binary.
let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

let sharedBrowser: Browser | undefined;

beforeAll(async () => {
  if (chromiumAvailable) sharedBrowser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await sharedBrowser?.close();
});

const MERCHANT_ORIGIN = "https://checkout.hibiyakadan.test";
const ACS_ORIGIN = "https://authentication.cardinalcommerce.com";
const ACS_CHALLENGE_URL = `${ACS_ORIGIN}/v1/cruise/stepup`;
const ACS_STATUS_URL = `${ACS_ORIGIN}/api/decoupled-status`;
const RECEIPT_URL = `${MERCHANT_ORIGIN}/receipt/456`;

// The session's real, merchant-only allowlist — precisely what a live
// operate_start on this checkout would have. No 3DS/ACS host is ever a
// `start`-declared or sibling-domain host, which is the whole gap.
const SESSION_ALLOWED_HOSTS = ["checkout.hibiyakadan.test"];

const ACS_POLL_SCRIPT = (onApproved: string): string => `
  <p>Verifying your payment authorization&hellip;</p>
  <script>
    setTimeout(() => {
      fetch(${JSON.stringify(ACS_STATUS_URL)})
        .then((r) => r.json())
        .then((status) => { if (status.approved) { ${onApproved} } })
        .catch(() => {});
    }, 2000);
  </script>`;

const TOP_LEVEL_MERCHANT_PAGE = `
  <button id="pay">Pay now</button>
  <script>
    // Async, like a real "submit -> server responds with a 3DS redirect" round
    // trip — a same-tick synchronous navigation from inside the click handler
    // races Playwright's own click-actionability wait, which is a harness
    // quirk, not anything the production code under test needs to handle.
    document.querySelector("#pay").addEventListener("click", () => {
      setTimeout(() => { location.href = ${JSON.stringify(ACS_CHALLENGE_URL)}; }, 50);
    });
  </script>`;

const TOP_LEVEL_ACS_PAGE = ACS_POLL_SCRIPT(`location.href = ${JSON.stringify(RECEIPT_URL)};`);

const IFRAME_MERCHANT_PAGE = `
  <button id="pay">Pay now</button>
  <script>
    document.querySelector("#pay").addEventListener("click", () => {
      const frame = document.createElement("iframe");
      frame.title = "3D Secure authentication";
      frame.src = ${JSON.stringify(ACS_CHALLENGE_URL)};
      document.body.append(frame);
    });
  </script>`;

// The real EMV 3DS2 CRes mechanic: a hidden form auto-submitted with
// target="_top" so a cross-origin challenge iframe can break out and
// navigate the WHOLE top-level page back to the merchant's return URL.
const IFRAME_ACS_PAGE = `
  <form id="cres-form" method="POST" action=${JSON.stringify(RECEIPT_URL)} target="_top"></form>
  ${ACS_POLL_SCRIPT('document.getElementById("cres-form").submit();')}`;

async function serveFixture(pages: Record<string, string>): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  if (sharedBrowser === undefined) throw new Error("Chromium test browser was not started");
  const context = await sharedBrowser.newContext();
  // Content-serving route, registered BEFORE the guard below — Playwright
  // runs same-scope (context) routes LIFO, so the guard (installed after,
  // via setHostScopeAllowedHosts) is checked FIRST on every request, exactly
  // like production: the guard gatekeeps before anything is ever served.
  await context.route("**/*", async (route) => {
    const url = route.request().url().split("?")[0] ?? route.request().url();
    if (url === ACS_STATUS_URL) {
      return route.fulfill({ contentType: "application/json", body: '{"approved": true}' });
    }
    const body = pages[url];
    if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ contentType: "text/html", body });
  });
  const page = await context.newPage();
  return { context, page };
}

describe("decoupled 3-D Secure — Hibiya Kadan/EbisuMart hang reproduction + fix", () => {
  it.skipIf(!chromiumAvailable)(
    "resolves a top-level decoupled challenge approved at t+2s, with only the merchant host allowed",
    async () => {
      const { context, page } = await serveFixture({
        [`${MERCHANT_ORIGIN}/checkout`]: TOP_LEVEL_MERCHANT_PAGE,
        [ACS_CHALLENGE_URL]: TOP_LEVEL_ACS_PAGE,
        [RECEIPT_URL]: "<p>Thank you for your order.</p>",
      });
      try {
        await page.goto(`${MERCHANT_ORIGIN}/checkout`);
        const controller = BrowserController.fromHarnessPage(page);
        await controller.setHostScopeAllowedHosts(
          () => SESSION_ALLOWED_HOSTS,
          () => SESSION_ALLOWED_HOSTS,
        );
        // submitFilledCheckout (not a raw page.click) so the outcome baseline is
        // captured the same way production does — at click-dispatch time, while
        // still on the merchant page, before the pay click's own navigation can
        // race it.
        await expect(controller.submitFilledCheckout()).resolves.toMatchObject({
          three_ds_required: true,
          order_confirmed: false,
        });

        await expect(controller.waitForThreeDsResolution(15_000)).resolves.toBe("succeeded");
        expect(new URL(page.url()).origin).toBe(MERCHANT_ORIGIN);
      } finally {
        await context.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable)(
    "resolves an iframe-embedded decoupled challenge that CRes-auto-submits target=_top at t+2s",
    async () => {
      const { context, page } = await serveFixture({
        [`${MERCHANT_ORIGIN}/checkout`]: IFRAME_MERCHANT_PAGE,
        [ACS_CHALLENGE_URL]: IFRAME_ACS_PAGE,
        [RECEIPT_URL]: "<p>Thank you for your order.</p>",
      });
      try {
        await page.goto(`${MERCHANT_ORIGIN}/checkout`);
        const controller = BrowserController.fromHarnessPage(page);
        await controller.setHostScopeAllowedHosts(
          () => SESSION_ALLOWED_HOSTS,
          () => SESSION_ALLOWED_HOSTS,
        );
        await expect(controller.submitFilledCheckout()).resolves.toMatchObject({
          three_ds_required: true,
          order_confirmed: false,
        });

        await expect(controller.waitForThreeDsResolution(15_000)).resolves.toBe("succeeded");
        expect(page.url()).toBe(RECEIPT_URL);
      } finally {
        await context.close();
      }
    },
    20_000,
  );
});

describe("requestHostInScope / isFailFastScopeAbort — 3DS ACS network allowlist (unit)", () => {
  it("allows cardinalcommerce.com XHR/fetch even when it is not a session-configured host", () => {
    expect(requestHostInScope(ACS_STATUS_URL, SESSION_ALLOWED_HOSTS)).toBe(true);
    expect(isFailFastScopeAbort(ACS_STATUS_URL, "fetch", SESSION_ALLOWED_HOSTS)).toBe(false);
    expect(isFailFastScopeAbort(ACS_STATUS_URL, "xhr", SESSION_ALLOWED_HOSTS)).toBe(false);
  });

  it("still fail-fast-blocks an unrelated out-of-scope host", () => {
    const rogue = "https://exfil.evil.test/collect";
    expect(requestHostInScope(rogue, SESSION_ALLOWED_HOSTS)).toBe(false);
    expect(isFailFastScopeAbort(rogue, "fetch", SESSION_ALLOWED_HOSTS)).toBe(true);
  });
});

describe("operation-scoped host allowances", () => {
  it.skipIf(!chromiumAvailable)(
    "allows Gmail only while the sanctioned inbox operation is active",
    async () => {
      const mailUrl = "https://mail.google.com/api/messages";
      const { context, page } = await serveFixture({
        [`${MERCHANT_ORIGIN}/checkout`]: "<main>Checkout</main>",
        [mailUrl]: "mail",
      });
      try {
        await page.goto(`${MERCHANT_ORIGIN}/checkout`);
        const controller = BrowserController.fromHarnessPage(page);
        await controller.setHostScopeAllowedHosts(
          () => SESSION_ALLOWED_HOSTS,
          () => SESSION_ALLOWED_HOSTS,
        );

        await expect(
          controller.withTemporaryHostScopeAllowedHosts(["mail.google.com"], async () =>
            await page.evaluate(async (url) => await (await fetch(url)).text(), mailUrl),
          ),
        ).resolves.toBe("mail");

        await expect(
          page.evaluate(async (url) => await (await fetch(url)).text(), mailUrl),
        ).rejects.toThrow();
      } finally {
        await context.close();
      }
    },
  );
});
