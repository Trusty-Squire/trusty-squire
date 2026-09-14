// Checkout parsing and reads, moved verbatim out of browser.ts (design PR 5 of
// data/ts-layer-contracts-design/report.md, §2.3 row "checkout parsers/reads").
//
// Plain functions over a Playwright Page: the parsers take the page text /
// structured-data extracts a capture already holds, and the readers take the
// Page (or frame tree) they read. browser.ts owns no checkout semantics.
import type { Frame, Page } from "playwright";

export interface CheckoutSummary {
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  // Set when sibling checkout frames render a different total/currency than
  // the one reported. A read-only report: the discrepancy is surfaced, never
  // a refusal that could block the purchase.
  total_conflict?: boolean;
}

export interface CheckoutReviewSummary extends CheckoutSummary {
  line_items: Array<{ title: string; quantity: number }>;
}

export interface CheckoutCard {
  pan: string;
  exp_month: string;
  exp_year: string;
  name: string;
  cvv: string;
  issuer?: string;
  issuer_source?: "bin_metadata" | "vault_metadata" | "vault_label";
  network?: string;
  label?: string;
  billing: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country: string;
  };
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

// Japanese has no \b word boundaries, so bare total labels (合計, 支払金額, …)
// are guarded against adjacent kana/kanji that would turn them into a
// different line item: 商品合計 is a merchandise subtotal, 合計数量 an item
// count, 合計ポイント points — none is the payable total. Honorific/compound
// forms (ご注文合計, お支払い金額, …) use the same guard so they only match as
// whole labels. A 税込 (tax-included) label annotation is skipped; 税抜
// (tax-EXCLUDED) deliberately is not — a pre-tax figure is not what the card
// is charged. A bare 小計 is also accepted: Rakuten cart pages use it as the
// only visible checkout amount. Summary readers retain every match, prefer the
// final payable label, and use 小計 only when no payable label resolves.
const cjkLetter = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}`;
const checkoutTotalLabel =
  String.raw`(?:\b(?:order\s+total|grand\s+total|total\s+due|amount\s+due|total)\b` +
  String.raw`|(?<![${cjkLetter}])(?:ご注文合計|ご注文金額|お支払い合計|お支払合計|お支払い金額|お支払金額|ご請求金額|ご請求額` +
  String.raw`|税込(?:み)?(?:合計|総額|金額|価格)?|総合計|総計|総額|合計金額|合計|小計|注文合計|注文金額|支払い金額|支払金額|請求金額|請求額)(?![${cjkLetter}]))`;
// The amount must end on a digit and (?![0-9.,]) makes it atomic: a rejected
// trailing guard fails the whole match instead of shortening the number
// (合計500円分のクーポン must never parse as ¥50), and a sentence period after
// the amount ("US$ 98.45.") can no longer be captured into the number, where
// the two-dot rule would strip the decimal point and inflate it 100×. The
// final CJK guard rejects an amount glued to trailing kana/kanji that the
// suffix group could not resolve to a currency (500円分, 3個セット).
const checkoutTotalPattern = new RegExp(
  checkoutTotalLabel +
    String.raw`(?:\s*[（(]税込み?[）)])?\s*[:：]?\s*(?:(\p{L}{1,4}\p{Sc}?)\s*)?(\p{Sc})?\s*([0-9](?:[0-9.,]*[0-9])?)(?![0-9.,])(?:[^\S\r\n]*(\p{L}{1,4}\p{Sc}?|\p{Sc})(?=\s|$|[.,;:!?)（）(。、]))?(?![${cjkLetter}])`,
  "giu",
);

// Amount suffixes that mark the number as a count, not a price. A match whose
// suffix is one of these is a quantity/points line (合計 3点, 合計 500ポイント)
// and must be skipped even when a fallback currency could label it.
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

type CheckoutAmount = { amount_cents: number; currency: string };

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

function classifyCheckoutCurrencyToken(token: string | undefined): string | undefined {
  return resolveCheckoutCurrencyToken(token);
}

// A lone separator with three trailing digits is ambiguous: it can be either a
// group ("1,000") or, for a three-minor-unit currency, a fraction ("1.000").
// Preserve the existing parser's handling of that case. Shorter trailing groups
// are an unambiguous displayed fractional scale and must agree with a fallback
// currency before that fallback can label the checkout.
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

function parseCheckoutAmountMatch(
  text: string,
  match: RegExpMatchArray,
  fallbackCurrency?: string,
  classifyCurrencyToken: (
    token: string | undefined,
  ) => string | undefined = classifyCheckoutCurrencyToken,
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
  if (isCheckoutCountSuffix(match[4])) {
    return null;
  }
  const prefix = classifyCurrencyToken(match[1]);
  const symbol = classifyCurrencyToken(match[2]);
  const suffix = classifyCurrencyToken(match[4]);
  // A page notation that can't be pinned to one ISO currency (a bare "$"/"¥"
  // shared by several locales, "R$", mismatched code+symbol, …) does not by
  // itself block the read — it just contributes no currency of its own, so
  // resolution falls through to the already-approved/selected fallbackCurrency
  // below, the same as a plain unlabeled number would. The remaining failure
  // mode is payment_checkout_total_not_found when no total can be pinned down
  // at all; currency ambiguity alone never refuses a purchase.
  const pageCurrency = prefix ?? suffix ?? symbol;
  const currency = (pageCurrency ?? fallbackCurrency)?.toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    return null;
  }
  const minorDigits = currencyMinorDigits(currency);
  if (pageCurrency === undefined && fallbackCurrencyScaleMismatches(match[3] ?? "", minorDigits)) {
    return null;
  }
  const amount = parseDisplayedNumber(match[3] ?? "", minorDigits);
  if (amount === null) {
    return null;
  }
  const scale = 10 ** minorDigits;
  const minor = Math.round(amount * scale);
  if (Math.abs(amount * scale - minor) > 1e-6) {
    return null;
  }
  return { amount_cents: minor, currency };
}

function parseCheckoutAmountResult(
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

export function parseCheckoutAmount(
  texts: readonly string[],
  fallbackCurrency?: string,
): { amount_cents: number; currency: string } | null {
  return parseCheckoutAmountResult(texts, fallbackCurrency);
}

interface CheckoutAmountsParseResult {
  amounts: CheckoutAmount[];
  payableAmounts: CheckoutAmount[];
}

function checkoutTextHasFreeShipping(text: string): boolean {
  return /(?:送料|配送料)\s*[:：]?\s*送料無料/u.test(text);
}

function parseCheckoutAmountsResult(
  texts: readonly string[],
  fallbackCurrency?: string,
): CheckoutAmountsParseResult {
  const amounts: CheckoutAmount[] = [];
  const payableAmounts: CheckoutAmount[] = [];
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計") && !checkoutTextHasFreeShipping(text)) continue;
      const amount = parseCheckoutAmountMatch(text, match, fallbackCurrency);
      if (amount !== null) {
        amounts.push(amount);
        if (!match[0].startsWith("小計")) payableAmounts.push(amount);
      }
    }
  }
  return { amounts, payableAmounts };
}

// Machine-readable order totals (schema.org). A checkout page that embeds its
// payable total as structured data labels it by construction —
// Order/Invoice.totalPaymentDue — which is language-independent and therefore
// reaches totals whose visible text label the prose parser doesn't recognize.
// Money-path restriction: ONLY totalPaymentDue on an Order/Invoice qualifies.
// An Offer/Product price is a UNIT price, never a checkout total, and is
// deliberately never read here.
export interface StructuredCheckoutDataExtract {
  jsonLd: string[];
  microdata: Array<{ price: string; currency: string; itemtype?: string }>;
}

// Runs in the page (frame.evaluate) — must stay self-contained.
function extractStructuredCheckoutData(): StructuredCheckoutDataExtract {
  const jsonLd = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json" i]'),
    (script) => script.textContent ?? "",
  ).filter((text) => text.trim().length > 0);
  const microdata: Array<{ price: string; currency: string; itemtype?: string }> = [];
  const isOrderScope = (itemtype: string | null): boolean =>
    (itemtype ?? "")
      .split(/\s+/)
      .some((token) => /^https?:\/\/schema\.org\/(?:Order|Invoice)\/?$/.test(token));
  const readValue = (element: Element | null): string =>
    (element?.getAttribute("content") ?? element?.textContent ?? "").trim();
  const ownsProperty = (owner: Element, property: Element): boolean => {
    let parent = property.parentElement;
    while (parent !== null && parent !== owner) {
      if (parent.hasAttribute("itemscope")) return false;
      parent = parent.parentElement;
    }
    return parent === owner;
  };
  for (const scope of Array.from(document.querySelectorAll("[itemscope][itemtype]"))) {
    if (!isOrderScope(scope.getAttribute("itemtype"))) continue;
    const dues = Array.from(scope.querySelectorAll('[itemprop~="totalPaymentDue"]')).filter((due) =>
      ownsProperty(scope, due),
    );
    for (const due of dues) {
      const prices = Array.from(due.querySelectorAll('[itemprop~="price"], [itemprop~="value"]'))
        .filter((property) => ownsProperty(due, property))
        .map((property) => readValue(property));
      const currencies = Array.from(
        due.querySelectorAll('[itemprop~="priceCurrency"], [itemprop~="currency"]'),
      )
        .filter((property) => ownsProperty(due, property))
        .map((property) => readValue(property));
      const count = Math.max(prices.length, currencies.length, 1);
      for (let index = 0; index < count; index += 1) {
        microdata.push({
          price: prices[index] ?? "",
          currency: currencies[index] ?? "",
          itemtype: due.getAttribute("itemtype") ?? "",
        });
      }
    }
  }
  return { jsonLd, microdata };
}

// Strict by design: a structured total is trusted only when its currency is a
// known ISO code and its amount is a plain schema.org decimal that lands on a
// whole minor unit. Anything else means "not confidently the payable total" —
// return null and let the caller fall through to the text parser.
function structuredCheckoutCandidate(
  priceRaw: unknown,
  currencyRaw: unknown,
): { amount_cents: number; currency: string } | null {
  if (typeof currencyRaw !== "string") return null;
  const currency = currencyRaw.trim().toUpperCase();
  if (!CHECKOUT_CURRENCY_CODES.has(currency)) return null;
  let price: number;
  if (typeof priceRaw === "number") {
    price = priceRaw;
  } else if (typeof priceRaw === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(priceRaw.trim())) {
    // schema.org mandates "." as the decimal point with no readability
    // separators; a value using any other notation is ambiguous — reject it
    // rather than guess at its locale.
    price = Number(priceRaw.trim());
  } else {
    return null;
  }
  // A zero total is more plausibly a template/product default than a genuinely
  // free checkout — fall through to the visible text for that case.
  if (!Number.isFinite(price) || price <= 0) return null;
  const scale = 10 ** currencyMinorDigits(currency);
  const minor = Math.round(price * scale);
  if (minor <= 0 || Math.abs(price * scale - minor) > 1e-6) return null;
  return { amount_cents: minor, currency };
}

function structuredCheckoutCandidateFromFields(
  fields: Record<string, unknown>,
): { amount_cents: number; currency: string } | null {
  const prices = ["price", "value"]
    .filter((key) => Object.prototype.hasOwnProperty.call(fields, key))
    .map((key) => fields[key]);
  const currencies = ["priceCurrency", "currency"]
    .filter((key) => Object.prototype.hasOwnProperty.call(fields, key))
    .map((key) => fields[key]);
  if (prices.length === 0 || currencies.length === 0) return null;
  let first: { amount_cents: number; currency: string } | null = null;
  for (const price of prices) {
    for (const currency of currencies) {
      const candidate = structuredCheckoutCandidate(price, currency);
      if (candidate === null) return null;
      if (first === null) {
        first = candidate;
      } else if (
        candidate.amount_cents !== first.amount_cents ||
        candidate.currency !== first.currency
      ) {
        return null;
      }
    }
  }
  return first;
}

function isSchemaOrgType(node: Record<string, unknown>, names: readonly string[]): boolean {
  const declared = node["@type"];
  const tokens = Array.isArray(declared) ? declared : [declared];
  return tokens.some(
    (token) =>
      typeof token === "string" &&
      names.includes(token.replace(/^https?:\/\/schema\.org\//, "").replace(/\/$/, "")),
  );
}

function hasCompatiblePayableType(declared: unknown): boolean {
  if (declared === undefined || declared === "") return true;
  const tokens = Array.isArray(declared)
    ? declared
    : typeof declared === "string"
      ? declared.split(/\s+/).filter((token) => token.length > 0)
      : [declared];
  return (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        typeof token === "string" &&
        ["PriceSpecification", "MonetaryAmount"].includes(
          token.replace(/^https?:\/\/schema\.org\//, "").replace(/\/$/, ""),
        ),
    )
  );
}

interface StructuredCheckoutCollection {
  candidates: Array<{ amount_cents: number; currency: string }>;
  invalid: boolean;
}

function collectJsonLdOrderTotals(
  node: unknown,
  collection: StructuredCheckoutCollection,
  depth: number,
): void {
  if (depth > 64) {
    collection.invalid = true;
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const entry of node) collectJsonLdOrderTotals(entry, collection, depth + 1);
    return;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(node));
  if (
    isSchemaOrgType(record, ["Order", "Invoice"]) &&
    Object.prototype.hasOwnProperty.call(record, "totalPaymentDue")
  ) {
    const due = record["totalPaymentDue"];
    const entries = Array.isArray(due) ? due : [due];
    if (entries.length === 0) collection.invalid = true;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        collection.invalid = true;
        continue;
      }
      const amount: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
      if (!hasCompatiblePayableType(amount["@type"])) {
        collection.invalid = true;
        continue;
      }
      const candidate = structuredCheckoutCandidateFromFields(amount);
      if (candidate === null) {
        collection.invalid = true;
      } else {
        collection.candidates.push(candidate);
      }
    }
  }
  // Order nodes can sit anywhere (@graph, nested containers) — walk everything.
  for (const value of Object.values(record)) collectJsonLdOrderTotals(value, collection, depth + 1);
}

/**
 * Resolve a confident machine-readable order total from per-frame structured
 * data extracts, or null. Null on ANY doubt — absent, malformed, unknown
 * currency, non-positive, fractional minor units, or multiple candidates that
 * disagree — so the caller always has the text-label parser to fall back on.
 * Inputs are typed unknown and re-validated at runtime: extracts cross the
 * evaluate boundary, so their shape is not statically guaranteed.
 */
export function parseStructuredCheckoutTotal(
  extracts: readonly unknown[],
): { amount_cents: number; currency: string } | null {
  const collection: StructuredCheckoutCollection = { candidates: [], invalid: false };
  for (const extract of extracts) {
    if (typeof extract !== "object" || extract === null) {
      collection.invalid = true;
      continue;
    }
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(extract));
    if (!Array.isArray(record["jsonLd"]) || !Array.isArray(record["microdata"])) {
      collection.invalid = true;
      continue;
    }
    const jsonLd = record["jsonLd"];
    const microdata = record["microdata"];
    for (const raw of jsonLd) {
      if (typeof raw !== "string") {
        collection.invalid = true;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        collection.invalid = true;
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) {
        collection.invalid = true;
        continue;
      }
      collectJsonLdOrderTotals(parsed, collection, 0);
    }
    for (const entry of microdata) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        collection.invalid = true;
        continue;
      }
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
      if (!hasCompatiblePayableType(fields["itemtype"])) {
        collection.invalid = true;
        continue;
      }
      const candidate = structuredCheckoutCandidate(fields["price"], fields["currency"]);
      if (candidate === null) {
        collection.invalid = true;
      } else {
        collection.candidates.push(candidate);
      }
    }
  }
  const first = collection.candidates[0];
  if (collection.invalid || first === undefined) return null;
  return collection.candidates.every(
    (candidate) =>
      candidate.amount_cents === first.amount_cents && candidate.currency === first.currency,
  )
    ? first
    : null;
}

// A standalone heading line that opens a "related products / recommendations"
// block whose prices must NEVER be mistaken for the checkout total. Rakuten
// cart pages bury the payable amount (only 小計 + 送料 送料無料) among ~30
// ショップ内の関連商品 prices; those block prices are not the order total.
// Anchored at the START of the line so a product/category NAME that merely
// contains "関連商品" mid-text is never treated as a section boundary.
const RECOMMENDATION_SECTION_HEADER =
  /^(?:ショップ内の関連商品|関連商品|関連item|おすすめ(?:商品)?|あなたへのおすすめ|こちらの商品(?:も|は)?|合わせて買う|セットで購入|人気商品|related\s*products|you\s+may\s+also\s+like|you\s+might\s+also\s+like|recommended(?:\s+for\s+you)?|more\s+(?:products|items)|similar\s+(?:products|items)|other\s+items?|picked\s+for\s+you)$/i;

/**
 * Drop the "related products / recommendations" tail from a checkout order-
 * summary innerText before parsing, so recommendation prices can never be
 * mistaken for (or selected over) the real payable total. Recommendations are
 * rendered below the cart summary in DOM order, so truncating at the first
 * recommendation-section heading — a short standalone line — is a faithful,
 * structurally-true boundary. The heading must be a short standalone line that
 * opens the block (anchored start, no price digits): a recap total inside a
 * long product sentence ("…おすすめ…") or a cart item line that merely carries
 * a price is never a heading, so it is never truncated.
 */
export function scopedOrderSummaryText(text: string): string {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    // Strip a trailing parenthetical count like "関連商品（3）" before judging
    // the line; a heading carries no price, so a bare "\d" is enough to veto it.
    const heading = line.replace(/[（(]\s*\d+\s*[）)]$/, "");
    if (heading.length === 0 || heading.length > 40) continue;
    if (/\d/.test(heading)) continue;
    if (RECOMMENDATION_SECTION_HEADER.test(heading)) {
      return lines.slice(0, index).join("\n");
    }
  }
  return text;
}

function extractCheckoutSummaryText(): string {
  const body = document.body;
  if (!body) return "";
  const excluded: Array<{ el: HTMLElement | SVGElement; style: string | null }> = [];
  try {
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      const tagName = el.tagName.toLowerCase();
      const semanticStrike = tagName === "del" || tagName === "s" || tagName === "strike";
      const computedStrike = window
        .getComputedStyle(el)
        .textDecorationLine.split(/\s+/)
        .includes("line-through");
      if (!semanticStrike && !computedStrike) continue;
      excluded.push({ el, style: el.getAttribute("style") });
      el.style.setProperty("display", "none", "important");
    }
    return body.innerText ?? "";
  } finally {
    for (const { el, style } of excluded.reverse()) {
      if (style === null) {
        el.style.removeProperty("display");
        if (el.getAttribute("style") === "") el.removeAttribute("style");
      } else {
        el.setAttribute("style", style);
      }
    }
  }
}

function merchantFromPage(title: string, siteName: string, url: string): string {
  if (siteName.trim().length > 0) return siteName.trim().slice(0, 256);
  const titlePart = title
    .split(/\s+[|—–-]\s+/)
    .find((part) => !/\b(checkout|payment|cart|order)\b/i.test(part));
  if (titlePart !== undefined && titlePart.trim().length > 0) {
    return titlePart.trim().slice(0, 256);
  }
  return new URL(url).hostname.replace(/^www\./, "").slice(0, 256);
}

export async function readCheckoutSummary(
  page: Page | null,
  fallbackCurrency?: string,
): Promise<CheckoutSummary> {
  if (!page) throw new Error("Browser not started");
  const identity = await page.evaluate(() => ({
    title: document.title,
    siteName:
      document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ??
      document.querySelector<HTMLElement>('[itemprop="merchant"]')?.textContent ??
      "",
  }));
  const frames = await visibleCheckoutFrames(page);
  const parsedFrames = await Promise.all(
    frames.map(async (frame) => {
      const [text, structuredExtract] = await Promise.all([
        scopedOrderSummaryText(await frame.evaluate(extractCheckoutSummaryText).catch(() => "")),
        frame.evaluate(extractStructuredCheckoutData).catch(() => null),
      ]);
      const parsedAmounts = parseCheckoutAmountsResult([text], fallbackCurrency);
      const textAmount = parsedAmounts.payableAmounts.at(-1) ?? parsedAmounts.amounts.at(-1);
      return textAmount ?? parseStructuredCheckoutTotal([structuredExtract]);
    }),
  );
  // Currency ambiguity on the page (a shared symbol, an FX-preview module,
  // …) never blocks this read by itself — an unpinned notation simply
  // contributes no amount for that occurrence (see parseCheckoutAmountMatch)
  // and resolution falls through to another candidate. If no candidate can
  // be resolved, the existing payment_checkout_total_not_found path below
  // handles it; currency ambiguity has no separate refusal status.
  // Structured-data order total (schema.org Order/Invoice.totalPaymentDue).
  // Used only when the visible text yields no clean labeled total: a
  // structured total that CONTRADICTS a clean visible one can't be confirmed
  // current (stale server-rendered JSON-LD is a real pattern), so the total
  // the user actually sees wins; when both agree the value is identical
  // either way. Net effect: structured data only ever rescues a
  // total_not_found, never overrides the text path or its currency resolution.
  const mainAmount = parsedFrames[0] ?? null;
  const childAmounts = parsedFrames
    .slice(1)
    .filter((amount): amount is NonNullable<typeof amount> => amount !== null);
  const amount = mainAmount ?? childAmounts[0] ?? null;
  if (amount === null) throw new Error("payment_checkout_total_not_found");
  if (
    childAmounts.some(
      (child) => child.amount_cents !== amount.amount_cents || child.currency !== amount.currency,
    )
  ) {
    throw new Error("payment_checkout_total_not_found");
  }
  return {
    merchant: merchantFromPage(identity.title, identity.siteName, page.url()),
    checkout_origin: new URL(page.url()).origin,
    ...amount,
  };
}

async function visibleCheckoutFrames(page: Page | null): Promise<Frame[]> {
  if (!page) return [];
  const mainFrame = page.mainFrame();
  const visible: Frame[] = [mainFrame];
  for (const frame of page.frames()) {
    if (frame === mainFrame) continue;
    let current: Frame | null = frame;
    let frameVisible = true;
    while (current !== null && current !== mainFrame) {
      try {
        const owner = await current.frameElement();
        try {
          const rendered = await owner.evaluate((element) => {
            let currentElement: Element | null = element as Element;
            while (currentElement !== null) {
              const style = window.getComputedStyle(currentElement);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                Number.parseFloat(style.opacity) <= 0
              ) {
                return false;
              }
              currentElement = currentElement.parentElement;
            }
            return true;
          });
          if (!(await owner.isVisible()) || !rendered) {
            frameVisible = false;
            break;
          }
        } finally {
          await owner.dispose().catch(() => undefined);
        }
      } catch {
        frameVisible = false;
        break;
      }
      current = current.parentFrame();
    }
    if (frameVisible && current === mainFrame) visible.push(frame);
  }
  return visible;
}

/**
 * Read a settled checkout-review amount.  Checkout pages can retain an
 * earlier subtotal while asynchronously replacing the final labeled total;
 * the harness calls this only after it has proved a shipping method is
 * present, then requires this value to remain stable across two reads.
 * This is a review-only, pre-payment reader whose amount must settle before
 * the payment flow continues.
 */
export async function readCheckoutReviewSummary(
  page: Page | null,
  fallbackCurrency?: string,
): Promise<CheckoutSummary> {
  if (!page) throw new Error("Browser not started");
  const identity = await page.evaluate(() => ({
    title: document.title,
    siteName:
      document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ??
      document.querySelector<HTMLElement>('[itemprop="merchant"]')?.textContent ??
      "",
  }));
  const frames = await visibleCheckoutFrames(page);
  const parsedFrames = await Promise.all(
    frames.map(async (frame) => {
      const [text, structuredExtract] = await Promise.all([
        scopedOrderSummaryText(await frame.evaluate(extractCheckoutSummaryText).catch(() => "")),
        frame.evaluate(extractStructuredCheckoutData).catch(() => null),
      ]);
      const parsedAmounts = parseCheckoutAmountsResult([text], fallbackCurrency);
      const textAmount = parsedAmounts.payableAmounts.at(-1) ?? parsedAmounts.amounts.at(-1);
      return textAmount ?? parseStructuredCheckoutTotal([structuredExtract]);
    }),
  );
  // Same structured-data precedence as readCheckoutSummary: a machine-
  // readable order total fills in only when no clean labeled text total
  // exists, so the settled-amount contract (readSettledCheckoutReviewSummary
  // re-reads until two consecutive reads agree) is unchanged — a structured
  // total is simply re-read and must be stable like any other source.
  const mainAmount = parsedFrames[0] ?? null;
  const childAmounts = parsedFrames
    .slice(1)
    .filter((amount): amount is NonNullable<typeof amount> => amount !== null);
  const amount = mainAmount ?? childAmounts[0] ?? null;
  if (amount === null) throw new Error("payment_checkout_total_not_found");
  const totalConflict = childAmounts.some(
    (child) => child.amount_cents !== amount.amount_cents || child.currency !== amount.currency,
  );
  return {
    merchant: merchantFromPage(identity.title, identity.siteName, page.url()),
    checkout_origin: new URL(page.url()).origin,
    ...amount,
    ...(totalConflict ? { total_conflict: true } : {}),
  };
}

export async function readCheckoutReviewLineItems(
  page: Page | null,
): Promise<Array<{ title: string; quantity: number }>>;
export async function readCheckoutReviewLineItems(
  page: Page | null,
  includeDetails: true,
): Promise<
  Array<{
    title: string;
    quantity: number;
    details: string;
    product_identities: string[];
    option_signatures: string[];
  }>
>;
export async function readCheckoutReviewLineItems(
  page: Page | null,
  includeDetails = false,
): Promise<
  Array<{
    title: string;
    quantity: number;
    details?: string;
    product_identities?: string[];
    option_signatures?: string[];
  }>
> {
  if (!page) throw new Error("Browser not started");
  const items = await page.evaluate(() => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const visible = (element: Element): boolean => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const quantityIn = (container: Element): number | undefined => {
      const field = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[name*="quantity" i], input[aria-label*="quantity" i], select[name*="quantity" i]',
        ),
      ).find(visible);
      const fieldValue = field?.value === undefined ? Number.NaN : Number(field.value);
      if (Number.isInteger(fieldValue) && fieldValue > 0) return fieldValue;
      const text = normalize(container.textContent ?? "");
      const labeled = /\bquantity\s*:?[\s\n]*(\d+)\b/i.exec(text)?.[1];
      const parsed = Number(labeled);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    };
    const titleFrom = (container: Element): string | undefined => {
      const candidates = [
        ...Array.from(
          container.querySelectorAll<HTMLElement>(
            'a[href*="/products/"], [data-testid*="title" i], [class*="title" i], h1, h2, h3, h4, td, [role="cell"]',
          ),
          (element) => normalize(element.innerText),
        ),
        ...Array.from(container.querySelectorAll<HTMLImageElement>("img[alt]"), (image) =>
          normalize(image.alt),
        ),
      ];
      return candidates.find(
        (candidate) =>
          candidate.length > 0 &&
          candidate.length <= 240 &&
          !/^product(?: image| information)?$/i.test(candidate) &&
          !/^quantity\b/i.test(candidate) &&
          !/^\$|\$\s*\d/.test(candidate),
      );
    };
    const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
    const productIdentitiesIn = (container: Element): string[] => {
      const identities: string[] = [];
      const candidates = [container, ...Array.from(container.querySelectorAll("*"))];
      for (const element of candidates) {
        const explicit = element.getAttribute("data-product-identity");
        const sku =
          element.getAttribute("data-sku") ??
          (element.getAttribute("itemprop") === "sku"
            ? (element.getAttribute("content") ?? element.textContent?.trim() ?? "")
            : "");
        const productId = element.getAttribute("data-product-id");
        if (explicit !== null) identities.push(explicit);
        if (sku.length > 0) identities.push(sku, `sku:${sku}`);
        if (productId !== null) identities.push(productId, `product:${productId}`);
      }
      for (const link of Array.from(
        container.querySelectorAll<HTMLAnchorElement>('a[href*="/product" i]'),
      )) {
        identities.push(link.href);
      }
      return unique(identities.map((identity) => normalize(identity)));
    };
    const optionSignaturesIn = (container: Element): string[] => {
      const signatures: string[] = [];
      const candidates = [container, ...Array.from(container.querySelectorAll("*"))];
      for (const element of candidates) {
        for (const attribute of ["data-options-hash", "data-option-signature"]) {
          const value = element.getAttribute(attribute);
          if (value !== null) signatures.push(value);
        }
        const optionName = element.getAttribute("data-option-name");
        const optionValue = element.getAttribute("data-option-value");
        if (optionName !== null && optionValue !== null) {
          signatures.push(`${optionName}=${optionValue}`);
        }
      }
      for (const select of Array.from(
        container.querySelectorAll<HTMLSelectElement>("select[name]"),
      )) {
        const option = select.selectedOptions[0];
        if (option !== undefined) {
          signatures.push(
            `${select.name}=${option.value}`,
            `${select.name}=${normalize(option.text)}`,
          );
        }
      }
      return unique(signatures.map((signature) => normalize(signature)));
    };
    const rows = Array.from(
      document.querySelectorAll(
        'tr, [role="row"], [data-testid*="line-item" i], [data-testid*="product" i], [class*="line-item" i], [class*="product" i]',
      ),
    )
      .filter(visible)
      .filter(
        (row, _index, candidates) =>
          !candidates.some(
            (candidate) =>
              candidate !== row &&
              row.contains(candidate) &&
              quantityIn(candidate) !== undefined &&
              titleFrom(candidate) !== undefined,
          ),
      );
    const observed = rows.flatMap((row) => {
      const quantity = quantityIn(row);
      const title = titleFrom(row);
      return quantity === undefined || title === undefined
        ? []
        : [
            {
              title,
              quantity,
              details: normalize(row.textContent ?? ""),
              product_identities: productIdentitiesIn(row),
              option_signatures: optionSignaturesIn(row),
            },
          ];
    });
    return observed;
  });
  return includeDetails ? items : items.map(({ title, quantity }) => ({ title, quantity }));
}

// Deterministic cart-normalize primitive: Shopify's standard Ajax Cart API
// exposes POST /cart/clear.js on every storefront's own origin — no DOM
// markup dependency, so it works regardless of theme. This is how an
// operator reaches a KNOWN (empty) cart quantity before a fresh cart_add,
// rather than accumulating quantity across separate operate_start sessions
// on the shared persistent profile.
export async function clearCart(page: Page | null): Promise<boolean> {
  if (!page) throw new Error("Browser not started");
  return await page.evaluate(async () => {
    try {
      const response = await fetch("/cart/clear.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return response.ok;
    } catch {
      return false;
    }
  });
}

export async function readSettledCheckoutReviewSummary(
  page: Page | null,
  fallbackCurrency?: string,
  timeoutMs = 12_000,
): Promise<CheckoutReviewSummary | undefined> {
  if (!page) throw new Error("Browser not started");
  const deadline = Date.now() + timeoutMs;
  let previous: CheckoutReviewSummary | undefined;
  while (Date.now() < deadline) {
    const shippingReady = await page
      .evaluate(() => {
        const labels = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        )
          .flatMap((input) => [
            ...(input.labels === null ? [] : Array.from(input.labels, (label) => label.innerText)),
            input.getAttribute("aria-label") ?? "",
            input.closest("label")?.textContent ?? "",
          ])
          .map((label) => label.replace(/\s+/g, " ").trim())
          .filter((label) => label.length > 0 && !/loading/i.test(label));
        return (
          /\bdelivery\b|\bshipping\b/i.test(document.body?.innerText ?? "") &&
          labels.some((label) => /\b(?:standard|express|shipping|delivery|pickup)\b/i.test(label))
        );
      })
      .catch(() => false);
    if (shippingReady) {
      const current = await Promise.all([
        readCheckoutReviewSummary(page, fallbackCurrency),
        readCheckoutReviewLineItems(page),
      ])
        .then(([summary, line_items]) => ({ ...summary, line_items }))
        .catch(() => undefined);
      if (
        current !== undefined &&
        current.line_items.length > 0 &&
        previous !== undefined &&
        JSON.stringify(current) === JSON.stringify(previous)
      ) {
        return current;
      }
      previous = current;
    }
    await page.waitForTimeout(250);
  }
  return undefined;
}
