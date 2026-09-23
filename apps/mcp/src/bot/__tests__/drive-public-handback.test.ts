import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { dispatchDriveAct } from "../act/act.js";
import { runOperateDrive } from "../operate-drive.js";
import {
  act,
  finishProvisionSession,
  formSelectMany,
  injectCardIntoSessionTargets,
  observe,
  observeSubtree,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

const URL = "https://drive-handback.test/form";
const HTML = `<!doctype html><meta charset="utf-8"><title>Handback</title>
<label>Name <input id="name" type="text"></label>
<label>Region <select id="region"><option>Choose</option><option>North</option></select></label>
<button id="send" type="button" onclick="window.hits=(window.hits||0)+1">Send</button>
<button class="duplicate" type="button">Duplicate</button>
<button class="duplicate" type="button">Duplicate</button>`;
const CARD = {
  pan: "4111111111111111",
  cvv: "739",
  exp_month: "12",
  exp_year: "2030",
  name: "Ada",
  billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: HTML }));
  await page.goto(URL);
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: URL,
    format: "compact",
    initialObservation: "drive",
  });
  const capture = vi.spyOn(controller, "extractBrowserUseObservation");
  const handback = async () => {
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "inspect form", max_steps: 0 },
      null,
    );
    const rows = result.observation?.safe_table;
    if (!Array.isArray(rows)) throw new Error("missing handback rows");
    return rows as unknown as Array<[string, string, string?]>;
  };
  const ref = (rows: Array<[string, string, string?]>, label: string) => {
    const row = rows.find((candidate) => candidate[2]?.split("|")[0] === label);
    if (row === undefined) throw new Error(`missing ${label}`);
    return row[0];
  };
  const close = async () => {
    capture.mockRestore();
    await finishProvisionSession(started.session_id);
    await context.close();
  };
  return { page, controller, started, capture, handback, ref, close };
}

async function cardFixture(remountCvvOnPanInput = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sharedUrl = "https://provider.test/shared";
  const url = "https://hosted-handback.test/checkout";
  await page.route(sharedUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<label>Card field <input id="field" ${remountCvvOnPanInput ? "oninput=\"parent.postMessage('remount-cvv','*')\"" : ""}></label>`,
    }),
  );
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe id="pan" name="pan" src="${sharedUrl}"></iframe><iframe id="cvv" name="cvv" src="${sharedUrl}"></iframe>
        <script>let remounted=false; window.addEventListener('message', e => {
          if (e.data === 'remount-cvv' && !remounted) {
            remounted=true;
            document.querySelector('#cvv').outerHTML='<iframe id="cvv" name="cvv" src="${sharedUrl}"></iframe>';
          }
        });</script>`,
    }),
  );
  await page.goto(url);
  await page.frameLocator("#pan").locator("#field").waitFor();
  await page.frameLocator("#cvv").locator("#field").waitFor();
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  const capture = vi.spyOn(controller, "extractBrowserUseObservation");
  const result = await runOperateDrive(
    {
      session_id: started.session_id,
      goal: "inspect card fields",
      facts: { card_ref: "card" },
      max_steps: 0,
    },
    null,
  );
  const rows = result.observation?.safe_table;
  if (!Array.isArray(rows)) throw new Error("missing card handback rows");
  const anchors = sessionForCall(started.session_id)!.compactV2DriveAnchors;
  const refs = Object.fromEntries(
    (rows as unknown as Array<[string, string, string?]>).flatMap(([ref]) => {
      const anchor = anchors.get(ref);
      return anchor === undefined ? [] : [[anchor.frame.name(), ref]];
    }),
  ) as Record<string, string>;
  expect(refs.pan).toMatch(/^@e:/);
  expect(refs.cvv).toMatch(/^@e:/);
  const close = async () => {
    capture.mockRestore();
    await finishProvisionSession(started.session_id);
    await context.close();
  };
  return { page, controller, started, capture, refs, sharedUrl, close };
}

describe("drive public action handback", () => {
  it("injects PAN and CVV from drive handback into separate same-URL cross-origin frames after sibling insertion", async () => {
    const f = await cardFixture();
    try {
      await f.page.evaluate((url) => {
        const decoy = document.createElement("iframe");
        decoy.name = "decoy";
        decoy.src = url;
        document.body.prepend(decoy);
      }, f.sharedUrl);
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: f.refs.pan! },
        cvv: { ref: f.refs.cvv! },
      });
      expect(fields).toEqual({ pan: { status: "filled" }, cvv: { status: "filled" } });
      expect(await f.page.frameLocator("#pan").locator("#field").inputValue()).toBe(CARD.pan);
      expect(await f.page.frameLocator("#cvv").locator("#field").inputValue()).toBe(CARD.cvv);
      expect(await f.page.frameLocator("iframe[name=decoy]").locator("#field").inputValue()).toBe(
        "",
      );
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }, 30_000);

  it("does not follow a remounted CVV frame between PAN and CVV writes", async () => {
    const f = await cardFixture(true);
    try {
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: f.refs.pan! },
        cvv: { ref: f.refs.cvv! },
      });
      expect(fields.pan).toEqual({ status: "filled" });
      expect(fields.cvv).toEqual({ status: "detached" });
      expect(await f.page.frameLocator("#cvv").locator("#field").inputValue()).toBe("");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("does not retarget old card refs when same-URL frames are reordered", async () => {
    const f = await cardFixture();
    try {
      await f.page.evaluate(() => {
        const pan = document.querySelector("#pan")!;
        const cvv = document.querySelector("#cvv")!;
        pan.before(cvv);
      });
      expect(await f.page.locator("iframe").first().getAttribute("id")).toBe("cvv");
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: f.refs.pan! },
        cvv: { ref: f.refs.cvv! },
      });
      const panValue = await f.page.frameLocator("#pan").locator("#field").inputValue();
      const cvvValue = await f.page.frameLocator("#cvv").locator("#field").inputValue();
      expect(panValue).not.toBe(CARD.cvv);
      expect(cvvValue).not.toBe(CARD.pan);
      if (fields.pan.status === "filled") expect(panValue).toBe(CARD.pan);
      else expect(panValue).toBe("");
      if (fields.cvv.status === "filled") expect(cvvValue).toBe(CARD.cvv);
      else expect(cvvValue).toBe("");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("rejects a stale card node before dispatch and leaves its replacement empty", async () => {
    const f = await cardFixture();
    try {
      await f.page
        .frameLocator("#pan")
        .locator("#field")
        .evaluate((node) => {
          node.replaceWith(node.cloneNode(true));
        });
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: f.refs.pan! },
      });
      expect(fields.pan).toEqual({ status: "detached" });
      expect(await f.page.frameLocator("#pan").locator("#field").inputValue()).toBe("");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("rejects an expired card handback before any field write", async () => {
    const f = await cardFixture();
    try {
      sessionForCall(f.started.session_id)!.compactV2Index!.expiresAt = Date.now() - 1;
      await expect(
        injectCardIntoSessionTargets(f.started.session_id, CARD, {
          pan: { ref: f.refs.pan! },
        }),
      ).rejects.toThrow("stale_ref");
      expect(await f.page.frameLocator("#pan").locator("#field").inputValue()).toBe("");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("still accepts a canonical observed card target", async () => {
    const f = await fixture();
    try {
      const observation = await observe(f.started.session_id, "compact");
      const rows = observation.safe_table as unknown as Array<[string, string, string?]>;
      const ref = rows.find((row) => row[2]?.startsWith("@name"))?.[0];
      expect(ref).toMatch(/^@e:/);
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: ref! },
      });
      expect(fields.pan).toEqual({ status: "filled" });
      expect(await f.page.locator("#name").inputValue()).toBe(CARD.pan);
    } finally {
      await f.close();
    }
  }, 30_000);

  it("does not adopt a replacement canonical card input during retries", async () => {
    const f = await fixture();
    try {
      const observation = await observe(f.started.session_id, "compact");
      const rows = observation.safe_table as unknown as Array<[string, string, string?]>;
      const ref = rows.find((row) => row[2]?.startsWith("@name"))?.[0];
      expect(ref).toMatch(/^@e:/);
      await f.page.locator("#name").evaluate((node) => node.replaceWith(node.cloneNode(true)));
      const fields = await injectCardIntoSessionTargets(f.started.session_id, CARD, {
        pan: { ref: ref! },
      });
      expect(fields.pan).toEqual({ status: "detached" });
      expect(await f.page.locator("#name").inputValue()).toBe("");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("uses click, type and select refs without an intervening observe or handback CDP capture", async () => {
    const f = await fixture();
    try {
      let rows = await f.handback();
      expect(f.capture).not.toHaveBeenCalled();
      await act(f.started.session_id, { kind: "type", target: f.ref(rows, "@name"), text: "Ada" });
      expect(await f.page.locator("#name").inputValue()).toBe("Ada");

      rows = await f.handback();
      const beforeSelect = f.capture.mock.calls.length;
      await act(f.started.session_id, {
        kind: "select",
        target: f.ref(rows, "@region"),
        text: "North",
      });
      expect(await f.page.locator("#region").inputValue()).toBe("North");
      expect(f.capture.mock.calls.length).toBe(beforeSelect + 1); // terminal observation only

      rows = await f.handback();
      await act(f.started.session_id, { kind: "click", target: f.ref(rows, "@send") });
      expect(await f.page.evaluate(() => (window as Window & { hits?: number }).hits)).toBe(1);
    } finally {
      await f.close();
    }
  }, 30_000);

  it("returns stale_ref before dispatch for a removed node and its surviving sibling", async () => {
    const f = await fixture();
    try {
      const rows = await f.handback();
      const duplicates = rows.filter((row) => row[2]?.startsWith("@duplicate"));
      expect(duplicates).toHaveLength(2);
      expect(duplicates.map((row) => row[2]?.split("|")[0])).toEqual([
        "@duplicate",
        "@duplicate-2",
      ]);
      await f.page
        .locator(".duplicate")
        .first()
        .evaluate((node) => node.remove());
      const click = vi.spyOn(f.controller, "click");
      await expect(
        act(f.started.session_id, { kind: "click", target: duplicates[0]![0] }),
      ).rejects.toThrow("stale_ref");
      expect(click).not.toHaveBeenCalled();
      expect(await f.page.locator(".duplicate").count()).toBe(1);
    } finally {
      await f.close();
    }
  }, 30_000);

  it("rejects a new document and an expired index before dispatch", async () => {
    const f = await fixture();
    try {
      const rows = await f.handback();
      const target = f.ref(rows, "@send");
      const session = sessionForCall(f.started.session_id)!;
      session.compactV2Index!.expiresAt = Date.now() - 1;
      await expect(act(f.started.session_id, { kind: "click", target })).rejects.toThrow(
        "stale_ref",
      );
      expect(await f.page.evaluate(() => (window as Window & { hits?: number }).hits ?? 0)).toBe(0);
      const fresh = await f.handback();
      await f.page.reload();
      await expect(
        act(f.started.session_id, { kind: "click", target: f.ref(fresh, "@send") }),
      ).rejects.toThrow("stale_ref");
      expect(await f.page.evaluate(() => (window as Window & { hits?: number }).hits ?? 0)).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);

  it("accepts drive handles in subtree and select-many readers", async () => {
    const f = await fixture();
    try {
      let rows = await f.handback();
      const subtree = await observeSubtree(f.started.session_id, f.ref(rows, "@name"));
      expect(subtree).toHaveProperty("subtree.tag", "input");
      rows = await f.handback();
      const result = await formSelectMany(f.started.session_id, {
        [f.ref(rows, "@region")]: "North",
      });
      expect(result.fields[0]?.status).toBe("selected");
      expect(await f.page.locator("#region").inputValue()).toBe("North");
    } finally {
      await f.close();
    }
  }, 30_000);

  it("keeps private drive dispatch outside public handle admission", async () => {
    const f = await fixture();
    try {
      await f.handback();
      const identities = sessionForCall(f.started.session_id)?.drive?.identities;
      const privateRef = [...(identities?.entries() ?? [])].find(
        ([, identity]) => identity.label === "Send",
      )?.[0];
      expect(privateRef).toMatch(/^@e:f\d+d\d+$/);
      const result = await dispatchDriveAct(f.started.session_id, {
        kind: "click",
        target: privateRef!,
      });
      expect(result.kind).toBe("ok");
      expect(await f.page.evaluate(() => (window as Window & { hits?: number }).hits)).toBe(1);
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }, 30_000);
});
