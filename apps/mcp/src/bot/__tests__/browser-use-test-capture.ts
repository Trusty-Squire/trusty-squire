import type { InteractiveElement } from "../browser.js";
import type { BrowserUseCapture } from "../browser-use-capture.js";
import type { BrowserUseNode } from "../browser-use-serializer.js";
/** State-machine double only; real CDP behavior is covered by observation-prose.test. */
export function mockBrowserUseCapture(
  elements: InteractiveElement[],
  text: readonly string[] = [],
): BrowserUseCapture {
  const node = (id: string, over: Partial<BrowserUseNode>): BrowserUseNode => ({
    id,
    nodeType: 1,
    nodeName: "DIV",
    value: "",
    attributes: {},
    visible: true,
    snapshot: true,
    bounds: { x: 0, y: 0, width: 500, height: 30 },
    cursor: null,
    scrollable: false,
    showScroll: false,
    scrollText: "",
    clickListener: false,
    axRole: null,
    axProperties: [],
    axChildIds: null,
    shadowType: null,
    hiddenElements: [],
    hiddenContent: false,
    children: [],
    contentDocument: null,
    ...over,
  });
  const nodeElements = new Map<string, InteractiveElement>();
  const children = elements.map((el, i) => {
    const attributes: Record<string, string> = {};
    for (const [name, value] of [
      ["id", el.id],
      ["name", el.name],
      ["type", el.type],
      ["role", el.role],
      ["aria-label", el.ariaLabel],
      ["placeholder", el.placeholder],
      ["value", el.value],
    ] as const)
      if (value !== null && value !== undefined) attributes[name] = value;
    const visible = el.visible && el.inViewport;
    const n = node(String(i), {
      nodeName: el.tag.toUpperCase(),
      attributes,
      visible,
      clickListener: true,
      children: el.visibleText
        ? [node(`text${i}`, { nodeType: 3, value: el.visibleText, visible })]
        : [],
      axProperties: [...(el.disabled ? [{ name: "disabled", value: true }] : [])],
    });
    nodeElements.set(n.id, el);
    return n;
  });
  return {
    root: node("root", {
      nodeName: "HTML",
      children: [...text.map((value, i) => node(`prose${i}`, { nodeType: 3, value })), ...children],
    }),
    elements,
    nodeElements,
    moreAbove: false,
    moreBelow: elements.some((e) => !e.inViewport),
  };
}
