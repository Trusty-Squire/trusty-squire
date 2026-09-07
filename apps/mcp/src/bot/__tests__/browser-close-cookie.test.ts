import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProcessOwner } from "../browser-process-owner.js";
import { PageDriver } from "../page-driver.js";

afterEach(() => vi.unstubAllEnvs());

// Real owner launch/close, real Chrome, fresh isolated profile, localhost only.
// Never seed storageState: the next launch must authenticate from Chrome's disk.
describe("operator close preserves fresh login cookies", () => {
  it.each(["1", "0"])(
    "survives immediate close and reopen (BOT_SELF_LAUNCH=%s)",
    async (selfLaunch) => {
      vi.stubEnv("BOT_SELF_LAUNCH", selfLaunch);
      vi.stubEnv("BOT_CDP_ENDPOINT", "");
      const profileDir = mkdtempSync(join(tmpdir(), "ts-owner-cookie-"));
      const server = createServer((req, res) => {
        if (req.url === "/login") {
          res.setHeader("Set-Cookie", "ts_login=fresh-session; HttpOnly; Max-Age=86400; Path=/");
          res.end("signed in");
        } else {
          res.end(
            req.headers.cookie?.includes("ts_login=fresh-session") ? "authenticated" : "signed out",
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const owners: BrowserProcessOwner[] = [];
      const launch = async () => {
        const pages: PageDriver = new PageDriver(() => owner.context, false);
        const owner: BrowserProcessOwner = new BrowserProcessOwner(
          { profileDir },
          pages,
          async (context) => {
            pages.page = await context.newPage();
            pages.primaryPage = pages.page;
            pages.trackOpenedTabs(pages.page);
          },
        );
        // The geo service is irrelevant to cookie persistence; avoid external IO.
        vi.spyOn(
          owner as unknown as { probeEgressGeo(): Promise<null> },
          "probeEgressGeo",
        ).mockResolvedValue(null);
        owners.push(owner);
        await owner.start();
        return { owner, page: pages.page! };
      };
      try {
        const first = await launch();
        await first.page.goto(`${origin}/login`);
        expect(await first.owner.context!.cookies(origin)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "ts_login", value: "fresh-session" }),
          ]),
        );
        // Close now, well before Chrome's ~30s cookie-store commit timer.
        await expect(first.owner.close()).resolves.toBe("closed");
        const second = await launch();
        await second.page.goto(`${origin}/account`);
        expect(await second.page.textContent("body")).toBe("authenticated");
      } finally {
        for (const owner of owners) await owner.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(profileDir, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    },
    60_000,
  );
});
