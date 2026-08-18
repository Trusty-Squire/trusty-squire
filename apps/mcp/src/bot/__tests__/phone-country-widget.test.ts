// Tests for setPhoneCountry — driving a phone field's dial-code country picker
// on international checkouts, the control that hard-blocked a live Casetify
// checkout because every ref-based act path (type/select/click) failed on it.
//
// Two layers:
//  1. Pure-helper unit tests (classify / match / pick) — no browser.
//  2. Real-Chromium fixtures for the supported opacity:0 native <select>,
//     loud unsupported-family failure, and address-select discrimination.
//
// Synthetic fixtures only — no real credentials, no network.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  BrowserController,
  classifyPhoneCountryQuery,
  phoneCountryOptionMatches,
  pickPhoneCountryOption,
} from "../browser.js";

describe("classifyPhoneCountryQuery", () => {
  it("reads a dial code (with or without +) as digits only", () => {
    expect(classifyPhoneCountryQuery("+81")).toEqual({ dialCode: "81" });
    expect(classifyPhoneCountryQuery("81")).toEqual({ dialCode: "81" });
    expect(classifyPhoneCountryQuery("+1")).toEqual({ dialCode: "1" });
  });
  it("reads a two-letter token as an upper-cased ISO2 code", () => {
    expect(classifyPhoneCountryQuery("jp")).toEqual({ iso2: "JP" });
    expect(classifyPhoneCountryQuery("US")).toEqual({ iso2: "US" });
  });
  it("reads anything else as a lower-cased name for substring match", () => {
    expect(classifyPhoneCountryQuery("Japan")).toEqual({ name: "japan" });
    expect(classifyPhoneCountryQuery("United Kingdom")).toEqual({ name: "united kingdom" });
  });
  it("returns an empty query for blank input (caller rejects it)", () => {
    expect(classifyPhoneCountryQuery("   ")).toEqual({});
  });
});

describe("phoneCountryOptionMatches", () => {
  it("matches an ISO2 query only against the option's iso2 (exact, case-insensitive)", () => {
    expect(phoneCountryOptionMatches({ iso2: "JP" }, { iso2: "jp", text: "Japan" })).toBe(true);
    expect(phoneCountryOptionMatches({ iso2: "JP" }, { iso2: "US", text: "Japan" })).toBe(false);
    // Never fuzzy-match an ISO2 query on text — "US" must not hit "United States".
    expect(phoneCountryOptionMatches({ iso2: "US" }, { text: "United States" })).toBe(false);
  });
  it("matches a dial-code query against the structured dial code", () => {
    expect(phoneCountryOptionMatches({ dialCode: "81" }, { dialCode: "+81" })).toBe(true);
    expect(phoneCountryOptionMatches({ dialCode: "81" }, { dialCode: "+1" })).toBe(false);
  });
  it("falls back to a +NN embedded in the option text for a dial-code query", () => {
    expect(phoneCountryOptionMatches({ dialCode: "81" }, { text: "Japan (日本) (+81)" })).toBe(
      true,
    );
    expect(phoneCountryOptionMatches({ dialCode: "81" }, { text: "United States (+1)" })).toBe(
      false,
    );
  });
  it("matches a name query as a case-insensitive substring of the text", () => {
    expect(phoneCountryOptionMatches({ name: "japan" }, { text: "Japan (日本) (+81)" })).toBe(true);
    expect(phoneCountryOptionMatches({ name: "korea" }, { text: "Japan" })).toBe(false);
  });
});

describe("pickPhoneCountryOption", () => {
  const opts = [
    { text: "United States", iso2: "US", dialCode: "1" },
    { text: "Japan", iso2: "JP", dialCode: "81" },
  ];
  it("returns the index of the first matching option", () => {
    expect(pickPhoneCountryOption({ iso2: "JP" }, opts)).toBe(1);
    expect(pickPhoneCountryOption({ name: "united" }, opts)).toBe(0);
  });
  it("returns -1 when nothing matches (the loud-failure signal)", () => {
    expect(pickPhoneCountryOption({ iso2: "FR" }, opts)).toBe(-1);
  });
});

// ── Real-Chromium widget fixtures ───────────────────────────────────────────

// A realistic-length option set so the native-select detector's "countryish"
// heuristic (>=10 options, >=5 ISO2/dial-coded) fires like a real page.
const ISO_ROWS: ReadonlyArray<{ iso2: string; name: string; dial: string }> = [
  { iso2: "US", name: "United States", dial: "+1" },
  { iso2: "GB", name: "United Kingdom", dial: "+44" },
  { iso2: "JP", name: "Japan", dial: "+81" },
  { iso2: "FR", name: "France", dial: "+33" },
  { iso2: "DE", name: "Germany", dial: "+49" },
  { iso2: "IN", name: "India", dial: "+91" },
  { iso2: "BR", name: "Brazil", dial: "+55" },
  { iso2: "CA", name: "Canada", dial: "+1" },
  { iso2: "AU", name: "Australia", dial: "+61" },
  { iso2: "KR", name: "South Korea", dial: "+82" },
  { iso2: "CN", name: "China", dial: "+86" },
  { iso2: "MX", name: "Mexico", dial: "+52" },
];

function dataUrl(body: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;padding:24px">${body}</body></html>`)}`;
}

// react-phone-number-input: the country is an opacity:0 native <select>
// overlaying a flag. A `change` listener mirrors the value into a flag node +
// window.__country, so we can assert React-style onChange fired.
const RPNI_FIXTURE = dataUrl(`
  <div class="PhoneInput">
    <div class="PhoneInputCountry" style="position:relative;display:inline-block">
      <select class="PhoneInputCountrySelect"
              style="position:absolute;top:0;left:0;width:48px;height:24px;opacity:0">
        ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
      </select>
      <div class="PhoneInputCountryIcon" id="flag">US</div>
    </div>
    <input class="PhoneInputInput" type="tel" placeholder="Phone">
  </div>
  <script>
    const sel = document.querySelector('.PhoneInputCountrySelect');
    sel.addEventListener('change', () => {
      document.getElementById('flag').textContent = sel.value;
      window.__country = sel.value;
    });
  </script>`);

// A checkout carrying BOTH an address country <select name="country"> (which
// must NOT be touched) and the phone widget. Proves the detector prefers the
// phone-named select even when both share a form and both sit near the tel.
const ADDRESS_PLUS_PHONE_FIXTURE = dataUrl(`
  <form>
    <fieldset>
      <label>Country</label>
      <select name="country" id="addr-country">
        ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
      </select>
    </fieldset>
    <fieldset class="PhoneInput">
      <select class="PhoneInputCountrySelect" style="opacity:0;position:absolute;width:48px;height:24px">
        ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
      </select>
      <input class="PhoneInputInput" type="tel">
    </fieldset>
  </form>
  <script>
    const sel = document.querySelector('.PhoneInputCountrySelect');
    sel.addEventListener('change', () => { window.__country = sel.value; });
  </script>`);

const ADDRESS_ONLY_WITH_TEL_FIXTURE = dataUrl(`
  <form>
    <label>Shipping country</label>
    <select name="country" id="addr-country">
      ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
    </select>
    <input type="tel" class="form-control">
  </form>
`);

const PHONE_TYPE_ONLY_FIXTURE = dataUrl(`
  <form>
    <select name="phone_type" id="phone-type">
      <option value="1">Home</option>
      <option value="2">Mobile</option>
    </select>
    <input type="tel" class="form-control">
  </form>
`);

let browser: Browser;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  // start() does network geo-probing + a persistent-profile launch unsuitable
  // for a unit test; inject a directly-launched page so the REAL methods run
  // against real Chromium. Same private-field injection as shadow-dom-topmost.
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

async function picked(page: Page): Promise<string | undefined> {
  return await page.evaluate(() => (window as unknown as { __picked?: string }).__picked);
}

describe("setPhoneCountry — real Chromium widget fixtures", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("react-phone-number-input: drives the opacity:0 native <select> by name", async () => {
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      const country = await page.evaluate(
        () => (window as unknown as { __country?: string }).__country,
      );
      expect(country).toBe("JP");
      expect(await page.textContent("#flag")).toBe("JP");
      expect(await ctrl.verifyPhoneCountry("Japan")).toBe(true);
      await page.locator(".PhoneInputCountrySelect").selectOption("US");
      expect(await ctrl.verifyPhoneCountry("Japan")).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it("react-phone-number-input: also accepts an ISO2 code", async () => {
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      await ctrl.setPhoneCountry("KR");
      const country = await page.evaluate(
        () => (window as unknown as { __country?: string }).__country,
      );
      expect(country).toBe("KR");
    } finally {
      await page.close();
    }
  }, 30000);

  it("throws when the native phone-country value does not stick", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div class="PhoneInput">
          <select class="PhoneInputCountrySelect" style="opacity:0">
            ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
          </select>
          <input type="tel">
        </div>
        <script>
          const select = document.querySelector('.PhoneInputCountrySelect');
          select.addEventListener('change', () => { select.value = 'US'; });
        </script>`),
    );
    try {
      await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(/did not retain value/i);
      expect(await page.locator(".PhoneInputCountrySelect").inputValue()).toBe("US");
    } finally {
      await page.close();
    }
  }, 30000);

  it("prefers the phone-named <select> over the address country <select>", async () => {
    const { ctrl, page } = await pageFor(ADDRESS_PLUS_PHONE_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      const phone = await page.evaluate(
        () => (window as unknown as { __country?: string }).__country,
      );
      expect(phone).toBe("JP");
      // The address country select must be untouched (still its first option).
      expect(await page.locator("#addr-country").inputValue()).toBe("US");
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not drive an address country select when no native phone picker exists", async () => {
    const { ctrl, page } = await pageFor(ADDRESS_ONLY_WITH_TEL_FIXTURE);
    try {
      await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(
        /no supported native phone-country <select> found/i,
      );
      expect(await page.locator("#addr-country").inputValue()).toBe("US");
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not mistake a phone type select for a country picker", async () => {
    const { ctrl, page } = await pageFor(PHONE_TYPE_ONLY_FIXTURE);
    try {
      await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(
        /no supported native phone-country <select> found/i,
      );
      expect(await page.locator("#phone-type").inputValue()).toBe("1");
    } finally {
      await page.close();
    }
  }, 30000);

  it("fails loudly when the requested country is not offered by the picker", async () => {
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      await expect(ctrl.setPhoneCountry("Antarctica")).rejects.toThrow(/no option matched/i);
    } finally {
      await page.close();
    }
  }, 30000);

  it("fails loudly for unsupported custom phone widgets", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div class="react-tel-input">
          <div class="selected-flag">flag</div>
          <input type="tel">
        </div>`),
    );
    try {
      await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(
        /this widget family is not supported yet/i,
      );
    } finally {
      await page.close();
    }
  }, 30000);

  it("react-phone-number-input: documents the expected dial-code limitation", async () => {
    // react-phone-number-input's native <option>s carry only the country name
    // and an ISO2 value — no dial code — so "+81" can't resolve here. Documents
    // the limitation: pass a name or ISO2 for this widget family.
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      await expect(ctrl.setPhoneCountry("+81")).rejects.toThrow(/no option matched/i);
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not select the first native option when text matches nothing", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <select id="country">
          <option value="">Choose a country</option>
          <option value="JP">Japan</option>
        </select>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "Atlantis")).rejects.toThrow(/no option matched/i);
      expect(await page.locator("#country").inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 30000);

  it("drives only the native select resolved by an nth-chain selector", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <select class="country">
          <option value="US">United States</option>
          <option value="CA">Canada</option>
        </select>
        <select class="country">
          <option value="JP">Japan</option>
          <option value="KR">South Korea</option>
        </select>`),
    );
    try {
      await ctrl.selectOption("select.country >> nth=1", "South Korea");
      expect(await page.locator("select.country").nth(0).inputValue()).toBe("US");
      expect(await page.locator("select.country").nth(1).inputValue()).toBe("KR");
      expect(await page.locator("select.country").nth(1).getAttribute("data-ts-touched")).toBe("1");
    } finally {
      await page.close();
    }
  }, 30000);

  it("throws when a native select reverts the chosen value", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <select id="country">
          <option value="US">United States</option>
          <option value="JP">Japan</option>
        </select>
        <script>
          const select = document.getElementById('country');
          select.addEventListener('change', () => { select.value = 'US'; });
        </script>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "Japan")).rejects.toThrow(/did not stick/i);
      expect(await page.locator("#country").inputValue()).toBe("US");
    } finally {
      await page.close();
    }
  }, 30000);

  it("does not click the first custom option when text matches nothing", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <button id="unrelated" type="button">Atlantis</button>
        <button id="country" role="combobox" type="button">Choose a country</button>
        <ul id="options" role="listbox" style="display:none">
          <li role="option" data-value="JP">Japan</li>
          <li role="option" data-value="KR">South Korea</li>
        </ul>
        <script>
          document.getElementById('country').addEventListener('click', () => {
            document.getElementById('options').style.display = 'block';
          });
          document.querySelectorAll('[role="option"]').forEach((option) => {
            option.addEventListener('click', () => {
              window.__picked = option.getAttribute('data-value');
            });
          });
          document.getElementById('unrelated').addEventListener('click', () => {
            window.__wrong = true;
          });
        </script>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "Atlantis")).rejects.toThrow(/no option matched/i);
      expect(await picked(page)).toBeUndefined();
      expect(
        await page.evaluate(() => (window as unknown as { __wrong?: boolean }).__wrong),
      ).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it("fails loudly when the trigger opens no popup", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div class="fake-select">
          <input id="country" role="combobox" aria-expanded="false">
          <div id="status"></div>
        </div>
        <script>
          const input = document.getElementById('country');
          const status = document.getElementById('status');
          input.addEventListener('keydown', (event) => {
            if (event.altKey && event.key === 'ArrowDown') {
              input.setAttribute('aria-expanded', 'true');
              status.textContent = 'No options';
            }
          });
          input.addEventListener('input', () => {
            status.textContent = 'No options';
          });
        </script>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "Atlantis")).rejects.toThrow(
        /no single opened popup/i,
      );
      expect(await picked(page)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it("clicks a matching actionable option from the opened popup", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <button id="country" role="combobox" aria-expanded="false" type="button">Choose a country</button>
        <ul id="options" role="listbox" style="display:none">
          <li role="option" data-value="JP">Japan</li>
          <li role="option" data-value="KR">South Korea</li>
        </ul>
        <script>
          const trigger = document.getElementById('country');
          const options = document.getElementById('options');
          trigger.addEventListener('click', () => {
            trigger.setAttribute('aria-expanded', 'true');
            options.style.display = 'block';
          });
          options.querySelectorAll('[role="option"]').forEach((option) => {
            option.addEventListener('click', () => {
              option.setAttribute('aria-selected', 'true');
              trigger.textContent = option.textContent;
              trigger.setAttribute('aria-expanded', 'false');
              options.style.display = 'none';
              window.__picked = option.getAttribute('data-value');
            });
          });
        </script>`),
    );
    try {
      await ctrl.selectOption("#country", "Japan");
      expect(await picked(page)).toBe("JP");
    } finally {
      await page.close();
    }
  }, 30000);

  it("collapses a nested popup wrapper to its semantic listbox", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <button id="country" role="combobox" type="button">Choose a country</button>
        <div class="dropdown-menu" style="display:none">
          <ul role="listbox">
            <li role="option" data-value="JP">Japan</li>
            <li role="option" data-value="KR">South Korea</li>
          </ul>
        </div>
        <script>
          const menu = document.querySelector('.dropdown-menu');
          document.getElementById('country').addEventListener('click', () => {
            menu.style.display = 'block';
          });
          menu.querySelectorAll('[role="option"]').forEach((option) => {
            option.addEventListener('click', () => {
              window.__picked = option.getAttribute('data-value');
            });
          });
        </script>`),
    );
    try {
      await ctrl.selectOption("#country", "South Korea");
      expect(await picked(page)).toBe("KR");
    } finally {
      await page.close();
    }
  }, 30000);

  it("accepts an input combobox commit after its listbox unmounts", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <input id="country" role="combobox" aria-expanded="false" aria-controls="country-options">
        <ul id="country-options" role="listbox" style="display:none">
          <li role="option" data-value="JP">Japan</li>
          <li role="option" data-value="KR">South Korea</li>
        </ul>
        <script>
          const trigger = document.getElementById('country');
          const options = document.getElementById('country-options');
          trigger.addEventListener('click', () => {
            trigger.setAttribute('aria-expanded', 'true');
            options.style.display = 'block';
          });
          options.querySelectorAll('[role="option"]').forEach((option) => {
            option.addEventListener('click', () => {
              trigger.value = option.textContent;
              trigger.setAttribute('aria-expanded', 'false');
              options.remove();
              window.__picked = option.getAttribute('data-value');
            });
          });
        </script>`),
    );
    try {
      await ctrl.selectOption("#country", "Japan");
      expect(await page.locator("#country").inputValue()).toBe("Japan");
      expect(await picked(page)).toBe("JP");
    } finally {
      await page.close();
    }
  }, 30000);

  it("opens an input combobox by keyboard before matching its rows", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <input id="country" role="combobox" aria-expanded="false" aria-controls="country-options">
        <ul id="country-options" role="listbox" style="display:none">
          <li role="option" data-value="JP">Japan</li>
        </ul>
        <script>
          const trigger = document.getElementById('country');
          const options = document.getElementById('country-options');
          trigger.addEventListener('keydown', (event) => {
            if (event.altKey && event.key === 'ArrowDown') {
              options.style.display = 'block';
            }
          });
          options.querySelector('[role="option"]').addEventListener('click', (event) => {
            window.__picked = event.currentTarget.getAttribute('data-value');
          });
        </script>`),
    );
    try {
      await ctrl.selectOption("#country", "Japan");
      expect(await picked(page)).toBe("JP");
    } finally {
      await page.close();
    }
  }, 30000);

  it("rejects text-only popup content without actionable option rows", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <span>South Korea</span>
        <button id="country" role="combobox" aria-expanded="false" type="button">Choose a country</button>
        <div id="country-options" class="dropdown-options" style="display:none">
          <div class="plain-row" data-value="JP">Japan</div>
          <div class="plain-row" data-value="KR">South Korea</div>
        </div>
        <script>
          const trigger = document.getElementById('country');
          const options = document.getElementById('country-options');
          trigger.addEventListener('click', () => {
            trigger.setAttribute('aria-expanded', 'true');
            options.style.display = 'block';
          });
          options.querySelectorAll('.plain-row').forEach((option) => {
            option.addEventListener('click', () => {
              trigger.textContent = option.textContent;
              trigger.setAttribute('aria-expanded', 'false');
              options.style.display = 'none';
              window.__picked = option.getAttribute('data-value');
            });
          });
        </script>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "South Korea")).rejects.toThrow(
        /no option matched/i,
      );
      expect(await picked(page)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);
});

// extractVisibleText's own comment claims it "reflects what a user would
// actually see" — innerText excludes display:none/visibility:hidden but NOT
// opacity:0, so the RPNI fixture's opacity:0 country <select> (real pattern,
// found live on a Shopify checkout) dumped all 12 option names into the page
// text. Left unfixed that floods/truncates the text a host reads to decide
// what's on the page.
describe("extractVisibleText — opacity:0 elements excluded", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("omits an opacity:0 native <select>'s options from page text", async () => {
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      const text = await ctrl.extractVisibleText();
      for (const row of ISO_ROWS) {
        if (row.name === "United States") continue; // visible flag placeholder text
        expect(text).not.toContain(row.name);
      }
    } finally {
      await page.close();
    }
  }, 30000);

  it("still includes ordinary visible text", async () => {
    const { ctrl, page } = await pageFor(RPNI_FIXTURE);
    try {
      const text = await ctrl.extractVisibleText();
      expect(text).toContain("US"); // the visible flag placeholder
    } finally {
      await page.close();
    }
  }, 30000);

  // innerText's pre-existing exclusions must survive the opacity:0 fix: a
  // detached-clone read would degrade innerText to textContent semantics and
  // re-include exactly this content (hidden "Loading…" skeletons false-trip
  // the loading-shell gate; Shopify inline JSON scripts flood the text).
  it("keeps excluding display:none, visibility:hidden, and <script> text", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div>VISIBLE_LINE</div>
        <div style="display:none">DISPLAY_NONE_LINE</div>
        <div style="visibility:hidden">VISIBILITY_HIDDEN_LINE</div>
        <div style="opacity:0">OPACITY_ZERO_LINE</div>
        <script type="application/json">{"payload":"SCRIPT_PAYLOAD_LINE"}</script>`),
    );
    try {
      const text = await ctrl.extractVisibleText();
      expect(text).toContain("VISIBLE_LINE");
      expect(text).not.toContain("DISPLAY_NONE_LINE");
      expect(text).not.toContain("VISIBILITY_HIDDEN_LINE");
      expect(text).not.toContain("OPACITY_ZERO_LINE");
      expect(text).not.toContain("SCRIPT_PAYLOAD_LINE");
    } finally {
      await page.close();
    }
  }, 30000);

  it("leaves the live DOM's style attributes byte-identical after reading", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <style>.ghost{opacity:0}</style>
        <div class="ghost" id="ghost">GHOST_LINE</div>
        <div id="inline" style="opacity:0;width:48px">INLINE_LINE</div>
        <div>VISIBLE_LINE</div>`),
    );
    try {
      const text = await ctrl.extractVisibleText();
      expect(text).not.toContain("GHOST_LINE");
      expect(text).not.toContain("INLINE_LINE");
      // Stylesheet-hidden element must not gain a residual style attribute…
      expect(await page.locator("#ghost").getAttribute("style")).toBeNull();
      // …and an inline-styled one must keep its exact original attribute.
      expect(await page.locator("#inline").getAttribute("style")).toBe("opacity:0;width:48px");
    } finally {
      await page.close();
    }
  }, 30000);

  // A foreign-namespace element (createElementNS) has no .style; combined
  // with a page-load fade-in rule like *{opacity:0} it must neither throw
  // nor abandon already-hidden elements as display:none in the live DOM.
  it("tolerates non-styleable namespaced elements without leaving residue", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <style>*{opacity:0}</style>
        <div id="faded">FADED_LINE</div>
        <div>ALSO_FADED_LINE</div>
        <script>
          document.body.appendChild(document.createElementNS("urn:example", "weird-el"));
        </script>`),
    );
    try {
      const text = await ctrl.extractVisibleText();
      expect(text).not.toContain("FADED_LINE");
      expect(await page.locator("#faded").getAttribute("style")).toBeNull();
      expect(await page.locator("#faded").evaluate((el) => getComputedStyle(el).display)).toBe(
        "block",
      );
    } finally {
      await page.close();
    }
  }, 30000);
});
