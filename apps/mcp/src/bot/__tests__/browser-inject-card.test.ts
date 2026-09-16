import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { injectCardTool } from "../../tools/inject-card.js";
import { operateTypeTool } from "../../tools/provision-drive.js";
import { BrowserController, type CheckoutCard, type InteractiveElement } from "../browser.js";
import { serializeBrowserUseDOM } from "../browser-use-serializer.js";
import {
  finishProvisionSession,
  observe,
  observeQuery,
  observeSubtree,
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
    "requires the same approval id before re-injecting a released card",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = "https://merchant.test/checkout";
        await isolated.page.route(topUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            // An explicit card-number signal so the compact map carries the
            // f=payment fact the PAN ref is picked from.
            body: '<input name="number" aria-label="Card number">',
          }),
        );
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
        });
        sessionId = started.session_id;
        const rows = started.safe_table as unknown as Array<[string, string, string?]>;
        const panRef = rows.find(([, , facts]) => facts?.includes("f=payment"))?.[0];
        if (panRef === undefined) throw new Error("missing public PAN field ref");
        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_same_purchase",
          approvalUrl: "https://approve.test/approval_same_purchase",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: "https://merchant.test",
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const input = {
          session_id: sessionId,
          merchant: "Synthetic Merchant",
          amount_cents: 123,
          currency: "JPY",
          item: "Synthetic item",
          reason: "Synthetic test purchase",
          card_ref: "card_synthetic",
          fields: { pan: { ref: panRef } },
        };
        const api = {} as ApiClient;

        await expect(
          injectCardTool.handler(injectCardTool.inputSchema.parse(input), api),
        ).rejects.toThrow("approval_id is required to retry this session's released purchase");
        await expect(
          injectCardTool.handler(
            injectCardTool.inputSchema.parse({ ...input, approval_id: "approval_other" }),
            api,
          ),
        ).rejects.toThrow("approval_id does not match this session's released purchase");
        await expect(
          injectCardTool.handler(
            injectCardTool.inputSchema.parse({
              ...input,
              approval_id: "approval_same_purchase",
            }),
            api,
          ),
        ).resolves.toMatchObject({
          status: "card_injected",
          approval_id: "approval_same_purchase",
          fields: { pan: { status: "filled" } },
        });
        expect(await isolated.page.locator('[name="number"]').inputValue()).toBe(CARD.pan);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );

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
              body: `{"card":"${CARD.pan}","card_code":"${CARD.cvv}","status":401}`,
            });
          }
          return route.fulfill({ status: 404, body: "not found" });
        });
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "full",
        });
        sessionId = started.session_id;
        const elements = await controller.extractInteractiveElements();
        const results = await controller.injectCardIntoTargets(CARD, {
          pan: { element: byName(elements, "number") },
          cvv: { element: byName(elements, "cvv") },
        });
        expect(results).toMatchObject({
          pan: { status: "filled" },
          cvv: { status: "filled" },
        });

        // Expiry and cardholder name are NOT secret and NOT inject_card
        // fields: the agent fills them with ordinary tools (here: direct page
        // writes standing in for operate_type/operate_select).
        await isolated.page
          .locator("#host")
          .evaluate((host) => {
            const input = host.shadowRoot!.querySelector("input") as HTMLInputElement;
            input.value = "Daeun Lee";
          });
        const frame = isolated.page.frames().find((candidate) => candidate.url() === frameUrl)!;
        await frame.locator('[name="year"]').fill("12/30");

        // Internal verification of writes; these values are never returned by a tool.
        expect(await isolated.page.locator('[name="number"]').inputValue()).toBe(CARD.pan);
        expect(
          await isolated.page
            .locator("#host")
            .evaluate(
              (host) => (host.shadowRoot!.querySelector("input") as HTMLInputElement).value,
            ),
        ).toBe("Daeun Lee");
        expect(await frame.locator('[name="cvv"]').inputValue()).toBe(CARD.cvv);

        await isolated.page.locator('[name="number"]').evaluate((node, card) => {
          node.outerHTML = `<input id="number-rerendered" name="card-number" value="${card.pan}">`;
        }, CARD);
        await frame.locator('[name="cvv"]').evaluate((node, card) => {
          node.outerHTML = `<input id="security-rerendered" name="cvv2" aria-label="Security code" value="${card.cvv}">`;
        }, CARD);
        expect(
          await isolated.page.locator("#number-rerendered").getAttribute("data-ts-card-mask"),
        ).toBeNull();
        expect(
          await frame.locator("#security-rerendered").getAttribute("data-ts-card-mask"),
        ).toBeNull();

        await isolated.page.evaluate((card) => {
          const mirror = document.createElement("div");
          mirror.textContent = `Card ${card.pan}; prefix ${card.pan.slice(0, 10)}; CVV ${card.cvv}`;
          document.body.append(mirror);
          console.error(`declined card ${card.pan} security code ${card.cvv}`);
        }, CARD);
        await isolated.page.evaluate(async (card) => {
          await fetch("https://merchant.test/decline", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "api-visible" },
            body: JSON.stringify({ card_number: card.pan, cvv2: card.cvv }),
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
          expect(output).not.toContain(CARD.pan.slice(0, 10));
          expect(output).not.toMatch(/(?:CVV|security code|\"cvv\"|\"cvc\")[^\n]{0,20}123/i);
        }
        expect(dom).toContain("[card number]");
        expect(dom).toContain("[security code]");
        expect(visible).toContain("Total 123 JPY");
        expect(visible).toContain("3-D Secure authentication");
        // Expiry and cardholder name stay fully visible — they are not secret.
        expect(dom).toContain("Daeun Lee");
        expect(dom).toContain("12/30");
        expect(JSON.stringify(evidence)).toContain("401");
        expect(JSON.stringify(evidence)).toContain("api-visible");
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    "lists cross-origin hosted fields in the COMPACT map with x=x and fills them by compact ref",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = "https://merchant.test/checkout";
        const frameUrl = "https://checkout.pci.shopifyinc.test/build/number-ltr.html";
        await isolated.page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === topUrl) {
            return route.fulfill({
              contentType: "text/html",
              body:
                '<main>Checkout</main><iframe name="card-fields-number" sandbox="allow-scripts" ' +
                `src="${frameUrl}" style="width:320px;height:200px;border:0"></iframe>`,
            });
          }
          if (url === frameUrl) {
            return route.fulfill({
              contentType: "text/html",
              body:
                '<input name="number" aria-label="Card number">' +
                '<input name="expiry" aria-label="Expiry">' +
                '<input name="verification_value" aria-label="Security code">' +
                '<input name="cardholder" aria-label="Name on card">',
            });
          }
          return route.fulfill({ status: 404, body: "not found" });
        });
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;

        // One cursorless query builds one immutable snapshot; every ref below
        // is drawn from that COMPACT map, never from el_table.
        const compact = await observeQuery(sessionId, "");
        const rows = compact.safe_table as Array<[string, string, string?]>;
        const textbox = (label: string): [string, string, string?] => {
          const row = rows.find(
            (candidate) => candidate[1] === "t" && (candidate[2] ?? "").includes(`@${label}`),
          );
          if (row === undefined) throw new Error(`compact map is missing textbox ${label}`);
          return row;
        };

        const numberRow = textbox("card-number");
        const expiryRow = textbox("expiry");
        const cvvRow = textbox("security-code");
        const nameRow = textbox("name-on-card");
        for (const row of [numberRow, expiryRow, cvvRow, nameRow]) {
          expect(row[2] ?? "").toContain("x=x");
        }

        const frame = isolated.page.frames().find((candidate) => candidate.url() === frameUrl)!;

        // operate_type resolves the compact ref to the hosted frame itself.
        // Expiry and cardholder name are ordinary agent fills — never masked,
        // never inject_card fields.
        await operateTypeTool.handler(
          { session_id: sessionId, ref: expiryRow[0], text: "12/30" },
          null,
        );
        expect(await frame.locator('[name="expiry"]').inputValue()).toBe("12/30");
        await operateTypeTool.handler(
          { session_id: sessionId, ref: nameRow[0], text: "Daeun Lee" },
          null,
        );
        expect(await frame.locator('[name="cardholder"]').inputValue()).toBe("Daeun Lee");

        // inject_card fills pan/cvv from COMPACT refs and exposes the masked
        // per-digit token vocabulary in its result.
        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_compact",
          approvalUrl: "https://approve.test/approval_compact",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: "https://merchant.test",
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const result = (await injectCardTool.handler(
          injectCardTool.inputSchema.parse({
            session_id: sessionId,
            merchant: "Synthetic Merchant",
            amount_cents: 123,
            currency: "JPY",
            item: "Synthetic item",
            reason: "Synthetic test purchase",
            card_ref: "card_synthetic",
            approval_id: "approval_compact",
            fields: {
              pan: { ref: numberRow[0] },
              cvv: { ref: cvvRow[0] },
            },
          }),
          {} as ApiClient,
        )) as { fields: Record<string, { status: string }>; card_tokens: Record<string, unknown> };
        expect(result).toMatchObject({
          status: "card_injected",
          fields: {
            pan: { status: "filled" },
            cvv: { status: "filled" },
          },
          card_tokens: {
            pan: "{{pan}}",
            pan_digit: "{{pan:N}}",
            cvv: "{{cvv}}",
            cvv_digit: "{{cvv:N}}",
            pan_length: 16,
            cvv_length: 3,
          },
        });
        // The checkout total (123 JPY) legitimately contains the CVV digits,
        // so the no-leak check covers the secret-bearing parts of the result.
        const secretBearing = JSON.stringify({
          fields: result.fields,
          card_tokens: result.card_tokens,
        });
        expect(secretBearing).not.toContain(CARD.pan);
        expect(secretBearing).not.toContain(CARD.cvv);
        expect(await frame.locator('[name="number"]').inputValue()).toBe(CARD.pan);
        expect(await frame.locator('[name="verification_value"]').inputValue()).toBe(CARD.cvv);
        expect(await frame.locator('[name="cardholder"]').inputValue()).toBe("Daeun Lee");
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    "places whole-value and per-digit masked tokens into arbitrary fields and masks every read",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = "https://merchant.test/checkout";
        const frameUrl = "https://assets.braintreegateway.test/hosted-digits";
        await isolated.page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === topUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: `<iframe src="${frameUrl}" style="width:480px;height:120px"></iframe>`,
            });
          }
          if (url === frameUrl) {
            return route.fulfill({
              contentType: "text/html",
              body:
                '<input name="d1" maxlength="1" aria-label="Digit 1">' +
                '<input name="d2" maxlength="1" aria-label="Digit 2">' +
                '<input name="d3" maxlength="1" aria-label="Digit 3">' +
                '<input name="d4" maxlength="1" aria-label="Digit 4">' +
                '<input name="cvvbox" maxlength="3" aria-label="CVV box">',
            });
          }
          return route.fulfill({ status: 404, body: "not found" });
        });
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;
        // Register the session's output mask exactly as the real release path
        // does (injectCardIntoTargets registers it before any token exists),
        // then mark the card released so operate_type substitutes tokens.
        await controller.injectCardIntoTargets(CARD, {});
        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_tokens",
          approvalUrl: "https://approve.test/approval_tokens",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: "https://merchant.test",
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const frame = isolated.page.frames().find((candidate) => candidate.url() === frameUrl)!;
        const refFor = async (label: string): Promise<string> => {
          const query = await observeQuery(sessionId!, label);
          const rows = query.safe_table as Array<[string, string, string?]>;
          const row = rows.find(
            (candidate) => candidate[1] === "t" && (candidate[2] ?? "").includes(`@${label}`),
          );
          if (row === undefined) throw new Error(`compact map is missing textbox ${label}`);
          return row[0];
        };

        // Per-digit placement: one token per single-digit box.
        for (const [label, token] of [
          ["digit-1", "{{pan:1}}"],
          ["digit-2", "{{pan:2}}"],
          ["digit-3", "{{pan:3}}"],
          ["digit-4", "{{pan:4}}"],
        ] as const) {
          await operateTypeTool.handler(
            { session_id: sessionId, ref: await refFor(label), text: token },
            null,
          );
        }
        await operateTypeTool.handler(
          { session_id: sessionId, ref: await refFor("cvv-box"), text: "{{cvv}}" },
          null,
        );
        expect(await frame.locator('[name="d1"]').inputValue()).toBe(CARD.pan[0]);
        expect(await frame.locator('[name="d2"]').inputValue()).toBe(CARD.pan[1]);
        expect(await frame.locator('[name="d3"]').inputValue()).toBe(CARD.pan[2]);
        expect(await frame.locator('[name="d4"]').inputValue()).toBe(CARD.pan[3]);
        expect(await frame.locator('[name="cvvbox"]').inputValue()).toBe(CARD.cvv);

        // Mixed per-digit tokens compose in one field too (a non-secret
        // prefix of the PAN — ordering is what matters, not the values).
        await operateTypeTool.handler(
          { session_id: sessionId, ref: await refFor("cvv-box"), text: "{{pan:1}}{{pan:2}}{{pan:3}}" },
          null,
        );
        expect(await frame.locator('[name="cvvbox"]').inputValue()).toBe(
          CARD.pan.slice(0, 3),
        );

        // Re-arm: a second full-value write replaces the field contents.
        await operateTypeTool.handler(
          { session_id: sessionId, ref: await refFor("cvv-box"), text: "{{cvv}}" },
          null,
        );
        expect(await frame.locator('[name="cvvbox"]').inputValue()).toBe(CARD.cvv);

        // Out-of-range tokens fail loudly WITHOUT leaking digits.
        await expect(
          operateTypeTool.handler(
            { session_id: sessionId, ref: await refFor("digit-1"), text: "{{pan:17}}" },
            null,
          ),
        ).rejects.toThrow(/out of range/);

        // No operator output carries real digits. The per-digit boxes show
        // single digits (individually meaningless); the complete CVV box is
        // masked by value equality; a mirror of the full PAN is masked.
        await isolated.page.evaluate((card) => {
          const mirror = document.createElement("div");
          mirror.textContent = `copied ${card.pan}`;
          document.body.append(mirror);
        }, CARD);
        const full = await observe(sessionId, "full");
        const compact = await observe(sessionId, "compact");
        const dom = serializeBrowserUseDOM((await controller.extractBrowserUseObservation()).root)
          .dom;
        for (const output of [JSON.stringify(full), JSON.stringify(compact), dom]) {
          expect(output).not.toContain(CARD.pan);
          expect(output).not.toContain(CARD.pan.slice(0, 10));
          expect(output).not.toMatch(new RegExp(`(?:cvv|security code)[^\\n]{0,20}${CARD.cvv}`, "i"));
        }
        expect(dom).toContain("[security code]");
        expect(dom).toContain("[card number]");
        // Expiry/name-like ordinary values (single digits here) stay visible.
        expect(dom).toContain(CARD.pan[0]);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    "per-digit token placement survives a hosted-field remount",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = "https://merchant.test/checkout";
        const frameUrl = "https://assets.braintreegateway.test/hosted-remount-digits";
        await isolated.page.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === topUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: `<iframe src="${frameUrl}" style="width:240px;height:80px"></iframe>`,
            });
          }
          if (url === frameUrl) {
            return route.fulfill({
              contentType: "text/html",
              body: '<input name="d1" maxlength="1" aria-label="Digit 1">',
            });
          }
          return route.fulfill({ status: 404, body: "not found" });
        });
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;
        // Same release-path mask registration as the token test above.
        await controller.injectCardIntoTargets(CARD, {});
        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_remount",
          approvalUrl: "https://approve.test/approval_remount",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: "https://merchant.test",
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const frame = isolated.page.frames().find((candidate) => candidate.url() === frameUrl)!;
        const refFor = async (label: string): Promise<string> => {
          const query = await observeQuery(sessionId!, label);
          const rows = query.safe_table as Array<[string, string, string?]>;
          const row = rows.find(
            (candidate) => candidate[1] === "t" && (candidate[2] ?? "").includes(`@${label}`),
          );
          if (row === undefined) throw new Error(`compact map is missing textbox ${label}`);
          return row[0];
        };

        await operateTypeTool.handler(
          { session_id: sessionId, ref: await refFor("digit-1"), text: "{{pan:1}}" },
          null,
        );
        expect(await frame.locator('[name="d1"]').inputValue()).toBe(CARD.pan[0]);

        // The provider rebuilds its frame: the element is replaced with a new
        // identity and reopens EMPTY. The agent re-observes and re-places the
        // same token — per-field, per-digit retry.
        await frame.evaluate(() => {
          document.body.innerHTML = '<input name="d1" maxlength="1" aria-label="Digit 1">';
        });
        await operateTypeTool.handler(
          { session_id: sessionId, ref: await refFor("digit-1"), text: "{{pan:1}}" },
          null,
        );
        expect(await frame.locator('[name="d1"]').inputValue()).toBe(CARD.pan[0]);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );
});
