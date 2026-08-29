import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  OBSERVE_V2_MAX_WIRE_BYTES,
  OBSERVE_V2_MAX_TOKENS,
  buildSafeControlsV2,
  compactV2LegacyRefForHandle,
  diffSafeControlsV2,
  equalSafePageSemanticsV2,
  encodeV2Delta,
  encodeV2Page,
  safePageSemanticsV2,
  safeDescriptionV2,
  sealRetainedInteractiveElementsV2,
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
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    const wire = JSON.stringify(safe.rows);
    expect(wire).not.toContain("4111111111111111");
    expect(wire).not.toContain("swordfish");
    expect(wire).not.toContain("Northwind");
    expect(safe.rows).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^@e:/),
        role: "button",
        visibility: "viewport",
      }),
    ]);
  });

  it("removes credential-shaped labels before building the safe table", () => {
    const button = element({ visibleText: "Copy api_1234567890123" });
    const safe = buildSafeControlsV2({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy-secret"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ ref: "@e:1.1", role: "button" })]);
    expect(JSON.stringify(safe.rows)).not.toContain("api_1234567890123");
  });

  it("rejects arbitrary standalone strings outside the semantic-safe grammar", () => {
    expect(safeDescriptionV2("correcthorsebattery")).toBeUndefined();
    expect(safeDescriptionV2("correct horse battery staple")).toBeUndefined();
    expect(
      safePageSemanticsV2({
        title: "correcthorsebattery",
        headings: ["Create your account"],
      }),
    ).toEqual({ headings: ["Create your account"] });
    const button = element({ visibleText: "correcthorsebattery" });
    const safe = buildSafeControlsV2({
      elements: [button],
      legacyRefs: new Map([[button, "@e:standalone-secret"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows[0]?.name).toBeUndefined();
  });

  it("retains only finite DOM semantic tokens", () => {
    const [sealed] = sealRetainedInteractiveElementsV2(
      [
        element({
          tag: "correcthorsebattery",
          type: "correcthorsebattery",
          role: "correcthorsebattery",
          selector: "#private-selector",
        }),
      ],
      () => "@c:opaque",
    );
    expect(sealed).toEqual(
      expect.objectContaining({ tag: "unknown", type: null, role: null, selector: "@c:opaque" }),
    );
    expect(JSON.stringify(sealed)).not.toContain("correcthorsebattery");
    expect(JSON.stringify(sealed)).not.toContain("private-selector");
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
      stage: "browse",
      rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(Buffer.byteLength(JSON.stringify(page.payload), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.nextOffset).toBeLessThan(rows.length);
    expect((page.payload.overflow as { next_cursor: string }).next_cursor).toBe(
      `cursor-${page.nextOffset}`,
    );
    expect(page.payload.session_id).toBe("session");
    expect(page.payload.stage).toBe("browse");
  });

  it("rejects token-dense metadata below the byte ceiling but above the token cap", () => {
    const denseHint = "!".repeat(OBSERVE_V2_MAX_TOKENS + 64);
    expect(Buffer.byteLength(JSON.stringify({ hint: denseHint }), "utf8")).toBeLessThan(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    expect(() =>
      encodeV2Page({
        sessionId: "session",
        stage: "browse",
        rows: [],
        cursorFor: (offset) => `cursor-${offset}`,
        startMetadata: { hint: denseHint },
      }),
    ).toThrow("compact-v2 budget metadata exceeded");
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
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    const page = encodeV2Page({
      sessionId: "session",
      stage: "browse",
      semantics: { title: "Dense sample", headings: ["First controls"] },
      rows: safe.rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    const wire = JSON.stringify(page.payload);
    expect(safe.rows).toHaveLength(94);
    expect(page.payload.safe_table as unknown[]).toHaveLength(4);
    expect(page.payload.overflow).toEqual({ remaining: 90, next_cursor: "cursor-4" });
    expect(page.payload.semantic).toEqual({ title: "Dense sample", headings: ["First controls"] });
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
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ role: "textbox", field: "email" })]);
    expect(JSON.stringify(safe.rows)).not.toContain("private@example.test");
  });

  it("keeps native submit inputs actionable and screens their value as a label", () => {
    const submit = element({
      tag: "input",
      type: "submit",
      role: null,
      value: "Create account",
      selector: "#create-account",
    });
    const safe = buildSafeControlsV2({
      elements: [submit],
      legacyRefs: new Map([[submit, "@e:submit"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({ role: "button", name: "Create account", action: "signup" }),
    ]);
  });

  it("classifies only quantity-signaled number inputs as quantity fields", () => {
    const otp = element({
      tag: "input",
      type: "number",
      role: "textbox",
      ariaLabel: "Verification code",
      selector: "#otp",
    });
    const quantity = element({
      tag: "input",
      type: "number",
      role: "textbox",
      ariaLabel: "Quantity",
      selector: "#quantity",
    });
    const safe = buildSafeControlsV2({
      elements: [otp, quantity],
      legacyRefs: new Map([
        [otp, "@e:otp"],
        [quantity, "@e:quantity"],
      ]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    const otpRow = safe.rows.find((row) => row.name === "Verification code");
    const quantityRow = safe.rows.find((row) => row.name === "Quantity");
    expect(otpRow?.field).toBeUndefined();
    expect(quantityRow?.field).toBe("quantity");
  });

  it("issues short generation-bound indices in table order", () => {
    const button = element({ visibleText: "private merchant copy" });
    const refs = new Map<InteractiveElement, string>([[button, "@e:stable_button"]]);
    const initial = buildSafeControlsV2({
      elements: [button],
      legacyRefs: refs,
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    const repeated = buildSafeControlsV2({
      elements: [button],
      legacyRefs: refs,
      generation: 2,
      pageOrigin: "https://merchant.invalid",
    });
    expect(initial.rows[0]).toEqual(
      expect.objectContaining({ ref: "@e:1.1", name: "private merchant copy" }),
    );
    expect(repeated.rows[0]).toEqual(expect.objectContaining({ ref: "@e:2.1" }));
  });

  it("accepts only current snapshot index members", () => {
    const current = new Map([["@e:2.1", "@e:legacy_current"]]);
    expect(compactV2LegacyRefForHandle(current, 2, "@e:2.1")).toBe("@e:legacy_current");
    expect(compactV2LegacyRefForHandle(current, 2, "@e:1.1")).toBeNull(); // stale generation
    expect(compactV2LegacyRefForHandle(current, 2, "@e:2.2")).toBeNull(); // out of range
    expect(compactV2LegacyRefForHandle(current, 2, "@e:2.01")).toBeNull(); // non-canonical forgery
    expect(compactV2LegacyRefForHandle(current, 3, "@e:2.1")).toBeNull(); // page-change snapshot
  });

  it("uses the native DOM label while retaining TS's local action ref", () => {
    const button = element({ visibleText: "Native serialized control" });
    const safe = buildSafeControlsV2({
      elements: [button],
      legacyRefs: new Map([[button, "@e:continue"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^@e:/),
        name: "Native serialized control",
      }),
    ]);
  });

  it("preserves short semantic essentials while rejecting card and secret-shaped text", () => {
    expect(
      safePageSemanticsV2({
        title: "Example storefront",
        headings: [
          "Create your account",
          "4111111111111111",
          "API key: abcdefghijklmnopqrstuvwxyz",
        ],
      }),
    ).toEqual({ title: "Example storefront", headings: ["Create your account"] });
    const button = element({ visibleText: "Continue to registration" });
    const cardLike = element({ selector: "#secret", visibleText: "4111111111111111" });
    const safe = buildSafeControlsV2({
      elements: [button, cardLike],
      legacyRefs: new Map([
        [button, "@e:continue"],
        [cardLike, "@e:card"],
      ]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toContainEqual(expect.objectContaining({ name: "Continue to registration" }));
    expect(JSON.stringify(safe.rows)).not.toContain("4111111111111111");
  });

  it("uses the first safe accessibility label after rejecting an unsafe visible value", () => {
    const button = element({
      visibleText: "abcdefghijklmnopqrstuvwxyz123456",
      ariaLabel: "Copy API key",
    });
    const safe = buildSafeControlsV2({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ name: "Copy API key" })]);
  });

  it("classifies password-masked card security controls as payment fields", () => {
    const cvc = element({
      tag: "input",
      type: "password",
      role: "textbox",
      autocomplete: "cc-csc",
    });
    const safe = buildSafeControlsV2({
      elements: [cvc],
      legacyRefs: new Map([[cvc, "@e:cvc"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ field: "payment" })]);
    expect(safeStageV2("https://merchant.invalid/checkout", [cvc])).toBe("checkout");
  });

  it("recognizes a labeled CVC field without autocomplete as payment", () => {
    const cvc = element({
      tag: "input",
      type: "password",
      role: "textbox",
      ariaLabel: "CVC",
    });
    const safe = buildSafeControlsV2({
      elements: [cvc],
      legacyRefs: new Map([[cvc, "@e:cvc"]]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ field: "payment" })]);
    expect(safeStageV2("https://merchant.invalid/checkout", [cvc])).toBe("checkout");
  });

  it("reduces completion and checkout signals to a finite page-stage enum", () => {
    expect(safeStageV2("https://merchant.invalid/thank-you", [])).toBe("complete");
    expect(safeStageV2("https://merchant.invalid/incomplete", [])).toBe("browse");
    expect(
      safeStageV2("https://merchant.invalid/cart", [
        element({ visibleText: "Checkout", role: "button" }),
      ]),
    ).toBe("cart");
    expect(
      safeStageV2("https://merchant.invalid/products/widget", [
        element({ visibleText: "View cart", role: "link" }),
      ]),
    ).toBe("browse");
    expect(
      safeStageV2("https://merchant.invalid/order", [
        element({ visibleText: "Checkout", role: "button" }),
        element({ tag: "input", role: "textbox", autocomplete: "shipping address-line1" }),
      ]),
    ).toBe("checkout");
    expect(safeStageV2("https://merchant.invalid/products/checkout-tote", [])).toBe("browse");
    expect(
      safeStageV2("https://merchant.invalid/products/checkout-tote", [
        element({ visibleText: "Checkout Tote", role: "link" }),
      ]),
    ).toBe("browse");
    expect(
      safeStageV2("https://merchant.invalid/products/widget", [
        element({ visibleText: "Log in", role: "link" }),
        element({ visibleText: "Gift card", role: "link" }),
      ]),
    ).toBe("browse");
    expect(
      safeStageV2("https://merchant.invalid/account", [
        element({ visibleText: "Log in", role: "button", formId: 1 }),
        element({ tag: "input", type: "email", role: "textbox", formId: 1 }),
      ]),
    ).toBe("auth");
    expect(
      safeStageV2("https://merchant.invalid/checkout", [
        element({ tag: "input", type: "password", role: "textbox" }),
      ]),
    ).toBe("auth");
    expect(
      safeStageV2("https://merchant.invalid/products/widget", [
        element({ visibleText: "Add to cart", role: "button", topmost: false }),
        element({
          tag: "input",
          type: "password",
          role: "textbox",
          visible: true,
          topmost: true,
          formId: 4,
        }),
      ]),
    ).toBe("auth");
    expect(
      safeStageV2("https://merchant.invalid/account", [
        element({ visibleText: "Log in", role: "button", containerId: 8, formId: 7 }),
        element({
          tag: "input",
          type: "email",
          role: "textbox",
          containerId: 7,
          formId: 7,
        }),
      ]),
    ).toBe("auth");
  });

  it("parses tokenized autocomplete fields and required state", () => {
    const city = element({
      tag: "input",
      role: "textbox",
      autocomplete: "section-delivery shipping address-level2",
      required: true,
    });
    const postal = element({
      tag: "input",
      role: "textbox",
      selector: "#postal",
      autocomplete: "shipping postal-code",
    });
    const safe = buildSafeControlsV2({
      elements: [city, postal],
      legacyRefs: new Map([
        [city, "@e:city"],
        [postal, "@e:postal"],
      ]),
      generation: 1,
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({ field: "city", state: "r" }),
      expect.objectContaining({ field: "postal" }),
    ]);
  });

  it("keeps compact control state and finite action semantics on the wire", () => {
    const page = encodeV2Page({
      sessionId: "session",
      stage: "form",
      rows: [
        {
          ref: "@e:1.1",
          role: "checkbox",
          visibility: "viewport",
          frame: "same_origin",
          name: "Terms",
          state: "u",
          action: "continue",
          field: "email",
          choice: "1/2",
        },
      ],
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(page.payload.safe_table).toEqual([
      ["@e:1.1", "c", "Terms|s=u|a=continue|f=email|q=1/2|x=s"],
    ]);
  });

  it("uses a tiny sealed delta when the safe map is unchanged", () => {
    const page = encodeV2Delta({
      sessionId: "session",
      stage: "form",
      delta: { added: [], changed: [], removed: [], stageChanged: false },
    });
    expect(page).toEqual({
      format: "compact-v2",
      url: "",
      text: "",
      session_id: "session",
      delta: true,
    });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(128);
  });

  it("keeps controls on the first page and sends no rows for its unchanged re-observe", () => {
    const first = encodeV2Page({
      sessionId: "session",
      stage: "browse",
      semantics: { title: "Sample", headings: ["Choose an option"] },
      rows: [
        {
          ref: "@e:first-control",
          role: "button",
          visibility: "viewport",
          frame: "main",
          name: "Continue",
        },
      ],
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(first.payload.safe_table).toEqual([["@e:first-control", "b", "Continue"]]);
    const repeat = encodeV2Delta({
      sessionId: "session",
      stage: "browse",
      delta: { added: [], changed: [], removed: [], stageChanged: false },
    });
    expect(repeat).toEqual({
      format: "compact-v2",
      url: "",
      text: "",
      session_id: "session",
      delta: true,
    });
    expect(Buffer.byteLength(JSON.stringify(repeat), "utf8")).toBeLessThan(128);
  });

  it("keeps unchanged semantic essentials sticky instead of repeating them in every delta", () => {
    const semantics = { title: "Example storefront", headings: ["Create your account"] };
    expect(
      equalSafePageSemanticsV2(semantics, { ...semantics, headings: ["Create your account"] }),
    ).toBe(true);
    expect(
      equalSafePageSemanticsV2(semantics, {
        title: "Different page",
        headings: ["Create your account"],
      }),
    ).toBe(false);
    const delta = encodeV2Delta({
      sessionId: "session",
      stage: "form",
      semantics: undefined,
      delta: { added: [], changed: [], removed: [], stageChanged: false },
    });
    expect(delta).toEqual({
      format: "compact-v2",
      url: "",
      text: "",
      session_id: "session",
      delta: true,
    });
    expect(Buffer.byteLength(JSON.stringify(delta), "utf8")).toBeLessThan(128);
  });

  it("emits an explicit semantic clear when the sealed semantics become empty", () => {
    const delta = encodeV2Delta({
      sessionId: "session",
      stage: "form",
      semantics: {},
      delta: { added: [], changed: [], removed: [], stageChanged: false },
    });
    expect(delta).toEqual({
      format: "compact-v2",
      url: "",
      text: "",
      session_id: "session",
      delta: true,
      semantic: {},
    });
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
      {
        pageKey: "same-page",
        snapshotGeneration: 1,
        stage: "form",
        semantics: {},
        byRef: new Map([
          [before.ref, before],
          ["@e:removed", before],
        ]),
      },
      "form",
      [changed, added],
    );
    const page = encodeV2Delta({ sessionId: "session", stage: "form", delta });
    const wire = JSON.stringify(page);
    expect(wire).toContain("safe_table");
    expect(wire).toContain("@e:added");
    expect(wire).toContain("@e:removed");
    expect(wire).not.toContain(planted);
    expect(wire).not.toContain("Northwind");
  });
});
