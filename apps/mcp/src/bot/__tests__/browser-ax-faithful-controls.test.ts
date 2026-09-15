// C1 — the observation must carry the browser's own accessibility
// description of an operable control, not a list of control shapes the
// capture layer recognises. Live repro: Oura Ring checkout (rc.30,
// session 458406a8): the payment-method chooser renders each option as a
// bare `<label>` wrapping an `opacity:0` `<input type=radio>`. Chrome's AX
// tree reports both radios as role=radio, focusable, named "Credit Card" /
// "PayPal" — a screen reader can operate them — but the capture dropped the
// input (rendered=false folds opacity) and the label (ownsAction=false), so
// the operator saw bare text and could not choose a payment method at all.
//
// C7 rides the same fixture: per-field validation state (Chrome's AX
// `invalid` property / authored aria-invalid — how Braintree hosted fields
// report a bad card) must surface in the compact state bitset so the
// operator can confirm a field landed correctly without rendering its value.

import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { observe } from "../provision-session.js";
import { observeQuery } from "../observe/observe.js";
import { operateClickTool } from "../../tools/provision-drive.js";

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

// Faithful transcription of Oura's checkout payment-method chooser
// (ourafront build, `RadioGroup`/`RadioButton` from chunk 6910 +
// the payment-options list from chunk 3016), plus one aria-invalid
// field standing in for a hosted card field Braintree marked invalid.
const CHOOSER = `<!doctype html><html><head><style>
  .radio { position: relative; display: flex; flex-shrink: 0; width: 1.5rem; height: 1.5rem;
           border: 2px solid #333; border-radius: 9999px; justify-content: center; align-items: center; }
  .hoverSelection { display: flex; padding: 0.25rem; border-radius: 9999px; }
  .checkmark { display: block; height: 1.25rem; width: 1.25rem; border-radius: 9999px; border: 3px solid #fff; }
  .hiddenInput { position: absolute; top: 0; opacity: 0; }
  .row { display: flex; flex-direction: column; gap: 1rem; opacity: 1; }
  .labelRow { display: flex; justify-content: space-between; align-items: center; width: 100%; }
</style></head><body>
<a href="#main">Skip to main content</a>
<div id="__next"><main id="main">
  <h1>Checkout</h1>
  <label>Card number <input aria-invalid="true" placeholder="Card number"></label>
  <div role="radiogroup" aria-label="Payment Method" class="rg" name="payment-method">
    <div class="row">
      <label class="labelRow">
        <span>Credit Card</span>
        <span class="hoverSelection"><span class="radio">
          <span aria-hidden="true" class="checkmark" hidden></span>
          <input type="radio" class="hiddenInput" name="payment-method" value="braintree_creditCard">
        </span></span>
      </label>
    </div>
    <div class="row">
      <label class="labelRow">
        <span>PayPal</span>
        <span class="hoverSelection"><span class="radio">
          <span aria-hidden="true" class="checkmark" hidden></span>
          <input type="radio" class="hiddenInput" name="payment-method" value="paypal">
        </span></span>
      </label>
    </div>
  </div>
  <button type="button">Place order</button>
</main></div>
</body></html>`;

// Generality fixture: widget roles that were NEVER in the old hand-written
// allow-list of sixteen role names. A consent toggle expressed as
// role="switch" and a menu expressed as role="menuitemcheckbox" are exactly
// the shapes the old allow-list dropped (C1 again with a different role); a
// styled-label wrapper and an opacity:0 widget body reproduce the Oura
// presentation. The deny-list rule must admit them because Chrome's AX tree
// presents them as unignored and focusable.
const ROLES = `<!doctype html><html><head><style>
  .hiddenInput { position: absolute; top: 0; opacity: 0; width: 24px; height: 24px; display: block; }
  .toggleRow { position: relative; display: flex; gap: 0.5rem; align-items: center; }
</style></head><body>
<div id="__next"><main id="main">
  <h1>Settings</h1>
  <div class="toggleRow">
    <span>Data sharing</span>
    <div role="switch" aria-checked="false" tabindex="0" class="hiddenInput"
         aria-label="Consent toggle"></div>
  </div>
  <div role="menu" aria-label="Notifications">
    <div role="menuitemcheckbox" aria-checked="false" tabindex="0" class="hiddenItem"
         style="position:absolute;top:0;opacity:0;width:24px;height:24px;display:block">Email me</div>
  </div>
</main></div>
</body></html>`;

// C5 fixture: the compact map emits canonical roles as single letters — a
// country <select> is role "s" on the wire — so a role filter stated the way
// the map taught the caller ("s") must match the same row.
const COUNTRY = `<!doctype html><html><body><main>
  <h1>Shipping</h1>
  <label>Country <select id="country"><option>Japan</option><option>United States</option></select></label>
  <button type="button">Continue to payment</button>
</main></body></html>`;

// Innermost-operable fixture: an <img tabindex="0"> acting as a button with a
// click handler and no operable descendants. Chrome's AX tree reports it as
// role Image, focusable — but the old role-name deny list contained "image",
// so the old predicate silently dropped a real control (C1 reintroduced under
// a different role name). The tree-derived rule must emit it.
const IMG_BUTTON = `<!doctype html><html><body><main>
  <h1>Store</h1>
  <img id="buy" tabindex="0" src="https://fixture.test/buy.png" alt="Buy now"
       style="width:96px;height:36px;display:block" onclick="this.dataset.clicked='yes'">
  <button type="button">Checkout</button>
</main></body></html>`;

// C7 label-proxy fixture: invisible checkboxes emitted through their single
// visible <label for>. The proxy row is built from the visible label node,
// but the validation state (aria-invalid) lives on the input — the semantic
// node — and must still surface in the state bitset.
const PROXY_INVALID = `<!doctype html><html><head><style>
  .off { position: absolute; opacity: 0; width: 20px; height: 20px; margin: 0; }
</style></head><body><main>
  <h1>Legal</h1>
  <label for="terms">Terms of service</label>
  <input type="checkbox" id="terms" class="off" aria-invalid="true">
  <label for="fine">Fine print</label>
  <input type="checkbox" id="fine" class="off">
</main></body></html>`;

let browser: Browser | undefined;

beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
});

async function newPage(body: string): Promise<Page> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const page = await (await browser.newContext()).newPage();
  await page.route("https://fixture.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
  return page;
}

describe("AX-faithful control emission (C1) and per-field invalid state (C7)", () => {
  it(
    "emits the opacity:0 styled-label radios as operable controls and drives them",
    async () => {
      const page = await newPage(CHOOSER);
      let sessionId: string | undefined;
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://fixture.test/checkout",
          format: "compact",
        });
        sessionId = start.session_id;

        const rows = (start as unknown as { safe_table: string[][] }).safe_table;
        const rowFor = (needle: string): string[] | undefined =>
          rows.find((row) => (row[2] ?? "").toLowerCase().includes(needle));

        // The radios are controls in the compact map, named by the browser's
        // own accessible description, not by our shape recognition.
        const credit = rowFor("credit-card");
        const paypal = rowFor("paypal");
        expect(credit, "compact row for the Credit Card radio").toBeDefined();
        expect(paypal, "compact row for the PayPal radio").toBeDefined();
        expect(credit![1]).toBe("r");
        expect(paypal![1]).toBe("r");
        // Exactly one control per option: the visible label text does not
        // become a second, nameless control.
        expect(rows.filter((row) => (row[2] ?? "").toLowerCase().includes("credit-card"))).toHaveLength(1);
        // The radiogroup container itself is NOT emitted: the innermost
        // operable node is the control, and the radios are its operable
        // descendants. A group row would pass its container role through
        // verbatim on the wire.
        expect(
          rows.filter((row) => /group/i.test(row[1] ?? "")),
          "no radiogroup container row",
        ).toHaveLength(0);

        // The AX name travelled onto the emitted input, so the full DOM can
        // be queried by the name the browser gives it.
        const full = (await observe(sessionId, "full")) as unknown as { dom: string };
        expect(full.dom).toContain("ax_name=Credit Card");
        expect(full.dom).toContain("ax_name=PayPal");

        // The emitted radio is operable: clicking its ref ticks the real
        // (opacity:0) input, exactly like a screen reader would.
        const clicked = await operateClickTool.handler(
          { session_id: sessionId, ref: credit![0]! },
          null,
        );
        expect(JSON.stringify(clicked)).toBeDefined();
        expect(await page.locator('input[value="braintree_creditCard"]').isChecked()).toBe(true);

        // C7 — the aria-invalid field carries the browser's invalid state in
        // its compact state bitset (s=…i…), sparse: absence means not invalid.
        const invalidRow = rowFor("card-number");
        expect(invalidRow, "compact row for the invalid card field").toBeDefined();
        expect(invalidRow![2] ?? "").toMatch(/s=[cudr]*i(?![a-z])/);
        // ...and a control whose browser state is not invalid carries no i bit.
        expect(paypal![2] ?? "").not.toMatch(/s=[cudr]*i(?![a-z])/);
      } finally {
        if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
        await page.context().close();
      }
    },
    120000,
  );
  it(
    "admits widget roles outside any hand-written allow-list (switch, menuitemcheckbox)",
    async () => {
      const page = await newPage(ROLES);
      let sessionId: string | undefined;
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://fixture.test/settings",
          format: "compact",
        });
        sessionId = start.session_id;

        const rows = (start as unknown as { safe_table: string[][] }).safe_table;
        const rowFor = (needle: string): string[] | undefined =>
          rows.find((row) => (row[2] ?? "").toLowerCase().includes(needle));

        // Default admits: both roles are controls named by the browser's own
        // accessible description, despite the opacity:0 presentation and the
        // styled-label wrapper. The denied menu container does not swallow or
        // duplicate them.
        const consent = rowFor("consent-toggle");
        const email = rowFor("email-me");
        expect(consent, "compact row for the role=switch toggle").toBeDefined();
        expect(email, "compact row for the role=menuitemcheckbox item").toBeDefined();
        expect(rows.filter((row) => (row[2] ?? "").toLowerCase().includes("email-me"))).toHaveLength(1);

        const full = (await observe(sessionId, "full")) as unknown as { dom: string };
        // The switch's browser name is its authored aria-label; the checkbox's
        // name comes from its content and travels as ax_name. Both are the
        // browser's own description, emitted verbatim with their AX roles.
        expect(full.dom).toContain("role=switch aria-checked=false aria-label=Consent toggle");
        expect(full.dom).toContain("role=menuitemcheckbox aria-checked=false ax_name=Email me");

        // Both are operable targets: the click machinery accepts the ref and
        // the action lands on the real (opacity:0) widget node.
        for (const row of [consent!, email!]) {
          const clicked = await operateClickTool.handler(
            { session_id: sessionId, ref: row[0]! },
            null,
          );
          expect(JSON.stringify(clicked)).toBeDefined();
        }
      } finally {
        if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
        await page.context().close();
      }
    },
    120000,
  );
  it(
    "matches role filters stated in wire form (C5: role:\"s\" finds the select)",
    async () => {
      const page = await newPage(COUNTRY);
      let sessionId: string | undefined;
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://fixture.test/shipping",
          format: "compact",
        });
        sessionId = start.session_id;

        // The unfiltered map taught the caller the role: the select's wire row
        // carries the letter "s".
        const rows = (start as unknown as { safe_table: string[][] }).safe_table;
        const selectRow = rows.find((row) => row[1] === "s");
        expect(selectRow, "select row with wire role s").toBeDefined();

        // C5 — a role filter in the emitted form must find the control; the
        // old code compared the letter against the internal role word and
        // returned an empty safe_table for a control the caller had just seen.
        const filtered = (await observeQuery(sessionId, "country", "s")) as unknown as {
          safe_table: string[][];
        };
        expect(filtered.safe_table).toHaveLength(1);
        expect(filtered.safe_table[0]![0]).toBe(selectRow![0]);
        expect(filtered.safe_table[0]![1]).toBe("s");
      } finally {
        if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
        await page.context().close();
      }
    },
    120000,
  );

  it(
    "emits a focusable img-as-button with no operable children (innermost rule, no role-name list)",
    async () => {
      const page = await newPage(IMG_BUTTON);
      let sessionId: string | undefined;
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://fixture.test/store",
          format: "compact",
        });
        sessionId = start.session_id;

        const rows = (start as unknown as { safe_table: string[][] }).safe_table;
        const rowFor = (needle: string): string[] | undefined =>
          rows.find((row) => (row[2] ?? "").toLowerCase().includes(needle));

        // Chrome's AX tree reports the <img tabindex=0> as role Image,
        // focusable — a control built out of an image. The old role-name deny
        // list silently dropped it (C1 again under a different role name);
        // the innermost-operable rule admits it because the browser says it
        // is operable and it has no operable descendant.
        const buy = rowFor("buy-now");
        expect(buy, "compact row for the focusable img-as-button").toBeDefined();

        // It is a real action target: the click lands on the image.
        const clicked = await operateClickTool.handler(
          { session_id: sessionId, ref: buy![0]! },
          null,
        );
        expect(JSON.stringify(clicked)).toBeDefined();
        expect(await page.locator("#buy").getAttribute("data-clicked")).toBe("yes");
      } finally {
        if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
        await page.context().close();
      }
    },
    120000,
  );

  it(
    "carries the invalid state of a label-proxied checkbox from the semantic node (C7)",
    async () => {
      const page = await newPage(PROXY_INVALID);
      let sessionId: string | undefined;
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: "https://fixture.test/terms",
          format: "compact",
        });
        sessionId = start.session_id;

        const rows = (start as unknown as { safe_table: string[][] }).safe_table;
        const rowFor = (needle: string): string[] | undefined =>
          rows.find((row) => (row[2] ?? "").toLowerCase().includes(needle));

        // The invisible checkbox is emitted through its visible label proxy;
        // aria-invalid lives on the input (the semantic node), not on the
        // visible label the row is built from. The state must still surface.
        const terms = rowFor("terms-of-service");
        expect(terms, "compact row for the proxied terms checkbox").toBeDefined();
        expect(terms![2] ?? "").toMatch(/s=[cudr]*i(?![a-z])/);

        // A proxied checkbox without aria-invalid carries no i bit.
        const fine = rowFor("fine-print");
        expect(fine, "compact row for the non-invalid proxied checkbox").toBeDefined();
        expect(fine![2] ?? "").not.toMatch(/s=[cudr]*i(?![a-z])/);

        // The proxy row is a real action target on the underlying input.
        const clicked = await operateClickTool.handler(
          { session_id: sessionId, ref: terms![0]! },
          null,
        );
        expect(JSON.stringify(clicked)).toBeDefined();
        expect(await page.locator("#terms").isChecked()).toBe(true);
      } finally {
        if (sessionId) await finishProvisionSession(sessionId).catch(() => {});
        await page.context().close();
      }
    },
    120000,
  );
});
