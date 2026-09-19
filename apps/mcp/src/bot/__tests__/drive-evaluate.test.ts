import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  DRIVE_EVALUATE_BUDGET_MS,
  DriveEvaluateTimeout,
  evaluateBound,
} from "../drive-evaluate.js";
import {
  attachOperatorRequestAbort,
  withOperatorRequestContext,
} from "../request-cancellation.js";

function hungPage(evaluate: Page["evaluate"], send = vi.fn(async () => undefined)): Page {
  return {
    evaluate,
    mainFrame: () => ({}),
    context: () => ({
      newCDPSession: async () => ({
        send,
        detach: async () => undefined,
      }),
    }),
  } as unknown as Page;
}

describe("evaluateBound", () => {
  it("exports a budget shorter than the Playwright default that wedged the broker", () => {
    expect(DRIVE_EVALUATE_BUDGET_MS).toBeLessThan(30_000);
    expect(DRIVE_EVALUATE_BUDGET_MS).toBeGreaterThan(0);
  });

  it("aborts a hung evaluate and leaves a later evaluate able to run", async () => {
    const send = vi.fn(async () => undefined);
    let calls = 0;
    const page = hungPage(async () => {
      calls += 1;
      if (calls === 1) return await new Promise(() => undefined);
      return 7;
    }, send);

    const controller = new AbortController();
    attachOperatorRequestAbort(controller.signal, (reason) => controller.abort(reason));
    await withOperatorRequestContext(controller.signal, async () => {
      await expect(evaluateBound(page, () => 1, undefined, 25)).rejects.toBeInstanceOf(
        DriveEvaluateTimeout,
      );
    });
    expect(send).toHaveBeenCalledWith("Page.stopLoading");
    expect(send).toHaveBeenCalledWith("Runtime.terminateExecution");
    expect(controller.signal.aborted).toBe(true);

    const later = hungPage(async () => 7);
    await expect(evaluateBound(later, () => 7)).resolves.toBe(7);
  });
});
