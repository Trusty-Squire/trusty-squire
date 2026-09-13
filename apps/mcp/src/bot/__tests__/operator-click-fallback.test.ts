import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import {
  operateClickTool,
  operateTypeTool,
  operateSelectTool,
  provisionObserveTool,
} from "../../tools/provision-drive.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

describe("operate_click internal fallback with a real browser", () => {
  it("clicks an intercepted control exactly once in legacy mode", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(1000);
    const url = "https://click-fallback.test/";
    await page.route(url, async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
      <button id="continue" style="position:absolute;left:20px;top:20px;width:150px;height:50px"
        onclick="document.querySelector('output').textContent=String(++window.clicks)">Continue</button>
      <div style="position:absolute;left:20px;top:20px;width:150px;height:50px;z-index:10">Overlay</div>
      <output>0</output><script>window.clicks=0</script>`,
      }),
    );
    await page.goto(url);
    const controller = BrowserController.fromHarnessPage(page);
    const plainClick = vi.spyOn(controller, "click");
    const domClick = vi.spyOn(controller, "clickViaJs");
    const started = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
    });
    try {
      await provisionObserveTool.handler({ session_id: started.session_id }, null);
      await operateClickTool.handler({ session_id: started.session_id, ref: "Continue" }, null);
      expect(plainClick).toHaveBeenCalledOnce();
      await expect(plainClick.mock.results[0]!.value).rejects.toThrow("intercepts pointer events");
      expect(domClick).toHaveBeenCalledOnce();
      expect(await page.locator("output").textContent()).toBe("1");
      expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});

it.each(["click", "type", "select"] as const)(
  "self-heals a control replaced into a different SPA layout before %s",
  async (kind) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://spa-ref.test/";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main><button onclick="document.querySelector('output').textContent='clicked'">Continue</button><input aria-label="Email"><select aria-label="Country"><option value="us">US</option><option value="jp">Japan</option></select></main><output></output>`,
      }),
    );
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      observationFormat: "browser-use-dom",
      format: "compact",
    });
    try {
      const rows = (started as unknown as { safe_table: string[][] }).safe_table;
      const label = { click: "@continue", type: "@email", select: "@country" }[kind];
      const ref = rows.find((row) => row[2]?.split("|")[0] === label)![0]!;
      await page.evaluate(() => {
        const main = document.querySelector("main")!;
        main.innerHTML = `<section><p>Hydrated checkout</p>${main.innerHTML}</section>`;
      });
      if (kind === "click") {
        await operateClickTool.handler({ session_id: started.session_id, ref }, null);
        expect(await page.locator("output").textContent()).toBe("clicked");
      } else if (kind === "type") {
        await operateTypeTool.handler(
          { session_id: started.session_id, ref, text: "person@example.test" },
          null,
        );
        expect(await page.locator("input").inputValue()).toBe("person@example.test");
      } else {
        await operateSelectTool.handler(
          { session_id: started.session_id, ref, values: ["Japan"] },
          null,
        );
        expect(await page.locator("select").inputValue()).toBe("jp");
      }
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  },
  30_000,
);

it("waits for hydration and retries transient frame bindings on start and observe", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://hydration.test/";
  await page.route(`${url}**`, async (route) => {
    if (route.request().url().endsWith("/hydrate")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ body: "ready" });
    } else if (route.request().url().endsWith("/frame")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ contentType: "text/html", body: "<button>Frame ready</button>" });
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: `<main>Loading</main>
        <script>fetch('/hydrate').then(() => document.querySelector('main').innerHTML =
        '<button>Hydrated</button><iframe src="/frame"></iframe>')</script>`,
      });
    }
  });
  const controller = BrowserController.fromHarnessPage(page);
  const original = context.newCDPSession.bind(context);
  let badBindings = 2;
  let retries = 0;
  vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const cdp = await original(target);
    const send = cdp.send.bind(cdp);
    vi.spyOn(cdp, "send").mockImplementation((async (method: string, params: unknown) => {
      const result = await (send as Function)(method, params);
      if (
        method === "Page.getFrameTree" &&
        badBindings > 0 &&
        result.frameTree.childFrames?.length
      ) {
        badBindings--;
        retries++;
        result.frameTree.childFrames[0].frame.url = `${url}still-binding`;
      }
      return result;
    }) as typeof cdp.send);
    return cdp;
  });
  let sessionId: string | undefined;
  try {
    const start = await startHarnessProvisionSession({
      browser: controller,
      serviceUrl: url,
      observationFormat: "browser-use-dom",
      format: "full",
    });
    sessionId = start.session_id;
    expect(JSON.stringify(start)).toContain("Hydrated");
    expect(JSON.stringify(start)).toContain("Frame ready");
    expect(JSON.stringify(start)).not.toContain("frame_binding_failed");
    expect(retries).toBe(2);
    badBindings = 2;
    await page.evaluate(() => {
      void fetch("/hydrate").then(
        () => (document.querySelector("button")!.textContent = "Updated"),
      );
    });
    const observed = await provisionObserveTool.handler(
      { session_id: sessionId, format: "full" },
      null,
    );
    expect(JSON.stringify(observed)).toContain("Updated");
    expect(JSON.stringify(observed)).not.toContain("frame_binding_failed");
    expect(retries).toBe(4);
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await context.close();
  }
}, 30_000);

it("returns stable controls and a settle omission when DOM churn never stops", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://busy-spa.test/";
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<button>Continue</button><output></output><script>setInterval(() => document.querySelector('output').textContent = String(Date.now()), 50)</script>`,
    }),
  );
  let sessionId: string | undefined;
  try {
    const startedAt = Date.now();
    const start = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      observationFormat: "browser-use-dom",
      format: "full",
    });
    sessionId = start.session_id;
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(JSON.stringify(start)).toContain("Continue");
    expect(JSON.stringify(start)).toContain("dom_settle_timeout");
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await context.close();
  }
}, 15_000);

it.each(["removed", "ambiguous"])(
  "returns proven not-dispatched for a %s control and allows observing again",
  async (change) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = "https://stale-spa.test/";
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body: `<main><button>Continue</button></main>` }),
    );
    let sessionId: string | undefined;
    try {
      const start = await startHarnessProvisionSession({
        browser: BrowserController.fromHarnessPage(page),
        serviceUrl: url,
        observationFormat: "browser-use-dom",
        format: "compact",
      });
      sessionId = start.session_id;
      const rows = (start as unknown as { safe_table: string[][] }).safe_table;
      const ref = rows.find((row) => row[2]?.split("|")[0] === "@continue")![0]!;
      await page.evaluate((change) => {
        document.querySelector("main")!.innerHTML =
          change === "removed"
            ? "<p>Gone</p>"
            : "<section><button>Continue</button><button>Continue</button></section>";
      }, change);
      await expect(
        operateClickTool.handler({ session_id: sessionId, ref }, null),
      ).rejects.toBeInstanceOf(ProvenPreDispatchMutationError);
      await expect(
        provisionObserveTool.handler({ session_id: sessionId }, null),
      ).resolves.toHaveProperty("session_id", sessionId);
    } finally {
      if (sessionId) await finishProvisionSession(sessionId);
      await context.close();
    }
  },
  20_000,
);
