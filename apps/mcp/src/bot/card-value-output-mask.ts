import { deflateSync, inflateSync } from "node:zlib";
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

const cvvKeyPattern = /(?:^|[_-])(?:cvv|cvc|cid|csc)(?:$|[_-])|security[_-]?code/i;
const cvvLabelPattern = /\b(?:cvv|cvc|cid|csc|security\s*code)\b/i;

function panPattern(digits: string): RegExp {
  const separated = [...digits]
    .map((digit) => `${digit}[\\s-]*`)
    .join("")
    .replace(/\[\\s-\]\*$/, "");
  return new RegExp(`(?<!\\d)${separated}(?!\\d)`, "g");
}

function maskCvvInLabelledText(value: string, cvv: string): string {
  if (!cvvLabelPattern.test(value)) return value;
  return value.replace(
    new RegExp(`(\\b(?:cvv|cvc|cid|csc|security\\s*code)\\b[^\\d\\n]{0,16})${cvv}(?!\\d)`, "gi"),
    `$1${SECURITY_CODE_MASK}`,
  );
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
  inheritedKind?: CardMaskKind,
): void {
  const ownKind = node.attributes[CARD_MASK_ATTRIBUTE];
  const kind: CardMaskKind | undefined =
    ownKind === "pan" || ownKind === "cvv" ? ownKind : inheritedKind;
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
  node.children.forEach((child) => maskNode(child, records, kind));
  if (node.contentDocument !== null) maskNode(node.contentDocument, records);
}

/**
 * Session-persistent, deliberately narrow output mask for a released payment card.
 * It is an output transformation only: it never authorizes, refuses, clears, or
 * otherwise changes a browser action.
 */
export class CardValueOutputMask {
  private readonly records: RegisteredCardMask[] = [];

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

  maskText(value: string, key?: string): string {
    return maskStringForKey(value, key, this.records);
  }

  /** Raw values for the internal, pre-output screenshot rectangle finder only. */
  screenshotNeedles(): { pans: string[]; cvvs: string[] } {
    return {
      pans: this.records.map((record) => record.panDigits),
      cvvs: this.records.map((record) => record.cvv),
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

  maskInteractiveElements(elements: readonly InteractiveElement[]): InteractiveElement[] {
    return elements.map((element) => {
      const kind = element.cardMaskKind;
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
    maskNode(capture.root, this.records);
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

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upperLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upperLeft;
}

/** Paint opaque neutral rectangles into an 8-bit RGB/RGBA PNG. */
export function compositePngCardMasks(base64: string, rects: readonly PixelMaskRect[]): string {
  if (rects.length === 0) return base64;
  const png = Buffer.from(base64, "base64");
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("card_mask_expected_png");
  let offset = 8;
  let ihdr: Buffer | undefined;
  const compressed: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") ihdr = Buffer.from(data);
    if (type === "IDAT") compressed.push(Buffer.from(data));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (ihdr === undefined || compressed.length === 0) throw new Error("card_mask_invalid_png");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || ihdr[12] !== 0) {
    throw new Error("card_mask_unsupported_png");
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[source++]!;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[source++]!;
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      const decoded =
        filter === 0
          ? raw
          : filter === 1
            ? raw + left
            : filter === 2
              ? raw + up
              : filter === 3
                ? raw + Math.floor((left + up) / 2)
                : filter === 4
                  ? raw + paeth(left, up, upperLeft)
                  : NaN;
      if (!Number.isFinite(decoded)) throw new Error("card_mask_invalid_png_filter");
      pixels[y * stride + x] = decoded & 0xff;
    }
  }
  for (const rect of rects) {
    const left = Math.max(0, Math.floor(rect.x));
    const top = Math.max(0, Math.floor(rect.y));
    const right = Math.min(width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = y * stride + x * channels;
        pixels[pixel] = 232;
        pixels[pixel + 1] = 232;
        pixels[pixel + 2] = 232;
        if (channels === 4) pixels[pixel + 3] = 255;
      }
    }
  }
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
