import { describe, expect, it } from "vitest";
import {
  CARD_NUMBER_MASK,
  CardValueOutputMask,
  SECURITY_CODE_MASK,
} from "../card-value-output-mask.js";
import type { BrowserUseNode } from "../browser-use-serializer.js";
import type { InteractiveElement } from "../browser.js";

const SYNTHETIC_CARD = {
  pan: "4111111111111111",
  cvv: "123",
};

function node(overrides: Partial<BrowserUseNode> = {}): BrowserUseNode {
  return {
    id: "root",
    nodeType: 1,
    nodeName: "DIV",
    value: "",
    attributes: {},
    visible: true,
    snapshot: true,
    bounds: { x: 0, y: 0, width: 100, height: 20 },
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
  };
}

describe("released card value output mask", () => {
  it("masks complete PAN spellings and labelled CVV copies without becoming a secret scanner", () => {
    const mask = new CardValueOutputMask();
    mask.register(SYNTHETIC_CARD);

    expect(mask.maskText("PAN 4111111111111111")).toBe(`PAN ${CARD_NUMBER_MASK}`);
    expect(mask.maskText("Card 4111 1111 1111 1111")).toBe(`Card ${CARD_NUMBER_MASK}`);
    expect(mask.maskText("Card 4111-1111-1111-1111")).toBe(`Card ${CARD_NUMBER_MASK}`);
    expect(mask.maskText("security code: 123")).toBe(`security code: ${SECURITY_CODE_MASK}`);
    expect(mask.maskValue({ cvc: "123", total: "123", status: 401 })).toEqual({
      cvc: SECURITY_CODE_MASK,
      total: "123",
      status: 401,
    });

    expect(
      mask.maskValue({
        cardholder: "Synthetic Buyer",
        expiry: "12/30",
        amount: "123 JPY",
        currency: "JPY",
        error: "401 unauthorized",
        api_key: "sk-synthetic-visible",
        three_ds: "Enter the one-time password from your bank",
      }),
    ).toEqual({
      cardholder: "Synthetic Buyer",
      expiry: "12/30",
      amount: "123 JPY",
      currency: "JPY",
      error: "401 unauthorized",
      api_key: "sk-synthetic-visible",
      three_ds: "Enter the one-time password from your bank",
    });
  });

  it("masks DOM values, raw attributes, AX properties, frame trees, and shadow trees", () => {
    const mask = new CardValueOutputMask();
    mask.register(SYNTHETIC_CARD);
    const pan = node({
      id: "pan",
      nodeName: "INPUT",
      attributes: { "data-ts-card-mask": "pan", value: SYNTHETIC_CARD.pan },
      axProperties: [
        { name: "value", value: SYNTHETIC_CARD.pan },
        { name: "invalid", value: true },
      ],
    });
    const cvv = node({
      id: "cvv",
      nodeName: "INPUT",
      attributes: { "data-ts-card-mask": "cvv", value: SYNTHETIC_CARD.cvv },
      axProperties: [{ name: "valuetext", value: SYNTHETIC_CARD.cvv }],
    });
    const shadow = node({
      id: "shadow",
      nodeType: 11,
      nodeName: "#document-fragment",
      shadowType: "closed",
      children: [cvv],
    });
    const iframe = node({
      id: "frame",
      nodeName: "IFRAME",
      attributes: { src: `https://payments.test/?pan=${SYNTHETIC_CARD.pan}` },
      contentDocument: node({ children: [pan, shadow] }),
    });
    const capture = {
      root: node({ children: [iframe] }),
      elements: [],
      nodeElements: new Map(),
      moreAbove: false,
      moreBelow: false,
      dynamics: "test",
      omissions: [],
    };

    mask.maskCapture(capture);

    expect(iframe.attributes.src).toBe(`https://payments.test/?pan=${CARD_NUMBER_MASK}`);
    expect(pan.attributes.value).toBe(CARD_NUMBER_MASK);
    expect(pan.axProperties[0]?.value).toBe(CARD_NUMBER_MASK);
    expect(pan.axProperties[1]?.value).toBe(true);
    expect(cvv.attributes.value).toBe(SECURITY_CODE_MASK);
    expect(cvv.axProperties[0]?.value).toBe(SECURITY_CODE_MASK);
  });

  it("masks ordinary network, log, diagnostic, URL, JSON, form, and error copies", () => {
    const mask = new CardValueOutputMask();
    mask.register(SYNTHETIC_CARD);
    const evidence = mask.maskValue({
      url: `https://merchant.test/fail?card=${SYNTHETIC_CARD.pan}`,
      request_headers: { "x-card": SYNTHETIC_CARD.pan, "x-api-key": "api-visible" },
      request_body: `card_number=${SYNTHETIC_CARD.pan}&cvv=${SYNTHETIC_CARD.cvv}`,
      response_body: `{"card_number":"${SYNTHETIC_CARD.pan}","cvc":"${SYNTHETIC_CARD.cvv}","status":401}`,
      console: `Card ${SYNTHETIC_CARD.pan} rejected; CVV ${SYNTHETIC_CARD.cvv}`,
      diagnostic: new Error(`processor echoed ${SYNTHETIC_CARD.pan}`),
    });

    expect(JSON.stringify(evidence)).not.toContain(SYNTHETIC_CARD.pan);
    expect(evidence.request_body).toContain(SECURITY_CODE_MASK);
    expect(evidence.console).toContain(SECURITY_CODE_MASK);
    expect(evidence.request_headers["x-api-key"]).toBe("api-visible");
    expect(evidence.response_body).toContain("401");
  });

  it("retains injected node provenance when a rerender drops the marker", () => {
    const mask = new CardValueOutputMask();
    mask.register(SYNTHETIC_CARD);
    mask.registerTarget({ kind: "cvv", selector: "#security", framePath: "0" });
    const rerendered = node({
      id: "rerendered-cvv",
      nodeName: "INPUT",
      value: SYNTHETIC_CARD.cvv,
      attributes: { id: "security", value: SYNTHETIC_CARD.cvv },
      axProperties: [{ name: "value", value: SYNTHETIC_CARD.cvv }],
    });
    const element = {
      selector: "#security",
      framePath: "0",
      value: SYNTHETIC_CARD.cvv,
      cardMaskKind: null,
    } as unknown as InteractiveElement;
    const capture = {
      root: node({
        children: [
          node({
            id: "frame",
            nodeName: "IFRAME",
            contentDocument: node({ children: [rerendered] }),
          }),
        ],
      }),
      elements: [element],
      nodeElements: new Map([[rerendered.id, element]]),
      moreAbove: false,
      moreBelow: false,
      dynamics: "rerender",
      omissions: [],
    };

    const masked = mask.maskCapture(capture);

    expect(rerendered.value).toBe(SECURITY_CODE_MASK);
    expect(rerendered.attributes.value).toBe(SECURITY_CODE_MASK);
    expect(rerendered.axProperties[0]?.value).toBe(SECURITY_CODE_MASK);
    expect(masked.elements[0]?.value).toBe(SECURITY_CODE_MASK);
  });

  it("documents the approved hostile-page limit without broadening the mask", () => {
    const mask = new CardValueOutputMask();
    mask.register(SYNTHETIC_CARD);

    // A hostile page can transform/split/canvas-render values. The normal seam
    // intentionally masks ordinary complete copies; it is not an information-flow
    // monitor or secret scanner and does not claim these adversarial encodings.
    expect(mask.maskText("4111|1111|1111|1111")).toBe("4111|1111|1111|1111");
    expect(mask.maskText(Buffer.from(SYNTHETIC_CARD.pan).toString("base64"))).toBe(
      Buffer.from(SYNTHETIC_CARD.pan).toString("base64"),
    );
    expect(mask.maskText("canvas pixels encode one digit at a time")).toBe(
      "canvas pixels encode one digit at a time",
    );
  });
});
