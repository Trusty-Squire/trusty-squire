import { randomBytes } from "node:crypto";
import type { CDPSession, Frame, Page } from "playwright";
interface RawNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: RawNode[];
  shadowRoots?: RawNode[];
  shadowRootType?: string;
  contentDocument?: RawNode;
  frameId?: string;
  isScrollable?: boolean;
}
interface FrameTree {
  frame: { id: string; url: string; loaderId: string };
  childFrames?: FrameTree[];
}
import type { InteractiveElement } from "./browser.js";
import {
  browserUseBoundedContextText,
  browserUseDynamicsSignature,
  browserUseInteractive,
  browserUseLocalContextContainer,
  browserUseOrderedHeadingContext,
  type BrowserUseNode,
  type DOMBounds,
} from "./browser-use-serializer.js";

// Frame object identity prevents backend IDs from crossing renderer/frame scopes.
// Kept outside the page; authored DOM attributes cannot forge this namespace.
const frameIdentities = new WeakMap<Frame, string>();
function frameIdentity(frame: Frame): string {
  let identity = frameIdentities.get(frame);
  if (identity === undefined) {
    identity = randomBytes(32).toString("base64url");
    frameIdentities.set(frame, identity);
  }
  return identity;
}

const STYLES = [
  "display",
  "visibility",
  "opacity",
  "overflow",
  "overflow-x",
  "overflow-y",
  "cursor",
  "pointer-events",
  "position",
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "filter",
  "backdrop-filter",
  "contain",
  "will-change",
  "content-visibility",
  "background-color",
];
const iframeHintContextMaxChars = 40;
interface Layout {
  bounds: DOMBounds | null;
  scroll: DOMBounds | null;
  client: DOMBounds | null;
  styles: Record<string, string>;
  paintOrder?: number | undefined;
  inputValue?: string;
  checked?: boolean;
}
export interface BrowserUseCapture {
  root: BrowserUseNode;
  elements: InteractiveElement[];
  nodeElements: Map<string, InteractiveElement>;
  moreAbove: boolean;
  moreBelow: boolean;
  /** Closed-shadow/iframe/frame-set structural signature (delta change hash). */
  dynamics: string;
}
const rect = (v: number[] | undefined): DOMBounds | null =>
  v && v.length >= 4 ? { x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! } : null;
/** Capture the three canonical Chrome trees. No page mutation and no Python runtime. */
export async function captureBrowserUseDOM(
  page: Page,
  existing: readonly InteractiveElement[],
  framePath: (frame: Frame) => string | null,
  frameSecurity: (frame: Frame) => Promise<{ opaque: boolean }>,
): Promise<BrowserUseCapture> {
  const nodeElements = new Map<string, InteractiveElement>();
  const opaqueFrames = new Map<Frame, boolean>();
  const renderedNodes = new Map<string, boolean>();
  const frameViews = new Map<Frame, { width: number; height: number; x: number; y: number }>();
  const viewMetadata = new Map<
    string,
    {
      layout: Layout | undefined;
      name: string;
      frame?: Frame;
    }
  >();
  let moreAbove = false,
    moreBelow = false;
  const classifyFrame = async (frame: Frame): Promise<void> => {
    if (frame === page.mainFrame()) {
      opaqueFrames.set(frame, false);
      return;
    }
    if (opaqueFrames.has(frame)) return;
    try {
      opaqueFrames.set(frame, (await frameSecurity(frame)).opaque);
    } catch {
      opaqueFrames.set(frame, true);
    }
  };
  await Promise.all(page.frames().map(classifyFrame));
  const opaqueFramePaths = new Set(
    [...opaqueFrames].filter(([, opaque]) => opaque).map(([frame]) => framePath(frame)),
  );
  const inventory = existing
    .filter((e) => e.frameOpaque !== true && !opaqueFramePaths.has(e.framePath ?? null))
    .map((e) => ({ ...e }));
  const elements: InteractiveElement[] = [];
  const cdp = await page.context().newCDPSession(page);
  const sessions: CDPSession[] = [cdp];
  let nextSyntheticIndex = Math.max(-1, ...inventory.map((element) => element.index)) + 1;
  const capture = async (
    client: CDPSession,
    prefix: string,
    owningFrame: Frame,
  ): Promise<BrowserUseNode> => {
    const [dom, snapshot, ax, frames] = await Promise.all([
      client.send("DOM.getDocument", { depth: -1, pierce: true }),
      client.send("DOMSnapshot.captureSnapshot", {
        computedStyles: STYLES,
        includeDOMRects: true,
        includePaintOrder: true,
      }),
      client.send("Accessibility.getFullAXTree"),
      client.send("Page.getFrameTree"),
    ]);
    const layouts = new Map<number, Layout>();
    for (const document of snapshot.documents) {
      const nodes = document.nodes,
        layout = document.layout;
      const layoutIndices = new Map<number, number>();
      layout.nodeIndex.forEach((n, i) => {
        if (!layoutIndices.has(n)) layoutIndices.set(n, i);
      });
      const inputs = new Map<number, string>();
      for (const values of [nodes.inputValue, nodes.textValue])
        values?.index.forEach((n, i) => inputs.set(n, snapshot.strings[values.value[i]!]!));
      const checked = new Set(nodes.inputChecked?.index ?? []);
      nodes.backendNodeId?.forEach((id, i) => {
        const li = layoutIndices.get(i);
        layouts.set(id, {
          paintOrder: li === undefined ? undefined : layout.paintOrders?.[li],
          bounds: li === undefined ? null : rect(layout.bounds[li]),
          client: li === undefined ? null : rect(layout.clientRects?.[li]),
          scroll: li === undefined ? null : rect(layout.scrollRects?.[li]),
          styles:
            li === undefined
              ? {}
              : Object.fromEntries(
                  (layout.styles[li] ?? []).map((s, j) => [STYLES[j]!, snapshot.strings[s]!]),
                ),
          ...(inputs.has(i) ? { inputValue: inputs.get(i)! } : {}),
          ...(nodes.inputChecked ? { checked: checked.has(i) } : {}),
        });
      });
    }
    const axs = new Map(
      ax.nodes.filter((n) => n.backendDOMNodeId !== undefined).map((n) => [n.backendDOMNodeId!, n]),
    );
    const hasCustomElements = (node: RawNode): boolean =>
      (node.nodeType === 1 && node.nodeName.includes("-")) ||
      (node.children ?? []).some(hasCustomElements) ||
      (node.shadowRoots ?? []).some(hasCustomElements) ||
      (node.contentDocument !== undefined && hasCustomElements(node.contentDocument));
    const containsCustomElements = hasCustomElements(dom.root);
    const frameIds: string[] = [];
    const frameById = new Map<string, Frame>();
    const framePathById = new Map<string, string | null>();
    const unboundFrames = new Set<Frame>();
    const unboundFrameIds = new Set<string>();
    const isFrameUnbound = (frame: Frame | null): boolean => {
      if (frame === null) return true;
      let current: Frame | null = frame;
      while (current !== null) {
        if (unboundFrames.has(current)) return true;
        current = current.parentFrame();
      }
      return false;
    };
    const markUnboundFrameTree = (tree: FrameTree, frame: Frame | undefined): void => {
      unboundFrameIds.add(tree.frame.id);
      if (frame) framePathById.set(tree.frame.id, framePath(frame));
      for (const [index, child] of (tree.childFrames ?? []).entries())
        markUnboundFrameTree(child, frame?.childFrames()[index]);
    };
    const documentLoaders = new Map<Frame, string>();
    const bindFrames = (tree: FrameTree, frame: Frame): void => {
      documentLoaders.set(frame, tree.frame.loaderId);
      frameIds.push(tree.frame.id);
      frameById.set(tree.frame.id, frame);
      framePathById.set(tree.frame.id, frame === page.mainFrame() ? null : framePath(frame));
      const available = new Set(frame.childFrames());
      for (const [index, child] of (tree.childFrames ?? []).entries()) {
        const matched = [...available].find((candidate) => candidate.url() === child.frame.url);
        if (matched) {
          available.delete(matched);
          bindFrames(child, matched);
        } else markUnboundFrameTree(child, frame.childFrames()[index]);
      }
    };
    bindFrames(frames.frameTree, owningFrame);
    await Promise.all([...frameById.values()].map(classifyFrame));
    const forgetFrame = (frameId: string): void => {
      const frame = frameById.get(frameId);
      if (frame) unboundFrames.add(frame);
      const path = framePathById.get(frameId);
      const belongsToFailedFrame = (candidate: string | null | undefined): boolean =>
        path === null ? true : candidate === path || candidate?.startsWith(`${path}/`) === true;
      for (let i = inventory.length - 1; i >= 0; i -= 1)
        if (belongsToFailedFrame(inventory[i]!.framePath)) inventory.splice(i, 1);
    };
    for (const frameId of unboundFrameIds) {
      const path = framePathById.get(frameId);
      if (path === undefined) continue;
      const belongsToUnboundFrame = (candidate: string | null | undefined): boolean =>
        candidate === path || candidate?.startsWith(`${path}/`) === true;
      for (let i = inventory.length - 1; i >= 0; i -= 1)
        if (belongsToUnboundFrame(inventory[i]!.framePath)) inventory.splice(i, 1);
    }
    for (const frameId of frameIds.slice(1)) {
      try {
        const tree = await client.send("Accessibility.getFullAXTree", { frameId });
        for (const n of tree.nodes)
          if (n.backendDOMNodeId !== undefined) axs.set(n.backendDOMNodeId, n);
      } catch {
        forgetFrame(frameId);
      }
    }
    const listeners = new Set<number>();
    const formAssociatedTags = new Map<Frame, Set<string>>();
    const bindings = new Map<number, InteractiveElement>();
    const baseUris = new Map<Frame, string>();
    const baseTargets = new Map<Frame, string>();
    const formOwners = new Map<number, number | null>();
    const mainWorldContexts = new Map<string, number>();
    client.on(
      "Runtime.executionContextCreated",
      (event: { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }) => {
        const { frameId, isDefault } = event.context.auxData ?? {};
        if (frameId && isDefault) mainWorldContexts.set(frameId, event.context.id);
      },
    );
    await client.send("Runtime.enable");
    for (const frameId of frameIds) {
      const frame = frameById.get(frameId);
      if (!frame) continue;
      if (isFrameUnbound(frame)) continue;
      const path = framePathById.get(frameId)!;
      const candidates = inventory.filter((e) => (e.framePath ?? null) === path);
      const frameBindings = new Map<number, InteractiveElement>();
      const frameListeners = new Set<number>();
      let formAssociated = new Set<string>();
      if (containsCustomElements)
        try {
          formAssociated = new Set(
            await frame.evaluate(() => {
              const names = new Set<string>();
              const roots: Array<Document | ShadowRoot> = [document];
              const getShadowRoot = Object.getOwnPropertyDescriptor(
                Element.prototype,
                "shadowRoot",
              )?.get;
              for (let i = 0; i < roots.length; i++)
                for (const el of Array.from(roots[i]!.querySelectorAll("*"))) {
                  const name = el.localName;
                  if (name.includes("-")) {
                    let constructor = customElements.get(name) as Function | undefined;
                    while (constructor) {
                      const descriptor = Object.getOwnPropertyDescriptor(
                        constructor,
                        "formAssociated",
                      );
                      if (descriptor) {
                        if ("value" in descriptor && descriptor.value === true) names.add(name);
                        break;
                      }
                      constructor = Object.getPrototypeOf(constructor) as Function | undefined;
                    }
                  }
                  const shadowRoot = getShadowRoot?.call(el);
                  if (shadowRoot) roots.push(shadowRoot);
                }
              return [...names];
            }),
          );
        } catch {}
      formAssociatedTags.set(frame, formAssociated);
      try {
        const context = await client.send("Page.createIsolatedWorld", {
          frameId,
          worldName: "trusty-squire-observation",
        });
        // Return exact DOM objects. describeNode binds existing action selectors to
        // backend identities without guessing from tag names or accessible names.
        const selectors = candidates.map((e) => e.selector);
        const objects = await client.send("Runtime.evaluate", {
          expression: `(() => { const roots=[document],getShadowRoot=Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot')?.get; for(let i=0;i<roots.length;i++) for(const e of roots[i].querySelectorAll('*')) { const shadowRoot=getShadowRoot?.call(e); if(shadowRoot) roots.push(shadowRoot); } const found=${JSON.stringify(selectors)}.map(s => { const p=s.split(' >> nth='); const matches=roots.flatMap(r=>{try{return [...r.querySelectorAll(p[0])]}catch{return []}}); return matches[Number(p[1]||0)] || null; }); const formOwners=roots.flatMap(r=>[...r.querySelectorAll('[form]')]).flatMap(e=>[e,e.form||null]); return Object.assign(found,{viewport:JSON.stringify({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY}),baseURI:document.baseURI,baseTarget:document.querySelector('base[target]')?.getAttribute('target'),formOwners}); })()`,
          contextId: context.executionContextId,
          objectGroup: "ts-observation",
        });
        if (objects.result.objectId) {
          const props = await client.send("Runtime.getProperties", {
            objectId: objects.result.objectId,
            ownProperties: true,
          });
          const viewport = props.result.find((p) => p.name === "viewport")?.value?.value;
          if (typeof viewport === "string") frameViews.set(frame, JSON.parse(viewport));
          const baseUri = props.result.find((p) => p.name === "baseURI")?.value?.value;
          baseUris.set(frame, typeof baseUri === "string" ? baseUri : frame.url());
          const baseTarget = props.result.find((p) => p.name === "baseTarget")?.value?.value;
          if (typeof baseTarget === "string") baseTargets.set(frame, baseTarget);
          const ownerObjects = props.result.find((p) => p.name === "formOwners")?.value?.objectId;
          if (ownerObjects) {
            const ownerProps = await client.send("Runtime.getProperties", {
              objectId: ownerObjects,
              ownProperties: true,
            });
            const ownerValues = new Map(
              ownerProps.result
                .filter((p) => /^\d+$/.test(p.name))
                .map((p) => [Number(p.name), p.value]),
            );
            for (let i = 0; ownerValues.has(i); i += 2) {
              const control = ownerValues.get(i);
              if (!control?.objectId) continue;
              const controlNode = await client.send("DOM.describeNode", {
                objectId: control.objectId,
              });
              const owner = ownerValues.get(i + 1);
              if (!owner?.objectId) {
                formOwners.set(controlNode.node.backendNodeId, null);
                continue;
              }
              const ownerNode = await client.send("DOM.describeNode", { objectId: owner.objectId });
              formOwners.set(controlNode.node.backendNodeId, ownerNode.node.backendNodeId);
            }
          }
          const indexed = props.result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId);
          for (let i = 0; i < indexed.length; i += 8)
            await Promise.all(
              indexed.slice(i, i + 8).map(async (p) => {
                const d = await client.send("DOM.describeNode", { objectId: p.value!.objectId! });
                const el = candidates[Number(p.name)];
                if (el) frameBindings.set(d.node.backendNodeId, el);
              }),
            );
        }
        try {
          const listenerTargets = await client.send("Runtime.evaluate", {
            expression: `(() => { const roots=[document], priority=[], fallback=[], limit=100,getShadowRoot=Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot')?.get; for(let i=0;i<roots.length;i++) for(const el of roots[i].querySelectorAll('*')) { const shadowRoot=getShadowRoot?.call(el); if(shadowRoot) roots.push(shadowRoot); if(!el.localName.includes('-')) continue; const r=el.getBoundingClientRect(), s=getComputedStyle(el), visible=r.width>1&&r.height>1&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0; const role=el.getAttribute('role')||''; const likely=visible&&(/(?:quick-add|add-to-cart|product-form|buy|cart)/.test(el.localName)||el.closest("form,[class*='product'],[id*='product'],[class*='price'],[id*='price']")!==null||['button','link','checkbox','radio','combobox','textbox','menuitem','option','tab'].includes(role)||el.hasAttribute('command')||el.hasAttribute('commandfor')||el.hasAttribute('popovertarget')); const targets=likely?priority:fallback; if(targets.length<limit) targets.push(el); } return [...priority,...fallback].slice(0,limit); })()`,
            contextId: context.executionContextId,
            objectGroup: "ts-observation",
          });
          if (listenerTargets.result.objectId) {
            const props = await client.send("Runtime.getProperties", {
              objectId: listenerTargets.result.objectId,
              ownProperties: true,
            });
            const indexed = props.result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId);
            for (let i = 0; i < indexed.length; i += 8) {
              const batches = await Promise.all(
                indexed.slice(i, i + 8).map((p) =>
                  client.send("DOMDebugger.getEventListeners", {
                    objectId: p.value!.objectId!,
                    depth: 0,
                    pierce: true,
                  }),
                ),
              );
              for (const events of batches)
                for (const listener of events.listeners)
                  if (
                    listener.backendNodeId !== undefined &&
                    [
                      "click",
                      "mousedown",
                      "mouseup",
                      "pointerdown",
                      "pointerup",
                      "keydown",
                      "keyup",
                    ].includes(listener.type)
                  )
                    frameListeners.add(listener.backendNodeId);
            }
          }
        } catch {}
        try {
          const mainWorldContextId = mainWorldContexts.get(frameId);
          if (mainWorldContextId !== undefined) {
            const clickObjects = await client.send("Runtime.evaluate", {
              expression: `(() => { if(typeof getEventListeners!=='function')return null; const roots=[document],found=[],getShadowRoot=Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot')?.get; let count=0; for(let i=0;i<roots.length;i++) for(const el of roots[i].querySelectorAll('*')) { const shadowRoot=getShadowRoot?.call(el); if(shadowRoot)roots.push(shadowRoot); if(++count>10000)return null; if(el.localName.includes('-'))continue; const l=getEventListeners(el); if(l.click||l.mousedown||l.mouseup||l.pointerdown||l.pointerup){found.push(el);if(found.length>100)return null;} } return found;})()`,
              contextId: mainWorldContextId,
              includeCommandLineAPI: true,
              objectGroup: "ts-observation",
            });
            if (clickObjects.result.objectId) {
              const props = await client.send("Runtime.getProperties", {
                objectId: clickObjects.result.objectId,
                ownProperties: true,
              });
              const indexed = props.result.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId);
              for (let i = 0; i < indexed.length; i += 8)
                await Promise.all(
                  indexed.slice(i, i + 8).map(async (p) => {
                    const d = await client.send("DOM.describeNode", {
                      objectId: p.value!.objectId!,
                    });
                    frameListeners.add(d.node.backendNodeId);
                  }),
                );
            }
          }
        } catch {}
        for (const [backendNodeId, element] of frameBindings) bindings.set(backendNodeId, element);
        for (const backendNodeId of frameListeners) listeners.add(backendNodeId);
      } catch {
        forgetFrame(frameId);
      }
    }
    const liveBackendNodeIds = new Set<number>();
    try {
      const liveSnapshot = await client.send("DOMSnapshot.captureSnapshot", {
        computedStyles: [],
      });
      for (const document of liveSnapshot.documents)
        for (const backendNodeId of document.nodes.backendNodeId ?? [])
          liveBackendNodeIds.add(backendNodeId);
    } catch {}
    await client
      .send("Runtime.releaseObjectGroup", { objectGroup: "ts-observation" })
      .catch(() => undefined);
    const rawById = new Map<string, RawNode>();
    const nodeFrame = new Map<string, Frame | null>();
    const selectorsById = new Map<string, string>();
    const build = (
      raw: RawNode,
      parents: Array<{ raw: RawNode; layout: Layout }>,
      parent: BrowserUseNode | null,
      selector: string,
      frame: Frame | null,
    ): BrowserUseNode => {
      const l = layouts.get(raw.backendNodeId),
        a = Object.fromEntries(
          Array.from({ length: (raw.attributes?.length ?? 0) / 2 }, (_, i) => [
            raw.attributes![2 * i]!,
            raw.attributes![2 * i + 1]!,
          ]),
        );
      const axNode = axs.get(raw.backendNodeId),
        t = raw.nodeName.toLowerCase();
      if (["input", "textarea"].includes(t) && l) {
        if (l.inputValue !== undefined) a.value = l.inputValue;
        if (l.checked) a.checked = "true";
        else delete a.checked;
      }
      const id = prefix + raw.backendNodeId;
      let rendered =
        !!l?.bounds &&
        l.bounds.width > 0 &&
        l.bounds.height > 0 &&
        l.styles.display !== "none" &&
        l.styles.visibility !== "hidden" &&
        l.styles.visibility !== "collapse" &&
        !(Number(l.styles.opacity ?? "1") <= 0) &&
        !parents.some((p) => Number(p.layout.styles.opacity ?? "1") <= 0);
      let visible = rendered;
      const view = frame === null ? undefined : frameViews.get(frame);
      if (view && l?.bounds) {
        const b = l.bounds;
        visible &&=
          b.x - view.x < view.width &&
          b.x + b.width > view.x &&
          b.y - view.y < view.height &&
          b.y + b.height > view.y;
      }
      const chain = [...parents];
      if (l) chain.push({ raw, layout: l });
      if (l?.bounds) {
        let x = l.bounds.x,
          y = l.bounds.y;
        let positioned = l.styles.position;
        for (const p of [...chain].reverse()) {
          if (p.raw === raw) continue;
          const styles = p.layout.styles;
          const establishesContainingBlock =
            [
              "transform",
              "translate",
              "rotate",
              "scale",
              "perspective",
              "filter",
              "backdrop-filter",
            ].some((key) => styles[key] !== undefined && styles[key] !== "none") ||
            /(?:layout|paint|strict|content)/.test(styles.contain ?? "") ||
            /(?:transform|translate|rotate|scale|perspective|filter|contain)/.test(
              styles["will-change"] ?? "",
            ) ||
            styles["content-visibility"] === "auto";
          const escapes =
            (positioned === "fixed" && !establishesContainingBlock) ||
            (positioned === "absolute" &&
              !establishesContainingBlock &&
              styles.position === "static");
          const b = p.layout.bounds;
          if (!escapes && b && !["IFRAME", "FRAME"].includes(p.raw.nodeName)) {
            for (const axis of ["x", "y"] as const) {
              const overflow = p.layout.styles[`overflow-${axis}`] ?? p.layout.styles.overflow;
              const start = axis === "x" ? x : y;
              const size = axis === "x" ? "width" : "height";
              const outside = start >= b[axis] + b[size] || start + l.bounds[size] <= b[axis];
              if (outside && ["hidden", "clip", "auto", "scroll"].includes(overflow ?? "")) {
                visible = false;
                if (["hidden", "clip"].includes(overflow!)) rendered = false;
              }
            }
          }
          if (!escapes) positioned = styles.position;
          if (["IFRAME", "FRAME"].includes(p.raw.nodeName) && p.layout.bounds) {
            positioned = styles.position;
            x += p.layout.bounds.x;
            y += p.layout.bounds.y;
          }
          if (p.raw.nodeName === "HTML" && p.layout.client && p.layout.scroll) {
            const c = p.layout.client,
              s = p.layout.scroll;
            if (
              !(
                x - s.x < c.width &&
                x - s.x + l.bounds.width > 0 &&
                y - s.y < c.height &&
                y - s.y + l.bounds.height > 0
              )
            )
              visible = false;
            x -= s.x;
            y -= s.y;
          }
        }
      }
      renderedNodes.set(id, rendered);
      const overflow = l?.styles ?? {};
      const scrollable =
        raw.isScrollable === true ||
        (!!l?.scroll &&
          !!l.client &&
          (l.scroll.height > l.client.height + 1 || l.scroll.width > l.client.width + 1) &&
          ["overflow", "overflow-x", "overflow-y"].some((k) =>
            ["auto", "scroll", "overlay"].includes(overflow[k] ?? "visible"),
          ));
      const showScroll =
        t === "iframe" || (scrollable && (["html", "body"].includes(t) || !parent?.scrollable));
      const scrollParts: string[] = [];
      if (scrollable && l?.scroll && l.client) {
        const s = l.scroll,
          c = l.client;
        if (s.height > c.height)
          scrollParts.push(
            `${(Math.max(0, s.y) / (c.height || 1)).toFixed(1)} pages above, ${(Math.max(0, s.height - c.height - s.y) / (c.height || 1)).toFixed(1)} pages below`,
          );
        if (s.width > c.width)
          scrollParts.push(`horizontal ${((s.x / (s.width - c.width)) * 100).toFixed(0)}%`);
        moreAbove ||= s.y > 0;
        moreBelow ||= s.height - c.height - s.y > 0;
      }
      const n: BrowserUseNode = {
        id,
        nodeType: raw.nodeType,
        nodeName: raw.nodeName,
        value: raw.nodeValue,
        attributes: a,
        visible,
        ...(l === undefined ? {} : { rendered }),
        snapshot: l?.bounds !== null,
        bounds: l?.bounds ?? null,
        cursor: l?.styles.cursor ?? null,
        paintOrder: l?.paintOrder ?? null,
        computedStyles: l?.styles ?? null,
        scrollable,
        showScroll,
        scrollText: t === "iframe" ? "scroll" : scrollParts.join(" "),
        clickListener: listeners.has(raw.backendNodeId),
        formAssociated: frame !== null && formAssociatedTags.get(frame)?.has(t) === true,
        axRole: axNode?.role?.value ?? null,
        axProperties: (axNode?.properties ?? []).map((p) => ({
          name: p.name,
          value: p.value?.value ?? null,
        })),
        axChildIds: axNode?.childIds ?? null,
        shadowType: raw.shadowRootType ?? null,
        hiddenElements: [],
        hiddenContent: false,
        children: [],
        contentDocument: null,
      };
      viewMetadata.set(id, {
        layout: l,
        name: String(axNode?.name?.value ?? ""),
        ...(raw.frameId && frameById.has(raw.frameId)
          ? { frame: frameById.get(raw.frameId)! }
          : {}),
      });
      rawById.set(id, raw);
      nodeFrame.set(id, frame);
      selectorsById.set(id, selector);
      const childList = raw.children ?? [];
      const shadowIds = new Set(raw.shadowRoots?.map((s) => s.nodeId));
      n.children = childList
        .filter((c) => !shadowIds.has(c.nodeId))
        .map((c) => {
          const siblings = childList.filter((s) => s.nodeName === c.nodeName);
          const part =
            c.nodeType === 1
              ? `${c.nodeName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(c) + 1})` : ""}`
              : "";
          return build(
            c,
            chain,
            n,
            part
              ? (selector ? selector + (selector.endsWith("=") ? "" : " > ") : "") + part
              : selector,
            frame,
          );
        });
      for (const shadow of raw.shadowRoots ?? [])
        n.children.push(build(shadow, chain, n, selector + " >> css=", frame));
      if (raw.contentDocument) {
        const contentFrame = raw.frameId ? (frameById.get(raw.frameId) ?? null) : null;
        n.contentDocument = build(raw.contentDocument, chain, n, "", contentFrame);
      }
      return n;
    };
    const root = build(dom.root, [], null, "", owningFrame);
    type FormIntent = {
      action: string | null;
      enctype: string;
      method: string;
      noValidate: boolean;
      signature: string;
      target: string;
    };
    const formIntents = new Map<number, FormIntent>();
    const effectiveDestination = (
      frame: Frame | null | undefined,
      value: string | undefined,
      fallback: string | null = null,
    ): string | null => {
      if (value === undefined) return fallback;
      try {
        return new URL(value, baseUris.get(frame!) ?? frame?.url()).href;
      } catch {
        return value;
      }
    };
    const effectiveSubmissionDestination = (
      frame: Frame | null | undefined,
      value: string | undefined,
    ): string | null =>
      value === undefined || value.trim() === ""
        ? (frame?.url() ?? null)
        : effectiveDestination(frame, value);
    const effectiveMethod = (value: string | undefined): string => {
      const method = value?.trim().toLowerCase();
      return method === "post" || method === "dialog" ? method : "get";
    };
    const effectiveTarget = (value: string | undefined, fallback: string): string => {
      const target = (value === undefined ? fallback : value).trim();
      const keyword = target.toLowerCase();
      return ["_self", "_blank", "_parent", "_top"].includes(keyword) ? keyword : target;
    };
    const effectiveEnctype = (value: string | undefined): string => {
      const enctype = value?.trim().toLowerCase();
      return ["multipart/form-data", "text/plain"].includes(enctype ?? "")
        ? enctype!
        : "application/x-www-form-urlencoded";
    };
    const formIntent = (n: BrowserUseNode): FormIntent => {
      const frame = nodeFrame.get(n.id);
      const action = effectiveSubmissionDestination(frame, n.attributes.action);
      const method = effectiveMethod(n.attributes.method);
      const target = effectiveTarget(n.attributes.target, baseTargets.get(frame!) ?? "_self");
      const enctype = effectiveEnctype(n.attributes.enctype);
      const noValidate = n.attributes.novalidate !== undefined;
      return {
        action,
        method,
        target,
        enctype,
        noValidate,
        signature: JSON.stringify([n.id, action, method, target, enctype, noValidate]),
      };
    };
    const isSubmitter = (n: BrowserUseNode): boolean => {
      const type = n.attributes.type?.toLowerCase();
      return (
        (n.nodeName === "BUTTON" && (type === undefined || type === "submit")) ||
        (n.nodeName === "INPUT" && (type === "submit" || type === "image"))
      );
    };
    const submissionIntent = (
      n: BrowserUseNode,
      frame: Frame,
      owners: readonly FormIntent[],
    ): Array<
      [string | null, string, string, string, boolean, string | undefined, string | undefined]
    > | null => {
      if (!isSubmitter(n) || owners.length === 0) return null;
      return owners.map((owner) => [
        n.attributes.formaction === undefined
          ? owner.action
          : effectiveSubmissionDestination(frame, n.attributes.formaction),
        n.attributes.formmethod === undefined
          ? owner.method
          : effectiveMethod(n.attributes.formmethod),
        n.attributes.formtarget === undefined
          ? owner.target
          : effectiveTarget(n.attributes.formtarget, baseTargets.get(frame) ?? "_self"),
        n.attributes.formenctype === undefined
          ? owner.enctype
          : effectiveEnctype(n.attributes.formenctype),
        owner.noValidate || n.attributes.formnovalidate !== undefined,
        n.attributes.name,
        n.attributes.value,
      ]);
    };
    const collectForms = (n: BrowserUseNode): void => {
      if (n.nodeName === "FORM") formIntents.set(rawById.get(n.id)!.backendNodeId, formIntent(n));
      n.children.forEach(collectForms);
      if (n.contentDocument) collectForms(n.contentDocument);
    };
    collectForms(root);
    type LabelScope = {
      nodeByDomId: Map<string, BrowserUseNode>;
      labelsFor: Map<string, BrowserUseNode[]>;
    };
    const labelScopeFor = new Map<BrowserUseNode, LabelScope>();
    const parentByNode = new Map<BrowserUseNode, BrowserUseNode>();
    const rootScope: LabelScope = { nodeByDomId: new Map(), labelsFor: new Map() };
    const indexLabels = (
      n: BrowserUseNode,
      parent: BrowserUseNode | undefined,
      scope: LabelScope,
    ): void => {
      if (parent) parentByNode.set(n, parent);
      const ownScope =
        n !== root && (n.nodeType === 9 || n.shadowType !== null)
          ? { nodeByDomId: new Map(), labelsFor: new Map() }
          : scope;
      labelScopeFor.set(n, ownScope);
      const domId = n.attributes.id;
      if (domId && !ownScope.nodeByDomId.has(domId)) ownScope.nodeByDomId.set(domId, n);
      const controlId = n.attributes.for;
      if (n.nodeName === "LABEL" && controlId) {
        const labels = ownScope.labelsFor.get(controlId) ?? [];
        labels.push(n);
        ownScope.labelsFor.set(controlId, labels);
      }
      n.children.forEach((child) => indexLabels(child, n, ownScope));
      if (n.contentDocument) indexLabels(n.contentDocument, n, ownScope);
    };
    indexLabels(root, undefined, rootScope);
    // A visible <label for> is a positive browser-owned activation proxy for
    // its checkbox/radio. Collapse that pair onto the visible label only when
    // the native control is itself visually hidden and exactly one visible
    // label owns it. Similar names or geometry never establish this relation.
    const proxyTargets = new Map<BrowserUseNode, BrowserUseNode>();
    const proxyOwners = new Map<BrowserUseNode, BrowserUseNode>();
    const cssVisible = (n: BrowserUseNode): boolean => {
      const layout = viewMetadata.get(n.id)?.layout;
      return (
        n.nodeType === 1 &&
        renderedNodes.get(n.id) === true &&
        layout?.bounds !== null &&
        layout?.bounds !== undefined &&
        layout.bounds.width > 1 &&
        layout.bounds.height > 1 &&
        layout.styles.display !== "none" &&
        layout.styles.visibility !== "hidden" &&
        Number(layout.styles.opacity ?? "1") > 0
      );
    };
    const indexPositiveLabelProxies = (n: BrowserUseNode): void => {
      if (n.nodeName === "INPUT" && ["checkbox", "radio"].includes(n.attributes.type ?? "")) {
        const scope = labelScopeFor.get(n);
        const labels = n.attributes.id ? (scope?.labelsFor.get(n.attributes.id) ?? []) : [];
        const visibleLabels = labels.filter(cssVisible);
        if (!cssVisible(n) && visibleLabels.length === 1) {
          proxyTargets.set(visibleLabels[0]!, n);
          proxyOwners.set(n, visibleLabels[0]!);
        }
      }
      n.children.forEach(indexPositiveLabelProxies);
      if (n.contentDocument) indexPositiveLabelProxies(n.contentDocument);
    };
    indexPositiveLabelProxies(root);
    const labelText = (n: BrowserUseNode): string | null => {
      const text = (node: BrowserUseNode): string =>
        node.nodeType === 3 ? node.value : node.children.map(text).join(" ");
      const value = text(n).replace(/\s+/g, " ").trim();
      return value.length === 0 ? null : value.slice(0, 120);
    };
    const rawText = (n: BrowserUseNode): string =>
      n.nodeType === 3 ? n.value : n.children.map(rawText).join(" ");
    const visibleText = (n: BrowserUseNode, inUserAgentShadow = false): string => {
      if (n.nodeType === 3) return inUserAgentShadow ? "" : n.value;
      return n.children
        .map((child) => visibleText(child, inUserAgentShadow || n.shadowType === "user-agent"))
        .join(" ");
    };
    const labelledByText = (n: BrowserUseNode): string | null => {
      const scope = labelScopeFor.get(n);
      if (!scope) return null;
      const ids = n.attributes["aria-labelledby"]?.trim().split(/\s+/) ?? [];
      const parts = ids
        .map((id) => scope.nodeByDomId.get(id))
        .map((node) => (node ? labelText(node) : null))
        .filter((value): value is string => value !== null);
      return parts.length === 0 ? null : parts.join(" ").slice(0, 120);
    };
    const associatedLabelText = (n: BrowserUseNode): string | null => {
      const scope = labelScopeFor.get(n);
      if (!scope) return null;
      const labels = n.attributes.id ? scope.labelsFor.get(n.attributes.id) : undefined;
      const explicit = labels?.map(labelText).find((value) => value !== null);
      if (explicit) return explicit;
      let parent = parentByNode.get(n);
      while (parent && labelScopeFor.get(parent) === scope) {
        if (parent.nodeName === "LABEL") return labelText(parent);
        parent = parentByNode.get(parent);
      }
      return null;
    };
    const nativeContainerKinds = new Map([
      ["section", "section"],
      ["nav", "navigation"],
      ["form", "form"],
      ["fieldset", "fieldset"],
      ["main", "main"],
      ["aside", "aside"],
      ["article", "article"],
      ["dialog", "dialog"],
    ]);
    const ariaContainerKinds = new Map([
      ["banner", "banner"],
      ["complementary", "aside"],
      ["contentinfo", "contentinfo"],
      ["form", "form"],
      ["main", "main"],
      ["navigation", "navigation"],
      ["region", "section"],
      ["search", "search"],
      ["dialog", "dialog"],
      ["alertdialog", "dialog"],
    ]);
    const syntheticContainer = (n: BrowserUseNode): string | null => {
      let scope = labelScopeFor.get(n);
      let child = n;
      let parent = parentByNode.get(child);
      while (parent) {
        if (labelScopeFor.get(parent) !== scope) {
          if (child.shadowType?.toLowerCase() !== "open") return null;
          scope = labelScopeFor.get(parent);
        }
        const tag = parent.nodeName.toLowerCase();
        const kind =
          nativeContainerKinds.get(tag) ??
          ariaContainerKinds.get(parent.attributes.role?.toLowerCase() ?? "");
        if (kind) {
          const heading = parent.children
            .filter((child) => /^H[1-6]$/.test(child.nodeName))
            .map(labelText)
            .find((value) => value !== null);
          const label =
            parent.attributes["aria-label"]?.trim() || labelledByText(parent) || heading;
          return label ? `${kind}:${label}` : null;
        }
        child = parent;
        parent = parentByNode.get(child);
      }
      return null;
    };
    const iconLabel = (n: BrowserUseNode): string | null => {
      const find = (node: BrowserUseNode): string | null => {
        const value = node.attributes.alt ?? node.attributes.title ?? node.attributes["aria-label"];
        if (value?.trim()) return value.trim().slice(0, 120);
        for (const child of node.children) {
          const descendant = find(child);
          if (descendant) return descendant;
        }
        return null;
      };
      return n.children.map(find).find((value) => value !== null) ?? null;
    };
    const ownedLabels = new Map<string, string>();
    const ownedControl = (n: BrowserUseNode): { count: number; sole?: BrowserUseNode } => {
      if (
        n.computedStyles?.display === "none" ||
        n.computedStyles?.visibility === "hidden" ||
        Number(n.computedStyles?.opacity ?? "1") <= 0 ||
        "inert" in n.attributes ||
        "disabled" in n.attributes ||
        n.attributes["aria-disabled"] === "true" ||
        n.axProperties.some((p) => p.name === "disabled" && Boolean(p.value))
      )
        return { count: 0 };
      if (n.contentDocument) ownedControl(n.contentDocument);
      const descendants = n.children.map(ownedControl);
      const descendantCount = descendants.reduce((sum, child) => sum + child.count, 0);
      const descendantSole =
        descendantCount === 1 ? descendants.find((child) => child.count === 1)?.sole : undefined;
      const custom = n.nodeName.includes("-");
      const nativeTag =
        ["BUTTON", "SELECT", "TEXTAREA"].includes(n.nodeName) ||
        (n.nodeName === "A" && "href" in n.attributes) ||
        (n.nodeName === "INPUT" && n.attributes.type?.toLowerCase() !== "hidden");
      const explicit =
        n.clickListener ||
        [
          "onclick",
          "onmousedown",
          "onmouseup",
          "onpointerdown",
          "onpointerup",
          "onkeydown",
          "onkeyup",
        ].some((key) => key in n.attributes) ||
        [
          "button",
          "link",
          "checkbox",
          "radio",
          "combobox",
          "textbox",
          "menuitem",
          "option",
          "tab",
        ].includes(n.attributes.role ?? n.axRole ?? "");
      const self = nativeTag || explicit || (custom && browserUseInteractive(n));
      const count = descendantCount + Number(self);
      const sole = count === 1 ? (self ? n : descendantSole) : undefined;
      const label = n.attributes["aria-label"]?.trim() || n.attributes.title?.trim();
      if (custom && label && sole && !ownedLabels.has(sole.id)) ownedLabels.set(sole.id, label);
      return { count, ...(sole ? { sole } : {}) };
    };
    if (containsCustomElements) ownedControl(root);
    const visit = (n: BrowserUseNode, inClosedShadow = false, form?: FormIntent): void => {
      if (n.nodeName === "FORM") form = formIntent(n);
      if (["IFRAME", "FRAME"].includes(n.nodeName)) form = undefined;
      const raw = rawById.get(n.id)!,
        frame = nodeFrame.get(n.id)!;
      const proxyTarget = proxyTargets.get(n);
      const bound = bindings.get(raw.backendNodeId);
      const ownsAction =
        proxyTarget !== undefined ||
        (proxyOwners.get(n) === undefined &&
          (browserUseInteractive(n) ||
            (bound !== undefined && ["IFRAME", "FRAME"].includes(n.nodeName))));
      n.actionOwned = ownsAction;
      let el = bound;
      if (el && (!ownsAction || renderedNodes.get(n.id) !== true)) el = undefined;
      // Playwright selectors cannot enter closed shadow roots. Preserve their
      // nodes for display, but do not manufacture an unusable action binding.
      if (
        !el &&
        liveBackendNodeIds.has(raw.backendNodeId) &&
        frame !== null &&
        !isFrameUnbound(frame) &&
        !inClosedShadow &&
        opaqueFrames.get(frame) === false &&
        n.nodeType === 1 &&
        ownsAction
      ) {
        const l = layouts.get(raw.backendNodeId),
          cssVisible =
            !!l?.bounds &&
            l.styles.display !== "none" &&
            l.styles.visibility !== "hidden" &&
            !(Number(l.styles.opacity ?? "1") <= 0);
        if (
          (cssVisible && renderedNodes.get(n.id) === true) ||
          (n.nodeName === "INPUT" && n.attributes.type === "file")
        ) {
          const a = n.attributes,
            t = n.nodeName.toLowerCase(),
            selector = selectorsById.get(n.id)!;
          const path = frame === page.mainFrame() ? null : framePath(frame);
          el = {
            index: nextSyntheticIndex++,
            tag: t,
            type: proxyTarget?.attributes.type ?? a.type ?? null,
            id: a.id ?? null,
            name: proxyTarget?.attributes.name ?? a.name ?? null,
            placeholder: proxyTarget?.attributes.placeholder ?? a.placeholder ?? null,
            ariaLabel: proxyTarget?.attributes["aria-label"] ?? a["aria-label"] ?? null,
            role:
              proxyTarget?.attributes.role ??
              (proxyTarget === undefined
                ? (a.role ??
                  n.axRole ??
                  (["a", "button", "input", "select", "textarea"].includes(t) ? null : "generic"))
                : (proxyTarget.attributes.type ?? "button")),
            labelText: null,
            visibleText: rawText(n).trim() || null,
            selector,
            visible: true,
            inViewport: n.visible,
            inConsentWidget: false,
            href: a.href ?? null,
            title: a.title ?? null,
            value: a.value ?? null,
            frameOrigin: frame === page.mainFrame() ? null : new URL(frame.url()).origin,
            frameUrl: frame === page.mainFrame() ? null : frame.url(),
            framePath: path,
          };
        }
      }
      if (el && frame && documentLoaders.get(frame) && liveBackendNodeIds.has(raw.backendNodeId)) {
        const submitter = isSubmitter(n);
        const explicitOwner = submitter ? formOwners.get(raw.backendNodeId) : undefined;
        const owners = !submitter
          ? []
          : n.attributes.form === undefined
            ? form === undefined
              ? []
              : [form]
            : explicitOwner === undefined || explicitOwner === null
              ? []
              : [formIntents.get(explicitOwner)].filter(
                  (owner): owner is FormIntent => owner !== undefined,
                );
        el.observationIdentity = `${frameIdentity(frame)}:${documentLoaders.get(frame)}:${raw.backendNodeId}`;
        // Include destinations and form ownership even when the visible name
        // stays the same. State/value and surrounding text are not identity.
        el.observationIntent = JSON.stringify([
          ...(proxyTarget === undefined
            ? []
            : [
                "label-proxy",
                rawById.get(proxyTarget.id)?.backendNodeId,
                proxyTarget.attributes.type,
                proxyTarget.attributes.name,
              ]),
          n.nodeName,
          n.axRole,
          viewMetadata.get(n.id)?.name,
          n.attributes.type,
          n.attributes.role,
          n.attributes.name,
          n.attributes["aria-label"],
          n.attributes["aria-labelledby"],
          n.attributes.title,
          n.attributes.placeholder,
          n.attributes.href,
          effectiveDestination(frame, n.attributes.href),
          ["A", "AREA"].includes(n.nodeName)
            ? effectiveTarget(n.attributes.target, baseTargets.get(frame) ?? "_self")
            : null,
          ["A", "AREA"].includes(n.nodeName) ? n.attributes.download : null,
          submitter ? n.attributes.form : null,
          owners.map((owner) => owner.signature),
          submissionIntent(n, frame, owners),
          n.attributes.autocomplete,
          n.attributes["data-field-role"],
        ]);
        if (submitter && n.attributes.form !== undefined && !formOwners.has(raw.backendNodeId)) {
          delete el.observationIdentity;
          delete el.observationIntent;
        }
      }
      if (el) {
        el.inViewport = n.visible;
        const semanticNode = proxyTarget ?? n;
        if (proxyTarget !== undefined) {
          el.type = proxyTarget.attributes.type ?? null;
          el.role = proxyTarget.attributes.role ?? proxyTarget.attributes.type ?? "button";
          el.checked = proxyTarget.attributes.checked === "true";
          el.disabled =
            "disabled" in proxyTarget.attributes ||
            proxyTarget.attributes["aria-disabled"] === "true";
          el.required =
            "required" in proxyTarget.attributes ||
            proxyTarget.attributes["aria-required"] === "true";
        }
        const ownedLabel = ownedLabels.get(n.id);
        if (ownedLabel && !el.ariaLabel && !n.attributes["aria-labelledby"]) {
          el.ariaLabel = ownedLabel;
          n.attributes.ax_name ??= ownedLabel;
        }
        el.compactNames = {
          ariaLabel: semanticNode.attributes["aria-label"]?.trim() || ownedLabel || null,
          labelledByText: labelledByText(semanticNode),
          accessibleName:
            viewMetadata.get(semanticNode.id)?.name.trim() ||
            (proxyTarget === undefined ? null : labelText(n)),
          labelText:
            proxyTarget === undefined ? associatedLabelText(n) : associatedLabelText(proxyTarget),
          visibleText: visibleText(n).trim() || null,
          alt: semanticNode.attributes.alt ?? null,
          iconLabel: iconLabel(n),
          title: semanticNode.attributes.title ?? null,
          placeholder: semanticNode.attributes.placeholder ?? null,
          name: semanticNode.attributes.name ?? null,
          value: semanticNode.attributes.value ?? null,
          container: syntheticContainer(n),
        };
        if (!elements.includes(el)) elements.push(el);
        nodeElements.set(n.id, el);
      }
      const closed = inClosedShadow || n.shadowType?.toLowerCase() === "closed";
      n.children.forEach((child) => visit(child, closed, child.shadowType ? undefined : form));
      if (n.contentDocument) visit(n.contentDocument, closed, undefined);
    };
    visit(root);
    return root;
  };
  try {
    const root = await capture(cdp, "main:", page.mainFrame());
    const visited = new Set<Frame>([page.mainFrame()]);
    const attachFrames = async (n: BrowserUseNode, depth = 0): Promise<void> => {
      if (
        ["IFRAME", "FRAME"].includes(n.nodeName) &&
        !n.contentDocument &&
        n.visible &&
        n.bounds &&
        n.bounds.width >= 10 &&
        n.bounds.height >= 10 &&
        depth < 5 &&
        visited.size <= 100
      ) {
        const frame = viewMetadata.get(n.id)?.frame;
        if (frame && !frame.isDetached() && !visited.has(frame)) {
          visited.add(frame);
          try {
            const child = await page.context().newCDPSession(frame);
            sessions.push(child);
            n.contentDocument = await capture(child, `${framePath(frame)}:`, frame);
          } catch {
            n.contentDocument = null;
          }
        }
      }
      for (const c of n.children) await attachFrames(c, depth);
      if (n.contentDocument) await attachFrames(n.contentDocument, depth + 1);
    };
    await attachFrames(root);
    const hints = async (n: BrowserUseNode): Promise<void> => {
      if (["IFRAME", "FRAME"].includes(n.nodeName) && n.contentDocument) {
        const viewportHeight = viewMetadata.get(n.id)?.layout?.client?.height ?? 0;
        let anyHidden = false;
        const isHidden = (c: BrowserUseNode): boolean => {
          const l = viewMetadata.get(c.id)?.layout;
          return (
            !c.visible &&
            !!l?.bounds &&
            l.styles.display !== "none" &&
            l.styles.visibility !== "hidden" &&
            !(Number(l.styles.opacity ?? "1") <= 0)
          );
        };
        const actionableDescendants = new Map<BrowserUseNode, boolean>();
        const actionableDescendant = (c: BrowserUseNode): boolean => {
          if (!actionableDescendants.has(c))
            actionableDescendants.set(
              c,
              c.children.some(
                (child) => browserUseInteractive(child) || actionableDescendant(child),
              ),
            );
          return actionableDescendants.get(c)!;
        };
        const localContext = (c: BrowserUseNode): string | null => {
          if (!browserUseLocalContextContainer(c, actionableDescendant(c))) return null;
          return browserUseBoundedContextText(c, iframeHintContextMaxChars);
        };
        const headingContext = (c: BrowserUseNode): string | null =>
          /^H[1-6]$/.test(c.nodeName)
            ? browserUseBoundedContextText(c, iframeHintContextMaxChars)
            : null;
        const collect = (c: BrowserUseNode, context = ""): string | null => {
          const meta = viewMetadata.get(c.id);
          const hidden = isHidden(c);
          anyHidden ||= hidden;
          if (hidden && browserUseInteractive(c))
            n.hiddenElements.push({
              tag: c.nodeName.toLowerCase(),
              interactive: true,
              text:
                meta?.name ||
                c.attributes.placeholder ||
                c.attributes.title ||
                c.attributes["aria-label"] ||
                context ||
                "(no label)",
              pages: viewportHeight > 0 ? (c.bounds!.y / viewportHeight).toFixed(1) : 0,
            });
          const directHeading = headingContext(c);
          const nearby = localContext(c) || directHeading || context;
          const nestedHeading = browserUseOrderedHeadingContext(
            c.children,
            nearby,
            headingContext,
            collect,
          );
          return directHeading || nestedHeading;
        };
        collect(n.contentDocument);
        n.hiddenElements.sort((a, b) => Number(a.pages) - Number(b.pages));
        n.hiddenElements = n.hiddenElements.slice(0, 10);
        n.hiddenContent = n.hiddenElements.length === 0 && anyHidden;
      }
      for (const child of n.children) await hints(child);
      if (n.contentDocument) await hints(n.contentDocument);
    };
    await hints(root);
    const scroll = await page.evaluate(() => ({
      above: window.scrollY > 0,
      below: document.documentElement.scrollHeight - window.innerHeight - window.scrollY > 0,
    }));
    const frameUrls = page
      .frames()
      .map((frame) => frame.url())
      .sort();
    const dynamics = [
      browserUseDynamicsSignature(root),
      `frames\u001f${frameUrls.join("\u001f")}`,
    ].join("\u0000");
    return {
      root,
      elements,
      nodeElements,
      moreAbove: moreAbove || scroll.above,
      moreBelow: moreBelow || scroll.below,
      dynamics,
    };
  } finally {
    await Promise.all(sessions.map((s) => s.detach().catch(() => undefined)));
  }
}
