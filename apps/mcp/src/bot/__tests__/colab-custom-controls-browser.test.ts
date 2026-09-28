import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { observeQuery } from "../observe/observe.js";
import {
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { operateClickTool, operatePressTool } from "../../tools/provision-drive.js";
import { OBSERVE_V2_MAX_WIRE_BYTES } from "../compact-observation-v2.js";

const PAGE_URL = "https://colab-fixture.test/notebook";
const OUTPUT_URL = "https://output-fixture.test/result";

const NOTEBOOK = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; }
  .scope { padding: 8px; margin: 4px; width: 360px; border: 1px solid #aaa; cursor: pointer; }
  md-text-button { display: inline-block; padding: 10px; cursor: pointer; }
</style></head><body>
<main><h1>Notebook</h1>
  <div role="checkbox" tabindex="0" aria-checked="false" class="scope">Select all</div>
  <div role="checkbox" tabindex="0" aria-checked="false" class="scope">Read notebooks</div>
  <div role="checkbox" tabindex="0" aria-checked="false" class="scope">Manage notebooks</div>
  <section aria-label="Change runtime type" role="dialog">
    <runtime-options></runtime-options>
  </section>
  <md-text-button id="hidden-toolbar">Other command</md-text-button>
  <md-text-button id="run-all">Run all</md-text-button>
  <div id="runs">0</div>
  <iframe title="Cell output" src="${OUTPUT_URL}" style="width:480px;height:120px"></iframe>
  <div id="large"></div>
</main>
<script>
  document.querySelectorAll('[role="checkbox"]').forEach(el => el.addEventListener('click', () => {
    el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true'));
  }));
  customElements.define('runtime-options', class extends HTMLElement {
    constructor() { super(); this.attachShadow({mode:'open'}).innerHTML =
      '<div role="radiogroup" aria-label="Hardware accelerator">' +
      '<md-radio id="cpu" aria-label="CPU" role="radio" aria-checked="true" tabindex="0">CPU</md-radio>' +
      '<md-radio id="t4" aria-label="T4 GPU" role="radio" aria-checked="false" tabindex="0">T4 GPU</md-radio>' +
      '<md-checkbox id="notify" aria-label="Notify me" role="checkbox" tabindex="0"></md-checkbox>' +
      '</div>';
    }
    connectedCallback() {
      this.shadowRoot.querySelectorAll('md-radio').forEach(radio => radio.addEventListener('click', () => {
        this.shadowRoot.querySelectorAll('md-radio').forEach(choice =>
          choice.setAttribute('aria-checked', String(choice === radio)));
      }));
    }
  });
  customElements.define('md-radio', class extends HTMLElement {});
  customElements.define('md-checkbox', class extends HTMLElement {
    checked = false;
    constructor() { super(); this.attachShadow({mode:'open'}).innerHTML = '<span>Checkbox mark</span>'; }
    connectedCallback() { this.addEventListener('click', () => { this.checked = !this.checked; }); }
  });
  customElements.define('md-text-button', class extends HTMLElement {
    constructor() { super(); this.attachShadow({mode:'open'}).innerHTML = '<button id="button">Action</button>'; }
    connectedCallback() {
      if (this.id === 'hidden-toolbar') this.shadowRoot.querySelector('button').hidden = true;
      else this.shadowRoot.querySelector('button').textContent = 'Run all';
      this.shadowRoot.querySelector('button').addEventListener('click', () => {
        document.querySelector('#runs').textContent = String(Number(document.querySelector('#runs').textContent) + 1);
      });
    }
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'F9') {
      event.preventDefault();
      document.querySelector('#runs').textContent = String(Number(document.querySelector('#runs').textContent) + 1);
    }
  });
  document.querySelector('#large').innerHTML = Array.from({length: 300}, (_, i) =>
    '<button type="button">Notebook command ' + i + ' with a long descriptive label</button>').join('');
  document.querySelector('#large').innerHTML += '<pre>' + 'cell output '.repeat(7000) + '</pre>';
</script></body></html>`;

const COLAB_RADIOS = `<!doctype html><html><head><style>
  colab-runtime-attributes-selector, md-radio { display: block; width: 160px; min-height: 36px; }
</style></head><body>
<div role="dialog" aria-label="Change runtime type">
  <colab-runtime-attributes-selector></colab-runtime-attributes-selector>
  <button>Cancel</button><button>Save</button>
</div>
<script>
  customElements.define('md-radio', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({mode:'open'}).innerHTML =
        '<label style="display:block;width:160px;height:36px;cursor:pointer">' +
        '<input type="radio" name="accelerator" style="width:20px;height:20px">' +
        '<span></span></label>';
    }
    connectedCallback() {
      const input = this.shadowRoot.querySelector('input');
      input.setAttribute('aria-label', this.getAttribute('aria-label'));
      input.checked = this.hasAttribute('selected');
      this.shadowRoot.querySelector('span').textContent = this.getAttribute('aria-label');
      input.addEventListener('click', () => {
        this.getRootNode().querySelectorAll('md-radio').forEach(other => {
          other.shadowRoot.querySelector('input').checked = other === this;
        });
      });
    }
  });
  customElements.define('colab-runtime-attributes-selector', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({mode:'open'}).innerHTML =
        '<md-radio aria-label="CPU" selected></md-radio>' +
        '<md-radio aria-label="T4 GPU"></md-radio>';
    }
  });
</script></body></html>`;

let browser: Browser | undefined;
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(
  large = false,
  body = NOTEBOOK,
): Promise<{
  page: Page;
  controller: BrowserController;
  sessionId: string;
  start: Record<string, unknown>;
}> {
  if (!browser) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(PAGE_URL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: large ? body : body.replace("length: 300", "length: 0"),
    }),
  );
  await page.route(OUTPUT_URL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><pre>2\nValueError: synthetic cell failure</pre></body></html>",
    }),
  );
  const controller = BrowserController.fromHarnessPage(page);
  const start = (await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: PAGE_URL,
    format: "compact",
  })) as unknown as Record<string, unknown>;
  return { page, controller, sessionId: start.session_id as string, start };
}

function rowFor(rows: string[][], label: string): string[] {
  const row = rows.find((item) => (item[2] ?? "").includes(label));
  if (!row) throw new Error(`Missing control ${label}: ${JSON.stringify(rows.slice(0, 18))}`);
  return row;
}

describe.skipIf(!available)("Colab-shaped operator controls", () => {
  it("lists and clicks Google-style ARIA checkboxes with current state", async () => {
    const { page, sessionId, start } = await fixture();
    try {
      const rows = start.safe_table as string[][];
      for (const label of ["select-all", "read-notebooks", "manage-notebooks"]) {
        const row = rowFor(rows, label);
        expect(row[1]).toBe("c");
        expect(row[2]).toContain("s=u");
      }
      const selectAll = rowFor(rows, "select-all");
      const clicked = (await operateClickTool.handler(
        { session_id: sessionId, ref: selectAll[0]! },
        null,
      )) as unknown as { safe_table: string[][] };
      expect(rowFor(clicked.safe_table, "select-all")[2]).toContain("s=c");
      expect(rowFor(clicked.safe_table, "select-all")[2]).toContain("w=acted");
      expect(await page.locator('[role="checkbox"]').first().getAttribute("aria-checked")).toBe(
        "true",
      );
      const full = (await observe(sessionId, "full")) as unknown as { dom: string };
      expect(full.dom).toContain("role=checkbox aria-checked=true");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("lists shadow-root md-radio options and returns the selected state after a click", async () => {
    const { page, sessionId, start } = await fixture();
    try {
      const rows = start.safe_table as string[][];
      expect(rowFor(rows, "cpu")[2]).toContain("s=c");
      const t4 = rowFor(rows, "t4-gpu");
      expect(t4[1]).toBe("r");
      expect(t4[2]).toContain("s=u");
      const full = (await observe(sessionId, "full")) as unknown as { dom: string };
      expect(full.dom).toContain("role=radio aria-checked=false");
      const notify = rowFor(rows, "notify-me");
      expect(notify[1]).toBe("c");
      expect(notify[2]).toContain("s=u");
      const clicked = (await operateClickTool.handler(
        { session_id: sessionId, ref: t4[0]! },
        null,
      )) as unknown as { safe_table: string[][] };
      expect(rowFor(clicked.safe_table, "t4-gpu")[2]).toContain("s=c");
      expect(await page.locator("#t4").getAttribute("aria-checked")).toBe("true");
      const checked = (await operateClickTool.handler(
        { session_id: sessionId, ref: notify[0]! },
        null,
      )) as unknown as { safe_table: string[][] };
      expect(rowFor(checked.safe_table, "notify-me")[2]).toContain("s=c");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("reads and changes native radio inputs nested in Colab Material shadow roots", async () => {
    const { page, controller, sessionId } = await fixture(false, COLAB_RADIOS);
    try {
      expect(await page.locator('input[aria-label="CPU"]').isChecked()).toBe(true);
      expect(await page.locator('input[aria-label="CPU"]').isVisible()).toBe(true);
      const inventory = await controller.extractInteractiveElements(page);
      const cpuInput = inventory.find((el) => el.tag === "input" && el.ariaLabel === "CPU");
      const t4Input = inventory.find((el) => el.tag === "input" && el.ariaLabel === "T4 GPU");
      expect(cpuInput?.checked).toBe(true);
      expect(cpuInput?.selector).not.toBe(t4Input?.selector);
      const before = (await observeQuery(sessionId, "", "r")) as unknown as {
        safe_table: string[][];
      };
      expect(rowFor(before.safe_table, "cpu")[2]).toContain("s=c");
      const t4 = rowFor(before.safe_table, "t4-gpu");
      expect(t4[2]).toContain("s=u");
      const clicked = (await operateClickTool.handler(
        { session_id: sessionId, ref: t4[0]! },
        null,
      )) as unknown as { safe_table: string[][] };
      expect(rowFor(clicked.safe_table, "t4-gpu")[2]).toContain("s=c");
      expect(rowFor(clicked.safe_table, "t4-gpu")[2]).toContain("w=acted");
      const after = (await observeQuery(sessionId, "", "r")) as unknown as {
        safe_table: string[][];
      };
      expect(rowFor(after.safe_table, "cpu")[2]).toContain("s=u");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("reads cross-origin cell output and errors in a full observation", async () => {
    const { page, sessionId } = await fixture();
    try {
      expect(new URL(page.frames()[1]!.url()).origin).not.toBe(new URL(page.url()).origin);
      const full = (await observe(sessionId, "full")) as unknown as { dom: string };
      expect(full.dom).toContain("ValueError: synthetic cell failure");
      expect(full.dom).toContain("2");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("keeps the default notebook observation inside the compact wire budget", async () => {
    const { page, sessionId, start } = await fixture(true);
    try {
      expect(start.format).toBe("browser-use-control-query");
      expect(await page.locator("#large").evaluate((el) => el.textContent!.length)).toBeGreaterThan(
        67000,
      );
      expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThanOrEqual(
        OBSERVE_V2_MAX_WIRE_BYTES,
      );
      const observed = await observe(sessionId, "compact");
      expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThanOrEqual(
        OBSERVE_V2_MAX_WIRE_BYTES,
      );
      expect(start).toHaveProperty("overflow.next_cursor");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("puts the acted checkbox and its new state on the first page of a crowded notebook", async () => {
    const { page, sessionId, start } = await fixture(true);
    try {
      expect(start).toHaveProperty("overflow.next_cursor");
      const query = (await observeQuery(sessionId, "Select all")) as unknown as {
        safe_table: string[][];
      };
      const selectAll = rowFor(query.safe_table, "select-all");
      const clicked = (await operateClickTool.handler(
        { session_id: sessionId, ref: selectAll[0]! },
        null,
      )) as unknown as { safe_table: string[][] };
      expect(rowFor(clicked.safe_table, "select-all")[2]).toContain("s=c");
      expect(rowFor(clicked.safe_table, "select-all")[2]).toContain("w=acted");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);

  it("dispatches Control+F9 and clicks the visible Run all button across repeated shadow ids", async () => {
    const { page, sessionId, start } = await fixture();
    try {
      await operatePressTool.handler({ session_id: sessionId, key: "Control+F9" }, null);
      expect(await page.locator("#runs").textContent()).toBe("1");
      const runAll = rowFor(start.safe_table as string[][], "run-all");
      await operateClickTool.handler({ session_id: sessionId, ref: runAll[0]! }, null);
      expect(await page.locator("#runs").textContent()).toBe("2");
    } finally {
      await finishProvisionSession(sessionId);
      await page.context().close();
    }
  }, 120000);
});
