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

describe("CDN/gateway error pages are named, not mistaken for a normal page", () => {
  it("reports a CloudFront 403 block from its title", () => {
    expect(
      safePageSemanticsV2({
        title: "ERROR: The request could not be satisfied",
        headings: ["403 ERROR"],
      }),
    ).toEqual({
      // The emitted title keeps the 40-char row budget; the signature matched
      // against the untruncated title, so the blocker names the full sentence.
      title: "ERROR: The request could not be satisfi…",
      headings: ["403 ERROR"],
      blocked: true,
      blockers: [{ kind: "error_page", text: "ERROR: The request could not be satisfied" }],
    });
  });

  it("does not name a bare status refusal as a CDN wall", () => {
    // "403 Forbidden" is the canonical ORIGIN refusal (Apache, nginx, a
    // framework permission page), whose remedy is a different identity or a
    // re-submitted form — not the abandoned step error_page implies.
    for (const source of [
      { title: "403 Forbidden", headings: [] },
      { title: "HTTP response status codes", headings: ["403 Forbidden"] },
    ]) {
      expect(safePageSemanticsV2(source).blocked).toBeUndefined();
    }
  });

  it("names the wall from the h1 when the title carries no signature", () => {
    expect(safePageSemanticsV2({ title: "example.com", headings: ["403 ERROR"] }).blockers).toEqual(
      [{ kind: "error_page", text: "403 ERROR" }],
    );
  });

  it("leaves a passable Cloudflare challenge interstitial as a challenge, not a wall", () => {
    // "Attention Required! | Cloudflare" is the managed-challenge page the
    // operator is built to clear; relabelling it error_page would tell the host
    // agent it hit a wall on a page it can pass.
    const semantics = safePageSemanticsV2({
      title: "Attention Required! | Cloudflare",
      headings: ["Verify you are human"],
    });
    expect(semantics.blocked).toBeUndefined();
    expect(semantics.blockers).toBeUndefined();
  });

  it("does not treat content-missing pages as blocks", () => {
    for (const title of ["404 Not Found", "410 Gone"]) {
      expect(safePageSemanticsV2({ title, headings: [] }).blocked).toBeUndefined();
    }
  });

  it("does not treat transient origin failures as walls", () => {
    // A 5xx/429 is retry-and-continue; calling it a wall invites the host agent
    // to abandon a recoverable step.
    for (const title of [
      "429 Too Many Requests",
      "500 Internal Server Error",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Time-out",
    ]) {
      expect(safePageSemanticsV2({ title, headings: [] }).blocked).toBeUndefined();
    }
  });

  it("does not name an app-authorization page as a CDN wall", () => {
    // Jenkins and several admin consoles title their permission page exactly
    // "Access Denied". The remedy is a different identity, not a bot wall, and
    // calling it error_page invites abandoning a recoverable step.
    for (const title of ["Access Denied", "Request blocked"]) {
      expect(safePageSemanticsV2({ title, headings: [] }).blocked).toBeUndefined();
    }
  });

  it("reports vendor block-wall vocabulary from the title or the heading", () => {
    expect(
      safePageSemanticsV2({ title: "Example Domain", headings: ["Sorry, you have been blocked"] })
        .blockers,
    ).toEqual([{ kind: "error_page", text: "Sorry, you have been blocked" }]);
  });

  it("does not flag ordinary content that merely discusses HTTP errors", () => {
    for (const source of [
      { title: "403 Forbidden - HTTP | MDN", headings: ["403 Forbidden"] },
      { title: "Handling request blocked events", headings: ["Overview"] },
      { title: "CloudFront distributions", headings: ["Distribution settings"] },
      { title: "Fixing Error - 403 on your bucket", headings: ["Troubleshooting"] },
      { title: "Attention required: verify your identity", headings: ["Verify your identity"] },
    ]) {
      const semantics = safePageSemanticsV2(source);
      expect(semantics.blocked).toBeUndefined();
      expect(semantics.blockers).toBeUndefined();
    }
  });

  it("ignores ordinary titles and headings", () => {
    expect(
      safePageSemanticsV2({ title: "Your Cart", headings: ["Review your order"] }).blocked,
    ).toBeUndefined();
  });
});

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

  it("sheds dialog detail and options before it would drop the blocked signal", () => {
    // Two multi-byte dialog blockers overrun the byte budget the char caps do
    // not track. Deleting `semantic` to fit emitted a blocked page as an
    // UNBLOCKED one, which is the inverse of what the blocker exists to say.
    const japanese = (count: number) => "住所を確認してください".repeat(count).slice(0, count);
    const blockers = Array.from({ length: 3 }, (_, blocker) => ({
      kind: "dialog" as const,
      text: japanese(160),
      ref: `@e:close-${blocker}`,
      options: Array.from({ length: 6 }, (_, index) => ({
        ref: `@e:opt-${blocker}-${index}`,
        label: japanese(48),
      })),
      detail: japanese(400),
    }));
    // Shedding detail alone is not enough at this size, so options go too.
    expect(
      Buffer.byteLength(
        JSON.stringify(blockers.map(({ detail: _detail, ...rest }) => rest)),
        "utf8",
      ),
    ).toBeGreaterThan(OBSERVE_V2_MAX_WIRE_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ blockers }), "utf8")).toBeGreaterThan(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );

    const page = encodeV2QueryPage({
      sessionId: "session",
      stage: "checkout",
      rows: [],
      cursorFor: (offset) => `cursor-${offset}`,
      semantics: { title: japanese(40), headings: [japanese(40)], blockers },
    });

    const semantic = page.payload.semantic as {
      blocked?: true;
      blockers?: Array<{ kind: string; detail?: string; options?: unknown }>;
    };
    expect(semantic?.blocked).toBe(true);
    expect(semantic.blockers?.map((blocker) => blocker.kind)).toEqual([
      "dialog",
      "dialog",
      "dialog",
    ]);
    for (const blocker of semantic.blockers ?? []) {
      expect(blocker.detail).toBeUndefined();
      expect(blocker.options).toBeUndefined();
    }
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

  describe("solved Turnstile challenge", () => {
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
    const challengeIframe = (id: string, innerText?: string): BrowserUseNode =>
      node(id, {
        nodeName: "IFRAME",
        attributes: {
          title: "Widget containing a Cloudflare security challenge",
          src: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile",
        },
        contentDocument:
          innerText === undefined
            ? null
            : node(`${id}-doc`, {
                nodeType: 9,
                nodeName: "#document",
                children: [text(`${id}-t`, innerText)],
              }),
      });
    const responseInput = (id: string, token: string): BrowserUseNode =>
      node(id, {
        nodeName: "INPUT",
        attributes: { type: "hidden", name: "cf-turnstile-response", value: token },
      });
    const hostPage = (children: BrowserUseNode[]): BrowserUseNode =>
      node("root", { nodeType: 9, nodeName: "#document", children });

    it("keeps reporting an unsolved widget with an empty response token", () => {
      const root = hostPage([
        node("wrapper", {
          attributes: { class: "cf-turnstile" },
          children: [challengeIframe("frame"), responseInput("response", "")],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([
        {
          kind: "challenge",
          text: "Widget containing a Cloudflare security challenge",
          target: "unavailable",
        },
      ]);
    });

    it("stops reporting the challenge once the response token is populated", () => {
      const root = hostPage([
        node("wrapper", {
          attributes: { class: "cf-turnstile" },
          children: [challengeIframe("frame"), responseInput("response", "0.token123")],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([]);
    });

    it("stops reporting the challenge for a cf-chl-widget response token sibling", () => {
      const root = hostPage([
        node("form", {
          nodeName: "FORM",
          children: [
            challengeIframe("frame"),
            node("response", {
              nodeName: "INPUT",
              attributes: {
                type: "hidden",
                name: "cf-chl-widget-abc123_response",
                value: "0.token123",
              },
            }),
          ],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([]);
    });

    it("keeps unrelated host success blocked until a real token arrives", () => {
      const response = responseInput("response", "");
      const root = hostPage([
        node("form", {
          nodeName: "FORM",
          children: [challengeIframe("frame"), text("success", "Success!"), response],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([
        {
          kind: "challenge",
          text: "Widget containing a Cloudflare security challenge",
          target: "unavailable",
        },
      ]);
      response.attributes.value = "0.token123";
      expect(safeBlockersV2(root)).toEqual([]);
    });

    it.each(["element", "shadow root"])(
      "associates nested %s widgets with isolated Turnstile hosts",
      (layout) => {
        const firstResponse = responseInput("response-a", "");
        const secondResponse = responseInput("response-b", "");
        const wrapper = (id: string, response: BrowserUseNode): BrowserUseNode =>
          node(`wrapper-${id}`, {
            attributes: { class: "cf-turnstile" },
            children: [
              node(`inner-${id}`, {
                ...(layout === "shadow root"
                  ? { nodeType: 11, nodeName: "#document-fragment", shadowType: "closed" }
                  : {}),
                children: [challengeIframe(`frame-${id}`)],
              }),
              response,
            ],
          });
        const root = hostPage([
          node("section", {
            attributes: { class: "captcha-section" },
            children: [wrapper("a", firstResponse), wrapper("b", secondResponse)],
          }),
        ]);
        expect(safeBlockersV2(root)).toHaveLength(1);
        firstResponse.attributes.value = "0.token123";
        expect(safeBlockersV2(root)).toHaveLength(1);
        secondResponse.attributes.value = "0.token456";
        expect(safeBlockersV2(root)).toEqual([]);
        firstResponse.attributes.value = "";
        expect(safeBlockersV2(root)).toHaveLength(1);
      },
    );

    it("requires a token even when the host and iframe display success", () => {
      const response = responseInput("response", "");
      const root = hostPage([
        node("wrapper", {
          attributes: { class: "cf-turnstile", "data-state": "success" },
          children: [challengeIframe("frame", "Success!"), response],
        }),
      ]);
      expect(safeBlockersV2(root)).toHaveLength(1);
      response.attributes.value = "0.token123";
      expect(safeBlockersV2(root)).toEqual([]);
    });

    it("does not associate a shared sibling token with multiple iframe widgets", () => {
      const root = hostPage([
        node("section", {
          attributes: { class: "captcha-section" },
          children: [
            challengeIframe("frame-a"),
            challengeIframe("frame-b"),
            responseInput("response", "0.token123"),
          ],
        }),
      ]);
      expect(safeBlockersV2(root)).toHaveLength(1);
    });

    it.each([true, undefined])(
      "does not infer completion from viewport exclusion with rendered=%s",
      (rendered) => {
        const frame = challengeIframe("frame");
        frame.visible = false;
        if (rendered === undefined) delete frame.rendered;
        else frame.rendered = rendered;
        frame.bounds = { x: 0, y: 2000, width: 300, height: 80 };
        const response = responseInput("response", "");
        const root = hostPage([
          node("wrapper", {
            attributes: { class: "cf-turnstile" },
            children: [frame, response],
          }),
        ]);
        expect(safeBlockersV2(root)).toHaveLength(1);
        response.attributes.value = "0.token123";
        expect(safeBlockersV2(root)).toEqual([]);
      },
    );

    it("omits a collapsed iframe inside a challenge wrapper", () => {
      const frame = challengeIframe("frame");
      frame.visible = false;
      frame.rendered = false;
      const root = hostPage([
        node("wrapper", {
          attributes: { class: "cf-turnstile" },
          children: [frame, responseInput("response", "")],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([]);
    });

    it("never lets one solved widget clear a different unsolved widget", () => {
      const root = hostPage([
        node("wrapper-a", {
          attributes: { class: "cf-turnstile" },
          children: [challengeIframe("frame-a"), responseInput("response-a", "0.token123")],
        }),
        node("wrapper-b", {
          attributes: { class: "cf-turnstile" },
          children: [challengeIframe("frame-b"), responseInput("response-b", "")],
        }),
      ]);
      expect(safeBlockersV2(root)).toEqual([
        {
          kind: "challenge",
          text: "Widget containing a Cloudflare security challenge",
          target: "unavailable",
        },
      ]);
    });
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

  it("marks a field-named generic container not fillable and never the hosted field itself (E3)", () => {
    // Braintree's hosted-field presentation: a listener div whose id says
    // "card-number" wrapping a cross-origin iframe with the real textbox.
    const container = element({
      tag: "div",
      role: "generic",
      id: "card-number",
      visibleText: null,
      selector: "#card-number",
    });
    const field = element({
      tag: "input",
      type: "text",
      role: "textbox",
      id: "credit-card-number",
      ariaLabel: "Credit card number",
      selector: "#credit-card-number",
    });
    const rows = safeControls({
      elements: [container, field],
      legacyRefs: new Map([
        [container, "r1"],
        [field, "r2"],
      ]),
      pageOrigin: "https://merchant.invalid",
      pageUrl: "https://merchant.invalid/checkouts/c/token",
    });
    const containerRow = rows.rows.find((row) => row.ref === "@e:hhhhhhhhh1");
    expect(containerRow, "container row").toBeDefined();
    expect(containerRow?.role).toBe("generic");
    expect(containerRow?.field).toBe("payment");
    expect(containerRow?.notFillable).toBe(true);
    const fieldRow = rows.rows.find((row) => row.ref === "@e:hhhhhhhhh2");
    expect(fieldRow?.notFillable).toBeUndefined();
    // The wire carries the fact in the row's facts string.
    const page = encodeV2QueryPage({
      sessionId: "s",
      stage: safeStageV2("https://merchant.invalid/checkouts/c/token", []),
      pageUrl: "https://merchant.invalid/checkouts/c/token",
      rows: rows.rows,
      cursorFor: () => "",
    });
    const wireRow = (page.payload.safe_table as string[][]).find(
      (row) => row[0] === "@e:hhhhhhhhh1",
    );
    expect(wireRow?.[2]).toContain("nf=1");
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
  it("keeps a ref stable when a dialog mount re-creates the node with unchanged meaning", () => {
    // Portal/dialog mounts re-render the underlying page (new backend nodes),
    // while the element the user sees is unchanged. The durable fingerprint
    // (tag/role/name) plus unchanged intent must resurrect the same ref
    // instead of churning every pre-existing control into `removed`/`*`.
    const refs = new StableObservationRefs();
    const navLink = (identity: string) =>
      ({
        tag: "a",
        role: "link",
        visibleText: "Docs",
        screenPath: "nav:main > link:docs",
        observationIdentity: identity,
        observationIntent: JSON.stringify(["A", "link", "Docs"]),
      }) as InteractiveElement;
    const first = navLink("page:loader:101");
    const original = refs.actions("doc", [first]).get(first)!;
    const recreated = navLink("page:loader:202");
    const dialogButton = {
      tag: "button",
      role: "button",
      visibleText: "Create API key",
      screenPath: "dialog:create-api-key > button:create",
      observationIdentity: "page:loader:900",
      observationIntent: JSON.stringify(["BUTTON", "button", "Create API key"]),
    } as InteractiveElement;
    const second = refs.actions("doc", [recreated, dialogButton]);
    expect(second.get(recreated)).toBe(original);
    const dialogRef = second.get(dialogButton)!;
    expect(dialogRef).toMatch(/^@e:[A-Za-z0-9_-]{22}$/);
    expect(dialogRef).not.toBe(original);
  });
  it("keeps refs across inventory-dependent name-to-region tier changes", () => {
    const refs = new StableObservationRefs();
    const first = element({
      visibleText: "Continue",
      container: "main:page",
      screenPath: "main:page > button:continue",
      observationIdentity: "page:loader:1",
      observationIntent: "continue",
    });
    const original = refs.actions("doc", [first]).get(first)!;
    const recreated = { ...first, observationIdentity: "page:loader:2" };
    const dialog = {
      ...first,
      container: "dialog:confirmation",
      screenPath: "dialog:confirmation > button:continue",
      observationIdentity: "page:loader:3",
    };
    const updated = refs.actions("doc", [dialog, recreated]);
    expect(updated.get(recreated)).toBe(original);
    expect(updated.get(dialog)).not.toBe(original);
  });

  it.each(["other:loader:2", "page:reloaded:2"])(
    "does not adopt a ref across frame documents: %s",
    (identity) => {
      const refs = new StableObservationRefs();
      const first = element({
        visibleText: "Continue",
        screenPath: "form:main > button:continue",
        observationIdentity: "page:loader:1",
        observationIntent: "continue",
      });
      const original = refs.actions("doc", [first]).get(first)!;
      const replacement = { ...first, observationIdentity: identity };
      expect(refs.actions("doc", [replacement]).get(replacement)).not.toBe(original);
    },
  );

  it.each(["retired", "live"])("refuses ambiguous %s adoption matches", (side) => {
    const refs = new StableObservationRefs();
    const control = (id: number) =>
      element({
        visibleText: "Continue",
        screenPath: "form:main > button:continue",
        observationIdentity: `page:loader:${id}`,
        observationIntent: "continue",
      });
    const before = side === "retired" ? [control(1), control(2), control(3)] : [control(1)];
    const original = new Set(refs.actions("doc", before).values());
    const after = side === "live" ? [control(4), control(5)] : [control(4)];
    const updated = refs.actions("doc", after);
    expect(new Set(updated.values()).size).toBe(after.length);
    for (const ref of updated.values()) expect(original.has(ref)).toBe(false);
  });

  it("mints a fresh ref when a re-created node's meaning changed with its identity", () => {
    const refs = new StableObservationRefs();
    const control = (identity: string, name: string, intent: string) =>
      ({
        tag: "button",
        role: "button",
        visibleText: name,
        screenPath: `form:main > button:${name.toLowerCase()}`,
        observationIdentity: identity,
        observationIntent: intent,
      }) as InteractiveElement;
    const first = control("page:loader:1", "Start", JSON.stringify(["BUTTON", "button", "Start"]));
    const original = refs.actions("doc", [first]).get(first)!;
    const replaced = control(
      "page:loader:2",
      "Cancel",
      JSON.stringify(["BUTTON", "button", "Cancel"]),
    );
    expect(refs.actions("doc", [replaced]).get(replaced)).not.toBe(original);
  });
});

it("uses native login semantics for JAF mail-address names and conflicting labels", () => {
  const inputs = [
    element({
      tag: "input",
      role: "textbox",
      type: "text",
      name: "login_mail_address",
      labelText: "Password",
    }),
    element({
      tag: "input",
      role: "textbox",
      type: "password",
      name: "login_password",
      labelText: "Email address",
    }),
    element({
      tag: "input",
      role: "textbox",
      type: "email",
      autocomplete: "current-password",
      labelText: "Password",
    }),
    element({
      tag: "input",
      role: "textbox",
      type: "text",
      autocomplete: "username",
      labelText: "Street address",
    }),
  ];
  const result = safeControls({
    elements: inputs,
    legacyRefs: new Map(inputs.map((el, i) => [el, `@old${i}`])),
    pageOrigin: "https://translation.jaf.or.jp",
  });
  for (const [i, expected] of ["email", "password", "email", "username"].entries()) {
    expect(
      result.rows.find((row) => row.ref === `@e:${String(i + 1).padStart(10, "h")}`)?.field,
    ).toBe(expected);
  }
});

describe("safeBlockersV2 modal dialog", () => {
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
  const page = (children: BrowserUseNode[]): BrowserUseNode =>
    node("root", { nodeType: 9, nodeName: "#document", children });
  const shopPayDialog = () =>
    node("dialog", {
      nodeName: "DIV",
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Confirm it's you" },
      children: [
        node("dialog-heading", {
          nodeName: "H2",
          children: [text("dialog-heading-text", "Confirm it's you")],
        }),
        text(
          "dialog-body",
          "Sign in as customer@example.com to securely use your saved information",
        ),
        node("dialog-close", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "Close" },
          axRole: "button",
        }),
      ],
    });

  it("names an open aria-modal dialog and grounds its close control", () => {
    const dialog = shopPayDialog();
    const close = dialog.children[2];
    const root = page([
      node("email-field", { nodeName: "INPUT", attributes: { type: "email" } }),
      dialog,
    ]);
    expect(
      safeBlockersV2(root, (candidate) => (candidate === close ? "@e:dialog-close" : undefined)),
    ).toEqual([
      {
        kind: "dialog",
        text: "Confirm it's you",
        ref: "@e:dialog-close",
        options: [{ ref: "@e:dialog-close", label: "Close" }],
        detail: "Sign in as customer@example.com to securely use your saved information",
      },
    ]);
  });

  it("marks alertdialog without a close control as blocked and unavailable", () => {
    const root = page([
      node("dialog", {
        nodeName: "DIV",
        attributes: { role: "alertdialog", "aria-label": "Confirm it's you" },
        children: [text("dialog-body", "Sign in to continue")],
      }),
    ]);
    expect(safeBlockersV2(root)).toEqual([
      {
        kind: "dialog",
        text: "Confirm it's you",
        target: "unavailable",
        detail: "Sign in to continue",
      },
    ]);
  });

  it("falls back to the dialog heading for the name and a dismiss control for the ref", () => {
    const dialog = node("dialog", {
      attributes: { "aria-modal": "true" },
      children: [
        node("dialog-heading", {
          nodeName: "H2",
          children: [text("dialog-heading-text", "Confirm it's you")],
        }),
        node("dialog-dismiss", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "No thanks" },
          axRole: "button",
        }),
      ],
    });
    const root = page([dialog]);
    const dismiss = dialog.children[1];
    expect(
      safeBlockersV2(root, (candidate) => (candidate === dismiss ? "@e:dismiss" : undefined)),
    ).toEqual([
      {
        kind: "dialog",
        text: "Confirm it's you",
        ref: "@e:dismiss",
        options: [{ ref: "@e:dismiss", label: "No thanks" }],
      },
    ]);
  });

  it("surfaces EVERY dialog control including the close path, with the body delta", () => {
    // Oura's address-verification shape: Confirm (which silently accepts the
    // suggestion) plus a close X that keeps what was entered. The compact
    // blocker must show both options in DOM order and the entered-vs-suggested
    // text, so keeping the entry is discoverable and never reads as a cancel.
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [
        text(
          "dialog-body",
          "You entered: 12 Rue de la Paix, room 101, Paris. Suggested address: 12 Rue de la Paix, Paris.",
        ),
        node("dialog-confirm", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("confirm-text", "Confirm address")],
        }),
        node("dialog-x", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "Close" },
          axRole: "button",
        }),
      ],
    });
    const root = page([dialog]);
    const confirm = dialog.children[1];
    const close = dialog.children[2];
    expect(
      safeBlockersV2(root, (candidate) =>
        candidate === confirm ? "@e:confirm" : candidate === close ? "@e:close" : undefined,
      ),
    ).toEqual([
      {
        kind: "dialog",
        text: "Verify your address",
        ref: "@e:close",
        options: [
          { ref: "@e:confirm", label: "Confirm address" },
          { ref: "@e:close", label: "Close" },
        ],
        detail:
          "You entered: 12 Rue de la Paix, room 101, Paris. Suggested address: 12 Rue de la Paix, Paris.",
      },
    ]);
  });

  it("keeps the entered-vs-suggested comparison intact past the blocker text budget", () => {
    // A real address comparison runs past BLOCKER_TEXT_MAX_CHARS; cutting it
    // there drops the "suggested" half, which is the whole point of detail.
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [
        text(
          "dialog-body",
          "You entered: 1234 Northwest Example Boulevard, Apartment 5B, Portland, Oregon 97209, United States. Suggested address: 1234 NW Example Blvd Apt 5B, Portland, OR 97209-1234, United States.",
        ),
        node("dialog-confirm", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("confirm-text", "Use suggested address")],
        }),
        node("dialog-keep", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("keep-text", "Keep what I entered")],
        }),
      ],
    });
    const blocker = safeBlockersV2(page([dialog]), (candidate) =>
      candidate === dialog.children[1]
        ? "@e:suggested"
        : candidate === dialog.children[2]
          ? "@e:keep"
          : undefined,
    )[0];
    expect(blocker?.detail).toBe(
      "You entered: 1234 Northwest Example Boulevard, Apartment 5B, Portland, Oregon 97209, United States. Suggested address: 1234 NW Example Blvd Apt 5B, Portland, OR 97209-1234, United States.",
    );
    // The exit is the button that preserves the entry, never the one that
    // accepts the correction: clearing the blocker through ref must not silently
    // discard what was entered.
    expect(blocker?.ref).toBe("@e:keep");
    expect(blocker?.target).toBeUndefined();
    expect(blocker?.options).toEqual([
      { ref: "@e:suggested", label: "Use suggested address" },
      { ref: "@e:keep", label: "Keep what I entered" },
    ]);
  });

  it("labels input-shaped dialog controls from their value attribute", () => {
    // A push-button input renders `value` as its label and has no child text, so
    // reading only aria-label/title left these controls unlabelled and the
    // rendered Close unrecognised as the exit.
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [
        node("confirm-input", {
          nodeName: "INPUT",
          attributes: { type: "submit", value: "Confirm address" },
        }),
        node("close-input", {
          nodeName: "INPUT",
          attributes: { type: "button", value: "Close" },
        }),
      ],
    });
    const refs = new Map(dialog.children.map((child, index) => [child, `@e:i${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.options).toEqual([
      { ref: "@e:i0", label: "Confirm address" },
      { ref: "@e:i1", label: "Close" },
    ]);
    expect(blocker?.ref).toBe("@e:i1");
  });

  it("refuses an accept button phrased around what was entered", () => {
    // "…instead of the one you entered" ACCEPTS the correction. Matching it as a
    // keep-style exit would outrank the real close and advertise the accept
    // button as the path that preserves the entry.
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [
        node("dialog-accept", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [
            text("accept-text", "Use the suggested address instead of the one you entered"),
          ],
        }),
        node("dialog-close", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "Close" },
          axRole: "button",
        }),
      ],
    });
    const refs = new Map(dialog.children.map((child, index) => [child, `@e:a${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.ref).toBe("@e:a1");
  });

  it("leaves a nested modal's controls and prose to that modal's own blocker", () => {
    // IAB/TCF consent managers render the vendor panel as a nested role=dialog.
    // Absorbing it made the outer blocker advertise vendor buttons as its own
    // choices and resolve `ref` to the inner Close, which leaves the wall up.
    const vendorPanel = node("vendor-panel", {
      attributes: { role: "dialog", "aria-label": "Vendor list" },
      children: [
        node("vendor-body", {
          nodeName: "P",
          children: [text("vendor-body-text", "Select vendors.")],
        }),
        node("vendor-a", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("vendor-a-text", "Vendor A")],
        }),
        node("vendor-close", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "Close" },
          axRole: "button",
        }),
      ],
    });
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "We value your privacy" },
      children: [
        node("outer-body", {
          nodeName: "P",
          children: [text("outer-body-text", "We and 412 partners store data.")],
        }),
        node("accept-all", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("accept-all-text", "Accept all")],
        }),
        vendorPanel,
      ],
    });
    const refs = new Map<BrowserUseNode, string>([
      [dialog.children[1]!, "@e:accept"],
      [vendorPanel.children[1]!, "@e:vendor-a"],
      [vendorPanel.children[2]!, "@e:vendor-close"],
    ]);
    const blockers = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate));
    expect(blockers[0]).toEqual({
      kind: "dialog",
      text: "We value your privacy",
      target: "unavailable",
      options: [{ ref: "@e:accept", label: "Accept all" }],
      detail: "We and 412 partners store data.",
    });
    expect(blockers[1]).toEqual({
      kind: "dialog",
      text: "Vendor list",
      ref: "@e:vendor-close",
      options: [
        { ref: "@e:vendor-a", label: "Vendor A" },
        { ref: "@e:vendor-close", label: "Close" },
      ],
      detail: "Select vendors.",
    });
  });

  it("refuses a destructive confirm that merely contains an exit word", () => {
    // "Cancel subscription" contains "cancel" but performs the irreversible
    // action. Advertising it as the way out would have an agent clear the
    // blocker by cancelling the subscription.
    const dialog = node("dialog", {
      attributes: {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Cancel your subscription?",
      },
      children: [
        text("dialog-body", "This cannot be undone."),
        node("dialog-confirm", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("confirm-text", "Cancel subscription")],
        }),
        node("dialog-keep", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("keep-text", "Keep my subscription")],
        }),
      ],
    });
    const refs = new Map(dialog.children.slice(1).map((child, index) => [child, `@e:s${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.ref).toBeUndefined();
    expect(blocker?.target).toBe("unavailable");
    expect(blocker?.options).toEqual([
      { ref: "@e:s0", label: "Cancel subscription" },
      { ref: "@e:s1", label: "Keep my subscription" },
    ]);
    expect(blocker?.detail).toBe("This cannot be undone.");
  });

  it("still names a plain close control as the exit", () => {
    for (const label of ["Close", "Cancel", "No thanks", "Close dialog", "\u2715"]) {
      const dialog = node("dialog", {
        attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Offer" },
        children: [
          node("dialog-close", {
            nodeName: "BUTTON",
            axRole: "button",
            children: [text("close-text", label)],
          }),
        ],
      });
      const blocker = safeBlockersV2(page([dialog]), (candidate) =>
        candidate === dialog.children[0] ? "@e:close" : undefined,
      )[0];
      expect(blocker?.ref).toBe("@e:close");
    }
  });

  it("omits detail that only repeats a nameless dialog's own text", () => {
    // With no aria-label and no heading, `text` is already the subtree prose, so
    // detail would spend the compact page's bytes restating it.
    const dialog = node("dialog", {
      attributes: { role: "alertdialog" },
      children: [
        node("dialog-body", {
          nodeName: "P",
          children: [text("body-text", "Discard your changes?")],
        }),
        node("dialog-cancel", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("cancel-text", "Cancel")],
        }),
        node("dialog-discard", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("discard-text", "Discard")],
        }),
      ],
    });
    const refs = new Map(dialog.children.slice(1).map((child, index) => [child, `@e:d${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.text).toBe("Discard your changes? Cancel Discard");
    expect(blocker?.detail).toBeUndefined();
  });

  it("omits the repeated detail when prose and controls interleave", () => {
    // The prose is no longer one contiguous run inside `text`, but `text` is
    // still the whole subtree, so detail can only restate it.
    const dialog = node("dialog", {
      attributes: { role: "alertdialog" },
      children: [
        node("dialog-lead", { nodeName: "P", children: [text("lead-text", "Are you sure?")] }),
        node("dialog-cancel", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("cancel-text", "Cancel")],
        }),
        node("dialog-tail", {
          nodeName: "P",
          children: [text("tail-text", "This cannot be undone.")],
        }),
      ],
    });
    const blocker = safeBlockersV2(page([dialog]), (candidate) =>
      candidate === dialog.children[1] ? "@e:cancel" : undefined,
    )[0];
    expect(blocker?.text).toBe("Are you sure? Cancel This cannot be undone.");
    expect(blocker?.detail).toBeUndefined();
  });

  it("omits the repeated detail whichever side of the prose the buttons render", () => {
    const dialog = node("dialog", {
      attributes: { role: "alertdialog" },
      children: [
        node("dialog-cancel", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("cancel-text", "Cancel")],
        }),
        node("dialog-body", {
          nodeName: "P",
          children: [text("body-text", "Discard your changes?")],
        }),
      ],
    });
    const blocker = safeBlockersV2(page([dialog]), (candidate) =>
      candidate === dialog.children[0] ? "@e:cancel" : undefined,
    )[0];
    expect(blocker?.text).toBe("Cancel Discard your changes?");
    expect(blocker?.detail).toBeUndefined();
  });

  it("surfaces radio-based address pickers and anchor escape paths as options", () => {
    // The USPS/Shopify shape: the choice is a radio pair and the way out is a
    // link, so a button-only option set reported a strict subset.
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [
        node("pick-suggested", {
          nodeName: "INPUT",
          attributes: { type: "radio" },
          axRole: "radio",
          children: [text("pick-suggested-text", "Use suggested address")],
        }),
        node("pick-entered", {
          nodeName: "INPUT",
          attributes: { type: "radio" },
          axRole: "radio",
          children: [text("pick-entered-text", "Use the address you entered")],
        }),
        node("edit-link", {
          nodeName: "A",
          axRole: "link",
          children: [text("edit-link-text", "Edit address")],
        }),
      ],
    });
    const refs = new Map([
      [dialog.children[0], "@e:suggested"],
      [dialog.children[1], "@e:entered"],
      [dialog.children[2], "@e:edit"],
    ]);
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.options).toEqual([
      { ref: "@e:suggested", label: "Use suggested address" },
      { ref: "@e:entered", label: "Use the address you entered" },
      { ref: "@e:edit", label: "Edit address" },
    ]);
    // A radio ACCEPTS a choice and an anchor navigates away; neither dismisses
    // the dialog, so naming one as ref would advertise accept-the-suggestion as
    // the escape path. With no button-shaped control the answer stays honest.
    expect(blocker?.ref).toBeUndefined();
    expect(blocker?.target).toBe("unavailable");
  });

  it("marks a body past the budget as cut rather than reading as complete", () => {
    const blurb = "This address could not be verified exactly. ".repeat(12);
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Verify your address" },
      children: [text("dialog-body", `${blurb}Suggested address: 1 Example Way, Portland, OR.`)],
    });
    const detail = safeBlockersV2(page([dialog]))[0]?.detail;
    expect(detail).toHaveLength(400);
    expect(detail?.endsWith("…")).toBe(true);
  });

  it("spends the detail budget on the body, not on the name and option labels", () => {
    // Re-emitting the heading and every control label used to tip a realistic
    // address dialog past the budget, and the body — the entered-vs-suggested
    // comparison C4 exists to surface — was what got dropped.
    const body =
      "You entered: 1200 Northwest Example Boulevard, Apartment 5B, Portland, Oregon 97209, United States. " +
      "Suggested address: 1200 NW Example Blvd Apt 5B, Portland, OR 97209-1234, United States. " +
      "Delivery estimates and taxes are calculated from the address you confirm here, and changing it later may alter both. " +
      "Choose which address to keep before continuing.";
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true" },
      children: [
        node("dialog-heading", {
          nodeName: "H2",
          children: [text("dialog-heading-text", "Verify your address")],
        }),
        text("dialog-body", body),
        node("btn-suggested", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("btn-suggested-text", "Use the suggested address")],
        }),
        node("btn-entered", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("btn-entered-text", "Keep the address I entered")],
        }),
        node("btn-edit", {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text("btn-edit-text", "Edit the address I entered")],
        }),
        node("btn-close", {
          nodeName: "BUTTON",
          attributes: { "aria-label": "Close" },
          axRole: "button",
        }),
      ],
    });
    const refs = new Map(dialog.children.slice(2).map((child, index) => [child, `@e:b${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.text).toBe("Verify your address");
    expect(blocker?.detail).toBe(body);
  });

  it("keeps the controls that resolve a consent modal ahead of its policy links", () => {
    // The anchors render first, so a plain DOM-order cut reported five policy
    // links and dropped Accept all / Reject all — the only controls that
    // actually resolve the modal — with nothing marking the list as partial.
    const anchors = [
      "Privacy Policy",
      "Cookie Policy",
      "Vendor list",
      "Legitimate interest",
      "Learn more",
    ];
    const buttons = ["Accept all", "Reject all", "Close"];
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "We value your privacy" },
      children: [
        ...anchors.map((label, index) =>
          node(`anchor-${index}`, {
            nodeName: "A",
            axRole: "link",
            children: [text(`anchor-${index}-text`, label)],
          }),
        ),
        ...buttons.map((label, index) =>
          node(`button-${index}`, {
            nodeName: "BUTTON",
            axRole: "button",
            children: [text(`button-${index}-text`, label)],
          }),
        ),
      ],
    });
    const refs = new Map(dialog.children.map((child, index) => [child, `@e:o${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.ref).toBe("@e:o7");
    // The anchors the cap dropped are still controls, not the dialog's prose.
    expect(blocker?.detail).toBeUndefined();
    expect(blocker?.options).toEqual([
      { ref: "@e:o0", label: "Privacy Policy" },
      { ref: "@e:o1", label: "Cookie Policy" },
      { ref: "@e:o2", label: "Vendor list" },
      { ref: "@e:o5", label: "Accept all" },
      { ref: "@e:o6", label: "Reject all" },
      { ref: "@e:o7", label: "Close" },
    ]);
  });

  it("keeps the close affordance past the option cap and names it as ref", () => {
    // A consent modal with more qualifying controls than the option cap. The
    // close sits last; dropping it would leave ref pointing at Accept all, so a
    // host agent told the blocker carries the close path grants consent instead.
    const labels = [
      "Accept all",
      "Reject all",
      "Analytics",
      "Marketing",
      "Functional",
      "Performance",
      "Save preferences",
      "Close",
    ];
    const dialog = node("dialog", {
      attributes: { role: "dialog", "aria-modal": "true", "aria-label": "Cookie preferences" },
      children: labels.map((label, index) =>
        node(`control-${index}`, {
          nodeName: "BUTTON",
          axRole: "button",
          children: [text(`control-${index}-text`, label)],
        }),
      ),
    });
    const refs = new Map(dialog.children.map((child, index) => [child, `@e:c${index}`]));
    const blocker = safeBlockersV2(page([dialog]), (candidate) => refs.get(candidate))[0];
    expect(blocker?.ref).toBe("@e:c7");
    expect(blocker?.detail).toBeUndefined();
    expect(blocker?.options).toEqual([
      { ref: "@e:c0", label: "Accept all" },
      { ref: "@e:c1", label: "Reject all" },
      { ref: "@e:c2", label: "Analytics" },
      { ref: "@e:c3", label: "Marketing" },
      { ref: "@e:c4", label: "Functional" },
      { ref: "@e:c7", label: "Close" },
    ]);
  });

  it("stops reporting the dialog blocker once the dialog is removed", () => {
    const dialog = shopPayDialog();
    const close = dialog.children[2];
    const withDialog = page([dialog]);
    const withoutDialog = page([
      node("email-field", { nodeName: "INPUT", attributes: { type: "email" } }),
    ]);
    const refs = (candidate: BrowserUseNode) =>
      candidate === close ? "@e:dialog-close" : undefined;
    expect(safeBlockersV2(withDialog, refs)).toHaveLength(1);
    expect(safeBlockersV2(withoutDialog, refs)).toEqual([]);
  });

  it("ignores a hidden dialog", () => {
    const root = page([node("dialog", { visible: false, attributes: { role: "dialog" } })]);
    expect(safeBlockersV2(root)).toEqual([]);
  });
});
