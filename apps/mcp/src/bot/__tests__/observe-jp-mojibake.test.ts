// Regression for operator-observe-jp-mojibake: element extraction returning
// garbled (鐃緒申…) Japanese for <select> option labels + button text on
// non-UTF-8 pages (Rakuten et al. serve EUC-JP / Shift_JIS).
//
// ROOT CAUSE (proven below): the hardened launcher (patchright, default-ON via
// BOT_CDP_HARDENED) makes patchright intercept and REWRITE every text/html
// Document response to inject its context init scripts into <head> — and that
// injection decodes the raw response bytes as UTF-8 unconditionally, so an
// EUC-JP page is corrupted at the byte level BEFORE Chrome parses it. The DOM
// then holds mojibake, which observe/extract faithfully reports. The trigger is
// having ANY context.addInitScript registered; with none, patchright leaves the
// body untouched. Under patchright those init scripts don't reach the main
// world anyway (the per-navigation page.evaluate re-application is the effective
// path), so browser.ts now skips the context-level installs under hardened
// mode — removing the corruption trigger at no stealth cost.
//
// These tests exercise the REAL extractInteractiveElements against a real
// EUC-JP page served over local HTTP (no network egress, no Rakuten), launched
// with the SAME hardened launcher production uses. The "fixed production shape"
// (no context init script) must extract true Unicode; a companion test pins the
// upstream trigger so a patchright behavior change would surface here.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "patchright";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BrowserController, contextInitScriptsFor } from "../browser.js";

// Encode a UTF-16 JS string to EUC-JP bytes. Node ships a decode-only
// TextDecoder("euc-jp"); we invert it once over the 2-byte EUC-JP plane to
// build a char→bytes map, so the fixture is genuine EUC-JP (not faked). ASCII
// passes through as-is. Every char used in the fixtures below is in this plane.
function makeEucJpEncoder(): (s: string) => Buffer {
  const dec = new TextDecoder("euc-jp");
  const map = new Map<string, [number, number]>();
  for (let a = 0xa1; a <= 0xfe; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      const ch = dec.decode(Buffer.from([a, b]));
      if (ch.length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, [a, b]);
    }
  }
  return (s: string): Buffer => {
    const out: number[] = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0) as number;
      if (cp < 0x80) {
        out.push(cp);
      } else {
        const bytes = map.get(ch);
        if (bytes === undefined) throw new Error(`fixture char not in EUC-JP plane: ${ch}`);
        out.push(bytes[0], bytes[1]);
      }
    }
    return Buffer.from(out);
  };
}

// Real Japanese product-label text of the class seen garbled in the wild:
// color/size/wrapping option names, "only a few left", a yen price.
const JP = {
  placeholder: "選択してください", // survives in the wild (JS-injected); must stay correct here too
  color: "色/ピンク",
  wrap: "希望する/ラッピング",
  button: "カートに追加 968円残りわずか",
};

const encodeEucJp = makeEucJpEncoder();

function eucJpDoc(body: string): Buffer {
  return encodeEucJp(
    `<!doctype html><html><head><meta charset="euc-jp"><title>fixture</title></head>` +
      `<body style="margin:0;padding:20px">${body}</body></html>`,
  );
}

let httpServer: Server;
let port: number;

const selectAndButton =
  `<select id="opts" data-testid="opts">` +
  `<option value="">${JP.placeholder}</option>` +
  `<option value="c">${JP.color}</option>` +
  `<option value="w">${JP.wrap}</option>` +
  `</select>` +
  `<button id="buy" data-testid="buy">${JP.button}</button>` +
  `<button id="ascii" data-testid="ascii">Add to cart</button>`;

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    if (req.url === "/euc-jp") {
      res.setHeader("content-type", "text/html; charset=euc-jp");
      res.end(eucJpDoc(selectAndButton + `<iframe src="/euc-jp-frame" width="300" height="150">`));
    } else if (req.url === "/euc-jp-frame") {
      res.setHeader("content-type", "text/html; charset=euc-jp");
      res.end(
        eucJpDoc(
          `<select id="fopts" data-testid="fopts">` +
            `<option value="">${JP.placeholder}</option>` +
            `<option value="c">${JP.color}</option>` +
            `</select>`,
        ),
      );
    } else if (req.url === "/utf8") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        Buffer.from(
          `<!doctype html><html><head><meta charset="utf-8"></head>` +
            `<body>${selectAndButton}</body></html>`,
          "utf-8",
        ),
      );
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

let browser: Browser;

describe("browser startup context init scripts", () => {
  it("installs no context init scripts in hardened mode", () => {
    expect(contextInitScriptsFor({ hardened: true, remoteMode: false })).toEqual([]);
    expect(contextInitScriptsFor({ hardened: true, remoteMode: true })).toEqual([]);
  });

  it("keeps baseline init scripts and omits the WebGL spoof in remote mode", () => {
    expect(contextInitScriptsFor({ hardened: false, remoteMode: false })).toEqual([
      "evaluate-name-shim",
      "navigator-webdriver",
      "webgl-spoof",
    ]);
    expect(contextInitScriptsFor({ hardened: false, remoteMode: true })).toEqual([
      "evaluate-name-shim",
      "navigator-webdriver",
    ]);
  });
});

describe("operate observe/extract — non-UTF-8 (EUC-JP) label fidelity", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // The fixed production shape under patchright: NO context.addInitScript, so
  // patchright doesn't rewrite the text/html body. Extraction must return the
  // true Unicode the DOM holds.
  async function extractFrom(path: string): Promise<{ ctrl: BrowserController; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "networkidle" });
    const ctrl = new BrowserController({ humanize: false });
    (ctrl as unknown as { page: Page }).page = page;
    return { ctrl, page };
  }

  it("extracts EUC-JP <select> option labels + button text without mojibake (main frame)", async () => {
    const { ctrl, page } = await extractFrom("/euc-jp");
    try {
      const els = await ctrl.extractInteractiveElements();
      const select = els.find((e) => e.testId === "opts");
      const buy = els.find((e) => e.testId === "buy");

      expect(select).toBeDefined();
      // The exact garble class: JP.color/JP.wrap previously came back as
      // `鐃緒申…`. They must now be the true labels.
      expect(select?.selectOptions).toEqual([
        { value: "", text: JP.placeholder },
        { value: "c", text: JP.color },
        { value: "w", text: JP.wrap },
      ]);
      expect(buy?.visibleText).toBe(JP.button);

      // No output anywhere carries the mojibake signature.
      const serialized = JSON.stringify(els);
      expect(serialized).not.toContain("鐃");
      expect(serialized).not.toContain("�");
    } finally {
      await page.context().close();
    }
  }, 30000);

  it("keeps ASCII text and already-correct UTF-8 Japanese unchanged", async () => {
    // ASCII on the EUC-JP page.
    const euc = await extractFrom("/euc-jp");
    try {
      const els = await euc.ctrl.extractInteractiveElements();
      expect(els.find((e) => e.testId === "ascii")?.visibleText).toBe("Add to cart");
    } finally {
      await euc.page.context().close();
    }

    // A UTF-8 page with the same Japanese — the untouched control path.
    const utf8 = await extractFrom("/utf8");
    try {
      const els = await utf8.ctrl.extractInteractiveElements();
      const select = els.find((e) => e.testId === "opts");
      expect(select?.selectOptions).toEqual([
        { value: "", text: JP.placeholder },
        { value: "c", text: JP.color },
        { value: "w", text: JP.wrap },
      ]);
      expect(els.find((e) => e.testId === "buy")?.visibleText).toBe(JP.button);
    } finally {
      await utf8.page.context().close();
    }
  }, 30000);

  it("extracts EUC-JP labels correctly from a child iframe too", async () => {
    const { ctrl, page } = await extractFrom("/euc-jp");
    try {
      const els = await ctrl.extractInteractiveElements();
      const frameSelect = els.find((e) => e.testId === "fopts");
      expect(frameSelect).toBeDefined();
      expect(frameSelect?.frameOrigin).toBe(`http://127.0.0.1:${port}`);
      expect(frameSelect?.selectOptions).toEqual([
        { value: "", text: JP.placeholder },
        { value: "c", text: JP.color },
      ]);
    } finally {
      await page.context().close();
    }
  }, 30000);

  // Pin the upstream trigger the fix routes around: with a context init script
  // registered (the PRE-FIX shape), patchright rewrites the EUC-JP body and the
  // DOM itself garbles — read straight off the live DOM, before any of our
  // serialization runs. This proves the fixture reproduces the real garble
  // class, so the green assertions above are meaningful, and flags any
  // patchright change to this behavior.
  it("reproduces the upstream trigger: a context init script corrupts the EUC-JP DOM", async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: "/* any init script triggers the rewrite */ 0;" });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/euc-jp`, { waitUntil: "networkidle" });
      const domText = await page.evaluate(
        () => document.querySelector("select")?.textContent ?? "",
      );
      // The classic wrong-encoding signature, read directly from the DOM.
      expect(domText).toContain("鐃");
      expect(domText).not.toContain(JP.color);
    } finally {
      await context.close();
    }
  }, 30000);
});
