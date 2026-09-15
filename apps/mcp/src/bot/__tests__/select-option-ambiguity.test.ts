// Regression tests for the `select` verb's option resolution.
//
// The `select` path used to resolve the planner's option text with a
// case-insensitive SUBSTRING search and take the FIRST hit. That silently
// committed the wrong option on any text collision (measured live in a real
// Chromium: "Guinea" committed "Equatorial Guinea (+240)"; "Korea" committed
// "North Korea (+850)"; the combobox filter committed "Vue.js" for "Vue").
// A silent wrong pick is worse than a loud refusal the planner can re-plan
// from, so the contract is now:
//
//   1. whitespace-normalized, case-insensitive EXACT text match wins;
//   2. otherwise a substring match is used only when it is UNIQUE;
//   3. otherwise the call refuses, naming the candidates.
//
// The same contract applies to `selectInFrame` (browser.ts) and to the
// label→row-control fallback, which additionally only fires when the row
// offers exactly one candidate control (it used to take the first of several
// and drove the wrong control — a "Phone country" label over a row holding an
// address select and a phone select committed the ADDRESS select).
//
// Synthetic fixtures only; no network, no credentials.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";

let browser: Browser;

const dataUrl = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

async function pageFor(url: string): Promise<{ ctrl: BrowserController; page: Page }> {
  const page = await browser.newPage();
  await page.goto(url);
  const ctrl = new BrowserController({ humanize: false });
  (ctrl as unknown as { page: Page }).page = page;
  return { ctrl, page };
}

const selectTarget = (selector: string) => ({ kind: "selector", selector }) as const;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser.close();
});

const COLLIDING_NATIVE = dataUrl(`
  <select id="country">
    <option value="GQ">Equatorial Guinea (+240)</option>
    <option value="GN">Guinea (+224)</option>
    <option value="GW">Guinea-Bissau (+245)</option>
  </select>`);

const ROW_WITH_TWO_CONTROLS = dataUrl(`
  <div class="n-form-group__row">
    <label id="addr-label">Address country</label>
    <select id="addr-country">
      <option value="US">United States</option>
      <option value="JP">Japan</option>
    </select>
    <label id="phone-label">Phone country</label>
    <select id="phone-country">
      <option value="US">United States</option>
      <option value="JP">Japan</option>
    </select>
  </div>`);

const LABEL_WITH_FOR = dataUrl(`
  <div class="n-form-group__row">
    <label for="for-phone">Phone country</label>
    <select id="for-phone">
      <option value="US">United States</option>
      <option value="JP">Japan</option>
    </select>
  </div>`);

const valueOf = (page: Page, selector: string) => page.locator(selector).inputValue();

describe("select — native <option> resolution", () => {
  it("refuses an ambiguous option text instead of committing the first substring hit", async () => {
    const { ctrl, page } = await pageFor(COLLIDING_NATIVE);
    try {
      await expect(ctrl.select(selectTarget("#country"), "Guinea")).rejects.toThrow(
        /matches several options.*Equatorial Guinea \(\+240\).*Guinea \(\+224\).*pass the exact option text/s,
      );
      // Nothing moved — the refusal is not a partial commit.
      expect(await valueOf(page, "#country")).toBe("GQ");
      expect(await page.locator("#country").getAttribute("data-ts-touched")).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);

  it("commits an exact option text", async () => {
    const { ctrl, page } = await pageFor(COLLIDING_NATIVE);
    try {
      await ctrl.select(selectTarget("#country"), "Guinea-Bissau");
      expect(await valueOf(page, "#country")).toBe("GW");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("still commits a UNIQUE partial option text", async () => {
    const { ctrl, page } = await pageFor(COLLIDING_NATIVE);
    try {
      await ctrl.select(selectTarget("#country"), "Bissau");
      expect(await valueOf(page, "#country")).toBe("GW");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("still refuses text that matches nothing", async () => {
    const { ctrl, page } = await pageFor(COLLIDING_NATIVE);
    try {
      await expect(ctrl.select(selectTarget("#country"), "Atlantis")).rejects.toThrow(
        /no option matched/,
      );
      expect(await valueOf(page, "#country")).toBe("GQ");
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("select — label fallback", () => {
  it("refuses a row with several candidate controls and moves none of them", async () => {
    const { ctrl, page } = await pageFor(ROW_WITH_TWO_CONTROLS);
    try {
      await expect(ctrl.select(selectTarget("#phone-label"), "Japan")).rejects.toThrow(
        /no single opened popup/,
      );
      expect(await valueOf(page, "#addr-country")).toBe("US");
      expect(await valueOf(page, "#phone-country")).toBe("US");
    } finally {
      await page.close();
    }
  }, 30_000);

  it("keeps resolving a label whose for= names its control exactly", async () => {
    const { ctrl, page } = await pageFor(LABEL_WITH_FOR);
    try {
      await ctrl.select(selectTarget("label[for='for-phone']"), "Japan");
      expect(await valueOf(page, "#for-phone")).toBe("JP");
    } finally {
      await page.close();
    }
  }, 30_000);
});

describe("select — combobox option resolution", () => {
  const combobox = (options: string[]) =>
    dataUrl(`
      <button id="trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false">Framework</button>
      <ul id="list" role="listbox" hidden>
        ${options
          .map(
            (o) => `<li role="option" tabindex="-1" onclick="commit('${o}')">${o}</li>`,
          )
          .join("")}
      </ul>
      <div id="out">none</div>
      <script>
        function commit(v) {
          if (window.__commits === undefined) window.__commits = [];
          window.__commits.push(v);
          document.getElementById('list').hidden = true;
          document.getElementById('trigger').textContent = v;
        }
        document.getElementById('trigger').addEventListener('click', () => {
          document.getElementById('list').hidden = false;
        });
      </script>`);

  const commits = (page: Page) =>
    page.evaluate(() => (window as unknown as { __commits?: string[] }).__commits ?? []);

  it("prefers the exact option over a longer option that contains it", async () => {
    const { ctrl, page } = await pageFor(combobox(["Vue.js", "Vue", "Keyword Search"]));
    try {
      await ctrl.select(selectTarget("#trigger"), "Vue");
      expect(await commits(page)).toEqual(["Vue"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("refuses an ambiguous option text and commits nothing", async () => {
    const { ctrl, page } = await pageFor(combobox(["Vue.js", "Vue (legacy)", "Keyword Search"]));
    try {
      await expect(ctrl.select(selectTarget("#trigger"), "Vue")).rejects.toThrow(
        /matches several options.*Vue\.js.*Vue \(legacy\).*pass the exact option text/s,
      );
      expect(await commits(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("still commits a unique partial option text", async () => {
    const { ctrl, page } = await pageFor(combobox(["Vue.js", "Vue (legacy)", "Keyword Search"]));
    try {
      await ctrl.select(selectTarget("#trigger"), "Keyword");
      expect(await commits(page)).toEqual(["Keyword Search"]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
