// Drive-loop act: one registry lookup + occlusion guard, then one CDP click
// or insertText (native select sets value in that same evaluate). No Playwright
// locator actionability polling and no resolveFreshActTarget re-extraction.

import type { Frame, Page } from "playwright";
import type { ProvisionAction } from "./provision-session.js";

export const DRIVE_SETTLE_MS = 50;
export const DRIVE_COMBOBOX_WAIT_MS = 200;

export type DriveActResult =
  | { kind: "ok"; combobox: boolean }
  | { kind: "stale"; reason: string }
  | { kind: "unsupported" };

interface GuardOk {
  ok: true;
  x: number;
  y: number;
  combobox: boolean;
}

interface GuardFail {
  ok: false;
  reason: string;
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
  type DriveCache = { nodes: Map<string, Element> };
  const root = window as Window & { __tsDriveRegistry?: DriveCache };
  const element = root.__tsDriveRegistry?.nodes.get(input.ref);
  if (element === undefined || !element.isConnected) {
    return { ok: false, reason: "detached" };
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { ok: false, reason: "no_box" };
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
    return { ok: false, reason: "occluded" };
  }
  const combobox =
    element.getAttribute("role") === "combobox" ||
    (element instanceof HTMLInputElement && element.getAttribute("aria-autocomplete") !== null);
  if (input.kind === "select") {
    if (!(element instanceof HTMLSelectElement)) {
      return { ok: false, reason: "not_select" };
    }
    const wanted = input.text ?? "";
    const match = Array.from(element.options).find(
      (option) =>
        option.value === wanted ||
        option.label === wanted ||
        (option.textContent ?? "").trim() === wanted ||
        (option.textContent ?? "").trim().toLowerCase().includes(wanted.toLowerCase()),
    );
    if (match === undefined) return { ok: false, reason: "option_missing" };
    element.value = match.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, x, y, combobox: false };
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
  return { ok: true, x, y, combobox };
}

export async function driveActOnPage(
  page: Page,
  action: ProvisionAction,
): Promise<DriveActResult> {
  if (action.kind === "scroll") {
    const direction = action.direction ?? "down";
    await page.evaluate((dir) => {
      const height = innerHeight;
      if (dir === "down") scrollBy(0, Math.min(560, height));
      else if (dir === "up") scrollBy(0, -Math.min(560, height));
      else if (dir === "bottom") scrollTo(0, document.documentElement.scrollHeight);
      else scrollTo(0, 0);
    }, direction);
    return { kind: "ok", combobox: false };
  }
  if (action.kind !== "click" && action.kind !== "type" && action.kind !== "select") {
    return { kind: "unsupported" };
  }
  const frame = resolveDriveFrame(page, action.target);
  const guard = await frame.evaluate(inPageGuard, {
    ref: action.target,
    kind: action.kind,
    ...(action.kind === "select" || action.kind === "type" ? { text: action.text } : {}),
  });
  if (!guard.ok) return { kind: "stale", reason: guard.reason };
  if (action.kind === "select") return { kind: "ok", combobox: false };
  const context = page.context();
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
      return { kind: "ok", combobox: guard.combobox };
    }
    await cdp.send("Input.insertText", { text: action.text });
    return { kind: "ok", combobox: guard.combobox };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export async function settleDriveStep(
  page: Page,
  combobox: boolean,
): Promise<number> {
  const started = Date.now();
  await page.evaluate(
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
    await page.evaluate(async (cap) => {
      const start = performance.now();
      while (performance.now() - start < cap) {
        const options = Array.from(document.querySelectorAll('[role="option"]')).filter((element) => {
          if (element.closest('[aria-hidden="true"],[inert]') !== null) return false;
          if (typeof element.checkVisibility === "function") {
            return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
          }
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        if (options.length > 0) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, DRIVE_COMBOBOX_WAIT_MS);
  }
  return Date.now() - started;
}

export async function documentEpochOf(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => `${performance.timeOrigin}|${location.href}`);
  } catch {
    return "";
  }
}

export async function waitForNavigationIdle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
}
