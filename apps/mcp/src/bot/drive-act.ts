// Drive-loop act: one registry lookup + occlusion guard, then one CDP click
// or insertText (native select sets value in that same evaluate). No Playwright
// locator actionability polling and no resolveFreshActTarget re-extraction.

import type { Frame, Page } from "playwright";
import { evaluateBound } from "./drive-evaluate.js";
import type { ProvisionAction } from "./provision-session.js";

export const DRIVE_SETTLE_MS = 50;
export const DRIVE_COMBOBOX_WAIT_MS = 400;
export const DRIVE_OVERLAY_REFRESH_WAIT_MS = 2000;
export const DRIVE_NAVIGATION_WAIT_MS = 300;

export type DriveActTimings = {
  guardScriptMs: number;
  guardWallMs: number;
  cdpMs: number;
};

export type DriveActResult =
  | ({ kind: "ok"; combobox: boolean; searchSubmit: boolean } & DriveActTimings)
  | ({ kind: "stale"; reason: string } & DriveActTimings)
  | { kind: "unsupported" };

const ZERO_ACT_TIMINGS: DriveActTimings = { guardScriptMs: 0, guardWallMs: 0, cdpMs: 0 };

interface GuardOk {
  ok: true;
  x: number;
  y: number;
  /** The frameElement walk reached window.top (no cross-origin boundary). */
  reachedTop: boolean;
  combobox: boolean;
  searchSubmit: boolean;
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

function inPageGuard(input: {
  ref: string;
  kind: "click" | "type" | "select";
  text?: string;
}): GuardResult {
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
  // The snapshot keeps offscreen fillables so the model can name them. The
  // CDP click/type path then uses viewport coordinates, so an offscreen
  // target used to fail the occlusion check and burn the attempt. Scroll
  // first — the same thing a person does — then measure.
  const before = element.getBoundingClientRect();
  const inView =
    before.width > 0 &&
    before.height > 0 &&
    before.bottom > 0 &&
    before.top < innerHeight &&
    before.right > 0 &&
    before.left < innerWidth;
  if (!inView) {
    // "instant" is load-bearing: the default honours the page's CSS
    // scroll-behavior, and a storefront that sets `smooth` animates the scroll
    // asynchronously, so the rect below would still be the pre-scroll one and
    // the occlusion check would burn the attempt this scroll exists to save.
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return timed({ ok: false, reason: "no_box" });
  }
  let x = rect.x + rect.width / 2;
  let y = rect.y + rect.height / 2;
  // Ascend same-origin ancestor frames, accumulating their offsets. A
  // cross-origin (OOPIF) boundary stops the walk — the child window reports
  // no frameElement across it — so report reachedTop=false and let the host
  // add the remaining offset from the frame's own <iframe> element.
  let reachedTop = false;
  try {
    let view: Window | null = element.ownerDocument.defaultView;
    let frameEl = view?.frameElement ?? null;
    while (frameEl instanceof Element) {
      const frameRect = frameEl.getBoundingClientRect();
      x += frameRect.x;
      y += frameRect.y;
      view = frameEl.ownerDocument.defaultView;
      frameEl = view?.frameElement ?? null;
    }
    reachedTop = view === window.top;
  } catch {
    reachedTop = false;
  }
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (hit === null || (hit !== element && !element.contains(hit) && !hit.contains(element))) {
    return timed({ ok: false, reason: "occluded" });
  }
  const combobox =
    element.getAttribute("role") === "combobox" ||
    element.getAttribute("role") === "searchbox" ||
    element.getAttribute("aria-haspopup") !== null ||
    (element instanceof HTMLInputElement &&
      (element.type === "search" ||
        element.type === "date" ||
        element.type === "datetime-local" ||
        element.type === "month" ||
        element.readOnly ||
        element.getAttribute("aria-autocomplete") !== null));
  const ariaLabel = element.getAttribute("aria-label") ?? "";
  const placeholder = element instanceof HTMLInputElement ? element.placeholder : "";
  const searchSubmit =
    element.getAttribute("role") === "searchbox" ||
    (element instanceof HTMLInputElement && (element.type === "search" || element.name === "q")) ||
    /search/i.test(ariaLabel) ||
    /search/i.test(placeholder);
  if (input.kind === "select") {
    if (!(element instanceof HTMLSelectElement)) {
      return timed({ ok: false, reason: "not_select" });
    }
    const wanted = input.text ?? "";
    const wantedLower = wanted.toLowerCase();
    const options = Array.from(element.options);
    // Match exactly first — by value, label, or trimmed visible text, then
    // case-insensitively — before falling back to a partial substring. A
    // substring "V" must not select "Visa" when the page offers an exact
    // option named "V"; two-pass ordering keeps exact matches authoritative.
    const match =
      options.find(
        (option) =>
          option.value === wanted ||
          option.label === wanted ||
          (option.textContent ?? "").trim() === wanted,
      ) ??
      options.find(
        (option) =>
          option.value.toLowerCase() === wantedLower ||
          option.label.toLowerCase() === wantedLower ||
          (option.textContent ?? "").trim().toLowerCase() === wantedLower,
      ) ??
      options.find((option) =>
        (option.textContent ?? "").trim().toLowerCase().includes(wantedLower),
      );
    if (match === undefined) return timed({ ok: false, reason: "option_missing" });
    element.value = match.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return timed({ ok: true, x, y, reachedTop, combobox: false, searchSubmit: false });
  }
  // The type path does NOT focus or select here: the host clicks first, then
  // runs selectAllInPage inside this frame. A guard-side focus races that
  // click (and is dropped entirely when a cross-origin boundary separates
  // them), leaving insertText to land in whatever element happens to hold
  // focus.
  return timed({ ok: true, x, y, reachedTop, combobox, searchSubmit });
}

/**
 * Focus the target and select its contents, after the host's click has
 * focused it. Runs inside the element's own frame so cross-origin fields are
 * reached directly; the registry lookup is repeated because the frame may
 * have re-rendered between the guard and this evaluate.
 */
function selectAllInPage(input: { ref: string }): boolean {
  type DriveCache = { nodes: Map<string, Element> };
  const root = window as Window & { __tsDriveRegistry?: DriveCache };
  const element = root.__tsDriveRegistry?.nodes.get(input.ref);
  if (element === undefined || !element.isConnected) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.select();
    return true;
  }
  if (element instanceof HTMLElement) {
    element.focus();
    const doc = element.ownerDocument;
    const selection = doc.getSelection();
    if (selection === null) return false;
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}

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

async function overlayOptionLabels(page: Page): Promise<string[]> {
  return evaluateBound(
    page,
    (selector) => {
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

async function waitForOverlayOptionsToChange(page: Page, before: string[]): Promise<void> {
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
    { selector: OVERLAY_OPTION_SELECTOR, before, cap: DRIVE_OVERLAY_REFRESH_WAIT_MS },
  );
}

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

const LIST_FILTER_SELECTOR =
  '[role="combobox"][aria-expanded="true"],[role="listbox"] input,input[aria-autocomplete="list"],input[aria-autocomplete="both"]';

async function listOwnerSignature(frame: Frame): Promise<string> {
  return frame
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
 */
async function clickDriveListOption(frame: Frame, ref: string): Promise<boolean> {
  const info = await frame
    .evaluate((input: { ref: string }) => {
      type DriveCache = { nodes: Map<string, Element> };
      const root = window as Window & { __tsDriveRegistry?: DriveCache };
      const element = root.__tsDriveRegistry?.nodes.get(input.ref);
      if (element === undefined || !element.isConnected) return null;
      const option = element.closest('[role="option"],[role="menuitem"]');
      const item = option ?? element;
      const role = item.getAttribute("role");
      const inListbox = item.closest('[role="listbox"]') !== null;
      const inMenu = item.closest('[role="menu"]') !== null;
      const text = (item.textContent ?? "").replace(/\s+/g, " ").trim();
      return { role, inListbox, inMenu, text };
    }, { ref })
    .catch(() => null);
  if (info === null) return false;
  const identity = listOptionIdentity(info.role, info.inListbox, info.inMenu, info.text);
  if (identity === null) return false;
  const page = frame.page();
  const before = await listOwnerSignature(frame);
  const option = page.getByRole(identity.role, { name: identity.text, exact: true }).first();
  if ((await option.count().catch(() => 0)) === 0) {
    await typeIntoOpenFilter(page, identity.text);
  }
  const target = page.getByRole(identity.role, { name: identity.text, exact: true }).first();
  if ((await target.count().catch(() => 0)) === 0) return false;
  try {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ timeout: 5000 });
    if ((await listOwnerSignature(frame)) !== before) return true;
    await page.keyboard.press("Enter");
    if ((await listOwnerSignature(frame)) !== before) return true;
    if (await typeIntoOpenFilter(page, identity.text)) {
      await page.keyboard.press("Enter");
    }
    return true;
  } catch {
    return false;
  }
}

export async function driveActOnPage(page: Page, action: ProvisionAction): Promise<DriveActResult> {
  if (action.kind === "scroll") {
    const direction = action.direction ?? "down";
    const wallStarted = Date.now();
    try {
      await evaluateBound(
        page,
        (dir) => {
          const height = innerHeight;
          if (dir === "down") scrollBy(0, Math.min(560, height));
          else if (dir === "up") scrollBy(0, -Math.min(560, height));
          else if (dir === "bottom") scrollTo(0, document.documentElement.scrollHeight);
          else scrollTo(0, 0);
        },
        direction,
      );
    } catch {
      return {
        kind: "stale",
        reason: "evaluate_timeout",
        ...ZERO_ACT_TIMINGS,
        guardWallMs: Date.now() - wallStarted,
      };
    }
    return {
      kind: "ok",
      combobox: false,
      searchSubmit: false,
      ...ZERO_ACT_TIMINGS,
      guardWallMs: Date.now() - wallStarted,
    };
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
    return {
      kind: "stale",
      reason: "evaluate_timeout",
      ...ZERO_ACT_TIMINGS,
      guardWallMs: Date.now() - guardStarted,
    };
  }
  const timings: DriveActTimings = {
    guardScriptMs: guard.scriptMs,
    guardWallMs: Date.now() - guardStarted,
    cdpMs: 0,
  };
  if (!guard.ok) return { kind: "stale", reason: guard.reason, ...timings };
  if (action.kind === "select")
    return { kind: "ok", combobox: false, searchSubmit: false, ...timings };
  // Drive clicks use CDP at the guard's cached center. Listbox/combobox
  // widgets often re-render the list before that event lands, so the
  // option's select handler never fires. A fresh role=option locator,
  // then Enter, then a filter input event, is the family commit — not
  // coordinates.
  if (action.kind === "click") {
    const listClicked = await clickDriveListOption(frame, action.target);
    if (listClicked) {
      return {
        kind: "ok",
        combobox: guard.combobox,
        searchSubmit: guard.searchSubmit,
        ...timings,
      };
    }
  }
  // CDP mouse coordinates are main-viewport CSS px; the compositor routes
  // hits into OOPIFs. When the in-page walk could not reach window.top (a
  // cross-origin boundary), the guard's x/y are still relative to that
  // frame's viewport — add the frame's own <iframe> position. Playwright's
  // boundingBox already accumulates every ancestor frame offset, so a single
  // hop is the complete correction and further chaining would double-count.
  let offsetX = 0;
  let offsetY = 0;
  if (!guard.reachedTop && frame !== page.mainFrame()) {
    const element = await frame.frameElement().catch(() => null);
    if (element !== null) {
      const box = await element.boundingBox().catch(() => null);
      if (box !== null) {
        offsetX = box.x;
        offsetY = box.y;
      }
    }
  }
  const x = guard.x + offsetX;
  const y = guard.y + offsetY;
  const context = page.context();
  const cdpStarted = Date.now();
  const cdp = await context.newCDPSession(page);
  try {
    if (action.kind === "click") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return {
        kind: "ok",
        combobox: guard.combobox,
        searchSubmit: guard.searchSubmit,
        ...timings,
        cdpMs: Date.now() - cdpStarted,
      };
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    // A picker click focuses the overlay input (Flights "Where else?").
    // Refocusing the snapshot ref yanks that away and insertText writes
    // behind the dialog. Match jev-ultrafast: wait for the overlay, then
    // selectAll+insertText with no in-page focus. Plain fields still
    // reselect the clicked ref so a detached target cannot type into a neighbor.
    let overlayLabelsBeforeType: string[] = [];
    if (guard.combobox) {
      await waitForOpenedOverlay(page).catch(() => undefined);
      overlayLabelsBeforeType = await overlayOptionLabels(page);
    } else {
      const selected = await evaluateBound(frame, selectAllInPage, { ref: action.target }).catch(
        () => false,
      );
      if (!selected) {
        return {
          kind: "stale",
          reason: "reselection_failed",
          ...timings,
          cdpMs: Date.now() - cdpStarted,
        };
      }
    }
    // Selection API select() / selectNodeContents does not replace a committed
    // Flights city chip after another overlay has just closed. Issue the
    // browser's own selectAll command (same as jev-ultrafast) so insertText
    // overwrites whatever the click focused.
    const modifier = process.platform === "darwin" ? 4 : 2;
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
      commands: ["selectAll"],
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
    });
    await cdp.send("Input.insertText", { text: action.text });
    // Autocomplete keeps the pre-type rows until the network refresh
    // (~110ms on Flights). Returning at first option presence snapshots
    // the stale set and the model BLOCKED.
    if (guard.combobox) {
      await waitForOverlayOptionsToChange(page, overlayLabelsBeforeType).catch(() => undefined);
    }
    if (guard.searchSubmit) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
    return {
      kind: "ok",
      combobox: guard.combobox,
      searchSubmit: guard.searchSubmit,
      ...timings,
      cdpMs: Date.now() - cdpStarted,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
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
