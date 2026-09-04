// Regression test for the operator's DOM inventory going blind on modal
// dialogs (Play Console "Review and transfer", Firebase console
// google-services.json download, Play Console tester email-list dialog).
//
// DIAGNOSIS (do not re-guess this — it was measured, not assumed):
// The naive theory — "the crawler drops subtrees under an aria-hidden/inert
// ancestor" — is FALSE. extractElementsFromContext never filters on
// aria-hidden/inert at all, and a live Chromium repro against a real Angular
// Material CDK dialog (material.angular.dev — Angular CDK/Material only ever
// marks the app root `aria-hidden`, never `inert`, and portals the overlay
// container as a true SIBLING of the app root) extracts and clicks the
// dialog's controls with no defect. Native <dialog>+showModal() and a
// synthetic CDK-shaped backdrop+pane fixture both extract fine too.
//
// The REAL defect only reproduces when a dialog is NOT truly portaled to
// <body> — it merely escapes its container VISUALLY via position:fixed while
// remaining a structural DESCENDANT of whatever ancestor got marked `inert`
// for the "hide the background while a modal is open" trick (a common
// pattern for dashboards that roll their own lighter modal instead of using
// a real DOM portal). `inert` — unlike display/visibility/opacity — makes
// Chromium's native hit-testing (document.elementFromPoint, and the
// actionability check behind Playwright's real click()) skip the ENTIRE
// subtree. Concretely, pre-fix:
//   - el_table DID list the dialog's controls (the DOM walk collects them
//     fine — nothing filters on inert), but every one was reported
//     topmost:false / occludedBy:"html" (elementFromPoint skips straight
//     past the inert subtree to whatever's behind the whole page), which is
//     indistinguishable from "unusable" to a host agent deciding what to
//     click.
//   - A real click() on one of those controls HUNG until Playwright's
//     actionability timeout, because Playwright's actionability check also
//     honors `inert` — matching the report's "the agent cannot click
//     anything inside it."
//
// The fix (browser.ts: neutralizeInertForHitTest in
// extractElementsFromContext, withModalInertNeutralized wrapping click())
// temporarily clears `inert` on ancestors of an element ONLY when that
// element is itself inside a detected dialog/modal region
// ([role="dialog"], <dialog>, [aria-modal="true"]), for the duration of the
// hit-test / click, then restores it — so a genuine background control
// outside any modal keeps its inert protection untouched (money-fence /
// confused-deputy boundary unaffected).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController, type InteractiveElement } from "../browser.js";
import { buildCompactObservation, type ObserveDeltaState } from "../provision-session.js";

let browser: Browser;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  // The controller's browser is normally created by start(), which does
  // network geo-probing + a persistent profile launch unsuitable for a unit
  // test. Inject a directly-launched page so the REAL extract/click methods
  // run against real Chromium, mirroring the established pattern in
  // shadow-dom-topmost.test.ts / browser-humanize.test.ts.
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

// A dialog that is NOT portaled to <body> — it stays a structural descendant
// of the `inert`-marked background wrapper and only escapes visually via
// position:fixed. This is the shape that reproduces the reported defect.
function nonPortaledDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="app-wrapper" inert aria-hidden="true">
    <button id="bg-btn" onclick="document.title='BG_CLICKED'">Background Button</button>
    <div class="backdrop" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)">
      <div role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;z-index:1001;width:400px;background:white;padding:20px">
        <h2>Review and transfer</h2>
        <input type="text" id="transfer-note" />
        <input type="checkbox" id="tos" />
        <label for="tos">I agree</label>
        <button id="confirm-btn" onclick="document.title='CONFIRM_CLICKED'">Confirm transfer</button>
        <button id="close-confirm-btn" onclick="document.title='CLOSE_CONFIRM_CLICKED';closeDialog()">Confirm and close</button>
        <button id="next-btn" onclick="advanceDialog()">Next</button>
        <button id="cancel-btn">Cancel</button>
      </div>
    </div>
  </div>
  <script>
    function closeDialog() {
      document.getElementById('app-wrapper').removeAttribute('inert');
      document.getElementById('app-wrapper').removeAttribute('aria-hidden');
      document.querySelector('.backdrop').remove();
    }
    function advanceDialog() {
      const current = document.querySelector('[role="dialog"]');
      const next = document.createElement('div');
      next.setAttribute('role', 'dialog');
      next.setAttribute('aria-modal', 'true');
      next.setAttribute('style', current.getAttribute('style'));
      const heading = document.createElement('h2');
      heading.textContent = 'Transfer details';
      const button = document.createElement('button');
      button.id = 'step-two-btn';
      button.textContent = 'Finish';
      button.addEventListener('click', () => {
        document.title = 'STEP_TWO_CLICKED';
      });
      next.append(heading, button);
      current.replaceWith(next);
    }
  </script>
</body></html>`)}`;
}

function duplicateOptionDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="app-wrapper" inert aria-hidden="true">
    <div role="option" id="bg-option" style="position:fixed;top:20px;left:20px;padding:12px" onclick="document.title='BG_OPTION_CLICKED'">Continue</div>
    <div role="dialog" aria-modal="true" style="position:fixed;top:120px;left:100px;width:400px;background:white;padding:20px">
      <h2>Choose action</h2>
      <div role="option" id="dialog-option" style="padding:12px" onclick="document.title='DIALOG_OPTION_CLICKED'">Continue</div>
    </div>
  </div>
</body></html>`)}`;
}

function formWrappedDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="app-wrapper" inert aria-hidden="true">
    <button id="bg-btn">Background Button</button>
    <div class="backdrop" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)">
      <div role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;z-index:1001;width:400px;background:white;padding:20px">
        <h2>Review and transfer</h2>
        <form>
          <input type="checkbox" id="form-tos" />
          <label for="form-tos">I agree</label>
          <button type="button" id="form-confirm-btn" onclick="document.title='FORM_CONFIRM_CLICKED'">Confirm transfer</button>
        </form>
      </div>
    </div>
  </div>
</body></html>`)}`;
}

function openShadowDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="app-wrapper" inert aria-hidden="true">
    <button id="bg-btn">Background Button</button>
    <modal-shell></modal-shell>
  </div>
  <script>
    class ModalShell extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<div id="shadow-inert-wrapper" inert>' +
          '<div class="backdrop" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)">' +
          '<div role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;z-index:1001;width:400px;background:white;padding:20px">' +
          '<h2>Shadow review</h2>' +
          '<input type="checkbox" id="shadow-tos" />' +
          '<label for="shadow-tos">I agree</label>' +
          '<button id="shadow-confirm-btn">Confirm transfer</button>' +
          '</div></div></div>';
        root.getElementById("shadow-confirm-btn").addEventListener("click", () => {
          document.title = "SHADOW_CONFIRM_CLICKED";
        });
      }
    }
    customElements.define("modal-shell", ModalShell);
  </script>
</body></html>`)}`;
}

// A native <dialog> whose close handler hides it via .close() — leaving the
// element CONNECTED in the DOM without `open` (UA-hidden) — while unlocking
// the background, instead of removing the dialog node entirely. The stale
// dialog-shaped remnant must not make the restore step re-lock the
// background the app just legitimately unlocked.
function staleRemnantDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="remnant-wrapper" inert aria-hidden="true">
    <button id="remnant-bg-btn" onclick="document.title='REMNANT_BG_CLICKED'">Background Button</button>
    <dialog id="remnant-dialog" style="position:fixed;top:100px;left:100px;z-index:1001;margin:0;width:400px;padding:20px">
      <h2>Review and transfer</h2>
      <button id="remnant-close-btn" onclick="document.title='REMNANT_CLOSE_CLICKED';closeRemnant()">Confirm and close</button>
    </dialog>
  </div>
  <script>
    document.getElementById('remnant-dialog').show();
    function closeRemnant() {
      document.getElementById('remnant-dialog').close();
      const wrapper = document.getElementById('remnant-wrapper');
      wrapper.removeAttribute('inert');
      wrapper.removeAttribute('aria-hidden');
    }
  </script>
</body></html>`)}`;
}

function ancestorHiddenDialogFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="hidden-parent-wrapper" inert aria-hidden="true">
    <button id="hidden-parent-bg" onclick="document.title='HIDDEN_PARENT_BG_CLICKED'">Background Button</button>
    <div id="overlay-parent" style="position:fixed;inset:0;z-index:1000">
      <div role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;width:400px;background:white;padding:20px">
        <button id="hide-parent-btn" onclick="closeByHidingParent()">Confirm and close</button>
      </div>
    </div>
  </div>
  <script>
    function closeByHidingParent() {
      document.getElementById('overlay-parent').style.display = 'none';
      const wrapper = document.getElementById('hidden-parent-wrapper');
      wrapper.removeAttribute('inert');
      wrapper.removeAttribute('aria-hidden');
    }
  </script>
</body></html>`)}`;
}

describe("modal overlay blindness — non-portaled inert-ancestor dialog (real Chromium)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("lists the dialog's checkbox/buttons as topmost and clickable, while the true background stays occluded", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      const els = await ctrl.extractInteractiveElements();

      const bg = els.find((e) => e.id === "bg-btn");
      const tos = els.find((e) => e.id === "tos");
      const confirmBtn = els.find((e) => e.id === "confirm-btn");
      const cancelBtn = els.find((e) => e.id === "cancel-btn");

      // All of them are collected (the DOM walk never filtered on inert).
      expect(bg).toBeDefined();
      expect(tos).toBeDefined();
      expect(confirmBtn).toBeDefined();
      expect(cancelBtn).toBeDefined();

      // The dialog's own controls are the genuinely visible, topmost thing —
      // the fix makes topmostStatus report that correctly instead of
      // "occludedBy:html" (inert hit-test skip).
      expect(tos?.topmost).toBe(true);
      expect(confirmBtn?.topmost).toBe(true);
      expect(cancelBtn?.topmost).toBe(true);
      expect(confirmBtn?.container).toBe("dialog:review-and-transfer");

      // The REAL background control (outside the modal) is still correctly
      // reported as occluded by the backdrop/dialog on top of it.
      expect(bg?.topmost).toBe(false);

      // The dialog's button is actually clickable — pre-fix this call hung
      // until Playwright's actionability timeout because inert blocked hit
      // testing for the real click() path too.
      await ctrl.click(confirmBtn!.selector);
      expect(await page.title()).toBe("CONFIRM_CLICKED");

      // inert is restored on the background wrapper after the click — the
      // neutralization is scoped to the single click, not left dangling.
      const inertRestored = await page.evaluate(
        () => document.getElementById("app-wrapper")?.hasAttribute("inert") === true,
      );
      expect(inertRestored).toBe(true);

      // No leftover marker attributes from the neutralize/restore machinery.
      const markerLeaked = await page.evaluate(
        () =>
          document.querySelectorAll("[data-ts-inert-neutralized],[data-ts-inert-region-anchor]")
            .length > 0,
      );
      expect(markerLeaked).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it("leaves a genuine background control (outside any modal) inert-protected — money-fence unaffected", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      const els = await ctrl.extractInteractiveElements();
      const bg = els.find((e) => e.id === "bg-btn")!;
      // A real click on the background control must NOT be silently
      // "fixed" into working — it stays genuinely non-actionable while
      // inert, exactly like before this change. Race it against a short
      // timeout rather than letting it hang the suite: the click must not
      // resolve within the window.
      const outcome = await Promise.race([
        ctrl.click(bg.selector).then(() => "resolved" as const),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 2000)),
      ]);
      expect(outcome).toBe("timed_out");
      expect(await page.title()).not.toBe("BG_CLICKED");
    } finally {
      await page.close();
    }
  }, 15000);

  it("types into a field inside the inert-ancestor dialog", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      await ctrl.type("#transfer-note", "Ready to transfer");
      expect(await page.locator("#transfer-note").inputValue()).toBe("Ready to transfer");
      expect(
        await page.evaluate(
          () => document.getElementById("app-wrapper")?.hasAttribute("inert") === true,
        ),
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);

  it("dialog closed → inventory returns to normal", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      const before = await ctrl.extractInteractiveElements();
      expect(before.some((e) => e.id === "confirm-btn")).toBe(true);

      await page.evaluate(() => (window as unknown as { closeDialog: () => void }).closeDialog());

      const after = await ctrl.extractInteractiveElements();
      expect(after.some((e) => e.id === "confirm-btn")).toBe(false);
      expect(after.some((e) => e.id === "cancel-btn")).toBe(false);

      const bg = after.find((e) => e.id === "bg-btn");
      expect(bg).toBeDefined();
      // The background is a normal, unhidden control again post-close.
      expect(bg?.topmost).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);

  it("preserves the app's background unlock when the clicked dialog closes", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      const before = await ctrl.extractInteractiveElements();
      const closeConfirm = before.find((e) => e.id === "close-confirm-btn");
      expect(closeConfirm).toBeDefined();

      await ctrl.click(closeConfirm!.selector);
      expect(await page.title()).toBe("CLOSE_CONFIRM_CLICKED");
      expect(
        await page.evaluate(
          () => document.getElementById("app-wrapper")?.hasAttribute("inert") === true,
        ),
      ).toBe(false);

      const after = await ctrl.extractInteractiveElements();
      const bg = after.find((e) => e.id === "bg-btn");
      expect(bg?.topmost).toBe(true);
      await ctrl.click(bg!.selector);
      expect(await page.title()).toBe("BG_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not re-lock the background over a closed-but-connected <dialog> remnant", async () => {
    const { ctrl, page } = await pageFor(staleRemnantDialogFixture());
    try {
      const before = await ctrl.extractInteractiveElements();
      const closeBtn = before.find((e) => e.id === "remnant-close-btn");
      expect(closeBtn).toBeDefined();

      await ctrl.click(closeBtn!.selector);
      expect(await page.title()).toBe("REMNANT_CLOSE_CLICKED");

      // The click's handler hid the dialog via .close() (the <dialog> stays
      // connected, just without `open`) and unlocked the background. The
      // stale remnant must not be mistaken for a still-active modal — inert
      // must NOT be re-added to the wrapper.
      expect(
        await page.evaluate(() => {
          const dialog = document.getElementById("remnant-dialog");
          return {
            remnantConnected: dialog !== null && dialog.isConnected,
            remnantOpen: dialog?.hasAttribute("open") === true,
            wrapperInert:
              document.getElementById("remnant-wrapper")?.hasAttribute("inert") === true,
          };
        }),
      ).toEqual({ remnantConnected: true, remnantOpen: false, wrapperInert: false });

      const after = await ctrl.extractInteractiveElements();
      const bg = after.find((e) => e.id === "remnant-bg-btn");
      expect(bg?.topmost).toBe(true);
      await ctrl.click(bg!.selector);
      expect(await page.title()).toBe("REMNANT_BG_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not re-lock the background when a dialog is hidden by its parent", async () => {
    const { ctrl, page } = await pageFor(ancestorHiddenDialogFixture());
    try {
      await ctrl.click("#hide-parent-btn");

      expect(
        await page.evaluate(() => ({
          overlayDisplay: document.getElementById("overlay-parent")?.style.display,
          dialogDisplay: getComputedStyle(document.querySelector('[role="dialog"]')!).display,
          wrapperInert:
            document.getElementById("hidden-parent-wrapper")?.hasAttribute("inert") === true,
        })),
      ).toEqual({ overlayDisplay: "none", dialogDisplay: "block", wrapperInert: false });

      await ctrl.click("#hidden-parent-bg");
      expect(await page.title()).toBe("HIDDEN_PARENT_BG_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("preserves background protection when a wizard replaces its dialog node", async () => {
    const { ctrl, page } = await pageFor(nonPortaledDialogFixture());
    try {
      const before = await ctrl.extractInteractiveElements();
      const next = before.find((e) => e.id === "next-btn");
      expect(next).toBeDefined();

      await ctrl.click(next!.selector);
      expect(
        await page.evaluate(
          () => document.getElementById("app-wrapper")?.hasAttribute("inert") === true,
        ),
      ).toBe(true);

      const after = await ctrl.extractInteractiveElements();
      const stepTwo = after.find((e) => e.id === "step-two-btn");
      expect(stepTwo).toBeDefined();
      expect(stepTwo?.topmost).toBe(true);

      await ctrl.click(stepTwo!.selector);
      expect(await page.title()).toBe("STEP_TWO_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("scopes same-named role re-resolution to the dialog", async () => {
    const { ctrl, page } = await pageFor(duplicateOptionDialogFixture());
    try {
      const els = await ctrl.extractInteractiveElements();
      const dialogOption = els.find((e) => e.id === "dialog-option");
      expect(dialogOption).toBeDefined();
      expect(dialogOption?.topmost).toBe(true);

      await ctrl.click(dialogOption!.selector);
      expect(await page.title()).toBe("DIALOG_OPTION_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("finds a dialog beyond an intervening form", async () => {
    const { ctrl, page } = await pageFor(formWrappedDialogFixture());
    try {
      const els = await ctrl.extractInteractiveElements();
      const tos = els.find((e) => e.id === "form-tos");
      const confirmBtn = els.find((e) => e.id === "form-confirm-btn");

      expect(tos).toBeDefined();
      expect(confirmBtn).toBeDefined();
      expect(tos?.topmost).toBe(true);
      expect(confirmBtn?.topmost).toBe(true);
      expect(confirmBtn?.container).toMatch(/^form:/);
      expect(confirmBtn?.inDialog).toBe(true);

      await ctrl.click(confirmBtn!.selector);
      expect(await page.title()).toBe("FORM_CONFIRM_CLICKED");
    } finally {
      await page.close();
    }
  }, 30000);

  it("pierces an open shadow root to neutralize an outer inert ancestor", async () => {
    const { ctrl, page } = await pageFor(openShadowDialogFixture());
    try {
      const els = await ctrl.extractInteractiveElements();
      const confirmBtn = els.find((e) => e.id === "shadow-confirm-btn");

      expect(confirmBtn).toBeDefined();
      expect(confirmBtn?.topmost).toBe(true);

      await ctrl.click(confirmBtn!.selector);
      expect(await page.title()).toBe("SHADOW_CONFIRM_CLICKED");
      expect(
        await page.evaluate(() => {
          const root = document.querySelector("modal-shell")?.shadowRoot;
          return {
            outerInert: document.getElementById("app-wrapper")?.hasAttribute("inert") === true,
            innerInert:
              root?.getElementById("shadow-inert-wrapper")?.hasAttribute("inert") === true,
            markerLeaked:
              root?.querySelector("[data-ts-inert-neutralized],[data-ts-inert-region-anchor]") !==
                null ||
              document.querySelector(
                "[data-ts-inert-neutralized],[data-ts-inert-region-anchor]",
              ) !== null,
          };
        }),
      ).toEqual({ outerInert: true, innerInert: true, markerLeaked: false });
    } finally {
      await page.close();
    }
  }, 30000);
});

// Regression control: a dialog shaped exactly like REAL Angular Material CDK
// output — confirmed via live DOM inspection (chrome-devtools-axi against
// material.angular.dev): the app root gets `aria-hidden="true"` but NEVER
// `inert`, and the overlay container is a true SIBLING of the app root, not
// a descendant. This shape must be completely unaffected by the fix (no
// inert ancestor of the dialog exists, so neutralizeInertForHitTest /
// withModalInertNeutralized are no-ops here). Kept synthetic/local rather
// than hitting a live external site — no other test in this suite depends
// on real network access, and a third-party page can change out from under
// CI.
function cdkSiblingPortalFixture(): string {
  return `data:text/html,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;padding:0">
  <div id="app-root" aria-hidden="true">
    <button id="bg-btn">Background Button</button>
  </div>
  <div class="cdk-overlay-container">
    <div class="cdk-overlay-backdrop" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5)"></div>
    <div class="cdk-overlay-pane" style="position:fixed;top:100px;left:100px;z-index:1001;width:400px;background:white;padding:20px">
      <div role="dialog" aria-modal="true" class="mat-mdc-dialog-container">
        <h2>Hi</h2>
        <input type="text" id="favorite-animal" />
        <button id="no-thanks-btn">No Thanks</button>
        <button id="ok-btn">Ok</button>
      </div>
    </div>
  </div>
</body></html>`)}`;
}

describe("modal overlay blindness — CDK sibling-portal dialog stays correct (regression control)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("extracts and reports topmost correctly with no inert ancestor involved", async () => {
    const { ctrl, page } = await pageFor(cdkSiblingPortalFixture());
    try {
      const els = await ctrl.extractInteractiveElements();
      const okBtn = els.find((e) => e.id === "ok-btn");
      const noThanksBtn = els.find((e) => e.id === "no-thanks-btn");
      const bg = els.find((e) => e.id === "bg-btn");
      expect(okBtn).toBeDefined();
      expect(okBtn?.topmost).toBe(true);
      expect(noThanksBtn?.topmost).toBe(true);
      expect(okBtn?.container).toBe("dialog:hi");
      // No inert anywhere in this fixture, so the background is only
      // occluded by the backdrop/dialog stacked visually on top of it —
      // ordinary occlusion, not the inert-hit-test-bypass case.
      expect(bg?.topmost).toBe(false);
      await ctrl.click(okBtn!.selector);
    } finally {
      await page.close();
    }
  }, 30000);
});

// Pure-function unit test for the `modal_active` observation signal — no
// browser needed. Mirrors the `el()` fixture-builder pattern established in
// observe-delta.test.ts.
function el(partial: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "sel",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    value: null,
    ...partial,
  };
}

describe("modal_active observation signal (pure function)", () => {
  it("is set when a dialog region has a topmost element", () => {
    const elements: InteractiveElement[] = [
      el({ index: 0, selector: "#a", visibleText: "Home", container: null, topmost: true }),
      el({
        index: 1,
        selector: "#confirm",
        visibleText: "Confirm transfer",
        container: "dialog:review-and-transfer",
        inDialog: true,
        topmost: true,
      }),
    ];
    const built = buildCompactObservation({
      sessionId: "s1",
      url: "https://example.com",
      text: "",
      elements,
      prev: null,
    });
    expect(built.observation.modal_active).toBe(true);
  });

  it("is omitted when no dialog region is topmost (or no dialog present)", () => {
    const elements: InteractiveElement[] = [
      el({ index: 0, selector: "#a", visibleText: "Home", container: null, topmost: true }),
      el({
        index: 1,
        selector: "#hidden-dialog-btn",
        visibleText: "Old dialog remnant",
        container: "dialog:stale",
        inDialog: true,
        topmost: false,
      }),
    ];
    const built = buildCompactObservation({
      sessionId: "s2",
      url: "https://example.com",
      text: "",
      elements,
      prev: null,
    });
    expect(built.observation.modal_active).toBeUndefined();
  });

  it("detects a form-grouped element inside a dialog", () => {
    const built = buildCompactObservation({
      sessionId: "s-form",
      url: "https://example.com",
      text: "",
      elements: [
        el({
          selector: "#confirm",
          visibleText: "Confirm transfer",
          container: "form:transfer-form",
          inDialog: true,
          topmost: true,
        }),
      ],
      prev: null,
    });
    expect(built.observation.modal_active).toBe(true);
  });

  it("stays accurate across a delta emit (not just the changed subset)", () => {
    // A stable baseline of 5 elements so adding ONE new dialog element keeps
    // churn (1/5 = 20%) under OBSERVE_CHURN_FULL_THRESHOLD (60%) and the
    // second observe genuinely takes the delta path, not a full resync.
    const first: InteractiveElement[] = [0, 1, 2, 3, 4].map((i) =>
      el({
        index: i,
        selector: `#a${i}`,
        visibleText: `Home ${i}`,
        container: null,
        topmost: true,
      }),
    );
    const firstBuilt = buildCompactObservation({
      sessionId: "s3",
      url: "https://example.com",
      text: "page text",
      elements: first,
      prev: null,
    });
    expect(firstBuilt.observation.modal_active).toBeUndefined();

    const prevState: ObserveDeltaState = firstBuilt.nextState;
    const second: InteractiveElement[] = [
      ...first,
      el({
        index: 1,
        selector: "#confirm",
        visibleText: "Confirm transfer",
        container: "dialog:review-and-transfer",
        inDialog: true,
        topmost: true,
      }),
    ];
    const secondBuilt = buildCompactObservation({
      sessionId: "s3",
      url: "https://example.com",
      text: "page text",
      elements: second,
      prev: prevState,
    });
    expect(secondBuilt.observation.delta).toBe(true);
    expect(secondBuilt.observation.modal_active).toBe(true);
  });
});
