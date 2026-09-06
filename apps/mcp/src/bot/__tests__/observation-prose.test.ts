// The compact-v2 text channel's GENUINE extraction path, against a real
// Chromium rendering a real document — no stub. This is the coverage gap that
// shipped the channel inert in 1.1.14-rc.3 (2026-09-06): the flow suite stubs
// `extractObservationProse`, so nothing noticed that
// `page.evaluate(extractObservationProseItems)` throws
// `ReferenceError: OBSERVATION_PROSE_MAX_ITEMS is not defined` on every real
// page (the serialized function referenced module-scope constants that do not
// travel into the page), while the observation's catch swallowed the throw and
// every observation emitted `text: ""`.
//
// These tests pin two things:
// 1. The extractor is self-contained: `page.evaluate(extractObservationProseItems)`
//    is the exact production call and only works if the function's source text
//    carries every identifier it references. If anyone moves a constant back
//    out to module scope, the evaluate below throws and these tests fail.
// 2. The full wire path with the real extractor — extract → screen →
//    encodeV2Page — emits the prose as `text` on the FIRST observation for a
//    document, with control labels excluded (the action map's job) and
//    credential-shaped prose screened through the shared redactor.
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractObservationProseItems } from "../browser.js";
import {
  encodeV2Page,
  screenObservationProseV2,
  type SafeControlV2,
} from "../compact-observation-v2.js";

let chromiumAvailable = false;
try {
  chromiumAvailable = existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

let sharedBrowser: Browser | undefined;

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete token literal appears in this source file (GitHub
// secret scanning false-positived on test data — PR #681). The assembled
// value is byte-identical to the token shape the ipinfo dogfood leaked; do
// NOT inline it back into a single string literal.
const hexToken = (body: string): string => "f9a062f02fad" + body;

beforeAll(async () => {
  if (chromiumAvailable) sharedBrowser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await sharedBrowser?.close();
});

async function newRealPage(): Promise<Page> {
  if (sharedBrowser === undefined) throw new Error("Chromium test browser was not started");
  const context = await sharedBrowser.newContext();
  return await context.newPage();
}

const DASHBOARD_HTML = `<!doctype html>
<html>
<head><title>API Tokens · Example</title></head>
<body>
  <h1>API Tokens</h1>
  <p>Treat your token like a password: anyone holding it can act as you.</p>
  <p>Live token: ${hexToken("df5")} — copy it now.</p>
  <ul>
    <li>Free plan includes 50,000 requests per month.</li>
    <li>Paid plan raises the ceiling.</li>
  </ul>
  <nav>
    <a href="/docs">Documentation</a>
    <button id="copy">Copy token</button>
  </nav>
  <p style="display:none">Hidden teaser text must never reach the channel.</p>
  <div role="alert">Rate limit nearly reached.</div>
  <p>${"Long paragraph ".repeat(30)}</p>
</body>
</html>`;

describe.skipIf(!chromiumAvailable)("compact-v2 text channel (real extractor)", () => {
  it("extracts prose through the production page.evaluate call without throwing", async () => {
    const page = await newRealPage();
    await page.setContent(DASHBOARD_HTML);
    // The exact call browser.ts makes. If extractObservationProseItems ever
    // references something outside its own source text again, this throws
    // ReferenceError instead of returning prose — the shipped-inert failure.
    const items = await page.evaluate(extractObservationProseItems);
    expect(items.length).toBeGreaterThan(0);
    expect(items).toContain("API Tokens");
    expect(items).toContain(
      "Treat your token like a password: anyone holding it can act as you.",
    );
    expect(items).toContain("Free plan includes 50,000 requests per month.");
    expect(items).toContain("Rate limit nearly reached.");
    // Interactive-control labels are the action map's job, not the channel's.
    expect(items).not.toContain("Copy token");
    expect(items).not.toContain("Documentation");
    // Hidden content stays out.
    expect(items.join("\n")).not.toContain("Hidden teaser text");
    // Items are bounded.
    for (const item of items) expect(item.length).toBeLessThanOrEqual(200);
    await page.context().close();
  });

  it("extracts fresh prose for a second document in the same tab (first observation per document)", async () => {
    const page = await newRealPage();
    await page.setContent(DASHBOARD_HTML);
    const first = await page.evaluate(extractObservationProseItems);
    expect(first).toContain("API Tokens");
    await page.setContent(
      `<!doctype html><html><body><h1>Teams</h1><p>Invite teammates to your workspace.</p></body></html>`,
    );
    // A new document must be extracted on its own merits — no reliance on any
    // state the first document established (page-side or sticky baselines).
    const second = await page.evaluate(extractObservationProseItems);
    expect(second).toContain("Teams");
    expect(second).toContain("Invite teammates to your workspace.");
    expect(second).not.toContain("API Tokens");
    await page.context().close();
  });

  it("carries the real extractor's output to the wire on the first observation for a document", async () => {
    const page = await newRealPage();
    await page.setContent(DASHBOARD_HTML);
    const prose = await page.evaluate(extractObservationProseItems);
    // The shared screen from PR #678 runs on the genuine extractor output: the
    // reflected live token must reach the wire redacted, the real copy intact.
    const screened = screenObservationProseV2(prose);
    expect(screened).toContain(
      "Treat your token like a password: anyone holding it can act as you.",
    );
    expect(screened.some((item) => item.includes(hexToken("df5")))).toBe(false);
    expect(screened.some((item) => item.includes("[redacted]"))).toBe(true);
    // First observation for a document = a full paged map, and the text
    // channel rides it whenever prose exists. Rows stay primary: encode with a
    // representative row and assert the text channel is present alongside it.
    const rows: SafeControlV2[] = [
      {
        ref: "@e:copy",
        role: "button",
        visibility: "viewport",
        label: "@copy-token",
        frame: "main",
      },
    ];
    const { payload } = encodeV2Page({
      sessionId: "sess-test",
      stage: "browse",
      pageUrl: "https://app.example.com/dashboard/token",
      semantics: { title: "API Tokens · Example", headings: ["API Tokens"] },
      rows,
      cursorFor: () => "cursor",
      pageText: screened,
    });
    expect(payload.safe_table).toHaveLength(1);
    expect(typeof payload.text).toBe("string");
    expect(payload.text).toContain("API Tokens");
    expect(payload.text).toContain("Treat your token like a password");
    await page.context().close();
  });
});
