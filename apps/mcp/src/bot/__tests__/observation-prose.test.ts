import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// The former separate-prose-channel tests now exercise its replacement through
// real Chrome: CDP capture -> canonical serializer with verbatim page content.
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserController, type InteractiveElement } from "../browser.js";
import { captureBrowserUseDOM } from "../browser-use-capture.js";
import { serializeBrowserUseDOM, type BrowserUseNode } from "../browser-use-serializer.js";
import {
  buildSafeControlsV2,
  controlMatchesPrivateQueryV2,
  StableObservationRefs,
} from "../compact-observation-v2.js";
let browser: Browser;
const transparentFrameSecurity = async (): Promise<{ opaque: boolean }> => ({ opaque: false });
const captureThroughController = async (page: Page) => {
  const controller = new BrowserController({ humanize: false });
  (controller as unknown as { page: Page }).page = page;
  return controller.extractBrowserUseObservation();
};
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
describe("interleaved observation DOM", () => {
  it("derives compact control labels from browser-use DOM associations", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <label for="work-email">Work email</label><input id="work-email">
        <span id="account-name">Account email</span><input id="account-email" aria-labelledby="account-name">
        <label for="query-email">Work email</label><span id="query-name">Billing contact</span><input id="query-email" aria-labelledby="query-name">
        <button id="checkout"><img alt="Acme"><span>Checkout</span></button>
        <button id="preferences" aria-label="設定"></button>
        <span id="empty-name">Master volume</span><div id="empty-volume" role="slider" aria-label="" aria-labelledby="empty-name" tabindex="0" style="display:block;width:20px;height:20px"></div>
        <section><h2>Volume controls</h2><div id="volume" role="slider" tabindex="0" style="display:block;width:20px;height:20px"></div></section>
        <section><div id="structural-floor" role="slider" tabindex="0" style="display:block;width:20px;height:20px"></div></section>
        <section id="shadow-section"><h2>Shadow volume controls</h2><x-slider id="shadow-host"></x-slider></section>
      `);
      await page.locator("body").evaluate((body) => {
        const host = body.querySelector("#shadow-host")!;
        host.attachShadow({ mode: "open" }).innerHTML =
          '<span id="shared-name">Shadow volume</span><div id="shadow-volume" role="slider" aria-labelledby="shared-name" tabindex="0" style="display:block;width:20px;height:20px"></div><div id="shadow-floor" role="slider" tabindex="0" style="display:block;width:20px;height:20px"></div><span id="shadow-email-name">Shadow work email</span><input id="shadow-email" aria-labelledby="shadow-email-name"><input id="image-search" type="image" alt="Search" style="display:block;width:20px;height:20px">';
        body.insertAdjacentHTML(
          "afterbegin",
          '<span id="shared-name">Outer volume</span><label for="shadow-associated">Outer email</label>',
        );
        host.shadowRoot!.innerHTML +=
          '<label for="shadow-associated">Shadow email</label><input id="shadow-associated">';
      });
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const rows = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: "https://merchant.invalid",
        canonical: true,
      }).rows;
      const labelFor = (id: string): string | undefined => {
        const element = capture.elements.find((candidate) => candidate.id === id)!;
        return rows.find((row) => row.ref === handles.get(element))?.label;
      };

      expect(labelFor("work-email")).toBe("@work-email");
      expect(labelFor("account-email")).toBe("@account-email");
      expect(labelFor("query-email")).toMatch(/^@billing-contact(?:-\d+)?$/);
      expect(labelFor("checkout")).toBe("@checkout");
      expect(labelFor("preferences")).toBe("@設定");
      expect(labelFor("empty-volume")).toBe("@master-volume");
      expect(labelFor("volume")).toBe("@volume-controls-button");
      expect(labelFor("structural-floor")).toMatch(/^@button-\d+$/);
      expect(labelFor("shadow-volume")).toBe("@shadow-volume");
      expect(labelFor("shadow-floor")).toBe("@shadow-volume-controls-button");
      expect(labelFor("shadow-email")).toBe("@shadow-work-email");
      expect(labelFor("shadow-associated")).toBe("@shadow-email");
      expect(labelFor("image-search")).toBe("@search");
      const queryEmail = capture.elements.find((candidate) => candidate.id === "query-email")!;
      expect(controlMatchesPrivateQueryV2(queryEmail, "work email")).toBe(true);
      expect(controlMatchesPrivateQueryV2(queryEmail, "billing contact")).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("keeps a standard direct-listener control actionable", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<span id="listener">Continue</span>');
      await page
        .locator("#listener")
        .evaluate((element) =>
          element.addEventListener("click", () => element.setAttribute("data-clicked", "yes")),
        );
      const capture = await captureThroughController(page);
      const listener = capture.elements.find((element) => element.id === "listener")!;
      expect(listener).toMatchObject({ tag: "span" });
      await page.locator(listener.selector).click();
      expect(await page.locator("#listener").getAttribute("data-clicked")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("finds a standard listener after ordinary visible content", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `${Array.from({ length: 1_000 }, (_, index) => `<span id="ordinary-${index}">Item</span>`).join("")}<span id="late-listener">Continue</span>`,
      );
      await page
        .locator("#late-listener")
        .evaluate((element) =>
          element.addEventListener("click", () => element.setAttribute("data-clicked", "yes")),
        );
      const capture = await captureThroughController(page);
      const listener = capture.elements.find((element) => element.id === "late-listener")!;
      expect(listener).toMatchObject({ tag: "span" });
      await page.locator(listener.selector).click();
      expect(await page.locator("#late-listener").getAttribute("data-clicked")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("does not invoke form-associated accessors during observation", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>getter-form-control, data-form-control { display:block; width:20px; height:20px }</style>
        <form id="form"><getter-form-control id="getter-control"></getter-form-control><data-form-control id="data-control" aria-label="Add to cart">Add</data-form-control></form>`);
      await page.locator("#form").evaluate((form) =>
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          form.setAttribute("data-submitted", "yes");
        }),
      );
      const getterReads = await page.evaluate(() => {
        let reads = 0;
        document.body.setAttribute("data-form-associated-reads", "0");
        customElements.define(
          "getter-form-control",
          class extends HTMLElement {
            static get formAssociated() {
              reads += 1;
              document.body.setAttribute("data-form-associated-reads", String(reads));
              if (reads > 1) document.querySelector<HTMLFormElement>("#form")?.requestSubmit();
              return true;
            }
          },
        );
        customElements.define(
          "data-form-control",
          class extends HTMLElement {
            static formAssociated = true;
            constructor() {
              super();
              this.attachInternals();
            }
          },
        );
        return reads;
      });
      const capture = await captureThroughController(page);
      expect(await page.locator("#form").getAttribute("data-submitted")).toBeNull();
      expect(await page.locator("body").getAttribute("data-form-associated-reads")).toBe(
        String(getterReads),
      );
      expect(capture.elements.some((element) => element.id === "getter-control")).toBe(false);
      expect(capture.elements.find((element) => element.id === "data-control")).toMatchObject({
        tag: "data-form-control",
      });
    } finally {
      await page.close();
    }
  });

  it("does not invoke page-owned shadow-root accessors during observation", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form id="form">
        <button id="native-buy" type="submit" name="add">Add to cart</button>
        <shadow-accessor-control id="guard"></shadow-accessor-control>
      </form>`);
      await page.locator("#form").evaluate((form) =>
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          form.setAttribute("data-submitted", "yes");
        }),
      );
      await page.locator("#guard").evaluate((element) => {
        let reads = 0;
        document.body.setAttribute("data-shadow-root-reads", "0");
        Object.defineProperty(element, "shadowRoot", {
          get() {
            reads += 1;
            document.body.setAttribute("data-shadow-root-reads", String(reads));
            document.querySelector<HTMLFormElement>("#form")?.requestSubmit();
            return null;
          },
        });
      });
      const capture = await captureThroughController(page);
      expect(await page.locator("body").getAttribute("data-shadow-root-reads")).toBe("0");
      expect(await page.locator("#form").getAttribute("data-submitted")).toBeNull();
      const buy = capture.elements.find((element) => element.id === "native-buy")!;
      expect(buy).toMatchObject({ tag: "button", name: "add", type: "submit" });
      await page.locator(buy.selector).click();
      expect(await page.locator("#form").getAttribute("data-submitted")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("binds persistent capabilities to physical nodes across fresh CDP captures", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return { capture, handles };
    };
    try {
      await page.setContent('<main><button id="held">Continue</button><p>Before</p></main>');
      const first = await read();
      const held = first.capture.elements.find((el) => el.id === "held")!;
      const ref = first.handles.get(held)!;
      expect(ref).toMatch(/^@e:[A-Za-z0-9_-]{22}$/);
      await page.locator("main").evaluate((main) => {
        main.querySelector("p")!.textContent = "Unrelated content changed";
        const sibling = document.createElement("button");
        sibling.textContent = "Continue";
        main.prepend(sibling);
      });
      const second = await read();
      const same = second.capture.elements.find((el) => el.id === "held")!;
      expect(same.observationIdentity).toBe(held.observationIdentity);
      expect(same.observationIntent).toBe(held.observationIntent);
      expect(second.handles.get(same)).toBe(ref);
      await page.locator("#held").evaluate((el) => el.replaceWith(el.cloneNode(true)));
      const third = await read();
      const replacement = third.capture.elements.find((el) => el.id === "held")!;
      expect(replacement.observationIdentity).not.toBe(held.observationIdentity);
      expect([...third.handles.values()]).not.toContain(ref);
      const replacementRef = third.handles.get(replacement)!;
      await page.locator("#held").evaluate((el) => {
        el.textContent = "Delete account";
      });
      const fourth = await read();
      expect([...fourth.handles.values()]).not.toContain(replacementRef);
      await page.locator("#held").evaluate((el) => {
        el.textContent = "Continue";
      });
      expect([...(await read()).handles.values()]).not.toContain(replacementRef);
      await page.locator("#held").evaluate((el) => el.remove());
      expect((await read()).capture.elements.some((el) => el.id === "held")).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("retires a held anchor when its form changes destination", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return handles.get(capture.elements.find((el) => el.id === "submit")!);
    };
    try {
      await page.setContent(
        '<form id="form" action="/safe"><button id="submit">Continue</button></form>',
      );
      const submit = await read();
      expect(submit).toBeDefined();
      await page.locator("form").evaluate((form) => form.setAttribute("action", "/delete"));
      expect(await read()).not.toBe(submit);
      // Explicit ownership outside the form is subject to the same check.
      await page.locator("#submit").evaluate((button) => {
        document.body.append(button);
        button.setAttribute("form", "form");
      });
      const explicit = await read();
      expect(explicit).toBeDefined();
      await page.locator("form").evaluate((form) => form.setAttribute("action", "/other"));
      expect(await read()).not.toBe(explicit);
    } finally {
      await page.close();
    }
  });

  it("finds Shopify owned buy controls and folds repeated custom-element content", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(
        readFileSync(
          new URL("../../../../../fixtures/browser-use/pages/shopify.html", import.meta.url),
          "utf8",
        ),
      );
      const capture = await captureThroughController(page);
      const buy = capture.elements.filter(
        (el) => el.tag === "button" && controlMatchesPrivateQueryV2(el, "add to cart"),
      );
      expect(buy).toHaveLength(4);
      expect(buy.every((el) => el.name === "add" && el.type === "submit")).toBe(true);
      const refs = new StableObservationRefs();
      const handles = new Map(capture.elements.map((el) => [el, refs.get("shop", el.selector)]));
      const rows = buildSafeControlsV2({
        elements: capture.elements,
        handles,
        legacyRefs: handles,
        pageOrigin: "https://shop.example",
        canonical: true,
      }).rows;
      for (const el of buy) {
        expect(rows.find((row) => row.ref === handles.get(el))?.role).toBe("button");
        expect(handles.get(el)).toMatch(/^@e:[A-Za-z0-9_-]{22}$/);
      }
      for (const el of buy) await page.locator(el.selector).click();
      expect(await page.evaluate(() => (window as unknown as { cart: string[] }).cart)).toEqual([
        "Jade ring",
        "Jade pendant",
        "Jade earrings",
        "Jade bracelet",
      ]);
      expect(capture.elements.some((el) => el.tag === "form-buy-component")).toBe(true);
      expect(capture.elements.some((el) => el.tag === "search-decoration")).toBe(false);
      const dom = serializeBrowserUseDOM(capture.root).dom;
      expect(dom).toContain("[repeated ×3]");
      expect(dom).toContain("product-card-component repeated ×4");
      expect(dom.match(/Natural jade, polished by hand/g)).toHaveLength(1);
      expect(dom.match(/\[same subtree /g)).toHaveLength(3);
      for (const [id, el] of capture.nodeElements) {
        if (buy.includes(el)) expect(dom).toContain(`[${id}]<button`);
      }
      for (const name of ["Jade ring", "Jade pendant", "Jade earrings", "Jade bracelet"])
        expect(dom).toContain(name);
    } finally {
      await page.close();
    }
  });

  it("uses only the effective owner for an explicit duplicate-id form control", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const submitter = capture.elements.find((element) => element.id === "submitter")!;
      return { element: submitter, ref: refs.actions("doc", capture.elements).get(submitter)! };
    };
    try {
      await page.setContent(`
        <form id="payment" action="/safe"></form>
        <form id="payment" action="/other"></form>
        <button id="submitter" form="payment">Pay</button>
      `);
      const held = await read();
      await page
        .locator("form:nth-of-type(2)")
        .evaluate((form) => form.setAttribute("action", "/changed"));
      const afterNonOwnerChange = await read();
      expect(afterNonOwnerChange.element.observationIdentity).toBe(
        held.element.observationIdentity,
      );
      expect(afterNonOwnerChange.ref).toBe(held.ref);
      await page
        .locator("form:nth-of-type(1)")
        .evaluate((form) => form.setAttribute("action", "/danger"));
      expect((await read()).ref).not.toBe(held.ref);
    } finally {
      await page.close();
    }
  });

  it("does not inherit form intent across an open shadow boundary", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const control = capture.elements.find((element) => element.id === "shadow-control")!;
      return { element: control, ref: refs.actions("doc", capture.elements).get(control)! };
    };
    try {
      await page.setContent('<form id="form" action="/safe"><div id="host"></div></form>');
      await page.locator("#host").evaluate((host) => {
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = '<button id="shadow-control" type="button">Continue</button>';
      });
      const held = await read();
      await page.locator("#form").evaluate((form) => form.setAttribute("action", "/other"));
      const afterParentChange = await read();
      expect(afterParentChange.element.observationIdentity).toBe(held.element.observationIdentity);
      expect(afterParentChange.ref).toBe(held.ref);
    } finally {
      await page.close();
    }
  });

  it("keeps non-submit controls and iframe wrappers stable across parent form changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return new Map(
        ["help", "google"].map((id) => {
          const element = capture.elements.find((candidate) => candidate.id === id)!;
          return [id, { identity: element.observationIdentity, ref: handles.get(element)! }];
        }),
      );
    };
    try {
      await page.setContent(`
        <form id="form" action="/safe">
          <button id="help" type="button">Help</button>
          <iframe
            id="google"
            src="https://accounts.google.com/gsi/button"
            style="width: 200px; height: 48px"
          ></iframe>
        </form>
      `);
      const held = await read();
      expect([...held.values()].every(({ ref }) => ref !== undefined)).toBe(true);
      await page.locator("#form").evaluate((form) => form.setAttribute("action", "/other"));
      const changed = await read();
      for (const id of held.keys()) {
        expect(changed.get(id)!.identity).toBe(held.get(id)!.identity);
        expect(changed.get(id)!.ref).toBe(held.get(id)!.ref);
      }
    } finally {
      await page.close();
    }
  });

  it("retires persistent anchors when only a base URL retargets relative actions", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return { capture, handles };
    };
    try {
      await page.setContent(`
        <base id="base" href="https://safe.example/checkout/">
        <a id="link" href="continue">Continue</a>
        <form id="form" action="submit"><button id="inherited">Pay</button></form>
        <button id="submitter" form="form" formaction="confirm">Confirm</button>
      `);
      const first = await read();
      const held = new Map(
        ["link", "inherited", "submitter"].map((id) => {
          const element = first.capture.elements.find((candidate) => candidate.id === id)!;
          return [id, { identity: element.observationIdentity, ref: first.handles.get(element)! }];
        }),
      );
      expect([...held.values()].every(({ ref }) => ref !== undefined)).toBe(true);
      await page.locator("#base").evaluate((base) => {
        base.setAttribute("href", "https://attacker.example/checkout/");
      });
      expect(
        await page.evaluate(() => [
          document.querySelector("#link")!.getAttribute("href"),
          document.querySelector("#form")!.getAttribute("action"),
          document.querySelector("#submitter")!.getAttribute("formaction"),
        ]),
      ).toEqual(["continue", "submit", "confirm"]);
      const second = await read();
      for (const id of held.keys()) {
        const element = second.capture.elements.find((candidate) => candidate.id === id)!;
        const prior = held.get(id)!;
        expect(element.observationIdentity).toBe(prior.identity);
        expect(second.handles.get(element)).not.toBe(prior.ref);
      }
    } finally {
      await page.close();
    }
  });

  it("does not borrow custom wrapper labels across competing controls or hidden subtrees", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>multi-control, one-control { display:block }</style>
        <multi-control aria-label="Add to cart"><button>Favorite</button><button>Compare</button></multi-control>
        <one-control aria-label="Purchase item"><button aria-label="Explicit choice">Choose</button></one-control>
        <one-control aria-label="Hidden choice" style="display:none"><button>Hidden</button></one-control>
        <div id="host"></div>`);
      await page.locator("#host").evaluate((host) => {
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML =
          '<click-component style="display:block">Add to cart in shadow</click-component>';
        root
          .querySelector("click-component")!
          .addEventListener("click", () => host.setAttribute("data-clicked", "yes"));
      });
      const capture = await captureThroughController(page);
      expect(
        capture.elements.filter((el) => controlMatchesPrivateQueryV2(el, "add to cart")),
      ).toHaveLength(1);
      expect(capture.elements.some((el) => el.ariaLabel === "Explicit choice")).toBe(true);
      expect(capture.elements.some((el) => el.ariaLabel === "Hidden choice")).toBe(false);
      const shadow = capture.elements.find((el) => el.tag === "click-component")!;
      expect(shadow).toBeDefined();
      await page.locator(shadow.selector).click();
      expect(await page.locator("#host").getAttribute("data-clicked")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("retires form and link anchors when only the base target changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return new Map(
        ["link", "submitter"].map((id) => {
          const element = capture.elements.find((candidate) => candidate.id === id)!;
          return [id, { identity: element.observationIdentity, ref: handles.get(element)! }];
        }),
      );
    };
    try {
      await page.setContent(`
        <base id="base" target="safe-window">
        <a id="link" href="/continue">Continue</a>
        <form><button id="submitter">Pay</button></form>
      `);
      const first = await read();
      await page
        .locator("#base")
        .evaluate((base) => base.setAttribute("target", "attacker-window"));
      const second = await read();
      for (const id of first.keys()) {
        expect(second.get(id)!.identity).toBe(first.get(id)!.identity);
        expect(second.get(id)!.ref).not.toBe(first.get(id)!.ref);
      }
    } finally {
      await page.close();
    }
  });

  it("keeps anchors stable when reserved target keyword casing changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return new Map(
        ["link", "form-submit", "submitter"].map((id) => {
          const element = capture.elements.find((candidate) => candidate.id === id)!;
          return [id, { identity: element.observationIdentity, ref: handles.get(element)! }];
        }),
      );
    };
    try {
      await page.setContent(`
        <a id="link" href="/continue" target="_BLANK">Continue</a>
        <form id="form" target="_PARENT"><button id="form-submit">Pay</button></form>
        <form><button id="submitter" formtarget="_TOP">Confirm</button></form>
      `);
      const held = await read();
      await page.locator("#link").evaluate((element) => element.setAttribute("target", "_blank"));
      await page.locator("#form").evaluate((element) => element.setAttribute("target", "_parent"));
      await page
        .locator("#submitter")
        .evaluate((element) => element.setAttribute("formtarget", "_top"));
      const changed = await read();
      for (const id of held.keys()) {
        expect(changed.get(id)!.identity).toBe(held.get(id)!.identity);
        expect(changed.get(id)!.ref).toBe(held.get(id)!.ref);
      }
    } finally {
      await page.close();
    }
  });

  it("gives a labelled custom wrapper's sole enabled buy control its label", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>add-to-cart-component, slideshow-slide { display:block }</style>
        <form id="cart-form"><add-to-cart-component aria-label="Add to cart">
          <button id="sold-out" disabled>Sold out</button>
          <a class="icon"></a>
          <quick-add-component aria-disabled="true" role="button"></quick-add-component>
          <button id="buy" type="submit" name="add"></button>
        </add-to-cart-component></form>
        <slideshow-slide id="focus-only" tabindex="0">Focus-only slide</slideshow-slide>`);
      await page.locator("#cart-form").evaluate((form) =>
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          form.setAttribute("data-submitted", "yes");
        }),
      );
      const capture = await captureThroughController(page);
      const buy = capture.elements.filter(
        (el) => el.tag === "button" && controlMatchesPrivateQueryV2(el, "add to cart"),
      );
      expect(buy).toHaveLength(1);
      expect(buy[0]).toMatchObject({ id: "buy", name: "add", type: "submit" });
      expect(capture.elements.find((el) => el.id === "sold-out")).toMatchObject({
        disabled: true,
      });
      expect(capture.elements.some((el) => el.id === "focus-only")).toBe(false);
      await page.locator(buy[0]!.selector).click();
      expect(await page.locator("#cart-form").getAttribute("data-submitted")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("distinguishes empty navigation targets from inherited base targets", async () => {
    const page = await browser.newPage();
    const assertStale = async (markup: string, id: string, selector: string, attribute: string) => {
      const refs = new StableObservationRefs();
      const read = async () => {
        const capture = await captureThroughController(page);
        const element = capture.elements.find((candidate) => candidate.id === id)!;
        return { element, ref: refs.actions("doc", capture.elements).get(element)! };
      };
      await page.setContent(markup);
      const held = await read();
      await page
        .locator(selector)
        .evaluate((element, name) => element.setAttribute(name, ""), attribute);
      const changed = await read();
      expect(changed.element.observationIdentity).toBe(held.element.observationIdentity);
      expect(changed.ref).not.toBe(held.ref);
    };
    try {
      await assertStale(
        '<base target="receipt"><a id="link" href="/continue">Continue</a>',
        "link",
        "#link",
        "target",
      );
      await assertStale(
        '<base target="receipt"><form id="form"><button id="submitter">Pay</button></form>',
        "submitter",
        "#form",
        "target",
      );
      await assertStale(
        '<base target="receipt"><form><button id="submitter">Pay</button></form>',
        "submitter",
        "#submitter",
        "formtarget",
      );
    } finally {
      await page.close();
    }
  });

  it("keeps empty and missing submission actions stable across base URL changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const handles = refs.actions("doc", capture.elements);
      return new Map(
        ["empty-form", "empty-submitter", "missing-form"].map((id) => {
          const element = capture.elements.find((candidate) => candidate.id === id)!;
          return [id, { identity: element.observationIdentity, ref: handles.get(element)! }];
        }),
      );
    };
    try {
      await page.setContent(`
        <base id="base" href="https://safe.example/">
        <form action=""><button id="empty-form">Pay</button><button id="empty-submitter" formaction="">Confirm</button></form>
        <form><button id="missing-form">Continue</button></form>
      `);
      const first = await read();
      await page
        .locator("#base")
        .evaluate((base) => base.setAttribute("href", "https://other.example/"));
      const second = await read();
      for (const id of first.keys()) {
        expect(second.get(id)!.identity).toBe(first.get(id)!.identity);
        expect(second.get(id)!.ref).toBe(first.get(id)!.ref);
      }
    } finally {
      await page.close();
    }
  });

  it("retires a held submitter when effective submission semantics change", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const submitter = capture.elements.find((element) => element.id === "submitter")!;
      return { element: submitter, ref: refs.actions("doc", capture.elements).get(submitter)! };
    };
    try {
      await page.setContent(`
        <form id="form" method="post" target="receipt" enctype="multipart/form-data">
          <button id="submitter">Pay</button>
        </form>
      `);
      let held = await read();
      const mutate = async (selector: string, attribute: string, value = "") => {
        await page
          .locator(selector)
          .evaluate((element, change) => element.setAttribute(change.attribute, change.value), {
            attribute,
            value,
          });
        const next = await read();
        expect(next.element.observationIdentity).toBe(held.element.observationIdentity);
        expect(next.ref).not.toBe(held.ref);
        held = next;
      };
      await mutate("#form", "method", "get");
      await mutate("#form", "target", "receipt-next");
      await mutate("#form", "enctype", "text/plain");
      await mutate("#submitter", "formmethod", "post");
      await mutate("#submitter", "formtarget", "receipt-final");
      await mutate("#submitter", "formenctype", "multipart/form-data");
      await mutate("#submitter", "formnovalidate");
      await page
        .locator("#submitter")
        .evaluate((element) => element.removeAttribute("formnovalidate"));
      const afterValidationRestore = await read();
      expect(afterValidationRestore.ref).not.toBe(held.ref);
    } finally {
      await page.close();
    }
  });

  it("does not transfer wrapper labels across an enabled wrapper control", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>add-to-cart-component { display:block }</style>
        <form><add-to-cart-component id="owner" aria-label="Add to cart" onclick="this.dataset.clicked='yes'">
          <button id="nested-buy" type="submit" name="add"></button>
        </add-to-cart-component></form>`);
      const capture = await captureThroughController(page);
      const buy = capture.elements.filter((el) => controlMatchesPrivateQueryV2(el, "add to cart"));
      expect(buy.map((el) => el.id)).toEqual(["owner"]);
      await page.locator(buy[0]!.selector).click();
      expect(await page.locator("#owner").getAttribute("data-clicked")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("prioritizes late custom buy controls over decorative elements", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(`<style>quick-add-component, late-form-buy { display:block; height:24px }</style>
        <div id="decorations"></div>
        <late-form-buy id="late-form" aria-label="Add to cart late form"></late-form-buy>
        <quick-add-component id="late-role" role="button" aria-label="Add to cart late role"></quick-add-component>
        <quick-add-component id="late-listener" aria-label="Add to cart late listener"></quick-add-component>`);
      await page.locator("#decorations").evaluate((decorations) => {
        decorations.innerHTML = Array.from(
          { length: 120 },
          () => "<decorative-control></decorative-control>",
        ).join("");
      });
      await page.evaluate(() => {
        customElements.define(
          "late-form-buy",
          class extends HTMLElement {
            static formAssociated = true;
            constructor() {
              super();
              this.attachInternals();
            }
          },
        );
      });
      await page
        .locator("#late-listener")
        .evaluate((el) =>
          el.addEventListener("click", () => el.setAttribute("data-clicked", "yes")),
        );
      const capture = await captureThroughController(page);
      const buy = capture.elements.filter((el) => controlMatchesPrivateQueryV2(el, "add to cart"));
      expect(buy.map((el) => el.id).sort()).toEqual(["late-form", "late-listener", "late-role"]);
      const listener = buy.find((el) => el.id === "late-listener")!;
      await page.locator(listener.selector).click();
      expect(await page.locator("#late-listener").getAttribute("data-clicked")).toBe("yes");
    } finally {
      await page.close();
    }
  });

  it("retires a held submitter when its submitted value changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const submitter = capture.elements.find((element) => element.id === "submitter")!;
      return { element: submitter, ref: refs.actions("doc", capture.elements).get(submitter)! };
    };
    try {
      await page.setContent(
        '<form><button id="submitter" name="operation" value="safe">Pay</button></form>',
      );
      const held = await read();
      await page
        .locator("#submitter")
        .evaluate((element) => element.setAttribute("value", "delete"));
      const changed = await read();
      expect(changed.element.observationIdentity).toBe(held.element.observationIdentity);
      expect(changed.ref).not.toBe(held.ref);
    } finally {
      await page.close();
    }
  });

  it("retires a held link when download mode changes", async () => {
    const page = await browser.newPage();
    const refs = new StableObservationRefs();
    const read = async () => {
      const capture = await captureThroughController(page);
      const link = capture.elements.find((element) => element.id === "contract")!;
      return { element: link, ref: refs.actions("doc", capture.elements).get(link)! };
    };
    try {
      await page.setContent('<a id="contract" href="/contract.pdf">View contract</a>');
      const held = await read();
      await page
        .locator("#contract")
        .evaluate((element) => element.setAttribute("download", "invoice.pdf"));
      const changed = await read();
      expect(changed.element.observationIdentity).toBe(held.element.observationIdentity);
      expect(changed.ref).not.toBe(held.ref);
    } finally {
      await page.close();
    }
  });

  it("returns rendered API keys, app slugs, key names and documentation JSON verbatim", async () => {
    const page = await browser.newPage();
    // The first two are exact reported false positives. Key names and requestId
    // are synthetic representatives: the brief did not supply their literals.
    const values = [
      "usernametaken29",
      "trusty-squire-dogfood-20260625",
      "resend-dogfood-20260907",
      "trusty-squire-resend-20260907",
      '"requestId": "550e8400-e29b-41d4-a716-446655440000"',
      "sk" + "-proj-0123456789abcdefghijklmnop",
      "f9a062f0-2fadf5ab-9c1d2e3f",
      "key_3kR9xQ2m_7LpW4vZn",
    ];
    try {
      await page.setContent("<main></main>");
      await page.locator("main").evaluate((main, values) => {
        for (const value of values) {
          const paragraph = document.createElement("p");
          paragraph.textContent = value;
          const button = document.createElement("button");
          button.setAttribute("aria-label", value);
          button.textContent = value;
          const input = document.createElement("input");
          input.type = "text";
          input.value = value;
          main.append(paragraph, button, input);
        }
      }, values);
      const capture = await captureThroughController(page);
      const { dom } = serializeBrowserUseDOM(capture.root);
      for (const value of values) {
        expect(dom).toContain(value);
        expect(dom).toContain(`aria-label=${value}`);
        expect(dom).toContain(`value=${value}`);
      }
      expect(dom).not.toContain("[redacted]");
    } finally {
      await page.close();
    }
  });
  it("surfaces actual selection evidence while a stateless card stays reachable with its original ref", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        readFileSync(
          new URL(
            "../../../../../fixtures/observation-efficiency/selectable-cards.html",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const refs = new StableObservationRefs();
      const capture = await captureThroughController(page);
      const ref = (n: BrowserUseNode): string => refs.get("doc", n.id);
      const before = serializeBrowserUseDOM(capture.root, { ref });
      const row = (dom: string, id: string): string =>
        dom.split("\n").find((line) => line.includes(`id=${id} `))!;
      const stateless = row(before.dom, "stateless");
      expect(stateless).not.toMatch(
        /(?:aria-pressed|aria-selected|data-state|selected|state_icons)=/,
      );
      const stable = stateless.match(/\[([^\]]+)\]/)![1]!;
      const boundNode = [...capture.nodeElements].find(
        ([id]) => refs.get("doc", id) === stable,
      )![1];
      await page.locator(boundNode.selector).click();
      for (const id of ["pressed", "classified", "icon", "selected", "data"])
        await page.locator(`#${id}`).click();
      const after = serializeBrowserUseDOM((await captureThroughController(page)).root, { ref });
      expect(row(after.dom, "stateless")).toBe(stateless);
      expect(row(before.dom, "pressed")).toContain("aria-pressed=false");
      expect(row(after.dom, "pressed")).toContain("aria-pressed=true");
      expect(row(after.dom, "selected")).toContain("aria-selected=true");
      expect(row(after.dom, "data")).toContain("data-state=checked");
      expect(row(after.dom, "classified")).toContain("border-selected");
      expect(row(after.dom, "icon")).toContain('state_icons=["check-icon"]');
      expect(after.refs).toContain(stable);
      expect(
        await page.evaluate(
          () => (window as unknown as { cardClicks: Record<string, number> }).cardClicks.stateless,
        ),
      ).toBe(1);
      expect(row(after.dom, "classified")).not.toContain("selected=true");
    } finally {
      await page.close();
    }
  });
  it("keeps hierarchy and prose and retrieves a below-the-fold control from the whole document", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(
        '<!doctype html><html><body><p>Account overview</p><button><span>Continue signup</span></button><div style="height:1800px"></div><button id="below">Create workspace below</button></body></html>',
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const dom = serializeBrowserUseDOM(capture.root).dom;
      expect(dom).toContain("Account overview");
      expect(dom).toMatch(/\[main:\d+\]<button \/>\n\tContinue signup/);
      expect(dom).not.toContain("Create workspace below");
      expect(capture.moreBelow).toBe(true);
      expect(capture.moreAbove).toBe(false);
      const below = capture.elements.find((e) => e.id === "below");
      expect(below?.visibleText).toContain("Create workspace below");
      expect(below?.inViewport).toBe(false);
      await page.locator(below!.selector).scrollIntoViewIfNeeded();
      const after = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      expect(serializeBrowserUseDOM(after.root).dom).toContain("Create workspace below");
      expect(after.moreAbove).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("uses only capped local context for below-fold iframe controls", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent('<iframe id="support" style="width: 400px; height: 100px"></iframe>');
      const frame = await (await page.locator("#support").elementHandle())!.contentFrame();
      const local = "Local support preference";
      await frame!.setContent(
        `<section>Whole section context must not be inherited <div style="margin-top: 800px">${local}<span><button id="below"></button></span></div></section>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const findFrame = (node: BrowserUseNode): BrowserUseNode | undefined =>
        node.nodeName === "IFRAME"
          ? node
          : node.children.map(findFrame).find((value) => value !== undefined) ||
            (node.contentDocument ? findFrame(node.contentDocument) : undefined);
      const hint = findFrame(capture.root)?.hiddenElements.find(
        (element) => element.tag === "button",
      );
      expect(hint?.text).toBe(local);
      expect(hint?.text).not.toContain("Whole section context");
    } finally {
      await page.close();
    }
  });
  it("keeps CSS-hidden descendants out of fallback context", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<div>Notification preferences<div style="display:none">private tier</div><input type="checkbox"></div>',
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const dom = serializeBrowserUseDOM(capture.root).dom;
      const input = dom.split("\n").find((line) => line.includes("<input"));
      expect(input).toContain("context=Notification preferences");
      expect(dom).not.toContain("private tier");
    } finally {
      await page.close();
    }
  });
  it("rejects oversized iframe containers before inheriting their text", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent('<iframe id="support" style="width: 400px; height: 100px"></iframe>');
      const frame = await (await page.locator("#support").elementHandle())!.contentFrame();
      const broad = "Oversized generic container ".repeat(4);
      await frame!.setContent(
        `<div style="margin-top: 800px">${broad}<span><button id="below"></button></span></div>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const findFrame = (node: BrowserUseNode): BrowserUseNode | undefined =>
        node.nodeName === "IFRAME"
          ? node
          : node.children.map(findFrame).find((value) => value !== undefined) ||
            (node.contentDocument ? findFrame(node.contentDocument) : undefined);
      const hint = findFrame(capture.root)?.hiddenElements.find(
        (element) => element.tag === "button",
      );
      expect(hint?.text).toBe("(no label)");
      expect(hint?.text).not.toContain("Oversized generic container");
    } finally {
      await page.close();
    }
  });
  it("uses captured heading context when an iframe action has no snapshot label", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent('<iframe id="support" style="width: 400px; height: 100px"></iframe>');
      const frame = await (await page.locator("#support").elementHandle())!.contentFrame();
      await frame!.setContent(
        '<section><header><h2>Billing</h2></header><div style="margin-top: 800px"><span><button id="below"></button></span></div></section>',
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const findFrame = (node: BrowserUseNode): BrowserUseNode | undefined =>
        node.nodeName === "IFRAME"
          ? node
          : node.children.map(findFrame).find((value) => value !== undefined) ||
            (node.contentDocument ? findFrame(node.contentDocument) : undefined);
      const hint = findFrame(capture.root)?.hiddenElements.find(
        (element) => element.tag === "button",
      );
      expect(hint?.text).toBe("Billing");
    } finally {
      await page.close();
    }
  });
  it("does not use hidden iframe descendants as an action label fallback", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent('<iframe id="support" style="width: 400px; height: 100px"></iframe>');
      const frame = await (await page.locator("#support").elementHandle())!.contentFrame();
      await frame!.setContent(
        '<div style="margin-top: 800px"><button id="below"><span style="display:none">private tier</span></button></div>',
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const findFrame = (node: BrowserUseNode): BrowserUseNode | undefined =>
        node.nodeName === "IFRAME"
          ? node
          : node.children.map(findFrame).find((value) => value !== undefined) ||
            (node.contentDocument ? findFrame(node.contentDocument) : undefined);
      const hint = findFrame(capture.root)?.hiddenElements.find(
        (element) => element.tag === "button",
      );
      expect(hint?.text).toBe("(no label)");
      expect(serializeBrowserUseDOM(capture.root).dom).toContain('<button> "(no label)"');
    } finally {
      await page.close();
    }
  });
  it("keeps capture geometry in CSS pixels on a scaled display after scrolling", async () => {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      await page.setContent(
        '<!doctype html><html><body><div style="height:1800px"></div><button id="below">Still below the fold</button><div style="height:1200px"></div></body></html>',
      );
      await page.evaluate(() => window.scrollTo(0, 600));
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const below = capture.elements.find((element) => element.id === "below");
      expect(below?.inViewport).toBe(false);
      expect(serializeBrowserUseDOM(capture.root).dom).not.toContain("Still below the fold");
      expect(capture.moreAbove).toBe(true);
      expect(capture.moreBelow).toBe(true);
    } finally {
      await context.close();
    }
  });
  it("binds controls in same-origin and cross-origin frames to their own documents", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/child"
          ? '<button id="child">Cross origin action</button>'
          : request.url === "/same"
            ? '<button id="same">Same origin action</button>'
            : `<iframe src="/same"></iframe><iframe src="http://localhost:${(server.address() as AddressInfo).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const capture = await captureThroughController(page);
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          expect(element, `unbound frame control ${node.id}`).toBeDefined();
          return `@e:${element!.index}`;
        },
      });
      expect(output.dom).toContain("Same origin action");
      expect(output.dom).toContain("Cross origin action");
      const child = capture.elements.find((element) => element.id === "child")!;
      const same = capture.elements.find((element) => element.id === "same")!;
      expect(child.frameUrl).toContain("http://localhost:");
      expect(same.frameUrl).toContain("http://127.0.0.1:");
      await page
        .frames()
        .find((frame) => frame.url() === child.frameUrl)!
        .locator(child.selector)
        .click();
      await page
        .frames()
        .find((frame) => frame.url() === same.frameUrl)!
        .locator(same.selector)
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps an unmapped child control non-targetable when its selector collides with the main document", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="shared" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=shared>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              const result = await send(method, params);
              if (method !== "Page.getFrameTree") return result;
              const tree = structuredClone(result) as {
                frameTree: { childFrames?: Array<{ frame: { url: string } }> };
              };
              tree.frameTree.childFrames![0]!.frame.url = "https://stale.example/child";
              return tree;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi
        .spyOn(context, "newCDPSession")
        .mockImplementation(async (target) => {
          if (target === page) return intercepted;
          throw new Error("No frame with given id");
        });
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      const lines = output.dom.split("\n");
      const childTextLine = lines.findIndex((line) => line.includes("Child action"));
      expect(childTextLine).toBeGreaterThan(0);
      expect(lines[childTextLine - 1]).toMatch(
        /\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/,
      );
      expect(capture.elements.some((element) => element.visibleText === "Child action")).toBe(
        false,
      );
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      expect(main.framePath).toBeNull();
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
    }
  });
  it("keeps same-URL child navigation from rebinding a captured control", async () => {
    let childLoads = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/child") {
        childLoads += 1;
        response.end(
          childLoads === 1
            ? '<button id="shared">Captured child action</button>'
            : '<button id="shared">Replacement child action</button>',
        );
        return;
      }
      response.end(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe src="/child"></iframe>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const childUrl = `${baseUrl}/child`;
      await page.goto(baseUrl);
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      let childFrameId: string | undefined;
      let navigated = false;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (
                method === "Page.createIsolatedWorld" &&
                params?.frameId === childFrameId &&
                !navigated
              ) {
                navigated = true;
                await page
                  .frames()
                  .find((frame) => frame.url() === childUrl)!
                  .goto(childUrl);
              }
              const result = await send(method, params);
              if (method === "Page.getFrameTree") {
                const tree = result as {
                  frameTree: { childFrames?: Array<{ frame: { id: string } }> };
                };
                childFrameId = tree.frameTree.childFrames?.[0]?.frame.id;
              }
              return result;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const staleChild = {
        index: 7,
        tag: "button",
        type: null,
        id: "shared",
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "button",
        labelText: null,
        visibleText: "Captured child action",
        selector: "#shared",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
        framePath: "0",
      };
      const newCDPSession = vi.spyOn(context, "newCDPSession").mockResolvedValue(intercepted);
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(
          page,
          [staleChild],
          (frame) => (frame === page.mainFrame() ? null : "0"),
          transparentFrameSecurity,
        );
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      const lines = output.dom.split("\n");
      const capturedTextLine = lines.findIndex((line) => line.includes("Captured child action"));
      expect(childLoads).toBe(2);
      expect(capturedTextLine).toBeGreaterThan(0);
      expect(lines[capturedTextLine - 1]).toMatch(
        /\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/,
      );
      expect(
        capture.elements.some((element) => element.visibleText === "Captured child action"),
      ).toBe(false);
      expect(
        capture.elements.some((element) => element.visibleText === "Replacement child action"),
      ).toBe(false);
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps the parent observation usable when a child CDP session disappears during capture", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=child>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      type CapturedNode = {
        nodeName: string;
        children?: CapturedNode[];
        contentDocument?: unknown;
      };
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              const result = await send(method, params);
              if (method !== "DOM.getDocument") return result;
              const document = structuredClone(result) as {
                root: CapturedNode;
              };
              const stripChildDocuments = (node: CapturedNode): void => {
                if (node.nodeName === "IFRAME") delete node.contentDocument;
                for (const child of node.children ?? []) stripChildDocuments(child);
              };
              stripChildDocuments(document.root);
              return document;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi
        .spyOn(context, "newCDPSession")
        .mockImplementation(async (target) => {
          if (target === page) return intercepted;
          throw new Error("Target frame detached during capture");
        });
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
        expect(newCDPSession).toHaveBeenCalledTimes(2);
      } finally {
        newCDPSession.mockRestore();
      }
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      expect(output.dom).toContain("Main action");
      expect(output.dom).toContain("<iframe");
      expect(output.dom).not.toContain("Child action");
      const main = capture.elements.find((element) => element.visibleText === "Main action")!;
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
    }
  });
  it("keeps a captured child frame visible when its CDP binding world disappears", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button id="main" onclick="document.body.dataset.main = \'clicked\'">Main action</button><iframe srcdoc="<button id=child>Child action</button>"></iframe>',
      );
      const context = page.context();
      const session = await context.newCDPSession(page);
      const send = session.send.bind(session) as (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      let childFrameId: string | undefined;
      const intercepted = new Proxy(session, {
        get(target, property, receiver) {
          if (property === "send")
            return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (method === "Page.createIsolatedWorld" && params?.frameId === childFrameId)
                throw new Error("No frame with given id");
              const result = await send(method, params);
              if (method === "Page.getFrameTree") {
                const tree = result as {
                  frameTree: { childFrames?: Array<{ frame: { id: string } }> };
                };
                childFrameId = tree.frameTree.childFrames?.[0]?.frame.id;
              }
              return result;
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const newCDPSession = vi.spyOn(context, "newCDPSession").mockResolvedValue(intercepted);
      const framePath = (frame: Frame): string | null => {
        const indexes: number[] = [];
        let current: Frame | null = frame;
        while (current !== null) {
          const parent = current.parentFrame();
          if (parent === null) break;
          indexes.unshift(parent.childFrames().indexOf(current));
          current = parent;
        }
        return indexes.length ? indexes.join("/") : null;
      };
      const staleChild: InteractiveElement = {
        index: 99,
        tag: "button",
        type: null,
        id: "child",
        name: null,
        placeholder: null,
        ariaLabel: null,
        role: "button",
        labelText: null,
        visibleText: "Child action",
        selector: "#child",
        visible: true,
        inViewport: true,
        inConsentWidget: false,
        framePath: "0",
      };
      let capture: Awaited<ReturnType<typeof captureBrowserUseDOM>>;
      try {
        capture = await captureBrowserUseDOM(
          page,
          [staleChild],
          framePath,
          transparentFrameSecurity,
        );
      } finally {
        newCDPSession.mockRestore();
      }

      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element === undefined
            ? { ref: `@e:unbound_${node.id}`, targetable: false }
            : handles.get(element)!;
        },
      });

      expect(childFrameId).toBeDefined();
      expect(output.dom).toContain("Child action");
      expect(output.dom).toMatch(/\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/);
      expect(capture.elements.some((element) => element.id === "child")).toBe(false);
      expect([...safe.byRef.values()]).not.toContain("#child");
      const main = capture.elements.find((element) => element.id === "main")!;
      expect(main).toBeDefined();
      await page.locator(main.selector).click();
      expect(await page.locator("body").getAttribute("data-main")).toBe("clicked");
    } finally {
      await page.close();
    }
  });
  it("keeps a sandboxed synthesized control visible but outside action and query maps", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/child"
          ? '<span id="cross" onclick="window.clicked = true">Permitted cross-origin action</span>'
          : request.url === "/same"
            ? '<span id="same" onclick="window.clicked = true">Same-origin action</span>'
            : `<iframe src="/same"></iframe><iframe sandbox="allow-scripts" srcdoc='<span id="opaque" onclick="window.clicked = true">Opaque sandbox action</span>'></iframe><iframe src="http://localhost:${(server.address() as AddressInfo).port}/child"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(capture.elements.map((element) => element.id)).toEqual(
        expect.arrayContaining(["same", "cross"]),
      );
      expect(capture.elements.some((element) => element.id === "opaque")).toBe(false);
      expect(safe.rows.map((row) => row.ref)).toEqual([...safe.byRef.keys()]);
      expect(
        safe.rows.map(
          (row) => capture.elements.find((element) => handles.get(element) === row.ref)?.id,
        ),
      ).toEqual(expect.arrayContaining(["same", "cross"]));
      expect(output.dom).toContain("not-targetable=true");
      expect(output.dom).toContain("Opaque sandbox action");
      const sameFrame = page.frames().find((frame) => frame.url().endsWith("/same"));
      await sameFrame!.locator("#same").click();
      await page
        .frames()
        .find((frame) => frame.url().includes("localhost:"))!
        .locator("#cross")
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps active-origin opaque controls visible but outside action and query maps", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        request.url === "/normal"
          ? '<span id="normal-action" onclick="window.clicked = true">Normal frame action</span>'
          : request.url === "/opaque"
            ? '<span id="opaque-action" onclick="window.clicked = true">Active-origin opaque action</span>'
            : '<iframe src="/normal"></iframe><iframe id="opaque-frame" sandbox="allow-scripts" src="/opaque"></iframe>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await page.locator("#opaque-frame").evaluate((frame) => frame.removeAttribute("sandbox"));

      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(capture.elements.map((element) => element.id)).toContain("normal-action");
      expect(capture.elements.some((element) => element.id === "opaque-action")).toBe(false);
      expect(
        safe.rows.map(
          (row) => capture.elements.find((element) => handles.get(element) === row.ref)?.id,
        ),
      ).toContain("normal-action");
      expect(output.dom).toContain("Active-origin opaque action");
      expect(output.dom).toContain("not-targetable=true");
      await page
        .frames()
        .find((frame) => frame.url().endsWith("/normal"))!
        .locator("#normal-action")
        .click();
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("keeps null-origin frame controls visible but outside action and query maps", async () => {
    const page = await browser.newPage();
    try {
      const dataDocument = encodeURIComponent(
        '<span id="data-action" onclick="window.clicked = true">Data opaque action</span>',
      );
      await page.setContent(
        `<iframe id="blank-frame"></iframe><iframe srcdoc='<span id="srcdoc-action" onclick="window.clicked = true">Srcdoc opaque action</span>'></iframe><iframe src="data:text/html,${dataDocument}"></iframe>`,
      );
      const blankHandle = await page.locator("#blank-frame").elementHandle();
      const blankFrame = await blankHandle!.contentFrame();
      await blankFrame!.setContent(
        '<span id="blank-action" onclick="window.clicked = true">Blank opaque action</span>',
      );

      const capture = await captureThroughController(page);
      const handles = new Map(capture.elements.map((element) => [element, `@e:${element.index}`]));
      const safe = buildSafeControlsV2({
        elements: capture.elements,
        legacyRefs: handles,
        handles,
        pageOrigin: new URL(page.url()).origin,
        canonical: true,
      });
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? handles.get(element)!
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });

      expect(
        capture.elements.some((element) =>
          ["blank-action", "srcdoc-action", "data-action"].includes(element.id ?? ""),
        ),
      ).toBe(false);
      expect(safe.rows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("Blank opaque action") }),
          expect.objectContaining({ text: expect.stringContaining("Srcdoc opaque action") }),
          expect.objectContaining({ text: expect.stringContaining("Data opaque action") }),
        ]),
      );
      expect(output.dom).toContain("Blank opaque action");
      expect(output.dom).toContain("Srcdoc opaque action");
      expect(output.dom).toContain("Data opaque action");
      expect(output.dom.match(/not-targetable=true/g)).toHaveLength(3);
    } finally {
      await page.close();
    }
  });
  it("keeps an unbindable closed-shadow control visible without disabling the rest of the fixture", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        readFileSync(new URL("./fixtures/shadow-unbound.html", import.meta.url), "utf8"),
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const output = serializeBrowserUseDOM(capture.root, {
        ref: (node) => {
          const element = capture.nodeElements.get(node.id);
          return element
            ? `@e:${element.index}`
            : { ref: `@e:unbound_${node.id}`, targetable: false };
        },
      });
      expect(output.dom).toContain("Complete page before web components");
      expect(output.dom).toContain("Complete page after web components");
      expect(output.dom).toContain("closed shadow action");
      expect(output.refs).toHaveLength(3);
      expect(output.dom).toMatch(/\[@e:unbound_[^\]]+\]<button[^\n]*not-targetable=true/);
      expect(capture.elements.some((element) => element.id === "closed")).toBe(false);
      const actionable = capture.elements.filter((element) =>
        ["outside", "open"].includes(element.id ?? ""),
      );
      expect(actionable).toHaveLength(2);
      for (const element of actionable) await page.locator(element.selector).click();
      expect(
        await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked),
      ).toEqual(["outside", "open"]);
    } finally {
      await page.close();
    }
  });
  it("preserves contained input, onclick, aria-label and text; keeps rendered names and text verbatim", async () => {
    const page = await browser.newPage();
    try {
      const token = "f9a062f02fad" + "f5";
      await page.setContent(
        `<div role="button" style="width:600px;height:300px"><span>Context text</span><input aria-label="Email"><span onclick="void 0">Separate action</span><span role="button" aria-label="Copy ${token}">Token ${token}</span></div>`,
      );
      const capture = await captureBrowserUseDOM(page, [], () => null, transparentFrameSecurity);
      const ref = (node: { id: string }): string => `@e:f9a062f02fadf5_${node.id}`;
      const { dom } = serializeBrowserUseDOM(capture.root, { ref });
      expect(dom).toContain("Context text");
      expect(dom).toContain("<input");
      expect(dom).toContain("Separate action");
      expect(dom).toContain(`aria-label=Copy ${token}`);
      expect(dom).toContain(`Token ${token}`);
    } finally {
      await page.close();
    }
  });
});
