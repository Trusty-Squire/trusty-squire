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
  browserUseInteractive,
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
interface Layout {
  bounds: DOMBounds | null;
  scroll: DOMBounds | null;
  client: DOMBounds | null;
  styles: Record<string, string>;
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
  v && v.length >= 4
    ? { x: v[0]!, y: v[1]!, width: v[2]!, height: v[3]! }
    : null;
const pathKey = (frame: string | null | undefined, selector: string): string =>
  `${frame ?? ""}\0${selector}`;

/** Capture the three canonical Chrome trees. No page mutation and no Python runtime. */
export async function captureBrowserUseDOM(
  page: Page,
  existing: readonly InteractiveElement[],
  framePath: (frame: Frame) => string | null,
): Promise<BrowserUseCapture> {
  const elements = existing.filter((e) => e.frameOpaque !== true).map((e) => ({ ...e }));
  const nodeElements = new Map<string, InteractiveElement>();
  const opaqueFrames = new Map<Frame, boolean>();
  const viewMetadata = new Map<
    string,
    { layout: Layout | undefined; name: string; frame?: Frame }
  >();
  let moreAbove = false,
    moreBelow = false;
  const cdp = await page.context().newCDPSession(page);
  const sessions: CDPSession[] = [cdp];
  const existingBySelector = new Map(elements.map((e) => [pathKey(e.framePath, e.selector), e]));
  const sandboxIsOpaque = (sandbox: string | undefined): boolean =>
    sandbox !== undefined && !sandbox.toLowerCase().split(/\s+/).includes("allow-same-origin");
  const frameUrlIsOpaque = (frame: Frame): boolean => {
    if (frame === page.mainFrame()) return false;
    const url = frame.url();
    if (url === "" || url === "about:blank" || url === "about:srcdoc") return true;
    try {
      return new URL(url).origin === "null";
    } catch {
      return true;
    }
  };
  const capture = async (
    client: CDPSession,
    prefix: string,
    owningFrame: Frame,
    owningFrameOpaque = false,
  ): Promise<BrowserUseNode> => {
    const [dom, snapshot, ax, frames] = await Promise.all([
      client.send("DOM.getDocument", { depth: -1, pierce: true }),
      client.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLES, includeDOMRects: true }),
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
    const bindFrames = (tree: FrameTree, frame: Frame): void => {
      frameIds.push(tree.frame.id);
      frameById.set(tree.frame.id, frame);
      const available = new Set(frame.childFrames());
      for (const child of tree.childFrames ?? []) {
        const matched = [...available].find((candidate) => candidate.url() === child.frame.url);
        if (matched) {
          available.delete(matched);
          bindFrames(child, matched);
        }
      }
    };
    bindFrames(frames.frameTree, owningFrame);
    for (const frameId of frameIds.slice(1)) {
      const tree = await client.send("Accessibility.getFullAXTree", { frameId });
      for (const n of tree.nodes)
        if (n.backendDOMNodeId !== undefined) axs.set(n.backendDOMNodeId, n);
    }
    const listeners = new Set<number>();
    const bindings = new Map<number, InteractiveElement>();
    for (const frameId of frameIds) {
      const context = await client.send("Page.createIsolatedWorld", {
        frameId,
        worldName: "trusty-squire-observation",
      });
      const frame = frameById.get(frameId) ?? owningFrame;
      const path = frame === page.mainFrame() ? null : framePath(frame);
      const candidates = elements.filter((e) => (e.framePath ?? null) === path);
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
              if (el) bindings.set(d.node.backendNodeId, el);
            }),
          );
      }
      const clickObjects = await client.send("Runtime.evaluate", {
        expression: `(() => { if(typeof getEventListeners!=='function')return null; const all=document.querySelectorAll('*'); if(all.length>10000)return null; const found=[]; for(const el of all){const l=getEventListeners(el);if(l.click||l.mousedown||l.mouseup||l.pointerdown||l.pointerup){found.push(el);if(found.length>100)return null;}} return found;})()`,
        contextId: context.executionContextId,
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
              const d = await client.send("DOM.describeNode", { objectId: p.value!.objectId! });
              listeners.add(d.node.backendNodeId);
            }),
          );
      }
    }
    await client.send("Runtime.releaseObjectGroup", { objectGroup: "ts-observation" });
    const rawById = new Map<string, RawNode>();
    const nodeFrame = new Map<string, Frame>();
    const selectorsById = new Map<string, string>();
    opaqueFrames.set(owningFrame, owningFrameOpaque || frameUrlIsOpaque(owningFrame));
    const build = (
      raw: RawNode,
      parents: Array<{ raw: RawNode; layout: Layout }>,
      parent: BrowserUseNode | null,
      selector: string,
      frame: Frame,
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
        snapshot: !!l,
        bounds: l?.bounds ?? null,
        cursor: l?.styles.cursor ?? null,
        scrollable,
        showScroll,
        scrollText: t === "iframe" ? "scroll" : scrollParts.join(" "),
        clickListener: listeners.has(raw.backendNodeId),
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
        const contentFrame = frameById.get(raw.frameId ?? "") ?? frame;
        opaqueFrames.set(
          contentFrame,
          (opaqueFrames.get(frame) ?? frameUrlIsOpaque(frame)) ||
            sandboxIsOpaque(a.sandbox) ||
            frameUrlIsOpaque(contentFrame),
        );
        n.contentDocument = build(
          raw.contentDocument,
          chain,
          n,
          "",
          contentFrame,
        );
      }
      return n;
    };
    const root = build(dom.root, [], null, "", owningFrame);
    const visit = (n: BrowserUseNode, inClosedShadow = false): void => {
      const raw = rawById.get(n.id)!,
        frame = nodeFrame.get(n.id)!;
      let el = bindings.get(raw.backendNodeId);
      // Playwright selectors cannot enter closed shadow roots. Preserve their
      // nodes for display, but do not manufacture an unusable action binding.
      if (
        !el &&
        !inClosedShadow &&
        opaqueFrames.get(frame) !== true &&
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
          el = existingBySelector.get(pathKey(path, selector));
          if (!el) {
            const text = (x: BrowserUseNode): string =>
              x.nodeType === 3 ? x.value : x.children.map(text).join(" ");
            el = {
              index: elements.length,
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
            elements.push(el);
            existingBySelector.set(pathKey(path, selector), el);
          }
        }
      }
      if (el) nodeElements.set(n.id, el);
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
          const child = await page.context().newCDPSession(frame);
          sessions.push(child);
          n.contentDocument = await capture(
            child,
            `${framePath(frame)}:`,
            frame,
            (opaqueFrames.get(frame) ?? frameUrlIsOpaque(frame)) ||
              sandboxIsOpaque(n.attributes.sandbox) ||
              frameUrlIsOpaque(frame),
          );
        }
      }
      for (const c of n.children) await attachFrames(c, depth);
      if (n.contentDocument) await attachFrames(n.contentDocument, depth + 1);
    };
    await attachFrames(root);
    const hints = (n: BrowserUseNode): void => {
      if (["IFRAME", "FRAME"].includes(n.nodeName) && n.contentDocument) {
        const viewportHeight = viewMetadata.get(n.id)?.layout?.client?.height ?? 0;
        let anyHidden = false;
        const collect = (c: BrowserUseNode): void => {
          const meta = viewMetadata.get(c.id),
            l = meta?.layout;
          const hidden =
            !c.visible &&
            !!l?.bounds &&
            l.styles.display !== "none" &&
            l.styles.visibility !== "hidden" &&
            !(Number(l.styles.opacity ?? "1") <= 0);
          anyHidden ||= hidden;
          if (hidden && browserUseInteractive(c))
            n.hiddenElements.push({
              tag: c.nodeName.toLowerCase(),
              text: (
                meta?.name ||
                c.attributes.placeholder ||
                c.attributes.title ||
                c.attributes["aria-label"] ||
                "(no label)"
              ),
              pages: viewportHeight > 0 ? (c.bounds!.y / viewportHeight).toFixed(1) : 0,
            });
          c.children.forEach(collect);
        };
        collect(n.contentDocument);
        n.hiddenElements.sort((a, b) => Number(a.pages) - Number(b.pages));
        n.hiddenElements = n.hiddenElements.slice(0, 10);
        n.hiddenContent = n.hiddenElements.length === 0 && anyHidden;
      }
      n.children.forEach(hints);
      if (n.contentDocument) hints(n.contentDocument);
    };
    hints(root);
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
