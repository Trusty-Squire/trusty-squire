import { randomUUID } from "node:crypto";
import type { CDPSession, Frame, Page } from "playwright";
import {
  markOperatorMutationDispatchAttempted,
  throwIfOperatorRequestCancelled,
} from "./request-cancellation.js";

export interface ScreenshotPoint {
  screenshot_id: string;
  x: number;
  y: number;
}
export interface ScreenshotBinding {
  screenshot_id: string;
  width: number;
  height: number;
  coordinate_space: "image_pixels";
}
type Rect = { x: number; y: number; width: number; height: number };
type FrameSecurity = (frame: Frame) => Promise<{ origin: string; opaque: boolean }>;
type Binding = {
  frameSecurity: FrameSecurity;
  public: ScreenshotBinding;
  state: string;
  beforeNodes: Map<string, string>;
  afterNodes: Map<string, string>;
  rect: Rect;
  expires: number;
};
const bindings = new WeakMap<Page, Binding>();

export class ScreenshotClickError extends Error {
  constructor(
    readonly code: "stale_screenshot" | "invalid_screenshot_point" | "screenshot_click_uncertain",
    readonly dispatch: "not_dispatched" | "dispatched" | "unknown",
  ) {
    super(code);
  }
}

// Decode only JPEG dimensions, in Node. Image bytes never enter page JavaScript.
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  for (let offset = 2; offset + 8 < bytes.length; ) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    if (length < 2) break;
    offset += 2 + length;
  }
  throw new Error("invalid_screenshot_image");
}

async function geometry(page: Page, cdp: CDPSession) {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const tree = await cdp.send("Page.getFrameTree");
  const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
  // Compare the chosen physical node, not every ancestor/text line on the page.
  // Chromium can shift an inline label baseline by one pixel during cropped
  // capture while the checkbox's identity, attributes and hit area stay exact.
  const nodes = new Map<string, string>();
  for (const doc of snapshot.documents) {
    if (!doc.nodes.nodeName || !doc.nodes.parentIndex || !doc.nodes.backendNodeId) continue;
    const texts = new Array<string>(doc.nodes.nodeName.length).fill("");
    for (const [j, i] of doc.layout.nodeIndex.entries())
      texts[i] = snapshot.strings[doc.layout.text[j] ?? -1] ?? "";
    for (let i = texts.length - 1; i >= 0; i--) {
      const parent = doc.nodes.parentIndex[i];
      if (parent !== undefined && parent >= 0) texts[parent] = texts[i]! + texts[parent]!;
    }
    const controls = doc.nodes.nodeName.map((name, i) => {
      const attributes = doc.nodes.attributes?.[i]?.map((v) => snapshot.strings[v]) ?? [];
      const role = attributes.findIndex((value, index) => index % 2 === 0 && value === "role");
      return (
        /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/.test(snapshot.strings[name] ?? "") ||
        (role >= 0 && ["button", "checkbox", "radio"].includes(attributes[role + 1] ?? ""))
      );
    });
    for (const [j, i] of doc.layout.nodeIndex.entries()) {
      const id = doc.nodes.backendNodeId?.[i];
      const nameIndex = doc.nodes.nodeName?.[i];
      if (id === undefined || nameIndex === undefined) continue;
      let control = i;
      while (!controls[control] && (doc.nodes.parentIndex[control] ?? -1) >= 0)
        control = doc.nodes.parentIndex[control]!;
      if (!controls[control]) control = i;
      nodes.set(
        `${snapshot.strings[doc.frameId]}:${id}`,
        JSON.stringify({
          bounds: doc.layout.bounds[j],
          attributes: doc.nodes.attributes?.[i]?.map((v) => snapshot.strings[v]),
          name: snapshot.strings[nameIndex],
          text: snapshot.strings[doc.nodes.nodeValue?.[i] ?? -1],
          control: doc.nodes.backendNodeId[control],
          controlText: texts[control]?.replace(/\s+/g, " ").trim(),
          controlAttributes: doc.nodes.attributes?.[control]?.map((v) => snapshot.strings[v]),
        }),
      );
    }
  }
  const boxes = await Promise.all(
    page.frames().map(async (frame) => {
      if (frame === page.mainFrame()) return null;
      const handle = await frame.frameElement();
      try {
        return { url: frame.url(), box: await handle.boundingBox() };
      } finally {
        await handle.dispose();
      }
    }),
  );
  const viewport = metrics.cssVisualViewport;
  return {
    state: JSON.stringify({ tree, viewport, layout: metrics.cssLayoutViewport, boxes }),
    viewport,
    nodes,
  };
}

/** Existing pixel capture stays read-only. A failed binding never prevents the read. */
export async function captureBoundScreenshot(
  page: Page,
  frameSecurity: FrameSecurity,
  capture: () => Promise<{ base64: string; rect: Rect }>,
): Promise<{ base64: string; clickBinding?: ScreenshotBinding }> {
  bindings.delete(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    const before = await geometry(page, cdp).catch(() => null);
    const result = await capture();
    const after = await geometry(page, cdp).catch(() => null);
    if (before === null || after === null || before.state !== after.state)
      return { base64: result.base64 };
    const publicBinding: ScreenshotBinding = {
      screenshot_id: randomUUID(),
      ...jpegSize(result.base64),
      coordinate_space: "image_pixels",
    };
    bindings.set(page, {
      frameSecurity,
      public: publicBinding,
      state: after.state,
      beforeNodes: before.nodes,
      afterNodes: after.nodes,
      rect: result.rect,
      expires: Date.now() + 60_000,
    });
    return { base64: result.base64, clickBinding: publicBinding };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export interface ScreenshotClickTarget {
  nodeKey: string;
  labels: string[];
  frameUrl: string;
  frameOrigin: string;
  frameOpaque: boolean;
  mainFrame: boolean;
}

// CDP can resolve a closed-shadow node without manufacturing a CSS selector.
// Reading the hit node's nearest control supplies the SAME existing action/payment
// predicates used by DOM targeting; only the dispatch itself uses image coordinates.
async function hitTarget(
  page: Page,
  cdp: CDPSession,
  x: number,
  y: number,
  frameSecurity: FrameSecurity,
): Promise<ScreenshotClickTarget> {
  const hit = await cdp.send("DOM.getNodeForLocation", {
    x: Math.round(x),
    y: Math.round(y),
    includeUserAgentShadowDOM: true,
  });
  let nodeSession = cdp;
  let owned: CDPSession | undefined;
  try {
    // A cross-process iframe's backend node belongs to its own CDP session.
    const root = await cdp.send("Page.getFrameTree");
    if (hit.frameId !== root.frameTree.frame.id) {
      for (const candidate of page.frames()) {
        if (candidate === page.mainFrame()) continue;
        const session = await page
          .context()
          .newCDPSession(candidate)
          .catch(() => null);
        if (session === null) continue; // Same-process frame shares the page session.
        const candidateTree = await session.send("Page.getFrameTree");
        if (candidateTree.frameTree.frame.id === hit.frameId) {
          nodeSession = session;
          owned = session;
          break;
        }
        await session.detach();
      }
    }
    const findFrame = (tree: typeof root.frameTree, frame: Frame): Frame | undefined => {
      if (`${tree.frame.url}${tree.frame.urlFragment ?? ""}` !== frame.url()) return undefined;
      if (tree.frame.id === hit.frameId) return frame;
      for (const [index, child] of (tree.childFrames ?? []).entries()) {
        const candidate = frame.childFrames()[index];
        if (!candidate) continue;
        const found = findFrame(child, candidate);
        if (found) return found;
      }
      return undefined;
    };
    const frame = findFrame(root.frameTree, page.mainFrame());
    if (!frame) throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
    const security =
      frame === page.mainFrame()
        ? { origin: new URL(frame.url()).origin, opaque: false }
        : await frameSecurity(frame);
    const node = await nodeSession.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId });
    if (!node.object.objectId) throw new Error("screenshot_target_unavailable");
    try {
      const result = await nodeSession.send("Runtime.callFunctionOn", {
        objectId: node.object.objectId,
        functionDeclaration: `function() {
          let el = this.nodeType === 1 ? this : this.parentElement;
          for (let p = el; p; p = p.parentElement || (p.getRootNode() instanceof ShadowRoot ? p.getRootNode().host : null)) {
            if (p.matches('button,a,input,select,textarea,label,[role="button"],[role="checkbox"],[role="radio"]')) { el = p; break; }
          }
          return { labels: [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('action-type'), el.getAttribute('name'), el.id, el.getAttribute('value'), ...Array.from(el.labels || [], l => l.innerText)].filter(x => typeof x === 'string'), frameUrl: location.href, frameOrigin: location.origin };
        }`,
        returnByValue: true,
      });
      if (result.exceptionDetails || !result.result.value)
        throw new Error("screenshot_target_unavailable");
      return {
        ...result.result.value,
        frameOrigin: security.origin,
        frameOpaque: security.opaque,
        nodeKey: `${hit.frameId}:${hit.backendNodeId}`,
        mainFrame: hit.frameId === root.frameTree.frame.id,
      } as ScreenshotClickTarget;
    } finally {
      await nodeSession
        .send("Runtime.releaseObject", { objectId: node.object.objectId })
        .catch(() => undefined);
    }
  } finally {
    await owned?.detach().catch(() => undefined);
  }
}

export async function clickScreenshot(
  page: Page,
  point: ScreenshotPoint,
  authorize: (target: ScreenshotClickTarget) => void,
): Promise<"dispatched"> {
  const binding = bindings.get(page);
  if (
    !binding ||
    binding.public.screenshot_id !== point.screenshot_id ||
    binding.expires < Date.now()
  )
    throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
  // Consume synchronously before any await: concurrent callers, dispatch failures,
  // and lost responses cannot replay this image's click.
  bindings.delete(page);
  const { width, height } = binding.public;
  if (
    ![point.x, point.y].every(Number.isFinite) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height
  )
    throw new ScreenshotClickError("invalid_screenshot_point", "not_dispatched");
  const cdp = await page.context().newCDPSession(page);
  let attempted = false;
  try {
    const current = await geometry(page, cdp);
    if (current.state !== binding.state)
      throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
    const x = Math.round(
      binding.rect.x + (point.x * binding.rect.width) / width - current.viewport.pageX,
    );
    const y = Math.round(
      binding.rect.y + (point.y * binding.rect.height) / height - current.viewport.pageY,
    );
    if (x < 0 || y < 0 || x >= current.viewport.clientWidth || y >= current.viewport.clientHeight)
      throw new ScreenshotClickError("invalid_screenshot_point", "not_dispatched");
    const target = await hitTarget(page, cdp, x, y, binding.frameSecurity);
    await markOperatorMutationDispatchAttempted();
    const final = await geometry(page, cdp);
    const originalNode = binding.beforeNodes.get(target.nodeKey);
    if (
      binding.expires < Date.now() ||
      final.state !== binding.state ||
      originalNode === undefined ||
      originalNode !== binding.afterNodes.get(target.nodeKey) ||
      originalNode !== current.nodes.get(target.nodeKey) ||
      originalNode !== final.nodes.get(target.nodeKey)
    )
      throw new ScreenshotClickError("stale_screenshot", "not_dispatched");
    throwIfOperatorRequestCancelled();
    authorize(target);
    attempted = true;
    await page.mouse.click(x, y);
    return "dispatched";
  } catch (error) {
    if (attempted) throw new ScreenshotClickError("screenshot_click_uncertain", "unknown");
    throw error;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
