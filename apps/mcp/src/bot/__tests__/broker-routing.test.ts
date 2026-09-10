import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../browser.js";
let browser: Browser | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await browser?.close();
});

async function fixture() {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<main>service</main>" });
  });
  const root = BrowserController.fromHarnessPage(await context.newPage());
  await root.enableBrokerRouting();
  const a = await BrowserController.attachSessionPage(root, { humanize: false });
  const b = await BrowserController.attachSessionPage(root, { humanize: false });
  const aHosts = ["a.test"];
  const bHosts = ["b.test"];
  await a.setHostScopeAllowedHosts(() => aHosts);
  await b.setHostScopeAllowedHosts(() => bHosts);
  await Promise.all([a.goto("https://a.test"), b.goto("https://b.test")]);
  const page = (controller: BrowserController) => (controller as unknown as { page: Page }).page;
  return { context, root, a, b, aHosts, bHosts, page };
}

describe("broker context coordination", () => {
  it("routes each target's fetches through its own scope with the old flag disabled", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION", "0");
    try {
      const { a, b, page } = await fixture();
      expect(await page(a).evaluate("fetch('/api').then(r => r.ok)")).toBe(true);
      expect(await page(b).evaluate("fetch('/api').then(r => r.ok)")).toBe(true);
      expect(
        await page(a).evaluate(
          "fetch('https://b.test/api').then(() => 'escaped', () => 'blocked')",
        ),
      ).toBe("blocked");
      expect(a.takeHostScopeDenials()).toEqual([
        expect.objectContaining({
          hostname: "b.test",
          resource_type: "fetch",
          reason: "host_not_allowed",
          count: 1,
          owner: expect.objectContaining({ frame: "main", hostname: "a.test" }),
          remedy: {
            action: "restart_session",
            tool: "operate_start",
            allowed_host: "b.test",
          },
        }),
      ]);
      expect(b.takeHostScopeDenials()).toEqual([]);
      await a.closeOwnPagesOnly();
      expect(await page(b).evaluate("fetch('/api').then(r => r.ok)")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("attributes bounded denial metadata to one document and never widens sibling scope", async () => {
    const { root, a, b, aHosts, page } = await fixture();
    expect(
      await page(a).evaluate(
        "fetch('https://api.external.test/private/path?secret=never-report').then(() => 'escaped', () => 'blocked')",
      ),
    ).toBe("blocked");
    expect(
      await page(a).evaluate(
        "fetch('https://api.external.test/another?secret=also-never-report').then(() => 'escaped', () => 'blocked')",
      ),
    ).toBe("blocked");
    const [diagnostic] = a.takeHostScopeDenials();
    expect(diagnostic).toMatchObject({
      hostname: "api.external.test",
      resource_type: "fetch",
      reason: "host_not_allowed",
      count: 2,
      owner: { frame: "main", hostname: "a.test" },
      remedy: {
        action: "restart_session",
        tool: "operate_start",
        allowed_host: "api.external.test",
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private/path");
    expect(JSON.stringify(diagnostic)).not.toContain("never-report");
    expect(diagnostic!.first_seen_at).toBeLessThanOrEqual(diagnostic!.last_seen_at);

    aHosts.push("api.external.test");
    expect(
      await page(a).evaluate("fetch('https://api.external.test/region').then(r => r.ok)"),
    ).toBe(true);
    expect(
      await page(b).evaluate(
        "fetch('https://api.external.test/region').then(() => 'escaped', () => 'blocked')",
      ),
    ).toBe("blocked");
    const unowned = (root as unknown as { page: Page }).page;
    expect(
      await unowned.evaluate(
        "fetch('https://api.external.test/worker').then(() => 'escaped', () => 'blocked')",
      ),
    ).toBe("blocked");
    expect(a.takeHostScopeDenials()).toEqual([]);
    expect(b.takeHostScopeDenials()).toHaveLength(1);
    expect(root.takeHostScopeDenials()).toEqual([]);
  });

  it("separates subframe document generations before diagnostic delivery", async () => {
    const { a, aHosts, page } = await fixture();
    aHosts.push("frame-a.test", "frame-b.test");
    await page(a).evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "https://frame-a.test/";
      document.body.append(frame);
    });
    await page(a).locator("iframe").contentFrame().locator("main").waitFor();
    const frame = page(a)
      .frames()
      .find((item) => item.url().includes("frame-a.test"))!;
    await frame.evaluate(() =>
      fetch("https://denied.test/private?secret=one").catch(() => undefined),
    );
    await frame.goto("https://frame-b.test/");
    await frame.evaluate(() =>
      fetch("https://denied.test/private?secret=two").catch(() => undefined),
    );
    const rows = a.takeHostScopeDenials();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.owner.hostname)).toEqual(["frame-a.test", "frame-b.test"]);
    expect(rows[0]!.owner.document_id).not.toBe(rows[1]!.owner.document_id);
    expect(rows.map((row) => row.count)).toEqual([1, 1]);
    expect(JSON.stringify(rows)).not.toContain("secret=");
  });

  it("clears Cloudflare cookies only for the recovering site's exact cookie scope", async () => {
    const { context, a } = await fixture();
    await context.addCookies([
      { name: "cf_clearance", value: "a", domain: ".a.test", path: "/" },
      { name: "cf_clearance", value: "b", domain: ".b.test", path: "/" },
      { name: "__cf_bm", value: "b", domain: ".b.test", path: "/" },
    ]);
    const recovery = a as unknown as {
      pollUntilInterstitialClears(
        timeout: number,
      ): Promise<{ cleared: boolean; detected: boolean }>;
      clearCloudflareCookiesAndRetry(timeout: number): Promise<boolean>;
    };
    vi.spyOn(recovery, "pollUntilInterstitialClears").mockResolvedValue({
      cleared: true,
      detected: false,
    });
    expect(await recovery.clearCloudflareCookiesAndRetry(1)).toBe(true);
    expect(await context.cookies("https://a.test")).toEqual([]);
    expect((await context.cookies("https://b.test")).map((cookie) => cookie.name).sort()).toEqual([
      "__cf_bm",
      "cf_clearance",
    ]);
  });

  it("retains an unclosed family's handles for a later proven close", async () => {
    const { a, b, page } = await fixture();
    const original = page(a);
    const failure = vi.spyOn(original, "close").mockRejectedValueOnce(new Error("close failed"));
    expect(await a.closeOwnPagesOnly()).toBe("unknown");
    expect(page(a)).toBe(original);
    expect(original.isClosed()).toBe(false);
    failure.mockRestore();
    expect(await a.closeOwnPagesOnly()).toBe("closed");
    expect(page(b).isClosed()).toBe(false);
  });
});
