// Text-only checkout total parser, restored from the pre-#782 pay-path
// reader. Page.evaluate readers that threw payment_checkout_total_not_found
// stay deleted: an unreadable total must still mint, never refuse.

import type { Page } from "playwright";

export const CHECKOUT_TOTAL_UNREADABLE = "total not readable";

/** inject_card's inputSchema and POST /v1/pay/approvals both cap amount_cents
 * and item here. A page number or a note above them would 400 the mint and
 * block the purchase. */
const APPROVAL_AMOUNT_CENTS_MAX = 2_147_483_647;
const APPROVAL_ITEM_MAX_CHARS = 500;

/** This read is best-effort and optional: it owns its own deadline and never
 * touches the drive's request-cancellation path, so a busy checkout page
 * degrades to an unknown total instead of curtailing the card release. */
export const CHECKOUT_TEXT_READ_BUDGET_MS = 4_000;

export interface CheckoutAmount {
  amount_cents: number;
  currency: string;
}

export interface DriveApprovalAmount extends CheckoutAmount {
  unknown: boolean;
  /** Shown to the human beside the amount; never replaces the signed reason. */
  note: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  US$: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "￥": "JPY",
  "₩": "KRW",
  円: "JPY",
  ZŁ: "PLN",
};

/** Shared by several ISO currencies, so the page symbol alone does not name one. */
const AMBIGUOUS_CURRENCY_SYMBOLS = new Set(["$", "£", "¥", "￥"]);

const CHECKOUT_CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

export function currencyMinorDigits(currency: string): number {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}

/** Apostrophes and the space family group digits in every locale that uses
 * them and never mark a fraction, so they are read as a group separator only
 * where they sit in front of exactly three digits. A digit run that follows an
 * amount across a space — an item count — is a separate token, not part of it. */
const CHECKOUT_GROUP_SEPARATORS = String.raw`\u0020\u00a0\u2009\u202f'\u2019`;
const checkoutGroupSeparatorPattern = new RegExp(`[${CHECKOUT_GROUP_SEPARATORS}]`, "gu");
const checkoutGroupedNumber = String.raw`[0-9]{1,3}(?:[${CHECKOUT_GROUP_SEPARATORS}][0-9]{3})+(?:[.,][0-9]+)?`;

function parseDisplayedNumber(value: string, minorDigits: number): number | null {
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  let normalized = value;
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const fractionLength = value.length - decimalIndex - 1;
    if (minorDigits > 0 && fractionLength > 0 && fractionLength <= minorDigits) {
      const integer = value.slice(0, decimalIndex).replace(/[.,]/g, "");
      normalized = `${integer}.${value.slice(decimalIndex + 1)}`;
    } else {
      normalized = value.replace(/[.,]/g, "");
    }
  } else if (comma >= 0) {
    const commaCount = (value.match(/,/g) ?? []).length;
    const fractionLength = value.length - comma - 1;
    normalized =
      commaCount === 1 && minorDigits > 0 && fractionLength > 0 && fractionLength <= minorDigits
        ? value.replace(",", ".")
        : value.replaceAll(",", "");
  } else if ((value.match(/\./g) ?? []).length > 1) {
    normalized = value.replaceAll(".", "");
  } else if (dot >= 0) {
    const fractionLength = value.length - dot - 1;
    normalized =
      minorDigits > 0 && fractionLength > 0 && fractionLength <= minorDigits
        ? value
        : value.replace(".", "");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const cjkLetter = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}`;
const checkoutTotalLabel =
  String.raw`(?:\b(?:order\s+total|grand\s+total|total\s+due|amount\s+due|total)\b` +
  String.raw`|(?<![${cjkLetter}])(?:ご注文合計|ご注文金額|お支払い合計|お支払合計|お支払い金額|お支払金額|ご請求金額|ご請求額` +
  String.raw`|税込(?:み)?(?:合計|総額|金額|価格)?|総合計|総計|総額|合計金額|合計|小計|注文合計|注文金額|支払い金額|支払金額|請求金額|請求額)(?![${cjkLetter}]))`;
const checkoutTotalPattern = new RegExp(
  checkoutTotalLabel +
    String.raw`(?:\s*[（(]税込み?[）)])?\s*[:：]?\s*(?:(\p{L}{1,4}\p{Sc}?)\s*)?(\p{Sc})?\s*(${checkoutGroupedNumber}|[0-9](?:[0-9.,]*[0-9])?)(?![0-9.,'’])(?:[^\S\r\n]*(\p{L}{1,4}\p{Sc}?|\p{Sc})(?=\s|$|[.,;:!?)（）(。、]))?(?![${cjkLetter}])`,
  "giu",
);

const CHECKOUT_COUNT_SUFFIXES = new Set([
  "点",
  "個",
  "件",
  "品",
  "枚",
  "本",
  "冊",
  "台",
  "ポイント",
]);
const CHECKOUT_TAX_EXCLUSIVE_PATTERN = /税抜|税別|本体価格/u;

function isCheckoutCountSuffix(token: string | undefined): boolean {
  if (token === undefined) return false;
  for (const counter of CHECKOUT_COUNT_SUFFIXES) {
    if (token.startsWith(counter)) return true;
  }
  return false;
}

interface PageCurrency {
  code: string;
  /** False only for a symbol several currencies share, where a currency fact
   * can say which one the page means. */
  unique: boolean;
}

function resolveCheckoutCurrencyToken(token: string | undefined): PageCurrency | undefined {
  if (token === undefined) return undefined;
  const upper = token.toUpperCase();
  if (CHECKOUT_CURRENCY_CODES.has(upper)) return { code: upper, unique: true };
  const codeWithSymbol = upper.match(/^([A-Z]{3})(\p{Sc})$/u);
  const code = codeWithSymbol?.[1];
  const symbol = codeWithSymbol?.[2];
  if (
    code !== undefined &&
    symbol !== undefined &&
    CHECKOUT_CURRENCY_CODES.has(code) &&
    CURRENCY_SYMBOLS[symbol] === code
  ) {
    return { code, unique: true };
  }
  const symbolKey = CURRENCY_SYMBOLS[token] !== undefined ? token : upper;
  const symbolCode = CURRENCY_SYMBOLS[symbolKey];
  return symbolCode === undefined
    ? undefined
    : { code: symbolCode, unique: !AMBIGUOUS_CURRENCY_SYMBOLS.has(symbolKey) };
}

/** A currency whose minor digits disagree with the fraction the page displays
 * would rescale the number, so the total is unreadable rather than rewritten.
 * A lone three-digit group reads as a thousands group only where no currency
 * spends three minor digits — under KWD/BHD `1,234` is genuinely either 1234
 * or 1.234, and a guess would show the human the wrong money. */
function displayedScaleMismatches(value: string, minorDigits: number): boolean {
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  const separator = Math.max(comma, dot);
  if (separator < 0) return false;
  const fractionLength = value.length - separator - 1;
  if (fractionLength === 3 && (comma < 0 || dot < 0)) {
    return (value.match(/[.,]/gu) ?? []).length === 1 && minorDigits >= 3;
  }
  return fractionLength > minorDigits;
}

function checkoutTextHasFreeShipping(text: string): boolean {
  return /(?:送料|配送料)\s*[:：]?\s*送料無料/u.test(text);
}

/** Null means the match is not a payable total line at all — a running or
 * tax-exclusive figure, a counted quantity, or a number carrying no currency. */
function payableTotalCurrency(
  text: string,
  match: RegExpMatchArray,
  factCurrency?: string,
): string | null {
  const matchEnd = (match.index ?? 0) + match[0].length;
  const trailingLine = text.slice(matchEnd).split(/\r?\n/u, 1)[0] ?? "";
  if (
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(match[1] ?? "") ||
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(match[4] ?? "") ||
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(trailingLine)
  ) {
    return null;
  }
  if (isCheckoutCountSuffix(match[4])) return null;
  const prefix = resolveCheckoutCurrencyToken(match[1]);
  const symbol = resolveCheckoutCurrencyToken(match[2]);
  const suffix = resolveCheckoutCurrencyToken(match[4]);
  const pageCurrency = prefix ?? suffix ?? symbol;
  if (pageCurrency === undefined) return null;
  return !pageCurrency.unique && factCurrency !== undefined ? factCurrency : pageCurrency.code;
}

/** Null here means the opposite: this IS the payable total and its number
 * cannot be read, so the caller owes the human an unknown total rather than a
 * running figure from higher up the summary. */
function payableTotalCents(displayed: string, currency: string): number | null {
  const minorDigits = currencyMinorDigits(currency);
  const value = displayed.replaceAll(checkoutGroupSeparatorPattern, "");
  if (displayedScaleMismatches(value, minorDigits)) return null;
  const amount = parseDisplayedNumber(value, minorDigits);
  if (amount === null) return null;
  const scale = 10 ** minorDigits;
  const minor = Math.round(amount * scale);
  return Math.abs(amount * scale - minor) > 1e-6 ? null : minor;
}

/** The payable total is the summary line, so the LAST labelled total in a
 * document wins over the running ones above it. */
export function parseCheckoutAmount(
  texts: readonly string[],
  factCurrency?: string,
): CheckoutAmount | null {
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    let payable: CheckoutAmount | null = null;
    let unreadable = false;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計") && !checkoutTextHasFreeShipping(text)) continue;
      const currency = payableTotalCurrency(text, match, factCurrency);
      if (currency === null) continue;
      const cents = payableTotalCents(match[3] ?? "", currency);
      if (cents === null) {
        unreadable = true;
        payable = null;
        continue;
      }
      unreadable = false;
      payable = { amount_cents: cents, currency };
    }
    if (unreadable) return null;
    if (payable !== null) return payable;
  }
  return null;
}

function factCurrency(facts: Record<string, string>): string | undefined {
  const raw = facts.currency?.trim().toUpperCase();
  return raw !== undefined && /^[A-Z]{3}$/.test(raw) ? raw : undefined;
}

function factAmountCents(facts: Record<string, string>): number | null {
  const raw = facts.amount_cents?.trim();
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatMinorAmount(minor: number, currency: string): string {
  const minorDigits = currencyMinorDigits(currency);
  return `${(minor / 10 ** minorDigits).toFixed(minorDigits)} ${currency}`;
}

/** The page total is the amount. A facts amount only confirms it — when the two
 * disagree the page still wins and the human is told they disagreed. */
export function resolveDriveApprovalAmount(
  pageTexts: readonly string[],
  facts: Record<string, string> = {},
): DriveApprovalAmount {
  const currencyFact = factCurrency(facts);
  const parsed = parseCheckoutAmount(pageTexts, currencyFact);
  if (parsed === null || parsed.amount_cents > APPROVAL_AMOUNT_CENTS_MAX) {
    return {
      amount_cents: 0,
      currency: currencyFact ?? "USD",
      unknown: true,
      note: CHECKOUT_TOTAL_UNREADABLE,
    };
  }
  const expected = factAmountCents(facts);
  const disagrees =
    expected !== null &&
    (expected !== parsed.amount_cents ||
      (currencyFact !== undefined && currencyFact !== parsed.currency));
  return {
    amount_cents: parsed.amount_cents,
    currency: parsed.currency,
    unknown: false,
    note: disagrees
      ? `agent expected ${formatMinorAmount(expected, currencyFact ?? parsed.currency)}, ` +
        `page shows ${formatMinorAmount(parsed.amount_cents, parsed.currency)}`
      : null,
  };
}

/** The note rides the item so the signed reason stays the agent's purpose. */
export function approvalItemWithNote(item: string, note: string | null): string {
  if (note === null) return item;
  const suffix = ` — ${note}`;
  const room = Math.max(APPROVAL_ITEM_MAX_CHARS - suffix.length, 0);
  return `${item.slice(0, room).trim()}${suffix}`;
}

export async function readPageCheckoutTexts(page: Page | null): Promise<string[]> {
  if (page === null) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = page.evaluate(() => document.body?.innerText ?? "");
  read.catch(() => undefined);
  try {
    const text = await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CHECKOUT_TEXT_READ_BUDGET_MS);
      }),
    ]);
    return text !== null && text.trim().length > 0 ? [text] : [];
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
