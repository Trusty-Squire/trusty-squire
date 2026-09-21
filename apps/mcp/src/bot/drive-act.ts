// Drive-loop settle and page-change helpers. Click/type/select dispatch lives
// in the shared executor (`dispatchDriveAct` / `executeAct`).

import type { Frame, Page } from "playwright";
import { evaluateBound } from "./drive-evaluate.js";

export const DRIVE_SETTLE_MS = 50;
export const DRIVE_COMBOBOX_WAIT_MS = 400;
const OVERLAY_REFRESH_WAIT_MS = 2000;
export const DRIVE_NAVIGATION_WAIT_MS = 300;
export const DRIVE_IN_PAGE_SETTLE_MS = 800;

export type { DriveActResult } from "./act/act.js";

const OVERLAY_OPTION_SELECTOR =
  '[role="option"],[role="listbox"] a,[role="listbox"] [role="option"],.suggestions a,.suggestion-link,.suggestions-dropdown a,[aria-selected],[role="grid"] button,[role="grid"] [role="gridcell"],[role="gridcell"],[role="dialog"] [role="gridcell"],[role="dialog"] [role="grid"] button';

async function waitForOpenedOverlay(page: Page): Promise<void> {
  await evaluateBound(
    page,
    async (input) => {
      const start = performance.now();
      const visibleSuggestion = (node: Element): boolean => {
        if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
        if (typeof node.checkVisibility === "function") {
          return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      while (performance.now() - start < input.cap) {
        const options = Array.from(document.querySelectorAll(input.selector)).filter(
          visibleSuggestion,
        );
        if (options.length > 0) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    { selector: OVERLAY_OPTION_SELECTOR, cap: DRIVE_COMBOBOX_WAIT_MS },
  );
}

/** Visible suggestion rows right now, as the baseline for a refresh wait. */
export async function overlayOptionLabels(page: Page): Promise<string[]> {
  return evaluateBound(
    page,
    (selector: string) => {
      const visible = (node: Element): boolean => {
        if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
        if (typeof node.checkVisibility === "function") {
          return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      return Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    },
    OVERLAY_OPTION_SELECTOR,
  ).catch(() => [] as string[]);
}

// Autocomplete keeps the pre-type rows until the network refresh (~110ms on
// Flights). Returning at first option PRESENCE snapshots the stale set and the
// model reads the previous city's suggestions.
async function waitForOverlayOptionsToChange(page: Page, before: readonly string[]): Promise<void> {
  await evaluateBound(
    page,
    async (input) => {
      const visibleSuggestion = (node: Element): boolean => {
        if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
        if (typeof node.checkVisibility === "function") {
          return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const read = (): string[] =>
        Array.from(document.querySelectorAll(input.selector))
          .filter(visibleSuggestion)
          .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
      const same = (left: string[], right: string[]): boolean => {
        if (left.length !== right.length) return false;
        const a = left.slice().sort();
        const b = right.slice().sort();
        return a.every((value, index) => value === b[index]);
      };
      const start = performance.now();
      while (performance.now() - start < input.cap) {
        const labels = read();
        if (labels.length > 0 && !same(labels, input.before)) return;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    { selector: OVERLAY_OPTION_SELECTOR, before: [...before], cap: OVERLAY_REFRESH_WAIT_MS },
  ).catch(() => undefined);
}

export async function reenterDriveField(
  scope: Page | Frame,
  selector: string,
  text: string,
): Promise<boolean> {
  if (selector.length === 0) return false;
  const locator = scope.locator(selector);
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 5000 });
    await locator.fill(text);
    return (await locator.inputValue().catch(() => "")) === text;
  } catch {
    return false;
  }
}

export async function settleDriveStep(
  page: Page,
  combobox: boolean,
  overlayBefore?: readonly string[],
): Promise<number> {
  const started = Date.now();
  try {
    const frames = page
      .evaluate(async (wait) => {
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
      }, DRIVE_SETTLE_MS)
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      frames,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DRIVE_SETTLE_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (combobox) {
      await waitForOpenedOverlay(page);
      if (overlayBefore !== undefined) await waitForOverlayOptionsToChange(page, overlayBefore);
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

export async function pageFingerprintOf(page: Page): Promise<string> {
  try {
    return await evaluateBound(page, () => {
      const text = document.body?.innerText.slice(0, 6000) ?? "";
      const controls = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input,select,textarea",
        ),
      )
        .map((element) => `${element.tagName}:${element.type}:${element.value}`)
        .join("\n");
      return [text, controls].join("\n").trim();
    });
  } catch {
    return "";
  }
}

export function documentOriginOf(epoch: string): string {
  const bar = epoch.indexOf("|");
  return bar === -1 ? epoch : epoch.slice(0, bar);
}

/** After a same-URL click, wait until the document fingerprint changes. */
export async function waitForInPageChange(
  page: Page,
  beforeFingerprint: string,
  capMs: number = DRIVE_IN_PAGE_SETTLE_MS,
): Promise<boolean> {
  if (beforeFingerprint.length === 0) return false;
  try {
    return await evaluateBound(
      page,
      async ({ before, cap }) => {
        const fingerprint = (): string => {
          const text = document.body?.innerText.slice(0, 6000) ?? "";
          const controls = Array.from<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            document.querySelectorAll("input,select,textarea"),
          )
            .map((element) => `${element.tagName}:${element.type}:${element.value}`)
            .join("\n");
          return [text, controls].join("\n").trim();
        };
        if (fingerprint() !== before) return true;
        return await new Promise<boolean>((resolve) => {
          let frame = 0;
          let finished = false;
          const finish = (changed: boolean): void => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            cancelAnimationFrame(frame);
            observer.disconnect();
            resolve(changed);
          };
          const timer = setTimeout(() => finish(false), cap);
          const observer = new MutationObserver(() => {
            if (fingerprint() !== before) finish(true);
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          const poll = (): void => {
            if (fingerprint() !== before) {
              finish(true);
              return;
            }
            frame = requestAnimationFrame(poll);
          };
          frame = requestAnimationFrame(poll);
        });
      },
      { before: beforeFingerprint, cap: capMs },
    );
  } catch {
    return false;
  }
}

export async function waitForNavigationIdle(page: Page, beforeFingerprint: string): Promise<void> {
  await evaluateBound(
    page,
    async ({ before, cap }) => {
      const fingerprint = (): string => {
        const text = document.body?.innerText.slice(0, 6000) ?? "";
        const controls = Array.from<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          document.querySelectorAll("input,select,textarea"),
        )
          .map((element) => `${element.tagName}:${element.type}:${element.value}`)
          .join("\n");
        return [text, controls].join("\n").trim();
      };
      await new Promise<void>((resolve) => {
        let frame: number;
        const finish = (): void => {
          clearTimeout(timer);
          cancelAnimationFrame(frame);
          resolve();
        };
        const timer = setTimeout(finish, cap);
        const poll = (): void => {
          const current = fingerprint();
          if (current.length > 0 && current !== before) {
            finish();
          } else {
            frame = requestAnimationFrame(poll);
          }
        };
        frame = requestAnimationFrame(poll);
      });
    },
    { before: beforeFingerprint, cap: DRIVE_NAVIGATION_WAIT_MS },
  ).catch(() => undefined);
}
