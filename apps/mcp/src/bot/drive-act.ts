// Drive-loop settle and page-change helpers. Click/type/select dispatch lives
// in the shared executor (`dispatchDriveAct` / `executeAct`).

import type { Frame, Page } from "playwright";
import { evaluateBound } from "./drive-evaluate.js";

export const DRIVE_SETTLE_MS = 50;
export const DRIVE_COMBOBOX_WAIT_MS = 400;
const OVERLAY_REFRESH_WAIT_MS = 2000;
export const DRIVE_NAVIGATION_WAIT_MS = 300;
export const DRIVE_IN_PAGE_SETTLE_MS = 800;

const OVERLAY_OPTION_SELECTOR =
  '[role="option"],[role="listbox"] a,[role="listbox"] [role="option"],.suggestions a,.suggestion-link,.suggestions-dropdown a,[aria-selected],[role="grid"] button,[role="grid"] [role="gridcell"],[role="gridcell"],[role="dialog"] [role="gridcell"],[role="dialog"] [role="grid"] button';

export async function waitForOpenedOverlay(page: Page): Promise<void> {
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
export async function waitForOverlayOptionsToChange(page: Page, before: readonly string[]): Promise<void> {
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

const LIST_FILTER_SELECTOR =
  '[role="combobox"][aria-expanded="true"],[role="listbox"] input,input[aria-autocomplete="list"],input[aria-autocomplete="both"]';

export function listOptionIdentity(
  role: string | null,
  inListbox: boolean,
  inMenu: boolean,
  text: string,
): { text: string; role: "option" | "menuitem" } | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  if (role === "option" || (inListbox && role !== "combobox" && role !== "listbox")) {
    return { text: trimmed.slice(0, 80), role: "option" };
  }
  if (role === "menuitem" || inMenu) return { text: trimmed.slice(0, 80), role: "menuitem" };
  return null;
}

async function listOwnerSignature(scope: Page | Frame): Promise<string> {
  return scope
    .evaluate(() => {
      const owners = Array.from(
        document.querySelectorAll(
          '[role="combobox"],[aria-haspopup="listbox"],[aria-expanded="true"]',
        ),
      );
      return owners
        .map((element) => {
          const value =
            element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : (element.textContent ?? "").replace(/\s+/g, " ").trim();
          return `${value}\t${element.getAttribute("placeholder") ?? ""}`;
        })
        .join("\n");
    })
    .catch(() => "");
}

async function typeIntoOpenFilter(page: Page, text: string): Promise<boolean> {
  const filter = page.locator(LIST_FILTER_SELECTOR).first();
  if ((await filter.count().catch(() => 0)) === 0) return false;
  try {
    await filter.click({ timeout: 2000 });
    await filter.fill("");
    await filter.pressSequentially(text, { delay: 20 });
    return true;
  } catch {
    return false;
  }
}

/** Commit a listbox/combobox option via a fresh locator, not cached coordinates.
 *
 * Coordinate clicks miss widgets that re-render the list before the pointer
 * lands. Some options are not real until the filter input receives an input
 * event; some listen for Enter on the highlighted item instead of click.
 * Returns false when the target is not an option row, leaving the ordinary
 * click dispatch to run.
 */
export async function commitDriveListOption(
  page: Page,
  scope: Page | Frame,
  selector: string,
): Promise<boolean> {
  if (selector.length === 0) return false;
  const info = await scope
    .evaluate((sel: string) => {
      const element = document.querySelector(sel);
      if (element === null || !element.isConnected) return null;
      const option = element.closest('[role="option"],[role="menuitem"]');
      const item = option ?? element;
      return {
        role: item.getAttribute("role"),
        inListbox: item.closest('[role="listbox"]') !== null,
        inMenu: item.closest('[role="menu"]') !== null,
        text: (item.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    }, selector)
    .catch(() => null);
  if (info === null) return false;
  const identity = listOptionIdentity(info.role, info.inListbox, info.inMenu, info.text);
  if (identity === null) return false;
  const before = await listOwnerSignature(scope);
  if (
    (await page
      .getByRole(identity.role, { name: identity.text, exact: true })
      .first()
      .count()
      .catch(() => 0)) === 0
  ) {
    await typeIntoOpenFilter(page, identity.text);
  }
  const target = page.getByRole(identity.role, { name: identity.text, exact: true }).first();
  if ((await target.count().catch(() => 0)) === 0) return false;
  try {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ timeout: 5000 });
    if ((await listOwnerSignature(scope)) !== before) return true;
    await page.keyboard.press("Enter");
    if ((await listOwnerSignature(scope)) !== before) return true;
    if (await typeIntoOpenFilter(page, identity.text)) {
      await page.keyboard.press("Enter");
    }
    return true;
  } catch {
    return false;
  }
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

export async function settleDriveStep(page: Page, combobox: boolean): Promise<number> {
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
    if (combobox) await waitForOpenedOverlay(page);
  } catch {
    return Date.now() - started;
  }
  return Date.now() - started;
}

/** The controls' own state — what a decision was made about, without the page
 *  text that ticks on its own (countdown, relative timestamp, live price). */
export async function driveControlDigest(page: Page): Promise<string> {
  try {
    return await evaluateBound(page, () => {
      return Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          "input,select,textarea",
        ),
      )
        .filter((element) => !(element instanceof HTMLInputElement && element.type === "hidden"))
        .map(
          (element) =>
            `${element.tagName}:${element.type}:${element.value}:${
              element instanceof HTMLInputElement ? element.checked : ""
            }:${element.disabled}`,
        )
        .join("\n");
    });
  } catch {
    return "";
  }
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
