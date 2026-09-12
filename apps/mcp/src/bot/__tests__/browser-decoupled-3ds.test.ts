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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BrowserController,
  requestHostInScope,
  isFailFastScopeAbort,
  recognizedPaymentProviderFrame,
} from "../browser.js";

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
          controller.withTemporaryHostScopeAllowedHosts(
            ["mail.google.com"],
            async () =>
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

describe("payment-window browser networking", () => {
  it.skipIf(!chromiumAvailable).each(["single", "split"] as const)(
    "natively advances a %s checkout through EMV-TDS, method, fingerprint, challenge and receipt",
    async (phase) => {
      const method = "https://methodurl.vcas.visa.com/method/status";
      const fingerprint = "https://h.online-metrix.net/fp/status";
      const checkout = `${MERCHANT_ORIGIN}/checkout`;
      const emvTds = "https://emvtds.sps-system.com/emvtds-fe/status";
      const { context, page } = await serveFixture({
        [checkout]: `<meta charset="utf-8"><h1>Synthetic card checkout</h1>
          <p>Test fixture only — no real payment. Total: ¥6,600</p>
          <form id="checkout"><label>Card number <input autocomplete="cc-number"></label>
          <label>Expiry <input autocomplete="cc-exp"></label>
          <label>Cardholder <input autocomplete="cc-name"></label>
          <label>セキュリティコード <input id="securityCode" type="tel" maxlength="4"></label>
          <button>Pay now</button></form><script>
          document.querySelector('form').onsubmit = async (event) => {
            event.preventDefault();
            if (!document.querySelector('#securityCode').value) return;
            await fetch(${JSON.stringify(emvTds)});
            await fetch(${JSON.stringify(method)});
            await fetch(${JSON.stringify(fingerprint)});
            location.href = ${JSON.stringify(ACS_CHALLENGE_URL)};
          };</script>`,
        [emvTds]: "emv-tds complete",
        [method]: "method complete",
        [fingerprint]: "fingerprint complete",
        [ACS_CHALLENGE_URL]: `<meta charset="utf-8"><h1>3D Secure authentication</h1>
          <p>Synthetic issuer challenge — no real payment</p>
          <p>Confirm this test purchase in your banking app.</p>
          <button onclick='location.href=${JSON.stringify(RECEIPT_URL)}'>Simulate cardholder confirmation</button>`,
        [RECEIPT_URL]:
          '<meta charset="utf-8"><h1>Thank you for your order.</h1><p>Receipt number: SYNTHETIC-456</p><p>Synthetic fixture only — no charge.</p>',
      });
      const responses: { url: string; status: number }[] = [];
      page.on("response", (response) => {
        responses.push({ url: response.url(), status: response.status() });
      });
      const evidence = process.env.PAYMENT_TEST_EVIDENCE_DIR
        ? join(process.env.PAYMENT_TEST_EVIDENCE_DIR, phase)
        : undefined;
      try {
        await page.goto(checkout);
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, "synthetic-checkout.png") });
        }
        const controller = BrowserController.fromHarnessPage(page);
        await controller.setHostScopeAllowedHosts(() => SESSION_ALLOWED_HOSTS);
        const card = {
          pan: "4242424242424242",
          exp_month: "12",
          exp_year: "30",
          cvv: "123",
          name: "Synthetic Cardholder",
          billing: { line1: "1 Test Street", city: "Test", postal_code: "10001", country: "US" },
        };
        let submission;
        if (phase === "single") {
          submission = await controller.fillAndSubmitCheckout(card);
          expect(submission).toMatchObject({ three_ds_required: true, order_confirmed: false });
        } else {
          await controller.fillCheckoutCardFields(card);
          await page.getByRole("button", { name: "Pay now" }).click();
          await page.waitForURL(ACS_CHALLENGE_URL);
        }
        expect(page.url()).toBe(ACS_CHALLENGE_URL);
        expect(responses).toEqual(
          expect.arrayContaining([
            { url: emvTds, status: 200 },
            { url: method, status: 200 },
            { url: fingerprint, status: 200 },
          ]),
        );
        if (evidence) await page.screenshot({ path: join(evidence, "synthetic-challenge.png") });
        if (phase === "split") {
          await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("challenge_pending");
        }
        // This click represents the human's issuer interaction, not an operator workaround.
        await page.getByRole("button", { name: "Simulate cardholder confirmation" }).click();
        await page.waitForURL(RECEIPT_URL);
        const resolution = await controller.waitForThreeDsResolution(5_000);
        expect(resolution).toBe("succeeded");
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("succeeded");
        expect(page.url()).toBe(RECEIPT_URL);
        expect(controller.takeHostScopeDenials()).toEqual([]);
        if (evidence) {
          await page.screenshot({ path: join(evidence, "synthetic-receipt.png") });
          await writeFile(
            join(evidence, "synthetic-payment.json"),
            JSON.stringify(
              {
                scope:
                  "Synthetic BrowserController flow; no vault/approval service or real SBPS backend; no charge",
                submission,
                resolution,
                responses,
                receipt: await page.locator("body").innerText(),
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await context.close();
      }
    },
    20_000,
  );

  it.skipIf(!chromiumAvailable).each([false, true])(
    "admits issuer requests only within the payment page and window (broker=%s)",
    async (broker) => {
      const method = "https://methodurl.vcas.visa.com/method/status";
      const fingerprint = "https://h.online-metrix.net/fp/status";
      const issuer = "https://emvtds.sps-system.com/emvtds-fe/status";
      const { context, page } = await serveFixture({
        [`${MERCHANT_ORIGIN}/checkout`]: `<form><input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc"><input autocomplete="cc-name"></form>`,
        [method]: "method complete",
        [fingerprint]: "fingerprint complete",
        [issuer]: "issuer complete",
      });
      try {
        await page.goto(`${MERCHANT_ORIGIN}/checkout`);
        const controller = BrowserController.fromHarnessPage(page);
        if (broker) await controller.enableBrokerRouting();
        await controller.setHostScopeAllowedHosts(() => SESSION_ALLOWED_HOSTS);
        const read = (target: Page, url: string) =>
          target.evaluate(async (url) => {
            try {
              return await (await fetch(url)).text();
            } catch {
              return "blocked";
            }
          }, url);
        expect(await read(page, method)).toBe("blocked");
        controller.takeHostScopeDenials();
        await controller.fillCheckoutCardFields({
          pan: "4242424242424242",
          exp_month: "12",
          exp_year: "30",
          cvv: "123",
          name: "Synthetic Cardholder",
          billing: { line1: "1 Test Street", city: "Test", postal_code: "10001", country: "US" },
        });
        expect(await read(page, method)).toBe("method complete");
        expect(await read(page, fingerprint)).toBe("fingerprint complete");
        expect(await read(page, issuer)).toBe("issuer complete");
        expect(controller.takeHostScopeDenials()).toEqual([]);
        expect(recognizedPaymentProviderFrame(issuer, page.url())).toBe(false);
        expect(recognizedPaymentProviderFrame(method, page.url())).toBe(false);
        await page.evaluate((url) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          document.body.append(frame);
        }, method);
        await expect
          .poll(() => page.frames().find((frame) => frame.url() === method))
          .toBeDefined();
        const methodFrame = page.frames().find((frame) => frame.url() === method)!;
        expect(
          await methodFrame.evaluate(async (url) => await (await fetch(url)).text(), fingerprint),
        ).toBe("fingerprint complete");
        const other = await context.newPage();
        await other.goto(`${MERCHANT_ORIGIN}/checkout`);
        expect(await read(other, issuer)).toBe("blocked");
        // An inconclusive status poll must retain the in-flight allowance.
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("timeout");
        expect(await read(page, issuer)).toBe("issuer complete");
        const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 21 * 60_000);
        try {
          expect(await read(page, issuer)).toBe("blocked");
        } finally {
          now.mockRestore();
        }
        // A terminal failure removes the allowance even before its deadline.
        await page.evaluate(() => {
          document.body.append("Authentication failed");
        });
        await expect(controller.waitForThreeDsResolution(0)).resolves.toBe("failed");
        expect(await read(page, issuer)).toBe("blocked");
      } finally {
        await context.close();
      }
    },
  );
});
