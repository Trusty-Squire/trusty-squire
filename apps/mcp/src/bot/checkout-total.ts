// Text-only checkout total parser, restored from the pre-#782 pay-path
// reader. Page.evaluate readers that threw payment_checkout_total_not_found
// stay deleted: an unreadable total must still mint, never refuse.

import type { Page } from "playwright";
import { evaluateBound } from "./drive-evaluate.js";

export const CHECKOUT_TOTAL_UNREADABLE = "total not readable";

/** inject_card's inputSchema and POST /v1/pay/approvals both cap amount_cents
 * here. A page number above it would 400 the mint and block the purchase. */
const APPROVAL_AMOUNT_CENTS_MAX = 2_147_483_647;

export interface CheckoutAmount {
  amount_cents: number;
  currency: string;
}

export interface DriveApprovalAmount extends CheckoutAmount {
  unknown: boolean;
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

const CHECKOUT_CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

export function currencyMinorDigits(currency: string): number {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits!;
}

function parseDisplayedNumber(raw: string, minorDigits: number): number | null {
  const value = raw.replace(/\s/g, "");
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
    String.raw`(?:\s*[（(]税込み?[）)])?\s*[:：]?\s*(?:(\p{L}{1,4}\p{Sc}?)\s*)?(\p{Sc})?\s*([0-9](?:[0-9.,]*[0-9])?)(?![0-9.,])(?:[^\S\r\n]*(\p{L}{1,4}\p{Sc}?|\p{Sc})(?=\s|$|[.,;:!?)（）(。、]))?(?![${cjkLetter}])`,
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

function resolveCheckoutCurrencyToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const upper = token.toUpperCase();
  if (CHECKOUT_CURRENCY_CODES.has(upper)) return upper;
  const codeWithSymbol = upper.match(/^([A-Z]{3})(\p{Sc})$/u);
  const code = codeWithSymbol?.[1];
  const symbol = codeWithSymbol?.[2];
  if (
    code !== undefined &&
    symbol !== undefined &&
    CHECKOUT_CURRENCY_CODES.has(code) &&
    CURRENCY_SYMBOLS[symbol] === code
  ) {
    return code;
  }
  return CURRENCY_SYMBOLS[token] ?? CURRENCY_SYMBOLS[upper];
}

function fallbackCurrencyScaleMismatches(raw: string, minorDigits: number): boolean {
  const value = raw.replace(/\s/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  const separator = Math.max(comma, dot);
  if (separator < 0) return false;
  const fractionLength = value.length - separator - 1;
  if (fractionLength === 3 && (comma < 0 || dot < 0)) return false;
  return fractionLength > minorDigits;
}

function checkoutTextHasFreeShipping(text: string): boolean {
  return /(?:送料|配送料)\s*[:：]?\s*送料無料/u.test(text);
}

function parseCheckoutAmountMatch(
  text: string,
  match: RegExpMatchArray,
  fallbackCurrency?: string,
): CheckoutAmount | null {
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
  const currency = (pageCurrency ?? fallbackCurrency)?.toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) return null;
  const minorDigits = currencyMinorDigits(currency);
  if (pageCurrency === undefined && fallbackCurrencyScaleMismatches(match[3] ?? "", minorDigits)) {
    return null;
  }
  const amount = parseDisplayedNumber(match[3] ?? "", minorDigits);
  if (amount === null) return null;
  const scale = 10 ** minorDigits;
  const minor = Math.round(amount * scale);
  if (Math.abs(amount * scale - minor) > 1e-6) return null;
  return { amount_cents: minor, currency };
}

export function parseCheckoutAmount(
  texts: readonly string[],
  fallbackCurrency?: string,
): CheckoutAmount | null {
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計") && !checkoutTextHasFreeShipping(text)) continue;
      const amount = parseCheckoutAmountMatch(text, match, fallbackCurrency);
      if (amount !== null) return amount;
    }
  }
  return null;
}

function factCurrency(facts: Record<string, string>): string | undefined {
  const raw = facts.currency?.trim().toUpperCase();
  return raw !== undefined && /^[A-Z]{3}$/.test(raw) ? raw : undefined;
}

/** Page total wins. A facts amount may confirm it or sit above it as a cap; it never replaces it. */
export function resolveDriveApprovalAmount(
  pageTexts: readonly string[],
  facts: Record<string, string> = {},
): DriveApprovalAmount {
  const fallback = factCurrency(facts);
  const parsed = parseCheckoutAmount(pageTexts, fallback ?? "USD");
  if (parsed === null || parsed.amount_cents > APPROVAL_AMOUNT_CENTS_MAX) {
    return { amount_cents: 0, currency: fallback ?? "USD", unknown: true };
  }
  return { amount_cents: parsed.amount_cents, currency: parsed.currency, unknown: false };
}

export async function readPageCheckoutTexts(page: Page | null): Promise<string[]> {
  if (page === null) return [];
  try {
    const text = await evaluateBound(page, () => document.body?.innerText ?? "");
    return text.trim().length > 0 ? [text] : [];
  } catch {
    return [];
  }
}
