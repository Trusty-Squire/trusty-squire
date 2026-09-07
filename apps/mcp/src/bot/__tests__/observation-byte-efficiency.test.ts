import { describe, expect, it } from "vitest";
import {
  browserUseBoundedContextText,
  serializeBrowserUseDOM,
  type BrowserUseNode,
} from "../browser-use-serializer.js";
import { StableObservationRefs } from "../compact-observation-v2.js";
let sequence = 0;
function node(name: string, props: Partial<BrowserUseNode> = {}): BrowserUseNode {
  return {
    id: String(++sequence),
    nodeType: name === "#text" ? 3 : 1,
    nodeName: name,
    value: "",
    attributes: {},
    visible: true,
    snapshot: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    cursor: null,
    scrollable: false,
    showScroll: false,
    scrollText: "",
    clickListener: false,
    axRole: null,
    axProperties: [],
    axChildIds: [],
    shadowType: null,
    hiddenElements: [],
    hiddenContent: false,
    children: [],
    contentDocument: null,
    ...props,
  };
}
const text = (value: string, props: Partial<BrowserUseNode> = {}) =>
  node("#text", { value, ...props });
const opaque = { "background-color": "rgb(255, 255, 255)", opacity: "1" };
const transparent = { "background-color": "rgba(0, 0, 0, 0)", opacity: "1" };
describe("observation byte efficiency", () => {
  it("ports full union coverage, equal-order batching, opacity and document isolation", () => {
    const covered = text("Covered copy", { paintOrder: 1, computedStyles: transparent });
    const left = node("DIV", {
      paintOrder: 2,
      computedStyles: opaque,
      bounds: { x: 0, y: 0, width: 50, height: 100 },
    });
    const right = node("DIV", {
      paintOrder: 2,
      computedStyles: opaque,
      bounds: { x: 50, y: 0, width: 50, height: 100 },
    });
    const root = node("BODY", { children: [covered, left, right] });
    expect(serializeBrowserUseDOM(root).dom).not.toContain("Covered copy");
    right.bounds!.width = 49;
    expect(serializeBrowserUseDOM(root).dom).toContain("Covered copy");
    right.bounds!.width = 50;
    right.computedStyles = { ...opaque, opacity: "0.79" };
    expect(serializeBrowserUseDOM(root).dom).toContain("Covered copy");
    right.computedStyles = { ...opaque, opacity: "0.8" };
    expect(serializeBrowserUseDOM(root).dom).not.toContain("Covered copy");
    right.computedStyles = transparent;
    expect(serializeBrowserUseDOM(root).dom).toContain("Covered copy");
    right.computedStyles = opaque;
    covered.paintOrder = 2;
    expect(serializeBrowserUseDOM(root).dom).toContain("Covered copy");
    covered.paintOrder = 1;
    root.children = [
      node("IFRAME", { contentDocument: node("HTML", { children: [covered] }) }),
      left,
      right,
    ];
    expect(serializeBrowserUseDOM(root).dom).toContain("Covered copy");
  });
  it("collapses consecutive non-actionable cards but preserves meaningful text differences and sibling boundaries", () => {
    const card = (copy: string) =>
      node("DIV", {
        attributes: { class: "animated", style: `transform: translateX(${sequence}px)` },
        children: [node("SPAN", { children: [text(copy)] })],
      });
    const root = node("BODY", {
      children: [
        card("PR #846 / Cart totals"),
        card("PR #846  / Cart totals"),
        card("PR #846 / Cart totals"),
        card("PR #847 / Cart totals"),
        card("PR #846 / Cart totals"),
      ],
    });
    const result = serializeBrowserUseDOM(root);
    expect(result.dom).toBe(
      "PR #846 / Cart totals [repeated ×3]\nPR #847 / Cart totals\nPR #846 / Cart totals",
    );
    expect(result.refs).toEqual([]);
  });
  it("preserves every interactive control through coverage, repeated cards and empty labels", () => {
    const controls = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "SVG", "G", "PATH", "SPAN"].map(
      (name) =>
        node(name, {
          paintOrder: 1,
          computedStyles: transparent,
          attributes: name === "INPUT" ? { type: "text" } : {},
          clickListener: ["SVG", "G", "PATH", "SPAN"].includes(name),
        }),
    );
    const root = node("BODY", {
      children: [
        ...controls.map((control) => node("DIV", { children: [control] })),
        node("DIV", { paintOrder: 2, computedStyles: opaque }),
        node("SVG"),
        node("SPAN"),
      ],
    });
    const refs = new StableObservationRefs();
    const result = serializeBrowserUseDOM(root, { ref: (n) => refs.get("doc", n.id) });
    expect(result.refs).toHaveLength(controls.length);
    for (const control of controls)
      expect(result.dom).toContain(
        `[${refs.get("doc", control.id)}]<${control.nodeName.toLowerCase()}`,
      );
    expect(result.dom).not.toContain("repeated");
    expect(result.dom.match(/<svg/g)).toHaveLength(1);
    const nested = node("SVG", { children: [node("G", { clickListener: true })] });
    expect(serializeBrowserUseDOM(nested).dom).toContain("<g");
    nested.children = [node("G", { children: [node("PATH", { clickListener: true })] })];
    expect(serializeBrowserUseDOM(nested).dom).toContain("<path");
  });
  it("omits only explicitly non-interactive unlabelled iframe hints", () => {
    const root = node("IFRAME", {
      hiddenElements: [
        { tag: "span", text: "(no label)", pages: 1, interactive: false },
        { tag: "svg", text: "", pages: 1, interactive: false },
        { tag: "button", text: "(no label)", pages: 1, interactive: true },
        { tag: "span", text: "Support", pages: 1, interactive: false },
      ],
    });
    const dom = serializeBrowserUseDOM(root).dom;
    expect(dom).not.toContain('<span> "(no label)"');
    expect(dom).not.toContain("<svg>");
    expect(dom).toContain('<button> "(no label)"');
    expect(dom).toContain('<span> "Support"');
    expect(dom).toContain("2 more elements");
  });
  it("coalesces highlighted code without losing spaces, punctuation, or embedded actions", () => {
    const source = "const key = await client.create({\n  type: 'mandate_signing'\n});";
    const pre = node("PRE", {
      children: source
        .split(/(\s+|[(){};])/)
        .filter(Boolean)
        .map((value) =>
          node("SPAN", {
            attributes: { class: "token" },
            bounds: { x: 0, y: 0, width: 20, height: 20 },
            children: [text(value)],
          }),
        ),
    });
    const output = serializeBrowserUseDOM(pre);
    expect(output.dom).toBe(`<pre> ${JSON.stringify(source)}`);
    expect(output.dom.split("\n")).toHaveLength(1);
    expect(output.refs).toEqual([]);
    const copy = node("BUTTON", { children: [text("Copy sample")] });
    pre.children.push(copy);
    const withCopy = serializeBrowserUseDOM(pre);
    expect(withCopy.dom).toContain(`<pre> ${JSON.stringify(source + "Copy sample")}`);
    expect(withCopy.dom).toContain(`[${copy.id}]<button`);
    expect(withCopy.dom).toContain("Copy sample");
    expect(withCopy.refs).toContain(copy.id);
  });
  it("preserves exact single-character action labels in and outside code", () => {
    for (const label of ["+", " ", "{"]) {
      const button = node("BUTTON", { children: [text(label)] });
      const dom = serializeBrowserUseDOM(button).dom;
      expect(dom).toContain(`[${button.id}]<button`);
      expect(dom).toContain(`\n\t${label}`);
    }
    const action = node("BUTTON", { children: [text("{")] });
    const code = serializeBrowserUseDOM(node("PRE", { children: [action] }));
    expect(code.dom).toContain(`<pre> ${JSON.stringify("{")}`);
    expect(code.dom).toContain(`[${action.id}]<button`);
    expect(code.dom).toContain("\n\t\t{");
    expect(code.refs).toContain(action.id);
  });
  it("keeps code visible through its opaque wrapper while suppressing externally occluded code", () => {
    const source = "const mandate = await sign();";
    const highlighted = () =>
      node("PRE", {
        paintOrder: 1,
        children: [
          node("CODE", {
            paintOrder: 2,
            computedStyles: opaque,
            children: [text(source)],
          }),
        ],
      });
    const selfPainted = highlighted();
    expect(serializeBrowserUseDOM(selfPainted).dom).toBe(`<pre> ${JSON.stringify(source)}`);
    const externallyCovered = node("BODY", {
      children: [highlighted(), node("DIV", { paintOrder: 3, computedStyles: opaque })],
    });
    expect(serializeBrowserUseDOM(externallyCovered).dom).not.toContain(source);
  });
  it("deduplicates only repeated bindings, retaining every distinct unlabelled checkbox", () => {
    const checkbox = (id: string) =>
      node("INPUT", { id, attributes: { type: "checkbox", value: "on" } });
    const originals = Array.from({ length: 12 }, (_, index) => checkbox(String(index)));
    const root = node("BODY", { children: [...originals, ...originals.map((c) => ({ ...c }))] });
    const result = serializeBrowserUseDOM(root, { ref: (n) => `@e:${n.id}` });
    expect(result.refs).toHaveLength(12);
    expect(result.dom.match(/<input /g)).toHaveLength(12);
    for (const original of originals) expect(result.dom).toContain(`[@e:${original.id}]<input`);
    root.children = Array.from({ length: 24 }, (_, index) => checkbox(String(index)));
    expect(serializeBrowserUseDOM(root).dom.match(/<input /g)).toHaveLength(24);
  });
  it("gives distinct unlabelled table controls their own row context", () => {
    const rows = ["Mail service key", "Build service key"].map((value) =>
      node("TR", {
        children: [
          node("TD", {
            children: [node("INPUT", { attributes: { type: "checkbox", value: "on" } })],
          }),
          node("TD", { children: [text(value)] }),
        ],
      }),
    );
    const result = serializeBrowserUseDOM(node("TABLE", { children: rows }));
    expect(result.dom).toContain("context=Mail service key");
    expect(result.dom).toContain("context=Build service key");
    expect(result.dom.match(/<input /g)).toHaveLength(2);
  });
  it("uses only bounded local generic containers as unlabelled form context", () => {
    const compact = node("DIV", {
      children: [
        node("INPUT", { attributes: { type: "checkbox" } }),
        node("SPAN", { children: [text("Marketing emails")] }),
      ],
    });
    expect(serializeBrowserUseDOM(compact).dom).toContain("context=Marketing emails");
    const actionableWrapper = node("DIV", {
      children: [text("Marketing emails"), node("SPAN", { children: [node("BUTTON")] })],
    });
    expect(serializeBrowserUseDOM(actionableWrapper).dom).toContain("context=Marketing emails");
    const broad = node("DIV", {
      children: [
        node("INPUT", { attributes: { type: "checkbox" } }),
        node("SPAN", { children: [text("Announcement ".repeat(20))] }),
      ],
    });
    const inputLine = serializeBrowserUseDOM(broad)
      .dom.split("\n")
      .find((line) => line.includes("<input"));
    expect(inputLine).not.toContain("context=");
    const wrapped = node("DIV", {
      children: [
        node("DIV", {
          children: [
            node("LABEL", {
              children: [
                node("SPAN", { children: [node("INPUT", { attributes: { type: "checkbox" } })] }),
              ],
            }),
          ],
        }),
        node("SPAN", { children: [text("Marketing emails")] }),
      ],
    });
    expect(serializeBrowserUseDOM(wrapped).dom).toContain("context=Marketing emails");
    const nestedHeading = node("SECTION", {
      children: [
        node("HEADER", { children: [node("H2", { children: [text("Billing")] })] }),
        node("DIV", { children: [node("SPAN", { children: [node("BUTTON")] })] }),
      ],
    });
    expect(serializeBrowserUseDOM(nestedHeading).dom).toContain("context=Billing");
  });
  it("rejects ineligible and whitespace-only context before unbounded collection", () => {
    const whitespace = text(" ");
    let reads = 0;
    Object.defineProperty(whitespace, "value", {
      get: () => {
        if (++reads > 1) throw new Error("ineligible context was collected");
        return " ".repeat(121);
      },
    });
    const button = node("BUTTON");
    const dom = serializeBrowserUseDOM(node("SECTION", { children: [whitespace, button] })).dom;
    expect(dom).toContain(`[${button.id}]<button`);
    expect(reads).toBe(1);
    expect(browserUseBoundedContextText(text(" ".repeat(121)), 120)).toBeNull();
  });
  it("emits native button class evidence without inferring selection", () => {
    const card = node("BUTTON", {
      attributes: { class: "card border-neutral" },
      children: [text("Product Analytics")],
    });
    const before = serializeBrowserUseDOM(card).dom;
    card.attributes.class = "card border-selected";
    const after = serializeBrowserUseDOM(card).dom;
    expect(before).not.toContain("state_class=");
    expect(after).toContain('state_class="card border-selected"');
    expect(after).not.toContain("selected=true");
  });
  it("emits actual class and icon evidence for link cards", () => {
    const card = node("A", {
      attributes: { href: "#", class: "card border-neutral" },
      children: [text("Product Analytics")],
    });
    const before = serializeBrowserUseDOM(card).dom;
    card.attributes.class = "card border-selected";
    card.children.push(node("SVG", { attributes: { class: "check-icon" } }));
    const after = serializeBrowserUseDOM(card).dom;
    expect(before).not.toContain("state_class=");
    expect(after).toContain('state_class="card border-selected"');
    expect(after).toContain('state_icons=["check-icon"]');
    expect(after).not.toContain("selected=true");
  });
  it("does not treat decorative icons as selection evidence", () => {
    const iconCard = (label: string, className: string) =>
      node("A", {
        attributes: { href: "#" },
        children: [
          text("Product Analytics"),
          node("SVG", { attributes: { "aria-label": label, class: className } }),
        ],
      });
    for (const card of [iconCard("Brand logo", "logo"), iconCard("Expand", "chevron")]) {
      const dom = serializeBrowserUseDOM(card).dom;
      expect(dom).not.toContain("state_icons=");
      expect(dom).not.toContain("state_class=");
    }
    const selected = iconCard("Selected", "check-icon");
    expect(serializeBrowserUseDOM(selected).dom).toContain('state_icons=["Selected"]');
  });
  it("emits check spans and icon-font glyphs but not decorative descendants", () => {
    const card = (icon: BrowserUseNode) =>
      node("ARTICLE", {
        clickListener: true,
        children: [text("Product Analytics"), icon],
      });
    expect(
      serializeBrowserUseDOM(card(node("SPAN", { attributes: { class: "check-icon" } }))).dom,
    ).toContain('state_icons=["check-icon"]');
    expect(serializeBrowserUseDOM(card(node("I", { children: [text("✓")] }))).dom).toContain(
      'state_icons=["✓"]',
    );
    for (const icon of [
      node("SPAN", { attributes: { class: "brand-logo" } }),
      node("I", { attributes: { class: "chevron" } }),
      node("SPAN", { attributes: { class: "spinner" } }),
      node("I", { children: [text("★")] }),
    ])
      expect(serializeBrowserUseDOM(card(icon)).dom).not.toContain("state_icons=");
  });
  it("emits selection evidence for reachable controls without card tag heuristics", () => {
    const link = node("A", {
      attributes: { href: "#", class: "option border-selected" },
      children: [text("Plan")],
    });
    const article = node("ARTICLE", {
      clickListener: true,
      attributes: { class: "option border-selected" },
      children: [text("Plan"), node("SVG", { attributes: { class: "check-icon" } })],
    });
    const refs = new StableObservationRefs();
    const result = serializeBrowserUseDOM(node("DIV", { children: [link, article] }), {
      ref: (value) => refs.get("doc", value.id),
    });
    expect(result.dom).toContain('state_class="option border-selected"');
    expect(result.dom).toContain('state_icons=["check-icon"]');
    expect(result.refs).toEqual([refs.get("doc", link.id), refs.get("doc", article.id)]);
  });
  it("never reassigns ids after insertions, removals or navigation", () => {
    const refs = new StableObservationRefs();
    const first = refs.get("doc1", "action:first");
    const second = refs.get("doc1", "action:second");
    expect(first).toMatch(/^@e:[A-Za-z0-9_-]{11}$/);
    expect(second).not.toBe(first);
    for (let i = 0; i < 100; i++) refs.get("doc1", `new:${i}`);
    expect(refs.get("doc1", "action:second")).toBe(second);
    expect(refs.get("doc1", "action:first")).toBe(first);
    expect(refs.get("doc1", "unbound:first")).not.toBe(first);
    expect(refs.get("doc2", "action:first")).not.toBe(first);
    expect(refs.get("doc1", "action:first")).not.toBe(first);
  });
});
