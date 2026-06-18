import { createHash } from "node:crypto";
import type { BrowserState, InteractiveElement } from "./browser.js";

export interface ObservationFrame {
  frameId: string;
  capturedAt: string;
  state: BrowserState;
  inventory: InteractiveElement[];
  visibleText: string;
  domDigest: string;
}

export interface ObservationFrameBrowserPort {
  getState(): Promise<BrowserState>;
  extractVisibleText?(): Promise<string>;
}

export type InventoryBuilder = () => Promise<InteractiveElement[]>;

let frameCounter = 0;

function nextFrameId(): string {
  frameCounter += 1;
  return `frame-${Date.now().toString(36)}-${frameCounter.toString(36)}`;
}

export async function captureObservationFrame(
  browser: ObservationFrameBrowserPort,
  buildInventory: InventoryBuilder,
): Promise<ObservationFrame> {
  const [state, inventory, visibleText] = await Promise.all([
    browser.getState(),
    buildInventory(),
    browser.extractVisibleText?.().catch(() => "") ?? Promise.resolve(""),
  ]);
  return {
    frameId: nextFrameId(),
    capturedAt: new Date().toISOString(),
    state,
    inventory,
    visibleText,
    domDigest: createHash("sha256").update(state.html).digest("hex"),
  };
}
