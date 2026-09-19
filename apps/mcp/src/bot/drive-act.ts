// Drive-loop act: one registry lookup + occlusion guard, then one CDP click
// or insertText (native select sets value in that same evaluate). No Playwright
// locator actionability polling and no resolveFreshActTarget re-extraction.

import type { Frame, Page } from "playwright";
import { evaluateBound } from "./drive-evaluate.js";
import type { ProvisionAction } from "./provision-session.js";

export const DRIVE_SETTLE_MS = 50;
export const DRIVE_COMBOBOX_WAIT_MS = 400;

export type DriveActTimings = {
  guardScriptMs: number;
  guardWallMs: number;
  cdpMs: number;
};

export type DriveActResult =
  | ({ kind: "ok"; combobox: boolean } & DriveActTimings)
  | ({ kind: "stale"; reason: string } & DriveActTimings)
  | { kind: "unsupported" };

const ZERO_ACT_TIMINGS: DriveActTimings = { guardScriptMs: 0, guardWallMs: 0, cdpMs: 0 };

interface GuardOk {
  ok: true;
  x: number;
  y: number;
  combobox: boolean;
  scriptMs: number;
}

interface GuardFail {
  ok: false;
  reason: string;
  scriptMs: number;
}

type GuardResult = GuardOk | GuardFail;

function frameOrdinalOf(ref: string): number {
  const match = /^@e:f(\d+)d\d+$/.exec(ref);
  return match === null ? 0 : Number(match[1]);
}

export function resolveDriveFrame(page: Page, ref: string): Frame {
  const ordinal = frameOrdinalOf(ref);
  const frames = page.frames();
  return frames[ordinal] ?? page.mainFrame();
}

function inPageGuard(input: { ref: string; kind: "click" | "type" | "select"; text?: string }): GuardResult {
  const scriptStarted = performance.now();
  const timed = <T extends Omit<GuardResult, "scriptMs">>(result: T): T & { scriptMs: number } => ({
    ...result,
    scriptMs: performance.now() - scriptStarted,
  });
  type DriveCache = { nodes: Map<string, Element> };
  const root = window as Window & { __tsDriveRegistry?: DriveCache };
  const element = root.__tsDriveRegistry?.nodes.get(input.ref);
  if (element === undefined || !element.isConnected) {
    return timed({ ok: false, reason: "detached" });
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return timed({ ok: false, reason: "no_box" });
  }
  let x = rect.x + rect.width / 2;
  let y = rect.y + rect.height / 2;
  let view: Window | null = element.ownerDocument.defaultView;
  let frameEl = view?.frameElement ?? null;
  while (frameEl instanceof Element) {
    const frameRect = frameEl.getBoundingClientRect();
    x += frameRect.x;
    y += frameRect.y;
    view = frameEl.ownerDocument.defaultView;
    frameEl = view?.frameElement ?? null;
  }
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (hit === null || (hit !== element && !element.contains(hit) && !hit.contains(element))) {
    return timed({ ok: false, reason: "occluded" });
  }
  const combobox =
    element.getAttribute("role") === "combobox" ||
    element.getAttribute("role") === "searchbox" ||
    (element instanceof HTMLInputElement &&
      (element.type === "search" || element.getAttribute("aria-autocomplete") !== null));
  if (input.kind === "select") {
    if (!(element instanceof HTMLSelectElement)) {
      return timed({ ok: false, reason: "not_select" });
    }
    const wanted = input.text ?? "";
    const match = Array.from(element.options).find(
      (option) =>
        option.value === wanted ||
        option.label === wanted ||
        (option.textContent ?? "").trim() === wanted ||
        (option.textContent ?? "").trim().toLowerCase().includes(wanted.toLowerCase()),
    );
    if (match === undefined) return timed({ ok: false, reason: "option_missing" });
    element.value = match.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return timed({ ok: true, x, y, combobox: false });
  }
  if (input.kind === "type" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    element.focus();
    element.select();
  } else if (input.kind === "type" && element instanceof HTMLElement) {
    element.focus();
    const selection = element.ownerDocument.getSelection();
    if (selection !== null) {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return timed({ ok: true, x, y, combobox });
}

export async function driveActOnPage(
  page: Page,
  action: ProvisionAction,
): Promise<DriveActResult> {
  if (action.kind === "scroll") {
    const direction = action.direction ?? "down";
    const wallStarted = Date.now();
    try {
      await evaluateBound(page, (dir) => {
        const height = innerHeight;
        if (dir === "down") scrollBy(0, Math.min(560, height));
        else if (dir === "up") scrollBy(0, -Math.min(560, height));
        else if (dir === "bottom") scrollTo(0, document.documentElement.scrollHeight);
        else scrollTo(0, 0);
      }, direction);
    } catch {
      return { kind: "stale", reason: "evaluate_timeout", ...ZERO_ACT_TIMINGS, guardWallMs: Date.now() - wallStarted };
    }
    return { kind: "ok", combobox: false, ...ZERO_ACT_TIMINGS, guardWallMs: Date.now() - wallStarted };
  }
  if (action.kind !== "click" && action.kind !== "type" && action.kind !== "select") {
    return { kind: "unsupported" };
  }
  const frame = resolveDriveFrame(page, action.target);
  const guardStarted = Date.now();
  let guard: GuardResult;
  try {
    guard = await evaluateBound(frame, inPageGuard, {
      ref: action.target,
      kind: action.kind,
      ...(action.kind === "select" || action.kind === "type" ? { text: action.text } : {}),
    });
  } catch {
    return { kind: "stale", reason: "evaluate_timeout", ...ZERO_ACT_TIMINGS, guardWallMs: Date.now() - guardStarted };
  }
  const timings: DriveActTimings = {
    guardScriptMs: guard.scriptMs,
    guardWallMs: Date.now() - guardStarted,
    cdpMs: 0,
  };
  if (!guard.ok) return { kind: "stale", reason: guard.reason, ...timings };
  if (action.kind === "select") return { kind: "ok", combobox: false, ...timings };
  const context = page.context();
  const cdpStarted = Date.now();
  const cdp = await context.newCDPSession(page);
  try {
    if (action.kind === "click") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: guard.x,
        y: guard.y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: guard.x,
        y: guard.y,
        button: "left",
        clickCount: 1,
      });
      return { kind: "ok", combobox: guard.combobox, ...timings, cdpMs: Date.now() - cdpStarted };
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: guard.x,
      y: guard.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: guard.x,
      y: guard.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.insertText", { text: action.text });
    return { kind: "ok", combobox: guard.combobox, ...timings, cdpMs: Date.now() - cdpStarted };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function settleDriveStep(
  page: Page,
  combobox: boolean,
): Promise<number> {
  const started = Date.now();
  try {
    await evaluateBound(
      page,
      async (wait) => {
        await Promise.race([
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, wait);
          }),
        ]);
      },
      DRIVE_SETTLE_MS,
    );
    if (combobox) {
      await evaluateBound(
        page,
        async (cap) => {
          const start = performance.now();
          const visibleSuggestion = (element: Element): boolean => {
            if (element.closest('[aria-hidden="true"],[inert]') !== null) return false;
            if (typeof element.checkVisibility === "function") {
              return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            }
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          };
          while (performance.now() - start < cap) {
            const options = Array.from(
              document.querySelectorAll(
                '[role="option"],[role="listbox"] a,.suggestions a,.suggestion-link,.suggestions-dropdown a,[aria-selected]',
              ),
            ).filter(visibleSuggestion);
            if (options.length > 0) return;
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
        },
        DRIVE_COMBOBOX_WAIT_MS,
      );
    }
  } catch {
    return Date.now() - started;
  }
  return Date.now() - started;
}

export async function documentEpochOf(page: Page): Promise<string> {
  try {
    return await evaluateBound(page, () => `${performance.timeOrigin}|${location.href}`);
  } catch {
    return "";
  }
}

export function documentOriginOf(epoch: string): string {
  const bar = epoch.indexOf("|");
  return bar === -1 ? epoch : epoch.slice(0, bar);
}

export async function waitForNavigationIdle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
}
