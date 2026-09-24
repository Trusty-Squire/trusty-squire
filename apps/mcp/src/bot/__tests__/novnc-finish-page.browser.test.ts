import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { openInstallConfirmInBotChrome, type RunInBotChromeOpts } from "../google-login.js";
import { startNoVncFinishProxy } from "../novnc-finish-proxy.js";

describe("noVNC Finish page", () => {
  it("clicks Finish and ends the Squire browser ceremony", async () => {
    const html = readFileSync(new URL("../../../assets/login/vnc.html", import.meta.url), "utf8");
    const pageServer = createServer((incoming, outgoing) => {
      if (incoming.url === "/core/rfb.js") {
        outgoing.setHeader("Content-Type", "text/javascript");
        outgoing.end("export default class RFB { addEventListener() {} }");
      } else if (incoming.url === "/core/input/keysymdef.js") {
        outgoing.setHeader("Content-Type", "text/javascript");
        outgoing.end("export default {};");
      } else if (incoming.url === "/vnc-input.js") {
        outgoing.setHeader("Content-Type", "text/javascript");
        outgoing.end("export function sendTextAsKeysyms() {}");
      } else {
        outgoing.setHeader("Content-Type", "text/html");
        outgoing.end(html);
      }
    });
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.SQUIRE_TEST_CHROME_PATH
        ? { executablePath: process.env.SQUIRE_TEST_CHROME_PATH }
        : {}),
    });
    try {
      const pollUntilClaimed = vi.fn(async (completed: boolean) =>
        completed ? ({ status: "claimed", provider: "google" } as const) : ("pending" as const),
      );
      const runChrome = async (opts: RunInBotChromeOpts) => {
        const proxy = await startNoVncFinishProxy(
          0,
          (pageServer.address() as { port: number }).port,
          opts.onVncFinish!,
        );
        try {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${proxy.port}/#p=vnc-secret&f=${proxy.token}`);
          expect(await opts.pollUntilDone()).toBe(false);
          await page.getByRole("button", { name: "Finish" }).click();
          await vi.waitFor(async () => expect(await opts.pollUntilDone()).toBe(true));
          await page.getByRole("button", { name: "Finishing…" }).waitFor();
          return { status: "satisfied" as const, closeState: "closed" as const };
        } finally {
          await proxy.close();
        }
      };
      await expect(
        openInstallConfirmInBotChrome(
          {
            confirmUrl: "https://trustysquire.ai/install",
            pollUntilClaimed,
            profileDir: "/unused/profile",
            deadline: Date.now() + 60_000,
          },
          runChrome,
        ),
      ).resolves.toEqual({ status: "claimed" });
      const completionStates = pollUntilClaimed.mock.calls.map(([completed]) => completed);
      expect(completionStates[0]).toBe(false);
      expect(completionStates.at(-1)).toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    }
  });
});
