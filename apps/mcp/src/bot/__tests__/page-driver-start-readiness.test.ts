import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { PageDriver } from "../page-driver.js";

describe("PageDriver startup readiness", () => {
  it.each(["interactive", "complete"])(
    "accepts %s readiness without the humanized dwell",
    async (state) => {
      const goto = vi.fn(async () => undefined);
      const evaluate = vi
        .fn()
        .mockResolvedValueOnce("loading")
        .mockResolvedValueOnce(state)
        .mockResolvedValue("complete");
      const waitForTimeout = vi.fn(async () => undefined);
      const url = vi.fn(() => "https://fixture.test/");
      const timer = vi.spyOn(globalThis, "setTimeout");
      const page = { goto, evaluate, waitForTimeout, url } as unknown as Page;
      const driver = new PageDriver(() => null, true);
      try {
        await driver.goto("https://fixture.test/", page, "document-ready");

        expect(goto).toHaveBeenCalledWith("https://fixture.test/", {
          waitUntil: "commit",
          timeout: 60_000,
        });
        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(waitForTimeout).toHaveBeenCalledOnce();
        expect(waitForTimeout).toHaveBeenCalledWith(20);
        expect(timer).not.toHaveBeenCalled();
      } finally {
        timer.mockRestore();
      }
    },
  );
});
