import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  serializeBrowserUseDOM,
  browserUseContained,
  browserUseDynamicsSignature,
  type BrowserUseNode,
} from "../browser-use-serializer.js";
const fixtures = fileURLToPath(new URL("../../../../../fixtures/browser-use/", import.meta.url));
// Normalize only bracketed identities attached to tags. Text, whitespace,
// indentation, attributes, order, new markers and scroll prefixes are untouched.
const identity = (s: string): string =>
  s.replace(/(\[)(?:\d+|@e:[A-Za-z0-9_-]+)(\]<)/g, "$1IDENTITY$2");
describe("canonical browser-use 0.13.10 fixture oracle", () => {
  for (const slug of ["ipinfo", "mdn", "hacker-news", "wikipedia", "github", "gov-uk", "shopify"])
    it(slug, () => {
      const fixture = JSON.parse(readFileSync(`${fixtures}${slug}.json`, "utf8")) as {
        browserUse: string;
        capturedAt: string;
        sha256: string;
        root: BrowserUseNode;
      };
      const expected = readFileSync(`${fixtures}${slug}.txt`, "utf8");
      expect(fixture.browserUse).toBe("0.13.10");
      expect(Number.isFinite(Date.parse(fixture.capturedAt))).toBe(true);
      expect(
        createHash("sha256").update(expected).digest("hex"),
        "STALE FIXTURES: capture metadata and output must be regenerated together",
      ).toBe(fixture.sha256);
      const actual = serializeBrowserUseDOM(fixture.root, {
        ref: (n) => "@e:" + n.id,
        canonical: true,
      }).dom;
      expect(identity(actual)).toBe(identity(expected));
    });
  it("emits an injected token-shaped username verbatim", () => {
    const { root } = JSON.parse(readFileSync(`${fixtures}hacker-news.json`, "utf8")) as {
      root: BrowserUseNode;
    };
    const username = "usernametaken29";
    // The capture is intentionally volatile; inject the behavior under test
    // instead of coupling this no-redaction check to its live username.
    const firstVisibleText = (node: BrowserUseNode): BrowserUseNode | undefined =>
      node.nodeType === 3 && node.visible && node.snapshot && node.value.trim().length > 1
        ? node
        : node.children.map(firstVisibleText).find(Boolean);
    firstVisibleText(root)!.value = username;
    expect(serializeBrowserUseDOM(root).dom).toContain(username);
  });
  it.each(["title", "aria-label", "image_alt"])(
    "keeps canonical truncation without rewriting credential-shaped spans in %s",
    (attribute) => {
      const { root } = JSON.parse(readFileSync(`${fixtures}hacker-news.json`, "utf8")) as {
        root: BrowserUseNode;
      };
      const find = (node: BrowserUseNode, name: string): BrowserUseNode | undefined =>
        node.nodeName === name
          ? node
          : node.children.map((child) => find(child, name)).find(Boolean);
      const anchor = find(root, "A")!;
      const source = attribute === "image_alt" ? find(anchor, "IMG")! : anchor;
      const key = attribute === "image_alt" ? "alt" : attribute;
      for (const prefix of ["", "😀 ".repeat(30), "words ".repeat(15), "words ".repeat(17)]) {
        const value = prefix + "f9a062f02fadf5" + " ordinary words".repeat(12);
        source.attributes[key] = value;
        const { dom } = serializeBrowserUseDOM(anchor);
        expect(dom).toContain(`${attribute}=${Array.from(value).slice(0, 100).join("")}...`);
      }
    },
  );
  it("keeps the 99% containment boundary exact", () => {
    const parent = { x: 0, y: 0, width: 100, height: 100 };
    expect(browserUseContained({ x: 1, y: 0, width: 100, height: 100 }, parent)).toBe(true);
    expect(browserUseContained({ x: 1.01, y: 0, width: 100, height: 100 }, parent)).toBe(false);
    expect(browserUseContained({ x: 0, y: 0, width: 0, height: 100 }, parent)).toBe(false);
  });
  it("preserves the canonical hidden iframe hint cutoff without redaction", () => {
    const token = "f9a062f02fadf5";
    const iframe: BrowserUseNode = {
      id: "iframe",
      nodeType: 1,
      nodeName: "IFRAME",
      value: "",
      attributes: {},
      visible: true,
      snapshot: true,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      cursor: null,
      scrollable: false,
      showScroll: false,
      scrollText: "",
      clickListener: false,
      axRole: null,
      axProperties: [],
      axChildIds: null,
      shadowType: null,
      hiddenElements: [
        { tag: "button", text: `Copy access token to clipboard: ${token}`, pages: 1 },
      ],
      hiddenContent: false,
      children: [],
      contentDocument: null,
    };
    const expected = '"' + `Copy access token to clipboard: ${token}`.slice(0, 40) + '..."';
    // The pinned canonical port and production serializer both retain the
    // capped iframe hint verbatim, including its truncation marker.
    expect(serializeBrowserUseDOM(iframe, { canonical: true }).dom).toContain(expected);
    expect(serializeBrowserUseDOM(iframe).dom).toContain(expected);
  });
});

describe("browserUseDynamicsSignature", () => {
  const node = (overrides: Partial<BrowserUseNode>): BrowserUseNode => ({
    id: "n",
    nodeType: 1,
    nodeName: "DIV",
    value: "",
    attributes: {},
    visible: true,
    snapshot: true,
    bounds: null,
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
    ...overrides,
  });
  const shadowHost = (child: BrowserUseNode, height = 60): BrowserUseNode =>
    node({
      nodeName: "DIV",
      bounds: { x: 0, y: 0, width: 300, height },
      children: [
        node({
          nodeType: 11,
          nodeName: "#shadow-root",
          shadowType: "closed",
          children: [child],
        }),
      ],
    });
  const turnstileFrame = (overrides: Partial<BrowserUseNode> = {}): BrowserUseNode =>
    node({
      nodeName: "IFRAME",
      attributes: { src: "https://challenges.example.com/turnstile/v0/api.js#widget" },
      bounds: { x: 0, y: 0, width: 300, height: 60 },
      ...overrides,
    });

  it("is stable for an unchanged closed-shadow widget tree", () => {
    expect(browserUseDynamicsSignature(shadowHost(turnstileFrame()))).toBe(
      browserUseDynamicsSignature(shadowHost(turnstileFrame())),
    );
  });

  it("changes when a closed-shadow iframe is replaced by another control", () => {
    const swapped = shadowHost(
      node({
        nodeName: "BUTTON",
        bounds: { x: 0, y: 0, width: 300, height: 60 },
      }),
    );
    expect(browserUseDynamicsSignature(shadowHost(turnstileFrame()))).not.toBe(
      browserUseDynamicsSignature(swapped),
    );
  });

  it("changes on iframe src and geometry even though the canonical DOM string does not render them", () => {
    const before = shadowHost(turnstileFrame());
    const rehashed = shadowHost(
      turnstileFrame({
        attributes: { src: "https://challenges.example.com/turnstile/v0/api.js#token" },
        bounds: { x: 0, y: 0, width: 300, height: 64 },
      }),
    );
    // This is the Groq/Cartesia failure mode: the widget swap serializes to the
    // same canonical DOM string, so only the dynamics signature can catch it.
    expect(serializeBrowserUseDOM(before).dom).toBe(serializeBrowserUseDOM(rehashed).dom);
    expect(browserUseDynamicsSignature(before)).not.toBe(browserUseDynamicsSignature(rehashed));
  });

  it("changes when the shadow host itself moves or grows", () => {
    expect(browserUseDynamicsSignature(shadowHost(turnstileFrame(), 60))).not.toBe(
      browserUseDynamicsSignature(shadowHost(turnstileFrame(), 96)),
    );
  });

  it("ignores benign content inside an open, unframed subtree", () => {
    const text = (value: string) => node({ nodeType: 3, nodeName: "#text", value });
    expect(
      browserUseDynamicsSignature(node({ children: [text("attempt=1")] })),
    ).toBe(browserUseDynamicsSignature(node({ children: [text("attempt=2")] })));
  });
});
