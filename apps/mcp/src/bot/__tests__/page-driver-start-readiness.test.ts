import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { PageDriver } from "../page-driver.js";

describe("PageDriver startup readiness", () => {
  it("waits for DOMContentLoaded without the humanized dwell", async () => {
    const goto = vi.fn(async () => undefined);
    const url = vi.fn(() => "https://fixture.test/");
    const timer = vi.spyOn(globalThis, "setTimeout");
    const page = { goto, url } as unknown as Page;
    const driver = new PageDriver(() => null, true);
    try {
      await driver.goto("https://fixture.test/", page, "document-ready");

      expect(goto).toHaveBeenCalledWith("https://fixture.test/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
});
