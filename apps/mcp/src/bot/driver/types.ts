// Contract C — the frozen browser-driver interface.
//
// §1.3 of data/ts-layer-contracts-design/report.md. The driver is Playwright
// mechanics only: seven verbs plus one observe hook. Nothing page-behaviour
// shaped belongs here.
//
// PR 4 of the layer-contracts plan evolves `DriverTarget` from the bare
// selector string into the report's target union and folds today's
// handle/frame entry points (`clickHandle`, `clickInFrame`, `typeHandle`,
// `typeInFrame`, `selectInFrame`, …) into the single verbs: the driver owns
// the frame-vs-page dispatch from here on, so the tooling layer keeps one
// call site per verb (`executeAct` in provision-session.ts).

import type { ElementHandle, Page } from "playwright";
import type { BrowserUseCapture } from "../browser-use-capture.js";

/** Frame identity (origin + path) captured from a fresh observation. */
export interface FrameTarget {
  framePath: string;
  frameOrigin: string;
  frameUrl: string;
}

/**
 * What a driver verb acts on. The tooling layer resolves session refs to one
 * of these; how the verb reaches the element (page locator, frame handle,
 * pre-resolved handle) is the driver's business.
 */
export type DriverTarget =
  | { kind: "selector"; selector: string } // element on the action page
  | { kind: "frame"; frame: FrameTarget; selector: string } // element inside a child frame
  | { kind: "handle"; handle: ElementHandle<Element> }; // pre-resolved element handle

/** How `click` dispatches. Only `click` reads this; the other verbs ignore it. */
export type ClickMethod = "click" | "js_click";

/** The page a verb acts on. `undefined` means the controller's active page. */
export type PageHandle = Page;

/** Base64 image bytes from `screenshot` (today's return shape). */
export type DriverScreenshot = string;

/** Raw serializer capture returned by `observe` (Contract D input). */
export type PageCapture = BrowserUseCapture;

export interface BrowserDriver {
  // 1 navigate
  navigate(url: string, page?: PageHandle): Promise<void>;
  // 2 click (dispatch evidence is the driver's business; never a page verdict)
  click(target: DriverTarget & { method: ClickMethod }, page?: PageHandle | null): Promise<void>;
  // 3 type
  type(
    target: DriverTarget,
    text: string,
    sealed?: boolean,
    page?: PageHandle | null,
  ): Promise<void>;
  // 4 select (returns the committed option text)
  select(target: DriverTarget, optionMatcher?: string, page?: PageHandle | null): Promise<string>;
  // 5 press
  press(key: string, page?: PageHandle | null): Promise<void>;
  // 6 scroll
  scroll(direction: "up" | "down" | "top" | "bottom", page?: PageHandle | null): Promise<void>;
  // 7 screenshot
  screenshot(): Promise<DriverScreenshot>;
  // the ONE hook into the serializer: raw capture only, never a formatted observation
  observe(page?: PageHandle | null, settlePage?: boolean): Promise<PageCapture>;
}
