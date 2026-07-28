// Tests for setPhoneCountry — driving a phone field's dial-code country picker
// on international checkouts, the control that hard-blocked a live Casetify
// checkout because every ref-based act path (type/select/click) failed on it.
//
// Two layers:
//  1. Pure-helper unit tests (classify / match / pick) — no browser.
//  2. Real-Chromium fixtures, one per widget family the primitive must cover:
//     react-phone-number-input (opacity:0 native <select> the inventory walker
//     drops), react-phone-input-2, react-international-phone, intl-tel-input,
//     and a bespoke "+NN" trigger (the Casetify shape). Each fixture wires a
//     handler that records the picked country so we assert the RIGHT country
//     was set — plus the loud-failure and address-select-discrimination cases.
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

const ADDRESS_PLUS_CUSTOM_PHONE_FIXTURE = dataUrl(`
  <form>
    <fieldset>
      <label>Shipping country</label>
      <select name="country" id="addr-country">
        ${ISO_ROWS.map((r) => `<option value="${r.iso2}">${r.name}</option>`).join("")}
      </select>
    </fieldset>
    <div class="react-tel-input">
      <input type="tel" class="form-control">
      <div class="flag-dropdown">
        <div class="selected-flag" tabindex="0" style="width:38px;height:26px;display:inline-block">flag</div>
        <ul class="country-list" style="display:none;margin:0">
          ${ISO_ROWS.map(
            (r) =>
              `<li class="country" data-country-code="${r.iso2.toLowerCase()}">` +
              `<span class="country-name">${r.name}</span>` +
              `<span class="dial-code">${r.dial}</span></li>`,
          ).join("")}
        </ul>
      </div>
    </div>
  </form>
  <script>
    const flag = document.querySelector('.selected-flag');
    const list = document.querySelector('.country-list');
    flag.addEventListener('click', () => { list.style.display = 'block'; });
    list.querySelectorAll('li.country').forEach((li) =>
      li.addEventListener('click', () => {
        window.__picked = li.getAttribute('data-country-code');
        list.style.display = 'none';
      }),
    );
  </script>`);

const PHONE_TYPE_PLUS_CUSTOM_PHONE_FIXTURE = dataUrl(`
  <form>
    <select name="phone_type" id="phone-type">
      <option value="1">Home</option>
      <option value="2">Mobile</option>
    </select>
    <div class="react-tel-input">
      <input type="tel" class="form-control">
      <div class="flag-dropdown">
        <div class="selected-flag" tabindex="0" style="width:38px;height:26px;display:inline-block">flag</div>
        <ul class="country-list" style="display:none;margin:0">
          ${ISO_ROWS.map(
            (r) =>
              `<li class="country" data-country-code="${r.iso2.toLowerCase()}">` +
              `<span class="country-name">${r.name}</span>` +
              `<span class="dial-code">${r.dial}</span></li>`,
          ).join("")}
        </ul>
      </div>
    </div>
  </form>
  <script>
    const flag = document.querySelector('.selected-flag');
    const list = document.querySelector('.country-list');
    flag.addEventListener('click', () => { list.style.display = 'block'; });
    list.querySelectorAll('li.country').forEach((li) =>
      li.addEventListener('click', () => {
        window.__picked = li.getAttribute('data-country-code');
        list.style.display = 'none';
      }),
    );
  </script>`);

// react-phone-input-2: a .selected-flag trigger + a .country-list of
// li.country[data-country-code] each with a .dial-code span.
const RPI2_FIXTURE = dataUrl(`
  <div class="react-tel-input">
    <input type="tel" class="form-control">
    <div class="flag-dropdown">
      <div class="selected-flag" tabindex="0" style="width:38px;height:26px;display:inline-block"><div class="flag us"></div></div>
      <ul class="country-list" style="display:none;margin:0">
        ${ISO_ROWS.map(
          (r) =>
            `<li class="country" data-country-code="${r.iso2.toLowerCase()}">` +
            `<span class="country-name">${r.name}</span>` +
            `<span class="dial-code">${r.dial}</span></li>`,
        ).join("")}
      </ul>
    </div>
  </div>
  <script>
    const flag = document.querySelector('.selected-flag');
    const list = document.querySelector('.country-list');
    flag.addEventListener('click', () => { list.style.display = 'block'; });
    list.querySelectorAll('li.country').forEach((li) =>
      li.addEventListener('click', () => {
        window.__picked = li.getAttribute('data-country-code');
        list.style.display = 'none';
      }),
    );
  </script>`);

// react-international-phone: a ...country-selector-button + a
// ...dropdown__list-item[data-country] list with a dial-code span.
const RIP_FIXTURE = dataUrl(`
  <div class="react-international-phone">
    <button class="react-international-phone-country-selector-button" type="button">flag</button>
    <ul class="react-international-phone-country-selector-dropdown__list" style="display:none;margin:0">
      ${ISO_ROWS.map(
        (r) =>
          `<li class="react-international-phone-country-selector-dropdown__list-item" data-country="${r.iso2.toLowerCase()}">` +
          `<span>${r.name}</span>` +
          `<span class="react-international-phone-country-selector-dropdown__list-item-dial-code">${r.dial}</span></li>`,
      ).join("")}
    </ul>
    <input type="tel">
  </div>
  <script>
    const btn = document.querySelector('.react-international-phone-country-selector-button');
    const list = document.querySelector('.react-international-phone-country-selector-dropdown__list');
    btn.addEventListener('click', () => { list.style.display = 'block'; });
    list.querySelectorAll('li').forEach((li) =>
      li.addEventListener('click', () => {
        window.__picked = li.getAttribute('data-country');
        list.style.display = 'none';
      }),
    );
  </script>`);

// intl-tel-input: a .iti__selected-flag trigger + .iti__country-list of
// .iti__country[data-country-code] with a .iti__dial-code span.
const ITI_FIXTURE = dataUrl(`
  <div class="iti">
    <div class="iti__flag-container">
      <div class="iti__selected-flag" role="combobox" tabindex="0" style="width:38px;height:26px;display:inline-block"><div class="iti__flag"></div></div>
      <ul class="iti__country-list" style="display:none;margin:0">
        ${ISO_ROWS.map(
          (r) =>
            `<li class="iti__country" data-country-code="${r.iso2.toLowerCase()}">` +
            `<span class="iti__country-name">${r.name}</span>` +
            `<span class="iti__dial-code">${r.dial}</span></li>`,
        ).join("")}
      </ul>
    </div>
    <input type="tel" class="iti__tel-input">
  </div>
  <script>
    const flag = document.querySelector('.iti__selected-flag');
    const list = document.querySelector('.iti__country-list');
    flag.addEventListener('click', () => { list.style.display = 'block'; });
    list.querySelectorAll('.iti__country').forEach((li) =>
      li.addEventListener('click', () => {
        window.__picked = li.getAttribute('data-country-code');
        list.style.display = 'none';
      }),
    );
  </script>`);

// Bespoke (Casetify shape): a <label> whose OWN text is "+1" next to a tel
// input, opening a plain <div> option list on click. No native select, no
// library class — the generic fallback's target.
const BESPOKE_FIXTURE = dataUrl(`
  <div class="checkout">
    <button class="country-link" type="button" onclick="window.__wrong = true">Japan (+81)</button>
    <div class="phone-row">
      <label id="cc" class="cc-label" style="cursor:pointer">+1</label>
      <input type="tel" id="phone">
    </div>
    <div id="cc-list" style="display:none">
      ${ISO_ROWS.map(
        (r) =>
          `<div class="cc-option" data-x="${r.iso2.toLowerCase()}">${r.name} (${r.dial})</div>`,
      ).join("")}
    </div>
  </div>
  <script>
    document.getElementById('cc').addEventListener('click', () => {
      document.getElementById('cc-list').style.display = 'block';
    });
    document.querySelectorAll('.cc-option').forEach((o) =>
      o.addEventListener('click', () => { window.__picked = o.getAttribute('data-x'); }),
    );
  </script>`);

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

  it("ignores an address country select when the phone picker is custom", async () => {
    const { ctrl, page } = await pageFor(ADDRESS_PLUS_CUSTOM_PHONE_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      expect(await page.locator("#addr-country").inputValue()).toBe("US");
      expect(await picked(page)).toBe("jp");
    } finally {
      await page.close();
    }
  }, 30000);

  it("ignores a phone type select and falls through to the country picker", async () => {
    const { ctrl, page } = await pageFor(PHONE_TYPE_PLUS_CUSTOM_PHONE_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      expect(await page.locator("#phone-type").inputValue()).toBe("1");
      expect(await picked(page)).toBe("jp");
    } finally {
      await page.close();
    }
  }, 30000);

  it("react-phone-input-2: opens the flag list and picks by dial code", async () => {
    const { ctrl, page } = await pageFor(RPI2_FIXTURE);
    try {
      await ctrl.setPhoneCountry("+81");
      expect(await picked(page)).toBe("jp");
    } finally {
      await page.close();
    }
  }, 30000);

  it("react-international-phone: opens the dropdown and picks by name", async () => {
    const { ctrl, page } = await pageFor(RIP_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      expect(await picked(page)).toBe("jp");
    } finally {
      await page.close();
    }
  }, 30000);

  it("react-international-phone: picks by ISO2 code", async () => {
    const { ctrl, page } = await pageFor(RIP_FIXTURE);
    try {
      await ctrl.setPhoneCountry("KR");
      expect(await picked(page)).toBe("kr");
    } finally {
      await page.close();
    }
  }, 30000);

  it("intl-tel-input: opens the country list and picks by dial code", async () => {
    const { ctrl, page } = await pageFor(ITI_FIXTURE);
    try {
      await ctrl.setPhoneCountry("+82");
      expect(await picked(page)).toBe("kr");
    } finally {
      await page.close();
    }
  }, 30000);

  it("bespoke +NN trigger: opens the list and picks by country name", async () => {
    const { ctrl, page } = await pageFor(BESPOKE_FIXTURE);
    try {
      await ctrl.setPhoneCountry("Japan");
      expect(await picked(page)).toBe("jp");
    } finally {
      await page.close();
    }
  }, 30000);

  it("bespoke +NN trigger: picks by dial code embedded in the option text", async () => {
    const { ctrl, page } = await pageFor(BESPOKE_FIXTURE);
    try {
      await ctrl.setPhoneCountry("+82");
      expect(await picked(page)).toBe("kr");
    } finally {
      await page.close();
    }
  }, 30000);

  it("fails loudly when the requested country is not offered by the picker", async () => {
    const { ctrl, page } = await pageFor(RPI2_FIXTURE);
    try {
      // Antarctica has no row — the picker opens but nothing matches.
      await expect(ctrl.setPhoneCountry("Antarctica")).rejects.toThrow(/no option matched/i);
    } finally {
      await page.close();
    }
  }, 30000);

  it("fails loudly when no phone-country picker exists on the page", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl('<input type="text" placeholder="just a text field">'),
    );
    try {
      await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(
        /no phone-country picker matched/i,
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

  it("does not treat keyboard filtering changes as a committed selection", async () => {
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
      await expect(ctrl.selectOption("#country", "Atlantis")).rejects.toThrow(/no option matched/i);
      expect(await picked(page)).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 30000);

  it("verifies a committed custom option before returning", async () => {
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

  it("does not accept a failed target click from an unrelated selected option", async () => {
    const { ctrl, page } = await pageFor(
      dataUrl(`
        <div role="listbox">
          <div role="option" aria-selected="true">Japan</div>
        </div>
        <button id="country" role="combobox" aria-expanded="false" aria-controls="country-options" type="button">
          Choose a country
        </button>
        <ul id="country-options" role="listbox" style="display:none">
          <li role="option" data-value="JP">Japan</li>
        </ul>
        <script>
          const trigger = document.getElementById('country');
          const options = document.getElementById('country-options');
          trigger.addEventListener('click', () => {
            trigger.setAttribute('aria-expanded', 'true');
            options.style.display = 'block';
          });
        </script>`),
    );
    try {
      await expect(ctrl.selectOption("#country", "Japan")).rejects.toThrow(/no option matched/i);
      expect(await picked(page)).toBeUndefined();
      expect(await page.locator("#country").textContent()).toContain("Choose a country");
    } finally {
      await page.close();
    }
  }, 30000);

  it("uses only the opened popup for text-only custom options", async () => {
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
      await ctrl.selectOption("#country", "South Korea");
      expect(await picked(page)).toBe("KR");
    } finally {
      await page.close();
    }
  }, 30000);
});
