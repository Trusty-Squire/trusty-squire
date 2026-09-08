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
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}
import type { InteractiveElement } from "./browser.js";
import {
  browserUseBoundedContextText,
  browserUseInteractive,
  browserUseLocalContextContainer,
  browserUseOrderedHeadingContext,
  type BrowserUseNode,
  type DOMBounds,
} from "./browser-use-serializer.js";

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
    const bindFrames = (tree: FrameTree, frame: Frame): void => {
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
    for (const frameId of frameIds) {
      const frame = frameById.get(frameId);
      if (!frame) continue;
      if (isFrameUnbound(frame)) continue;
      const path = framePathById.get(frameId)!;
      const candidates = inventory.filter((e) => (e.framePath ?? null) === path);
      const frameBindings = new Map<number, InteractiveElement>();
      const frameListeners = new Set<number>();
      try {
        // Read the registry in the page's own realm: isolated-world constructors
        // do not expose the site's form-associated custom-element definitions.
        formAssociatedTags.set(
          frame,
          new Set(
            await frame.evaluate(() => {
              const names = new Set<string>();
              const roots: Array<Document | ShadowRoot> = [document];
              for (let i = 0; i < roots.length; i++)
                for (const el of Array.from(roots[i]!.querySelectorAll("*"))) {
                  const name = el.localName;
                  if (
                    name.includes("-") &&
                    (
                      customElements.get(name) as
                        | (CustomElementConstructor & { formAssociated?: boolean })
                        | undefined
                    )?.formAssociated === true
                  )
                    names.add(name);
                  if (el.shadowRoot) roots.push(el.shadowRoot);
                }
              return [...names];
            }),
          ),
        );
        const context = await client.send("Page.createIsolatedWorld", {
          frameId,
          worldName: "trusty-squire-observation",
        });
        // Return exact DOM objects. describeNode binds existing action selectors to
        // backend identities without guessing from tag names or accessible names.
        const selectors = candidates.map((e) => e.selector);
        const objects = await client.send("Runtime.evaluate", {
          expression: `(() => { const roots=[document]; for(let i=0;i<roots.length;i++) for(const e of roots[i].querySelectorAll('*')) if(e.shadowRoot) roots.push(e.shadowRoot); return ${JSON.stringify(selectors)}.map(s => { const p=s.split(' >> nth='); const found=roots.flatMap(r=>{try{return [...r.querySelectorAll(p[0])]}catch{return []}}); return found[Number(p[1]||0)] || null; }); })()`,
          contextId: context.executionContextId,
          objectGroup: "ts-observation",
        });
        if (objects.result.objectId) {
          const props = await client.send("Runtime.getProperties", {
            objectId: objects.result.objectId,
            ownProperties: true,
          });
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
        // The console helper in an isolated world only sees that world's
        // listeners. DOMDebugger with pierce reports the page's real handlers,
        // including those on custom elements inside shadow roots.
        const documentObject = await client.send("Runtime.evaluate", {
          expression: "document",
          contextId: context.executionContextId,
          objectGroup: "ts-observation",
        });
        if (documentObject.result.objectId) {
          const events = await client.send("DOMDebugger.getEventListeners", {
            objectId: documentObject.result.objectId,
            depth: -1,
            pierce: true,
          });
          for (const listener of events.listeners) {
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
            ) {
              frameListeners.add(listener.backendNodeId);
            }
          }
        }
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
      let visible =
        !!l?.bounds &&
        l.styles.display !== "none" &&
        l.styles.visibility !== "hidden" &&
        !(Number(l.styles.opacity ?? "1") <= 0);
      const chain = [...parents];
      if ((t === "html" || t === "iframe" || t === "frame") && l) chain.push({ raw, layout: l });
      if (l?.bounds) {
        let x = l.bounds.x,
          y = l.bounds.y;
        for (const p of [...chain].reverse()) {
          if (p.raw === raw) continue;
          if (["IFRAME", "FRAME"].includes(p.raw.nodeName) && p.layout.bounds) {
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
    // A labelled custom wrapper can own a native control without being a click
    // target itself. Bind its label only to a sole descendant, never to a grid
    // of competing buttons or to the wrapper's bounding box.
    const ownedLabels = new Map<string, string>();
    const ownedControl = (n: BrowserUseNode): { count: number; sole?: BrowserUseNode } => {
      if (
        n.computedStyles?.display === "none" ||
        n.computedStyles?.visibility === "hidden" ||
        Number(n.computedStyles?.opacity ?? "1") <= 0 ||
        "inert" in n.attributes
      )
        return { count: 0 };
      if (n.contentDocument) ownedControl(n.contentDocument);
      const descendants = n.children.map(ownedControl);
      const count = descendants.reduce((sum, child) => sum + child.count, 0);
      const sole = count === 1 ? descendants.find((child) => child.count === 1)?.sole : undefined;
      const custom = n.nodeName.includes("-");
      const label = n.attributes["aria-label"]?.trim() || n.attributes.title?.trim();
      if (custom && label && sole && !ownedLabels.has(sole.id)) ownedLabels.set(sole.id, label);
      const native = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(n.nodeName);
      const explicit =
        n.clickListener ||
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
      if (native || ((explicit || (custom && browserUseInteractive(n))) && count === 0))
        return { count: 1, sole: n };
      return { count, ...(sole ? { sole } : {}) };
    };
    ownedControl(root);
    const visit = (n: BrowserUseNode, inClosedShadow = false): void => {
      const raw = rawById.get(n.id)!,
        frame = nodeFrame.get(n.id)!;
      let el = bindings.get(raw.backendNodeId);
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
        (browserUseInteractive(n) || n.scrollable)
      ) {
        const l = layouts.get(raw.backendNodeId),
          cssVisible =
            !!l?.bounds &&
            l.styles.display !== "none" &&
            l.styles.visibility !== "hidden" &&
            !(Number(l.styles.opacity ?? "1") <= 0);
        if (cssVisible || (n.nodeName === "INPUT" && n.attributes.type === "file")) {
          const a = n.attributes,
            t = n.nodeName.toLowerCase(),
            selector = selectorsById.get(n.id)!;
          const path = frame === page.mainFrame() ? null : framePath(frame);
          const text = (x: BrowserUseNode): string =>
            x.nodeType === 3 ? x.value : x.children.map(text).join(" ");
          el = {
            index: nextSyntheticIndex++,
            tag: t,
            type: a.type ?? null,
            id: a.id ?? null,
            name: a.name ?? null,
            placeholder: a.placeholder ?? null,
            ariaLabel: a["aria-label"] ?? null,
            role:
              a.role ??
              (["a", "button", "input", "select", "textarea"].includes(t) ? null : "button"),
            labelText: null,
            visibleText: text(n).trim() || null,
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
      if (el) {
        const ownedLabel = ownedLabels.get(n.id);
        if (ownedLabel && !el.ariaLabel && !n.attributes["aria-labelledby"]) {
          el.ariaLabel = ownedLabel;
          n.attributes.ax_name ??= ownedLabel;
        }
        if (!elements.includes(el)) elements.push(el);
        nodeElements.set(n.id, el);
      }
      const closed = inClosedShadow || n.shadowType?.toLowerCase() === "closed";
      n.children.forEach((child) => visit(child, closed));
      if (n.contentDocument) visit(n.contentDocument);
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
    return {
      root,
      elements,
      nodeElements,
      moreAbove: moreAbove || scroll.above,
      moreBelow: moreBelow || scroll.below,
    };
  } finally {
    await Promise.all(sessions.map((s) => s.detach().catch(() => undefined)));
  }
}
