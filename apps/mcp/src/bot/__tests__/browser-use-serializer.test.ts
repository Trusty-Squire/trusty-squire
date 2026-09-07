import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  serializeBrowserUseDOM,
  browserUseContained,
  type BrowserUseNode,
} from "../browser-use-serializer.js";
const fixtures = fileURLToPath(new URL("../../../../../fixtures/browser-use/", import.meta.url));
// Normalize only bracketed identities attached to tags. Text, whitespace,
// indentation, attributes, order, new markers and scroll prefixes are untouched.
const identity = (s: string): string =>
  s.replace(/(\[)(?:\d+|@e:[A-Za-z0-9_-]+)(\]<)/g, "$1IDENTITY$2");
describe("canonical browser-use 0.13.10 fixture oracle", () => {
  for (const slug of ["ipinfo", "mdn", "hacker-news", "wikipedia", "github", "gov-uk"])
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
      }).dom;
      expect(identity(actual)).toBe(identity(expected));
    });
  it("emits the HN username verbatim", () => {
    const { root } = JSON.parse(readFileSync(`${fixtures}hacker-news.json`, "utf8")) as {
      root: BrowserUseNode;
    };
    expect(serializeBrowserUseDOM(root).dom).toContain("usernametaken29");
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
    const dom = serializeBrowserUseDOM({
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
    }).dom;
    expect(dom).toContain('"' + `Copy access token to clipboard: ${token}`.slice(0, 40) + '"');
  });
});
