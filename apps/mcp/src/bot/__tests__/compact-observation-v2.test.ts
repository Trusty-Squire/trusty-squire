import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  OBSERVE_V2_MAX_WIRE_BYTES,
  buildSafeControlsV2,
  diffSafeControlsV2,
  encodeV2Delta,
  encodeV2Page,
  safeStageV2,
} from "../compact-observation-v2.js";
import type { InteractiveElement } from "../browser.js";

function element(overrides: Partial<InteractiveElement> = {}): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: "button",
    labelText: null,
    visibleText: null,
    selector: "button",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...overrides,
  };
}

describe("compact observation v2", () => {
  it("allows only enum fields even when every raw source contains secrets", () => {
    const planted = "4111111111111111 CVV=123 password=swordfish merchant=Northwind";
    const input = element({
      visibleText: planted,
      labelText: planted,
      ariaLabel: planted,
      iconLabel: planted,
      title: planted,
      placeholder: planted,
      name: planted,
      id: planted,
      value: planted,
      href: `https://merchant.invalid/pay?card=${planted}`,
    });
    const refs = new Map<InteractiveElement, string>([[input, "@e:private_identity_1"]]);
    const safe = buildSafeControlsV2({
      elements: [input],
      legacyRefs: refs,
      secret: randomBytes(32),
      pageOrigin: "https://merchant.invalid",
      selected: [{ backend_node_id: 1, tag: "button", role: "button", name: planted }],
    });
    const wire = JSON.stringify(safe.rows);
    expect(wire).not.toContain("4111111111111111");
    expect(wire).not.toContain("swordfish");
    expect(wire).not.toContain("Northwind");
    expect(safe.rows).toEqual([
      expect.objectContaining({ ref: expect.stringMatching(/^@e:/), role: "button", visibility: "viewport" }),
    ]);
  });

  it("returns an intact first page and signed cursor below the final wire cap", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      ref: `@e:${index.toString(36).padStart(18, "a")}`,
      role: "button" as const,
      visibility: "viewport" as const,
      frame: "main" as const,
      action: "continue" as const,
    }));
    const page = encodeV2Page({
      sessionId: "session",
      generation: 4,
      stage: "browse",
      rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(Buffer.byteLength(JSON.stringify(page.payload), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.nextOffset).toBeLessThan(rows.length);
    expect((page.payload.overflow as { next_cursor: string }).next_cursor).toBe(`cursor-${page.nextOffset}`);
    expect(page.payload.stage).toBe("browse");
  });

  it("clamps a dense page with long raw labels to a paged, sealed first action map", () => {
    const longLabel = "merchant-controlled label ".repeat(12);
    const dense = Array.from({ length: 94 }, (_, index) =>
      element({
        index,
        visibleText: `${longLabel}${index}`,
        labelText: `${longLabel}${index}`,
        selector: `#control-${index}`,
      }),
    );
    const safe = buildSafeControlsV2({
      elements: dense,
      legacyRefs: new Map(dense.map((control, index) => [control, `@e:legacy_${index}`])),
      secret: randomBytes(32),
      pageOrigin: "https://merchant.invalid",
      selected: dense.map((_, index) => ({
        backend_node_id: index + 1,
        tag: "button",
        role: "button",
        name: `${longLabel}${index}`,
      })),
    });
    const page = encodeV2Page({
      sessionId: "session",
      generation: 7,
      stage: "browse",
      rows: safe.rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    const wire = JSON.stringify(page.payload);
    expect(safe.rows).toHaveLength(94);
    expect((page.payload.safe_table as unknown[])).toHaveLength(4);
    expect(page.payload.overflow).toEqual({ remaining: 90, next_cursor: "cursor-4" });
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(OBSERVE_V2_MAX_WIRE_BYTES);
    expect(wire).not.toContain(longLabel);
  });

  it("turns form semantics into finite fields and never forwards their labels", () => {
    const input = element({
      tag: "input",
      type: "email",
      role: "textbox",
      ariaLabel: "Private customer contact address: private@example.test",
      autocomplete: "email",
    });
    const safe = buildSafeControlsV2({
      elements: [input],
      legacyRefs: new Map([[input, "@e:email_1"]]),
      secret: randomBytes(32),
      pageOrigin: "https://merchant.invalid",
      selected: [{ backend_node_id: 1, tag: "input", role: "textbox", name: "anything" }],
    });
    expect(safe.rows).toEqual([expect.objectContaining({ role: "textbox", field: "email" })]);
    expect(JSON.stringify(safe.rows)).not.toContain("private@example.test");
  });

  it("keeps only an already browser-use-authorized sealed ref across a transient shortlist change", () => {
    const button = element({ visibleText: "private merchant copy" });
    const refs = new Map<InteractiveElement, string>([[button, "@e:stable_button"]]);
    const initial = buildSafeControlsV2({
      elements: [button],
      legacyRefs: refs,
      secret: Buffer.alloc(32, 7),
      pageOrigin: "https://merchant.invalid",
      selected: [{ backend_node_id: 1, tag: "button", role: "button", name: "private merchant copy" }],
    });
    const repeated = buildSafeControlsV2({
      elements: [button],
      legacyRefs: refs,
      secret: Buffer.alloc(32, 7),
      pageOrigin: "https://merchant.invalid",
      selected: [],
      previouslySelected: new Set(initial.rows.map((row) => row.ref)),
    });
    expect(repeated.rows).toEqual(initial.rows);
    expect(JSON.stringify(repeated.rows)).not.toContain("private merchant copy");
  });

  it("reduces completion and checkout signals to a finite page-stage enum", () => {
    expect(safeStageV2("https://merchant.invalid/thank-you", [])).toBe("complete");
    expect(
      safeStageV2("https://merchant.invalid/order", [element({ visibleText: "Checkout", role: "button" })]),
    ).toBe("checkout");
  });

  it("uses a tiny sealed delta when the safe map is unchanged", () => {
    const page = encodeV2Delta({
      generation: 5,
      stage: "form",
      delta: { added: [], changed: [], removed: [], stageChanged: false },
    });
    expect(page).toEqual({
      format: "compact-v2",
      generation: 5,
      delta: true,
    });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(80);
  });

  it("emits only safe upserts and removed refs for a structural delta", () => {
    const planted = "4111111111111111 CVV=123 merchant=Northwind";
    const before = {
      ref: "@e:before",
      role: "button" as const,
      visibility: "viewport" as const,
      frame: "main" as const,
      action: "continue" as const,
    };
    const changed = { ...before, action: "submit" as const };
    const added = { ...before, ref: "@e:added", field: "email" as const };
    const delta = diffSafeControlsV2(
      { stage: "form", byRef: new Map([[before.ref, before], ["@e:removed", before]]) },
      "form",
      [changed, added],
    );
    const page = encodeV2Delta({ generation: 6, stage: "form", delta });
    const wire = JSON.stringify(page);
    expect(wire).toContain("safe_table");
    expect(wire).toContain("@e:added");
    expect(wire).toContain("@e:removed");
    expect(wire).not.toContain(planted);
    expect(wire).not.toContain("Northwind");
  });
});
