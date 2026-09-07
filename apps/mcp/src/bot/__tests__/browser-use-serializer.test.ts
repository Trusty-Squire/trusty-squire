import { redactObservationProseV2, screenBrowserUseValueV2 } from "../compact-observation-v2.js";
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
  for (const slug of ["ipinfo", "stripe", "hacker-news", "wikipedia", "github", "gov-uk"])
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
  for (const slug of ["ipinfo", "stripe", "hacker-news", "wikipedia", "github", "gov-uk"])
    it(`${slug}: screening changes only redacted spans, preserving every row and ref`, () => {
      const { root } = JSON.parse(readFileSync(`${fixtures}${slug}.json`, "utf8")) as {
        root: BrowserUseNode;
      };
      const ref = (node: BrowserUseNode): string => `@e:${node.id}`;
      const before = serializeBrowserUseDOM(root, { ref });
      const after = serializeBrowserUseDOM(root, { ref, screen: screenBrowserUseValueV2 });
      expect(after.refs).toEqual(before.refs);
      const originalLines = before.dom.split("\n");
      const screenedLines = after.dom.split("\n");
      expect(screenedLines).toHaveLength(originalLines.length);
      for (const [index, line] of screenedLines.entries()) {
        const original = originalLines[index]!;
        expect(line.match(/^\t*/)?.[0]).toBe(original.match(/^\t*/)?.[0]);
        // Independently constrain the entire output to literal unchanged spans
        // separated by non-whitespace strings accepted by the existing screen.
        // No normalization can conceal a removed row, tag, ref or indentation.
        const escaped = line
          .split("[redacted]")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const match = original.match(new RegExp(`^${escaped.join("(\\S+?)")}$`));
        expect(match, `unexpected structural change on ${slug} line ${index}`).not.toBeNull();
        for (const span of match!.slice(1))
          expect(redactObservationProseV2(span)).toBe("[redacted]");
        expect(line.match(/\[@e:[A-Za-z0-9_-]+\]</g)).toEqual(
          original.match(/\[@e:[A-Za-z0-9_-]+\]</g),
        );
      }
    });
  it("pins the HN lowercase-plus-digits username false positive without loosening the screen", () => {
    const { root } = JSON.parse(readFileSync(`${fixtures}hacker-news.json`, "utf8")) as {
      root: BrowserUseNode;
    };
    const before = serializeBrowserUseDOM(root).dom;
    const after = serializeBrowserUseDOM(root, { screen: screenBrowserUseValueV2 }).dom;
    expect(before).toContain("usernametaken29");
    expect(redactObservationProseV2("usernametaken29")).toBe("[redacted]");
    expect(after).not.toContain("usernametaken29");
    const line = before.split("\n").findIndex((value) => value.includes("usernametaken29"));
    expect(after.split("\n")[line]).toBe(
      before.split("\n")[line]!.replaceAll("usernametaken29", "[redacted]"),
    );
  });
  it.each(["title", "aria-label", "image_alt"])(
    "preserves canonical truncation around redacted spans in %s",
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
      const token = "f9a062f02fadf5";
      for (const prefix of ["", "😀 ".repeat(30), "words ".repeat(15), "words ".repeat(17)]) {
        const value = prefix + token + " ordinary words".repeat(12);
        source.attributes[key] = value;
        const before = serializeBrowserUseDOM(anchor, { ref: (node) => `@e:${node.id}` });
        const after = serializeBrowserUseDOM(anchor, {
          ref: (node) => `@e:${node.id}`,
          screen: screenBrowserUseValueV2,
        });
        const visible = Array.from(value).slice(0, 100).join("");
        // Expected text is derived from the ORIGINAL cutoff, not from the screen.
        // Even a tiny visible prefix of a full secret becomes a complete marker.
        const start = prefix.length;
        const expected =
          visible.length > start
            ? visible.slice(0, start) + "[redacted]" + visible.slice(start + token.length)
            : visible;
        expect(after.dom).toBe(
          before.dom.replace(`${attribute}=${visible}...`, `${attribute}=${expected}...`),
        );
        expect(after.refs).toEqual(before.refs);
        expect(after.dom.split("\n")).toHaveLength(before.dom.split("\n").length);
      }
    },
  );
  it("keeps the 99% containment boundary exact", () => {
    const parent = { x: 0, y: 0, width: 100, height: 100 };
    expect(browserUseContained({ x: 1, y: 0, width: 100, height: 100 }, parent)).toBe(true);
    expect(browserUseContained({ x: 1.01, y: 0, width: 100, height: 100 }, parent)).toBe(false);
    expect(browserUseContained({ x: 0, y: 0, width: 0, height: 100 }, parent)).toBe(false);
  });
  it("screens a hidden iframe control against its full name before applying the hint cutoff", () => {
    const token = "f9a062f02fadf5";
    const dom = serializeBrowserUseDOM(
      {
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
      },
      { screen: screenBrowserUseValueV2 },
    ).dom;
    expect(dom).toContain('"Copy access token to clipboard: [redacted]"');
    expect(dom).not.toContain(token);
    expect(dom).not.toContain(token.slice(0, 8));
  });
});
