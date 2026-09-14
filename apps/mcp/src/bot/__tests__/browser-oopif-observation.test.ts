// Real-Chromium regression for OUT-OF-PROCESS (site-isolated) iframe
// observation. Hosted card fields (Shopify's
// checkout.pci.shopifyinc.com card inputs) live in a cross-SITE iframe, so
// Chromium site-isolates them into a separate renderer process. CDP's
// Page.getFrameTree on the page session does not list that child, so a frame
// walk built only on the top session silently drops it.
//
// #772's "cross-origin" regression served the child from a second localhost
// PORT — same site, same process — so it passed while real OOPIFs were still
// dropped. This file maps two DIFFERENT registrable domains to loopback over a
// real local HTTP server, asserts the child really is a separate CDP target
// first, and only then trusts the observation.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { injectCardTool } from "../../tools/inject-card.js";
import { operateTypeTool } from "../../tools/provision-drive.js";
import { BrowserController, type CheckoutCard } from "../browser.js";
import {
  finishProvisionSession,
  observe,
  paymentSession,
  startHarnessProvisionSession,
} from "../provision-session.js";

const CARD: CheckoutCard = {
  pan: "4111111111111111",
  cvv: "123",
  exp_month: "12",
  exp_year: "2030",
  name: "Synthetic Buyer",
  billing: {
    line1: "1 Test Street",
    city: "Testville",
    postal_code: "10000",
    country: "US",
  },
};

const PARENT_HOST = "example.com";
const CHILD_HOST = "example.org";
const CHILD_PATH = "/build/number-ltr.html";

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let server: Server;
let port: number;
let browser: Browser | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const host = (req.headers.host ?? "").split(":")[0];
    if (host === PARENT_HOST) {
      res.end(
        '<!doctype html><html><body><main>Checkout</main>' +
          `<iframe name="card-fields-number" src="http://${CHILD_HOST}:${port}${CHILD_PATH}" ` +
          'style="width:320px;height:200px;border:0"></iframe>' +
          "</body></html>",
      );
    } else if (host === CHILD_HOST) {
      res.end(
        "<!doctype html><html><body>" +
          '<input name="number" aria-label="Card number" placeholder="Card number">' +
          '<input name="expiry" aria-label="Expiry">' +
          '<input name="verification_value" aria-label="Security code">' +
          '<input name="cardholder" aria-label="Name on card">' +
          "</body></html>",
      );
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  if (available) {
    browser = await chromium.launch({
      headless: true,
      // Playwright's bundled Chromium does not site-isolate cross-site frames by
      // default; production Chrome does. Force it so the child frame is a real
      // OOPIF, and assert that below so this test cannot silently regress to a
      // same-process frame (which is how #772 passed while OOPIFs were still
      // dropped).
      args: [
        "--site-per-process",
        `--host-resolver-rules=MAP ${PARENT_HOST} 127.0.0.1,MAP ${CHILD_HOST} 127.0.0.1`,
      ],
    });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function page(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** The child frame's own CDP target exists — i.e. it really is an OOPIF. */
async function childIsSeparateTarget(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const client = await page.context().newCDPSession(page);
    try {
      const targets = await client.send("Target.getTargets");
      if (targets.targetInfos.some((target) => target.type === "iframe" && target.url.includes(CHILD_HOST)))
        return true;
    } finally {
      await client.detach().catch(() => undefined);
    }
    await page.waitForTimeout(100);
  }
  return false;
}

function textboxRow(
  rows: Array<[string, string, string?]>,
  label: string,
): [string, string, string?] {
  const row = rows.find(
    (candidate) => candidate[1] === "t" && (candidate[2] ?? "").includes(`@${label}`),
  );
  if (row === undefined) throw new Error(`compact map is missing textbox ${label}`);
  return row;
}

describe("out-of-process iframe observation (real Chromium, real HTTP)", () => {
  it.skipIf(!available)(
    "lists a site-isolated card frame's inputs in the COMPACT map and fills them by ref",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = `http://${PARENT_HOST}:${port}/checkout`;
        const childUrl = `http://${CHILD_HOST}:${port}${CHILD_PATH}`;
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;

        // Precondition: this is genuinely an OOPIF, not a same-process frame.
        expect(await childIsSeparateTarget(isolated.page)).toBe(true);

        const compact = (await observe(sessionId, "compact")) as unknown as Record<string, unknown>;
        const rows = compact.safe_table as Array<[string, string, string?]>;
        const numberRow = textboxRow(rows, "card-number");
        const expiryRow = textboxRow(rows, "expiry");
        const cvvRow = textboxRow(rows, "security-code");
        const nameRow = textboxRow(rows, "name-on-card");
        for (const row of [numberRow, expiryRow, cvvRow, nameRow])
          expect(row[2] ?? "").toContain("x=x");

        const frame = isolated.page.frames().find((candidate) => candidate.url() === childUrl)!;
        expect(frame).toBeDefined();

        // A frame whose capture succeeded produces no silent omission.
        expect(compact.capture_omissions ?? []).toEqual([]);
        // operate_type resolves the compact ref inside the OOPIF.
        await operateTypeTool.handler(
          { session_id: sessionId, ref: expiryRow[0], text: "12/30" },
          null,
        );
        expect(await frame.locator('[name="expiry"]').inputValue()).toBe("12/30");

        // inject_card fills pan/cvv/name from COMPACT refs, not el_table.
        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_oopif",
          approvalUrl: "https://approve.test/approval_oopif",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: `http://${PARENT_HOST}:${port}`,
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const result = await injectCardTool.handler(
          injectCardTool.inputSchema.parse({
            session_id: sessionId,
            merchant: "Synthetic Merchant",
            amount_cents: 123,
            currency: "JPY",
            item: "Synthetic item",
            reason: "Synthetic test purchase",
            card_ref: "card_synthetic",
            approval_id: "approval_oopif",
            fields: {
              pan: { ref: numberRow[0] },
              cvv: { ref: cvvRow[0] },
              exp_month: { ref: expiryRow[0] },
              name: { ref: nameRow[0] },
            },
          }),
          {} as ApiClient,
        );
        expect(result).toMatchObject({
          status: "card_injected",
          fields: {
            pan: { status: "filled" },
            cvv: { status: "filled" },
            exp_month: { status: "filled" },
            name: { status: "filled" },
          },
        });
        expect(await frame.locator('[name="number"]').inputValue()).toBe(CARD.pan);
        expect(await frame.locator('[name="verification_value"]').inputValue()).toBe(CARD.cvv);
        expect(await frame.locator('[name="cardholder"]').inputValue()).toBe(CARD.name);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    60000,
  );

  it.skipIf(!available)(
    "records a frame_attach_failed omission when an OOPIF cannot be attached — never a silent zero",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = `http://${PARENT_HOST}:${port}/checkout`;
        const childUrl = `http://${CHILD_HOST}:${port}${CHILD_PATH}`;
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;
        expect(await childIsSeparateTarget(isolated.page)).toBe(true);

        // Simulate a frame whose capture genuinely fails: every CDP attach for
        // the OOPIF raises, as it does mid-navigation or on a torn-down target.
        const context = isolated.page.context();
        const realNewCDPSession = context.newCDPSession.bind(context);
        const urlOf = (target: Page | Frame): string =>
          typeof (target as Frame).url === "function"
            ? (target as Frame).url()
            : (target as Page).url();
        (context as { newCDPSession: typeof context.newCDPSession }).newCDPSession = async (
          target,
        ) => {
          if (urlOf(target as Page | Frame) === childUrl)
            throw new Error("simulated OOPIF attach failure");
          return realNewCDPSession(target);
        };

        const observed = (await observe(sessionId, "compact")) as unknown as Record<string, unknown>;
        const omissions = (observed.capture_omissions ?? []) as Array<{
          kind: string;
          url: string;
        }>;
        expect(omissions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "frame_attach_failed", url: childUrl }),
          ]),
        );
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    60000,
  );
});