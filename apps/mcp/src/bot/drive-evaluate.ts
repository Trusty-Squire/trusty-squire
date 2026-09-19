// Bound in-page evaluate for the drive loop. Expiry aborts the registered
// request AbortController and terminates the in-page call so that one
// request returns an honest error while other sessions keep serving.

import type { Frame, Page } from "playwright";
import {
  abortCurrentOperatorRequest,
  currentOperatorRequestSignal,
} from "./request-cancellation.js";

export const DRIVE_EVALUATE_BUDGET_MS = 4000;

export class DriveEvaluateTimeout extends Error {
  readonly code = "evaluate_timeout";
  readonly wallMs: number;
  constructor(wallMs: number) {
    super(`in-page evaluate exceeded ${wallMs}ms`);
    this.name = "DriveEvaluateTimeout";
    this.wallMs = wallMs;
  }
}

function ownerPage(target: Page | Frame): Page {
  return "mainFrame" in target ? (target as Page) : (target as Frame).page();
}

export async function abortInPageEvaluate(target: Page | Frame): Promise<void> {
  const page = ownerPage(target);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Page.stopLoading").catch(() => undefined);
    await cdp.send("Runtime.terminateExecution").catch(() => undefined);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function evaluateBound<R>(
  target: Page | Frame,
  pageFunction: () => R | Promise<R>,
  arg?: undefined,
  budgetMs?: number,
): Promise<R>;
export async function evaluateBound<R, A>(
  target: Page | Frame,
  pageFunction: (arg: A) => R | Promise<R>,
  arg: A,
  budgetMs?: number,
): Promise<R>;
export async function evaluateBound<R, A>(
  target: Page | Frame,
  pageFunction: ((arg: A) => R | Promise<R>) | (() => R | Promise<R>),
  arg?: A,
  budgetMs: number = DRIVE_EVALUATE_BUDGET_MS,
): Promise<R> {
  const budget = budgetMs;
  const signal = currentOperatorRequestSignal();
  if (signal?.aborted) throw signal.reason ?? new DriveEvaluateTimeout(budget);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Playwright's evaluate overloads cannot be named without a cast; the
  // wrappers above are the typed surface.
  const work: Promise<R> =
    arg === undefined
      ? target.evaluate(pageFunction as () => R | Promise<R>)
      : (target.evaluate(pageFunction as Parameters<Page["evaluate"]>[0], arg) as Promise<R>);
  const timedOut = new DriveEvaluateTimeout(budget);
  try {
    return await Promise.race([
      work,
      new Promise<R>((_, reject) => {
        timer = setTimeout(() => reject(timedOut), budget);
        signal?.addEventListener("abort", () => reject(signal.reason ?? timedOut), { once: true });
      }),
    ]);
  } catch (error) {
    if (error instanceof DriveEvaluateTimeout) {
      await abortInPageEvaluate(target).catch(() => undefined);
      abortCurrentOperatorRequest(error);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
