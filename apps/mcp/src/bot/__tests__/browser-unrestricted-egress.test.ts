import { chromium, type Browser } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
import { installBrokerBrowserCustody } from "../broker/custody.js";
import { startProvisionSession, finishProvisionSession } from "../session/lifecycle.js";

let browser: Browser;
let active: BrowserController;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  installBrokerBrowserCustody({
    acquire: async () => ({ browser: active, profileDir: "fixture-only" }),
    cleanupAdmission: async () => true,
    orphanAdmission: async () => {},
    orphan: async () => {},
    release: async (controller, beforeRelease) => {
      await beforeRelease?.();
      await controller.closeOwnPagesOnly();
    },
    identity: async (operation) => await operation(),
  });
});
afterAll(async () => {
  await browser?.close();
});

describe("operator egress", () => {
  it("delivers arbitrary SDK, 3DS, analytics and frame fetch/XHR requests without declarations", async () => {
    const context = await browser.newContext();
    const delivered: string[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      delivered.push(url);
      await route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        contentType: url.endsWith("/sdk.js") ? "application/javascript" : "text/html",
        body: url.endsWith("/sdk.js") ? "window.sdkLoaded = true" : "<main>Fixture</main>",
      });
    });
    active = BrowserController.fromHarnessPage(await context.newPage());
    vi.spyOn(active, "detectSessionProviders").mockResolvedValue(["google"]);
    vi.spyOn(active, "detectGoogleAccountEmail").mockResolvedValue("fixture@example.test");
    let sessionId: string | undefined;
    try {
      const result = await startProvisionSession(
        {
          serviceUrl: "https://merchant.example.test/checkout",
          extraAllowedHosts: ["ignored.example.test"],
        },
        {
          // The lifecycle/network boundary is under test; DOM formatting is independent.
          observeSession: async (session) => ({
            session_id: session.id,
            url: session.browser.currentUrl(),
            text: "",
            elements: [],
          }),
          compactV2StartMetadata: () => ({}),
        },
      );
      sessionId = result.session_id;
      const page = context.pages()[0]!;
      const hosts = [
        "assets.braintreegateway.com",
        "emvtds.sps-system.com",
        "arbitrary-third-party.test",
        "www.google-analytics.com",
      ];
      for (const host of hosts) {
        const url = `https://${host}/api`;
        expect(await page.evaluate(async (url) => (await fetch(url)).ok, url)).toBe(true);
        expect(
          await page.evaluate(
            (url) =>
              new Promise<number>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", url);
                xhr.onload = () => resolve(xhr.status);
                xhr.onerror = () => reject(new Error("XHR aborted"));
                xhr.send();
              }),
            url,
          ),
        ).toBe(200);
        expect(delivered.filter((entry) => entry === url)).toHaveLength(2);
      }
      await page.addScriptTag({ url: "https://assets.braintreegateway.com/sdk.js" });
      expect(await page.evaluate("window.sdkLoaded")).toBe(true);
      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.src = "https://emvtds.sps-system.com/frame";
        document.body.append(frame);
      });
      await page.locator("iframe").contentFrame().locator("main").waitFor();
      const frame = page.frames().find((candidate) => candidate.url().includes("emvtds"))!;
      expect(
        await frame.evaluate(
          async () => (await fetch("https://another-issuer.test/fingerprint")).ok,
        ),
      ).toBe(true);
      expect(delivered).toContain("https://another-issuer.test/fingerprint");
      const evidenceDirectory = process.env.EGRESS_EVIDENCE_DIR;
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(
          join(evidenceDirectory, "operator-egress.json"),
          JSON.stringify(
            {
              fixture: "Real Chromium operator session with intercepted synthetic HTTP responses",
              merchantUrl: page.url(),
              deliveredRequests: delivered,
              sdkExecuted: await page.evaluate("window.sdkLoaded"),
              providerFrameUrl: frame.url(),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      vi.restoreAllMocks();
      await context.close();
    }
  }, 30_000);
});
