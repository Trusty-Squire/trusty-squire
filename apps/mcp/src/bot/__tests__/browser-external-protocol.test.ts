import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { prepareBrowserProtocolPolicy } from "../browser-protocol-policy.js";
import { hostDisplayAcceptsConnections } from "../display-env.js";
import { resolveChannelBinary } from "../browser-process-runtime.js";
import {
  createXvfbDisplayRig,
  startRemoteLoginDisplay,
  remoteLoginEnvironment,
  teardownRemoteLoginRig,
} from "../remote-login-display.js";

// Headed Chrome matters: headless Chromium has no external-application modal.
// A plain self-launch also avoids Playwright's launch-time UI suppression.
it.skipIf(process.platform !== "linux")(
  "rep-tiktok-consent: an external-protocol iframe cannot swallow the next trusted click",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-external-protocol-"));
    const rig = (await hostDisplayAcceptsConnections()) ? undefined : createXvfbDisplayRig();
    try {
      if (rig) await startRemoteLoginDisplay(rig);
      const env = rig ? remoteLoginEnvironment(rig) : process.env;
      for (const protectedProfile of [false, true]) {
        const profile = join(root, String(protectedProfile));
        await mkdir(profile);
        if (protectedProfile) await prepareBrowserProtocolPolicy(profile);
        const chrome = spawn(
          process.env.UNIVERSAL_BOT_CHROME_BINARY ||
            resolveChannelBinary("chrome") ||
            chromium.executablePath(),
          [
            "--no-sandbox",
            "--no-first-run",
            "--no-default-browser-check",
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "about:blank",
          ],
          { stdio: "ignore", env },
        );
        let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
        try {
          let port = "";
          await expect
            .poll(
              async () => {
                try {
                  port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
                    "\n",
                  )[0]!;
                } catch {
                  return false;
                }
                return port.length > 0;
              },
              { timeout: 15000 },
            )
            .toBe(true);
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          const page = browser.contexts()[0]!.pages()[0]!;
          const dialogs: string[] = [];
          page.on("dialog", (dialog) => {
            dialogs.push(dialog.type());
            void dialog.dismiss();
          });
          await page.setContent(`<iframe></iframe>
          <button id="launch" onclick="document.querySelector('iframe').src='squire-protocol-fixture://probe/'">Launch</button>
          <button id="continue" onclick="document.body.dataset.trusted=String(event.isTrusted);this.textContent='Continued'">Continue</button>`);
          await page.locator("#launch").click({ noWaitAfter: true });
          // The shell-handler lookup is asynchronous. Wait for the modal (or
          // policy denial) before the click, otherwise a fast machine races it.
          await page.waitForTimeout(1000);
          await page.locator("#continue").click({ noWaitAfter: true, timeout: 3000 });
          expect(await page.locator("#continue").textContent()).toBe(
            protectedProfile ? "Continued" : "Continue",
          );
          expect(dialogs).toEqual([]);
          if (protectedProfile)
            expect(await page.locator("body").getAttribute("data-trusted")).toBe("true");
          if (protectedProfile) {
            await page.route("https://protocol-fixture.test/**", (route) =>
              route.fulfill({ contentType: "text/html", body: "Browser navigation still works" }),
            );
            await page.goto("https://protocol-fixture.test/next");
            expect(await page.textContent("body")).toBe("Browser navigation still works");
          }
        } finally {
          await browser?.close();
          if (chrome.exitCode === null && chrome.signalCode === null) {
            const exited = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
            chrome.kill("SIGINT");
            await exited;
          }
        }
      }
    } finally {
      if (rig) await teardownRemoteLoginRig(rig);
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);

it("preserves existing preferences and rejects corrupt preferences without overwriting them", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ts-protocol-prefs-"));
  const directory = join(profile, "Default");
  const path = join(directory, "Preferences");
  try {
    await mkdir(directory);
    await writeFile(
      path,
      JSON.stringify({
        other: { retained: true },
        policy: { url_blocklist: ["blocked.example"], url_allowlist: ["https://allowed.example"] },
      }),
    );
    await prepareBrowserProtocolPolicy(profile);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.other).toEqual({ retained: true });
    expect(saved.policy.url_blocklist).toContain("blocked.example");
    expect(saved.policy.url_allowlist).toContain("https://allowed.example");
    await writeFile(path, "broken json");
    await expect(prepareBrowserProtocolPolicy(profile)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken json");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
