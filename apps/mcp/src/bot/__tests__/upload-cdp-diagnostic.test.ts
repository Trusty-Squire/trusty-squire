import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "patchright";
import type { Browser } from "playwright";
import { it, expect, vi } from "vitest";
import { BrowserController } from "../browser.js";
import {
  detectChromiumChannel,
  resolveChannelBinary,
  waitForOwnedDevtoolsEndpoint,
} from "../browser-process-runtime.js";
import { hostDisplayAcceptsConnections } from "../display-env.js";
import {
  createXvfbDisplayRig,
  startRemoteLoginDisplay,
  remoteLoginEnvironment,
  teardownRemoteLoginRig,
  type RemoteLoginRig,
} from "../remote-login-display.js";
import {
  captureScreenshot,
  startHarnessProvisionSession,
  finishProvisionSession,
} from "../provision-session.js";
import { operateUploadTool } from "../../tools/provision-drive.js";

// Reproduction dreamina-live-upload-2: delay the actual driver subscription,
// while leaving Chrome's native pointer dispatch and chooser events untouched.
// This qualifies the interception race, not a successful upload on Dreamina.
it("awaits chooser interception before a headed native screenshot upload", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".chooser-cdp-"));
  let rig: RemoteLoginRig | undefined;
  let browser: Browser | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const markup = `<div id="card" style="position:absolute;left:20px;top:30px;width:200px;height:100px">Add first frame</div><output></output><script>
    document.body.dataset.clicks='0';
    document.addEventListener('click', e => {
      if (!e.target.closest('#card')) return;
      document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1);
      const input=document.createElement('input'); input.type='file';
      input.onchange=()=>document.querySelector('output').textContent=input.files[0].name+':'+input.files[0].size;
      input.click();
    });</script>`;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      req.url === "/parent"
        ? `<iframe style="position:absolute;left:100px;top:120px;width:400px;height:300px;border:0" src="http://child.test:${port}/child"></iframe>`
        : markup,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await writeFile(
      join(dir, "first-frame.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfEYEY0pSH8OITBAtxmnf11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBEIYhD+7aWsEAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    if (!(await hostDisplayAcceptsConnections())) {
      rig = createXvfbDisplayRig({ width: 1280, height: 960 });
      await startRemoteLoginDisplay(rig);
    }
    child = spawn(
      resolveChannelBinary(await detectChromiumChannel()) ?? chromium.executablePath(),
      [
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-proxy-server",
        "--site-per-process",
        `--host-resolver-rules=MAP parent.test 127.0.0.1,MAP child.test 127.0.0.1`,
        `--user-data-dir=${dir}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { env: rig ? remoteLoginEnvironment(rig) : process.env, stdio: "ignore" },
    );
    const endpoint = await waitForOwnedDevtoolsEndpoint(dir, 10000, child);
    browser = (await chromium.connectOverCDP(endpoint)) as unknown as Browser;
    const failures: unknown[] = [];
    for (const framed of [false, true]) {
      const page = await browser.contexts()[0]!.newPage();
      let session: string | undefined;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      try {
        const start = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: `http://parent.test:${port}/${framed ? "parent" : "main"}`,
          format: "compact",
        });
        session = start.session_id;
        const shot = await captureScreenshot(
          session,
          framed ? { frameUrlContains: "child.test" } : {},
        );
        const frame = framed
          ? page.frames().find((f) => f.url().includes("child.test"))!
          : page.mainFrame();
        if (framed) {
          const renderer = await page.context().newCDPSession(frame);
          try {
            const tree = await renderer.send("Page.getFrameTree");
            expect(tree.frameTree.frame.url).toContain("child.test");
          } finally {
            await renderer.detach();
          }
        }
        const owner = page as unknown as {
          _updateSubscription(event: string, enabled: boolean): void;
        };
        const original = owner._updateSubscription.bind(owner);
        vi.spyOn(owner, "_updateSubscription").mockImplementation((event, enabled) => {
          if (event === "filechooser" && enabled) {
            setTimeout(() => original(event, enabled), 750);
          } else original(event, enabled);
        });
        const request = {
          session_id: session,
          path: join(dir, "first-frame.png"),
          screenshot: { screenshot_id: shot.click_binding!.screenshot_id, x: 60, y: 70 },
        };
        const mouse = vi.spyOn(page.mouse, "click");
        const result = await operateUploadTool.handler(request, null);
        console.warn("CDP DIAGNOSTIC", framed, JSON.stringify(result));
        expect(await operateUploadTool.handler(request, null)).toMatchObject({
          status: "stale_screenshot",
          screenshot_click: { dispatch: "not_dispatched" },
        });
        expect(mouse).toHaveBeenCalledOnce();
        expect(await frame.locator("body").getAttribute("data-clicks")).toBe("1");
        if (result && typeof result === "object" && "upload_failure" in result) {
          failures.push({ framed, result });
          expect(result).toMatchObject({
            upload_failure: { phase: "chooser_wait", cause: "chooser_timeout" },
            screenshot_click: { dispatch: "dispatched", retry_policy: "observe_before_new_action" },
          });
          expect(await frame.locator("output").textContent()).toBe("");
          continue;
        }
        expect(result).toMatchObject({ screenshot_click: { dispatch: "dispatched" } });
        expect(await frame.locator("output").textContent()).toBe("first-frame.png:179");
      } finally {
        await cdp.detach();
        if (session) await finishProvisionSession(session);
        await page.close();
      }
    }
    expect(failures).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await browser?.close();
    if (child && child.exitCode === null) {
      child.kill("SIGINT");
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => child!.kill("SIGKILL"), 2000);
        child!.once("exit", () => {
          clearTimeout(deadline);
          resolve();
        });
      });
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (rig) await teardownRemoteLoginRig(rig);
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
