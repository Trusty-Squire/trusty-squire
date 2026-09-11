import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { operateClickTool, operateTypeTool, operatePressTool } from "../../tools/provision-drive.js";

it("returns compact action payloads from a real reveal page and verbatim DOM on request", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let sessionId: string | undefined;
  const evidence = process.env.ACTION_COMPACT_EVIDENCE_DIR;
  const transcript: unknown[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.route("https://fixture.test/**", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>Action response fixture</title>
      <nav>${Array.from({length: 40}, (_, i) => `<a href="#nav${i}">Navigation ${i}</a>`).join(" ")}</nav>
      <main><h1>API keys — synthetic test account</h1>
      <label>API key <input id="key" value="hidden" readonly></label>
      <button onclick="document.querySelector('#key').value='synthetic-revealed-key'; document.querySelector('#copy').hidden=false">Reveal</button>
      <button id="copy" hidden>Copy</button>
      <label>Key name <input id="name"></label>
      <button>Create</button></main>`
    }));
    const start = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page), serviceUrl: "https://fixture.test/keys",
      observationFormat: "browser-use-dom", format: "compact",
    });
    sessionId = start.session_id;
    transcript.push({ tool: "operate_start (harness-owned Chromium)", response: start });
    const rows = (start as unknown as {safe_table: string[][]}).safe_table;
    const ref = (name: string) => {
      const row = rows.find(row => row[2]?.split("|")[0] === name);
      expect(row, `control ${name}`).toBeDefined();
      return row![0]!;
    };
    const clickArgs = {session_id: sessionId, ref: ref("@reveal")};
    const clicked = await operateClickTool.handler(clickArgs, null);
    transcript.push({tool: "operate_click", arguments: clickArgs, response: clicked});
    expect(await page.locator("#key").inputValue()).toBe("synthetic-revealed-key");
    expect(clicked).toMatchObject({format: "browser-use-control-query", delta: true});
    expect(JSON.stringify(clicked)).not.toContain("synthetic-revealed-key");
    expect(JSON.stringify(clicked)).not.toContain("@navigation-");
    expect(clicked).not.toHaveProperty("dom");
    if (evidence) {
      await mkdir(evidence, {recursive: true});
      await page.screenshot({path: join(evidence, "revealed-key-fixture.png"), fullPage: true});
    }
    const typeArgs = {session_id: sessionId, ref: ref("@key-name"), text: "Demo key"};
    const typed = await operateTypeTool.handler(typeArgs, null);
    transcript.push({tool: "operate_type", arguments: typeArgs, response: typed});
    expect(await page.locator("#name").inputValue()).toBe("Demo key");
    expect(typed).toMatchObject({format: "browser-use-control-query"});
    const pressArgs = {session_id: sessionId, key: "Tab"};
    const pressed = await operatePressTool.handler(pressArgs, null);
    transcript.push({tool: "operate_press", arguments: pressArgs, response: pressed});
    expect(pressed).toMatchObject({format: "browser-use-control-query"});
    for (const response of [typed, pressed]) {
      expect(response).not.toHaveProperty("dom");
      expect(JSON.stringify(response)).not.toContain("synthetic-revealed-key");
    }
    for (const [tool, args] of [
      [operateClickTool, clickArgs], [operateTypeTool, typeArgs], [operatePressTool, pressArgs],
    ] as const) {
      // Each full request observes a changed value; unchanged full snapshots
      // legitimately use dom_unchanged instead of repeating the previous DOM.
      await page.locator("#key").evaluate((element, value) => {
        (element as HTMLInputElement).value = value;
      }, `synthetic-revealed-key-${tool.name}`);
      const input = tool.inputSchema.parse({...args, format: "full"});
      const full = await tool.handler(input as never, null);
      transcript.push({tool: tool.name, arguments: input, response: full});
      expect(full).toMatchObject({format: "browser-use-dom"});
      expect((full as {dom: string}).dom).toContain("synthetic-revealed-key");
    }
    if (evidence) await writeFile(join(evidence, "action-responses.json"), JSON.stringify(transcript, null, 2));
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await browser.close();
  }
}, 60_000);
