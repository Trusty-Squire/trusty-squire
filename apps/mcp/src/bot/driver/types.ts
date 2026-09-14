// Contract C — the frozen browser-driver interface.
//
// §1.3 of data/ts-layer-contracts-design/report.md. The driver is Playwright
// mechanics only: seven verbs plus one observe hook. Nothing page-behaviour
// shaped belongs here.
//
// PR 3 of the layer-contracts plan introduces the contract and has
// `BrowserController` declare that it satisfies it, with no behaviour change.
// The five verbs that are not method names today (`navigate`, `select`,
// `press`, `scroll`, `observe`) are one-line delegations on
// `BrowserController`; `click`, `type` and `screenshot` already carry the
// contract names and signatures. No caller changes in this PR.

import type { Page } from "playwright";
import type { BrowserUseCapture } from "../browser-use-capture.js";

/**
 * What a driver verb acts on today: the CSS selector string the tooling layer
 * passes to the selector-based entry points.
 *
 * PR 4 evolves this into the report's `{kind:"ref"} | {kind:"handle"} |
 * {kind:"frame"}` union and folds today's handle/frame entry points
 * (`clickHandle`, `clickInFrame`, `typeHandle`, `typeInFrame`,
 * `selectInFrame`, …) into the single verbs, which is why no target-resolution
 * logic exists here yet.
 */
export type DriverTarget = string;

/** The page a verb acts on. `undefined` means the controller's active page. */
export type PageHandle = Page;

/** Base64 image bytes from `screenshot` (today's return shape). */
export type DriverScreenshot = string;

/** Raw serializer capture returned by `observe` (Contract D input). */
export type PageCapture = BrowserUseCapture;

export interface BrowserDriver {
  // 1 navigate
  navigate(url: string, page?: PageHandle): Promise<void>;
  // 2 click
  click(target: DriverTarget): Promise<void>;
  // 3 type
  type(target: DriverTarget, text: string, sealed?: boolean): Promise<void>;
  // 4 select (returns the committed option text)
  select(target: DriverTarget, optionMatcher?: string): Promise<string>;
  // 5 press
  press(key: string, page?: PageHandle | null): Promise<void>;
  // 6 scroll
  scroll(direction: "up" | "down" | "top" | "bottom", page?: PageHandle | null): Promise<void>;
  // 7 screenshot
  screenshot(): Promise<DriverScreenshot>;
  // the ONE hook into the serializer: raw capture only, never a formatted observation
  observe(page?: PageHandle | null, settlePage?: boolean): Promise<PageCapture>;
}
