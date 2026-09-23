import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { extractCredentials, maskedCredentialLabels } from "../capture/capture.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import { provisionExtractTool } from "../../tools/provision-drive.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser.close();
});

const secret = "sk" + "_live_fixtureSecret1234567890abcdef";
const writeKey = "vsk_sandbox_write_Zyx987wvu654Tsr321";
const readKey = "vsk_sandbox_read_Abc123def456Ghi789";

it("keeps a masked credential with a different visible prefix under the same label", () => {
  expect(
    maskedCredentialLabels(
      [
        { label: "API key", isMasked: false, value: "sk_live_first1234567890" },
        { label: "API key", isMasked: true, value: "sk_live_second…" },
      ],
      ["api_key"],
    ),
  ).toEqual(["API key"]);
});

it("reveals every sibling and leaves regenerate untouched", async () => {
  const detail = `<!doctype html><meta charset="utf-8"><title>Fixture app</title><main><h1>Credentials</h1>
    <div><label>Secret <input readonly value="${secret}"></label></div>
    <div><label>Sandbox write key</label><code id="write">vsk_sandbox_write_20af…</code>
      <button id="regenerate" type="button">Show and regenerate key</button>
      <button id="reveal-write" type="button">Reveal</button></div>
    <div><label>Sandbox read key</label><code id="read">vsk_sandbox_read_20af…</code>
      <button id="reveal-read" type="button">Reveal</button></div>
    </main><script>
      window.regenerations = 0;
      document.getElementById("reveal-write").onclick = () => {
        document.getElementById("write").textContent = ${JSON.stringify(writeKey)};
      };
      document.getElementById("reveal-read").onclick = () => {
        document.getElementById("read").textContent = ${JSON.stringify(readKey)};
      };
      document.getElementById("regenerate").onclick = () => { window.regenerations += 1; };
    </script>`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: detail }));
  const startUrl = "https://fixture.test/settings/apps/fixture";
  await page.goto(startUrl);
  const controller = BrowserController.fromHarnessPage(page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: startUrl,
    format: "compact",
    initialObservation: "standard",
  });
  const dependencies: DriveDependencies = {
    askJev: async (_api, _state, questions) => {
      const answers: Record<
        string,
        { choice: string; confidence: number; probabilities: Record<string, number> }
      > = {};
      for (const [name, question] of Object.entries(questions)) {
        if (question.type !== "choice") continue;
        const keys = Object.keys(question.criteria);
        const choice = name === "operation" && keys.includes("CLICK") ? "CLICK" : keys[0]!;
        answers[name] = {
          choice,
          confidence: 0.95,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? (keys.length === 1 ? 1 : 0.95) : 0.05 / (keys.length - 1),
            ]),
          ),
        };
      }
      return { attempts: 1, elapsedMs: 1, result: { answers } };
    },
    act,
    observe,
    startSession: async () => {
      throw new Error("fixture uses existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
  try {
    const result = await runOperateDrive(
      { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
      { useCredential: vi.fn() } as unknown as ApiClient,
      undefined,
      dependencies,
    );
    const extracted = await extractCredentials(started.session_id);
    expect(result.status).toBe("complete");
    expect(page.url()).toContain("/settings/apps/");
    expect(extracted.credentials).toMatchObject({
      secret,
      sandbox_write_key: writeKey,
      sandbox_read_key: readKey,
    });
    expect(extracted.masked_remaining ?? []).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { regenerations: number }).regenerations),
    ).toBe(0);
    const storeCredential = vi.fn().mockResolvedValue({
      reference: "vault://fixture/credentials",
      service: "fixture",
      label: "default",
      field_names: Object.keys(extracted.credentials),
      allowed_hosts: ["fixture.test"],
      created_at: "now",
      updated: false,
    });
    const stored = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({
        session_id: started.session_id,
        store: { service: "fixture" },
      }),
      { storeCredential } as unknown as ApiClient,
    );
    expect(storeCredential).toHaveBeenCalledOnce();
    expect(storeCredential.mock.calls[0]?.[0].fields).toMatchObject({
      secret,
      sandbox_write_key: writeKey,
      sandbox_read_key: readKey,
    });
    expect(JSON.stringify(stored)).not.toContain(secret);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}, 30_000);
