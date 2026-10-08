import type { Page } from "playwright";

export interface CeremonyDisplayClip {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The broker's X screen stays desktop sized. Only the Chrome window that
// contains the ceremony tab moves into the portion exposed to noVNC.
export const PHONE_CEREMONY_CLIP: CeremonyDisplayClip = {
  left: 0,
  top: 0,
  // Chrome clamps narrower top-level windows to 500px on Linux.
  width: 500,
  height: 932,
};

export async function resizeCeremonyWindow(
  page: Page,
): Promise<{ clip: CeremonyDisplayClip; restore: () => Promise<void> }> {
  const browser = page.context().browser();
  if (browser === null) throw new Error("ceremony browser has no CDP connection");
  const targetSession = await page.context().newCDPSession(page);
  let targetId: string;
  try {
    targetId = (await targetSession.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await targetSession.detach();
  }
  const cdp = await browser.newBrowserCDPSession();
  let restore: (() => Promise<void>) | undefined;
  let changed = false;
  try {
    const { windowId, bounds: original } = await cdp.send("Browser.getWindowForTarget", {
      targetId,
    });
    let restored = false;
    restore = async () => {
      if (restored) return;
      restored = true;
      try {
        // Chrome rejects coordinates together with a non-normal state.
        const bounds =
          original.windowState !== undefined && original.windowState !== "normal"
            ? { windowState: original.windowState }
            : original;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds });
      } finally {
        await cdp.detach();
      }
    };
    changed = true;
    if (original.windowState !== undefined && original.windowState !== "normal") {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    }
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal", ...PHONE_CEREMONY_CLIP },
    });
    const actual = (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
    if (
      actual.left === undefined ||
      actual.top === undefined ||
      actual.width === undefined ||
      actual.height === undefined
    ) {
      throw new Error("ceremony window bounds could not be read after resize");
    }
    return {
      clip: {
        left: actual.left,
        top: actual.top,
        width: actual.width,
        height: actual.height,
      },
      restore,
    };
  } catch (error) {
    if (changed) await restore?.().catch(() => undefined);
    else await cdp.detach().catch(() => undefined);
    throw error;
  }
}
