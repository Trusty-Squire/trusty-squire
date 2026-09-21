import { describe, expect, it } from "vitest";
import {
  canonicalIndexForDriveRef,
  identityFromDriveElement,
  interactiveFromIdentity,
  rememberDriveIdentities,
} from "../act/identity.js";

describe("act control identity", () => {
  it("keeps a checkbox a checkbox so the act does not read it as a textbox", () => {
    const identity = identityFromDriveElement(
      { selector: "#terms", role: "checkbox", label: "I agree" },
      "https://app.example.test/signup",
    );
    expect(identity.role).toBe("checkbox");
    expect(interactiveFromIdentity(identity).role).toBe("checkbox");
  });

  it("carries the frame a drive element was captured in", () => {
    const identities = rememberDriveIdentities(
      {},
      [
        {
          ref: "@e:f1d4",
          selector: "#pan",
          role: "textbox",
          label: "Card number",
          frameUrl: "https://pay.example.test/fields",
          frameOrigin: "https://pay.example.test",
        },
      ],
      "https://shop.example.test/checkout",
    );
    const el = interactiveFromIdentity(identities.get("@e:f1d4")!, { framePath: "0" });
    expect(el.frameUrl).toBe("https://pay.example.test/fields");
    expect(el.frameOrigin).toBe("https://pay.example.test");
    expect(el.framePath).toBe("0");
  });

  it("translates a drive ref by node, not by a recomputed label", () => {
    const pan = { tagName: "INPUT", isConnected: true };
    const other = { tagName: "INPUT", isConnected: true };
    const selectors = new Map<string, unknown>([
      ["html > body > input", pan],
      ["html > body > input:nth-of-type(2)", other],
    ]);
    const restore = {
      registry: (globalThis as Record<string, unknown>).window,
      document: (globalThis as Record<string, unknown>).document,
    };
    (globalThis as Record<string, unknown>).window = {
      __tsDriveRegistry: { nodes: new Map([["@e:f0d3", pan]]) },
    };
    (globalThis as Record<string, unknown>).document = {
      querySelector: (selector: string) => selectors.get(selector) ?? null,
    };
    try {
      expect(
        canonicalIndexForDriveRef({
          ref: "@e:f0d3",
          candidates: [
            { index: 0, selector: "html > body > input:nth-of-type(2)" },
            { index: 1, selector: "html > body > input" },
          ],
        }),
      ).toBe(1);
      expect(
        canonicalIndexForDriveRef({
          ref: "@e:f0d9",
          candidates: [{ index: 0, selector: "html > body > input" }],
        }),
      ).toBe(-1);
    } finally {
      (globalThis as Record<string, unknown>).window = restore.registry;
      (globalThis as Record<string, unknown>).document = restore.document;
    }
  });
});
