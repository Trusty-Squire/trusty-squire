import sharp from "sharp";
import type { BrowserUseCapture } from "./browser-use-capture.js";
import type { BrowserUseNode } from "./browser-use-serializer.js";
import type { InteractiveElement } from "./browser.js";

export const CARD_NUMBER_MASK = "[card number]";
export const SECURITY_CODE_MASK = "[security code]";
export const CARD_MASK_ATTRIBUTE = "data-ts-card-mask";

export type CardMaskKind = "pan" | "cvv";

export interface CardMaskRegistration {
  pan: string;
  cvv: string;
}

export interface CardMaskTarget {
  kind: CardMaskKind;
  selector: string;
  framePath: string | null;
}

export interface PixelMaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RegisteredCardMask {
  panDigits: string;
  panPattern: RegExp;
  cvv: string;
}

const CVV_NAME_SOURCE = String.raw`(?:cvv2?|cvc2?|cid|csc|cvn|card[\s_-]*code|security[\s_-]*code)`;
const CVV_CONNECTOR_SOURCE = String.raw`[\s_\-:="']*`;
const CVV_BOUNDARY_SOURCE = String.raw`[\s_\-:="'&?{},]`;
const CVV_IDENTITY_SOURCE = String.raw`(?:^|${CVV_BOUNDARY_SOURCE})${CVV_NAME_SOURCE}(?=$|${CVV_BOUNDARY_SOURCE})`;
const cvvKeyPattern = new RegExp(CVV_IDENTITY_SOURCE, "i");
const PAN_SEPARATOR_SOURCE = String.raw`[\s.\u00b7\u2010-\u2015-]*`;

function panPattern(digits: string): RegExp {
  const prefixes = Array.from({ length: digits.length - 7 }, (_, index) =>
    [...digits.slice(0, digits.length - index)].join(PAN_SEPARATOR_SOURCE),
  );
  return new RegExp(`(?<!\\d)(?:${prefixes.join("|")})(?!${PAN_SEPARATOR_SOURCE}\\d)`, "g");
}

function maskCvvInLabelledText(value: string, cvv: string): string {
  if (!cvvKeyPattern.test(value)) return value;
  return value.replace(
    new RegExp(
      `((?:^|${CVV_BOUNDARY_SOURCE})${CVV_NAME_SOURCE}${CVV_CONNECTOR_SOURCE})${cvv}(?!\\d)`,
      "gi",
    ),
    `$1${SECURITY_CODE_MASK}`,
  );
}

function nodeHasReleasedCvv(node: BrowserUseNode, records: readonly RegisteredCardMask[]): boolean {
  const identity = [
    node.attributes.name,
    node.attributes.id,
    node.attributes.autocomplete,
    node.attributes.placeholder,
    node.attributes["aria-label"],
    ...node.axProperties
      .filter((property) => /^(?:name|label|description)$/i.test(property.name))
      .map((property) => (typeof property.value === "string" ? property.value : "")),
  ].filter((value): value is string => typeof value === "string");
  if (!identity.some((value) => cvvKeyPattern.test(value))) return false;
  const values = [
    node.value,
    node.attributes.value,
    ...node.axProperties
      .filter((property) => /value|valuetext/i.test(property.name))
      .map((property) => (typeof property.value === "string" ? property.value : "")),
  ].filter((value): value is string => typeof value === "string");
  return records.some((record) => values.some((value) => value.replace(/\D/g, "") === record.cvv));
}

function maskStringForKey(
  value: string,
  key: string | undefined,
  records: readonly RegisteredCardMask[],
): string {
  let masked = value;
  for (const record of records) {
    masked = masked.replace(record.panPattern, CARD_NUMBER_MASK);
    if (key !== undefined && cvvKeyPattern.test(key)) {
      masked = masked.replace(new RegExp(`(?<!\\d)${record.cvv}(?!\\d)`, "g"), SECURITY_CODE_MASK);
    } else {
      masked = maskCvvInLabelledText(masked, record.cvv);
    }
  }
  return masked;
}

function maskNode(
  node: BrowserUseNode,
  records: readonly RegisteredCardMask[],
  targetKinds: ReadonlyMap<string, CardMaskKind>,
  inheritedKind?: CardMaskKind,
): void {
  const ownKind = node.attributes[CARD_MASK_ATTRIBUTE];
  const kind: CardMaskKind | undefined =
    ownKind === "pan" || ownKind === "cvv"
      ? ownKind
      : (targetKinds.get(node.id) ?? (nodeHasReleasedCvv(node, records) ? "cvv" : inheritedKind));
  node.value =
    kind === "pan"
      ? CARD_NUMBER_MASK
      : kind === "cvv"
        ? SECURITY_CODE_MASK
        : maskStringForKey(node.value, undefined, records);
  for (const [key, value] of Object.entries(node.attributes)) {
    node.attributes[key] =
      key === "value" && kind === "pan"
        ? CARD_NUMBER_MASK
        : key === "value" && kind === "cvv"
          ? SECURITY_CODE_MASK
          : maskStringForKey(value, key, records);
  }
  node.axProperties = node.axProperties.map((property) => ({
    ...property,
    value:
      typeof property.value !== "string"
        ? property.value
        : kind === "pan" && /value|valuetext|name/i.test(property.name)
          ? CARD_NUMBER_MASK
          : kind === "cvv" && /value|valuetext|name/i.test(property.name)
            ? SECURITY_CODE_MASK
            : maskStringForKey(property.value, property.name, records),
  }));
  node.children.forEach((child) => maskNode(child, records, targetKinds, kind));
  if (node.contentDocument !== null) maskNode(node.contentDocument, records, targetKinds);
}

/**
 * Session-persistent, deliberately narrow output mask for a released payment card.
 * It is an output transformation only: it never authorizes, refuses, clears, or
 * otherwise changes a browser action.
 */
export class CardValueOutputMask {
  private readonly records: RegisteredCardMask[] = [];
  private readonly targets: CardMaskTarget[] = [];

  get active(): boolean {
    return this.records.length > 0;
  }

  register(card: CardMaskRegistration): void {
    const panDigits = card.pan.replace(/\D/g, "");
    if (panDigits.length < 12) throw new Error("card mask registration requires a complete PAN");
    if (!/^\d{3,4}$/.test(card.cvv)) {
      throw new Error("card mask registration requires a complete security code");
    }
    if (this.records.some((record) => record.panDigits === panDigits && record.cvv === card.cvv)) {
      return;
    }
    this.records.push({ panDigits, panPattern: panPattern(panDigits), cvv: card.cvv });
  }

  registerTarget(target: CardMaskTarget): void {
    if (
      this.targets.some(
        (known) =>
          known.kind === target.kind &&
          known.selector === target.selector &&
          known.framePath === target.framePath,
      )
    ) {
      return;
    }
    this.targets.push({ ...target });
  }

  screenshotTargets(framePath: string | null): CardMaskTarget[] {
    return this.targets
      .filter((target) => target.framePath === framePath)
      .map((target) => ({
        ...target,
      }));
  }

  maskText(value: string, key?: string): string {
    return maskStringForKey(value, key, this.records);
  }

  /** Raw values for the internal, pre-output screenshot rectangle finder only. */
  screenshotNeedles(): { pans: string[]; cvvs: string[]; cvvNameSource: string } {
    return {
      pans: this.records.map((record) => record.panDigits),
      cvvs: this.records.map((record) => record.cvv),
      cvvNameSource: CVV_IDENTITY_SOURCE,
    };
  }

  maskValue<T>(value: T, key?: string): T {
    if (typeof value === "string") return this.maskText(value, key) as T;
    if (Array.isArray(value)) return value.map((entry) => this.maskValue(entry, key)) as T;
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = this.maskValue(child, childKey);
    }
    return out as T;
  }

  private inferredInteractiveKind(element: InteractiveElement): CardMaskKind | undefined {
    const targetKind = this.targets.find(
      (target) =>
        target.selector === element.selector && target.framePath === (element.framePath ?? null),
    )?.kind;
    if (element.cardMaskKind === "pan" || element.cardMaskKind === "cvv") {
      return element.cardMaskKind;
    }
    if (targetKind !== undefined) return targetKind;
    const identity = [
      element.name,
      element.id,
      element.autocomplete,
      element.placeholder,
      element.ariaLabel,
      element.compactNames?.accessibleName,
      element.compactNames?.labelText,
    ].filter((value): value is string => typeof value === "string");
    const digits = (element.value ?? "").replace(/\D/g, "");
    if (
      identity.some((value) => cvvKeyPattern.test(value)) &&
      this.records.some((record) => record.cvv === digits)
    ) {
      return "cvv";
    }
    return undefined;
  }

  maskInteractiveElements(elements: readonly InteractiveElement[]): InteractiveElement[] {
    return elements.map((element) => {
      const kind = this.inferredInteractiveKind(element);
      const masked = this.maskValue(element);
      if (kind === "pan") masked.value = CARD_NUMBER_MASK;
      if (kind === "cvv") masked.value = SECURITY_CODE_MASK;
      if (masked.compactNames !== undefined) {
        if (kind === "pan") masked.compactNames.value = CARD_NUMBER_MASK;
        if (kind === "cvv") masked.compactNames.value = SECURITY_CODE_MASK;
      }
      return masked;
    });
  }

  maskCapture(capture: BrowserUseCapture): BrowserUseCapture {
    if (!this.active) return capture;
    const targetKinds = new Map<string, CardMaskKind>();
    for (const [id, element] of capture.nodeElements) {
      const kind = this.inferredInteractiveKind(element);
      if (kind === "pan" || kind === "cvv") targetKinds.set(id, kind);
    }
    maskNode(capture.root, this.records, targetKinds);
    return {
      ...capture,
      elements: this.maskInteractiveElements(capture.elements),
      nodeElements: new Map(
        [...capture.nodeElements].map(([id, element]) => [
          id,
          this.maskInteractiveElements([element])[0]!,
        ]),
      ),
    };
  }
}

/** Paint opaque neutral rectangles into a captured PNG without touching the page. */
export async function compositePngCardMasks(
  base64: string,
  rects: readonly PixelMaskRect[],
): Promise<string> {
  if (rects.length === 0) return base64;
  const png = Buffer.from(base64, "base64");
  const metadata = await sharp(png).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined) throw new Error("card_mask_invalid_png");
  const boxes = rects
    .map((rect) => {
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const right = Math.min(width, Math.ceil(rect.x + rect.width));
      const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
      return { x, y, width: right - x, height: bottom - y };
    })
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (boxes.length === 0) return base64;
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes
      .map(
        (rect) =>
          `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="#e8e8e8"/>`,
      )
      .join("")}</svg>`,
  );
  const output = await sharp(png)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  return output.toString("base64");
}
