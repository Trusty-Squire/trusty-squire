import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium as patchright } from "patchright";
import { chromium, type BrowserContext } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/three-ds-method/${name}.html`, import.meta.url), "utf8");
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// This is a synthetic method transport contract, not an SBPS/issuer integration
// qualification. No real card, challenge, approval or payment is involved.
describe("native 3DS2 method completion", () => {
  it.each(["playwright", "operator", "self-launch"] as const)(
    "%s preserves onload, cross-origin fingerprint POST/message, and native auto-submit",
    async (driver) => {
      const events: string[] = [];
      let parentOrigin = "";
      let completed = false;
      let authenticateBody = "";
      const token = "synthetic-server-method-completion";
      const methodServer = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (req.url === "/method" && req.method === "POST") {
          events.push(`method:${body}`);
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(fixture("method").replaceAll("__PARENT_ORIGIN__", parentOrigin));
        } else if (req.url === "/fingerprint-complete" && req.method === "POST") {
          const fingerprint = JSON.parse(body);
          completed =
            fingerprint.transaction === "synthetic-transaction" &&
            fingerprint.screenWidth > 0 &&
            typeof fingerprint.language === "string";
          events.push("fingerprint");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ token: completed ? token : "" }));
        } else {
          res.writeHead(404).end();
        }
      });
      const methodOrigin = (await listen(methodServer)).replace("127.0.0.1", "localhost");
      const parentServer = createServer(async (req, res) => {
        if (req.url === "/FepChargePaymentInfoLookupResult.do") {
          events.push("lookup");
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(fixture("lookup").replaceAll("__METHOD_ORIGIN__", methodOrigin));
        } else if (req.url === "/FepChargePaymentInfoAuthenticateInit.do") {
          for await (const chunk of req) authenticateBody += chunk;
          events.push("authenticate");
          const valid =
            completed &&
            req.method === "POST" &&
            new URLSearchParams(authenticateBody).get("methodCompletion") === token;
          res.writeHead(valid ? 200 : 400, { "content-type": "text/html" });
          res.end(
            valid ? "<h1>Ready for genuine cardholder authentication</h1>" : "Incomplete method",
          );
        } else res.writeHead(404).end();
      });
      parentOrigin = await listen(parentServer);
      const browser =
        driver === "self-launch"
          ? null
          : await (driver === "operator" ? patchright : chromium).launch({
              executablePath: chromium.executablePath(),
              headless: true,
              args: [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-dev-shm-usage",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
              ],
            });
      const launched =
        driver === "self-launch"
          ? new BrowserController({
              profileDir: mkdtempSync(join(homedir(), "method-profile-")),
              humanize: false,
            })
          : null;
      try {
        if (launched) {
          vi.stubEnv("BOT_CDP_ENDPOINT", "");
          vi.stubEnv("BOT_SELF_LAUNCH", "1");
          // Avoid an unrelated public IP service; do not mock browser execution.
          vi.spyOn(
            (launched as unknown as { processOwner: { probeEgressGeo(): Promise<null> } })
              .processOwner,
            "probeEgressGeo",
          ).mockResolvedValue(null);
          await launched.start();
          expect(launched.launchMode).toBe("headed");
          expect(launched.stealthProfile).toBe("cdp_hardened");
        }
        const context = browser
          ? ((await browser.newContext()) as unknown as BrowserContext)
          : (launched as unknown as { processOwner: { context: BrowserContext } }).processOwner
              .context;
        const page = browser ? await context.newPage() : context.pages()[0]!;
        const controller = launched ?? BrowserController.fromHarnessPage(page);
        if (driver === "operator") {
          // Exercise the real production page setup, including normalization.
          await (
            controller as unknown as {
              initializePages(
                context: BrowserContext,
                hardened: boolean,
                remote: boolean,
              ): Promise<void>;
            }
          ).initializePages(context, true, false);
        }
        await controller.setHostScopeAllowedHosts(() => ["127.0.0.1", "localhost"]);
        const response = page.waitForResponse(
          (r) => r.url().endsWith("/FepChargePaymentInfoAuthenticateInit.do"),
          { timeout: 10_000 },
        );
        await page.goto(`${parentOrigin}/FepChargePaymentInfoLookupResult.do`, {
          waitUntil: "commit",
        });
        // Native event handlers alone drive the method, never a forced submit.
        expect((await response).status()).toBe(200);
        expect(events).toEqual([
          "lookup",
          "method:threeDSMethodData=synthetic-transaction",
          "fingerprint",
          "authenticate",
        ]);
        expect(new URLSearchParams(authenticateBody).get("methodCompletion")).toBe(token);
        expect(controller.peekHostScopeDenials()).toEqual([]);
      } finally {
        if (launched) await launched.close();
        await browser?.close();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await close(parentServer);
        await close(methodServer);
      }
    },
    30_000,
  );
});
