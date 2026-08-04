import type { DriftMutationName } from "./types.js";

interface HarContent {
  text?: string;
  encoding?: string;
  mimeType?: string;
}

interface HarEntry {
  request?: { url?: string };
  response?: { content?: HarContent };
}

export interface HarFile {
  log: { entries: HarEntry[]; [key: string]: unknown };
  [key: string]: unknown;
}

export interface MutationOptions {
  expectedTotalCents?: number;
  changedTotalCents?: number;
}

export interface MutationResult {
  har: HarFile;
  mutation: DriftMutationName;
  responses_changed: number;
  replacements: number;
  observed_total_cents?: number;
}

function decode(content: HarContent): string | null {
  if (typeof content.text !== "string") return null;
  return content.encoding === "base64"
    ? Buffer.from(content.text, "base64").toString("utf8")
    : content.text;
}

function encode(content: HarContent, body: string): void {
  content.text = content.encoding === "base64" ? Buffer.from(body).toString("base64") : body;
}

function replaceFirst(
  body: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...args: string[]) => string),
): { body: string; replacements: number } {
  if (!pattern.test(body)) return { body, replacements: 0 };
  pattern.lastIndex = 0;
  return { body: body.replace(pattern, replacement as string), replacements: 1 };
}

function moneyForms(cents: number): string[] {
  const dollars = cents / 100;
  const forms = [`$${dollars.toFixed(2)}`];
  if (cents % 100 === 0) forms.push(`$${dollars.toFixed(0)}`);
  return forms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mutateBody(
  body: string,
  mutation: DriftMutationName,
  options: MutationOptions,
): { body: string; replacements: number; observedTotalCents?: number } {
  if (mutation === "rename-button") {
    const button = replaceFirst(
      body,
      /(<button\b[^>]*>[\s\S]{0,1000}?)(add\s+to\s+(?:cart|bag)|continue|choose)([\s\S]{0,1000}?<\/button>)/i,
      (_match, before: string, _label: string, after: string) => `${before}Purchase item${after}`,
    );
    if (button.replacements > 0) return button;
    return replaceFirst(body, /add\s+to\s+(?:cart|bag)|continue|choose/i, "Purchase item");
  }

  if (mutation === "swap-testid") {
    const testId = replaceFirst(
      body,
      /data-testid=(['"])([^'"]+)\1/i,
      (_match, quote: string, value: string) => `data-testid=${quote}drifted-${value}${quote}`,
    );
    if (testId.replacements > 0) return testId;
    return replaceFirst(
      body,
      /\bid=(['"])([^'"]+)\1/i,
      (_match, quote: string, value: string) => `id=${quote}drifted-${value}${quote}`,
    );
  }

  if (mutation === "remove-field") {
    const required = replaceFirst(body, /<input\b(?=[^>]*\brequired\b)[^>]*>/i, "");
    if (required.replacements > 0) return required;
    const checkoutField = replaceFirst(
      body,
      /<input\b(?=[^>]*\bname=(['"])(?:updates\[\]|quantity|checkout\[[^'"]+)\1)[^>]*>/i,
      "",
    );
    if (checkoutField.replacements > 0) return checkoutField;
    return replaceFirst(body, /<input\b[^>]*>/i, "");
  }

  if (mutation === "change-price") {
    if (options.expectedTotalCents === undefined) {
      throw new Error("change-price requires expectedTotalCents");
    }
    const changed = options.changedTotalCents ?? options.expectedTotalCents + 100;
    let next = body;
    let replacements = 0;
    const oldForms = moneyForms(options.expectedTotalCents);
    const newForms = moneyForms(changed);
    for (const [index, oldForm] of oldForms.entries()) {
      const replacement = newForms[index] ?? newForms[0] ?? String(changed);
      const result = replaceFirst(next, new RegExp(`${escapeRegExp(oldForm)}(?!\\d)`), replacement);
      next = result.body;
      replacements += result.replacements;
      if (replacements > 0) break;
    }
    if (replacements === 0) {
      const centsResult = replaceFirst(
        next,
        new RegExp(
          `((?:total_price|totalPrice|price)\\s*[\":=]+\\s*)${options.expectedTotalCents}(?!\\d)`,
        ),
        `$1${changed}`,
      );
      next = centsResult.body;
      replacements += centsResult.replacements;
    }
    return { body: next, replacements, observedTotalCents: changed };
  }

  if (mutation === "out-of-stock") {
    const availability = replaceFirst(body, /("available"\s*:\s*)true/i, "$1false");
    if (availability.replacements > 0) return availability;
    const stockText = replaceFirst(body, /\bin stock\b/i, "Out of stock");
    if (stockText.replacements > 0) return stockText;
    return replaceFirst(body, /\badd\s+to\s+cart\b/i, "Sold out");
  }

  const overlay =
    '<div data-replay-eval-overlay role="dialog" aria-modal="true">Store notice</div>';
  const inserted = replaceFirst(body, /<\/body>/i, `${overlay}</body>`);
  if (inserted.replacements > 0) return inserted;
  return { body: `${body}${overlay}`, replacements: 1 };
}

export function mutateHar(
  input: HarFile,
  mutation: DriftMutationName,
  options: MutationOptions = {},
): MutationResult {
  const har = structuredClone(input);
  let responsesChanged = 0;
  let replacements = 0;
  let observedTotalCents: number | undefined;
  for (const entry of har.log.entries) {
    const content = entry.response?.content;
    if (content === undefined) continue;
    const body = decode(content);
    if (body === null) continue;
    const changed = mutateBody(body, mutation, options);
    if (changed.replacements === 0) continue;
    encode(content, changed.body);
    responsesChanged += 1;
    replacements += changed.replacements;
    observedTotalCents = changed.observedTotalCents ?? observedTotalCents;
    break;
  }
  return {
    har,
    mutation,
    responses_changed: responsesChanged,
    replacements,
    ...(observedTotalCents === undefined ? {} : { observed_total_cents: observedTotalCents }),
  };
}
