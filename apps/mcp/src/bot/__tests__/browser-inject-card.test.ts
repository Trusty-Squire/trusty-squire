import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController, type CheckoutCard, type InteractiveElement } from "../browser.js";
import { serializeBrowserUseDOM } from "../browser-use-serializer.js";
import {
  finishProvisionSession,
  observe,
  observeQuery,
  observeSubtree,
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

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}
let browser: Browser | undefined;
beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true });
});
afterAll(async () => await browser?.close());

async function page(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function byName(elements: InteractiveElement[], name: string): InteractiveElement {
  const element = elements.find((candidate) => candidate.name === name);
  if (element === undefined) throw new Error(`missing ${name}`);
  return element;
}

describe("direct card injection and masked observation", () => {
  it.skipIf(!available)(
    "fills only named main/open-shadow/cross-origin nodes and masks every normal read",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = "https://merchant.test/checkout";
        const frameUrl = "https://assets.braintreegateway.test/hosted";
        await isolated.page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === topUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: `<input name="number"><div id="host"></div><iframe src="${frameUrl}"></iframe>
                <div>Total 123 JPY</div><div>3-D Secure authentication</div>
                <script>const root=document.querySelector('#host').attachShadow({mode:'open'});const input=document.createElement('input');input.name='cardholder';root.append(input)</script>`,
            });
          }
          if (url === frameUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: '<input name="cvv"><select name="month"><option value="12">12</option></select><input name="year">',
            });
          }
          if (url === "https://merchant.test/decline") {
            return route.fulfill({
              status: 401,
              contentType: "application/json",
              body: `{"card":"${CARD.pan}","cvc":"${CARD.cvv}","status":401}`,
            });
          }
          return route.fulfill({ status: 404, body: "not found" });
        });
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "full",
          observationFormat: "browser-use-dom",
        });
        sessionId = started.session_id;
        const elements = await controller.extractInteractiveElements();
        const results = await controller.injectCardIntoTargets(CARD, {
          pan: { element: byName(elements, "number") },
          cvv: { element: byName(elements, "cvv") },
          exp_month: { element: byName(elements, "month") },
          exp_year: { element: byName(elements, "year"), format: "two_digit" },
          name: { element: byName(elements, "cardholder") },
        });
        expect(results).toMatchObject({
          pan: { status: "filled" },
          cvv: { status: "filled" },
          exp_month: { status: "filled" },
          exp_year: { status: "filled" },
          name: { status: "filled" },
          exp: { status: "not_found" },
        });

        // Internal verification of writes; these values are never returned by a tool.
        expect(await isolated.page.locator('[name="number"]').inputValue()).toBe(CARD.pan);
        expect(
          await isolated.page
            .locator("#host")
            .evaluate(
              (host) => (host.shadowRoot!.querySelector("input") as HTMLInputElement).value,
            ),
        ).toBe(CARD.name);
        const frame = isolated.page.frames().find((candidate) => candidate.url() === frameUrl)!;
        expect(await frame.locator('[name="cvv"]').inputValue()).toBe(CARD.cvv);

        await isolated.page.evaluate((card) => {
          const mirror = document.createElement("div");
          mirror.textContent = `Card ${card.pan}; CVV ${card.cvv}`;
          document.body.append(mirror);
          console.error(`declined card ${card.pan} security code ${card.cvv}`);
        }, CARD);
        await isolated.page.evaluate(async (card) => {
          await fetch("https://merchant.test/decline", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "api-visible" },
            body: JSON.stringify({ card_number: card.pan, cvv: card.cvv }),
          }).catch(() => undefined);
        }, CARD);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const capture = await controller.extractBrowserUseObservation();
        const dom = serializeBrowserUseDOM(capture.root).dom;
        const visible = await controller.extractVisibleText();
        const evidence = controller.readOperatorEvidence();
        const full = await observe(sessionId, "full");
        const compact = await observe(sessionId, "compact");
        const query = await observeQuery(sessionId, "number");
        const subtreeRef = (query.safe_table as unknown[][] | undefined)?.[0]?.[0];
        if (typeof subtreeRef !== "string") throw new Error("missing subtree ref");
        const subtree = await observeSubtree(sessionId, subtreeRef, true);
        for (const output of [
          dom,
          visible,
          JSON.stringify(evidence),
          JSON.stringify(full),
          JSON.stringify(compact),
          JSON.stringify(query),
          JSON.stringify(subtree),
        ]) {
          expect(output).not.toContain(CARD.pan);
          expect(output).not.toMatch(/(?:CVV|security code|\"cvv\"|\"cvc\")[^\n]{0,20}123/i);
        }
        expect(dom).toContain("[card number]");
        expect(dom).toContain("[security code]");
        expect(visible).toContain("Total 123 JPY");
        expect(visible).toContain("3-D Secure authentication");
        expect(JSON.stringify(evidence)).toContain("401");
        expect(JSON.stringify(evidence)).toContain("api-visible");
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );
});
