// Regression: uploadFile's filechooser waiter (15s timeout) used to attach its
// .catch only AFTER `locator.click()` resolved. A click that actionability-
// waits past 15s (occluded upload button) left the waiter's rejection with no
// handler — an unhandledRejection that killed the whole MCP server process
// mid-session (reproduced live: "MCP server 'squire' is unreachable"). The fix
// attaches the handler at creation, so the slow-click path degrades to the
// clean "did not open a file picker" per-call error.

import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserController } from "../browser.js";

const thisFile = fileURLToPath(import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("uploadFile filechooser-timeout race", () => {
  const leaked: unknown[] = [];
  const track = (reason: unknown): void => {
    leaked.push(reason);
  };

  beforeEach(() => {
    leaked.length = 0;
    process.on("unhandledRejection", track);
  });

  afterEach(() => {
    process.removeListener("unhandledRejection", track);
  });

  it("a click outlasting the chooser timeout yields a clean error, not an escaped rejection", async () => {
    const controller = new BrowserController({ humanize: false });
    // The crash window: the chooser waiter rejects (t≈10ms, standing in for
    // the real 15s timeout) while the click is still pending (t≈60ms, standing
    // in for the 30s actionability wait on an occluded button).
    const fakeLocator = {
      evaluate: () => Promise.reject(new Error("target is not an <input>")),
      click: () => sleep(60),
    };
    const page = {
      locator: () => ({ first: () => fakeLocator }),
      waitForEvent: (event: string) =>
        sleep(10).then(() => {
          throw new Error(`Timeout 15000ms exceeded while waiting for event "${event}"`);
        }),
    };
    Object.defineProperty(controller, "page", { value: page });

    await expect(controller.uploadFile("#up", thisFile)).rejects.toThrow(
      /did not open a file picker/,
    );

    // Give a leaked rejection time to surface before asserting none did.
    await sleep(50);
    expect(leaked).toEqual([]);
  });
});
