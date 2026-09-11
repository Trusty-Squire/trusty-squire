import { StableObservationRefs } from "../compact-observation-v2.js";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  OBSERVE_V2_MAX_WIRE_BYTES,
  buildSafeControlsV2,
  compactV2LegacyRefForHandle,
  controlLabelV2,
  isCompactV2Handle,
  isCompactV2Label,
  controlQueryMatchV2,
  controlMatchesPrivateQueryV2,
  disambiguateDuplicateLabelsV2,
  encodeV2QueryPage,
  safeBlockersV2,
  safePageSemanticsV2,
  safeDescriptionV2,
  safeOriginV2,
  sealRetainedInteractiveElementsV2,
  safeStageV2,
} from "../compact-observation-v2.js";
import type { InteractiveElement } from "../browser.js";
import type { BrowserUseNode } from "../browser-use-serializer.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const aizasy = (body: string): string => "AIza" + "Sy" + body;
const akia = (body: string): string => "AK" + "IA" + body;
const asia = (body: string): string => "AS" + "IA" + body;
const gho = (body: string): string => "gh" + "o_" + body;
const ghp = (body: string): string => "gh" + "p_" + body;
const ghs = (body: string): string => "gh" + "s_" + body;
const ghu = (body: string): string => "gh" + "u_" + body;
const gpat = (body: string): string => "github_" + "pat_" + body;
const glpat = (body: string): string => "gl" + "pat-" + body;
const sk = (body: string): string => "sk" + "-" + body;
const xoxb = (body: string): string => "xox" + "b-" + body;
const xoxp = (body: string): string => "xox" + "p-" + body;
const xoxr = (body: string): string => "xox" + "r-" + body;

/**
 * The serializer under test consumes handles; minting them is the session's job
 * (docs/observation-model.md §4.1). Give each element a stable synthetic handle
 * so these cases stay about the wire representation.
 */
function safeControls(args: {
  elements: readonly InteractiveElement[];
  legacyRefs: ReadonlyMap<InteractiveElement, string>;
  pageOrigin: string;
  pageUrl?: string;
  canonical?: boolean;
}): ReturnType<typeof buildSafeControlsV2> {
  return buildSafeControlsV2({
    ...args,
    handles: new Map(
      args.elements.map((el, index) => [el, `@e:${String(index + 1).padStart(10, "h")}`]),
    ),
  });
}

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
  it("advertises only Shopify's required address-line1 as the delivery-address field", () => {
    const address = element({
      tag: "input",
      role: "combobox",
      labelText: "Address",
      autocomplete: "shipping address-line1",
      required: true,
      selector: "#shipping-address",
    });
    const apartment = element({
      index: 1,
      tag: "input",
      role: "textbox",
      labelText: "Apartment, suite, etc. (optional)",
      autocomplete: "shipping address-line2",
      selector: "#shipping-apartment",
    });
    const refs = new Map<InteractiveElement, string>([
      [address, "Address"],
      [apartment, "Apartment, suite, etc. (optional)"],
    ]);

    const rows = safeControls({
      elements: [address, apartment],
      legacyRefs: refs,
      pageOrigin: "https://merchant.invalid",
      pageUrl: "https://merchant.invalid/checkouts/example/information",
    }).rows;

    // Before the regression fix both rows carried f=address. That made the
    // optional textbox look interchangeable with the required combobox.
    expect(rows[0]).toEqual(
      expect.objectContaining({ role: "select", state: "r", field: "address" }),
    );
    expect(rows[1]).toEqual(expect.objectContaining({ role: "textbox" }));
    expect(rows[1]).not.toHaveProperty("field");
  });

  it("emits enum fields plus the page's own label, whatever the label contains", () => {
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
    const safe = safeControls({
      elements: [input],
      legacyRefs: refs,
      pageOrigin: "https://merchant.invalid",
    });
    // Everything but the label stays a code-owned enum (the wire format), and
    // the label is the page's own copy — card material included. Nothing is
    // screened out any more.
    expect(safe.rows).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^@e:/),
        role: "button",
        visibility: "viewport",
        field: "payment",
        label: expect.stringContaining("4111111111111111"),
      }),
    ]);
  });

  it.each([
    ["Copy api_1234567890123", "@copy-api-1234567890123"],
    ["f9a062f02fadf5", "@f9a062f02fadf5"],
    ["usernametaken29", "@usernametaken29"],
    ["Copy 3kR9xQ2m-7LpW4vZn", "@copy-3k"],
    ["Bearer f9a062f02f", "@bearer-f9a062f02f"],
  ])("keeps the page label %s actionable without redaction", (visibleText, label) => {
    const button = element({ visibleText });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows[0]).toMatchObject({ ref: "@e:hhhhhhhhh1", role: "button", label });
    const { payload } = encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      rows: safe.rows,
      cursorFor: () => "cursor",
    });
    expect(payload.safe_table).toEqual([["@e:hhhhhhhhh1", "b", label]]);
  });

  it("keeps every page-derived description, card material included", () => {
    expect(safeDescriptionV2("correcthorsebattery")).toBe("correcthorsebattery");
    expect(safeDescriptionV2("correct horse battery staple")).toBe("correct horse battery staple");
    expect(safeDescriptionV2("Sign in with Keycloak")).toBe("Sign in with Keycloak");
    expect(safeDescriptionV2("buyer@example.com")).toBe("buyer@example.com");
    expect(safeDescriptionV2(sk("proj-1234567890abcdefghijklmnopqrstuv"))).toBe(
      sk("proj-1234567890abcdefghijklmnopqrstuv"),
    );
    // The last payment screens are gone too: a rendered PAN and a labeled CVV
    // are page copy the agent is meant to read.
    expect(safeDescriptionV2("4111 1111 1111 1111")).toBe("4111 1111 1111 1111");
    expect(safeDescriptionV2("CVV 123")).toBe("CVV 123");
    expect(
      safePageSemanticsV2({
        title: "correcthorsebattery",
        headings: ["Create your account"],
      }),
    ).toEqual({ title: "correcthorsebattery", headings: ["Create your account"] });
    const button = element({ visibleText: "correcthorsebattery" });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:standalone-secret"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows[0]?.label).toBe("@correcthorsebattery");
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

  it("retains any structurally valid frame origin — no content screen remains", () => {
    expect(safeOriginV2("https://payments.example.com")).toBe("https://payments.example.com");
    // A long high-entropy subdomain is an ordinary host, not a secret.
    expect(safeOriginV2("https://apikeyabcdefghijklmnopqrstuvwxyz9.attacker.test")).toBe(
      "https://apikeyabcdefghijklmnopqrstuvwxyz9.attacker.test",
    );
    // Digits in the host are no longer card material to be hidden.
    expect(safeOriginV2("https://4111-1111-1111-1111.attacker.test")).toBe(
      "https://4111-1111-1111-1111.attacker.test",
    );
    const [retained] = sealRetainedInteractiveElementsV2([
      element({ frameOrigin: "https://4111-1111-1111-1111.attacker.test" }),
    ]);
    expect(retained?.frameOrigin).toBe("https://4111-1111-1111-1111.attacker.test");
    // A malformed origin is still rejected — that is validity, not masking.
    expect(safeOriginV2("not a url")).toBeNull();
  });

  it("emits the live page URL, path and query included", () => {
    const url = "https://ipinfo.io/signup?token=private-url-token-123456789";
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      pageUrl: url,
      rows: [],
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(page.payload).toMatchObject({ url });
  });

  it("prioritizes signup actions over unlabeled landing-page navigation", () => {
    const nav = ["Products", "Enterprise", "Resources", "Pricing"].map((visibleText, index) =>
      element({ index, visibleText }),
    );
    const signup = element({
      index: nav.length,
      tag: "a",
      visibleText: "Sign Up",
    });
    const safe = safeControls({
      elements: [...nav, signup],
      legacyRefs: new Map([...nav, signup].map((el, index) => [el, `@e:legacy-${index}`])),
      pageOrigin: "https://ipinfo.io",
    });
    expect(safe.rows[0]).toMatchObject({ role: "link", action: "signup" });
  });

  it("returns an intact first page and signed cursor below the final wire cap", () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      ref: `@e:${index.toString(36).padStart(18, "a")}`,
      role: "button" as const,
      visibility: "viewport" as const,
      frame: "main" as const,
      action: "continue" as const,
    }));
    const page = encodeV2QueryPage({
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

  it("degrades oversized start metadata instead of failing the page", () => {
    const denseHint = "!".repeat(OBSERVE_V2_MAX_WIRE_BYTES + 64);
    expect(Buffer.byteLength(JSON.stringify({ hint: denseHint }), "utf8")).toBeGreaterThan(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    // A hint this dense is dropped by the graceful metadata degradation — the
    // observation itself must never fail on real-world metadata.
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      rows: [],
      cursorFor: (offset) => `cursor-${offset}`,
      startMetadata: { hint: denseHint },
    });
    expect(page.payload.hint).toBeUndefined();
    expect(page.payload.safe_table).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(page.payload), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
  });

  it("drops title and headings before bounded blocker semantics under wire pressure", () => {
    const denseHint = "!".repeat(OBSERVE_V2_MAX_WIRE_BYTES + 64);
    const blockers = [
      {
        kind: "challenge" as const,
        text: "Please complete the verification challenge.",
        target: "unavailable" as const,
      },
    ];
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "auth",
      rows: [],
      cursorFor: (offset) => `cursor-${offset}`,
      semantics: { title: "Fixture login", headings: ["Sign in"], blockers },
      startMetadata: { hint: denseHint },
    });

    expect(page.payload.hint).toBeUndefined();
    expect(page.payload.semantic).toEqual({ blocked: true, blockers });
    expect(Buffer.byteLength(JSON.stringify(page.payload), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
  });

  it("keeps refs and focus within each visible challenge boundary", () => {
    const node = (id: string, overrides: Partial<BrowserUseNode>): BrowserUseNode => ({
      id,
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
    const text = (id: string, value: string): BrowserUseNode =>
      node(id, { nodeType: 3, nodeName: "#text", value });
    const checkboxA = node("checkbox-a", {
      nodeName: "INPUT",
      attributes: { type: "checkbox", "aria-label": "Verify you are human for account A" },
      axRole: "checkbox",
      axProperties: [{ name: "focusable", value: true }],
    });
    const checkboxB = node("checkbox-b", {
      nodeName: "INPUT",
      attributes: { type: "checkbox", "aria-label": "Verify you are human for account B" },
      axRole: "checkbox",
      axProperties: [
        { name: "focusable", value: true },
        { name: "focused", value: true },
      ],
    });
    const hiddenCheckbox = node("checkbox-complete", {
      nodeName: "INPUT",
      attributes: { type: "checkbox", "aria-label": "Verify you are human — Success" },
      axRole: "checkbox",
      axProperties: [{ name: "focused", value: true }],
    });
    const frameDocument = (id: string, checkbox: BrowserUseNode): BrowserUseNode =>
      node(id, {
        nodeType: 9,
        nodeName: "#document",
        children: [
          node(`${id}-label`, {
            nodeName: "LABEL",
            children: [checkbox, text(`${id}-text`, checkbox.attributes["aria-label"]!)],
          }),
        ],
      });
    const root = node("root", {
      nodeType: 9,
      nodeName: "#document",
      children: [
        node("challenge-a", {
          nodeName: "LABEL",
          children: [checkboxA, text("challenge-a-text", "Verify you are human for account A")],
        }),
        node("challenge-b", {
          nodeName: "IFRAME",
          attributes: { title: "Widget containing a Cloudflare security challenge" },
          contentDocument: frameDocument("frame-b", checkboxB),
        }),
        node("challenge-complete", {
          nodeName: "IFRAME",
          visible: false,
          attributes: { title: "Completed Turnstile verification challenge" },
          contentDocument: frameDocument("frame-complete", hiddenCheckbox),
        }),
      ],
    });

    expect(
      safeBlockersV2(root, (candidate) => (candidate === checkboxA ? "@e:challenge-a" : undefined)),
    ).toEqual([
      {
        kind: "challenge",
        text: "Verify you are human for account A",
        ref: "@e:challenge-a",
        focus: "focusable",
        keyboard: "tab_space",
      },
      {
        kind: "challenge",
        text: "Verify you are human for account B",
        target: "unavailable",
        focus: "focused",
        keyboard: "space",
      },
    ]);
  });

  it("shrinks a URL that exceeds the wire budget before packing so the first page keeps multiple rows", () => {
    const dense = Array.from({ length: 40 }, (_, index) =>
      element({
        index,
        visibleText: `Control ${index}`,
        selector: `#control-${index}`,
      }),
    );
    const safe = safeControls({
      elements: dense,
      legacyRefs: new Map(dense.map((control, index) => [control, `@e:legacy_${index}`])),
      pageOrigin: "https://merchant.invalid",
    });
    const idToken = "a".repeat(OBSERVE_V2_MAX_WIRE_BYTES + 256);
    const pageUrl = `https://merchant.invalid/auth/callback?id_token=${idToken}`;
    expect(Buffer.byteLength(pageUrl, "utf8")).toBeGreaterThan(OBSERVE_V2_MAX_WIRE_BYTES);
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "auth",
      pageUrl,
      rows: safe.rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    const firstPage = page.payload.safe_table as unknown[];
    expect(firstPage.length).toBeGreaterThan(1);
    expect(page.payload.url).toBe(pageUrl.slice(0, 512));
    expect(Buffer.byteLength(JSON.stringify(page.payload), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    const overflow = page.payload.overflow as
      | { remaining: number; next_cursor: string }
      | undefined;
    if (overflow !== undefined) {
      expect(overflow).toEqual({
        remaining: 40 - firstPage.length,
        next_cursor: `cursor-${firstPage.length}`,
      });
    }
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
    const safe = safeControls({
      elements: dense,
      legacyRefs: new Map(dense.map((control, index) => [control, `@e:legacy_${index}`])),
      pageOrigin: "https://merchant.invalid",
    });
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      semantics: { title: "Dense sample", headings: ["First controls"] },
      rows: safe.rows,
      cursorFor: (offset) => `cursor-${offset}`,
    });
    const wire = JSON.stringify(page.payload);
    expect(safe.rows).toHaveLength(94);
    // Budget-driven packing: rows fill the page until the wire budget is
    // actually reached — never clamped to a fixed first-page row count that
    // strands below-the-fold CTAs in overflow.
    const firstPage = page.payload.safe_table as unknown[];
    expect(firstPage.length).toBeGreaterThan(4);
    expect(page.payload.overflow).toEqual({
      remaining: 94 - firstPage.length,
      next_cursor: `cursor-${firstPage.length}`,
    });
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
    const safe = safeControls({
      elements: [input],
      legacyRefs: new Map([[input, "@e:email_1"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ role: "textbox", field: "email" })]);
    expect(JSON.stringify(safe.rows)).not.toContain("private@example.test");
  });

  it("keeps native submit inputs actionable and uses their value as a label", () => {
    const submit = element({
      tag: "input",
      type: "submit",
      role: null,
      value: "Create account",
      selector: "#create-account",
    });
    const safe = safeControls({
      elements: [submit],
      legacyRefs: new Map([[submit, "@e:submit"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({ role: "button", label: "@create-account", action: "signup" }),
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
    const safe = safeControls({
      elements: [otp, quantity],
      legacyRefs: new Map([
        [otp, "@e:otp"],
        [quantity, "@e:quantity"],
      ]),
      pageOrigin: "https://merchant.invalid",
    });
    const otpRow = safe.rows.find((row) => row.label === "@verification-code");
    const quantityRow = safe.rows.find((row) => row.label === "@quantity");
    expect(otpRow?.field).toBeUndefined();
    expect(quantityRow?.field).toBe("quantity");
  });

  it("carries the minted handle and a slugified addressable label", () => {
    const button = element({ visibleText: "private merchant copy" });
    const refs = new Map<InteractiveElement, string>([[button, "@e:stable_button"]]);
    const initial = safeControls({
      elements: [button],
      legacyRefs: refs,
      pageOrigin: "https://merchant.invalid",
    });
    const repeated = safeControls({
      elements: [button],
      legacyRefs: refs,
      pageOrigin: "https://merchant.invalid",
    });
    expect(initial.rows[0]).toEqual(
      expect.objectContaining({ ref: "@e:hhhhhhhhh1", label: "@private-merchant-copy" }),
    );
    // A re-serialization of the same element keeps the same ref: no churn.
    expect(repeated.rows[0]?.ref).toBe(initial.rows[0]?.ref);
  });

  it("accepts only well-formed handles that are current snapshot members", () => {
    const current = new Map([["@e:hhhhhhhhhhhhhhhhhhhhhh", "@e:legacy_current"]]);
    expect(compactV2LegacyRefForHandle(current, "@e:hhhhhhhhhhhhhhhhhhhhhh")).toBe(
      "@e:legacy_current",
    );
    expect(compactV2LegacyRefForHandle(current, "@e:iiiiiiiiiiiiiiiiiiiiii")).toBeNull(); // not a member
    expect(compactV2LegacyRefForHandle(current, "@e:hhhhhhhhhh")).toBeNull(); // malformed
    expect(compactV2LegacyRefForHandle(current, "@e:short")).toBeNull(); // not a member
    expect(compactV2LegacyRefForHandle(current, "@e:1.1")).toBeNull(); // legacy index form
    expect(compactV2LegacyRefForHandle(current, "@private-merchant-copy")).toBeNull(); // a label
  });

  it("slugs a label from the page description", () => {
    expect(controlLabelV2("Continue with Google")).toBe("@continue-with-google");
    expect(controlLabelV2(undefined)).toBeUndefined();
    expect(controlLabelV2("!!!")).toBeUndefined();
    expect(isCompactV2Label("@continue-with-google")).toBe(true);
    expect(isCompactV2Label("@e:hhhhhhhhhhhhhhhhhhhhhh")).toBe(false);
    expect(isCompactV2Handle("@e:hhhhhhhhhhhhhhhhhhhhhh")).toBe(true);
    expect(isCompactV2Handle("@e:hhhhhhhhhh")).toBe(false);
  });

  // 2026-09-06 ipinfo docs dogfood: headings glued to their descriptions by
  // the DOM (no whitespace between them) slugified into one unreadable run
  // and were hard-cut mid-word at LABEL_MAX_CHARS — the agent got 65 slugs it
  // could act on but not read. The label keeps the leading title (boundary
  // detected in the ORIGINAL name, before slugification erases it) and any
  // remaining cut lands on a word boundary.
  describe("label legibility for glued heading+description names", () => {
    it("keeps the leading title of the five real glued docs-page names", () => {
      const real = new Map<string, string>([
        // Observed broken labels:
        //   @database-downloadsdownload-ip-da, @api-referencecomplete-documentat,
        //   @client-librariesofficial-sdks-fo, @integrationsconnect-ipinfo-with,
        //   @c-search-ctrl-knavigationg
        [
          "Database DownloadsDownload IP-address databases for every use case",
          "@database-downloads",
        ],
        ["API ReferenceComplete documentation for every endpoint and field", "@api-reference"],
        ["Client LibrariesOfficial SDKs for every major programming language", "@client-libraries"],
        ["IntegrationsConnect IPinfo with the tools you already use", "@integrations"],
        ["C (Search Ctrl+K)Navigation Getting started with the docs", "@c-search-ctrl-k"],
      ]);
      for (const [name, expected] of real) {
        expect(controlLabelV2(name), name).toBe(expected);
      }
    });

    it("detects the title boundary from a newline in the accessible name", () => {
      expect(controlLabelV2("API Reference\nComplete documentation for every endpoint")).toBe(
        "@api-reference",
      );
    });

    it("cuts an over-length title on a word boundary, never mid-word", () => {
      const label = controlLabelV2("International Standard Organization Members List Directory");
      // The old behavior sliced at 32 chars: "...organizat".
      expect(label).toBe("@international-standard");
    });

    it("keeps ordinary names whole: camelCase stubs, abbreviations, short pairs", () => {
      // The camelCase seam's title "my" is a stub, not a heading — no split
      // (and the unsplit name slugs as one run).
      expect(controlLabelV2("myAccount")).toBe("@myaccount");
      // A period before a lowercase letter is an abbreviation ("Node.js"),
      // not a heading seam.
      expect(controlLabelV2("Node.js SDK")).toBe("@node-js-sdk");
      // No single-letter title is split out of the "U.S." abbreviation.
      expect(controlLabelV2("U.S. Government cloud documentation")).toBe("@u-s-government-cloud");
    });

    it("keeps title selection independent of credential shapes in its description", () => {
      expect(
        controlLabelV2("Database DownloadsDownload API key f9a062f02fadf5 for production"),
      ).toBe("@database-downloads");
      expect(
        controlLabelV2('IntegrationsConnect curl -H "Authorization: Bearer f9a062f02fadf5"'),
      ).toBe("@integrations");
    });

    it("composes with duplicate-label ordinals: links differing only in description stay distinguishable", () => {
      const a = controlLabelV2("Database DownloadsDownload IP geolocation accuracy data");
      const b = controlLabelV2("Database DownloadsDownload IP-to-ASN enrichment feeds");
      expect(a).toBe("@database-downloads");
      expect(b).toBe("@database-downloads");
      expect(disambiguateDuplicateLabelsV2([a, b])).toEqual([
        "@database-downloads",
        "@database-downloads-2",
      ]);
    });
  });

  it("disambiguates duplicate labels with a deterministic ordinal so identical rows are distinguishable", () => {
    // The /dashboard/token dogfood returned two distinct copy buttons both
    // labelled "curl example" — a correct pick was a coin flip.
    const first = element({ visibleText: "curl example", selector: "#copy-a" });
    const second = element({ visibleText: "curl example", selector: "#copy-b" });
    const safe = safeControls({
      elements: [first, second],
      legacyRefs: new Map([
        [first, "@e:copy_a"],
        [second, "@e:copy_b"],
      ]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows.map((row) => row.label)).toEqual(["@curl-example", "@curl-example-2"]);
    // Ordinals follow the map's own row order, so re-serializing the same
    // elements (in either extraction order, mapped to the same sorted rows)
    // keeps the numbering stable.
    const flipped = safeControls({
      elements: [second, first],
      legacyRefs: new Map([
        [second, "@e:copy_a"],
        [first, "@e:copy_b"],
      ]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(flipped.rows.map((row) => row.label)).toEqual(["@curl-example", "@curl-example-2"]);
  });

  it("skips an ordinal that would collide with an existing label", () => {
    expect(
      disambiguateDuplicateLabelsV2(["@curl-example", "@curl-example-2", "@curl-example"]),
    ).toEqual(["@curl-example", "@curl-example-2", "@curl-example-3"]);
    // Singles are untouched.
    expect(disambiguateDuplicateLabelsV2(["@one", undefined, "@two"])).toEqual([
      "@one",
      undefined,
      "@two",
    ]);
  });

  it("uses the native DOM label while retaining TS's local action ref", () => {
    const button = element({ visibleText: "Native serialized control" });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:continue"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^@e:/),
        label: "@native-serialized-control",
      }),
    ]);
  });

  describe("control-label source priority and fallbacks", () => {
    const labelsFor = (...elements: InteractiveElement[]): Array<string | undefined> =>
      safeControls({
        elements,
        legacyRefs: new Map(elements.map((el, index) => [el, `@e:label_${index}`])),
        pageOrigin: "https://merchant.invalid",
      }).rows.map((row) => row.label);

    it("prefers a concise aria-label over mashed descendant navigation text", () => {
      const navMenu = element({
        role: "menuitem",
        ariaLabel: "Shop men",
        visibleText: "Shop Men Shoes Apparel Accessories New Arrivals",
      });

      expect(labelsFor(navMenu)).toEqual(["@shop-men"]);
    });

    it("preserves a non-ASCII accessible name when ASCII slugging is empty", () => {
      expect(labelsFor(element({ ariaLabel: "設定" }))).toEqual(["@設定"]);
    });

    it("keeps Unicode aliases bounded and wire-safe", () => {
      const piped = labelsFor(element({ ariaLabel: "設定|詳細" }))[0]!;
      const long = labelsFor(element({ ariaLabel: "設定".repeat(40) }))[0]!;
      const { payload } = encodeV2QueryPage({
        sessionId: "session",
        stage: "browse",
        rows: [
          {
            ref: "@e:unicode",
            role: "button",
            visibility: "viewport",
            frame: "main",
            label: piped,
          },
          { ref: "@e:long", role: "button", visibility: "viewport", frame: "main", label: long },
        ],
        cursorFor: () => "cursor",
      });

      expect(piped).toBe("@設定-詳細");
      expect(long.endsWith("…")).toBe(true);
      expect(Array.from(long.slice(1))).toHaveLength(32);
      expect(isCompactV2Label(piped)).toBe(true);
      expect(isCompactV2Label(long)).toBe(true);
      const stable = new StableObservationRefs();
      stable.label("@e:first", long);
      const duplicate = stable.label("@e:second", long)!;
      expect(isCompactV2Label(duplicate)).toBe(true);
      expect(Array.from(duplicate.slice(1))).toHaveLength(32);
      expect(payload.safe_table).toEqual([
        ["@e:unicode", "b", "@設定-詳細"],
        ["@e:long", "b", long],
      ]);
    });

    it("preserves mixed Unicode accessible names", () => {
      const label = controlLabelV2("設定 Account");

      expect(label).toBe("@設定-account");
      expect(isCompactV2Label(label!)).toBe(true);
    });

    it("falls back to the emitted role when punctuation cannot form a label", () => {
      expect(labelsFor(element({ ariaLabel: "!!!" }))).toEqual(["@button-1"]);
    });

    it("falls back to the emitted role for combining marks alone", () => {
      expect(controlLabelV2("\u0301")).toBeUndefined();
      expect(labelsFor(element({ ariaLabel: "\u0301" }))).toEqual(["@button-1"]);
    });

    it("uses an associated label before a form control's visible subtree", () => {
      const input = element({
        tag: "input",
        type: "text",
        role: "textbox",
        labelText: "Work email",
        visibleText: "Account Settings Profile Notifications",
      });

      expect(labelsFor(input)).toEqual(["@work-email"]);
    });

    it("uses visible text before a descendant icon label", () => {
      expect(labelsFor(element({ visibleText: "Checkout", iconLabel: "Acme" }))).toEqual([
        "@checkout",
      ]);
    });

    it("uses a descendant icon label before a control title", () => {
      expect(labelsFor(element({ iconLabel: "Profile", title: "Open settings" }))).toEqual([
        "@profile",
      ]);
    });

    it("uses a text-content button's own visible name", () => {
      expect(labelsFor(element({ visibleText: "Create account" }))).toEqual(["@create-account"]);
    });

    it("uses textbox placeholder then name when no accessible or visible name exists", () => {
      const placeholder = element({
        tag: "input",
        type: "search",
        role: "searchbox",
        placeholder: "Search emails",
      });
      const name = element({
        index: 1,
        tag: "input",
        type: "email",
        role: "textbox",
        name: "email_address",
      });

      expect(labelsFor(placeholder, name)).toEqual(["@search-emails", "@email-address"]);
    });

    it("uses a control title when higher-priority naming signals are absent", () => {
      expect(labelsFor(element({ title: "Open command palette" }))).toEqual([
        "@open-command-palette",
      ]);
    });

    it("labels an otherwise anonymous control with its role and immediate context", () => {
      const button = element({ container: "navigation:account-menu" });
      const anonymousControls = [
        element({ index: 1 }),
        element({ index: 2, tag: "a", role: "link" }),
        element({ index: 3, tag: "input", type: "text", role: "textbox" }),
        element({ index: 4, tag: "select", role: "combobox" }),
        element({ index: 5, tag: "input", type: "checkbox", role: "checkbox" }),
        element({ index: 6, tag: "input", type: "radio", role: "radio" }),
        element({ index: 7, tag: "div", role: "tab" }),
        element({ index: 8, tag: "div", role: "menuitem" }),
        element({ index: 9, tag: "input", type: "file", role: null }),
        element({ index: 10, container: "section:section" }),
      ];

      const labels = labelsFor(button, ...anonymousControls);
      expect(labels).toContain("@account-menu-button");
      expect(labels).toContain("@button-2");
      expect(labels).toContain("@link-3");
      expect(labels).toContain("@textbox-4");
      expect(labels).toContain("@select-5");
      expect(labels).toContain("@checkbox-6");
      expect(labels).toContain("@radio-7");
      expect(labels).toContain("@tab-8");
      expect(labels).toContain("@menuitem-9");
      expect(labels).toContain("@file-10");
      expect(labels).toContain("@button-11");
      expect(labels.every((label) => label !== undefined && label.length > 1)).toBe(true);
    });

    it("uses the canonical emitted role for an otherwise unsupported control", () => {
      const slider = element({ tag: "div", role: "slider" });
      const safe = safeControls({
        elements: [slider],
        legacyRefs: new Map([[slider, "@e:slider"]]),
        pageOrigin: "https://merchant.invalid",
        canonical: true,
      });

      expect(safe.rows).toEqual([expect.objectContaining({ role: "slider", label: "@slider-1" })]);
    });
  });

  it.each(["usernametaken29", "trusty-squire-dogfood-20260625", "f9a062f02fadf5"])(
    "emits semantic titles and headings verbatim: %s",
    (value) => {
      expect(safePageSemanticsV2({ title: value, headings: [value] })).toEqual({
        title: value,
        headings: [value],
      });
    },
  );

  it("preserves short semantic essentials without rejecting card or secret-shaped text", () => {
    expect(
      safePageSemanticsV2({
        title: "Example storefront",
        // Only the FIRST heading is carried (a size budget); nothing is screened.
        headings: [
          "Create your account",
          "4111111111111111",
          "API key: abcdefghijklmnopqrstuvwxyz",
        ],
      }),
    ).toEqual({ title: "Example storefront", headings: ["Create your account"] });
    expect(
      safePageSemanticsV2({ title: "4111111111111111", headings: ["API key: abcdef"] }),
    ).toEqual({ title: "4111111111111111", headings: ["API key: abcdef"] });
    const button = element({ visibleText: "Continue to registration" });
    const cardLike = element({ selector: "#secret", visibleText: "4111111111111111" });
    const safe = safeControls({
      elements: [button, cardLike],
      legacyRefs: new Map([
        [button, "@e:continue"],
        [cardLike, "@e:card"],
      ]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toContainEqual(
      expect.objectContaining({ label: "@continue-to-registration" }),
    );
    expect(safe.rows).toContainEqual(expect.objectContaining({ label: "@4111111111111111" }));
  });

  it("preserves a page title in query semantic metadata without changing the query response", () => {
    const title = "Developer f9a062f02fadf5 Resource";
    const semantics = safePageSemanticsV2({ title, headings: ["Getting started"] });
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      semantics,
      rows: [],
      cursorFor: (offset) => `cursor-${offset}`,
    }).payload;
    expect(semantics).toEqual({
      title,
      headings: ["Getting started"],
    });
    expect(page).toEqual({
      format: "browser-use-control-query",
      url: "",
      session_id: "session",
      stage: "browse",
      semantic: semantics,
      safe_table: [],
    });
    expect(JSON.stringify(page)).toContain(title);
  });

  it("uses the explicit accessible name independently of descendant token shape", () => {
    const button = element({
      visibleText: "abcdefghijklmnopqrstuvwxyz123456",
      ariaLabel: "Copy API key",
    });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ label: "@copy-api-key" })]);
  });

  it("keeps word-like pure-alpha and low-entropy digit labels unscreened", () => {
    expect(controlLabelV2("authorization")).toBe("@authorization");
    expect(controlLabelV2("authentication")).toBe("@authentication");
    expect(controlLabelV2("4111111111111111")).toBe("@4111111111111111");
    expect(controlLabelV2("202609060941")).toBe("@202609060941");
    expect(controlLabelV2("deadbeefcafe")).toBe("@deadbeefcafe");
  });

  describe("rendered credential-shaped names are page content", () => {
    const values: readonly string[] = [
      sk("proj-abcdefghijklmnop1234567890"),
      sk("ant-api03-xyz"),
      sk("lw-0123456789abcdef"),
      ghp("0123456789abcdefghijklmnopqrstuvwxyz"),
      gho("0123456789abcdefghijklmnopqrstuvwxyz"),
      gpat("0123456789ABCDEFG_abcdefgh"),
      akia("IOSFODNN7EXAMPLE"),
      asia("IOSFODNN7EXAMPLE"),
      xoxb("123456789012-1234567890123-abc"),
      xoxp("123456789012-1234567890123-abc"),
      xoxr("123456789012-1234567890123-abc"),
      ghu("0123456789abcdefghijklmnopqrstuvwxyz"),
      ghs("0123456789abcdefghijklmnopqrstuvwxyz"),
      glpat("0123456789abcdefghijklmnopqrst"),
      aizasy("A0123456789abcdefghijklmnopqrstu"),
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
      "login | Bearer 9f8e7d6c5b4a",
      "curl -H 'Authorization: Bearer f9a062f02fadf5'",
      "token f9a062f02fadf5 (never expires)",
      "Your ipinfo access token is: f9a062f02fadf5",
      "Copy access token to clipboard: f9a062f02fadf5",
    ];
    it.each(values)("preserves %s verbatim in page descriptions", (value) => {
      // These fixtures fit the existing description limit; no shape-based rewrite is allowed.
      const expected = value.length <= 40 ? value : value.slice(0, 39) + "…";
      expect(safeDescriptionV2(value)).toBe(expected);
    });
  });

  it("uses the explicit accessible name independently of descendant card shape", () => {
    const button = element({
      visibleText: "4111 1111 1111 1111",
      ariaLabel: "Copy API key",
    });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ label: "@copy-api-key" })]);
  });

  it("matches every private query term against one control naming source", () => {
    const basic = element({ visibleText: "Buy Acme Basic" });
    const pro = element({ visibleText: "Buy Acme Pro" });
    expect(controlMatchesPrivateQueryV2(basic, "Acme Pro")).toBe(false);
    expect(controlMatchesPrivateQueryV2(pro, "Acme Pro")).toBe(true);
    expect(controlMatchesPrivateQueryV2(pro, "Acme-Pro")).toBe(true);

    const iphone15 = element({ visibleText: "Buy iPhone 15 Pro" });
    const iphone16 = element({ visibleText: "Buy iPhone 16 Pro" });
    expect(controlMatchesPrivateQueryV2(iphone15, "iPhone 16 Pro")).toBe(false);
    expect(controlMatchesPrivateQueryV2(iphone16, "iPhone 16 Pro")).toBe(true);

    const model2023 = element({ visibleText: "Buy Model 2023" });
    const model2024 = element({ visibleText: "Buy Model 2024" });
    expect(controlMatchesPrivateQueryV2(model2023, "Model 2024")).toBe(false);
    expect(controlMatchesPrivateQueryV2(model2024, "Model 2024")).toBe(true);
  });

  it("ranks exact names before local text and permits only explicit local context", () => {
    const exact = element({
      visibleText: "Open credentials",
      compactNames: {
        ariaLabel: "API keys",
        labelledByText: null,
        accessibleName: "API keys",
        labelText: null,
        visibleText: "Open credentials",
        alt: null,
        iconLabel: null,
        title: null,
        placeholder: null,
        name: null,
        value: null,
        container: "navigation:Developer settings",
      },
    });
    const local = element({ visibleText: "API keys export" });
    const broadSidebarNeighbor = element({
      visibleText: "Webhooks",
      compactNames: {
        ariaLabel: null,
        labelledByText: null,
        accessibleName: "Webhooks",
        labelText: null,
        visibleText: "Webhooks",
        alt: null,
        iconLabel: null,
        title: null,
        placeholder: null,
        name: null,
        value: null,
        container: "navigation:API keys",
      },
    });
    const dialogContext = element({
      visibleText: "Continue",
      compactNames: {
        ariaLabel: null,
        labelledByText: null,
        accessibleName: "Continue",
        labelText: null,
        visibleText: "Continue",
        alt: null,
        iconLabel: null,
        title: null,
        placeholder: null,
        name: null,
        value: null,
        container: "dialog:API keys",
      },
    });
    expect(controlQueryMatchV2(exact, "API keys")).toEqual({ rank: 0, provenance: "name" });
    expect(controlQueryMatchV2(local, "API keys")).toEqual({ rank: 2, provenance: "text" });
    expect(controlQueryMatchV2(broadSidebarNeighbor, "API keys")).toBeNull();
    expect(controlQueryMatchV2(dialogContext, "API keys")).toEqual({
      rank: 3,
      provenance: "context",
    });
  });

  it("classifies password-masked card security controls as payment fields", () => {
    const cvc = element({
      tag: "input",
      type: "password",
      role: "textbox",
      autocomplete: "cc-csc",
    });
    const safe = safeControls({
      elements: [cvc],
      legacyRefs: new Map([[cvc, "@e:cvc"]]),
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
    const safe = safeControls({
      elements: [cvc],
      legacyRefs: new Map([[cvc, "@e:cvc"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ field: "payment" })]);
    expect(safeStageV2("https://merchant.invalid/checkout", [cvc])).toBe("checkout");
  });

  it("uses checkout context for ambiguous security-code fields", () => {
    const securityCode = element({
      tag: "input",
      type: "password",
      role: "textbox",
      ariaLabel: "Security code",
    });
    const safe = safeControls({
      elements: [securityCode],
      legacyRefs: new Map([[securityCode, "@e:security-code"]]),
      pageOrigin: "https://merchant.invalid",
      pageUrl: "https://merchant.invalid/checkout",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ field: "payment" })]);
    expect(safeStageV2("https://merchant.invalid/checkout", [securityCode])).toBe("checkout");
    expect(safeStageV2("https://merchant.invalid/login", [securityCode])).toBe("auth");

    const cardVerification = element({
      tag: "input",
      type: "password",
      role: "textbox",
      ariaLabel: "Card verification number",
    });
    expect(safeStageV2("https://merchant.invalid/order", [cardVerification])).toBe("checkout");

    for (const [label, type] of [
      ["CVN", "tel"],
      ["CID", "text"],
    ] as const) {
      const verificationCode = element({
        tag: "input",
        type,
        role: "textbox",
        ariaLabel: label,
      });
      const contextual = safeControls({
        elements: [verificationCode],
        legacyRefs: new Map([[verificationCode, `@e:${label.toLowerCase()}`]]),
        pageOrigin: "https://merchant.invalid",
        pageUrl: "https://merchant.invalid/checkout",
      });
      expect(contextual.rows).toEqual([expect.objectContaining({ field: "payment" })]);
      expect(safeStageV2("https://merchant.invalid/checkout", [verificationCode])).toBe("checkout");
    }
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
    ).toBe("checkout");
    expect(
      safeStageV2("https://merchant.invalid/settings/security", [
        element({ tag: "input", type: "password", role: "textbox", labelText: "New password" }),
      ]),
    ).toBe("form");
    expect(
      safeStageV2("https://merchant.invalid/login", [
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
    ).toBe("form");
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
    const safe = safeControls({
      elements: [city, postal],
      legacyRefs: new Map([
        [city, "@e:city"],
        [postal, "@e:postal"],
      ]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({ field: "city", state: "r" }),
      expect.objectContaining({ field: "postal" }),
    ]);
  });

  it("keeps compact control state and finite action semantics on the wire", () => {
    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "form",
      rows: [
        {
          ref: "@e:1.1",
          role: "checkbox",
          visibility: "viewport",
          frame: "same_origin",
          label: "@terms",
          state: "u",
          action: "continue",
          field: "email",
          choice: "1/2",
        },
      ],
      cursorFor: (offset) => `cursor-${offset}`,
    });
    expect(page.payload.safe_table).toEqual([
      ["@e:1.1", "c", "@terms|s=u|a=continue|f=email|q=1/2|x=s"],
    ]);
  });
});

describe("compact-v2 query pages and region context", () => {
  const pageWithRows = (overrides: Partial<Parameters<typeof encodeV2QueryPage>[0]> = {}) => {
    const el = element({ visibleText: "Continue" });
    const safe = safeControls({
      elements: [el],
      legacyRefs: new Map([[el, "@e:continue"]]),
      pageOrigin: "https://shop.example.com",
    });
    return encodeV2QueryPage({
      sessionId: "session",
      stage: "browse",
      rows: safe.rows,
      cursorFor: (offset) => `cursor-${offset}`,
      ...overrides,
    });
  };

  it("query pages have no separate text channel", () => {
    expect(pageWithRows().payload).not.toHaveProperty("text");
    expect(pageWithRows().payload).not.toHaveProperty("text_unavailable");
  });

  it("attaches page region context to uninformative label slugs", () => {
    // The ipinfo dogfood's /dashboard/token read "@as15169" — an opaque ASN
    // fragment. The region's own name gives the agent something to act on.
    const el = element({ visibleText: "as15169", container: "section:as-details" });
    const safe = safeControls({
      elements: [el],
      legacyRefs: new Map([[el, "@e:as"]]),
      pageOrigin: "https://shop.example.com",
    });
    expect(safe.rows[0]!.label).toBe("@as15169-as-details");
  });

  it("keeps informative labels untouched and includes credential-shaped region context", () => {
    const informative = element({
      visibleText: "Continue checkout",
      container: "main:checkout",
    });
    const opaque = element({ visibleText: "1w", container: `section:${sk("proj-abcdefghij")}` });
    const safe = safeControls({
      elements: [informative, opaque],
      legacyRefs: new Map([
        [informative, "@e:continue"],
        [opaque, "@e:one-week"],
      ]),
      pageOrigin: "https://shop.example.com",
    });
    // A legible label gains nothing from context — bytes stay on the map.
    expect(safe.rows[0]!.label).toBe("@continue-checkout");
    // Region headings are page content, including vendor-key-shaped text.
    expect(safe.rows[1]!.label).toBe("@1w-sk-proj-abcdefghij");
  });
});

describe("persistent action anchor allocator", () => {
  const node = (identity: string, intent = "continue") =>
    ({
      observationIdentity: identity,
      observationIntent: intent,
    }) as InteractiveElement;
  it("uses session-separated 132-bit capabilities and refuses unbound or duplicate identity", () => {
    const first = new StableObservationRefs();
    const second = new StableObservationRefs();
    const elements = Array.from({ length: 1000 }, (_, i) => node(String(i)));
    const refs = first.actions("document", elements);
    expect(new Set(refs.values()).size).toBe(elements.length);
    const other = second.actions("document", elements);
    for (const el of elements) {
      expect(refs.get(el)).toMatch(/^@e:[A-Za-z0-9_-]{22}$/);
      expect(refs.get(el)).not.toBe(other.get(el));
    }
    expect(first.actions("document", [node("same"), node("same")]).size).toBe(0);
    expect(first.actions("document", [{} as InteractiveElement]).size).toBe(0);
  });
  it("retires missing and changed anchors without reviving refs or aliases", () => {
    const refs = new StableObservationRefs();
    const held = node("physical");
    const original = refs.actions("doc", [held]).get(held)!;
    expect(refs.label(original, "@continue")).toBe("@continue");
    const changed = node("physical", "delete");
    const changedRef = refs.actions("doc", [changed]).get(changed)!;
    expect(changedRef).not.toBe(original);
    const restored = refs.actions("doc", [held]).get(held)!;
    expect(restored).not.toBe(original);
    expect(refs.label(restored, "@continue")).toBe("@continue-2");
    refs.actions("doc", []);
    const returned = refs.actions("doc", [held]).get(held)!;
    expect(returned).not.toBe(restored);
    expect(refs.label(returned, "@continue")).toBe("@continue-3");
    expect(refs.actions("next-doc", [held]).get(held)).not.toBe(returned);
  });
});
