import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { BrowserController } from "../browser.js";
import { dispatchDriveAct } from "../act/act.js";
import { runOperateDrive } from "../operate-drive.js";
import {
  act,
  finishProvisionSession,
  formSelectMany,
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

describe("drive public action handback", () => {
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
