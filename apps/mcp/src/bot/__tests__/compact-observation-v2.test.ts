import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  OBSERVE_V2_MAX_WIRE_BYTES,
  REDACTED_SECRET_LABEL_V2,
  buildSafeControlsV2,
  compactV2LegacyRefForHandle,
  controlLabelV2,
  isCompactV2Handle,
  isCompactV2Label,
  looksLikeSecretShapedName,
  controlMatchesPrivateQueryV2,
  disambiguateDuplicateLabelsV2,
  encodeV2QueryPage,
  safePageSemanticsV2,
  safeDescriptionV2,
  safeOriginV2,
  redactObservationProseV2,
  sealRetainedInteractiveElementsV2,
  safeStageV2,
} from "../compact-observation-v2.js";
import type { InteractiveElement } from "../browser.js";

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

  it("redacts a credential-shaped accessible name but keeps the row actionable", () => {
    const button = element({ visibleText: "Copy api_1234567890123" });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy-secret"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([
      expect.objectContaining({
        ref: "@e:hhhhhhhhh1",
        role: "button",
        label: REDACTED_SECRET_LABEL_V2,
      }),
    ]);
  });

  // Live evidence (2026-09-06 ipinfo dogfood, Finding 1): on /dashboard and
  // /dashboard/token the action map emitted the account's LIVE api token as
  // the copy button's label — `["@e:6b3eXuaBV7","b","@f9a062f02fadf5"]` — and
  // a curl example's label carried its first four characters. Both labels are
  // reproduced below verbatim from the captured maps; the token itself is
  // reconstructed to the same 14-lowercase-hex shape.
  describe("ipinfo captured-map regression", () => {
    const token = "f9a062f02fadf5"; // 14 lowercase hex — ipinfo's live token shape

    it("redacts the copy-token button's label and keeps ref + role + actionability", () => {
      const copyToken = element({ visibleText: token });
      const safe = buildSafeControlsV2({
        elements: [copyToken],
        legacyRefs: new Map([[copyToken, "@e:6b3eXuaBV7"]]),
        handles: new Map([[copyToken, "@e:6b3eXuaBV7"]]),
        pageOrigin: "https://ipinfo.invalid",
      });
      expect(safe.rows).toHaveLength(1);
      expect(safe.rows[0]).toEqual(
        expect.objectContaining({ ref: "@e:6b3eXuaBV7", role: "button" }),
      );
      expect(safe.rows[0]?.label).toBe(REDACTED_SECRET_LABEL_V2);
      const page = encodeV2QueryPage({
        sessionId: "session",
        stage: "browse",
        rows: safe.rows,
        cursorFor: (offset) => `cursor-${offset}`,
      });
      expect(page.payload.safe_table).toEqual([["@e:6b3eXuaBV7", "b", REDACTED_SECRET_LABEL_V2]]);
      expect(JSON.stringify(page.payload)).not.toContain(token);
    });

    it("redacts the curl example whose truncated label carried the token fragment", () => {
      const curlExample = element({
        visibleText: `curl -H "Authorization: Bearer ${token}"`,
      });
      const safe = safeControls({
        elements: [curlExample],
        legacyRefs: new Map([[curlExample, "@e:curl-ex"]]),
        pageOrigin: "https://ipinfo.invalid",
      });
      expect(safe.rows[0]?.label).toBe(REDACTED_SECRET_LABEL_V2);
      const page = encodeV2QueryPage({
        sessionId: "session",
        stage: "browse",
        rows: safe.rows,
        cursorFor: (offset) => `cursor-${offset}`,
      });
      const wire = JSON.stringify(page.payload);
      expect(wire).not.toContain(token);
      expect(wire).not.toContain("f9a0");
    });

    it("screens the full name when the description budget would cut the token short", () => {
      // A 28-31 char preamble pushes the bare token across the 40-char
      // description cut, leaving fewer than the entropy screen's minimum run;
      // the label must be screened on the untruncated name so no leading
      // fragment survives into the slug.
      for (const visibleText of [
        `Your ipinfo access token is: ${token}`,
        `Copy access token to clipboard: ${token}`,
      ]) {
        const control = element({ visibleText });
        const safe = buildSafeControlsV2({
          elements: [control],
          legacyRefs: new Map([[control, "@e:preamble"]]),
          handles: new Map([[control, "@e:preamble"]]),
          pageOrigin: "https://ipinfo.invalid",
        });
        expect(safe.rows[0]?.label, visibleText).toBe(REDACTED_SECRET_LABEL_V2);
        expect(safe.rows[0], visibleText).toEqual(
          expect.objectContaining({ ref: "@e:preamble", role: "button" }),
        );
        const page = encodeV2QueryPage({
          sessionId: "session",
          stage: "browse",
          rows: safe.rows,
          cursorFor: (offset) => `cursor-${offset}`,
        });
        const wire = JSON.stringify(page.payload);
        expect(wire, visibleText).not.toContain(token);
        expect(wire, visibleText).not.toContain("f9a0");
      }
    });

    it("keeps a redacted query result actionable", () => {
      const copyToken = element({ visibleText: token });
      const safe = buildSafeControlsV2({
        elements: [copyToken],
        legacyRefs: new Map([[copyToken, "@e:6b3eXuaBV7"]]),
        handles: new Map([[copyToken, "@e:6b3eXuaBV7"]]),
        pageOrigin: "https://ipinfo.invalid",
      });
      const { payload } = encodeV2QueryPage({
        sessionId: "session",
        stage: "browse",
        rows: safe.rows,
        cursorFor: () => "cursor",
      });
      expect(payload).not.toBeNull();
      expect(payload!.safe_table).toEqual([["@e:6b3eXuaBV7", "b", REDACTED_SECRET_LABEL_V2]]);
      expect(JSON.stringify(payload)).not.toContain(token);
    });

    it("keeps every legitimate captured label verbatim", () => {
      const expected: Readonly<Record<string, string>> = {
        "View Plans & Pricing": "@view-plans-pricing",
        AS15169: "@as15169",
        "8.8.8.8": "@8-8-8-8",
        "1.1.1.1": "@1-1-1-1",
        bmbmlite: "@bmbmlite",
        "curl example": "@curl-example",
      };
      for (const [visibleText, label] of Object.entries(expected)) {
        const control = element({ visibleText });
        const safe = safeControls({
          elements: [control],
          legacyRefs: new Map([[control, "@e:legit"]]),
          pageOrigin: "https://ipinfo.invalid",
        });
        expect(safe.rows[0]?.label, visibleText).toBe(label);
      }
    });

    it("gives each redacted row a stable per-observation discriminator", () => {
      const first = element({ visibleText: "550e8400-e29b-41d4-a716-446655440000" });
      const second = element({ visibleText: "Copy 3kR9xQ2m-7LpW4vZn" });
      const safe = buildSafeControlsV2({
        elements: [first, second],
        legacyRefs: new Map([
          [first, "@e:legit1"],
          [second, "@e:legit2"],
        ]),
        handles: new Map([
          [first, "@e:legit1"],
          [second, "@e:legit2"],
        ]),
        pageOrigin: "https://ipinfo.invalid",
      });
      const labels = safe.rows.map((row) => row.label).sort();
      expect(labels).toEqual(["@redacted-secret", "@redacted-secret-2"]);
      // Both rows survive with ref, role, and label — clickable by ref.
      expect(safe.rows.map((row) => row.ref).sort()).toEqual(["@e:legit1", "@e:legit2"]);
      expect(safe.rows.every((row) => row.role === "button")).toBe(true);
    });
  });

  it("screens the derived composite label even when only the slug would leak", () => {
    // The description survives truncation intact but the SLUG truncates at 32
    // chars, carrying the token's first four characters; the marker replaces
    // the whole slug, so no fragment leaks either way.
    expect(controlLabelV2(`curl -H "Authorization: Bearer f9a062f02fadf5"`)).toBe(
      REDACTED_SECRET_LABEL_V2,
    );
    expect(controlLabelV2("Bearer f9a062f02f")).toBe(REDACTED_SECRET_LABEL_V2);
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

  it("keeps native submit inputs actionable and screens their value as a label", () => {
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
    const current = new Map([["@e:hhhhhhhhh1", "@e:legacy_current"]]);
    expect(compactV2LegacyRefForHandle(current, "@e:hhhhhhhhh1")).toBe("@e:legacy_current");
    expect(compactV2LegacyRefForHandle(current, "@e:hhhhhhhhh2")).toBeNull(); // not a member
    expect(compactV2LegacyRefForHandle(current, "@e:short")).toBeNull(); // malformed
    expect(compactV2LegacyRefForHandle(current, "@e:1.1")).toBeNull(); // legacy index form
    expect(compactV2LegacyRefForHandle(current, "@private-merchant-copy")).toBeNull(); // a label
  });

  it("slugs a label only from a screened description", () => {
    expect(controlLabelV2("Continue with Google")).toBe("@continue-with-google");
    expect(controlLabelV2(undefined)).toBeUndefined();
    expect(controlLabelV2("!!!")).toBeUndefined();
    expect(isCompactV2Label("@continue-with-google")).toBe(true);
    expect(isCompactV2Label("@e:hhhhhhhhh1")).toBe(false);
    expect(isCompactV2Handle("@e:hhhhhhhhh1")).toBe(true);
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

    it("stays secret-screened FIRST: a bare token behind a heading still redacts", () => {
      // The title-preference change must not let a secret-shaped name slip
      // through as a tidy title: the screen runs on the UNTRUNCATED name
      // before any splitting or cutting.
      expect(
        controlLabelV2("Database DownloadsDownload API key f9a062f02fadf5 for production"),
      ).toBe(REDACTED_SECRET_LABEL_V2);
      expect(
        controlLabelV2(`IntegrationsConnect curl -H "Authorization: Bearer f9a062f02fadf5"`),
      ).toBe(REDACTED_SECRET_LABEL_V2);
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

  it("redacts a prefixless high-entropy token rendered as the accessible name", () => {
    const button = element({
      visibleText: "abcdefghijklmnopqrstuvwxyz123456",
      ariaLabel: "Copy API key",
    });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ label: REDACTED_SECRET_LABEL_V2 })]);
  });

  it("keeps word-like pure-alpha and low-entropy digit labels unscreened", () => {
    expect(controlLabelV2("authorization")).toBe("@authorization");
    expect(controlLabelV2("authentication")).toBe("@authentication");
    expect(controlLabelV2("4111111111111111")).toBe("@4111111111111111");
    expect(controlLabelV2("202609060941")).toBe("@202609060941");
    expect(controlLabelV2("deadbeefcafe")).toBe("@deadbeefcafe");
  });

  describe("secret-shaped-name screen (vendor prefixes and shapes)", () => {
    const redacted: readonly string[] = [
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
    const kept: readonly string[] = [
      "View plans & pricing",
      "AS15169",
      "8.8.8.8",
      "1.1.1.1",
      "bmbmlite",
      "curl example",
      "Copy API key",
      "authorization",
      "authentication",
      "xoxo gossip girl club",
      "task-management-101",
      "standard-bearer of the fleet",
      "user@example.com",
      "4111 1111 1111 1111",
      "SKU-12345",
      "v1.2.3",
    ];

    it("redacts every vendor-prefixed or token-shaped name", () => {
      for (const value of redacted) expect(looksLikeSecretShapedName(value), value).toBe(true);
    });

    it("keeps ordinary UI copy", () => {
      for (const value of kept) expect(looksLikeSecretShapedName(value), value).toBe(false);
    });

    it("scores a hyphen/underscore-grouped credential as one joined run", () => {
      // Grouped credential bodies (base64url grouping, license keys) would
      // otherwise slip through as short segments.
      expect(looksLikeSecretShapedName("Copy f9a062f0-2fadf5ab-9c1d2e3f"), "hex groups").toBe(true);
      expect(looksLikeSecretShapedName("Copy 3kR9xQ2m-7LpW4vZn"), "base62 groups").toBe(true);
      expect(
        looksLikeSecretShapedName("550e8400-e29b-41d4-a716-446655440000"),
        "canonical v4 UUID",
      ).toBe(true);
      expect(looksLikeSecretShapedName("key_3kR9xQ2m_7LpW4vZn"), "underscore groups").toBe(true);
      // Ordinary hyphenated copy never produces a joined candidate: segments
      // shorter than 4 chars, pure-alpha joins, and letterless digit joins stay.
      expect(looksLikeSecretShapedName("SKU-12345")).toBe(false);
      expect(looksLikeSecretShapedName("task-management-101")).toBe(false);
      expect(looksLikeSecretShapedName("8.8.8.8")).toBe(false);
    });

    it("is length + character-class + entropy: a bare hex run needs entropy, not a prefix", () => {
      expect(looksLikeSecretShapedName("f9a062f02fadf5")).toBe(true);
      expect(looksLikeSecretShapedName("a1b2c3d4e5f6a7b8")).toBe(true);
      // Low-entropy digit runs (dates, Luhn-valid PANs, counters) stay.
      expect(looksLikeSecretShapedName("4111111111111111")).toBe(false);
      expect(looksLikeSecretShapedName("111111111111")).toBe(false);
      // High-entropy digit-bearing base62 run with no prefix.
      expect(looksLikeSecretShapedName("Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz")).toBe(true);
    });

    it("fails toward redaction on ambiguous truncations of anchored shapes", () => {
      // A 40-char description budget can cut a key mid-body; the anchored
      // shapes must still screen on the visible fragment.
      expect(looksLikeSecretShapedName(sk("live-12345678"))).toBe(true);
      expect(looksLikeSecretShapedName(akia("IOSFODNN7EXAM"))) /* truncated */
        .toBe(true);
      expect(looksLikeSecretShapedName("Bearer f9a062")).toBe(true);
    });
  });

  it("uses the visible text even when it is card material — no accessibility fallback", () => {
    const button = element({
      visibleText: "4111 1111 1111 1111",
      ariaLabel: "Copy API key",
    });
    const safe = safeControls({
      elements: [button],
      legacyRefs: new Map([[button, "@e:copy"]]),
      pageOrigin: "https://merchant.invalid",
    });
    expect(safe.rows).toEqual([expect.objectContaining({ label: "@4111-1111-1111-1111" })]);
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

describe("compact-v2 query pages and shared substring screen", () => {
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

  it("attaches a screened region context to uninformative label slugs", () => {
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

  it("keeps informative labels untouched and never uses a secret-shaped region as context", () => {
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
    // The region heading is vendor-key-shaped: the shared screen keeps it out.
    expect(safe.rows[1]!.label).toBe("@1w");
  });

  it("redactObservationProseV2 redacts grouped credentials exactly when the label screen would", () => {
    // Hyphen/underscore-grouped credentials (UUIDs, grouped base64url) must
    // not survive prose because grouping kept every plain run under the
    // 12-char floor — the same strings screen as labels.
    const grouped = [
      "Your key: 3kR9xQ2m-7LpW4vZn — keep it safe.",
      "Token 550e8400-e29b-41d4-a716-446655440000 has been created.",
      "License AAAE2F9K-Q2m7LpW4-vZn3kR9x expired.",
    ];
    for (const item of grouped) {
      expect(looksLikeSecretShapedName(item)).toBe(true);
    }
    expect(grouped.map(redactObservationProseV2)).toEqual([
      "Your key: [redacted] — keep it safe.",
      "Token [redacted] has been created.",
      "License [redacted] expired.",
    ]);
    // Ordinary grouped copy with short or low-entropy segments survives.
    expect(["See SKU-12345 and task-management-101."].map(redactObservationProseV2)).toEqual([
      "See SKU-12345 and task-management-101.",
    ]);
  });

  it("preserves whitespace and repeated text for the canonical renderer", () => {
    expect(redactObservationProseV2("\tRepeated  words\n\tRepeated  words")).toBe(
      "\tRepeated  words\n\tRepeated  words",
    );
  });
});
