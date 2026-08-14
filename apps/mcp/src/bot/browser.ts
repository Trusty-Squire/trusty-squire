// Browser automation wrapper for universal signup bot
// Provides simple interface for AI agent to control browser.
//
// Two layers of bot-resistance:
//
// 1. Stealth fingerprinting (playwright-extra + puppeteer-extra-plugin-
//    stealth). Patches ~17 client-side tells: navigator.webdriver,
//    navigator.plugins, missing chrome runtime, WebGL vendor/renderer,
//    permissions.query for notifications, etc. This handles the
//    *fingerprint* side of bot detection.
//
// 2. Human-like behavior (this file, when humanize=true). Adds bezier
//    mouse paths to clicks, variable typing delays with thinking pauses,
//    dwell time after page loads, hover-then-click hesitations. This
//    handles the *behavior* side — the bit that fingerprint spoofing
//    alone won't get past, because modern Cloudflare/reCAPTCHA scoring
//    correlates mouse-path entropy and inter-keystroke timing.
//
// Together with the user's residential IP (the bot runs on user
// machines, not on Fly), these are sufficient for invisible-mode
// Turnstile/reCAPTCHA-v3 scoring on most SaaS signups. Visible-mode
// captchas still need the click-and-wait pattern (the Tier 2 captcha
// gate).

import { chromium as baseChromium } from "playwright";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  FileChooser,
  Frame,
  Locator,
  Page,
} from "playwright";
import { createRequire } from "node:module";
import { Socket, createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { isSameRecipeDomain } from "@trusty-squire/recipe-schema";
import { detectAsn, type AsnClass } from "./asn.js";
import {
  acquireFreeProfileOperationGuard,
  CHROME_PROFILE_DIR,
  clearStaleSingletonLock,
  closeProfileWithProof,
  currentProfileHolderPid,
  launchWithProfileGate,
  profilePathIdentity,
  profileProcessIdentity,
  profileProcessIdentityState,
  profileProcessMatches,
  PROFILE_BUSY_MESSAGE,
  ProfileBusyError,
  reapProfileHolderIfOwned,
  signalProfileProcess,
  type ProfileProcessIdentity,
  type ProfileOperationLease,
  type ProfileCloseState,
  waitForProfileFree,
} from "./profile.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import type { TwoCaptchaCoordinatesResult } from "./captcha-solver-2captcha.js";
import {
  GOOGLE_LOGIN_COOKIE_MARKERS,
  type OperatorWorkerIdentity,
} from "./operator-profile-pool.js";
import { startXvfb, xvfbAvailable, type XvfbRig } from "./xvfb.js";

// Lazy registration: installing the plugin mutates the chromium singleton
// from playwright-extra so we only do it once per process. We require()
// the CJS modules lazily (the stealth toolchain only ships CJS) and treat
// stealth as best-effort — a missing dep should never crash the bot.
const require = createRequire(import.meta.url);

export type StealthProfile = "baseline" | "cdp_hardened";

export type ContextInitScriptId = "evaluate-name-shim" | "navigator-webdriver" | "webgl-spoof";

export function contextInitScriptsFor(options: {
  hardened: boolean;
  remoteMode: boolean;
}): ContextInitScriptId[] {
  if (options.hardened) return [];
  return [
    "evaluate-name-shim",
    "navigator-webdriver",
    ...(options.remoteMode ? [] : (["webgl-spoof"] as const)),
  ];
}

export interface PageTargetSafetySignals {
  billingObject: boolean;
  accountSetup: boolean;
}

export interface FrameTarget {
  framePath: string;
  frameOrigin: string;
  frameUrl: string;
  frameOpaque?: boolean;
}

export type ResolvedPageTarget =
  | {
      ok: true;
      handle: ElementHandle<Element>;
      text: string;
      labels: string[];
      safetySignals: PageTargetSafetySignals;
      frameTarget: FrameTarget | null;
    }
  | { ok: false; reason: "none" | "ambiguous"; candidates: string[] };

// Whether to use the CDP-hardened launcher (patchright, which runs
// evaluations in an isolated world and removes the automation tells —
// mainWorldExecution, navigator.webdriver, viewport — that Turnstile /
// reCAPTCHA-v3 / Google's consent SPA score on). See
// docs/ARCHITECTURE.md.
//
// 2026-06-08 — DEFAULT FLIPPED ON. The baseline (playwright-extra +
// stealth) self-inflicts a detectable navigator.webdriver via its manual
// defineProperty patch, so it is strictly WORSE on the fingerprint. The
// hardened launcher is all-green on the rebrowser bot-detector and was
// live-A/B'd: meilisearch's Google consent-SPA block became a (handleable)
// FedCM path, and render still signed up + extracted a key cleanly — no
// crash on either (the old crash was the retired rebrowser fork, not
// patchright). Default to hardened; opt out with BOT_CDP_HARDENED=0 for
// the baseline. If patchright isn't installed, getChromium() falls back to
// baseline gracefully.
function cdpHardeningRequested(): boolean {
  const v = process.env.BOT_CDP_HARDENED;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

let cachedChromium: typeof baseChromium | null = null;
// The stealth profile the cached launcher actually represents. Set the
// first time getChromium() resolves a launcher and read back via
// BrowserController.stealthProfile for the CaptchaEvent A/B tag. A
// patchright load failure degrades it to "baseline" truthfully rather
// than over-claiming "cdp_hardened" on a run that never got the patch.
let activeStealthProfile: StealthProfile = "baseline";

function activeStealthProfileValue(): StealthProfile {
  return activeStealthProfile;
}

function getChromium(): typeof baseChromium {
  if (cachedChromium !== null) return cachedChromium;
  const hardened = cdpHardeningRequested();
  try {
    if (hardened) {
      // patchright — a maintained Playwright fork that runs every
      // evaluation in an ISOLATED world (so the bot's DOM probing is
      // invisible to a page that traps DOM methods → closes the
      // `mainWorldExecution` tell) and handles `navigator.webdriver`
      // natively + correctly. Verified ALL-GREEN against the maintained
      // rebrowser bot-detector (mainWorldExecution, navigatorWebdriver,
      // viewport, runtimeEnableLeak all clean). It drives real Chrome
      // (channel) directly — the earlier rebrowser fork couldn't, which is
      // why the old hardened arm was forced onto bundled chromium and then
      // crashed the OAuth flow. NO playwright-extra/stealth wrap here: the
      // stealth plugin's manual `navigator.webdriver` defineProperty
      // RE-ADDS a detectable property (proven counterproductive) — patchright
      // does it right. See docs/ARCHITECTURE.md.
      const patchright = require("patchright") as { chromium: typeof baseChromium };
      cachedChromium = patchright.chromium;
      activeStealthProfile = "cdp_hardened";
      return cachedChromium;
    }
    // Baseline: playwright-extra + stealth (unchanged). addExtra(baseChromium)
    // is exactly what playwright-extra's default `chromium` export already is.
    const { addExtra } = require("playwright-extra") as {
      addExtra: (launcher: unknown) => { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    activeStealthProfile = "baseline";
    const extra = addExtra(baseChromium);
    extra.use(stealth());
    cachedChromium = extra as unknown as typeof baseChromium;
  } catch (err) {
    // Fall back to vanilla playwright if stealth (or the rebrowser fork)
    // isn't installed. The bot still works, it's just easier to
    // fingerprint as a bot — and the A/B tag stays truthfully "baseline".
    console.warn(
      `[operator] hardened launcher unavailable, falling back to vanilla chromium: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    cachedChromium = baseChromium;
    activeStealthProfile = "baseline";
  }
  return cachedChromium;
}

export interface BrowserAction {
  type: "goto" | "click" | "type" | "screenshot" | "extract" | "wait";
  selector?: string;
  text?: string;
  url?: string;
}

export interface BrowserState {
  url: string;
  title: string;
  html: string;
  screenshot: string; // base64
}

export interface CheckoutSummary {
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
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
  billing: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country: string;
  };
}

interface CheckoutCardGroupRoot {
  frame: Frame;
  root: Locator;
  token: string;
}

interface CheckoutCardGroupScope {
  selected: CheckoutCardGroupRoot;
  groups: readonly CheckoutCardGroupRoot[];
}

interface CheckoutPaymentFieldRoot {
  frame: Frame;
  token: string;
}

interface CheckoutOutcomeBaseline {
  url: string;
  orderUrlIdentities: readonly string[];
  terminalUrlIdentity: string | null;
}

interface CheckoutOutcomeDispatchSnapshot {
  url: string;
}

type CheckoutFailureBaseline = Readonly<Record<string, number>> | null;

export interface CheckoutSubmitResult {
  three_ds_required: boolean;
  // A dispatched click is not a payment outcome. The submit path sets this
  // only after it observes a terminal merchant order route.
  order_confirmed: boolean;
  challenge_url?: string;
}

export type ThreeDsResolution = "succeeded" | "failed" | "timeout" | "unconfirmed";

const THREE_DS_RESOLUTION_GRACE_MS = 5_000;

interface CheckoutFrameDescriptor {
  url: string;
  name: string;
  title: string;
}

// Recognized payment-provider frames — the ONLY cross-registrable-domain
// frames the fill-without-charge step (operate_pay phase="fill_card") may put
// the vaulted card into. This mirrors the vault's egress model: the card may
// travel to a surface we can confidently attribute to a legitimate payment
// processor, never to an arbitrary third-party iframe (a possible rogue/
// phishing frame) that merely appears on an in-scope page. Entries are host
// suffixes: a domain is listed at the registrable level only when the whole
// domain IS the processor (everything under stripe.com is Stripe); a
// mixed-purpose domain is pinned to its payment platform subdomain
// (rakuten.com is a marketplace — only payment.global.rakuten.com, the
// Rakuten Payment platform that serves the hosted card fields observed live
// at static-content.payment.global.rakuten.com, qualifies). Deliberately
// minimal; extend only with evidence of the processor's hosted-field host.
const RECOGNIZED_PAYMENT_PROVIDER_FRAME_HOSTS: readonly string[] = [
  "stripe.com", // Stripe Elements / Payment Element iframes (js.stripe.com)
  "adyen.com", // Adyen web components hosted fields (checkoutshopper-*.adyen.com)
  "braintreegateway.com", // Braintree Hosted Fields (assets.braintreegateway.com)
  "paypal.com", // Scope classification only; an actual PayPal PAN frame is refused before fill
  "worldpay.com", // Worldpay / Access Worldpay hosted payment fields
  "payment.global.rakuten.com", // Rakuten Payment platform hosted card fields
  "checkout.pci.shopifyinc.com", // Shopify PCI-compliant hosted card fields
];

// True when a child frame is a surface the vaulted card may be filled into:
// the merchant's own registrable domain (its payment subdomain included), or
// a curated recognized payment processor — https only. Anything else is
// refused: a failed fill is far better than a card sent to a rogue frame.
export function recognizedPaymentProviderFrame(frameUrl: string, pageUrl: string): boolean {
  let frame: URL;
  try {
    frame = new URL(frameUrl);
  } catch {
    return false;
  }
  if (frame.protocol !== "https:") return false;
  if (isSameRecipeDomain(frameUrl, pageUrl)) return true;
  const host = frame.hostname.toLowerCase();
  return RECOGNIZED_PAYMENT_PROVIDER_FRAME_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

// Card fields exist on the page but only inside a frame that is NOT a
// recognized payment-provider surface. Carries the frame origin so the
// refusal names what was refused without ever filling it.
export class UnrecognizedPaymentFrameError extends Error {
  readonly frameOrigin: string;
  constructor(frameOrigin: string) {
    super("payment_frame_not_recognized");
    this.frameOrigin = frameOrigin;
  }
}

export class PaymentCardFillCleanupError extends Error {
  readonly paymentFieldsCleared = false;
  readonly frameOrigin?: string;

  constructor(error: unknown) {
    const source = error instanceof Error ? error : new Error("payment_card_fill_failed");
    super(source.message);
    this.name = "PaymentCardFillCleanupError";
    if (source instanceof UnrecognizedPaymentFrameError) this.frameOrigin = source.frameOrigin;
  }
}

export class PaymentSubmitOutcomeUnknownError extends Error {
  constructor() {
    super("payment_submit_outcome_unknown");
    this.name = "PaymentSubmitOutcomeUnknownError";
  }
}

const CHECKOUT_TERMINAL_RESERVED_SEGMENTS = new Set([
  "about_blank",
  "blank",
  "checkout",
  "checkouts",
  "complete",
  "confirmation",
  "confirmed",
  "loading",
  "lookup",
  "masked",
  "n_a",
  "na",
  "new",
  "null",
  "not_available",
  "order",
  "orders",
  "pending",
  "preview",
  "processing",
  "receipt",
  "receipts",
  "success",
  "thank_you",
  "undefined",
  "unknown",
]);

const CHECKOUT_TERMINAL_PLACEHOLDER_TOKENS = new Set([
  "blank",
  "complete",
  "confirmation",
  "confirmed",
  "loading",
  "lookup",
  "masked",
  "new",
  "null",
  "pending",
  "preview",
  "processing",
  "success",
  "undefined",
  "unknown",
]);

function isSubstantiveCheckoutIdentity(identity: string): boolean {
  const rawIdentity = identity.normalize("NFKC").trim();
  if (/(?:x{2,}|[*•●◦▪■□×])/iu.test(rawIdentity)) return false;
  const normalizedIdentity = rawIdentity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalizedIdentity.length === 0) return false;
  if (CHECKOUT_TERMINAL_RESERVED_SEGMENTS.has(normalizedIdentity)) return false;
  const identityTokens = normalizedIdentity.split("_").filter(Boolean);
  if (
    identityTokens.length === 0 ||
    identityTokens.every((token) => /^0+$/.test(token)) ||
    identityTokens.some((token) => CHECKOUT_TERMINAL_PLACEHOLDER_TOKENS.has(token))
  ) {
    return false;
  }
  const compactIdentity = identityTokens.join("");
  return !/^x{2,}\d*$/i.test(compactIdentity);
}

function checkoutOutcomeBaselineFromDispatchSnapshot(
  snapshot: CheckoutOutcomeDispatchSnapshot,
): CheckoutOutcomeBaseline {
  const identities = checkoutUrlOrderIdentities(snapshot.url);
  return {
    url: snapshot.url,
    orderUrlIdentities: identities?.orders ?? [],
    terminalUrlIdentity: identities?.terminal ?? null,
  };
}

function checkoutUrlOrderIdentities(
  rawUrl: string,
): { orders: readonly string[]; terminal: string | null } | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    const routeSegment = (offset: number): string =>
      (segments.at(offset) ?? "").toLowerCase().replace(/-/g, "_");
    if (
      segments.some((segment) =>
        ["about_blank", "blank"].includes(segment.toLowerCase().replace(/[-:]/g, "_")),
      )
    ) {
      return null;
    }
    const canonicalIdentity = (identity: string | undefined): string | null => {
      if (identity === undefined || !isSubstantiveCheckoutIdentity(identity)) return null;
      const normalizedIdentity = identity.normalize("NFKC").trim().toLowerCase();
      return `${url.origin}/order/${encodeURIComponent(normalizedIdentity)}`;
    };
    const orders = new Set<string>();
    for (let index = 0; index < segments.length - 1; index += 1) {
      const marker = segments[index]?.toLowerCase().replace(/-/g, "_");
      if (
        !["checkout", "checkouts", "order", "orders", "receipt", "receipts"].includes(
          marker ?? "",
        )
      ) {
        continue;
      }
      const order = canonicalIdentity(segments[index + 1]);
      if (order !== null) orders.add(order);
    }
    let terminalIdentity: string | undefined;
    if (["receipt", "receipts"].includes(routeSegment(-2))) {
      terminalIdentity = segments.at(-1);
    } else if (
      ["order", "orders"].includes(routeSegment(-3)) &&
      ["confirmation", "confirmed", "thank_you"].includes(routeSegment(-1))
    ) {
      terminalIdentity = segments.at(-2);
    } else if (
      ["order_confirmation", "order_confirmed", "order_complete", "thank_you"].includes(
        routeSegment(-2),
      )
    ) {
      terminalIdentity = segments.at(-1);
    } else if (
      ["checkout", "checkouts"].includes(routeSegment(-3)) &&
      routeSegment(-1) === "thank_you"
    ) {
      terminalIdentity = segments.at(-2);
    }
    const terminal = canonicalIdentity(terminalIdentity);
    if (terminal !== null) orders.add(terminal);
    return { orders: [...orders], terminal };
  } catch {
    return null;
  }
}

const CHECKOUT_PAN_FIELD_SELECTORS =
  'input[autocomplete~="cc-number"],input[name*="cardnumber" i],input[id*="card-number" i],input[id*="cardnumber" i]';

const CHECKOUT_CARD_VALUE_FIELD_SELECTORS = [
  CHECKOUT_PAN_FIELD_SELECTORS,
  'input[autocomplete~="cc-exp"],input[autocomplete~="cc-exp-month"],input[autocomplete~="cc-exp-year"],input[name*="expir" i],input[name="exp" i],input[name*="exp_month" i],input[name*="expmonth" i],input[name*="exp_year" i],input[name*="expyear" i],input[id*="expir" i],input[id="exp" i],input[id*="exp-date" i],input[id*="exp" i][id*="month" i],input[id*="exp" i][id*="year" i],input[placeholder="MM/YY" i],input[placeholder="MM / YY" i],input[aria-label="MM/YY" i],input[aria-label="MM / YY" i]',
  'input[autocomplete~="cc-csc"],input[name*="cvv" i],input[name*="cvc" i],input[name*="security-code" i],input[id*="cvv" i],input[id*="cvc" i]',
  'input[autocomplete~="cc-name"],input[name*="cardholder" i],input[name*="card-name" i],input[id*="cardholder" i]',
].join(",");

// Charge-verb button labels — the click that actually moves money. Used by
// submitFilledCheckout to find the charge control, and by operate_act's
// pending-card-fill guard to refuse the model clicking such a control directly
// while a vaulted card sits filled in the checkout. NOT English-only: Japanese
// checkouts (the
// Rakuten-style flows the card-fill path targets) label the charge
// ご注文を確定する / 注文する / 購入する / お支払い. Ambiguous confirm/pay
// wording errs toward matching — a false positive is a safe refusal routed
// through the confirm gate; a false negative is a bypassed charge gate.
// Note: \b is ASCII-only, so the Japanese alternatives anchor on ^ (with $
// where a bare noun like 購入 would otherwise swallow navigation labels such
// as 購入手続きへ). 確定 (finalize) is deliberate — 確認 (review) must NOT match.
export const CHECKOUT_SUBMIT_LABEL_RE =
  /^(?:pay(?:\s+now)?|place\s+order|complete\s+(?:order|purchase|payment)|submit\s+payment|buy\s+now|confirm\s+(?:order|payment))\b|^ご?注文(?:内容)?[をの]?確定|^ご?注文する|^確定(?:する|$)|^購入(?:する|を確定|$)|^今すぐ(?:購入|注文|支払)|^支払う|^お?支払い(?:を確定|$)/i;

// Descriptor-level PayPal surface classifier retained for callers that need to
// inventory wallet/card frames. It is not the payment refusal gate: the operator
// keys that decision off the frame containing the actual visible PAN field.
export function hasPayPalHostedCheckoutFrame(frames: readonly CheckoutFrameDescriptor[]): boolean {
  return frames.some((frame) => {
    const marker = `${frame.url} ${frame.name} ${frame.title}`.toLowerCase();
    if (/__zoid__paypal_(?:buttons|card_fields|checkout)/.test(marker)) return true;

    try {
      const url = new URL(frame.url);
      const paypalHost =
        url.hostname === "paypal.com" ||
        url.hostname.endsWith(".paypal.com") ||
        url.hostname === "paypalobjects.com" ||
        url.hostname.endsWith(".paypalobjects.com");
      return paypalHost && /(?:smart|checkout|card[_ -]?fields|zoid)/.test(marker);
    } catch {
      return false;
    }
  });
}

// The frame hosts that render UNFILLABLE PayPal/Braintree-hosted card fields.
// A PayPal EXPRESS button frame (smart/checkout) is deliberately NOT here —
// the operator must not refuse a fillable checkout (e.g. Shopify-PCI card
// fields with a plain PayPal express button) merely because a button exists.
function isPayPalBraintreeHostedFieldsHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "paypal.com" ||
    h.endsWith(".paypal.com") ||
    h === "paypalobjects.com" ||
    h.endsWith(".paypalobjects.com") ||
    h === "braintreegateway.com" ||
    h.endsWith(".braintreegateway.com")
  );
}

// Identity-provider + auth-handler hosts a page legitimately bounces subresource
// traffic through. Mirror of provision-session.ts DEFAULT_AUTH_HOSTS, kept local
// so browser.ts's request-scope guard never creates a circular import.
const HOST_SCOPE_AUTH_HOSTS: readonly string[] = [
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
];

const HOST_SCOPE_ALWAYS_ALLOW_HOSTS: readonly string[] = [
  "challenges.cloudflare.com",
  "hcaptcha.com",
  "newassets.hcaptcha.com",
  "www.google.com",
  "recaptcha.net",
  "js.stripe.com",
];

// Whether a request URL's host is inside the operator's egress scope. In-scope
// when it matches an allowed host, shares the SAME registrable
// domain (eTLD+1) as an already-trusted host (the merchant's own API siblings —
// the Rakuten cart/checkout backend), or is a known auth/captcha/payment host.
// A request outside this scope is a candidate for fail-fast blocking rather than
// being silently dropped to hang the page. Reuses isSameRecipeDomain (a tested
// tldts-backed eTLD+1 comparison) for the same-registrable-domain auto-scope.
export function requestHostInScope(
  url: string,
  allowedHosts: readonly string[],
  siblingDomainHosts: readonly string[] = allowedHosts,
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return true; // unparseable URL — never fail-fast-block on a parse stumble
  }
  const host = parsedUrl.hostname.toLowerCase();
  const bySuffix = (suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);
  if (allowedHosts.some((allowed) => host === allowed.toLowerCase())) return true;
  if (siblingDomainHosts.some((allowed) => isSameRecipeDomain(host, allowed))) return true;
  if (HOST_SCOPE_AUTH_HOSTS.some(bySuffix)) return true;
  if (HOST_SCOPE_ALWAYS_ALLOW_HOSTS.some(bySuffix)) return true;
  if (bySuffix("gstatic.com") && /^\/recaptcha(?:\/|$)/u.test(parsedUrl.pathname)) return true;
  if (
    RECOGNIZED_PAYMENT_PROVIDER_FRAME_HOSTS.some(bySuffix) ||
    host.endsWith(".firebaseapp.com") ||
    host.endsWith(".web.app")
  ) {
    return true;
  }
  return false;
}

// The fail-fast decision the request-scope guard calls. A request is aborted
// (net error → the page's fetch/XHR rejects promptly instead of hanging) only
// when it is an in-page XHR/fetch API call TO A HOST OUTSIDE THE SESSION SCOPE.
// Page-load resources (scripts/styles/images/frames) and every in-scope call
// (including same-registrable-domain merchant API siblings) always continue. A
// null allowedHosts (harness/replay, no active session) never blocks.
export function isFailFastScopeAbort(
  url: string,
  resourceType: string,
  allowedHosts: readonly string[] | null,
  siblingDomainHosts?: readonly string[],
): boolean {
  if (allowedHosts === null) return false;
  if (resourceType !== "xhr" && resourceType !== "fetch") return false;
  return !requestHostInScope(url, allowedHosts, siblingDomainHosts);
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
const UNRESOLVED_CURRENCY_NOTATIONS = new Set(["KR"]);

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

interface CheckoutAmountParseResult {
  amount: { amount_cents: number; currency: string } | null;
  currencyUnresolved: boolean;
  fallbackCurrencyScaleMismatch: boolean;
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

interface CheckoutCurrencyTokenResult {
  currency: string | undefined;
  unresolved: boolean;
}

function classifyCheckoutCurrencyToken(token: string | undefined): CheckoutCurrencyTokenResult {
  if (token === undefined) return { currency: undefined, unresolved: false };
  const currency = resolveCheckoutCurrencyToken(token);
  return {
    currency,
    unresolved:
      currency === undefined &&
      (/円|\p{Sc}/u.test(token) || UNRESOLVED_CURRENCY_NOTATIONS.has(token.toUpperCase())),
  };
}

const AMBIGUOUS_CONFIRM_CURRENCY_NOTATIONS = new Set(["$", "¥", "￥"]);
const CONFIRM_DOLLAR_PREFIX_CURRENCIES: Readonly<Record<string, string>> = {
  A: "AUD",
  AU: "AUD",
  C: "CAD",
  CA: "CAD",
  HK: "HKD",
  MX: "MXN",
  NZ: "NZD",
  SG: "SGD",
  US: "USD",
};

function classifyCheckoutConfirmCurrencyToken(
  token: string | undefined,
): CheckoutCurrencyTokenResult {
  if (token === undefined) return { currency: undefined, unresolved: false };
  const upper = token.toUpperCase();
  if (upper.endsWith("$") && upper.length > 1) {
    const prefix = upper.slice(0, -1);
    const currency = CHECKOUT_CURRENCY_CODES.has(prefix)
      ? prefix
      : CONFIRM_DOLLAR_PREFIX_CURRENCIES[prefix];
    if (currency !== undefined) return { currency, unresolved: false };
  }
  if (AMBIGUOUS_CONFIRM_CURRENCY_NOTATIONS.has(upper)) {
    return { currency: undefined, unresolved: true };
  }
  return classifyCheckoutCurrencyToken(token);
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
  ) => CheckoutCurrencyTokenResult = classifyCheckoutCurrencyToken,
): CheckoutAmountParseResult {
  const matchEnd = (match.index ?? 0) + match[0].length;
  const trailingLine = text.slice(matchEnd).split(/\r?\n/u, 1)[0] ?? "";
  if (
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(match[1] ?? "") ||
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(match[4] ?? "") ||
    CHECKOUT_TAX_EXCLUSIVE_PATTERN.test(trailingLine)
  ) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: false };
  }
  if (isCheckoutCountSuffix(match[4])) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: false };
  }
  const prefix = classifyCurrencyToken(match[1]);
  const symbol = classifyCurrencyToken(match[2]);
  const suffix = classifyCurrencyToken(match[4]);
  if (prefix.unresolved || symbol.unresolved || suffix.unresolved) {
    return { amount: null, currencyUnresolved: true, fallbackCurrencyScaleMismatch: false };
  }
  const pageCurrency = prefix.currency ?? suffix.currency ?? symbol.currency;
  const currency = (pageCurrency ?? fallbackCurrency)?.toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: false };
  }
  const minorDigits = currencyMinorDigits(currency);
  if (pageCurrency === undefined && fallbackCurrencyScaleMismatches(match[3] ?? "", minorDigits)) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: true };
  }
  const amount = parseDisplayedNumber(match[3] ?? "", minorDigits);
  if (amount === null) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: false };
  }
  const scale = 10 ** minorDigits;
  const minor = Math.round(amount * scale);
  if (Math.abs(amount * scale - minor) > 1e-6) {
    return { amount: null, currencyUnresolved: false, fallbackCurrencyScaleMismatch: false };
  }
  return {
    amount: { amount_cents: minor, currency },
    currencyUnresolved: false,
    fallbackCurrencyScaleMismatch: false,
  };
}

function parseCheckoutAmountResult(
  texts: readonly string[],
  fallbackCurrency?: string,
): CheckoutAmountParseResult {
  let currencyUnresolved = false;
  let fallbackCurrencyScaleMismatch = false;
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計") && !checkoutTextHasFreeShipping(text)) continue;
      const result = parseCheckoutAmountMatch(text, match, fallbackCurrency);
      currencyUnresolved ||= result.currencyUnresolved;
      fallbackCurrencyScaleMismatch ||= result.fallbackCurrencyScaleMismatch;
      if (result.amount === null) continue;
      return {
        amount: result.amount,
        currencyUnresolved,
        fallbackCurrencyScaleMismatch,
      };
    }
  }
  return { amount: null, currencyUnresolved, fallbackCurrencyScaleMismatch };
}

function parseCheckoutConfirmAmountResult(texts: readonly string[]): CheckoutAmountParseResult {
  let currencyUnresolved = false;
  let amount: { amount_cents: number; currency: string } | null = null;
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計")) continue;
      const result = parseCheckoutAmountMatch(
        text,
        match,
        undefined,
        classifyCheckoutConfirmCurrencyToken,
      );
      currencyUnresolved ||= result.currencyUnresolved;
      if (result.amount !== null) amount = result.amount;
    }
  }
  return { amount, currencyUnresolved, fallbackCurrencyScaleMismatch: false };
}

export function parseCheckoutAmount(
  texts: readonly string[],
  fallbackCurrency?: string,
): { amount_cents: number; currency: string } | null {
  return parseCheckoutAmountResult(texts, fallbackCurrency).amount;
}

/**
 * Like parseCheckoutAmount but returns every currency-guard-clean match
 * instead of the first — checkout review pages can show a pre-shipping
 * subtotal before the final labeled total, so the caller needs the full
 * sequence to pick the settled one. Reuses the same regex and currency-guard
 * helpers as parseCheckoutAmountResult (unresolved-currency and
 * fallback-scale-mismatch matches are skipped identically), just without the
 * single-result early return.
 */
export function parseCheckoutAmounts(
  texts: readonly string[],
  fallbackCurrency?: string,
): Array<{ amount_cents: number; currency: string }> {
  return parseCheckoutAmountsResult(texts, fallbackCurrency).amounts;
}

interface CheckoutAmountsParseResult {
  amounts: Array<{ amount_cents: number; currency: string }>;
  payableAmounts: Array<{ amount_cents: number; currency: string }>;
  currencyUnresolved: boolean;
  fallbackCurrencyScaleMismatch: boolean;
}

function checkoutTextHasFreeShipping(text: string): boolean {
  return /(?:送料|配送料)\s*[:：]?\s*送料無料/u.test(text);
}

function parseCheckoutAmountsResult(
  texts: readonly string[],
  fallbackCurrency?: string,
): CheckoutAmountsParseResult {
  const amounts: Array<{ amount_cents: number; currency: string }> = [];
  const payableAmounts: Array<{ amount_cents: number; currency: string }> = [];
  let currencyUnresolved = false;
  let fallbackCurrencyScaleMismatch = false;
  for (const text of texts) {
    checkoutTotalPattern.lastIndex = 0;
    for (const match of text.matchAll(checkoutTotalPattern)) {
      if (match[0].startsWith("小計") && !checkoutTextHasFreeShipping(text)) continue;
      const result = parseCheckoutAmountMatch(text, match, fallbackCurrency);
      currencyUnresolved ||= result.currencyUnresolved;
      fallbackCurrencyScaleMismatch ||= result.fallbackCurrencyScaleMismatch;
      if (result.amount !== null) {
        amounts.push(result.amount);
        if (!match[0].startsWith("小計")) payableAmounts.push(result.amount);
      }
    }
  }
  return { amounts, payableAmounts, currencyUnresolved, fallbackCurrencyScaleMismatch };
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

function extractCheckoutConfirmSummaryText(): string {
  const body = document.body;
  if (!body) return "";
  const excluded: Array<{ el: HTMLElement | SVGElement; style: string | null }> = [];
  try {
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      const style = window.getComputedStyle(el);
      const tagName = el.tagName.toLowerCase();
      const struck =
        tagName === "del" ||
        tagName === "s" ||
        tagName === "strike" ||
        style.textDecorationLine.split(/\s+/).includes("line-through");
      if (!struck && Number.parseFloat(style.opacity) > 0) continue;
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

function extractObservationVisibleText(): string {
  const body = document.body;
  if (!body) return "";
  const hidden: Array<{ el: HTMLElement | SVGElement; style: string | null }> = [];
  let text = "";
  try {
    for (const el of Array.from(body.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      if (window.getComputedStyle(el).opacity === "0") {
        hidden.push({ el, style: el.getAttribute("style") });
        el.style.setProperty("display", "none", "important");
      }
    }
    text = body.innerText ?? "";
  } finally {
    for (const { el, style } of hidden) {
      if (style === null) {
        el.style.removeProperty("display");
        if (el.getAttribute("style") === "") el.removeAttribute("style");
      } else {
        el.setAttribute("style", style);
      }
    }
  }
  return text;
}

function extractVisibleTopmostTextSignals({
  source,
  flags,
}: {
  source: string;
  flags: string;
}): Record<string, number> {
  const pattern = new RegExp(source, flags);
  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
  const canonicalize = (text: string): string =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[*•●◦▪■□×]+/g, " masked ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const visuallyTopmostAtPoint = (element: Element, x: number, y: number): boolean => {
    const restored: Array<{
      element: HTMLElement;
      priority: string;
      value: string;
    }> = [];
    for (const candidate of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const style = getComputedStyle(candidate);
      if (
        style.pointerEvents !== "none" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) <= 0 ||
        !Array.from(candidate.getClientRects()).some(
          (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
        )
      ) {
        continue;
      }
      restored.push({
        element: candidate,
        priority: candidate.style.getPropertyPriority("pointer-events"),
        value: candidate.style.getPropertyValue("pointer-events"),
      });
      candidate.style.setProperty("pointer-events", "auto", "important");
    }
    const hit = document.elementFromPoint(x, y);
    for (const original of restored) {
      if (original.value.length === 0) {
        original.element.style.removeProperty("pointer-events");
      } else {
        original.element.style.setProperty("pointer-events", original.value, original.priority);
      }
    }
    return hit === element;
  };
  const visibleAndTopmost = (node: Text): boolean => {
    const element = node.parentElement;
    if (element === null) return false;
    let ancestor: HTMLElement | null = element as HTMLElement;
    while (ancestor !== null) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity) <= 0
      ) {
        return false;
      }
      ancestor = ancestor.parentElement;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) continue;
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const x = left + (right - left) / 2;
      const y = top + (bottom - top) / 2;
      if (visuallyTopmostAtPoint(element, x, y)) return true;
    }
    return false;
  };
  const signals: Record<string, number> = {};
  const body = document.body;
  if (body === null) return signals;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const splitCandidateMatches = new Map<Element, string | null>();
  const splitCandidates = new Map<Element, string>();
  let node = walker.nextNode();
  while (node !== null) {
    const text = normalize(node.textContent ?? "");
    pattern.lastIndex = 0;
    const match = text.length > 0 && text.length <= 500 ? pattern.exec(text) : null;
    pattern.lastIndex = 0;
    if (match !== null && visibleAndTopmost(node as Text)) {
      const signal = canonicalize(match[0]);
      if (signal.length > 0) signals[signal] = 1;
    } else if (match === null && text.length > 0) {
      let container = node.parentElement;
      for (let depth = 0; container !== null && depth < 4; depth += 1) {
        let combinedMatchText: string | null;
        if (splitCandidateMatches.has(container)) {
          combinedMatchText = splitCandidateMatches.get(container) ?? null;
        } else {
          const combined = normalize(container.textContent ?? "");
          pattern.lastIndex = 0;
          const combinedMatch =
            combined.length > 0 && combined.length <= 500 ? pattern.exec(combined) : null;
          pattern.lastIndex = 0;
          combinedMatchText = combinedMatch?.[0] ?? null;
          splitCandidateMatches.set(container, combinedMatchText);
        }
        if (combinedMatchText !== null) {
          splitCandidates.set(container, combinedMatchText);
          break;
        }
        container = container.parentElement;
      }
    }
    node = walker.nextNode();
  }
  for (const [container, match] of splitCandidates) {
    const textNodes: Text[] = [];
    const containerWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let textNode = containerWalker.nextNode();
    while (textNode !== null) {
      if (normalize(textNode.textContent ?? "").length > 0) textNodes.push(textNode as Text);
      textNode = containerWalker.nextNode();
    }
    if (textNodes.length < 2 || !textNodes.every(visibleAndTopmost)) continue;
    const signal = canonicalize(match);
    if (signal.length > 0) signals[signal] = 1;
  }
  return signals;
}

const PAYMENT_PAN_MAX_SPAN_CHARS = 96;

function passesPaymentLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsLuhnPanSpan(text: string): boolean {
  const digitPositions = Array.from(text.matchAll(/\d/g), (match) => match.index);
  for (let start = 0; start + 13 <= digitPositions.length; start += 1) {
    const maxLength = Math.min(19, digitPositions.length - start);
    for (let length = 13; length <= maxLength; length += 1) {
      const positions = digitPositions.slice(start, start + length);
      if (positions[positions.length - 1]! - positions[0]! + 1 > PAYMENT_PAN_MAX_SPAN_CHARS) {
        break;
      }
      const digits = positions.map((position) => text[position]).join("");
      if (passesPaymentLuhn(digits)) return true;
    }
  }
  return false;
}

function containsVisiblePaymentMaterial(text: string): boolean {
  return (
    containsLuhnPanSpan(text) || /\b(?:cvv|cvc|security\s+code)\s*[:#-]?\s*\d{3,4}\b/iu.test(text)
  );
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

const HCAPTCHA_UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function extractHcaptchaSitekeyFromHtml(html: string): string | null {
  if (!/hcaptcha\.com|h-captcha|hcaptcha/i.test(html)) return null;
  const normalized = html
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
  for (const src of normalized.matchAll(/<iframe[^>]+src=["']([^"']*hcaptcha[^"']*)["']/gi)) {
    const raw = src[1];
    if (raw === undefined) continue;
    try {
      const url = new URL(raw, "https://example.invalid");
      const direct = url.searchParams.get("sitekey");
      if (direct !== null && direct.length > 10) return direct;
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
      const fromHash = new URLSearchParams(hash).get("sitekey");
      if (fromHash !== null && fromHash.length > 10) return fromHash;
    } catch {
      const match = raw.match(new RegExp(`[?#&]sitekey=(${HCAPTCHA_UUID_RE})`, "i"));
      if (match?.[1] !== undefined) return match[1];
    }
  }
  const patterns = [
    // Standard hCaptcha/SDK naming.
    new RegExp(
      `(?:sitekey|site_key|site-key|hcaptcha_key|captchaApiKey|data-(?:hcaptcha-)?sitekey)["'\\s]*[:=]\\s*["'](${HCAPTCHA_UUID_RE})["']`,
      "i",
    ),
    // Stripe and similar app config JSON often names keys
    // `express_hcaptcha_site_key` or `hcaptcha_login_main_site_key`.
    new RegExp(
      `(?:hcaptcha[^"'<>]{0,80}site[_-]?key|express_hcaptcha_site_key)["'\\s]*[:=]\\s*["'](${HCAPTCHA_UUID_RE})["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function extractHcaptchaResponseKeyFromToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    for (const key of ["ekey", "eKey", "respKey", "responseKey", "key", "kr"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    return null;
  }
  return null;
}

export interface BrowserControllerOptions {
  // Adds human-like timing to clicks, typing, and page loads. Defaults
  // to true in production (we want to pass Cloudflare/reCAPTCHA scoring)
  // and should be disabled in unit tests so they run fast and
  // deterministically.
  humanize?: boolean;
  // Persistent Chrome profile directory. Signup runs launch from this
  // profile so an OAuth signup reuses the Google session google-login.ts
  // established. Defaults to CHROME_PROFILE_DIR.
  profileDir?: string;
  // Per-launch egress override. When set, this run routes through this proxy
  // instead of the env-global UNIVERSAL_BOT_PROXY_URL — so a fleet of verify
  // identities can each egress from a distinct residential IP in ONE process
  // (no containers). Subject to the same ASN-class gating + liveness probe as
  // the env proxy. Unset → fall back to the env behavior.
  proxyUrl?: string;
}

// Hosts of known captcha-challenge iframes (Turnstile, reCAPTCHA, hCaptcha,
// Arkose/FunCaptcha). Shared between the per-navigation WebGL-spoof reapply
// (start(), below) and extractInteractiveElements' frame walk, which skips
// these frames — their content is handled by the dedicated captcha-gate flow,
// not surfaced as ordinary el_table rows.
const CAPTCHA_FRAME_HOST_RE =
  /(hcaptcha\.com|challenges\.cloudflare\.com|google\.com\/recaptcha|recaptcha\.net|arkoselabs\.com|funcaptcha\.com)/i;

export type CaptchaKind = "turnstile" | "recaptcha" | "hcaptcha";

const GOOGLE_ACCOUNT_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function extractGoogleAccountEmail(pageText: string): string | null {
  const chip = /Google Account:[^()]*\(([^)]+)\)/i.exec(pageText);
  if (chip?.[1] !== undefined) {
    const match = GOOGLE_ACCOUNT_EMAIL_RE.exec(chip[1]);
    if (match !== null) return match[0].trim();
  }
  return null;
}

// Map a cookie jar to the OAuth providers that have a LIVE logged-in session.
// The auth cookies that mean "signed in": GitHub → `user_session`; Google →
// any of the *SID session cookies (NID / CONSENT / 1P_JAR are set even when
// logged out, so they are deliberately NOT signals). Host-scoped so a
// google.com cookie can't pass for github. Cookie NAMES + presence only;
// values are checked for non-triviality, never logged. Exported for tests.
export function sessionProvidersFromCookies(
  cookies: ReadonlyArray<{ name: string; value: string; domain: string }>,
): OAuthProviderId[] {
  const SIGNATURES: ReadonlyArray<{
    provider: OAuthProviderId;
    host: RegExp;
    names: readonly string[];
  }> = [
    { provider: "github", host: /(^|\.)github\.com$/i, names: ["user_session"] },
    {
      provider: "google",
      host: /(^|\.)google\.com$/i,
      names: GOOGLE_LOGIN_COOKIE_MARKERS,
    },
  ];
  const live: OAuthProviderId[] = [];
  for (const sig of SIGNATURES) {
    const present = cookies.some(
      (c) =>
        sig.host.test(c.domain.replace(/^\./, "")) &&
        sig.names.includes(c.name) &&
        c.value.length > 10,
    );
    if (present) live.push(sig.provider);
  }
  return live;
}

// Finer-grained captcha classification for spike telemetry (T3.2).
// `recaptcha_v3` covers any score-mode reCAPTCHA with no clickable
// checkbox (true v3 and v2-invisible behave the same to the bot:
// nothing to solve). Static-vs-dynamic of a v2 grid is intentionally
// not split here — reliable pre-solve classification needs the grid
// inspection that T3.4 (Module A) builds; the spike's question is
// answered by family + challenge_rendered.
export type CaptchaVariant = "turnstile" | "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "unknown";

function isCaptchaVariant(v: string): v is CaptchaVariant {
  return (
    v === "turnstile" ||
    v === "recaptcha_v2" ||
    v === "recaptcha_v3" ||
    v === "hcaptcha" ||
    v === "unknown"
  );
}

// Result of solveVisibleCaptcha(). `found: false` is the happy path
// for most pages — no widget, nothing to do, agent proceeds. `solved`
// is only meaningful when `found: true`.
export type CaptchaSolveResult =
  | { found: false }
  | { found: true; solved: true; kind: CaptchaKind }
  | { found: true; solved: false; kind: CaptchaKind };

export type HcaptchaCoordinateSolveResult =
  | { found: false; solved: false; reason: "no_visible_challenge" }
  | {
      found: true;
      solved: boolean;
      reason?: string;
      clicks: number;
      durationMs?: number;
    };

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Real-Chromium-family browser channels we'll prefer over the bundled
// Chromium binary when available. Chromium ships without Widevine,
// without proprietary codecs, with an empty navigator.plugins array,
// and with a chrome.runtime API surface that bot-detection scripts
// know to look for. Using a *real* installation papers over ~6 of
// those fingerprint bits at zero engineering cost.
//
// Order matters: pick the channel most likely to be present *and*
// hardest to fingerprint as automation. Stable Chrome > Edge >
// Beta/Canary > Brave. Brave isn't a Playwright channel but its
// binary path is well-known; we resolve it explicitly below.
const PREFERRED_CHANNELS: readonly string[] = ["chrome", "msedge", "chrome-beta", "chrome-canary"];

// Per-channel binary search paths. Playwright's `executablePath()` is
// argumentless (returns the bundled Chromium path), so we can't ask it
// "is Chrome installed?" — we have to look ourselves. These are the
// canonical install locations on each platform; the first hit wins.
//
// Limitation: this misses sideloaded installs (Chrome installed via
// the user's package manager to a non-default path, dev-builds in
// home directories, etc.). For those, the user can set
// UNIVERSAL_BOT_CHANNEL=chrome to force Playwright to find it
// through its own resolution. We accept the false-negative because
// the alternative (asking Playwright to launch and seeing if it
// succeeds) costs ~1s of process startup per probe.
const CHANNEL_PATHS: Record<string, readonly string[]> = {
  chrome: [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    // Windows — Playwright resolves these via channel anyway, but list
    // for completeness on cross-platform Node runs.
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  msedge: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  "chrome-beta": [
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/usr/bin/google-chrome-beta",
  ],
  "chrome-canary": [
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome-unstable",
  ],
};

// Detect a real-Chromium-family browser channel without launching it.
// Returns the channel name (passable as `channel:` to .launch) or null
// to mean "use bundled Chromium." Logs the selection to stderr so the
// telemetry path can see which browser the run ended up on without
// having to thread it through the agent state machine.
async function detectChromiumChannel(): Promise<string | null> {
  // Skip detection in tests / when explicitly opting out. The unit tests
  // launch hundreds of browsers and shouldn't probe the filesystem each
  // time; they also can't rely on real Chrome being present.
  if (process.env.UNIVERSAL_BOT_CHANNEL === "bundled") return null;
  if (process.env.UNIVERSAL_BOT_CHANNEL !== undefined) {
    // Explicit override — caller knows what they want.
    return process.env.UNIVERSAL_BOT_CHANNEL;
  }

  const fsMod = await import("node:fs");
  for (const channel of PREFERRED_CHANNELS) {
    const candidatePaths = CHANNEL_PATHS[channel] ?? [];
    for (const candidate of candidatePaths) {
      try {
        if (fsMod.existsSync(candidate)) return channel;
      } catch {
        // permission errors etc. — skip this candidate, try the next
      }
    }
  }
  return null;
}

// Resolve the on-disk Chrome binary for a detected channel, for the
// self-launch path (see launchSelfManagedContext). Playwright launches a
// channel by name; we have to spawn the binary ourselves, so we need the
// path. Returns null when the channel is unknown / not found on disk
// (caller falls back to launchPersistentContext).
export function resolveChannelBinary(channel: string | null): string | null {
  if (channel === null) return null; // bundled Chromium — no self-launch
  const explicit = process.env.UNIVERSAL_BOT_CHROME_BINARY;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const candidates = CHANNEL_PATHS[channel] ?? [];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // skip unreadable candidate
    }
  }
  return null;
}

// Whether to launch Chrome ourselves and attach over CDP, instead of
// Playwright's launchPersistentContext.
//
// WHY THIS EXISTS — the single decisive finding (2026-06-12, fully
// reproduced + falsifiable; see STATE.md "Cloudflare-Turnstile wall").
// Cloudflare Turnstile's interactive challenge FAILS a Playwright/patchright
// launchPersistentContext-driven Chrome and PASSES a Chrome the operator
// launches itself and then attaches to over CDP — every other variable held
// constant (same box, same datacenter IP, same Xvfb display, same Chrome 148
// binary, same software-WebGL, same humanized click). The discriminator
// matrix:
//   launchPersistentContext + CDP click   → "Verification failed"
//   launchPersistentContext + OS click     → "Verification failed"
//   plain google-chrome      + OS click     → "Success!"
//   plain google-chrome + connectOverCDP + page.mouse → token issued (len816)
// So the tell is NEITHER the live CDP attachment NOR the click mechanism —
// it is specifically the launch flags/instrumentation Playwright injects at
// launchPersistentContext time. Self-launching the binary (no
// --enable-automation et al.) and attaching with connectOverCDP avoids it.
// Default-ON; opt out with BOT_SELF_LAUNCH=0 for the persistent-context path. Exported for tests.
export function selfLaunchEnabled(): boolean {
  const v = process.env.BOT_SELF_LAUNCH;
  return v !== "0" && v !== "false" && v !== "off";
}

const PERSISTENT_CONTEXT_LAUNCH_TIMEOUT_MS = 30_000;
const PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS = 2_000;
const PERSISTENT_CONTEXT_CANCELLATION_POLL_MS = 25;
const PROFILE_IDENTITY_PROOF_TIMEOUT_MS = 2_000;
const PROFILE_IDENTITY_POLL_MS = 25;
const PROFILE_HOLDER_ABSENCE_GRACE_MS = 100;

export type PersistentFallbackIdentityProof =
  | { state: "owned"; identity: ProfileProcessIdentity }
  | { state: "absent" }
  | { state: "unknown" };

export async function resolvePersistentFallbackIdentity(opts: {
  profileDir: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  pollMs?: number;
  absenceGraceMs?: number;
  currentHolderPid?: (profileDir: string) => number | null;
  readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
  clearStaleLock?: (profileDir: string) => boolean;
}): Promise<PersistentFallbackIdentityProof> {
  if ((opts.platform ?? process.platform) !== "linux") return { state: "unknown" };
  const timeoutMs = opts.timeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PROFILE_IDENTITY_POLL_MS;
  const absenceGraceMs = opts.absenceGraceMs ?? PROFILE_HOLDER_ABSENCE_GRACE_MS;
  const readHolder = opts.currentHolderPid ?? currentProfileHolderPid;
  const readIdentity = opts.readIdentity ?? profileProcessIdentity;
  const clearStaleLock = opts.clearStaleLock ?? clearStaleSingletonLock;
  const deadline = Date.now() + timeoutMs;
  let absentSince: number | null = null;
  for (;;) {
    const holderPid = readHolder(opts.profileDir);
    if (holderPid === null) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= absenceGraceMs) return { state: "absent" };
    } else {
      absentSince = null;
      const identity = readIdentity(holderPid, opts.profileDir);
      if (identity !== null) return { state: "owned", identity };
      if (clearStaleLock(opts.profileDir)) return { state: "absent" };
    }
    if (Date.now() >= deadline) return { state: "unknown" };
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      timer.unref();
    });
  }
}

export async function launchCancellablePersistentContext<T, O extends object>(opts: {
  launch: (options: O & { timeout: number }) => Promise<T>;
  options: O;
  cancellation: Promise<void>;
  cleanupCancelled: (value: T) => Promise<ProfileCloseState>;
  cleanupRejected: () => Promise<ProfileCloseState>;
  launchTimeoutMs?: number;
  cancellationSettleMs?: number;
  cancellationPollMs?: number;
}): Promise<
  { status: "launched"; value: T } | { status: "cancelled"; closeState: ProfileCloseState }
> {
  const launchTimeoutMs = opts.launchTimeoutMs ?? PERSISTENT_CONTEXT_LAUNCH_TIMEOUT_MS;
  const launchDeadline = Date.now() + launchTimeoutMs;
  const launch = Promise.resolve().then(() =>
    opts.launch({ ...opts.options, timeout: launchTimeoutMs }),
  );
  const outcome = await Promise.race([
    launch.then((value) => ({ status: "launched" as const, value })),
    opts.cancellation.then(() => ({ status: "cancelled" as const })),
  ]);
  if (outcome.status === "launched") return outcome;
  let rejectedCleanup: Promise<ProfileCloseState> | null = null;
  const cleanupRejected = (): Promise<ProfileCloseState> => {
    if (rejectedCleanup !== null) return rejectedCleanup;
    const cleanup = Promise.resolve()
      .then(opts.cleanupRejected)
      .catch(() => "unknown" as const)
      .finally(() => {
        if (rejectedCleanup === cleanup) rejectedCleanup = null;
      });
    rejectedCleanup = cleanup;
    return cleanup;
  };
  const lateCleanup = launch
    .then(opts.cleanupCancelled, cleanupRejected)
    .catch(() => "unknown" as const);
  const settleMs = opts.cancellationSettleMs ?? PERSISTENT_CONTEXT_CANCELLATION_SETTLE_MS;
  const pollMs = opts.cancellationPollMs ?? PERSISTENT_CONTEXT_CANCELLATION_POLL_MS;
  const cancellationDeadline = Math.max(Date.now(), launchDeadline) + settleMs;
  let settledCloseState: ProfileCloseState | null = null;
  void lateCleanup.then((closeState) => {
    settledCloseState = closeState;
  });
  while (settledCloseState === null && Date.now() < cancellationDeadline) {
    await cleanupRejected();
    if (settledCloseState !== null) break;
    const remaining = cancellationDeadline - Date.now();
    if (remaining <= 0) break;
    await Promise.race([
      lateCleanup,
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, Math.min(pollMs, remaining));
        timer.unref();
      }),
    ]);
  }
  if (settledCloseState !== null) {
    return { status: "cancelled", closeState: settledCloseState };
  }
  await cleanupRejected();
  void lateCleanup;
  return { status: "cancelled", closeState: "unknown" };
}

// Find an ephemeral TCP port for Chrome's --remote-debugging-port.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

// Poll Chrome's DevTools HTTP endpoint until it answers (the browser is up
// and accepting CDP), or the deadline passes. Returns the base endpoint URL
// connectOverCDP accepts.
async function waitForDevtools(
  port: number,
  deadlineMs: number,
  child?: ChildProcess,
): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + deadlineMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (child !== undefined && !childProcessIsRunning(child)) {
      throw new Error("Chrome exited before its DevTools endpoint became available");
    }
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return base;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome DevTools endpoint never came up on ${base} (${lastErr})`);
}

export async function withChromeStartupLock<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs?: number; lockDir?: string } = {},
): Promise<T> {
  const lockDir = opts.lockDir ?? "/tmp/trusty-squire-chrome-start.lock";
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 120_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        if (deadlineMs === 0) throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
        throw new Error(
          `Timed out waiting for Chrome startup lock at ${lockDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

const selfManagedChromes = new Map<number, ProfileProcessIdentity>();
let selfManagedCleanupInstalled = false;
let selfManagedTerminationSignalExitEnabled = true;
let orphanVerifierReapRan = false;
const orphanOperatorProfilesReaped = new Set<string>();

function cleanupSelfManagedChromes(): void {
  for (const identity of selfManagedChromes.values()) {
    signalProfileProcess(identity, identity.user_data_dir, "SIGKILL");
  }
  selfManagedChromes.clear();
}

const exitForSelfManagedSignal = (code: number): void => {
  cleanupSelfManagedChromes();
  process.exit(128 + code);
};
const onSelfManagedSigint = (): void => exitForSelfManagedSignal(2);
const onSelfManagedSigterm = (): void => exitForSelfManagedSignal(15);
const onSelfManagedSighup = (): void => exitForSelfManagedSignal(1);

export function setSelfManagedChromeTerminationSignalExitEnabled(enabled: boolean): void {
  if (selfManagedTerminationSignalExitEnabled === enabled) return;
  selfManagedTerminationSignalExitEnabled = enabled;
  if (!selfManagedCleanupInstalled) return;
  if (enabled) {
    process.once("SIGINT", onSelfManagedSigint);
    process.once("SIGTERM", onSelfManagedSigterm);
  } else {
    process.removeListener("SIGINT", onSelfManagedSigint);
    process.removeListener("SIGTERM", onSelfManagedSigterm);
  }
}

function installSelfManagedChromeCleanup(): void {
  if (selfManagedCleanupInstalled) return;
  selfManagedCleanupInstalled = true;
  process.once("exit", cleanupSelfManagedChromes);
  if (selfManagedTerminationSignalExitEnabled) {
    process.once("SIGINT", onSelfManagedSigint);
    process.once("SIGTERM", onSelfManagedSigterm);
  }
  process.once("SIGHUP", onSelfManagedSighup);
}

function registerSelfManagedChrome(
  child: ChildProcess,
  profileDir: string,
): ProfileProcessIdentity | null {
  installSelfManagedChromeCleanup();
  const identity = child.pid === undefined ? null : profileProcessIdentity(child.pid, profileDir);
  if (identity !== null) selfManagedChromes.set(identity.pid, identity);
  child.once("exit", () => {
    if (child.pid !== undefined) selfManagedChromes.delete(child.pid);
  });
  return identity;
}

async function waitForTrackedProfileChildIdentity(
  child: ChildProcess,
  profileDir: string,
  readIdentity: (pid: number, profileDir: string) => ProfileProcessIdentity | null,
  timeoutMs: number,
  pollMs: number,
): Promise<ProfileProcessIdentity | null> {
  const deadline = Date.now() + timeoutMs;
  while (childProcessIsRunning(child)) {
    const identity = child.pid === undefined ? null : readIdentity(child.pid, profileDir);
    if (identity !== null) {
      selfManagedChromes.set(identity.pid, identity);
      return identity;
    }
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      timer.unref();
    });
  }
  return null;
}

export async function resolveAttachedProfileChildIdentity(
  child: ChildProcess,
  profileDir: string,
  identity: ProfileProcessIdentity | null,
  options: {
    platform?: NodeJS.Platform;
    readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
    identityTimeoutMs?: number;
    identityPollMs?: number;
  } = {},
): Promise<ProfileProcessIdentity | null> {
  if (identity !== null || (options.platform ?? process.platform) !== "linux") return identity;
  return await waitForTrackedProfileChildIdentity(
    child,
    profileDir,
    options.readIdentity ?? profileProcessIdentity,
    options.identityTimeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS,
    options.identityPollMs ?? PROFILE_IDENTITY_POLL_MS,
  );
}

export async function terminateTrackedProfileChild(
  child: ChildProcess,
  profileDir: string,
  options: {
    identity?: ProfileProcessIdentity | null;
    platform?: NodeJS.Platform;
    readIdentity?: (pid: number, profileDir: string) => ProfileProcessIdentity | null;
    terminate?: (identity: ProfileProcessIdentity, profileDir: string) => boolean;
    identityTimeoutMs?: number;
    identityPollMs?: number;
  } = {},
): Promise<ProfileProcessIdentity | null> {
  const readIdentity = options.readIdentity ?? profileProcessIdentity;
  const terminate =
    options.terminate ??
    ((ownedIdentity: ProfileProcessIdentity, ownedProfileDir: string): boolean => {
      const signalled = signalProfileProcess(ownedIdentity, ownedProfileDir, "SIGKILL");
      reapProfileHolderIfOwned(ownedProfileDir, ownedIdentity);
      return signalled;
    });
  let identity = options.identity ?? null;
  if (identity === null && (options.platform ?? process.platform) !== "linux") return null;
  while (childProcessIsRunning(child)) {
    identity ??= await waitForTrackedProfileChildIdentity(
      child,
      profileDir,
      readIdentity,
      options.identityTimeoutMs ?? PROFILE_IDENTITY_PROOF_TIMEOUT_MS,
      options.identityPollMs ?? PROFILE_IDENTITY_POLL_MS,
    );
    if (identity === null) break;
    selfManagedChromes.set(identity.pid, identity);
    const terminated = terminate(identity, profileDir);
    if (!terminated) {
      identity = null;
      continue;
    }
    while (childProcessIsRunning(child)) {
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 25);
        timer.unref();
      });
    }
  }
  if (child.pid !== undefined) selfManagedChromes.delete(child.pid);
  return identity;
}

// Stale verifier/operator browsers are the expensive leak mode: if the MCP process dies
// mid-verify, self-launched Chrome survives as PPID=1 with a
// ~/.trusty-squire/profiles/verify-* or ~/.trusty-squire/chrome-profile
// user-data-dir. It keeps the profile lock,
// burns memory, and may leave defunct helper children. A live verifier should
// never be parented to init, so these are safe to reap at the next browser
// startup. Best-effort and Linux-only; failure must not block signups.
export function matchesReapableBrowserArgs(
  args: string,
  profileDirs: readonly string[],
  includeVerifier: boolean,
): boolean {
  return reapableBrowserProfile(args, profileDirs, includeVerifier) !== null;
}

function reapableBrowserProfile(
  args: string,
  profileDirs: readonly string[],
  includeVerifier: boolean,
): string | null {
  if (!/(?:chrome|chromium)/i.test(args)) return null;
  const configuredProfiles = new Map(
    profileDirs.map((profileDir) => [profileDir, profilePathIdentity(profileDir)]),
  );
  const match = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))(?=\s|$)/.exec(args);
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  if (candidate !== undefined) {
    const identity = profilePathIdentity(candidate);
    if ([...configuredProfiles.values()].includes(identity)) return identity;
    if (includeVerifier && /[/\\]\.trusty-squire[/\\]profiles[/\\]verify-[^/\\]+$/.test(identity)) {
      return identity;
    }
  }
  for (const [profileDir, identity] of configuredProfiles) {
    for (const exactPath of new Set([profileDir, identity])) {
      const variants = [exactPath, `"${exactPath}"`, `'${exactPath}'`];
      if (
        variants.some((variant) => {
          const option = `--user-data-dir=${variant}`;
          const offset = args.indexOf(option);
          return (
            offset >= 0 &&
            /\s|$/.test(args.slice(offset + option.length, offset + option.length + 1))
          );
        })
      ) {
        return identity;
      }
    }
  }
  return null;
}

export function claimOrphanBrowserReapScope(profileDir: string): {
  includeVerifier: boolean;
  profileDirs: string[];
} | null {
  const includeVerifier = !orphanVerifierReapRan;
  const profileDirs = [...new Set([CHROME_PROFILE_DIR, profileDir])].filter(
    (candidate) => !orphanOperatorProfilesReaped.has(candidate),
  );
  if (!includeVerifier && profileDirs.length === 0) return null;
  orphanVerifierReapRan = true;
  for (const candidate of profileDirs) orphanOperatorProfilesReaped.add(candidate);
  return { includeVerifier, profileDirs };
}

function reapOrphanedBrowsersOnce(profileDir: string): void {
  if (process.platform !== "linux") return;
  const scope = claimOrphanBrowserReapScope(profileDir);
  if (scope === null) return;
  let rows = "";
  try {
    rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    return;
  }
  const identities: ProfileProcessIdentity[] = [];
  for (const line of rows.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3] ?? "";
    const expectedProfile = reapableBrowserProfile(args, scope.profileDirs, scope.includeVerifier);
    if (Number.isFinite(pid) && ppid === 1 && expectedProfile !== null) {
      const identity = profileProcessIdentity(pid, expectedProfile);
      if (identity !== null) identities.push(identity);
    }
  }
  if (identities.length === 0) return;
  console.error(`[operator] reaping ${identities.length} orphaned Chrome process(es)`);
  for (const identity of identities) {
    signalProfileProcess(identity, identity.user_data_dir, "SIGTERM");
  }
  setTimeout(() => {
    for (const identity of identities) {
      signalProfileProcess(identity, identity.user_data_dir, "SIGKILL");
    }
  }, 2_000).unref();
}

// Classify an anti-bot interstitial page from its (title + body) text.
// `onInterstitial` matches the static Cloudflare/Turnstile challenge copy.
// `verificationPassed` is the signal the challenge SUCCEEDED — but
// Cloudflare leaves the static "Just a moment / Performing security
// verification" copy ON THE PAGE even after it appends "Verification
// successful. Waiting for…", so `onInterstitial` alone wrongly reads as
// "still blocked" and the bot bails as anti_bot_blocked — exactly what
// stranded codesandbox/lambda-labs once patchright started PASSING the
// challenge. When the challenge passed, the redirect is just racing/
// stuck; the caller should be patient + reload, not give up. Exported
// for unit tests.
export function classifyInterstitialText(text: string): {
  onInterstitial: boolean;
  verificationPassed: boolean;
} {
  const onInterstitial =
    /just a moment|performing security verification|verifying you are human|checking your browser|attention required/i.test(
      text,
    );
  const verificationPassed =
    /verification successful|you are (now )?verified|success!|challenge[- ]?(passed|complete)/i.test(
      text,
    );
  return { onInterstitial, verificationPassed };
}

// After a Cloudflare managed challenge PASSES, the cf_clearance cookie is
// set but the URL still carries Cloudflare's single-use challenge token
// (`__cf_chl_rt_tk`, `__cf_chl_tk`, `__cf_chl_f_tk`, …). Cloudflare's own
// client-side redirect to the cleared page can stall — especially over a
// high-latency residential tunnel, where the meta-refresh/JS hop never
// fires inside our wait budget. Re-navigating to the SAME url with those
// one-shot tokens stripped serves the real page directly (the clearance
// cookie now satisfies the edge), instead of waiting on the stuck redirect.
// Returns the cleaned URL, or null when there's no challenge token to strip
// (nothing this can do better than a plain reload). Exported for unit tests.
export function stripCloudflareChallengeParams(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("__cf_chl")) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? u.toString() : null;
}

export interface SelfLaunchedLogin {
  context: BrowserContext;
  // Idempotent: disconnects the CDP browser AND kills the self-launched
  // Chrome child (a plain context.close() over CDP leaves the process
  // running — the zombie-chrome leak). Also reaps the profile lock.
  teardown: () => Promise<void>;
  forceTeardown: () => void;
  identity: ProfileProcessIdentity | null;
}

export function childProcessIsRunning(child: ChildProcess | null): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

export async function attachSelfManagedLoginContext(
  endpoint: string,
  child: ChildProcess,
  profileDir: string,
  identity: ProfileProcessIdentity | null,
  options: {
    launcher?: { connectOverCDP(endpoint: string): Promise<Browser> };
    terminateChild?: (
      child: ChildProcess,
      profileDir: string,
      identity: ProfileProcessIdentity | null,
    ) => Promise<ProfileProcessIdentity | null>;
  } = {},
): Promise<{ browser: Browser; context: BrowserContext }> {
  let browser: Browser | null = null;
  try {
    browser = await (options.launcher ?? getChromium()).connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error("self-launched login Chrome exposed no default browser context");
    }
    return { browser, context };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    const terminateChild =
      options.terminateChild ??
      ((ownedChild, ownedProfileDir, ownedIdentity) =>
        terminateTrackedProfileChild(ownedChild, ownedProfileDir, {
          identity: ownedIdentity,
        }));
    await terminateChild(child, profileDir, identity);
    throw error;
  }
}

function profileCollisionFromStderr(stderr: string): ProfileBusyError | null {
  return /ProcessSingleton|SingletonLock|profile.*in use/i.test(stderr)
    ? new ProfileBusyError(PROFILE_BUSY_MESSAGE)
    : null;
}

// Self-launch Chrome + connectOverCDP for the INTERACTIVE login (connect /
// `mcp login`), instead of Playwright's launchPersistentContext.
//
// This is the STATE.md 2026-06-12 finding — the same launcher tell that fails
// Cloudflare Turnstile from a launchPersistentContext-driven Chrome and passes
// from a self-launched one — ported to the login path. BrowserController (the
// signup path) already migrated; the connect login was the last consumer of
// the detectable launcher. Kept STANDALONE (not a BrowserController method) so
// the working signup path is untouched.
//
// Persistent profile is preserved: --user-data-dir=profileDir means the
// provider session (Google/GitHub cookies) still lands in the bot's profile,
// which the connect flow needs to seed for later Gmail-reading / OAuth signups.
export async function launchSelfManagedLoginContext(params: {
  binary: string;
  profileDir: string;
  initialUrl: string;
  // App mode (--app=URL) opens a chromeless window — the connect noVNC path
  // needs it so tabs/URL bar don't eat the phone-shaped framebuffer.
  appMode: boolean;
  window: { width: number; height: number };
  env: NodeJS.ProcessEnv;
  // Server-only proxy (self-launch can't carry SOCKS/HTTP auth — the caller
  // falls back to launchPersistentContext for credentialed proxies).
  proxyServer: string | null;
  extraArgs?: readonly string[];
}): Promise<SelfLaunchedLogin> {
  let child: ChildProcess | null = null;
  let childIdentity: ProfileProcessIdentity | null = null;
  const endpoint = await withChromeStartupLock(
    async () => {
      const port = await findFreePort();
      clearStaleSingletonLock(params.profileDir);
      const argv = [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${params.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--window-position=0,0",
        `--window-size=${params.window.width},${params.window.height}`,
        "--lang=en-US",
        ...(params.extraArgs ?? []),
        ...(params.proxyServer !== null ? [`--proxy-server=${params.proxyServer}`] : []),
        // NB: we build argv ourselves, so Playwright's --enable-automation
        // (and the rest of its launch instrumentation — the actual Turnstile
        // tell) is never added. That is the whole point of self-launching.
        params.appMode ? `--app=${params.initialUrl}` : params.initialUrl,
      ];
      const spawned = spawn(params.binary, argv, {
        env: params.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child = spawned;
      childIdentity = registerSelfManagedChrome(spawned, params.profileDir);
      let chromeStderr = "";
      spawned.stderr?.on("data", (chunk: Buffer) => {
        chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
      });
      try {
        const endpoint = await waitForDevtools(port, 30_000, spawned);
        childIdentity = await resolveAttachedProfileChildIdentity(
          spawned,
          params.profileDir,
          childIdentity,
        );
        if (process.platform === "linux" && childIdentity === null) {
          throw new Error("self-launched login Chrome exited before identity was proven");
        }
        return endpoint;
      } catch (err) {
        childIdentity = await terminateTrackedProfileChild(spawned, params.profileDir, {
          identity: childIdentity,
        });
        const detail = chromeStderr.trim();
        const collision = profileCollisionFromStderr(detail);
        if (collision !== null) throw collision;
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}` +
            `${detail.length > 0 ? `; Chrome stderr: ${detail}` : ""}`,
        );
      }
    },
    { deadlineMs: 0 },
  );
  if (child === null) {
    throw new Error("self-launched login Chrome lost its process handle");
  }

  const { browser, context } = await attachSelfManagedLoginContext(
    endpoint,
    child,
    params.profileDir,
    childIdentity,
  );

  let torn = false;
  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    // Disconnect the CDP browser first; over connectOverCDP this leaves the
    // real Chrome running, so kill the child explicitly (SIGTERM, then a
    // hard SIGKILL after a short grace) to avoid the zombie-chrome leak.
    await browser.close();
    if (child !== null && childIdentity !== null) {
      signalProfileProcess(childIdentity, params.profileDir, "SIGTERM");
    }
  };

  const forceTeardown = (): void => {
    if (childIdentity !== null) {
      signalProfileProcess(childIdentity, params.profileDir, "SIGKILL");
      selfManagedChromes.delete(childIdentity.pid);
    }
    reapProfileHolderIfOwned(params.profileDir, childIdentity);
  };

  return { context, teardown, forceTeardown, identity: childIdentity };
}

export interface PlainLoginBrowser {
  // Idempotent: kills the spawned Chrome child and reaps the profile lock.
  teardown: () => Promise<void>;
  forceTeardown: () => void;
  // Plain login intentionally has no CDP attachment, so expose child liveness
  // for the polling loop to fail loudly if the visible browser disappears.
  isRunning: () => boolean;
  identity: ProfileProcessIdentity | null;
}

// Launch a TRULY PLAIN Chrome for the interactive connect claim — NO
// `--remote-debugging-port`, NO `connectOverCDP`, NO Playwright attach at all.
//
// WHY (2026-07-20, fully bisected on chad; see STATE.md "connect Google-login").
// Google's OAUTH authorization flow (Trusty Squire's "Sign in with Google",
// Gmail restricted scope) runs a "secure browser" integrity check that a plain
// `google-chrome` PASSES but a CDP-attached Chrome FAILS with
// `/v3/signin/rejected` — even a self-launched one, even with patchright, even
// though the same CDP browser passes a DIRECT accounts.google.com sign-in. The
// tell is the CDP attachment itself (NOT the launcher, NOT the flags, NOT
// `navigator.webdriver` — all separately ruled out). The connect claim doesn't
// need to drive the browser: the USER signs in over noVNC, completion is read
// from the API (`installPoll`), and provider seeding is read from the profile's
// SQLite cookie store (`profileHasProviderCookies`). So we spawn Chrome and
// only ever kill it — never attach.
//
// Persistent profile is preserved (--user-data-dir=profileDir) so the Google/
// GitHub session still lands in the bot's profile for later signups.
export async function launchPlainLoginBrowser(params: {
  binary: string;
  profileDir: string;
  // App mode (--app=URL) opens a chromeless window so the install page fills the
  // phone-shaped noVNC framebuffer.
  url: string;
  window: { width: number; height: number };
  env: NodeJS.ProcessEnv;
  proxyServer: string | null;
  extraArgs?: readonly string[];
}): Promise<PlainLoginBrowser> {
  let child: ChildProcess | null = null;
  let childIdentity: ProfileProcessIdentity | null = null;
  await withChromeStartupLock(
    async () => {
      clearStaleSingletonLock(params.profileDir);
      const argv = [
        `--user-data-dir=${params.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--window-position=0,0",
        `--window-size=${params.window.width},${params.window.height}`,
        "--lang=en-US",
        ...(params.extraArgs ?? []),
        ...(params.proxyServer !== null ? [`--proxy-server=${params.proxyServer}`] : []),
        `--app=${params.url}`,
      ];
      const spawned = spawn(params.binary, argv, {
        env: params.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child = spawned;
      childIdentity = registerSelfManagedChrome(spawned, params.profileDir);
      let chromeStderr = "";
      spawned.stderr?.on("data", (chunk: Buffer) => {
        chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
      });
      // Give Chrome a moment to actually come up (or die). Unlike the CDP path
      // there is no devtools endpoint to poll — but a crash-on-launch (bad
      // profile, missing lib) should surface here, not 15min later as a blank
      // noVNC. If the process is already dead, throw with its stderr.
      await new Promise((r) => setTimeout(r, 1_200));
      childIdentity ??=
        spawned.pid === undefined ? null : profileProcessIdentity(spawned.pid, params.profileDir);
      childIdentity = await resolveAttachedProfileChildIdentity(
        spawned,
        params.profileDir,
        childIdentity,
      );
      if (childIdentity !== null) selfManagedChromes.set(childIdentity.pid, childIdentity);
      if (!childProcessIsRunning(spawned)) {
        reapProfileHolderIfOwned(params.profileDir, childIdentity);
        const detail = chromeStderr.trim();
        const collision = profileCollisionFromStderr(detail);
        if (collision !== null) throw collision;
        const termination =
          spawned.exitCode !== null
            ? `code ${spawned.exitCode}`
            : `signal ${spawned.signalCode ?? "unknown"}`;
        throw new Error(
          `plain login Chrome exited immediately (${termination})` +
            `${detail.length > 0 ? `; Chrome stderr: ${detail}` : ""}`,
        );
      }
      if (process.platform === "linux" && childIdentity === null) {
        throw new Error("plain login Chrome identity could not be proven");
      }
    },
    { deadlineMs: 0 },
  );

  let torn = false;
  const forceTeardown = (): void => {
    if (childIdentity !== null) {
      signalProfileProcess(childIdentity, params.profileDir, "SIGKILL");
      selfManagedChromes.delete(childIdentity.pid);
    }
    reapProfileHolderIfOwned(params.profileDir, childIdentity);
  };
  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    if (child !== null && childIdentity !== null) {
      signalProfileProcess(childIdentity, params.profileDir, "SIGTERM");
    }
  };
  return {
    teardown,
    forceTeardown,
    isRunning: () => childProcessIsRunning(child),
    identity: childIdentity,
  };
}

export class BrowserController {
  // The persistent browser context. Persistent (launchPersistentContext)
  // rather than an ephemeral context so the profile carries the user's
  // Google session across runs — see profile.ts / google-login.ts.
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private checkoutCardGroupScope: CheckoutCardGroupScope | undefined;
  private checkoutOutcomeBaseline: CheckoutOutcomeBaseline | undefined;
  private checkoutFailureBaseline: CheckoutFailureBaseline | undefined;
  private checkoutThreeDsPending = false;
  private checkoutSubmitSequence = 0;
  // The page start() configured with the controller's navigation/captcha
  // handlers. OAuth may temporarily switch `this.page` to a popup, but warm
  // reuse must always restore this original page rather than adopting a popup
  // whose lifecycle handlers were never installed.
  private primaryPage: Page | null = null;
  // Self-launch path (Turnstile-safe; see selfLaunchEnabled). When we spawn
  // Chrome ourselves and attach over CDP, these hold the child process and
  // the connected Browser so close() can tear both down.
  private childChrome: ChildProcess | null = null;
  private childChromeIdentity: ProfileProcessIdentity | null = null;
  private cdpBrowser: Browser | null = null;
  // True once a local browser context launched this session.
  private launchedContext = false;
  private launchedProfileHolderIdentity: ProfileProcessIdentity | null = null;
  private profileOperationLease: ProfileOperationLease | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<ProfileCloseState> | null = null;
  private startCancellationRequested = false;
  private startLaunchCommitted = false;
  private startSettled = false;
  private persistentFallbackLaunchInFlight = false;
  private persistentFallbackCancellationState: ProfileCloseState | null = null;
  private profilePoolReusable = true;
  private resolveStartCancellation: (() => void) | null = null;
  private readonly startCancellation = new Promise<void>((resolveCancellation) => {
    this.resolveStartCancellation = resolveCancellation;
  });
  private cancelledStartReaper: Promise<void> | null = null;
  private readonly humanize: boolean;
  // Tracks the simulated mouse position so successive clicks can move
  // along a continuous path (humans don't teleport between clicks).
  private mouseX = 100;
  private mouseY = 100;
  // Records the browser channel that .start() actually launched. Set
  // post-launch so telemetry can surface "this run
  // used real Chrome" vs "this run used bundled Chromium." Useful for
  // separating fingerprint regressions from network regressions when
  // a service starts failing.
  private launchedChannel: string | null = null;
  // The proxy server this run egressed through, or null for a direct
  // connection. Set by .start(); surfaced via the `proxied` getter —
  // a captcha failure behind a residential proxy is materially
  // different signal from the same failure on a raw datacenter IP.
  private proxyServer: string | null = null;

  // Optional live provider of the session's current allowed hosts, used by the
  // fail-fast request-scope guard. Set by provision-session once a session
  // exists so the guard auto-scopes same-registrable-domain merchant API
  // siblings and fails-fast on genuinely out-of-scope in-page API calls. When
  // null/never set (harness replay, non-session use) the guard is inert.
  private hostScopeAllowedHostsProvider:
    | (() => { allowedHosts: readonly string[]; siblingDomainHosts: readonly string[] })
    | null = null;
  private hostScopeGuardInstallation: Promise<void> | null = null;

  // Feed the current session's allowed hosts to the request-scope guard. Read
  // lazily per request, so allow_host / auto-widen updates take effect without
  // re-registering the route. Registers the single fail-fast route handler on
  // the first call — so the guard is only ever active for real operator
  // sessions, never for harness/replay or non-session browsers.
  async setHostScopeAllowedHosts(
    provider: () => readonly string[],
    siblingDomainProvider: () => readonly string[] = provider,
  ): Promise<void> {
    this.hostScopeAllowedHostsProvider = () => ({
      allowedHosts: provider(),
      siblingDomainHosts: siblingDomainProvider(),
    });
    this.hostScopeGuardInstallation ??= this.installHostScopeGuard().catch((error: unknown) => {
      this.hostScopeGuardInstallation = null;
      throw error;
    });
    await this.hostScopeGuardInstallation;
  }

  // Defect-A fail-fast request-scope guard. Only XHR/fetch subresource API
  // calls are scope-guarded; page-load resources (scripts/styles/images/frames)
  // always continue, so a legitimate render is never broken by the guard. A
  // checkout SPA's own backend API often lives on a same-registrable-domain
  // sibling subdomain (e.g. cart-api.step.rakuten.co.jp beside
  // cart.step.rakuten.co.jp) and is auto-scoped in via requestHostInScope. For
  // a genuinely out-of-scope call the old behavior was a silently-dropped
  // request that never resolved — wedging the page with an infinite spinner.
  // Here it is aborted with a real net error so the page's fetch/XHR rejects
  // promptly and the site's own error handling runs.
  private async installHostScopeGuard(): Promise<void> {
    const ctx = this.context;
    if (ctx === null) throw new Error("Browser not started");
    await ctx.route("**/*", async (route) => {
      try {
        const url = route.request().url();
        const type = route.request().resourceType();
        const scope = this.hostScopeAllowedHostsProvider?.() ?? null;
        if (
          isFailFastScopeAbort(url, type, scope?.allowedHosts ?? null, scope?.siblingDomainHosts)
        ) {
          await route.abort("failed");
          return;
        }
        await route.fallback();
      } catch {
        await route.fallback().catch(() => undefined);
      }
    });
  }

  private readonly profileDir: string;

  // The replay harness owns this context so it can route the storefront from a
  // HAR, then remove that route before checkout becomes live.
  private harnessAttachedPage = false;

  // T6/T7 — OAuth handshake bookkeeping. Legacy startOAuth() adopts a
  // popup window as the active page, so keep the product tab parked here
  // until settleAfterOAuth() restores it. The operator's oauth_login action
  // keeps the observed product page active for the click and opens a recovery
  // tab before the provider can redirect or close either OAuth transport.
  private oauthProductPage: Page | null = null;
  private oauthProviderPage: Page | null = null;
  private oauthProviderPageClosed = false;
  // Deep-investigation instrumentation (UNIVERSAL_BOT_OAUTH_DEBUG): a ring
  // buffer of OAuth/SSO-relevant network responses, so we can see WHY a Clerk/
  // Stytch SSO callback fails to persist a session (cookie not set, FAPI
  // rejection, etc.) without guessing. Off by default; zero cost when unset.
  private oauthNetLog: Array<{ url: string; status: number; setCookie: boolean; ct: string }> = [];
  private oauthNetListenerAttached = false;

  // F13 — on-demand Xvfb. Set when start() determined the host has no
  // display surface but Xvfb is available, so Chrome can run with
  // `headless: false` against a virtual display (Cloudflare/Stytch et
  // al. detect Chromium-headless and block their signup forms). Torn
  // down by close().
  private xvfb: XvfbRig | null = null;

  // F13 — which launch path start() took. Surfaced via .launchMode so
  // the agent can push it into the run's step trail and we can see
  // (from outside the box) whether the bot ran headed.
  private launchedMode: "display" | "xvfb" | "headless" | "remote" | "unknown" = "unknown";

  get launchMode(): "display" | "xvfb" | "headless" | "remote" | "unknown" {
    return this.launchedMode;
  }

  constructor(opts: BrowserControllerOptions = {}) {
    this.humanize = opts.humanize ?? true;
    this.profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
    this.proxyOverride =
      opts.proxyUrl !== undefined && opts.proxyUrl.trim().length > 0 ? opts.proxyUrl.trim() : null;
  }

  /** Attach normal controller behavior to a harness-owned Playwright page. */
  static fromHarnessPage(page: Page): BrowserController {
    const controller = new BrowserController({ humanize: false });
    controller.context = page.context();
    controller.page = page;
    controller.primaryPage = page;
    controller.harnessAttachedPage = true;
    controller.launchedMode = "headless";
    return controller;
  }

  // Per-launch egress override (verify-fleet identities each get their own IP).
  // null → use the env-global proxy. See resolveProxy().
  private readonly proxyOverride: string | null;

  // Warm reuse is deliberately narrow: a browser belongs to exactly one
  // persistent profile and one explicit egress override. Undefined/blank proxy
  // values both mean "use the environment/default route".
  matchesLaunchOptions(opts: Pick<BrowserControllerOptions, "profileDir" | "proxyUrl">): boolean {
    const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
    const proxyUrl =
      opts.proxyUrl !== undefined && opts.proxyUrl.trim().length > 0 ? opts.proxyUrl.trim() : null;
    return this.profileDir === profileDir && this.proxyOverride === proxyUrl;
  }

  /** Identity persisted by the operator profile lease for owner-safe crash recovery. */
  operatorWorkerIdentity(): OperatorWorkerIdentity | null {
    return this.childChromeIdentity ?? this.launchedProfileHolderIdentity;
  }

  // Required health gate for a warm browser. BrowserContext alone is not a
  // sufficient signal: a dead CDP transport can leave stale JS objects behind.
  isConnected(): boolean {
    const browser = this.cdpBrowser ?? this.context?.browser() ?? null;
    return browser?.isConnected() === true;
  }

  // Which browser channel the most recent .start() actually used.
  // `null` means bundled Chromium; a string like "chrome" means a
  // real installed browser of that channel. Throws if .start() hasn't
  // been called yet — there's no sensible default to return.
  get channel(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.channel read before .start()");
    }
    return this.launchedChannel;
  }

  // The proxy server the most recent .start() routed egress through,
  // or null for a direct connection. Useful telemetry alongside
  // `channel`. Throws if .start() hasn't run — same reason as channel.
  get proxied(): string | null {
    if (this.context === null) {
      throw new Error("BrowserController.proxied read before .start()");
    }
    return this.proxyServer;
  }

  // The stealth profile the most recent .start() launched under:
  // "cdp_hardened" when the patchright launcher actually loaded
  // (BOT_CDP_HARDENED set + patchright present), else "baseline". Surfaced
  // for the CaptchaEvent A/B tag. Throws before .start() — same reason
  // as channel/proxied.
  get stealthProfile(): StealthProfile {
    if (this.context === null) {
      throw new Error("BrowserController.stealthProfile read before .start()");
    }
    return activeStealthProfileValue();
  }

  // Launch Chrome ourselves and attach over CDP — the Turnstile-safe launch
  // (see selfLaunchEnabled for the proof). The profile dir is the SAME shared
  // profile launchPersistentContext would use, so the OAuth session carries
  // over. Options that a default connectOverCDP context can't take at creation
  // are applied differently:
  //   • timezone  → TZ env on the child (more authentic than a CDP override)
  //   • proxy     → --proxy-server flag, with credentials applied post-connect
  //   • viewport  → --window-size (with viewport:null-equivalent: we never set
  //                 an emulated viewport on the connected context)
  //   • locale/geo/permissions → applied post-connect by start()
  private async launchSelfManagedContext(params: {
    binary: string;
    headless: boolean;
    args: readonly string[];
    proxy: ProxySettings | null;
    env: NodeJS.ProcessEnv;
    window: { width: number; height: number };
  }): Promise<BrowserContext> {
    this.throwIfStartCancelled();
    // Remote-CDP attach: BOT_CDP_ENDPOINT points at a Chrome already running on
    // another host (e.g. a real-GPU Mac), reachable over Tailscale. We do NOT
    // spawn or own the binary — the remote host launched it with its own
    // profile, real GPU, and (residential) egress. Just attach over CDP. This
    // is the real-GPU path: software-WebGL output (llvmpipe) is what
    // hCaptcha-Enterprise-class anti-bot scores, and only real hardware fixes
    // the rendered-pixel fingerprint that JS spoofing can't.
    const remoteEndpoint = (process.env.BOT_CDP_ENDPOINT ?? "").trim();
    if (remoteEndpoint.length > 0) {
      const launcher = getChromium();
      const browser = await launcher.connectOverCDP(remoteEndpoint);
      this.cdpBrowser = browser;
      this.launchedMode = "remote";
      const ctx = browser.contexts()[0];
      if (ctx === undefined) {
        throw new Error(
          `remote Chrome (BOT_CDP_ENDPOINT=${remoteEndpoint}) exposed no default browser context`,
        );
      }
      return ctx;
    }
    const endpoint = await withChromeStartupLock(
      async () => {
        this.throwIfStartCancelled();
        const port = await findFreePort();
        this.throwIfStartCancelled();
        clearStaleSingletonLock(this.profileDir);
        const argv = [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${this.profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--window-position=0,0",
          `--window-size=${params.window.width},${params.window.height}`,
          "--lang=en-US",
          ...params.args,
          ...(params.proxy !== null ? [`--proxy-server=${params.proxy.server}`] : []),
          ...(params.headless ? ["--headless=new"] : []),
          "about:blank",
        ];
        this.commitProfileLaunch();
        const child = spawn(params.binary, argv, {
          env: params.env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        this.childChrome = child;
        this.childChromeIdentity = registerSelfManagedChrome(child, this.profileDir);
        let chromeStderr = "";
        let chromeExit = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          chromeStderr = (chromeStderr + chunk.toString("utf8")).slice(-4_000);
        });
        child.on("exit", (code, signal) => {
          chromeExit = ` exit=${code ?? "null"} signal=${signal ?? "none"}`;
        });
        if (this.startCancellationRequested) {
          await this.cancelSpawnedSelfManagedChrome(child);
          throw new Error("BrowserController start cancelled");
        }
        try {
          const endpoint = await waitForDevtools(port, 30_000);
          this.childChromeIdentity = await resolveAttachedProfileChildIdentity(
            child,
            this.profileDir,
            this.childChromeIdentity,
          );
          if (process.platform === "linux" && this.childChromeIdentity === null) {
            throw new Error("self-launched Chrome exited before identity was proven");
          }
          return endpoint;
        } catch (err) {
          const alive =
            this.childChromeIdentity !== null &&
            profileProcessMatches(this.childChromeIdentity, this.profileDir);
          this.childChromeIdentity = await terminateTrackedProfileChild(child, this.profileDir, {
            identity: this.childChromeIdentity,
          });
          this.childChrome = null;
          this.childChromeIdentity = null;
          const detail = chromeStderr.trim();
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}; Chrome pid=${child.pid ?? "unknown"} alive=${alive ? 1 : 0}` +
              `${chromeExit}${detail.length > 0 ? `; Chrome stderr: ${detail}` : ""}`,
          );
        }
      },
      { deadlineMs: 0 },
    );
    // Use the patchright launcher's connectOverCDP — it's the exact path the
    // falsification experiment validated (its connect avoids Runtime.enable,
    // which a plain attach would emit). The anti-detection that matters here
    // is the LAUNCH (which we now own), not the connect.
    const launcher = getChromium();
    const browser = await launcher.connectOverCDP(endpoint);
    this.cdpBrowser = browser;
    const ctx = browser.contexts()[0];
    if (ctx === undefined) {
      throw new Error("self-launched Chrome exposed no default browser context");
    }
    return ctx;
  }

  private async cancelSpawnedSelfManagedChrome(child: ChildProcess): Promise<void> {
    this.childChromeIdentity = await terminateTrackedProfileChild(child, this.profileDir, {
      identity: this.childChromeIdentity,
    });
    if (this.childChrome === child) this.childChrome = null;
    this.childChromeIdentity = null;
  }

  // Resource blocking for speed (BOT_BLOCK_RESOURCES, default OFF). Aborts
  // image/media/font requests + known analytics/tracker hosts to cut page-load
  // wall-clock (3-5x on byte-heavy pages; also stops trackers from holding the
  // network "busy"). HARD ALLOW-GUARD first for captcha/challenge + payment
  // scripts (blocking those breaks the Turnstile/hCaptcha token poll and the
  // signup form). CSS + first-party JS are never blocked (not in BLOCK_TYPES) —
  // the SPA form renders from them and the vision planner reads the styled
  // render. DUAL RISK, hence default-OFF + an OF#2 A/B before flipping on:
  //   (1) a browser that loads ZERO images is itself an anti-bot fingerprint;
  //   (2) the screenshot the vision planner reads loses detail — mitigated
  //       because the DOM inventory is the authoritative action space, but
  //       still a regression risk on image-only affordances.
  // Registered on the CONTEXT so it covers OAuth popups + iframes.
  private async installResourceBlocking(): Promise<void> {
    const ctx = this.context;
    if (ctx === null) return;
    if (!/^(1|true|on)$/i.test(process.env.BOT_BLOCK_RESOURCES ?? "")) return;
    const BLOCK_TYPES = new Set(["image", "media", "font"]);
    const BLOCK_HOSTS = [
      "google-analytics.com",
      "googletagmanager.com",
      "analytics.google.com",
      "doubleclick.net",
      "static.hotjar.com",
      "script.hotjar.com",
      "segment.com",
      "segment.io",
      "cdn.segment.com",
      "fullstory.com",
      "mixpanel.com",
      "bugsnag.com",
      "intercom.io",
      "intercomcdn.com",
      "widget.intercom.io",
      "connect.facebook.net",
      "analytics.tiktok.com",
      "clarity.ms",
      "cdn.heapanalytics.com",
      "wistia.com",
    ];
    // NEVER block — these break signup (captcha/challenge widgets + payment SDK).
    const ALWAYS_ALLOW = [
      "challenges.cloudflare.com",
      "turnstile",
      "hcaptcha.com",
      "newassets.hcaptcha.com",
      "recaptcha",
      "gstatic.com/recaptcha",
      "js.stripe.com",
    ];
    await ctx.route("**/*", async (route) => {
      try {
        const url = route.request().url();
        if (ALWAYS_ALLOW.some((h) => url.includes(h))) {
          await route.continue();
          return;
        }
        const type = route.request().resourceType();
        if (BLOCK_TYPES.has(type) || BLOCK_HOSTS.some((h) => url.includes(h))) {
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        // Routing race / already-handled — never let a decision crash nav.
      }
    });
    console.error(
      "[operator] resource blocking ON (image/media/font + analytics aborted; captcha/CSS/JS allowed)",
    );
  }

  async start(): Promise<void> {
    if (this.closePromise !== null) throw new Error("BrowserController is already closing");
    this.startPromise ??= this.startOnce();
    await this.startPromise;
  }

  private async startOnce(): Promise<void> {
    const remoteMode = (process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0;
    const lease = remoteMode ? null : await acquireFreeProfileOperationGuard(this.profileDir);
    this.profileOperationLease = lease;
    try {
      await this.startWithProfileGuard();
      if (this.startCancellationRequested) {
        await this.closeWithProfileGuard();
        throw new Error("BrowserController start cancelled");
      }
    } catch (err) {
      if (this.startCancellationRequested && this.persistentFallbackCancellationState === null) {
        await this.closeWithProfileGuard().catch(() => undefined);
      }
      if (
        this.persistentFallbackCancellationState === null ||
        this.persistentFallbackCancellationState === "closed"
      ) {
        this.profileOperationLease = null;
        lease?.release();
      }
      throw err;
    } finally {
      this.startSettled = true;
    }
  }

  private throwIfStartCancelled(): void {
    if (this.startCancellationRequested) throw new Error("BrowserController start cancelled");
  }

  private commitProfileLaunch(): void {
    this.throwIfStartCancelled();
    this.startLaunchCommitted = true;
  }

  private async startWithProfileGuard(): Promise<void> {
    this.throwIfStartCancelled();
    reapOrphanedBrowsersOnce(this.profileDir);
    const channel = await detectChromiumChannel();
    this.throwIfStartCancelled();
    this.launchedChannel = channel;
    const proxy = await this.resolveProxy();
    this.throwIfStartCancelled();
    this.proxyServer = proxy?.server ?? null;
    // Stderr so the MCP stdio transport's framing stays clean (the
    // module's existing logging convention).
    console.error(
      `[operator] launching browser channel=${channel ?? "bundled-chromium"} ` +
        `proxy=${proxy?.server ?? "direct"}`,
    );
    // Remote-CDP mode (BOT_CDP_ENDPOINT): the browser runs on a REMOTE host
    // (e.g. a Mac with a real GPU + residential egress) and we attach over CDP
    // across Tailscale. The remote machine IS a real device, so we spoof
    // NOTHING — no WebGL/device fingerprint patch (a fake-Intel string over a
    // real Apple-GPU output would be its own mismatch tell), no local Xvfb, no
    // egress-geo override (the remote host's real timezone + residential IP are
    // authentic). software-WebGL output is exactly what the toughest anti-bot
    // (hCaptcha Enterprise) scores; only real hardware fixes the pixel
    // fingerprint, which is the whole point of this path.
    const remoteMode = (process.env.BOT_CDP_ENDPOINT ?? "").trim().length > 0;
    if (remoteMode) {
      console.error(
        `[operator] REMOTE-CDP mode — attaching to ${(process.env.BOT_CDP_ENDPOINT ?? "").trim()} ` +
          `(real-host GPU + egress; local fingerprint spoof + Xvfb DISABLED)`,
      );
    }
    // T3.1: probe where this run's traffic actually exits so the
    // browser's declared timezone matches its egress IP (a US-timezone
    // browser on a foreign proxy IP is itself an anti-bot signal).
    // Done before the real launch: launchPersistentContext bakes the
    // timezone in at creation, with no way to set it afterward. Skipped in
    // remote mode — the remote host's own clock/IP are the authentic truth.
    const geo = remoteMode ? null : await this.probeEgressGeo(channel, proxy);
    this.throwIfStartCancelled();
    if (geo !== null) {
      console.error(
        `[operator] egress geo: timezone=${geo.timezoneId}` +
          (geo.geolocation !== undefined
            ? ` loc=${geo.geolocation.latitude},${geo.geolocation.longitude}`
            : ""),
      );
    }
    // F13 — decide whether to spin up Xvfb and run Chrome headed.
    // Modern SaaS signups (Cloudflare/Stytch, Clerk, Auth0) detect
    // Chromium-headless via JS fingerprints and gate their forms
    // behind the check. Running headed against Xvfb defeats the gate
    // — the user never sees the display.
    //
    // The decision matrix:
    //   - UNIVERSAL_BOT_HEADLESS=true (explicit opt-in): keep true
    //     headless. CI / Codespaces that lack Xvfb.
    //   - UNIVERSAL_BOT_HEADLESS=false (explicit opt-out): the
    //     current pre-F13 behavior — DISPLAY must exist already.
    //   - default + DISPLAY set: run headed against the existing
    //     display (laptop/desktop install).
    //   - default + no DISPLAY + Xvfb on PATH: spawn Xvfb, run
    //     headed against it (the headless-server install — what
    //     Cloudflare needed).
    //   - default + no DISPLAY + no Xvfb: fall back to true
    //     headless with a clear stderr warning.
    let chromeEnv: NodeJS.ProcessEnv | undefined;
    let chromeHeadless: boolean;
    const explicitHeadless = process.env.UNIVERSAL_BOT_HEADLESS;
    const hostHasDisplay =
      process.platform === "darwin" ||
      process.platform === "win32" ||
      (typeof process.env.DISPLAY === "string" && process.env.DISPLAY.length > 0);
    if (explicitHeadless === "true") {
      chromeHeadless = true;
      this.launchedMode = "headless";
    } else if (explicitHeadless === "false") {
      chromeHeadless = false;
      this.launchedMode = "display";
    } else if (hostHasDisplay) {
      chromeHeadless = false;
      this.launchedMode = "display";
    } else if (xvfbAvailable()) {
      try {
        // 1920×1080 — the most common real desktop resolution. The old
        // 1280×720 here was exactly Playwright's emulated-device viewport
        // default (the code's own comments flag that as an anti-bot tell),
        // and with viewport:null the page read it straight back. A 720p
        // screen whose availHeight==height (no taskbar) is a headless
        // signature strict Turnstiles (exa/cartesia) score against.
        const xvfb = await startXvfb({ width: 1920, height: 1080 });
        if (this.startCancellationRequested) {
          xvfb.stop();
          this.throwIfStartCancelled();
        }
        this.xvfb = xvfb;
        chromeEnv = { ...process.env, DISPLAY: xvfb.display };
        chromeHeadless = false;
        this.launchedMode = "xvfb";
        console.error(
          `[operator] no DISPLAY — spawned Xvfb at ${this.xvfb.display} for headed Chrome`,
        );
      } catch (err) {
        console.error(
          `[operator] Xvfb failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `falling back to true headless; Cloudflare/Stytch-class signups may fail`,
        );
        chromeHeadless = true;
        this.launchedMode = "headless";
      }
    } else {
      console.error(
        `[operator] no DISPLAY and Xvfb not installed — running true headless. ` +
          `For Cloudflare/Stytch-class signups install xvfb: apt-get install -y xvfb`,
      );
      chromeHeadless = true;
      this.launchedMode = "headless";
    }

    const free = await waitForProfileFree(this.profileDir, { deadlineMs: 0 });
    this.throwIfStartCancelled();
    if (!free) {
      throw new ProfileBusyError(PROFILE_BUSY_MESSAGE);
    }

    // T3: a PERSISTENT context. The profile dir carries the user's
    // Google session (established by `mcp login` — see google-login.ts),
    // so the OAuth-first signup path reuses it instead of starting
    // logged-out. launchPersistentContext takes launch + context
    // options in one call.
    // Resolve the launcher first so activeStealthProfile is set before we
    // decide on executablePath below.
    const launcher = getChromium();
    const hardened = activeStealthProfileValue() === "cdp_hardened";
    // Both launchers drive real Chrome via `channel`: baseline through
    // playwright+stealth, hardened through patchright. patchright closes
    // the automation tells at the protocol layer and drives real Chrome
    // directly — so it no longer needs the bundled-chromium pin the old
    // rebrowser fork required (the pin is what crashed the OAuth flow and
    // confounded the A/B). One binary for both arms.
    this.launchedChannel = channel;
    // Launch args shared by BOTH paths (launchPersistentContext and the
    // self-launch). See the per-flag rationale: swiftshader gives a real
    // (software) WebGL context on the GPU-less Xvfb box; the others are the
    // standard headless/sandbox flags. NOTE we deliberately do NOT include
    // Playwright's automation flags (--enable-automation et al.) — on the
    // self-launch path their ABSENCE is the whole fix.
    const launchArgs: readonly string[] = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ];
    // F10 clipboard + egress-matched geolocation permission, built once for
    // either path. Typed as string[] (Playwright's grantPermissions /
    // permissions option both accept it).
    const grantedPermissions: string[] = [
      ...(geo?.geolocation !== undefined ? ["geolocation"] : []),
      "clipboard-read",
      "clipboard-write",
    ];
    const selfLaunchBinary = selfLaunchEnabled()
      ? (resolveChannelBinary(channel) ?? (channel === null ? launcher.executablePath() : null))
      : null;
    const proxyHasAuth =
      proxy !== null && typeof proxy.username === "string" && proxy.username.length > 0;
    const useSelfLaunch =
      selfLaunchBinary !== null && existsSync(selfLaunchBinary) && !proxyHasAuth;

    let context: BrowserContext;
    this.throwIfStartCancelled();
    if (useSelfLaunch && selfLaunchBinary !== null) {
      console.error(
        `[operator] self-launch + connectOverCDP (Turnstile-safe launch) binary=${selfLaunchBinary}`,
      );
      const window =
        this.launchedMode === "xvfb"
          ? { width: 1920, height: 1080 }
          : { width: 1280, height: 1024 };
      const selfEnv: NodeJS.ProcessEnv = {
        ...(chromeEnv ?? process.env),
        TZ: geo?.timezoneId ?? "America/New_York",
      };
      context = await launchWithProfileGate(
        this.profileDir,
        () => {
          this.throwIfStartCancelled();
          return this.launchSelfManagedContext({
            binary: selfLaunchBinary,
            headless: chromeHeadless,
            args: launchArgs,
            proxy,
            env: selfEnv,
            window,
          });
        },
        { failFast: true },
      );
      try {
        await context.grantPermissions(grantedPermissions);
        if (geo?.geolocation !== undefined) {
          await context.setGeolocation(geo.geolocation);
        }
      } catch (err) {
        console.error(
          `[operator] post-connect context setup partial: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      this.profilePoolReusable = false;
      this.persistentFallbackLaunchInFlight = true;
      const cleanupProfileHolder = async (): Promise<ProfileCloseState> => {
        const proof = await this.waitForPersistentFallbackIdentity();
        if (proof.state === "absent") return "closed";
        if (proof.state === "unknown") return "unknown";
        const { identity } = proof;
        signalProfileProcess(identity, this.profileDir, "SIGKILL");
        return (await this.waitForOwnedProfileExit(identity)) ? "closed" : "unknown";
      };
      const cleanupCancelled = async (lateContext: BrowserContext): Promise<ProfileCloseState> => {
        const proof = await this.waitForPersistentFallbackIdentity();
        if (proof.state !== "owned") {
          await lateContext.close().catch(() => undefined);
          return proof.state === "absent" ? "closed" : "unknown";
        }
        const { identity } = proof;
        const closeState = await closeProfileWithProof({
          profileDir: this.profileDir,
          identity,
          close: () => lateContext.close(),
          forceClose: () => {
            signalProfileProcess(identity, this.profileDir, "SIGKILL");
            reapProfileHolderIfOwned(this.profileDir, identity);
          },
        });
        if (closeState === "closed") return closeState;
        return (await this.waitForOwnedProfileExit(identity)) ? "closed" : "unknown";
      };
      const outcome = await (async () => {
        try {
          return await launchCancellablePersistentContext({
            launch: (options) =>
              launchWithProfileGate(
                this.profileDir,
                () => launcher.launchPersistentContext(this.profileDir, options),
                { failFast: true },
              ),
            options: {
              headless: chromeHeadless,
              ...(chromeEnv !== undefined ? { env: chromeEnv } : {}),
              ...(channel !== null ? { channel } : {}),
              ...(proxy !== null ? { proxy } : {}),
              args: [...launchArgs],
              viewport: null,
              locale: "en-US",
              timezoneId: geo?.timezoneId ?? "America/New_York",
              permissions: grantedPermissions,
              ...(geo?.geolocation !== undefined ? { geolocation: geo.geolocation } : {}),
            },
            cancellation: this.startCancellation,
            cleanupCancelled,
            cleanupRejected: cleanupProfileHolder,
          });
        } catch (error) {
          if (!this.startCancellationRequested) {
            this.persistentFallbackLaunchInFlight = false;
            throw error;
          }
          this.persistentFallbackCancellationState = await cleanupProfileHolder().catch(
            () => "unknown" as const,
          );
          this.persistentFallbackLaunchInFlight = false;
          throw new Error("BrowserController start cancelled");
        }
      })();
      if (outcome.status === "cancelled") {
        this.persistentFallbackCancellationState = outcome.closeState;
        this.persistentFallbackLaunchInFlight = false;
        throw new Error("BrowserController start cancelled");
      }
      context = outcome.value;
      if (this.startCancellationRequested) {
        this.persistentFallbackCancellationState = await cleanupCancelled(context).catch(
          () => "unknown" as const,
        );
        this.persistentFallbackLaunchInFlight = false;
        throw new Error("BrowserController start cancelled");
      }
      this.context = context;
      this.launchedContext = true;
      const holderPid = currentProfileHolderPid(this.profileDir);
      this.launchedProfileHolderIdentity =
        holderPid === null ? null : profileProcessIdentity(holderPid, this.profileDir);
      this.commitProfileLaunch();
      this.persistentFallbackLaunchInFlight = false;
    }
    this.context = context;
    // We own the profile now — close() may reap a leaked Chrome.
    this.launchedContext = true;
    if (!remoteMode) {
      const holderPid = this.childChrome?.pid ?? currentProfileHolderPid(this.profileDir);
      this.launchedProfileHolderIdentity =
        this.childChromeIdentity ??
        (holderPid === null ? null : profileProcessIdentity(holderPid, this.profileDir));
    }
    if (this.startCancellationRequested) {
      await this.closeWithProfileGuard();
      throw new Error("BrowserController start cancelled");
    }
    // Speed: optionally abort heavy/irrelevant requests before any navigation.
    await this.installResourceBlocking();
    // Dev-runtime guard: when the bot is run through `tsx`, esbuild may inject
    // calls to its `__name(fn, "name")` helper into functions passed to
    // page.evaluate/addInitScript. Those functions execute in the browser page,
    // where Node's helper does not exist, causing an immediate
    // `ReferenceError: __name is not defined` before the real signup even
    // starts. Define the same no-op helper in every document. Built `dist`
    // should not emit these calls, but the helper is harmless there too.
    const evaluateNameShimScript =
      'Object.defineProperty(globalThis, "__name", { value: (fn) => fn, configurable: true });';
    const contextInitScripts = contextInitScriptsFor({ hardened, remoteMode });
    // Never register context init scripts under patchright. Its injection path
    // rewrites text/html after decoding the response as UTF-8, corrupting
    // server-rendered EUC-JP and Shift_JIS before Chrome parses it. The scripts
    // also land outside the main world under patchright, so the per-navigation
    // page.evaluate path below is the effective hardened-mode installation.
    // Baseline playwright-extra does not rewrite responses and keeps these
    // document-start installs. Regression guard: observe-jp-mojibake.test.ts.
    if (contextInitScripts.includes("evaluate-name-shim")) {
      await context.addInitScript({ content: evaluateNameShimScript });
    }
    // Patch navigator.webdriver — BASELINE ONLY. Measured against the
    // rebrowser bot-detector, this manual `defineProperty` is
    // COUNTERPRODUCTIVE under patchright: it re-adds `webdriver` as an own
    // property the detector then flags, whereas patchright removes it
    // correctly at the source. So in hardened mode we leave it to
    // patchright; only the stealth baseline gets the manual patch.
    if (contextInitScripts.includes("navigator-webdriver")) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    }

    // rc.33 / 2026-06-04 — spoof the WebGL UNMASKED vendor+renderer toward a
    // stock Intel GPU, so the software Mesa/llvmpipe string (--enable-unsafe-
    // swiftshader gives us a context, but llvmpipe is itself a VM/headless
    // tell) doesn't read through. Applied TWO ways because patchright
    // (hardened) isolates document-start scripts from the page's main world:
    //   • addInitScript — document-start; the effective path in the stealth
    //     BASELINE (non-patchright).
    //   • re-applied via page.evaluate on every navigation — the ONLY path that
    //     reaches the MAIN world under patchright. MEASURED 2026-06-04:
    //     addInitScript AND raw CDP Page.addScriptToEvaluateOnNewDocument both
    //     land in patchright's isolated world (renderer stayed llvmpipe);
    //     page.evaluate does not (renderer became Intel), and the v3 score held
    //     at 1.0. Idempotent via a marker so the per-nav re-apply is cheap, and
    //     getParameter.toString() is masked to the original native source so
    //     the patch itself isn't a tell. Only strings change, not rendering.
    const installWebglSpoofScript = String.raw`(() => {
      const VENDOR_WEBGL = 0x9245; // UNMASKED_VENDOR_WEBGL
      const RENDERER_WEBGL = 0x9246; // UNMASKED_RENDERER_WEBGL
      const spoof = (proto) => {
        // The marker lives on the prototype so re-application is a no-op; the
        // cast is the one typed-alternative-exhausted spot (adding an ad-hoc
        // brand to a DOM prototype).
        if (proto.__tsWebglPatched === true) return;
        const orig = proto.getParameter;
        const native = orig.toString();
        proto.getParameter = function (p) {
          if (p === VENDOR_WEBGL) return "Google Inc. (Intel)";
          if (p === RENDERER_WEBGL) {
            return "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)";
          }
          return orig.call(this, p);
        };
        Object.defineProperty(proto.getParameter, "toString", {
          value: () => native,
          configurable: true,
          writable: true,
        });
        proto.__tsWebglPatched = true;
      };
      if (typeof WebGLRenderingContext !== "undefined") {
        spoof(WebGLRenderingContext.prototype);
      }
      if (typeof WebGL2RenderingContext !== "undefined") {
        spoof(WebGL2RenderingContext.prototype);
      }
      // Device-tell normalization. The headless harvester box reports 20
      // logical cores (navigator.hardwareConcurrency) — a consumer residential
      // device is 4-16. A 20-core Linux machine behind a "residential" IP is
      // an internal inconsistency Cloudflare Turnstile scores against
      // (MEASURED 2026-06-11: exa/cartesia Turnstile won't issue a token on a
      // clean-fingerprint click; hwConcurrency=20 + Linux is the standout
      // anomaly). Normalize to a common consumer profile. Same per-nav main-
      // world application as the WebGL spoof — patchright denies init-world
      // reach, and Turnstile reads these after the challenge script loads
      // (seconds in), so the framenavigated re-apply wins the race. Defined on
      // Navigator.prototype (where the native getters live) so there's no own-
      // property tell on the instance.
      const navProto = Navigator.prototype;
      if (navProto.__tsDevicePatched !== true) {
        try {
          Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
            get: () => 8,
            configurable: true,
          });
          Object.defineProperty(Navigator.prototype, "deviceMemory", {
            get: () => 8,
            configurable: true,
          });
          // Screen availHeight tell: a headless Xvfb screen reports
          // availHeight == height (no OS taskbar), whereas a real Windows
          // desktop reserves ~40px for the taskbar (availHeight = height-40,
          // availWidth = width). Reinstate that gap so the screen reads like
          // an ordinary desktop, not a bare framebuffer. Guarded so it only
          // applies when the two are currently equal (i.e. headless).
          try {
            if (screen.availHeight === screen.height) {
              Object.defineProperty(Screen.prototype, "availHeight", {
                get: () => screen.height - 40,
                configurable: true,
              });
            }
          } catch {
            // leave it
          }
          navProto.__tsDevicePatched = true;
        } catch {
          // descriptor already locked by something else — leave it.
        }
      }
    })();`;
    // Skip under patchright (hardened) — see the mojibake note above: any
    // context.addInitScript triggers patchright's charset-lossy text/html
    // rewrite. This spoof is already re-applied per navigation via
    // reapplyWebglSpoof (framenavigated/load), which the comment above notes is
    // the ONLY path that reaches the main world under patchright anyway, so the
    // context init copy is dead weight there.
    if (contextInitScripts.includes("webgl-spoof")) {
      await context.addInitScript({ content: installWebglSpoofScript });
    }
    this.page = context.pages()[0] ?? (await context.newPage());
    this.primaryPage = this.page;
    // In baseline mode addInitScript covers document-start page JS, but
    // Playwright's page.evaluate utility execution can run in a separate realm.
    // Install the same no-op helper there with a STRING evaluate (tsx cannot
    // wrap strings with __name). This prevents dev-runtime source runs from
    // crashing before replay reaches the service page.
    await this.page.evaluate(evaluateNameShimScript).catch(() => undefined);
    // Re-apply on every navigation — the main-world reach patchright's isolated
    // init world denies us. framenavigated fires at navigation-commit (before
    // most page JS), so a late WebGL query (reCAPTCHA scores seconds in) sees
    // the spoofed strings; a document-start fingerprinter could still race it.
    const reapplyWebglSpoof = (): void => {
      if (remoteMode) return; // real-GPU remote host: spoof nothing
      const pg = this.page;
      if (pg === null) return;
      void (async () => {
        await pg.evaluate(evaluateNameShimScript).catch(() => undefined);
        await pg.evaluate(installWebglSpoofScript).catch(() => {
          // mid-navigation / closed page — the next navigation re-applies.
        });
      })();
    };
    // A CROSS-ORIGIN captcha iframe (hCaptcha / Turnstile / reCAPTCHA) is its own
    // realm: the main-frame page.evaluate above never reaches it, so the captcha's
    // OWN fingerprint read sees the real software-WebGL renderer (llvmpipe /
    // SwiftShader) + 20-core / high-memory / no-taskbar Linux profile — a
    // headless/VM tell. MEASURED 2026-06-23: Stripe's invisible hCaptcha
    // Enterprise flags the session before any token, identically on a datacenter
    // AND a residential exit IP (IP falsified) — the discriminator is this
    // unspoofed in-iframe fingerprint. Patch the iframe's own main world too.
    // frame.evaluate reaches a cross-origin frame's main world at the driver
    // level (same path that wins the main-frame race), re-applied at
    // navigation-commit before the captcha's scoring JS queries WebGL.
    // String probe (no compiled-fn __name shim needed): the UNMASKED renderer
    // a captcha would read. Logged only under CAPTCHA_TRACE to prove the fix.
    const RENDERER_PROBE = String.raw`(() => { try { const c = document.createElement("canvas"); const gl = c.getContext("webgl") || c.getContext("webgl2"); if (!gl) return "no-gl"; const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "no-ext"; } catch (err) { return "err:" + (err && err.message); } })()`;
    const trace = process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1";
    this.page.on("framenavigated", (frame) => {
      if (remoteMode) return; // real-GPU remote host: no in-iframe spoof
      if (this.page === null) return;
      if (frame === this.page.mainFrame()) {
        reapplyWebglSpoof();
        return;
      }
      if (!CAPTCHA_FRAME_HOST_RE.test(frame.url())) return;
      const cfHost = (() => {
        try {
          return new URL(frame.url()).host;
        } catch {
          return "captcha-frame";
        }
      })();
      void (async () => {
        if (trace) {
          const before = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          console.error(`[captcha-fp] ${cfHost} renderer BEFORE spoof: ${before}`);
        }
        // Retry until the spoof STICKS. The first framenavigated commonly
        // eval-fails (frame mid-commit, or a throwaway about:blank hCaptcha
        // replaces), and hCaptcha reads the fingerprint during its widget
        // lifecycle — a single best-effort apply loses the race. Re-apply on a
        // ~3s budget until the iframe's renderer reads Intel, so the spoof is in
        // place before the scoring read.
        let landed = false;
        for (let i = 0; i < 20 && !landed; i++) {
          await frame.evaluate(installWebglSpoofScript).catch(() => undefined);
          const r = await frame.evaluate(RENDERER_PROBE).catch(() => "eval-fail");
          if (typeof r === "string" && r.includes("Intel")) landed = true;
          else await new Promise((res) => setTimeout(res, 150));
        }
        if (trace) {
          console.error(
            `[captcha-fp] ${cfHost} renderer AFTER spoof:  ${landed ? "Intel (landed)" : "FAILED to land in budget"}`,
          );
        }
      })();
    });
    this.page.on("load", reapplyWebglSpoof);

    // rc.33 — captcha tracing. When UNIVERSAL_BOT_CAPTCHA_TRACE=1 is
    // set, log every response from Cloudflare/Google's challenge
    // endpoints plus any console message that mentions captcha-y
    // keywords. Gives us visibility into *why* a Tier-2 click times
    // out ("sat idle" vs "score-too-low" vs "follow-up issued") —
    // the parent page can't read the iframe's DOM (cross-origin) but
    // it CAN observe its network. Off by default; opt in for
    // diagnostic runs only since the bodies can be large.
    if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
      this.page.on("response", async (resp) => {
        const url = resp.url();
        if (
          !/challenges\.cloudflare\.com|google\.com\/recaptcha|hcaptcha\.com|newassets\.hcaptcha\.com/.test(
            url,
          )
        ) {
          return;
        }
        const status = resp.status();
        const ct = resp.headers()["content-type"] ?? "";
        let bodyPreview = "";
        if (
          /json|javascript|html|plain/.test(ct) ||
          /api\.hcaptcha\.com\/(?:checksiteconfig|getcaptcha|checkcaptcha)/.test(url)
        ) {
          try {
            const body = await resp.text();
            bodyPreview = body.length > 400 ? body.slice(0, 400) + "…" : body;
          } catch {
            // body may be evicted; ignore
          }
        }
        console.error(
          `[captcha-trace] ${status} ${url}${
            bodyPreview ? "\n  body: " + bodyPreview.replace(/\n/g, "\\n") : ""
          }`,
        );
      });
      this.page.on("console", (msg) => {
        const text = msg.text();
        if (!/turnstile|cloudflare|challenge|recaptcha/i.test(text)) return;
        console.error(`[captcha-trace] console.${msg.type()}: ${text}`);
      });
    }
  }

  // Probe the run's actual egress geo by loading ipinfo.io. Launches a
  // throwaway browser: the persistent context isn't up yet, and its
  // timezone has to be known before it is. The throwaway inherits the
  // same channel + proxy so it reports the real egress. Best-effort —
  // any failure returns null and start() keeps a default timezone.
  private async probeEgressGeo(
    channel: string | null,
    proxy: ProxySettings | null,
  ): Promise<EgressGeo | null> {
    if (proxy === null) {
      try {
        const resp = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return parseEgressGeo(await resp.text());
      } catch (err) {
        console.error(
          `[operator] egress geo probe failed — using default ` +
            `timezone: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }

    let probe: Browser | undefined;
    try {
      probe = await getChromium().launch({
        headless: process.env.UNIVERSAL_BOT_HEADLESS !== "false",
        ...(channel !== null ? { channel } : {}),
        ...(proxy !== null ? { proxy } : {}),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await probe.newPage();
      await page.goto("https://ipinfo.io/json", {
        timeout: 10000,
        waitUntil: "domcontentloaded",
      });
      const body = await page.evaluate(() => document.body.innerText);
      return parseEgressGeo(body);
    } catch (err) {
      console.error(
        `[operator] egress geo probe failed — using default ` +
          `timezone: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      if (probe !== undefined) await probe.close();
    }
  }

  // Decide whether this run egresses through a residential proxy, and
  // return Playwright's proxy settings or null for a direct connection.
  //
  // The fast path: when UNIVERSAL_BOT_PROXY_URL is unset (the default),
  // this returns null before doing anything — no ASN lookup, no added
  // latency for the ~80% of users who never configure a proxy.
  //
  // When a proxy IS configured, it's used only for datacenter-class
  // egress: reCAPTCHA/Cloudflare score datacenter IPs as bot-likely no
  // matter how clean the fingerprint is, while residential users
  // already pass — so routing them through the proxy would just burn
  // money. UNIVERSAL_BOT_PROXY_ALWAYS=true forces it on for networks
  // that misclassify as "unknown". A malformed URL never aborts the
  // run — we log and fall back to a direct connection.
  private async resolveProxy(): Promise<ProxySettings | null> {
    // Per-launch override (verify fleet) wins over the env-global proxy.
    const raw = this.proxyOverride ?? process.env.UNIVERSAL_BOT_PROXY_URL;
    if (raw === undefined || raw.trim().length === 0) return null;

    let proxy: ProxySettings;
    try {
      proxy = parseProxyUrl(raw);
    } catch (err) {
      console.error(
        `[operator] UNIVERSAL_BOT_PROXY_URL is malformed — running ` +
          `direct: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const forceAlways = process.env.UNIVERSAL_BOT_PROXY_ALWAYS === "true";
    // detectAsn is best-effort (5s timeout, null on failure) → "unknown".
    const asn = await detectAsn();
    const asnClass: AsnClass = asn?.class ?? "unknown";
    if (shouldRouteThroughProxy(asnClass, forceAlways)) {
      // Proxy liveness probe. A dead proxy (gost crashed, Tailscale down) makes
      // EVERY navigation time out for 60s and silently breaks the whole heal
      // pass — MEASURED 2026-06-12: the Mac gost SOCKS5 went down and every
      // discover died on page.goto Timeout. A cheap TCP connect to the SOCKS
      // host tells us it's reachable; if not, fall back to DIRECT (the box's own
      // datacenter egress) so the run still serves the services that don't block
      // datacenter IPs, instead of dying entirely. Self-healing > silent stall.
      const reachable = await isProxyReachable(proxy.server);
      if (!reachable) {
        console.error(
          `[operator] proxy ${proxy.server} is UNREACHABLE — falling back to ` +
            `DIRECT egress (datacenter IP; anti-bot services may block it, but far ` +
            `better than every navigation timing out)`,
        );
        return null;
      }
      console.error(
        `[operator] routing through residential proxy ` +
          `(asn=${asnClass}${forceAlways ? ", forced" : ""})`,
      );
      return proxy;
    }
    console.error(
      `[operator] direct connection (asn=${asnClass}) — proxy ` +
        `configured but not needed for this network`,
    );
    return null;
  }

  // Reload the current page. Used by the post-verify flow to make a SPA
  // re-read a server-side state change (email verified) that the client
  // hasn't picked up yet. Best-effort: a reload failure is non-fatal — the
  // caller re-reads the page state regardless.
  async reload(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed (slow SPA / transient) — caller re-inspects anyway
    }
  }

  // Open the first conversation in a Gmail search-results list so the email
  // BODY renders. The results LIST only carries snippets + Gmail chrome links —
  // a magic/verification LINK lives in the body and is absent until the mail is
  // opened, so await_verification could never read it from the list. Best-effort:
  // returns true if a conversation opened (URL hash gained a message id).
  // MEASURED 2026-07-01 (Loops "Login link": list view had no /api/auth/callback
  // href; opening the mail revealed it).
  async openFirstMailResult(): Promise<boolean> {
    if (!this.page) return false;
    const before = this.page.url();
    // Find the conversation ROW the same way the observation layer does — a
    // role=link element with a substantial subject label (Gmail chrome
    // affordances like "Gmail"/"Compose"/"Inbox" are short or not role=link) —
    // and open it with this.click(), the SAME positional click that works
    // interactively. The prior CSS-selector + synthetic .click() missed: Gmail
    // rows are div[role=link] whose delegated jsaction handler a plain click may
    // not fire. MEASURED 2026-07-01 (Loops "Login link": the results list has no
    // /api/auth/callback href; opening the row reveals it).
    const els = await this.extractInteractiveElements();
    const row = els.find(
      (e) =>
        e.role === "link" && (e.visibleText ?? e.ariaLabel ?? e.labelText ?? "").trim().length > 25,
    );
    if (row === undefined) return false;
    await this.click(row.selector).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const now = this.page.url();
      // An opened conversation appends a message id to the #search/#inbox hash.
      if (now !== before && /\/[A-Za-z0-9_-]{12,}$/.test(now)) return true;
      await this.page.waitForTimeout(300).catch(() => {});
    }
    return false;
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Retry transient network/proxy drops. A residential SOCKS tunnel
    // intermittently resets a connection mid-navigation (Chrome surfaces
    // net::ERR_SOCKS_CONNECTION_FAILED / ERR_CONNECTION_RESET / ERR_NETWORK_
    // CHANGED / ERR_TIMED_OUT), especially on heavy onboarding pages that
    // open many subresource connections at once (algolia's dashboard_setup).
    // The host is reachable on the next attempt — a single goto failure
    // shouldn't fail the whole signup. Only retry these connection-level
    // errors; HTTP statuses and selector/logic errors fall straight through.
    // net::ERR_ABORTED — a navigation superseded by a redirect/JS-nav during
    // the domcontentloaded wait. Usually transient (a redirect race on the
    // first hit of an auth-gated portal — MEASURED 2026-06-11: defang's
    // portal.defang.io aborted on the initial goto); a retry lands the
    // settled page. Distinct from ERR_CONNECTION_ABORTED (a dropped socket).
    const TRANSIENT_NET =
      /ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_(?:RESET|CLOSED|FAILED|ABORTED)|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|net::ERR_EMPTY_RESPONSE|net::ERR_ABORTED/i;
    const MAX_GOTO_ATTEMPTS = 3;
    const sameOriginPathAndSearch = (a: string, b: string): boolean => {
      try {
        const left = new URL(a);
        const right = new URL(b);
        return (
          left.origin === right.origin &&
          left.pathname === right.pathname &&
          left.search === right.search
        );
      } catch {
        return false;
      }
    };
    const landedAuthGateForTarget = (landedRaw: string, targetRaw: string): boolean => {
      try {
        const landed = new URL(landedRaw);
        const target = new URL(targetRaw);
        if (landed.origin !== target.origin) return false;
        return /\/(?:sign[_-]?in|login|log[_-]?in|auth)(?:\/|$)/i.test(landed.pathname);
      } catch {
        return false;
      }
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        // A SOCKS/connection drop does NOT always throw: Chrome resolves
        // domcontentloaded on its own `chrome-error://chromewebdata/`
        // interstitial and goto returns cleanly. The bot then ran the whole
        // planner on a dead error page and gave up after one round (MEASURED
        // 2026-06-11: galileo/lancedb landed on chrome-error with the app
        // host as the title, never retried). Treat a chrome-error landing as
        // the same transient class and retry it like a thrown net error.
        const landed = this.page.url();
        if (landed.startsWith("chrome-error://")) {
          if (attempt >= MAX_GOTO_ATTEMPTS) {
            throw new Error(
              `net::navigation landed on a Chrome error page for ${url} ` +
                `after ${attempt} attempts (transient proxy/host failure)`,
            );
          }
          await this.sleep(1500 * attempt);
          continue;
        }
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Some client-routed apps commit the address bar to the requested SPA
        // route but never fire the lifecycle event Playwright is waiting for.
        // Treat that as a successful navigation: callers immediately inspect
        // the DOM and have their own element-level waits.
        if (/Timeout \d+ms exceeded/i.test(msg)) {
          await this.sleep(500);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
          await this.page
            .waitForURL((landed) => sameOriginPathAndSearch(landed.toString(), url), {
              timeout: 5000,
            })
            .then(() => undefined)
            .catch(() => undefined);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
        }
        if (attempt >= MAX_GOTO_ATTEMPTS || !TRANSIENT_NET.test(msg)) throw err;
        // Linear backoff — give the tunnel a moment to recover a slot.
        await this.sleep(1500 * attempt);
      }
    }
    // Post-load dwell. Cloudflare/reCAPTCHA scoring runs JS that
    // collects behavior signals over a window (typically 500-2000ms);
    // landing on a page and immediately interacting reads as bot-like.
    // The "dwell" gives the scoring window enough wall-clock to settle
    // and also gives any deferred JS time to register event listeners
    // we'll later fire.
    if (this.humanize) {
      await this.sleep(rand(800, 2000));
    }
  }

  // Pre-warm a domain by visiting its root. Useful before navigating
  // to a deep signup URL on a strict-Cloudflare service: the root sets
  // first-party cookies and lets the bot-scoring JS calibrate on a
  // benign page before we hit anything sensitive.
  //
  // `mode`:
  //   - "fast" (default): visit the root, dwell ~2s, jitter the mouse,
  //     done. Cheap and adequate when the domain has been warmed
  //     recently (cookies already in jar, prior session in the
  //     scoring JS's memory).
  //   - "referrer-chain": simulate a research session — Google search
  //     → click the brand result → scroll the marketing site →
  //     navigate. ~20-40s of wall clock, but builds a realistic
  //     browsing-history signal that v3 weighs heavily. Use this on
  //     first-attempt against strict services and after a captcha
  //     failure.
  async prewarm(url: string, mode: "fast" | "referrer-chain" = "fast"): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    if (mode === "referrer-chain") {
      await this.prewarmViaReferrerChain(url);
      return;
    }
    const root = new URL(url).origin;
    await this.page.goto(root, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (this.humanize) {
      await this.sleep(rand(1200, 2500));
      // Tiny mouse jitter so cf_clearance JS sees pointer activity.
      await this.jitterMouse();
    }
  }

  // Simulates a research session that ends at the signup target.
  //
  // Why this is more than theater: reCAPTCHA v3 reads a "browsing
  // history" signal that aggregates referrer + dwell + interaction
  // across the prior 1-2 page loads in this context. A cold landing on
  // `/sign_up` has none of that — score gets clamped near 0.3, which
  // is the kill-floor for most v3-protected forms. A simulated
  // Google → result-click → marketing-site → /sign_up chain lifts the
  // score to 0.5-0.7 range, which is where real users sit.
  //
  // Best-effort throughout: if any step fails (Google rate-limits us,
  // the brand's marketing site is down, etc.) we degrade to the fast
  // prewarm rather than aborting the whole signup. Network surprises
  // are common; the bot still works without this lift, just worse.
  private async prewarmViaReferrerChain(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const targetOrigin = new URL(url).origin;
    // Strip "www." for the search query so "postmarkapp.com" becomes
    // "postmarkapp" not "www postmarkapp"; reads more like what a
    // human types into a search box.
    const brand = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(brand + " sign up")}`;

    try {
      await this.page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (this.humanize) await this.sleep(rand(2000, 4000));
      // Look for a result link pointing at the target origin. Google
      // wraps result hrefs but exposes the real destination as a child
      // attribute or via the `href` itself for organic results — we
      // grab whichever link's href starts with the target origin.
      // Google SERPs often expose several anchors to the same origin
      // (the organic result, "People also ask" related links, sitelinks
      // like /pricing). Scope to the first match so Playwright's strict
      // mode doesn't throw before we get to click.
      const resultLocator = this.page.locator(`a[href^="${targetOrigin}"]`).first();
      const hasResult = (await resultLocator.count()) > 0;
      if (hasResult) {
        // Use humanClick if available — moves the mouse along a bezier
        // path to the link, which feeds the scoring JS pointer entropy
        // as a side effect.
        if (this.humanize) {
          await this.humanClickLocator(resultLocator);
        } else {
          await resultLocator.click();
        }
        await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
      } else {
        // Couldn't find an organic result (Google sometimes interposes
        // an ad or "people also ask" block first). Navigate directly
        // and accept that the referrer chain is shorter but still
        // includes the search.
        await this.page.goto(targetOrigin, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      // Marketing-site dwell: scroll a bit, pause, scroll back. The
      // scroll events plus the wall clock build up the "this user is
      // reading" signal. Magnitude is intentionally small — overshooting
      // (scrolling to the bottom in 200ms, etc.) is itself bot-like.
      if (this.humanize) {
        await this.sleep(rand(1500, 3500));
        await this.page.mouse.wheel(0, rand(200, 500));
        await this.sleep(rand(800, 2000));
        await this.page.mouse.wheel(0, rand(-200, 0));
        await this.sleep(rand(1000, 2500));
        await this.jitterMouse();
      }
    } catch (err) {
      // Any step in the chain failing leaves us at *some* page (the
      // search results, the marketing site, an error page) — that's
      // still better than a cold landing on /sign_up. Log and proceed.
      console.error(
        `[operator] referrer-chain prewarm partial failure (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Wait for element to be visible and enabled before typing.
    await this.page.waitForSelector(selector, { state: "visible", timeout: 10000 });

    if (!this.humanize) {
      // Fast path for tests / non-humanized runs.
      await this.page.fill(selector, text);
      return;
    }

    // Humanized typing:
    //   - Click into the field first (moves mouse, generates focus event)
    //   - pressSequentially focuses ONCE and types each char with a
    //     per-key delay. Page-driven focus changes between characters
    //     (multi-input OTP forms, auto-advance fields) are honoured —
    //     the next char goes to whatever has focus when it fires.
    //
    // page.fill() bypasses keydown/keypress/input events entirely — it
    // sets value via JS. That's a giant red flag to behavior scoring.
    // pressSequentially emits real key events so the page sees a normal
    // typing pattern.
    //
    // rc.29 — the prior implementation looped `locator.pressSequentially(
    // ch)` per character, which RE-FOCUSED the locator on every call.
    // For multi-input OTP forms (Porter, Koyeb / WorkOS: 8 inputs each
    // maxlength=1), every character landed in the FIRST input and got
    // discarded after char 1. Switching to a single pressSequentially
    // call lets the browser's auto-advance handler move focus naturally.
    await this.humanClick(selector);
    const locator = this.page.locator(selector);
    // Clear any prefilled value before typing. Only meaningful for
    // single-input fields; multi-input OTP forms ignore this since
    // each box is its own input.
    await locator.fill("").catch(() => {});
    // Per-key delay matches the prior bursty distribution. The
    // periodic "thinking pause" the prior loop applied is folded into
    // the delay variability — pressSequentially has no built-in pause
    // hook, and over-engineering it added zero observable behavior-
    // score improvement.
    await locator.pressSequentially(text, { delay: rand(40, 110) });
  }

  // Best-effort scan for the SPECIFIC unfilled required field(s) blocking a
  // disabled submit. Returns a " Unfilled required field(s) — …" suffix for the
  // disabled-click error so the planner fills the right field instead of
  // re-clicking the dead button. Pure observation — never throws, never mutates.
  private async unfilledRequiredHint(): Promise<string> {
    if (!this.page) return "";
    try {
      const fields = await this.page.evaluate(() => {
        const out: string[] = [];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const label = (el: Element): string => {
          const al = el.getAttribute("aria-label");
          if (al && al.trim()) return al.trim().slice(0, 40);
          const id = (el as HTMLElement).id;
          if (id) {
            const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
            const lab = document.querySelector(`label[for="${esc}"]`);
            if (lab && lab.textContent && lab.textContent.trim())
              return lab.textContent.trim().slice(0, 40);
          }
          const ph = el.getAttribute("placeholder");
          if (ph && ph.trim()) return ph.trim().slice(0, 40);
          return (el.getAttribute("name") ?? el.tagName.toLowerCase()).slice(0, 40);
        };
        for (const el of Array.from(
          document.querySelectorAll(
            "input[required],textarea[required],input[aria-required='true'],textarea[aria-required='true']",
          ),
        )) {
          if (!vis(el)) continue;
          const inp = el as HTMLInputElement;
          if (inp.type === "checkbox" || inp.type === "radio") {
            if (!inp.checked) out.push(`unchecked: ${label(el)}`);
          } else if (!inp.value || !inp.value.trim()) {
            out.push(`empty: ${label(el)}`);
          }
        }
        for (const el of Array.from(document.querySelectorAll("select"))) {
          if (vis(el) && !(el as HTMLSelectElement).value) out.push(`unselected: ${label(el)}`);
        }
        for (const el of Array.from(
          document.querySelectorAll("[role='combobox'],[role='listbox']"),
        )) {
          if (!vis(el)) continue;
          const txt = (el.textContent ?? "").trim();
          if (txt.length === 0 || /^(select|choose|please|pick)\b/i.test(txt))
            out.push(`unselected: ${label(el)}`);
        }
        for (const grp of Array.from(document.querySelectorAll("[role='radiogroup']"))) {
          if (!vis(grp)) continue;
          const chosen = grp.querySelector(
            "[role='radio'][aria-checked='true'],input[type='radio']:checked",
          );
          if (!chosen) out.push(`nothing chosen: ${label(grp)}`);
        }
        return Array.from(new Set(out)).slice(0, 5);
      });
      return fields.length > 0
        ? ` Unfilled required field(s) — fill/select these first: ${fields.join("; ")}.`
        : "";
    } catch {
      return "";
    }
  }

  // Read any visible transient toast / alert / notification text. Validation
  // errors, rate-limits, and "operation failed" messages frequently appear as a
  // toast that auto-dismisses BEFORE the next round's capture — so a failed
  // submit looks like a SILENT no-op to the planner. Surfacing it turns the
  // no-op into a diagnosable reason. MEASURED 2026-06-11 (deepseek Sign-up
  // no-ops; the error is a ds-toast the round-start capture never sees).
  // `settleMs` lets the caller reuse a wait it was already going to do.
  async captureTransientAlert(settleMs = 600): Promise<string> {
    if (!this.page) return "";
    if (settleMs > 0) await this.sleep(settleMs);
    try {
      return await this.page.evaluate(() => {
        const sels = [
          "[role='alert']",
          "[aria-live='assertive']",
          ".ds-toast-container",
          ".ds-notification-container",
          ".Toastify__toast",
          ".ant-message-notice",
          ".ant-notification-notice",
          ".sonner-toast",
          "[data-sonner-toast]",
          ".toast",
          ".Toaster",
        ];
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 2 && t.length <= 240) return t;
          }
        }
        // Second pass: INLINE field-validation errors (not a transient
        // toast). Many SPAs render "Please enter the verification code" /
        // "Invalid code" as a small element with an error-ish class or an
        // aria-invalid node rather than a toast — so the first pass misses
        // them and a failed submit reads as a silent no-op.
        // MEASURED 2026-06-11 (deepseek post-OTP submit).
        const errSels = [
          "[class*='error' i]",
          "[class*='invalid' i]",
          "[class*='danger' i]",
          "[class*='explain' i]", // antd/ds-form-item-explain
          "[aria-invalid='true']",
        ];
        for (const sel of errSels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!vis(el)) continue;
            // Leaf-ish only — skip containers that wrap the whole form.
            if (el.querySelector("input, button, form")) continue;
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            if (t.length >= 3 && t.length <= 160) return t;
          }
        }
        return "";
      });
    } catch {
      return "";
    }
  }

  // Attach a LOCAL file without driving the OS file dialog. If `selector`
  // resolves to an <input type=file>, set the file on it directly — this works
  // even when the input is visually hidden, which most upload widgets are.
  // Otherwise treat `selector` as the visible trigger (button / menu item /
  // styled label): clicking it opens a file chooser, which Playwright intercepts
  // so the native dialog is never touched. This is how the operator uploads
  // (Drive, S3 consoles, any web form) through the session the user is already
  // signed into — no API credential, no password. Bounded by the session's
  // domain scope, so a file can only reach the site the task is already on.
  async uploadFile(selector: string, filePath: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`upload: local file not found or not a regular file: ${filePath}`);
    }
    const page = this.page;
    const locator = page.locator(selector).first();
    const isFileInput = await locator
      .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
      .catch(() => false);
    if (isFileInput) {
      await locator.setInputFiles(filePath);
      return;
    }
    // Register the chooser waiter BEFORE the click so the event can't be missed.
    // The catch must attach at creation, not after the click resolves: the click
    // actionability-waits up to 30s (e.g. an occluded button), so the waiter's
    // 15s timeout can reject while the click is still pending — a bare rejection
    // here is an unhandledRejection that kills the whole MCP server process.
    const chooserPromise: Promise<FileChooser | null> = page
      .waitForEvent("filechooser", { timeout: 15_000 })
      .then((c): FileChooser | null => c)
      .catch((): null => null);
    await locator.click();
    const chooser = await chooserPromise;
    if (chooser === null) {
      throw new Error(
        `upload: clicking "${selector}" did not open a file picker within 15s. ` +
          `Target the upload button (or the file <input>) and retry.`,
      );
    }
    await chooser.setFiles(filePath);
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Radio/checkbox inputs — especially the visually-hidden kind behind a
    // styled label (kinde's `kui-util-hide-visually` SDK-picker radios) — don't
    // respond to a positional click: Playwright can't click an invisible
    // element, and even a label click may not fire the `change` handler a gated
    // control depends on (kinde's radio `kui-on-change` enables the otherwise-
    // disabled Next button). Playwright's check() toggles the control AND
    // dispatches input/change; `force` bypasses the visibility actionability
    // gate for the sr-only pattern. MEASURED 2026-06-09 (kinde tech-stack step).
    try {
      const probe = await this.page
        .$eval(selector, (el) => {
          const t = el as HTMLInputElement;
          const inputKind =
            t.tagName === "INPUT" && (t.type === "radio" || t.type === "checkbox") ? t.type : "";
          // The planner's selector often resolves to a CHILD of the real option
          // (the inner <span> with the visible text, or a positional wrapper), not
          // the role=option element itself. Walk up to the nearest combobox-option
          // ancestor so the role-based re-resolution below fires. cmdk items carry
          // role=option but the `[cmdk-item]` attribute is the most stable tell.
          // MEASURED 2026-06-16 (meilisearch /welcome-informations cmdk multi-
          // select): a plain getByRole("option",{name}).click() COMMITS the value
          // — the trigger updates + Next un-gates — but only when we target the
          // option element, not its child span (which a raw coordinate click drops).
          const optEl = el.closest(
            '[role="option"],[role="menuitem"],[role="menuitemradio"],[cmdk-item]',
          );
          const optRole = optEl !== null ? (optEl.getAttribute("role") ?? "option") : "";
          const optText = optEl !== null ? (optEl.textContent ?? "").trim().slice(0, 80) : "";
          return {
            inputKind,
            role: el.getAttribute("role") ?? "",
            text: (el.textContent ?? "").trim().slice(0, 80),
            optRole,
            optText,
          };
        })
        .catch(() => ({ inputKind: "", role: "", text: "", optRole: "", optText: "" }));
      const inputKind = probe.inputKind;
      // Custom-combobox / listbox options (role=option|menuitem) — react-select,
      // Radix, downshift, cmdk, MUI. Two failure modes the humanized RAW-COORDINATE
      // click hits: (1) the menu is a PORTAL that re-renders/repositions, so the
      // captured POSITIONAL selector (e.g. `div…>> nth=42`) resolves to the wrong
      // element at click time — nothing selects, planner loops (MEASURED
      // 2026-06-11, meilisearch Radix combobox); (2) options bind pointer/select
      // handlers a raw coordinate click misses. Fix: re-resolve by role+accessible
      // name (robust to portal/positional drift + the planner targeting a child),
      // and use the actionability-checked locator click. Options are post-load,
      // NOT the anti-bot-scored gate.
      const optRole =
        probe.role === "option" || probe.role === "menuitem" || probe.role === "menuitemradio"
          ? probe.role
          : probe.optRole === "option" ||
              probe.optRole === "menuitem" ||
              probe.optRole === "menuitemradio"
            ? probe.optRole
            : "";
      const optName = probe.role !== "" ? probe.text : probe.optText;
      if (optRole !== "") {
        const role = optRole as "option" | "menuitem" | "menuitemradio";
        if (optName.length > 0) {
          const byName = this.page.getByRole(role, { name: optName, exact: false }).first();
          if ((await byName.count().catch(() => 0)) > 0) {
            await byName.click({ timeout: 8000 });
            return;
          }
        }
        await this.page.locator(selector).first().click({ timeout: 8000 });
        return;
      }
      if (inputKind === "radio" || inputKind === "checkbox") {
        // check() handles standard inputs; but a custom framework (kinde's kui)
        // binds its change handler via event delegation, and a force-check on an
        // sr-only radio may not fire a bubbling change. Belt-and-suspenders:
        // check(), then JS-ensure checked + dispatch bubbling input/change so the
        // delegated handler (e.g. enable-the-gated-Next-button) fires AND the
        // value is included on submit. MEASURED 2026-06-09 (kinde SDK picker).
        await this.page.check(selector, { force: true }).catch(() => undefined);
        await this.page
          .$eval(selector, (el) => {
            const r = el as HTMLInputElement;
            if (!r.checked) r.checked = true;
            r.dispatchEvent(new Event("input", { bubbles: true }));
            r.dispatchEvent(new Event("change", { bubbles: true }));
            r.dispatchEvent(new Event("click", { bubbles: true }));
          })
          .catch(() => undefined);
        return;
      }
      // ARIA toggle: a <button role="switch"> / role="checkbox" (Firebase's
      // Google-provider "Enable" switch, MUI/Material toggles). A synthetic
      // positional click frequently does NOT flip these — the handler binds to a
      // keydown/pointer sequence the raw click misses, so click() returns but
      // aria-checked never changes. The ARIA-correct activation is the keyboard:
      // focus + Space. Click first (cheap); if aria-checked didn't move, focus
      // and press Space. MEASURED 2026-06-27 (Firebase auth Enable switch).
      if (probe.role === "switch" || probe.role === "checkbox") {
        const node = this.page.locator(selector).first();
        const readChecked = (): Promise<string | null> =>
          node.getAttribute("aria-checked").catch(() => null);
        const before = await readChecked();
        await node.click({ timeout: 8000 }).catch(() => undefined);
        if ((await readChecked()) === before) {
          await node.focus().catch(() => undefined);
          await this.page.keyboard.press("Space").catch(() => undefined);
          if ((await readChecked()) === before) {
            await this.page.keyboard.press("Enter").catch(() => undefined);
          }
        }
        return;
      }
    } catch {
      // element vanished / selector didn't resolve — fall through to a click
    }
    if (!this.humanize) {
      await this.page.click(selector);
      return;
    }
    await this.humanClick(selector);
  }

  // Force-click bypasses Playwright's actionability + interception checks — for a
  // button that is visible / enabled / stable but whose pointer events are eaten
  // by a modal-dialog backdrop layered over it (MUI `<div class="MuiDialog-
  // container">`, e.g. deepinfra's new-API-key dialog). A normal click() there
  // times out with "intercepts pointer events"; force dispatches at the element.
  async clickForce(selector: string, index = 0): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const safeIndex = Math.max(0, Math.floor(index));
    await this.page.locator(selector).nth(safeIndex).click({ force: true, timeout: 8000 });
  }

  // Resolve a locator-form operate_act target (`text=…` / `css=…`) DIRECTLY
  // against a live page/frame document, bypassing the extracted-inventory list.
  // This is the escape hatch for a control the inventory never emitted: a bare
  // click-handler <div> with no role/label/testid that the SELECTOR walk skips,
  // or a typeable control missing from the inventory. The card scan can also
  // drop a control once its MAX_CARDS budget is spent on earlier cursor:pointer
  // divs (Casetify's Add-To-Cart is element #45 of the eligible cards; the cap is
  // 16). With no ref, `text=`/`css=` is the only host-addressable target.
  //
  // Resolution rules (kept deliberately strict so the action can't land on the
  // wrong element):
  //   • text mode — matches an element whose rendered text (innerText, so hidden
  //     descendants don't leak) equals (or, if nothing equals, contains) the
  //     query AND that carries a real click affordance (button/a/label/select
  //     tag, an interactive ARIA role, an onclick / action-type attribute, or
  //     cursor:pointer). Plain prose that merely contains the words is excluded.
  //     Open shadow roots are pierced.
  //   • css mode — the author's selector, restricted to VISIBLE matches.
  //   • A weak (cursor-only) descendant inside a strong control collapses away;
  //     weak ancestors and two GENUINE nested controls stay ambiguous rather
  //     than being silently merged.
  //   • 0 matches → {ok:false, reason:"none"}; >1 → {ok:false, reason:"ambiguous"}
  //     with the candidate texts so the host can disambiguate. Exactly 1 returns
  //     a live ElementHandle to the winner. The caller acts through the handle
  //     (never a DOM-visible marker), so a page MutationObserver cannot re-aim
  //     the action at a decoy between resolution and dispatch, and disposes it
  //     after.
  private async resolveTargetInContext(
    ctx: Page | Frame,
    mode: "text" | "css",
    value: string,
    intent: "click" | "type",
  ): Promise<
    | {
        ok: true;
        handle: ElementHandle<Element>;
        text: string;
        labels: string[];
        safetySignals: PageTargetSafetySignals;
        documentOrigin: string;
      }
    | { ok: false; reason: "none" | "ambiguous"; candidates: string[] }
  > {
    if (!this.page) throw new Error("Browser not started");
    const resultHandle = await ctx.evaluateHandle(
      ({ mode, value, intent }) => {
        const norm = (s: string | null): string =>
          (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        // Rendered text, NOT textContent: innerText reflects what the user
        // actually sees, excluding display:none / visibility:hidden descendants.
        // Matching on textContent let a visible "Cancel" button that hides a
        // "Delete account" span be selected by text="Delete account" (codex).
        // Display form: whitespace-collapsed but ORIGINAL case (for the trace /
        // audit / candidate list). `rendered` lowercases it for matching only.
        const renderedRaw = (el: Element): string => {
          const it = (el as HTMLElement).innerText;
          return (typeof it === "string" ? it : (el.textContent ?? "")).replace(/\s+/g, " ").trim();
        };
        const rendered = (el: Element): string => renderedRaw(el).toLowerCase();
        const safetyMetadata = (value: string | null): string =>
          (value ?? "")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_.\/-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const safetySignalsFor = (el: Element): PageTargetSafetySignals => {
          const safetyText = [
            renderedRaw(el),
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.getAttribute("alt"),
            el.getAttribute("action-type"),
            el.getAttribute("name"),
            el.getAttribute("id"),
            el.getAttribute("value"),
          ]
            .map((part) => safetyMetadata(part))
            .filter((part) => part.length > 0)
            .join(" ");
          // Keep these predicates in sync with isBillingObjectActionTarget and
          // isAccountSetupActionTarget in provision-session.ts.
          return {
            billingObject:
              /\b(create|save|add|finish)\b/i.test(safetyText) &&
              /\b(product|price|pricing|subscription|billing|payment|invoice|checkout)\b/i.test(
                safetyText,
              ),
            accountSetup:
              /\b(?:create|finish|complete|set up|setup)\s+(?:your\s+)?(?:account|profile|organization|workspace|business)\b/i.test(
                safetyText,
              ),
          };
        };
        // Visibility walks the ANCESTOR chain (crossing shadow-host boundaries):
        // opacity does not inherit, so a button under an opacity:0 wrapper keeps
        // its own computed opacity 1 and a self-only check would wrongly treat it
        // as visible and click an invisible control (codex).
        const isVisible = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          let node: Element | null = el;
          while (node !== null) {
            const s = window.getComputedStyle(node);
            if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")
              return false;
            const parentEl: Element | null = node.parentElement;
            if (parentEl !== null) {
              node = parentEl;
            } else {
              const root = node.getRootNode();
              node = root instanceof ShadowRoot ? root.host : null;
            }
          }
          return true;
        };
        // "Strong" = real interactive semantics (a genuine control), as opposed
        // to an element that merely inherits cursor:pointer from a clickable
        // ancestor (a decorative wrapper / inner label span).
        const isStrong = (el: Element): boolean => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          if (
            tag === "button" ||
            tag === "a" ||
            tag === "label" ||
            tag === "select" ||
            tag === "summary"
          )
            return true;
          if (
            role === "button" ||
            role === "link" ||
            role === "radio" ||
            role === "checkbox" ||
            role === "menuitem" ||
            role === "menuitemradio" ||
            role === "option" ||
            role === "tab" ||
            role === "switch"
          )
            return true;
          return el.hasAttribute("onclick") || el.hasAttribute("action-type");
        };
        const hasClickAffordance = (el: Element): boolean =>
          isStrong(el) || window.getComputedStyle(el).cursor === "pointer";
        const hasTypeAffordance = (el: Element): boolean =>
          (el instanceof HTMLInputElement && el.type !== "hidden" && !el.disabled) ||
          (el instanceof HTMLTextAreaElement && !el.disabled) ||
          (el instanceof HTMLElement && el.isContentEditable);
        const typeLabel = (el: Element): string => {
          const labels =
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? Array.from(el.labels ?? []).map((label) => renderedRaw(label))
              : [];
          return [
            ...labels,
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("placeholder") ?? "",
            el.getAttribute("name") ?? "",
            el.getAttribute("id") ?? "",
            renderedRaw(el),
          ]
            .filter((part) => part.length > 0)
            .join(" ");
        };
        const effectiveLabels = (el: Element): string[] =>
          Array.from(
            new Set(
              [
                el.getAttribute("aria-label") ?? "",
                el instanceof HTMLInputElement ? el.value : "",
                renderedRaw(el),
              ]
                .map((part) => part.replace(/\s+/g, " ").trim())
                .filter((part) => part.length > 0),
            ),
          );

        // Gather candidates across the light DOM and every OPEN shadow root.
        const all: Element[] = [];
        const collect = (root: Document | ShadowRoot): void => {
          if (root == null || typeof root.querySelectorAll !== "function") return;
          let nodes: Element[] = [];
          if (mode === "css") {
            try {
              nodes = Array.from(root.querySelectorAll(value));
            } catch {
              nodes = [];
            }
          } else {
            nodes = Array.from(root.querySelectorAll("*"));
          }
          for (const n of nodes) all.push(n);
          for (const el of Array.from(root.querySelectorAll("*"))) {
            const sr = (el as HTMLElement).shadowRoot;
            if (sr != null) collect(sr);
          }
        };
        collect(document);

        let pool: Element[];
        if (mode === "css") {
          pool = all.filter((el) => isVisible(el) && (intent === "click" || hasTypeAffordance(el)));
        } else {
          const want = norm(value);
          if (want.length === 0) {
            return {
              element: null,
              count: 0,
              candidates: [] as string[],
              text: "",
              labels: [] as string[],
              safetySignals: { billingObject: false, accountSetup: false },
              documentOrigin: location.origin,
            };
          }
          const affordable = all.filter(
            (el) =>
              isVisible(el) &&
              (intent === "click" ? hasClickAffordance(el) : hasTypeAffordance(el)),
          );
          const matchText = (el: Element): string =>
            intent === "click" ? rendered(el) : norm(typeLabel(el));
          const exact = affordable.filter((el) => matchText(el) === want);
          // Prefer exact-text matches; only fall back to "contains" (with a
          // length guard so a big wrapper doesn't swallow the query) when no
          // element's rendered text equals the query.
          pool =
            exact.length > 0
              ? exact
              : affordable.filter((el) => {
                  const t = matchText(el);
                  return t.includes(want) && t.length <= Math.max(80, want.length + 20);
                });
        }
        // Bound the O(n²) nesting-collapse below: a broad selector (css=* /
        // css=div) can match thousands of nodes, and a pairwise `contains` scan
        // over all of them would block the page for seconds. A pool this large
        // is ambiguous by any measure (the caller wants exactly one), so
        // short-circuit to ambiguous before the quadratic pass (no-mistakes review).
        const AMBIGUOUS_POOL_CAP = 40;
        if (pool.length > AMBIGUOUS_POOL_CAP) {
          return {
            element: null,
            count: pool.length,
            candidates: pool.slice(0, 8).map((el) => renderedRaw(el).slice(0, 60)),
            text: "",
            labels: [] as string[],
            safetySignals: { billingObject: false, accountSetup: false },
            documentOrigin: location.origin,
          };
        }
        // Collapse nesting WITHOUT silently merging two genuine controls. A
        // STRONG candidate (real interactive semantics) always survives. A WEAK
        // candidate (only inherits cursor:pointer — a decorative wrapper or the
        // inner label span of a real control) is dropped only when it sits
        // inside a strong candidate (it's part of that control's subtree, e.g.
        // Casetify's <span> inside the button <div>). Two WEAK candidates in a
        // nesting relationship — each a bare click-handler div with its own
        // listener — are NOT collapsed:
        // dropping the outer would pick the inner, whose click bubbles to the
        // outer and fires BOTH handlers (a double add-to-cart). They both
        // survive → reported ambiguous rather than silently double-clicked (codex).
        const leaves = pool.filter((el) => {
          if (isStrong(el)) return true;
          for (const other of pool) {
            if (other === el) continue;
            if (other.contains(el) && isStrong(other)) return false;
          }
          return true;
        });
        const uniq = Array.from(new Set(leaves));
        const candidates = uniq.slice(0, 8).map((el) => renderedRaw(el).slice(0, 60));
        const win = uniq.length === 1 ? (uniq[0] as HTMLElement) : null;
        return {
          element: win,
          count: uniq.length,
          candidates,
          text: win !== null ? renderedRaw(win).slice(0, 120) : "",
          labels: win !== null ? effectiveLabels(win) : [],
          safetySignals:
            win !== null ? safetySignalsFor(win) : { billingObject: false, accountSetup: false },
          documentOrigin: location.origin,
        };
      },
      { mode, value, intent },
    );
    const meta = await resultHandle.evaluate((r) => ({
      count: r.count,
      candidates: r.candidates,
      text: r.text,
      labels: r.labels,
      safetySignals: r.safetySignals,
      documentOrigin: r.documentOrigin,
    }));
    if (meta.count !== 1) {
      await resultHandle.dispose();
      return {
        ok: false,
        reason: meta.count === 0 ? "none" : "ambiguous",
        candidates: meta.candidates,
      };
    }
    // Pull out a live ElementHandle to the winning node; dispose the wrapper.
    const winHandle = await resultHandle.evaluateHandle((r) => r.element);
    await resultHandle.dispose();
    const asElement = winHandle.asElement();
    if (asElement === null) {
      await winHandle.dispose();
      return { ok: false, reason: "none", candidates: meta.candidates };
    }
    return {
      ok: true,
      handle: asElement,
      text: meta.text ?? "",
      labels: meta.labels ?? [],
      safetySignals: meta.safetySignals ?? { billingObject: false, accountSetup: false },
      documentOrigin: meta.documentOrigin,
    };
  }

  async resolvePageTarget(
    mode: "text" | "css",
    value: string,
    intent: "click" | "type" = "click",
  ): Promise<ResolvedPageTarget> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const matches: Array<{
      handle: ElementHandle<Element>;
      text: string;
      labels: string[];
      safetySignals: PageTargetSafetySignals;
      frameTarget: FrameTarget | null;
    }> = [];
    const candidates: string[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const rawUrl = frame.url();
      if (frame !== page.mainFrame() && this.frameWithinCaptcha(frame)) continue;
      const resolved = await this.resolveTargetInContext(frame, mode, value, intent).catch(
        () => null,
      );
      if (resolved === null) continue;
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") candidates.push(...resolved.candidates);
        continue;
      }
      let frameTarget: FrameTarget | null = null;
      if (frame !== page.mainFrame()) {
        try {
          const security = await this.frameSecurity(frame);
          frameTarget = {
            framePath: this.framePath(frame),
            frameOrigin: security.origin,
            frameUrl: rawUrl,
            ...(security.opaque ? { frameOpaque: true } : {}),
          };
        } catch {
          await resolved.handle.dispose().catch(() => undefined);
          continue;
        }
      }
      matches.push({ ...resolved, frameTarget });
      candidates.push(resolved.text);
    }
    if (matches.length !== 1 || candidates.length > 1) {
      await Promise.all(matches.map((match) => match.handle.dispose().catch(() => undefined)));
      return {
        ok: false,
        reason: candidates.length === 0 ? "none" : "ambiguous",
        candidates: candidates.slice(0, 8),
      };
    }
    return { ok: true, ...matches[0]! };
  }

  private async locatorClickState(
    handle: ElementHandle<Element>,
  ): Promise<"detached" | "disabled" | "ok"> {
    return await handle.evaluate((el) => {
      if (!el.isConnected) return "detached";
      if (typeof el.matches === "function" && el.matches(":disabled")) return "disabled";
      let n: Element | null = el;
      while (n !== null) {
        if (n.getAttribute("aria-disabled") === "true") return "disabled";
        const parentEl: Element | null = n.parentElement;
        if (parentEl !== null) {
          n = parentEl;
        } else {
          const root = n.getRootNode();
          n = root instanceof ShadowRoot ? root.host : null;
        }
      }
      return "ok";
    });
  }

  async clickHandle(handle: ElementHandle<Element>): Promise<void> {
    const state = await this.locatorClickState(handle);
    if (state === "detached") {
      throw new Error("locator target detached from the page before the click");
    }
    if (state === "disabled") {
      throw new Error("locator target is disabled");
    }
    await handle.click({ timeout: 8000, noWaitAfter: true });
  }

  async jsClickHandle(handle: ElementHandle<Element>): Promise<void> {
    const state = await this.locatorClickState(handle);
    if (state === "detached") {
      throw new Error("locator target detached from the page before the click");
    }
    if (state === "disabled") {
      throw new Error("locator target is disabled");
    }
    const dispatchState = await handle.evaluate((el) => {
      if (!el.isConnected) return "detached";
      if (typeof el.matches === "function" && el.matches(":disabled")) return "disabled";
      let n: Element | null = el;
      while (n !== null) {
        if (n.getAttribute("aria-disabled") === "true") return "disabled";
        const parentEl: Element | null = n.parentElement;
        if (parentEl !== null) {
          n = parentEl;
        } else {
          const root = n.getRootNode();
          n = root instanceof ShadowRoot ? root.host : null;
        }
      }
      (el as HTMLElement).click();
      return "ok";
    });
    if (dispatchState === "detached") {
      throw new Error("locator target detached from the page before the click");
    }
    if (dispatchState === "disabled") {
      throw new Error("locator target is disabled");
    }
  }

  async typeHandle(handle: ElementHandle<Element>, text: string, sealed = false): Promise<void> {
    if (sealed) {
      await handle.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
    }
    if (!this.humanize) {
      await handle.fill(text);
      return;
    }
    await handle.click({ timeout: 8000 }).catch(() => undefined);
    await handle.fill("").catch(() => undefined);
    await handle.type(text, { delay: rand(40, 110) });
  }

  // Dispatch a DOM .click() in the page context. Some React copy buttons fire
  // their onClick (and thus navigator.clipboard.writeText) on the synthetic
  // event a real Playwright mouse click doesn't reliably reproduce (deepinfra's
  // "copy key": a JS click populated the clipboard in a probe where the
  // positional click did not). Used as a copy-extraction fallback; the preceding
  // real click supplies the transient user-activation writeText needs.
  async clickViaJs(selector: string, index = 0): Promise<void> {
    if (!this.page) return;
    const safeIndex = Math.max(0, Math.floor(index));
    await this.page
      .evaluate(
        ({ sel, i }) => {
          const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
          const el = els[i] ?? els[0];
          if (el !== undefined) el.click();
        },
        { sel: selector, i: safeIndex },
      )
      .catch(() => undefined);
  }

  async clickNth(selector: string, index: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const safeIndex = Math.max(0, Math.floor(index));
    const locator = this.page.locator(selector).nth(safeIndex);
    await locator.click({ timeout: 8000 });
  }

  // Click a link/button by its visible text. Used for one-off
  // dismissibles where the bot knows the literal label text and
  // doesn't need full inventory ranking (e.g. GitHub's "skip 2FA
  // verification at this moment" link on the post-handshake 2FA
  // sanity page). Case-insensitive substring match — GitHub
  // occasionally tweaks capitalization on the same link.
  //
  // Returns true on successful click, false when the text isn't on
  // the page within the timeout. Doesn't throw on miss — caller
  // decides whether to fall back to abort.
  async clickLinkByText(text: string, timeoutMs = 3000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      // Escape regex metacharacters in the user-supplied label text so
      // a literal "(2FA)" or "." doesn't get interpreted as a pattern.
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const locator = this.page.getByText(new RegExp(escaped, "i")).first();
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      if (this.humanize) {
        await this.humanClickLocator(locator);
      } else {
        await locator.click();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Click the form's submit button, disambiguating when the planned
  // selector matches several elements. Signup pages routinely render
  // OAuth buttons ("Continue with Google" / "GitHub") as
  // button[type=submit] alongside the real submit — and a Playwright
  // locator is strict-mode, so a plain click on a multi-match selector
  // throws "strict mode violation". We score the candidates by visible
  // text and click the best, or throw a clear error when none reads as
  // a signup button (e.g. an OAuth-only page).
  async clickSubmit(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.3-rc.1 — wait for the submit selector to appear before
    // querying count. Mixpanel-class SPAs (Next.js + heavy auth JS)
    // race past the 10s `waitForSelector` in click() and bail with
    // `locator.waitFor: Timeout 10000ms exceeded` even when the form
    // is otherwise correct. Polling here gives the SPA time to
    // mount the submit button BEFORE we check whether it's disabled.
    // Best-effort: a genuine miss still surfaces as the click()'s
    // own timeout downstream.
    try {
      await this.page.waitForSelector(selector, {
        state: "attached",
        timeout: 20000,
      });
    } catch {
      // fall through — click() below will produce the canonical error
    }
    const locator = this.page.locator(selector);
    // The count can throw "Execution context was destroyed" when an
    // earlier fill already triggered a navigation/auto-submit (zilliz:
    // typing email+password redirects before we reach the submit click).
    // That race must NOT crash the whole signup — the page is already
    // moving on, so treat the submit as effectively done and let the
    // caller inspect the new page. MEASURED 2026-06-11 (zilliz /signup).
    const count = await locator.count().catch(() => -1);
    if (count < 0) {
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
      return;
    }
    // A disabled submit means a required field or agreement checkbox
    // wasn't satisfied — throw a distinct `submit_disabled` so the
    // caller can re-plan to fix it, rather than wait out a generic
    // visibility timeout (SendPulse: #btn-reg stays disabled +
    // hidden until the TOS box is ticked).
    if (count >= 1) {
      const disabled = await locator
        .first()
        .isDisabled()
        .catch(() => false);
      if (disabled) {
        throw new Error(
          `submit_disabled: the submit button (${selector}) is disabled — a ` +
            `required field or agreement checkbox was not satisfied`,
        );
      }
    }
    // 0 or 1 match: the normal click path handles it (and surfaces a
    // clean "waiting for selector" timeout when the count is 0).
    if (count <= 1) {
      await this.click(selector);
      return;
    }
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      texts.push(((await locator.nth(i).textContent()) ?? "").trim());
    }
    const best = pickSubmitButtonIndex(texts);
    if (best === null) {
      throw new Error(
        `submit selector "${selector}" matched ${count} buttons, none scoring ` +
          `as a signup button (texts: ${texts.map((t) => JSON.stringify(t)).join(", ")})`,
      );
    }
    const chosen = locator.nth(best);
    if (this.humanize) {
      await this.humanClickLocator(chosen);
    } else {
      await chosen.click();
    }
  }

  async check(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Use force:true because TOS checkboxes are sometimes visually covered by
    // a custom label/styled wrapper but the underlying input is checkable.
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    // Bring it into the viewport first — MongoDB/Sentry signup
    // checkboxes sit below the fold and a bezier mouse-click misses
    // an off-screen element (F3 T6).
    await this.page
      .locator(selector)
      .scrollIntoViewIfNeeded({ timeout: 5000 })
      .catch(() => {});
    if (!this.humanize) {
      await this.page.check(selector, { force: true }).catch(() => undefined);
      if (await this.ensureChecked(selector)) return;
      throw new Error(`Unable to check selector "${selector}" after label and DOM fallbacks`);
    }
    // For visible checkboxes, move the mouse to it first (a real user
    // would). For force-checked invisible ones, fall back to the
    // Playwright API so we don't try to mouse-click an offscreen element.
    await this.humanClick(selector).catch(() => undefined);
    await this.page.check(selector, { force: true }).catch(() => undefined);
    if (await this.ensureChecked(selector)) return;
    throw new Error(`Unable to check selector "${selector}" after click, label, and DOM fallbacks`);
  }

  private async ensureChecked(selector: string): Promise<boolean> {
    if (!this.page) return false;
    if (
      await this.page
        .locator(selector)
        .isChecked()
        .catch(() => false)
    )
      return true;

    await this.clickAssociatedLabel(selector).catch(() => false);
    if (
      await this.page
        .locator(selector)
        .isChecked()
        .catch(() => false)
    )
      return true;

    const domChecked = await this.page
      .locator(selector)
      .first()
      .evaluate((el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        if (el.type !== "checkbox" && el.type !== "radio") return false;
        if (!el.checked) {
          el.click();
        }
        if (!el.checked) {
          el.checked = true;
          el.setAttribute("checked", "");
          el.setAttribute("aria-checked", "true");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return el.checked;
      })
      .catch(() => false);
    if (!domChecked) return false;
    return await this.page
      .locator(selector)
      .isChecked()
      .catch(() => false);
  }

  // Click the <label> associated with a checkbox/radio input — either a
  // `<label for="<id>">` or the wrapping `<label>` ancestor. Mantine/Radix
  // render the real input visually-hidden inside a styled label; clicking the
  // label is what fires the library's onChange (a direct input check can
  // leave React's controlled state stale). Returns true if a label was
  // found + clicked. Best-effort — never throws.
  private async clickAssociatedLabel(selector: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      const id = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => (el instanceof HTMLElement ? el.id : ""))
        .catch(() => "");
      if (id) {
        const forLabel = this.page.locator(`label[for="${id}"]`).first();
        if ((await forLabel.count()) > 0) {
          await forLabel.click({ timeout: 4000 });
          return true;
        }
      }
      // No `for=` label — try the wrapping <label> ancestor.
      const wrapping = this.page.locator(selector).locator("xpath=ancestor::label[1]").first();
      if ((await wrapping.count()) > 0) {
        await wrapping.click({ timeout: 4000 });
        return true;
      }
      // Some Radix/shadcn-style controls render the hidden input as a sibling
      // of the visible agreement label, with no `for=` and no wrapping label
      // (Mistral's terms checkbox). At this point direct check has already
      // failed/not toggled, so clicking the nearest agreement-shaped label in
      // the same form is the safest remaining human-equivalent action.
      const clickedAgreement = await this.page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const agreementRe = /terms|tos\b|privacy|policy|i accept|i agree|agree to/i;
          const form = el.closest("form");
          const labels = [
            ...(form ? Array.from(form.querySelectorAll("label")) : []),
            ...Array.from(document.querySelectorAll("label")),
          ];
          const label = labels.find((candidate) => agreementRe.test(candidate.textContent ?? ""));
          if (!(label instanceof HTMLElement)) return false;
          label.click();
          return true;
        })
        .catch(() => false);
      if (clickedAgreement) {
        return true;
      }
    } catch {
      // best-effort
    }
    return false;
  }

  // Deterministic pre-submit guard: tick every visible, unchecked,
  // non-disabled REQUIRED-AGREEMENT checkbox (terms/privacy/consent),
  // while never touching marketing/newsletter opt-ins.
  //
  // Why this exists separate from the LLM planner: amplitude's signup
  // has a required TOS checkbox the planner skipped (it read the
  // adjacent data-storage card-radios as the whole cluster being
  // "ambiguous radios"), and amplitude does NOT disable submit when the
  // box is unticked — so the click silently no-ops and the bot then
  // waits forever for a verification mail that never sends. This runs on
  // EVERY submit, not only the `submit_disabled` path in clickSubmit().
  //
  // Returns the labels/testids it checked (for step logging); empty when
  // it ticked nothing.
  async checkRequiredAgreementBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    // Best-effort: a page-eval failure (navigation mid-call, detached
    // frame) must never fail the parent submit — return nothing.
    try {
      return await this.page.evaluate(() => {
        // These two regexes MUST stay byte-identical with
        // AGREEMENT_TEXT_RE / MARKETING_TEXT_RE in this module — the
        // page realm can't import, so they're inlined here.
        const agreementRe =
          /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr|age|18\+|18 years|certif/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const checked: string[] = [];
        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        );
        for (const box of boxes) {
          if (box.checked || box.disabled) continue;
          const rect = box.getBoundingClientRect();
          const ancestorLabel = box.closest("label");
          const labelRect = ancestorLabel?.getBoundingClientRect();
          const visible =
            (rect.width > 0 && rect.height > 0) ||
            (labelRect !== undefined && labelRect.width > 0 && labelRect.height > 0);
          if (!visible) continue;

          // Associated text = attributes + a label[for=id] + nearest
          // ancestor <label> + the immediately following sibling text.
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          const sibling = box.nextSibling;
          if (sibling && sibling.textContent) parts.push(sibling.textContent);
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }

          const text = parts.join(" ");
          if (!agreementRe.test(text) || marketingRe.test(text)) continue;

          // React/Vue controlled inputs ignore a bare `.checked = true`:
          // their state lives in the framework, updated only by the real
          // event flow. Click first (while unchecked) so the framework sees the
          // same transition a user would make, then force-ensure checked and
          // dispatch input/change for styled/hidden inputs whose click target
          // does not toggle the underlying control.
          box.click();
          if (!box.checked) box.checked = true;
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));

          const label =
            box.getAttribute("data-testid") ||
            box.getAttribute("name") ||
            box.id ||
            box.getAttribute("aria-label") ||
            "agreement-checkbox";
          checked.push(label);
        }
        return checked;
      });
    } catch {
      return [];
    }
  }

  // Deterministic pre-submit guard for required signup category choices.
  //
  // Paddle-class forms ask a required "What do you sell?" question where one
  // product category must be selected before account creation, but the submit
  // button remains enabled. The planner can satisfy the agreement checkbox and
  // still skip the category, producing a rejected submit + no verification mail.
  //
  // Keep this conservative: only fire when the page text explicitly says a
  // product/category choice is required, never touch agreement/marketing boxes,
  // and prefer low-risk SaaS/software labels over restricted categories.
  async checkRequiredSignupChoiceBoxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        const choiceGateRe =
          /what do you sell|categories we support|select which types? of products|choose (?:a|your) (?:category|product|business type)|product category|business category/i;
        const safeChoiceRe =
          /digital products?|saas|software|developer tools?|apis?|mobile apps?|data|analytics/i;
        const riskyChoiceRe =
          /gambling|financial services?|physical products?|marketplace|human services?|adult|weapons?|medical|restricted|crypto|payments?|banking/i;
        const agreementRe = /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr/i;
        const marketingRe =
          /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;

        const bodyText = document.body?.innerText ?? "";
        if (!choiceGateRe.test(bodyText)) return [];

        const associatedText = (box: HTMLInputElement): string => {
          const parts: string[] = [
            box.getAttribute("data-testid") ?? "",
            box.getAttribute("name") ?? "",
            box.id,
            box.getAttribute("aria-label") ?? "",
          ];
          if (box.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
            if (forLabel) parts.push(forLabel.textContent ?? "");
          }
          const ancestorLabel = box.closest("label");
          if (ancestorLabel) parts.push(ancestorLabel.textContent ?? "");
          if (box.nextElementSibling) {
            parts.push(box.nextElementSibling.textContent ?? "");
          }
          return parts.join(" ").replace(/\s+/g, " ").trim();
        };

        const boxes = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="checkbox"], input[type="radio"]',
          ),
        );
        const visibleBoxes = boxes.filter((box) => {
          if (box.disabled) return false;
          const rect = box.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

        const alreadyChoseCategory = visibleBoxes.some((box) => {
          if (!box.checked) return false;
          const text = associatedText(box);
          return !agreementRe.test(text) && !marketingRe.test(text) && !riskyChoiceRe.test(text);
        });
        if (alreadyChoseCategory) return [];

        const candidates = visibleBoxes
          .filter((box) => !box.checked)
          .map((box) => ({ box, text: associatedText(box) }))
          .filter(({ text }) => {
            if (!text) return false;
            if (agreementRe.test(text) || marketingRe.test(text)) return false;
            if (riskyChoiceRe.test(text)) return false;
            return safeChoiceRe.test(text);
          })
          .sort((a, b) => {
            const score = (text: string): number => {
              if (/digital products?|saas|software/i.test(text)) return 3;
              if (/developer tools?|apis?|data|analytics/i.test(text)) return 2;
              if (/mobile apps?/i.test(text)) return 1;
              return 0;
            };
            return score(b.text) - score(a.text);
          });
        const choice = candidates[0];
        if (!choice) return [];

        choice.box.checked = true;
        choice.box.dispatchEvent(new Event("input", { bubbles: true }));
        choice.box.dispatchEvent(new Event("change", { bubbles: true }));
        choice.box.click();
        return [
          choice.box.getAttribute("data-testid") ||
            choice.box.getAttribute("name") ||
            choice.box.id ||
            choice.box.getAttribute("aria-label") ||
            choice.text ||
            "signup-choice",
        ];
      });
    } catch {
      return [];
    }
  }

  // Scroll a Terms-of-Service style modal to the bottom so the gated
  // "Accept" button enables. Railway's signup is the canonical case:
  // a modal with a virtualized ToS list watches real `scroll` /
  // `wheel` events on its container and only flips the button to
  // enabled once `scrollTop + clientHeight ~= scrollHeight`.
  //
  // The post-verify planner has no way to name a non-interactive div
  // (the inventory only carries interactive elements), so when
  // `selector` is omitted this method auto-detects the most plausible
  // scrollable container: the largest visible element with
  // `overflow:auto|scroll` and real scroll headroom. Returns a
  // structured result so the executor can log what it found and the
  // calling planner round can re-plan if nothing was scrollable.
  //
  // Strategy:
  //   1. Resolve a target element (selector or auto-detected).
  //   2. Position the mouse over it and emit a series of `mouse.wheel`
  //      events. Real wheel events fire `scroll` + `wheel` handlers
  //      and walk virtualized lists row by row; a single JS
  //      `scrollTop = scrollHeight` skips them.
  //   3. Fallback: once wheel loop exits, set `scrollTop = scrollHeight`
  //      and dispatch a synthetic `scroll` event. Covers static lists
  //      whose handlers only debounce on the final scroll position.
  // Operator surface — reveal below-the-fold controls so the planner can act on
  // them (heavy SPAs like the GCP console render long forms whose lower fields
  // sit outside the viewport and so never enter the element inventory). Scrolls
  // the page by ~80% of a viewport (or to an extreme); the next observe picks
  // up the newly-visible elements.
  async scrollViewport(direction: "down" | "up" | "bottom" | "top" = "down"): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.evaluate((dir: string) => {
      const step = Math.round(window.innerHeight * 0.8);
      if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
      else if (dir === "top") window.scrollTo(0, 0);
      else if (dir === "up") window.scrollBy(0, -step);
      else window.scrollBy(0, step);
    }, direction);
    await this.page.waitForTimeout(350);
  }

  async scrollToEndOfTOS(selector?: string): Promise<{
    scrolled: boolean;
    container: string | null;
    reason: "ok" | "no_container" | "already_at_bottom";
  }> {
    if (!this.page) throw new Error("Browser not started");

    // 1. Find the container.
    const target = await this.page.evaluate((sel: string | null) => {
      const scrollableOf = (el: Element): boolean => {
        const s = window.getComputedStyle(el);
        const overflowY = s.overflowY;
        if (overflowY !== "auto" && overflowY !== "scroll") return false;
        return el.scrollHeight > el.clientHeight + 20;
      };
      const visibleArea = (el: Element): number => {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return w * h;
      };
      const describe = (
        el: Element,
      ): { rect: DOMRect; scrollTop: number; scrollHeight: number; clientHeight: number } => ({
        rect: el.getBoundingClientRect(),
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      if (sel !== null) {
        const explicit = document.querySelector(sel);
        if (explicit === null) return null;
        return describe(explicit);
      }
      // Auto-detect: largest visible scrollable element.
      const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
      const candidates = all.filter(scrollableOf).map((el) => ({
        el,
        area: visibleArea(el),
      }));
      candidates.sort((a, b) => b.area - a.area);
      const winner = candidates[0];
      if (winner === undefined || winner.area < 100) return null;
      return describe(winner.el);
    }, selector ?? null);

    if (target === null) {
      return { scrolled: false, container: null, reason: "no_container" };
    }

    // Already at the bottom on entry — a no-op scroll. Surface this
    // so the executor can hint the planner that whatever is gating
    // the disabled button is NOT scroll position (Railway iter ≥2 on
    // the second ToS modal: planner kept asking for scroll when the
    // form was actually waiting on something else).
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 4) {
      return {
        scrolled: false,
        container: selector ?? "auto-detected",
        reason: "already_at_bottom",
      };
    }

    const { rect } = target;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;

    // 2. Move the mouse over the container, then wheel down repeatedly.
    if (this.humanize) {
      await this.bezierMouseTo(cx, cy);
      await this.sleep(rand(80, 200));
    } else {
      await this.page.mouse.move(cx, cy);
    }

    const deltaPerStep = Math.max(200, Math.floor(rect.height * 0.7));
    const maxSteps = 30;
    for (let i = 0; i < maxSteps; i++) {
      await this.page.mouse.wheel(0, deltaPerStep);
      await this.sleep(this.humanize ? rand(60, 180) : 30);
      const atBottom = await this.page.evaluate(
        ({ sel, autoDetected }: { sel: string | null; autoDetected: boolean }) => {
          let el: Element | null;
          if (sel !== null) {
            el = document.querySelector(sel);
          } else {
            // Re-resolve the same way we picked it the first time —
            // the modal we wheeled may have re-rendered (virtualized
            // list mounting new rows), so cache-by-reference would go
            // stale.
            const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
            const overflowing = all.filter((node) => {
              const s = window.getComputedStyle(node);
              if (s.overflowY !== "auto" && s.overflowY !== "scroll") return false;
              return node.scrollHeight > node.clientHeight + 20;
            });
            const visibleArea = (n: Element): number => {
              const r = n.getBoundingClientRect();
              const vw = window.innerWidth;
              const vh = window.innerHeight;
              const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              return w * h;
            };
            overflowing.sort((a, b) => visibleArea(b) - visibleArea(a));
            el = overflowing[0] ?? null;
          }
          if (el === null) return true;
          void autoDetected;
          return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        },
        { sel: selector ?? null, autoDetected: selector === undefined },
      );
      if (atBottom) break;
    }

    // 3. JS fallback: pin scrollTop to the end and fire a synthetic
    //    scroll event for handlers that only react on the final
    //    position. No-op if the wheel loop already reached the bottom.
    await this.page.evaluate((sel: string | null) => {
      let el: Element | null;
      if (sel !== null) {
        el = document.querySelector(sel);
      } else {
        const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
        const overflowing = all.filter((node) => {
          const s = window.getComputedStyle(node);
          if (s.overflowY !== "auto" && s.overflowY !== "scroll") return false;
          return node.scrollHeight > node.clientHeight + 20;
        });
        const visibleArea = (n: Element): number => {
          const r = n.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          return w * h;
        };
        overflowing.sort((a, b) => visibleArea(b) - visibleArea(a));
        el = overflowing[0] ?? null;
      }
      if (el === null) return;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, selector ?? null);

    return {
      scrolled: true,
      container: selector ?? "auto-detected",
      reason: "ok",
    };
  }

  // Pick a valid option for either a native <select> OR a custom
  // ARIA combobox (Radix, Headless UI, React Aria, cmdk — F11). The
  // bot must not call type() on a select-shaped element (Sentry,
  // legacy form path: "Element is not an <input>"); modern dashboards
  // increasingly render permission / role / region pickers as
  // <button role="combobox"> that open a <ul role="listbox"> with
  // <li role="option"> children, so Playwright's selectOption fails
  // with "no selectable option" on them.
  //
  // Dispatch: read the element's tag. <select> → native path
  // (existing behavior, picks the first non-placeholder option).
  // Anything else → combobox path (click to open, find role=option,
  // click the chosen one).
  //
  // `optionMatcher` is the planner-supplied text of the option to
  // pick (e.g. "Project: Read"). Case-insensitive substring match
  // against the option's visible text. When undefined, picks the
  // first option — preserves the existing behavior for native
  // selects whose contents are interchangeable (country pickers).
  async selectOption(selector: string, optionMatcher?: string): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.waitForSelector(selector, { state: "attached", timeout: 10000 });
    let activeSelector = selector;
    let tagName = await this.page
      .locator(activeSelector)
      .first()
      .evaluate((node) => node.tagName.toLowerCase());

    // 0.8.2-rc.21 — Railway-class fix. The captured selector frequently
    // points at a `<label>` (the inventory ranker prefers visible-text
    // elements). If that label's `for=` association resolves to a
    // native `<select>`, take the native path instead of routing into
    // selectFromCombobox — native selects don't reveal their options
    // via any DOM pattern in headless Chromium (they're OS-rendered),
    // so the combobox path is guaranteed to fail for them. Without
    // this redirect, every captured Railway/legacy-form `<select>`
    // step replays as "no options found after click."
    if (tagName === "label") {
      const resolved = await this.resolveLabelToInput(activeSelector);
      if (resolved !== activeSelector) {
        const resolvedTag = await this.page
          .locator(resolved)
          .first()
          .evaluate((node) => node.tagName.toLowerCase())
          .catch(() => "");
        if (resolvedTag === "select") {
          activeSelector = resolved;
          tagName = "select";
        }
      } else {
        const rowControl = await this.page
          .locator(activeSelector)
          .first()
          .evaluate((label) => {
            const root =
              label.closest(".n-form-group__row") ??
              label.closest("label")?.parentElement ??
              label.parentElement;
            const control = root?.querySelector<HTMLElement>(
              'select,button[role="combobox"],input[role="combobox"],[role="combobox"]',
            );
            if (control === null || control === undefined) return null;
            const id = control.getAttribute("id");
            if (id !== null && id.length > 0) return `#${CSS.escape(id)}`;
            const testId =
              control.getAttribute("data-qa") ??
              control.getAttribute("data-testid") ??
              control.getAttribute("data-test") ??
              control.getAttribute("data-cy");
            if (testId !== null && testId.length > 0) {
              return `[data-qa="${CSS.escape(testId)}"],[data-testid="${CSS.escape(testId)}"],[data-test="${CSS.escape(testId)}"],[data-cy="${CSS.escape(testId)}"]`;
            }
            return null;
          })
          .catch(() => null);
        if (rowControl !== null) {
          activeSelector = rowControl;
          tagName = await this.page
            .locator(activeSelector)
            .first()
            .evaluate((node) => node.tagName.toLowerCase())
            .catch(() => tagName);
        }
      }
    }

    if (tagName === "select") {
      // Keep the resolved target as a Locator. Walker selectors can include
      // Playwright chains such as `select.foo >> nth=1`; appending CSS text to
      // those strings changes the chain's meaning (`... >> nth=1 option`) and
      // makes a full select appear option-less. Descendant lookup, selection,
      // and verification must all stay anchored to the same resolved element.
      const selectLocator = this.page.locator(activeSelector).first();
      const optionLocator = selectLocator.locator("option");
      // Native path. rc.15 — keep value="" options selectable. The
      // Railway workspace dropdown's "No workspace" option is value=""
      // and it IS the right pick for an account-scoped token. The
      // prior implementation filtered empty strings out of the fallback
      // list AND rejected matched value="" picks, so the planner could
      // never reach that option. Now: fallback list keeps every option
      // (with the first option's value, even if empty), and a matched
      // text-based pick is honored verbatim — including empty values.
      const allValues = await optionLocator.evaluateAll((opts) =>
        opts.map((o) => (o instanceof HTMLOptionElement ? o.value : "")),
      );
      if (allValues.length === 0) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      // Default to the first NON-empty value when the planner gave no
      // hint — historic behavior, kept because "Select…" placeholder
      // options are almost always the wrong default pick.
      const firstReal = allValues.find((v) => v.length > 0);
      let chosenValue: string | undefined = firstReal !== undefined ? firstReal : allValues[0];
      if (optionMatcher !== undefined) {
        const matcherLower = optionMatcher.toLowerCase();
        // Returns either a matched value (may be "") or null when no
        // option's text matches. Wrap in an object so we can
        // distinguish "matched to empty value" from "no match".
        const matched = await optionLocator.evaluateAll((opts, needle) => {
          const hit = opts
            .filter((o): o is HTMLOptionElement => o instanceof HTMLOptionElement)
            .find((o) => o.textContent?.toLowerCase().includes(needle));
          return hit !== undefined ? { value: hit.value } : null;
        }, matcherLower);
        if (matched === null) {
          throw new Error(
            `<select> ${activeSelector}: no option matched ${JSON.stringify(optionMatcher)}`,
          );
        }
        chosenValue = matched.value;
      }
      if (chosenValue === undefined) {
        throw new Error(`<select> ${activeSelector} has no selectable option`);
      }
      await selectLocator.selectOption(chosenValue);
      const committedValue = await selectLocator.inputValue();
      if (committedValue !== chosenValue) {
        throw new Error(
          `<select> ${activeSelector}: selected value ${JSON.stringify(chosenValue)} did not stick`,
        );
      }
      // rc.17 — mark the element as touched so subsequent inventory
      // reads can suppress the DEFAULTED-dropdown warning for it.
      // Without this, a select whose committed value is "" (Railway's
      // "No workspace") keeps tripping the warning every round, and
      // the planner gets stuck in a select→select→… loop trying to
      // satisfy a warning the form has already satisfied.
      await selectLocator
        .evaluate((el) => {
          if (el instanceof HTMLElement) el.setAttribute("data-ts-touched", "1");
        })
        .catch(() => {});
      return await selectLocator.evaluate((select) =>
        select instanceof HTMLSelectElement
          ? (select.selectedOptions[0]?.textContent ?? "").replace(/\s+/g, " ").trim()
          : "",
      );
    }

    // Custom combobox path. Sentry, Radix, Headless UI, React Aria
    // — every modern React picker emits role=option on its items.
    return await this.selectFromCombobox(activeSelector, optionMatcher);
  }

  // Set the country on a phone-number field backed by a phone-local native
  // <select>, including react-phone-number-input's opacity:0 country select.
  // The inventory walker omits that hidden control and Playwright refuses to
  // select it, so this path uses the native value setter, dispatches change,
  // and verifies the selected value. Custom phone widget families are not
  // supported and fail loudly.
  async setPhoneCountry(country: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const query = classifyPhoneCountryQuery(country);
    if (query.dialCode === undefined && query.iso2 === undefined && query.name === undefined) {
      throw new Error("setPhoneCountry: empty country argument");
    }
    await this.clearPhoneCountryMarkers();
    await this.page
      .locator('[data-ts-phone-country-control="1"]')
      .evaluateAll((elements) => {
        elements.forEach((element) => element.removeAttribute("data-ts-phone-country-control"));
      })
      .catch(() => undefined);
    if (await this.trySetPhoneCountryNativeSelect(query)) return;
    throw new Error(
      "set_phone_country: no supported native phone-country <select> found " +
        "(this widget family is not supported yet) — enter a valid contact number instead.",
    );
  }

  async verifyPhoneCountry(country: string): Promise<boolean> {
    if (!this.page) return false;
    const query = classifyPhoneCountryQuery(country);
    if (query.dialCode === undefined && query.iso2 === undefined && query.name === undefined) {
      return false;
    }
    const selected = await this.page.evaluate(() => {
      const control = document.querySelector('select[data-ts-phone-country-control="1"]');
      if (!(control instanceof HTMLSelectElement)) return null;
      const option = control.selectedOptions[0];
      return option === undefined
        ? null
        : {
            value: option.value,
            text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
    });
    if (selected === null) return false;
    const option: PhoneCountryOption = {
      text: selected.text.length > 0 ? selected.text : undefined,
      iso2: /^[A-Za-z]{2}$/.test(selected.value) ? selected.value.toUpperCase() : undefined,
      dialCode: /^\+?\d{1,4}$/.test(selected.value) ? selected.value.replace(/\D/g, "") : undefined,
    };
    return phoneCountryOptionMatches(query, option);
  }

  async hasPhoneCountryControl(): Promise<boolean> {
    if (!this.page) return false;
    return (await this.page.locator('select[data-ts-phone-country-control="1"]').count()) === 1;
  }

  // Strategy 1 — a native <select> that governs the phone country (react-
  // phone-number-input's `opacity:0` PhoneInputCountrySelect, or any bespoke
  // widget backed by a real <select>). Detection is deliberately conservative
  // so it does NOT grab the address "country" select that lives elsewhere on
  // the checkout: a select qualifies only when its class/name/id names it a
  // PHONE control and its options carry country evidence, or its options look
  // like countries AND it is a direct sibling of the tel input or lives in an
  // immediately adjacent wrapper.
  // Returns false when no such select exists; throws when one is found but the
  // requested country isn't among its options.
  private async trySetPhoneCountryNativeSelect(query: PhoneCountryQuery): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const candidates = await this.page.evaluate(() => {
      const out: Array<{
        marker: number;
        options: Array<{ value: string; text: string }>;
        phoneNamed: boolean;
        telDistance: number;
      }> = [];
      const selects = Array.from(document.querySelectorAll("select"));
      selects.forEach((sel, i) => {
        if (!(sel instanceof HTMLSelectElement)) return;
        const hay = `${sel.className} ${sel.getAttribute("name") ?? ""} ${sel.id}`.toLowerCase();
        const phoneNamed = /phone|dial|calling/.test(hay);
        let telDistance = Number.POSITIVE_INFINITY;
        const isTel = (el: Element | null): boolean => el?.matches('input[type="tel"]') === true;
        const parent = sel.parentElement;
        if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          (isTel(sel.previousElementSibling) || isTel(sel.nextElementSibling))
        ) {
          telDistance = 0;
        } else if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          Array.from(parent.children).some(isTel)
        ) {
          telDistance = 1;
        }
        const options = Array.from(sel.options).map((o) => ({
          value: o.value,
          text: (o.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        const isoish = options.filter((o) => /^[A-Za-z]{2}$/.test(o.value)).length;
        const dialish = options.filter(
          (o) => /\+\d/.test(o.text) || /^\+?\d{1,4}$/.test(o.value),
        ).length;
        const explicitDialish = options.filter(
          (o) => /\+\d/.test(o.text) || /^\+\d{1,4}$/.test(o.value),
        ).length;
        const countryish = options.length >= 10 && (isoish >= 5 || dialish >= 5);
        const countryNamed = /country|nation|iso/.test(hay);
        const dialCodeNamed = /dial|calling/.test(hay);
        const phoneCountryish =
          countryish ||
          explicitDialish > 0 ||
          (dialCodeNamed && dialish >= 2) ||
          (countryNamed && isoish >= 2);
        if ((phoneNamed && phoneCountryish) || (countryish && telDistance <= 1)) {
          sel.setAttribute("data-ts-phone-cc", String(i));
          out.push({
            marker: i,
            options,
            phoneNamed,
            telDistance: telDistance === Number.POSITIVE_INFINITY ? 99 : telDistance,
          });
        }
      });
      return out;
    });
    if (candidates.length === 0) return false;
    // Prefer a phone-NAMED select, then the one physically closest to a tel
    // input — the strongest evidence it's the dial-code control, not address.
    candidates.sort(
      (a, b) => Number(b.phoneNamed) - Number(a.phoneNamed) || a.telDistance - b.telDistance,
    );
    const best = candidates[0];
    if (best === undefined) return false;
    const opts: PhoneCountryOption[] = best.options.map((o) => ({
      text: o.text.length > 0 ? o.text : undefined,
      iso2: /^[A-Za-z]{2}$/.test(o.value) ? o.value.toUpperCase() : undefined,
      dialCode: /^\+?\d{1,4}$/.test(o.value) ? o.value.replace(/\D/g, "") : undefined,
    }));
    const idx = pickPhoneCountryOption(query, opts);
    const chosenOpt = idx === -1 ? undefined : best.options[idx];
    if (chosenOpt === undefined) {
      await this.clearPhoneCountryMarkers();
      const sample = best.options
        .map((o) => o.text)
        .filter((t) => t.length > 0)
        .slice(0, 6)
        .join(" | ");
      throw new Error(
        `setPhoneCountry: native phone <select> found but no option matched ` +
          `${JSON.stringify(query)} (sample: ${sample})`,
      );
    }
    const value = chosenOpt.value;
    // Set through the native value setter + a dispatched `change` so a React-
    // controlled select (react-phone-number-input) sees the update: assigning
    // .value directly is swallowed by React's value tracker, so we go through
    // the prototype setter the tracker also patches, then fire the event React
    // listens on. Works on the opacity:0 select without a visibility check.
    const assigned = await this.page.evaluate(
      ({ marker, val }) => {
        const sel = document.querySelector(`select[data-ts-phone-cc="${marker}"]`);
        if (!(sel instanceof HTMLSelectElement)) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
        if (desc?.set !== undefined) desc.set.call(sel, val);
        else sel.value = val;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.setAttribute("data-ts-phone-country-control", "1");
        return true;
      },
      { marker: best.marker, val: value },
    );
    const committedValue = assigned
      ? await this.page
          .locator(`select[data-ts-phone-cc="${best.marker}"]`)
          .inputValue()
          .catch(() => "")
      : "";
    await this.clearPhoneCountryMarkers();
    if (!assigned || committedValue !== value) {
      throw new Error(
        `setPhoneCountry: native phone <select> did not retain value ${JSON.stringify(value)}`,
      );
    }
    return true;
  }

  private async clearPhoneCountryMarkers(): Promise<void> {
    if (!this.page) return;
    await this.page
      .evaluate(() => {
        document.querySelectorAll("[data-ts-phone-cc]").forEach((el) => {
          el.removeAttribute("data-ts-phone-cc");
        });
      })
      .catch(() => {});
  }

  private async markComboboxPreexistingElements(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.evaluate(() => {
      const visible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity || "1") > 0.01
        );
      };
      const popupSelector =
        '[role="listbox"],[role="menu"],[role="dialog"],[id*="listbox" i],[id*="dropdown" i],[id*="popover" i],[id*="menu" i],[id*="options" i],[class*="listbox" i],[class*="dropdown" i],[class*="popover" i],[class*="menu" i],[class*="options" i]';
      document
        .querySelectorAll(popupSelector)
        .forEach((el) => visible(el) && el.setAttribute("data-ts-select-preexisting-popup", "1"));
    });
  }

  private async refreshComboboxMarkers(triggerSelector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page
      .locator(triggerSelector)
      .first()
      .evaluate((trigger) => {
        const visible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            parseFloat(style.opacity || "1") > 0.01
          );
        };
        document
          .querySelectorAll("[data-ts-select-popup],[data-ts-select-option-tier]")
          .forEach((el) => {
            el.removeAttribute("data-ts-select-popup");
            el.removeAttribute("data-ts-select-option-tier");
          });
        const popupSelector =
          '[role="listbox"],[role="menu"],[role="dialog"],[id*="listbox" i],[id*="dropdown" i],[id*="popover" i],[id*="menu" i],[id*="options" i],[class*="listbox" i],[class*="dropdown" i],[class*="popover" i],[class*="menu" i],[class*="options" i]';
        const controlledPopups: Element[] = [];
        for (const attr of ["aria-controls", "aria-owns"]) {
          for (const id of (trigger.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
            const popup = trigger.ownerDocument.getElementById(id);
            if (popup !== null && visible(popup) && !controlledPopups.includes(popup)) {
              controlledPopups.push(popup);
            }
          }
        }
        const openedPopups: Element[] = [];
        trigger.ownerDocument.querySelectorAll(popupSelector).forEach((el) => {
          if (
            !el.hasAttribute("data-ts-select-preexisting-popup") &&
            visible(el) &&
            !openedPopups.includes(el)
          ) {
            openedPopups.push(el);
          }
        });
        const singlePopup = (candidates: Element[]): Element | undefined => {
          const semantic = candidates.filter((el) =>
            el.matches('[role="listbox"],[role="dialog"],[role="menu"]'),
          );
          const pool = semantic.length > 0 ? semantic : candidates;
          const innermost = pool.filter(
            (candidate) => !pool.some((other) => other !== candidate && candidate.contains(other)),
          );
          return innermost.length === 1 ? innermost[0] : undefined;
        };
        const popup =
          controlledPopups.length > 0 ? singlePopup(controlledPopups) : singlePopup(openedPopups);
        popup?.setAttribute("data-ts-select-popup", "1");
        const optionSelectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="menuitemradio"]',
          "mat-option",
          ".mat-mdc-option",
          '[id^="react-select-"][role*="menu"]',
          '[role="listbox"] li',
        ];
        optionSelectors.forEach((selector, tier) => {
          trigger.ownerDocument.querySelectorAll(selector).forEach((el) => {
            if (popup !== undefined && visible(el) && (popup === el || popup.contains(el))) {
              el.setAttribute("data-ts-select-option-tier", String(tier));
            }
          });
        });
      });
  }

  private async clearComboboxMarkers(): Promise<void> {
    if (!this.page) return;
    await this.page
      .evaluate(() => {
        document
          .querySelectorAll(
            "[data-ts-select-preexisting-popup],[data-ts-select-popup],[data-ts-select-option-tier]",
          )
          .forEach((el) => {
            el.removeAttribute("data-ts-select-preexisting-popup");
            el.removeAttribute("data-ts-select-popup");
            el.removeAttribute("data-ts-select-option-tier");
          });
      })
      .catch(() => {});
  }

  private async selectFromCombobox(
    triggerSelector: string,
    optionMatcher?: string,
  ): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.2-rc.11 — selector normalization. The planner sometimes
    // emits a selector pointing at a `<label for="X">` instead of the
    // associated `<input id="X">` — the label has the visible text
    // ("Project") so the inventory ranking surfaces it as the target.
    // Clicking a label is NOT equivalent to clicking the input for
    // react-select: the synthetic focus DOES move to the input via
    // the `for` association, but no mouse-down lands on the
    // react-select control, so the menu never opens. Resolve the
    // label to its associated input here so downstream tiers (the
    // keyboard fallback in particular) actually see an input target.
    const normalizedSelector = await this.resolveLabelToInput(triggerSelector);
    await this.markComboboxPreexistingElements();
    try {
      await this.humanClick(normalizedSelector);
      await this.refreshComboboxMarkers(normalizedSelector);
      let popup = this.page.locator('[data-ts-select-popup="1"]').first();
      if ((await popup.count()) === 0) {
        await this.openComboboxWithKeyboard(normalizedSelector);
        await this.refreshComboboxMarkers(normalizedSelector);
        popup = this.page.locator('[data-ts-select-popup="1"]').first();
      }
      if ((await popup.count()) === 0) {
        throw new Error(`combobox ${triggerSelector}: no single opened popup could be resolved`);
      }
      const options = this.page.locator("[data-ts-select-option-tier]");
      let target = options.first();
      if (optionMatcher !== undefined) {
        const matching = options.filter({ hasText: optionMatcher });
        if ((await matching.count()) === 0) {
          throw new Error(
            `combobox ${triggerSelector}: no option matched ${JSON.stringify(optionMatcher)}`,
          );
        }
        target = matching.first();
      } else if ((await options.count()) === 0) {
        throw new Error(`combobox ${triggerSelector}: opened popup has no actionable options`);
      }
      const committedText = (await target.innerText()).replace(/\s+/g, " ").trim();
      await this.clickComboboxOption(target);
      return committedText;
    } finally {
      await this.clearComboboxMarkers();
    }
  }

  // 0.8.2-rc.11 — resolve a `<label for="X">` selector to `#X` so the
  // executor lands on the actual input rather than the label decoration.
  // The planner-emitted inventory line for Sentry's permission grid
  // sometimes targets the label (the visible text is "Project", which
  // lives on the <label>, not the <input>); a click on a label only
  // synthetically focuses its `for` target, which is insufficient to
  // open a react-select menu. Returns the original selector unchanged
  // when the resolution doesn't apply (target isn't a label, has no
  // `for`, or the `for`-id doesn't resolve to an input).
  private async resolveLabelToInput(selector: string): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const resolvedId = await this.page
        .locator(selector)
        .first()
        .evaluate((node) => {
          if (!(node instanceof HTMLLabelElement)) return null;
          const forAttr = node.htmlFor;
          if (forAttr.length === 0) return null;
          const target = node.ownerDocument.getElementById(forAttr);
          if (target === null) return null;
          // Only redirect when the target is input/textarea/select. A
          // label pointing at a non-form element (rare; React Aria
          // does it for a labelled-by relationship) shouldn't trigger
          // the redirect.
          const tag = target.tagName.toLowerCase();
          if (tag !== "input" && tag !== "textarea" && tag !== "select") {
            return null;
          }
          return forAttr;
        });
      if (resolvedId === null) return selector;
      // CSS-escape the id so unusual characters (Sentry's `--` separator
      // is fine, but the helper is defensive against future ids that
      // include `.`, spaces, …) don't break the locator.
      const escaped =
        typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape ===
        "function"
          ? (globalThis as { CSS: { escape: (s: string) => string } }).CSS.escape(resolvedId)
          : resolvedId.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
      return `#${escaped}`;
    } catch {
      return selector;
    }
  }

  private async openComboboxWithKeyboard(triggerSelector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const trigger = this.page.locator(triggerSelector).first();
    try {
      if ((await trigger.evaluate((node) => node.tagName.toLowerCase())) !== "input") return;
      await trigger.focus({ timeout: 1500 });
      await this.page.keyboard.press("Alt+ArrowDown");
      await this.wait(0.4);
    } catch {
      return;
    }
  }

  private async clickComboboxOption(target: Locator): Promise<void> {
    // cmdk (the command-menu library) does NOT commit a selection from the
    // bot's humanized page.mouse.click(x, y): cmdk re-renders + re-orders its
    // list as the search filters, so the cached click coordinates land on the
    // wrong row (or empty space), and cmdk's onSelect — bound to a real
    // pointer/click event ON the item, or Enter on the highlighted item —
    // never fires. The trigger keeps its placeholder and the gated submit
    // stays disabled (MEASURED 2026-06-11: meilisearch's /welcome-informations
    // "reasons" + "SDK" comboboxes looped the whole run). Detect cmdk/Radix
    // option items and commit via a real, re-resolved actionable click (plus a
    // pointer-event sequence as backup) instead of raw mouse coordinates.
    const isCmdkItem = await target
      .evaluate(
        (el) =>
          el.hasAttribute("cmdk-item") ||
          el.closest("[cmdk-root],[cmdk-list],[cmdk-group]") !== null,
      )
      .catch(() => false);
    if (isCmdkItem) {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      // Playwright's locator.click() re-resolves geometry and dispatches the
      // full trusted pointer/mouse sequence at the element's center — what
      // cmdk's onSelect actually listens for.
      await target.click({ timeout: 5000 }).catch(async () => {
        await target.dispatchEvent("pointerdown");
        await target.dispatchEvent("pointerup");
        await target.dispatchEvent("click");
      });
      await this.wait(0.5);
      return;
    }
    await this.humanClickLocator(target);
    await this.wait(0.5);
  }

  // ───────────── type-triggered autocomplete (3.1) ─────────────
  // A free-text `type` into a Google-Places-style address field or a
  // react-select/cmdk/Radix combobox can open the same kind of suggestion
  // popup `select`'s selectFromCombobox() already knows how to drive — the
  // difference is the host issued `type`, not an explicit `select`, so
  // nothing today detects or commits the popup. These three methods reuse
  // the exact open-detect/click machinery selectFromCombobox() uses; the
  // match-or-stop decision of WHICH option (if any) to click lives in
  // provision-session.ts (matchAutocompleteSuggestions), kept a pure
  // function there so it's unit-testable without a browser.

  /**
   * Snapshot popups that already exist BEFORE typing — the suggestion popup
   * can open mid-keystroke, so this must run before type(), not after.
   */
  async markPreexistingTypeSuggestionPopups(): Promise<void> {
    await this.markComboboxPreexistingElements();
  }

  /**
   * After typing into `selector`, detect whether a suggestion popup opened
   * as a side effect and return its option texts in DOM order. Empty when
   * no popup opened — `type` behaved as an ordinary text field and the
   * caller should no-op. Google-Places-style pickers debounce (~200ms)
   * plus a network round-trip before rendering suggestions, so a single
   * synchronous check right after the last keystroke commonly sees
   * nothing — poll on a bounded budget (mirroring settleAfterStateChange's
   * shape), returning as soon as options appear so an already-open popup
   * pays no extra latency.
   */
  async detectTypeSuggestionPopup(selector: string): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await this.sleep(300);
      await this.refreshComboboxMarkers(selector);
      const options = this.page.locator("[data-ts-select-option-tier]");
      const count = await options.count();
      if (count === 0) continue;
      const texts: string[] = [];
      for (let i = 0; i < count; i += 1) {
        texts.push((await options.nth(i).innerText()).replace(/\s+/g, " ").trim());
      }
      return texts;
    }
    return [];
  }

  /** Click the option at `index` (as indexed by detectTypeSuggestionPopup). */
  async commitTypeSuggestion(index: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const options = this.page.locator("[data-ts-select-option-tier]");
    await this.clickComboboxOption(options.nth(index));
  }

  /**
   * Clean up after a type-triggered autocomplete interaction, regardless of
   * outcome (committed, ambiguous/zero-match stop, or a failed commit).
   * When `dismissWithEscape` is true — the caller determined a detected
   * popup is plausibly still open (an ambiguous/zero-match stop where no
   * option was ever clicked, or a commit whose confirmation failed) —
   * presses Escape to dismiss it BEFORE clearing our own tracking markers:
   * some widgets (Google Places classic's `.pac-container` in particular)
   * never fully unmount, just toggle visibility, so a popup left open would
   * otherwise be captured as "preexisting" the next time
   * markPreexistingTypeSuggestionPopups snapshots the page (it snapshots by
   * current visibility, not by who opened it), silently disabling detection
   * on a host's very next retry. Escape must NOT fire when no popup was
   * ever detected, nor after a confirmed successful commit (the widget
   * already closed its popup on selection): it commonly bubbles to close an
   * enclosing modal/dialog too, so firing it with nothing left to dismiss
   * risks closing a dialog the typed-into field happens to live in (a
   * cmdk-in-Radix-dialog combobox, a cart-drawer quantity field, a login
   * modal's email field, an address-edit modal). Marker clearing stays
   * unconditional — it only removes our own tracking attributes, never
   * touches page behavior.
   */
  async discardTypeSuggestionPopup(dismissWithEscape: boolean): Promise<void> {
    if (dismissWithEscape) await this.pressKey("Escape");
    await this.clearComboboxMarkers();
  }

  /**
   * After commitTypeSuggestion, POSITIVELY confirm the picked option's value
   * actually committed. A same-selector `.value` change is one signal, but
   * react-select/cmdk-style widgets clear their search input on selection
   * and render the committed choice in a separate nearby element instead —
   * checking only the original selector's `.value` would false-fail on
   * exactly the widgets this feature targets. Checks, in order: the field's
   * own live value; a native `<select>`'s selected-option label; a nearby
   * (within two DOM ancestor hops of the field, never page-wide) element
   * whose own text or aria-label exactly equals the picked option's text.
   * Returns false — never true — when nothing positively confirms it; the
   * caller must treat false as a miss (stop), never as a silent success.
   */
  async confirmAutocompleteCommitted(
    fieldSelector: string,
    pickedOptionText: string,
  ): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page
        .locator(fieldSelector)
        .first()
        .evaluate((field, wantedRaw) => {
          const normalize = (s: string | null) =>
            (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
          const wanted = normalize(wantedRaw);
          if (wanted.length === 0) return false;
          const ownValue =
            field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
              ? field.value
              : "";
          if (normalize(ownValue) === wanted) return true;
          if (field instanceof HTMLSelectElement) {
            const opt = field.options[field.selectedIndex];
            if (opt !== undefined && normalize(opt.textContent) === wanted) return true;
          }
          // Bounded to the field's immediate wrapper (walk up at most two
          // ancestors) so a coincidental text match elsewhere on the page —
          // or elsewhere in a large `<form>` — can't produce a false
          // positive. React-select/cmdk render the committed choice as a
          // sibling of the (now-cleared) search input under a shared
          // control wrapper, well within this range.
          //
          // This runs BEFORE discardTypeSuggestionPopup (Escape is in the
          // caller's finally), so a suggestion menu that never really
          // committed can still be open here — and menus commonly render
          // within two ancestor hops of the input too. Without excluding
          // it, the picked OPTION's own (still-visible, un-really-clicked)
          // element trivially satisfies the text-equality check every
          // time, defeating the "positively confirm or stop" guarantee for
          // exactly the failure this exists to catch. Exclude anything
          // that IS, is INSIDE, or CONTAINS our own tracked popup/option
          // markers — the last case matters because `.textContent`
          // aggregates every descendant's text, so a plain wrapper div that
          // merely contains the still-open popup reads as if it displayed
          // the picked text itself.
          const TRACKED_POPUP_SELECTOR = "[data-ts-select-popup],[data-ts-select-option-tier]";
          const inTrackedPopup = (el: Element): boolean =>
            el.matches(TRACKED_POPUP_SELECTOR) ||
            el.closest("[data-ts-select-popup]") !== null ||
            el.querySelector(TRACKED_POPUP_SELECTOR) !== null;
          let scope: Element | null = field.parentElement;
          for (let hop = 0; hop < 2 && scope !== null; hop += 1) {
            const found = Array.from(scope.querySelectorAll("*")).some((el) => {
              if (el === field || inTrackedPopup(el)) return false;
              if (normalize(el.textContent) === wanted) return true;
              const ariaLabel = el.getAttribute("aria-label");
              return ariaLabel !== null && normalize(ariaLabel) === wanted;
            });
            if (found) return true;
            scope = scope.parentElement;
          }
          return false;
        }, pickedOptionText);
    } catch {
      return false;
    }
  }

  // ───────────── humanization internals ─────────────

  // Click that mimics a real user: locate element, bezier-path the
  // mouse to it, hover briefly, then click. The mouse position is
  // remembered so successive clicks form a continuous path.
  private async humanClick(selector: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // A bare selector through a strict-mode locator throws "strict mode
    // violation" before humanClickLocator can even waitFor — and several
    // OAuth widgets (Descope's <descope-button>, seen on Weaviate + Redis
    // Cloud) stamp the SAME generated id on both the wrapping web component
    // and its inner text node, so a single id selector resolves to 2
    // elements. For a click that's harmless: every match is the same visual
    // affordance. Narrow to the first match (Playwright's documented
    // disambiguation for clicks) when the selector isn't already unique,
    // matching what clickSubmit/clickLinkByText already do.
    const locator = this.page.locator(selector);
    const count = await locator.count().catch(() => 1);
    await this.humanClickLocator(pickClickLocator(locator, count));
  }

  // Locator-based core of humanClick. Taking a Locator (not a selector
  // string) lets clickSubmit() hand us a `.nth(i)`-narrowed locator
  // when a selector matched several elements — a bare selector through
  // a strict-mode locator would throw before we could disambiguate.
  private async humanClickLocator(locator: Locator): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // 0.8.3-rc.1 — widened from 10s to 20s for SPA-load races. The
    // mixpanel-class signup page (Next.js + heavy auth JS, ~12-15s
    // to first-paint the form) was timing out here even when the
    // submit button DOES eventually mount. Bound stays low enough
    // that a genuinely-missing target still surfaces a clear error
    // within the bot's per-action budget.
    await locator.waitFor({ state: "visible", timeout: 20000 });
    // rc.20 — wait for the target to be ENABLED before issuing the
    // click. humanClick uses page.mouse.click(x, y) which bypasses
    // Playwright's actionability check, so a disabled button receives
    // the mousedown/mouseup events but the browser no-ops them, and
    // the caller sees no error. Symptom: OpenRouter's /sign-up renders
    // Clerk's OAuth buttons with `disabled` + `cl-loading` while Clerk
    // JS is initialising; humanClick fires against the disabled
    // Google button, nothing happens, then auth-state detection
    // misreads "URL unchanged, not on provider" as "OAuth completed"
    // and the run falls apart.
    //
    // Poll for up to 15s for the disabled state to clear. Both the
    // HTML `disabled` attribute AND `aria-disabled="true"` are
    // honored — the latter covers ARIA-styled buttons (Radix, Headless
    // UI) that visually appear interactive but reject input.
    //
    // rc.16 — when the poll times out we now THROW instead of silently
    // proceeding to a no-op click. PostHog's "Create key" submit stays
    // aria-disabled until both an org/project access option AND a
    // scopes preset are set; humanClick previously fired a mouse
    // click at the disabled button (which does nothing), the page
    // didn't change, and the post-verify no-progress detector
    // re-planned generically. The planner kept retrying click on the
    // same button because nothing in its hint named the specific
    // root cause ("button is disabled — find what precondition is
    // missing"). Throwing surfaces the disabled state explicitly to
    // the planner via the executor's existing catch handler, so the
    // next round's reason includes "click failed: target is
    // aria-disabled" and the planner pivots to checking other fields.
    {
      const deadline = Date.now() + 15_000;
      let isDisabled = false;
      while (Date.now() < deadline) {
        isDisabled = await locator
          .first()
          .evaluate((el) => {
            if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
              if (el.disabled) return true;
            }
            const aria = el.getAttribute("aria-disabled");
            return aria === "true" || aria === "";
          })
          .catch(() => false);
        if (!isDisabled) break;
        await this.sleep(150);
      }
      if (isDisabled) {
        // Name the SPECIFIC unfilled required field(s) so the planner fills the
        // right one instead of re-clicking the dead submit. MEASURED 2026-06-11
        // (meilisearch/zilliz: planner clicked a disabled Next 4+ times because
        // the generic hint didn't say WHICH field blocked it). Feedback only.
        const hint = await this.unfilledRequiredHint();
        throw new Error(
          "target is disabled (HTML disabled or aria-disabled=true) after 15s — " +
            "the click would no-op. A required precondition is unmet: an empty " +
            "input, an unselected dropdown, an unchecked agreement checkbox, or " +
            "a missing preset/permission choice. Do NOT retry this click — pick a " +
            "different action that fills the missing field first." +
            hint,
        );
      }
    }
    // Scroll the element into the viewport BEFORE measuring it. A
    // humanized click is a raw page.mouse.click(x, y) at viewport
    // coordinates — boundingBox() of a below-the-fold element returns
    // an off-screen y, and the click then lands on nothing (it was
    // why a Sentry OAuth button below the fold never navigated). The
    // regular .click() path auto-scrolls; the humanized path must too
    // — same fix check() already carries.
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox();
    if (box === null) {
      // Element exists but isn't in the layout (e.g., display:none).
      // Fall back to the regular click which will fail loudly with a
      // useful error.
      await locator.click();
      return;
    }
    // Aim for a random point inside the bounding box (not always the
    // exact center — that's a fingerprintable bot tell).
    const targetX = box.x + rand(box.width * 0.25, box.width * 0.75);
    const targetY = box.y + rand(box.height * 0.25, box.height * 0.75);

    await this.bezierMouseTo(targetX, targetY);
    // Hover hesitation. Real users land on a button and pause briefly
    // before clicking. 80-300ms is short enough not to slow runs much
    // and long enough to register as "non-instant" in scoring JS.
    await this.sleep(rand(80, 300));
    await this.page.mouse.click(targetX, targetY);
    this.mouseX = targetX;
    this.mouseY = targetY;
  }

  // Moves the mouse along a bezier curve from the current position to
  // (x, y). Uses 12-25 intermediate steps with small per-step delays.
  // The curve avoids the dead-straight teleport that Playwright's
  // default move() does.
  private async bezierMouseTo(x: number, y: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const steps = rand(12, 25);
    // Bezier control points: bow the curve slightly perpendicular to
    // the travel direction so it's a recognizable arc, not a straight
    // line. Magnitude scales with distance.
    const dx = x - this.mouseX;
    const dy = y - this.mouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const bowMagnitude = Math.min(distance * 0.2, 80);
    // Perpendicular direction (rotate the (dx, dy) vector 90°), then
    // randomize which side of the line we bow toward.
    const perpX = -dy / (distance || 1);
    const perpY = dx / (distance || 1);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const cx = this.mouseX + dx / 2 + perpX * bowMagnitude * sign;
    const cy = this.mouseY + dy / 2 + perpY * bowMagnitude * sign;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Quadratic bezier: (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
      const oneMinusT = 1 - t;
      const px = oneMinusT * oneMinusT * this.mouseX + 2 * oneMinusT * t * cx + t * t * x;
      const py = oneMinusT * oneMinusT * this.mouseY + 2 * oneMinusT * t * cy + t * t * y;
      await this.page.mouse.move(px, py);
      // 6-18ms per step → ~150-400ms total travel for a typical click.
      await this.sleep(rand(6, 18));
    }
  }

  // ───────────── Tier 2 captcha handling ─────────────

  // Detects and handles visible-mode captcha widgets (Cloudflare
  // Turnstile, reCAPTCHA v2 checkbox). Returns:
  //   { found: false }                   - no widget present
  //   { found: true, solved: true }      - we clicked it and the page
  //                                        accepted the resulting token
  //   { found: true, solved: false }     - we clicked it but the
  //                                        challenge didn't pass
  //                                        within the timeout
  //
  // Strategy: locate the third-party iframe, click at the checkbox's
  // typical position (inside the widget's bounding box, near the
  // left), then poll for the success signal:
  //   - Turnstile:   `input[name="cf-turnstile-response"][value]` populated
  //   - reCAPTCHA:   `textarea[name="g-recaptcha-response"]` populated
  //
  // The click + wait is the entire "solve." The challenge JS runs
  // inside the iframe under Cloudflare/Google's origin — we can't
  // touch it directly. What we CAN do is trigger the click that
  // starts the challenge, then wait for the widget's host page to
  // receive the token via postMessage and inject it into the form.
  //
  // Honest limits:
  //   - "Invisible" Turnstile/reCAPTCHA-v3 doesn't need this method
  //     because there's no widget to click; the existing Tier 1
  //     humanization is what gets you past those.
  //   - When CF decides this user is suspicious enough to issue a
  //     full challenge image grid, this method won't help — the
  //     iframe will render the grid, our click won't solve it, and
  //     we'll time out with `solved: false`.
  async solveVisibleCaptcha(timeoutMs = 30000): Promise<CaptchaSolveResult> {
    if (!this.page) throw new Error("Browser not started");

    // Locate the widget. Turnstile and reCAPTCHA both use distinctive
    // iframe URLs that are easy to discriminate.
    const widget = await this.findCaptchaWidget();
    if (widget === null) return { found: false };

    // rc.33 — fingerprint probe. When tracing, dump the values
    // Cloudflare Turnstile (and other anti-bot solutions) actually
    // read: WebGL renderer/vendor strings, canvas hash, hw concurrency,
    // device memory, screen, languages, webdriver flag. Turnstile
    // error 600010 ("internal client execution error") usually points
    // at one of these returning something the challenge JS can't
    // handle (e.g. SwiftShader/llvmpipe renderer under Xvfb).
    if (process.env.UNIVERSAL_BOT_CAPTCHA_TRACE === "1") {
      try {
        const fp = await this.page.evaluate(() => {
          const out: Record<string, unknown> = {};
          try {
            const c = document.createElement("canvas");
            const gl =
              (c.getContext("webgl2") as WebGL2RenderingContext | null) ??
              (c.getContext("webgl") as WebGLRenderingContext | null);
            if (gl !== null) {
              out.webglVendor = gl.getParameter(gl.VENDOR);
              out.webglRenderer = gl.getParameter(gl.RENDERER);
              out.webglVersion = gl.getParameter(gl.VERSION);
              out.webglShadingLanguageVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
              const dbg = gl.getExtension("WEBGL_debug_renderer_info");
              if (dbg !== null) {
                out.webglUnmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
                out.webglUnmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
              }
              out.webglExtensions = (gl.getSupportedExtensions() ?? []).slice(0, 6).join(",");
            } else {
              out.webglVendor = null;
            }
          } catch (e) {
            out.webglError = String(e);
          }
          try {
            const c2 = document.createElement("canvas");
            c2.width = 200;
            c2.height = 50;
            const ctx = c2.getContext("2d");
            if (ctx !== null) {
              ctx.textBaseline = "top";
              ctx.font = "14px Arial";
              ctx.fillStyle = "#f60";
              ctx.fillRect(125, 1, 62, 20);
              ctx.fillStyle = "#069";
              ctx.fillText("Cwm fjordbank glyphs vext quiz", 2, 15);
              out.canvas2dHash = c2.toDataURL().slice(-48);
            }
          } catch (e) {
            out.canvas2dError = String(e);
          }
          out.hardwareConcurrency = navigator.hardwareConcurrency;
          out.deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
          out.platform = navigator.platform;
          out.languages = navigator.languages.join(",");
          out.userAgent = navigator.userAgent;
          out.webdriver = navigator.webdriver;
          out.screen = {
            w: screen.width,
            h: screen.height,
            d: screen.colorDepth,
            availW: screen.availWidth,
            availH: screen.availHeight,
          };
          out.devicePixelRatio = window.devicePixelRatio;
          out.touchPoints = navigator.maxTouchPoints;
          return out;
        });
        console.error("[fingerprint] " + JSON.stringify(fp));
      } catch (err) {
        console.error(
          "[fingerprint] probe failed: " + (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // Click at the checkbox position. Turnstile's checkbox sits at
    // roughly (28, 32) inside its iframe (the iframe is typically
    // 300x65 with the box on the left). reCAPTCHA v2 checkbox is at
    // (30, 30) inside a 304x78 iframe. Both tolerate clicks anywhere
    // in the left 60px of the widget.
    const clickX = widget.box.x + 28;
    const clickY = widget.box.y + widget.box.height / 2;

    // Use the humanized path so the click looks like a real user
    // tapping the box (Cloudflare's post-click challenge correlates
    // mouse-entry velocity with bot-likelihood).
    //
    // rc.33 — pre-click reconnaissance. Without this, the trajectory
    // goes "last form field → straight to checkbox," which is too
    // direct: a human eyes the captcha, glances around the form, and
    // *then* approaches. Wander to a point above the widget first,
    // dwell as if reading, then bezier in. The dwell also widens the
    // scoring window so Cloudflare has more session-level entropy to
    // grade before the click lands.
    if (this.humanize) {
      const wanderX = widget.box.x + widget.box.width / 2 + rand(-40, 40);
      const wanderY = widget.box.y - rand(60, 110);
      await this.bezierMouseTo(wanderX, wanderY);
      await this.sleep(rand(600, 1400));
      await this.bezierMouseTo(clickX, clickY);
      await this.sleep(rand(180, 450));
    }
    await this.page.mouse.click(clickX, clickY);
    this.mouseX = clickX;
    this.mouseY = clickY;

    // Poll for the success token. We check both Turnstile and reCAPTCHA
    // selectors because some sites embed multiple widgets and we want
    // either to count.
    const start = Date.now();
    const pollIntervalMs = 500;
    while (Date.now() - start < timeoutMs) {
      await this.sleep(pollIntervalMs);
      const solved = await this.page.evaluate(() => {
        const turnstile = document.querySelector(
          'input[name="cf-turnstile-response"]',
        ) as HTMLInputElement | null;
        if (turnstile !== null && turnstile.value.length > 0) return true;
        const recaptcha = document.querySelector(
          'textarea[name="g-recaptcha-response"]',
        ) as HTMLTextAreaElement | null;
        if (recaptcha !== null && recaptcha.value.length > 0) return true;
        // hCaptcha populates its own response textarea on a passed
        // checkbox (plausible). Same shape as reCAPTCHA's.
        const hcaptcha = document.querySelector(
          'textarea[name="h-captcha-response"]',
        ) as HTMLTextAreaElement | null;
        if (hcaptcha !== null && hcaptcha.value.length > 0) return true;
        // Some Turnstile installs use a managed mode that emits its
        // own attribute on the host div when solved.
        const cfManaged = document.querySelector(".cf-turnstile[data-state='success']");
        if (cfManaged !== null) return true;
        return false;
      });
      if (solved) {
        if (widget.kind === "hcaptcha") {
          const settled = await this.waitForCaptchaChallengeToSettle(15_000, 10_000);
          if (!settled) return { found: true, solved: false, kind: widget.kind };
        }
        return { found: true, solved: true, kind: widget.kind };
      }
    }

    // Timed out — the challenge didn't pass. We don't loop or retry
    // because Cloudflare scoring is sticky for a given session; a
    // failed solve usually means the entire session is flagged and
    // further clicks won't help.
    return { found: true, solved: false, kind: widget.kind };
  }

  // Locates the captcha widget on the current page. Returns the
  // iframe's bounding box and which provider it is, or null if no
  // visible widget is present.
  //
  // rc.23 — two-phase detection:
  //   (1) Iframe-shape — fast path. Polls for up to 5s in case the
  //       widget's iframe is being injected by the host page's JS
  //       (Clerk installs Turnstile this way; the iframe is absent
  //       from the static HTML snapshot but materializes within a
  //       few seconds of the form rendering).
  //   (2) Host-element fallback — when no iframe ever appears
  //       (rare, but Cloudflare sometimes embeds the widget in a
  //       way the selector misses), find the hidden response input
  //       (cf-turnstile-response / g-recaptcha-response) and use
  //       its closest visible ancestor as the click target. The
  //       widget's click handler is registered on the host div, so
  //       a click inside the host box still triggers the challenge.
  private async findCaptchaWidget(): Promise<{
    kind: CaptchaKind;
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");

    // An INVISIBLE reCAPTCHA (api2/anchor with size=invisible — the
    // bottom-right badge) is score-mode: there is no checkbox to click, and
    // its token is emitted only when the form's submit handler calls
    // grecaptcha.execute(). It must NOT be treated as a solvable visible
    // widget. MEASURED on amplitude (2026-06-04): the badge iframe is
    // ~256×60, so it cleared the size filter below and got "found" + clicked;
    // the pre-submit token-poll then timed out and the bot escalated to
    // 2Captcha, which can't solve a score-mode widget (ERROR_CAPTCHA_
    // UNSOLVABLE) → captcha_blocked — even though our v3 score is ~1.0 and a
    // plain form-submit would have passed silently. Detect "invisible-only"
    // (badge present, no visible checkbox anchor, no rendered bframe grid) and
    // skip reCAPTCHA entirely so the signup proceeds to submit.
    const recaptchaInvisibleOnly = await this.page
      .evaluate(() => {
        const q = (s: string): boolean => document.querySelector(s) !== null;
        const visibleAnchor = Array.from(
          document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]'),
        ).some((f) => !/size=invisible/.test((f as HTMLIFrameElement).src));
        const bframe = (() => {
          const f = document.querySelector('iframe[src*="recaptcha/api2/bframe"]');
          if (f === null) return false;
          const r = f.getBoundingClientRect();
          return r.width > 30 && r.height > 30;
        })();
        const invisiblePresent =
          q('iframe[src*="recaptcha/api2/anchor"][src*="size=invisible"]') ||
          q(".grecaptcha-badge");
        return invisiblePresent && !visibleAnchor && !bframe;
      })
      .catch(() => false);

    // Phase 1: widget shape with polling. page.locator (unlike the
    // querySelector in detectCaptchaVariant) pierces OPEN shadow roots,
    // so the Cloudflare iframe is reachable even on modern shadow-DOM
    // Turnstile embeds. The `.cf-turnstile` host div is added as a
    // fallback for CLOSED-shadow embeds where the iframe isn't reachable
    // but the (light-DOM) host is — clicking the host box still triggers
    // the widget. This mirrors detectCaptchaVariant's iframe-OR-host
    // check so detection and solving agree (A4).
    //   Cloudflare Turnstile: src contains "challenges.cloudflare.com"
    //   reCAPTCHA v2:         src contains "recaptcha/api2"
    const iframeCandidates: Array<{
      kind: CaptchaKind;
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'iframe[src*="challenges.cloudflare.com"]' },
      // Visible reCAPTCHA only — the size=invisible anchor (score-mode badge)
      // is handled by the recaptchaInvisibleOnly skip above.
      {
        kind: "recaptcha",
        selector: 'iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])',
      },
      // hCaptcha's checkbox iframe (the anchor frame). Plausible and other
      // hCaptcha sites render this; clicking it ticks the box the same way
      // Turnstile/reCAPTCHA do.
      { kind: "hcaptcha", selector: 'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]' },
      { kind: "hcaptcha", selector: 'iframe[src*="newassets.hcaptcha.com"]' },
      // Host-div fallbacks (light DOM) — preferred order keeps the iframe
      // first when present (more precise click target).
      { kind: "turnstile", selector: ".cf-turnstile" },
      { kind: "turnstile", selector: "#clerk-captcha" },
      { kind: "hcaptcha", selector: ".h-captcha" },
    ];
    const iframeDeadline = Date.now() + 5000;
    while (Date.now() < iframeDeadline) {
      for (const { kind, selector } of iframeCandidates) {
        const locator = this.page.locator(selector);
        const count = await locator.count();
        if (count === 0) continue;
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          // Bounded + best-effort. boundingBox() carries Playwright's default
          // 30s actionability wait; an invisible-mode Turnstile (the kind
          // patchright + a residential IP pass silently) never stabilises into
          // a visible box, so the unguarded call burned the full 30s and THREW
          // — and because the form-fill runCaptchaGate path didn't catch it,
          // it aborted the whole signup (measured: cartesia, cron-job.org).
          // A short timeout + catch turns "no clickable widget here" into a
          // skip, matching the Phase-2 host walk-up's `.catch(() => null)`.
          const box = await el.boundingBox({ timeout: 1500 }).catch(() => null);
          if (box === null) continue;
          if (box.width < 50 || box.height < 30) continue;
          return { kind, box };
        }
      }
      await this.sleep(250);
    }

    // Phase 2: host-element fallback. The hidden response input is
    // injected by the captcha JS even before the iframe; locate it,
    // walk up to a visible ancestor, return that bounding box.
    const hostCandidates: Array<{
      kind: CaptchaKind;
      selector: string;
    }> = [
      { kind: "turnstile", selector: 'input[name="cf-turnstile-response"]' },
      { kind: "recaptcha", selector: 'textarea[name="g-recaptcha-response"]' },
      { kind: "hcaptcha", selector: 'textarea[name="h-captcha-response"]' },
    ];
    for (const { kind, selector } of hostCandidates) {
      // The invisible reCAPTCHA's hidden g-recaptcha-response textarea lives
      // INSIDE the .grecaptcha-badge (~256×60), so the walk-up below would
      // return the badge box and we'd click it — the exact bug. Skip it.
      if (kind === "recaptcha" && recaptchaInvisibleOnly) continue;
      const locator = this.page.locator(selector);
      const count = await locator.count();
      if (count === 0) continue;
      const box = await locator
        .first()
        .evaluate((input) => {
          // Walk up looking for an ancestor with a non-trivial layout
          // box. The hidden input itself has 0×0 dimensions; the
          // visible widget container (Cloudflare's `.cf-turnstile`,
          // Clerk's `#clerk-captcha`, or any styled wrapper) sits
          // 1–3 levels up.
          let el = input as HTMLElement;
          for (let depth = 0; depth < 6 && el !== null; depth++) {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 50 && rect.height >= 30) {
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            }
            const parent = el.parentElement;
            if (parent === null) break;
            el = parent;
          }
          return null;
        })
        .catch(() => null);
      if (box !== null) {
        return { kind, box };
      }
    }

    return null;
  }

  // Pure-read captcha classification for spike telemetry (T3.2).
  // Reports which captcha family is on the page and whether a solvable
  // image-grid challenge has actually rendered. Clicks nothing and
  // solves nothing — it cannot regress the Tier 2 solve path.
  // Best-effort: a page-eval failure (e.g. mid-navigation) reports
  // unknown / not-rendered rather than throwing.
  async detectCaptchaVariant(): Promise<{
    variant: CaptchaVariant;
    challengeRendered: boolean;
  }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const raw = await this.page.evaluate(() => {
        const present = (sel: string): boolean => document.querySelector(sel) !== null;
        const visible = (sel: string): boolean => {
          const el = document.querySelector(sel);
          if (el === null) return false;
          const r = el.getBoundingClientRect();
          return r.width > 30 && r.height > 30;
        };
        // The image-grid challenge frame: reCAPTCHA's `bframe`, or
        // hCaptcha's challenge frame. Turnstile and score-mode
        // reCAPTCHA never render a grid.
        const challengeRendered =
          visible('iframe[src*="recaptcha/api2/bframe"]') ||
          visible('iframe[src*="hcaptcha.com"][src*="challenge"]');
        let variant = "unknown";
        // Turnstile: modern Cloudflare renders its iframe inside a SHADOW
        // DOM, so `querySelector('iframe[src*=challenges.cloudflare.com]')`
        // misses it entirely (verified on demo.turnstile.workers.dev:
        // iframe selector false, cf-turnstile-response input true). Detect
        // via the response input + host div, which live in the light DOM —
        // the iframe is a fallback for older/non-shadow embeds.
        if (
          present('input[name="cf-turnstile-response"]') ||
          present(".cf-turnstile") ||
          present('iframe[src*="challenges.cloudflare.com"]')
        ) {
          variant = "turnstile";
        } else if (present('iframe[src*="hcaptcha.com"]')) {
          variant = "hcaptcha";
        } else if (present('iframe[src*="recaptcha/api2/anchor"]:not([src*="size=invisible"])')) {
          // VISIBLE checkbox anchor (size=normal) → clickable v2.
          variant = "recaptcha_v2";
        } else if (
          present(".grecaptcha-badge") ||
          present('iframe[src*="recaptcha/api2/anchor"][src*="size=invisible"]')
        ) {
          // Badge / size=invisible anchor and no clickable checkbox →
          // score-mode reCAPTCHA (passes on submit, nothing to click).
          variant = "recaptcha_v3";
        }
        return { variant, challengeRendered };
      });
      return {
        variant: isCaptchaVariant(raw.variant) ? raw.variant : "unknown",
        challengeRendered: raw.challengeRendered,
      };
    } catch {
      return { variant: "unknown", challengeRendered: false };
    }
  }

  // Tier 3 captcha-solver support — extract the reCAPTCHA sitekey
  // from the page so a third-party solver can submit it. Returns
  // null when no v2 widget is present (Tier 3 only handles v2;
  // Turnstile + reCAPTCHA v3 are scoring-based and solvers don't
  // help). Reads from the standard places sites declare it:
  //   1. <div class="g-recaptcha" data-sitekey="...">
  //   2. <iframe src="...?k=SITEKEY&...">  (api2/anchor frame)
  //
  // CRITICAL: only ever returns a GENUINE reCAPTCHA key. hCaptcha
  // (`.h-captcha`) and Turnstile (`.cf-turnstile`) ALSO publish a
  // `data-sitekey` attribute, so a bare `[data-sitekey]` selector
  // grabs the wrong provider's key and the caller ships it to
  // 2Captcha's `userrecaptcha` endpoint → ERROR_WRONG_GOOGLEKEY (the
  // plausible/hCaptcha case). The authoritative discriminator is the
  // key FORMAT: reCAPTCHA public keys always start with `6L`; hCaptcha
  // keys are UUIDs (`bc609205-…`); Turnstile keys start with `0x`. We
  // both scope the selector away from the other widgets AND gate on
  // the `6L` prefix, so no non-reCAPTCHA key can ever leak through.
  async extractRecaptchaSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const sitekey = await this.page.evaluate(() => {
        const isRecaptchaKey = (k: string | null): k is string =>
          k !== null && /^6L/.test(k) && k.length > 30;
        // 1. data-sitekey, but NOT on an hCaptcha/Turnstile widget (or
        //    nested inside one). Those publish data-sitekey too.
        const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-sitekey]")).filter(
          (el) => el.closest(".h-captcha, .cf-turnstile") === null,
        );
        for (const el of anchors) {
          const k = el.getAttribute("data-sitekey");
          if (isRecaptchaKey(k)) return k;
        }
        // 2. The api2/enterprise iframe src carries ?k=SITEKEY.
        const iframes = Array.from(
          document.querySelectorAll<HTMLIFrameElement>(
            'iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]',
          ),
        );
        for (const ifr of iframes) {
          const url = new URL(ifr.src);
          const k = url.searchParams.get("k");
          if (isRecaptchaKey(k)) return k;
        }
        return null;
      });
      return sitekey;
    } catch {
      return null;
    }
  }

  // Inject a 2Captcha-resolved token into the page's hidden
  // g-recaptcha-response textarea AND fire any onSuccess callback
  // the widget registered with grecaptcha.render(). Without firing
  // the callback the page often doesn't "see" the token even though
  // the DOM input is populated.
  //
  // Returns true on success, false if no recaptcha widget present.
  async injectRecaptchaToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const injected = await this.page.evaluate((tok: string) => {
        // 1. Populate every g-recaptcha-response textarea on the page
        //    (some pages render multiple widgets).
        const inputs = Array.from(
          document.querySelectorAll<HTMLTextAreaElement>(
            'textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]',
          ),
        );
        if (inputs.length === 0) return false;
        for (const input of inputs) {
          input.value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>("[data-hcaptcha-widget-id], .h-captcha"),
        )) {
          el.setAttribute("data-hcaptcha-response", tok);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const form = inputs[0]?.closest("form");
        form?.dispatchEvent(new Event("input", { bubbles: true }));
        form?.dispatchEvent(new Event("change", { bubbles: true }));
        // 2. Fire the widget's onSuccess callback if registered. The
        //    callbacks are stored on `___grecaptcha_cfg.clients`; the
        //    exact tree is undocumented and shifts across versions
        //    so a defensive walk is the only reliable way.
        try {
          const cfg = (
            window as unknown as {
              ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
            }
          ).___grecaptcha_cfg;
          if (cfg !== undefined && cfg.clients !== undefined) {
            const fire = (obj: unknown): void => {
              if (obj === null || typeof obj !== "object") return;
              for (const [, v] of Object.entries(obj as Record<string, unknown>)) {
                if (v === null || typeof v !== "object") continue;
                if (
                  "callback" in v &&
                  typeof (v as { callback: unknown }).callback === "function"
                ) {
                  try {
                    (v as { callback: (t: string) => void }).callback(tok);
                  } catch {
                    // best-effort — at worst we miss the callback,
                    // but the DOM input is populated which most
                    // sites' server-side validation reads.
                  }
                }
                fire(v);
              }
            };
            fire(cfg.clients);
          }
        } catch {
          // grecaptcha not on window — page may use a wrapper
          // (Stytch, Clerk). DOM injection is still in place.
        }
        return true;
      }, token);
      return injected;
    } catch {
      return false;
    }
  }

  // Cloudflare Turnstile sitekey. On the `.cf-turnstile` widget's
  // data-sitekey, or as the `0x…` path segment in the challenge iframe src
  // (challenges.cloudflare.com/.../0x4AAAAA…/…). Returns null when absent.
  async extractTurnstileSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        // Turnstile sitekeys are `0x` + ~22 base64url chars (e.g.
        // 0x4AAAAAADSpJWQOnICEKAwx). A site-embedded WIDGET exposes it; a
        // Cloudflare-MANAGED interstitial does not (it's injected, not in the
        // DOM) — those return null and the caller can't Tier-3 solve them.
        const isKey = (k: string | null | undefined): k is string =>
          k != null && /^0x[A-Za-z0-9_-]{18,}$/.test(k);
        // 1. data-sitekey on any element.
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-sitekey]"))) {
          const k = el.getAttribute("data-sitekey");
          if (isKey(k)) return k;
        }
        // 2. ANY iframe src carrying a 0x… sitekey (the challenge iframe path,
        //    or a query param). Not just challenges.cloudflare.com — some
        //    embeds proxy it.
        for (const ifr of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
          const src = ifr.src || "";
          const path = src.match(/\/(0x[A-Za-z0-9_-]{18,})(?:\/|$)/);
          if (path !== null && isKey(path[1])) return path[1] ?? null;
          try {
            const q = new URL(src).searchParams.get("sitekey");
            if (isKey(q)) return q;
          } catch {
            /* relative/blank src */
          }
        }
        // 3. Inline HTML: `sitekey: '0x…'`, `data-sitekey="0x…"`,
        //    `turnstile.render(el, { sitekey: '0x…' })`. Covers JS-config
        //    widgets that never set a DOM attribute.
        const html = document.documentElement.outerHTML;
        const m =
          html.match(/data-sitekey=["'](0x[A-Za-z0-9_-]{18,})/i) ??
          html.match(/sitekey["'\s:=]{1,4}["'](0x[A-Za-z0-9_-]{18,})/i);
        if (m !== null && isKey(m[1])) return m[1] ?? null;
        return null;
      });
    } catch {
      return null;
    }
  }

  // Inject a 2Captcha-resolved Turnstile token into the page's
  // cf-turnstile-response input(s) + dispatch input/change so the form's
  // submit handler sees it. Turnstile exposes no public callback-read API
  // (unlike grecaptcha), so DOM injection + events is the reliable path; the
  // server-side validation reads the input value. Returns true if an input
  // was populated.
  async injectTurnstileToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate((tok: string) => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            '[name="cf-turnstile-response"], [name^="cf-turnstile-response"], input[id^="cf-chl-widget"]',
          ),
        );
        if (inputs.length === 0) return false;
        for (const input of inputs) {
          (input as HTMLInputElement).value = tok;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }, token);
    } catch {
      return false;
    }
  }

  // Mint the score token for an INVISIBLE reCAPTCHA by calling
  // grecaptcha.execute() ourselves, then wait for g-recaptcha-response to
  // populate. MEASURED on amplitude (2026-06-04): an invisible reCAPTCHA's
  // token only exists once execute() runs, and amplitude's form REQUIRES it —
  // merely skipping the badge (not clicking it) left the textarea empty and
  // the submit silently no-op'd. With our ~1.0 v3 score, execute() returns a
  // passing token in ~1-3s, so the subsequent submit carries a valid token.
  // Handles both standard (grecaptcha) and enterprise (grecaptcha.enterprise)
  // namespaces. Returns true once a token is present. Best-effort: a missing
  // grecaptcha or an execute() throw resolves false (the form may still mint
  // it on its own submit handler).
  async triggerInvisibleRecaptcha(timeoutMs = 9000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const tokenPresent = (): Promise<boolean> => this.hasCaptchaResponseToken();

    if (await tokenPresent()) return true;

    const fired = await this.page
      .evaluate(() => {
        const w = window as unknown as {
          grecaptcha?: {
            execute?: (widgetId?: number) => void;
            enterprise?: { execute?: (widgetId?: number) => void };
          };
          // grecaptcha stashes every rendered widget here, keyed by its
          // numeric widget id. amplitude (and many SPAs) render the invisible
          // widget with an EXPLICIT id, and a bare grecaptcha.execute() with
          // no id throws "No reCAPTCHA clients exist" — MEASURED as "token not
          // minted" on amplitude. Enumerate the clients and execute each by id.
          ___grecaptcha_cfg?: { clients?: Record<string, unknown> };
        };
        const g = w.grecaptcha;
        if (g === undefined) return false;
        let any = false;
        const ids = (() => {
          try {
            return Object.keys(w.___grecaptcha_cfg?.clients ?? {});
          } catch {
            return [];
          }
        })();
        for (const id of ids) {
          const n = Number(id);
          if (!Number.isFinite(n)) continue;
          try {
            g.enterprise?.execute?.(n);
            any = true;
          } catch {
            /* not this namespace */
          }
          try {
            g.execute?.(n);
            any = true;
          } catch {
            /* widget already executed / wrong namespace */
          }
        }
        // Fallback: no enumerable clients — try the bare (first-widget) call,
        // enterprise first (a v2-invisible page exposes plain execute()).
        if (!any) {
          try {
            if (typeof g.enterprise?.execute === "function") {
              g.enterprise.execute();
              any = true;
            } else if (typeof g.execute === "function") {
              g.execute();
              any = true;
            }
          } catch {
            return false;
          }
        }
        return any;
      })
      .catch(() => false);
    if (!fired) return false;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(500);
      if (await tokenPresent()) return true;
    }
    return false;
  }

  async hasCaptchaResponseToken(): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    return this.page
      .evaluate(() => {
        const hasValue = (selector: string): boolean => {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
          return el !== null && el.value.trim().length > 0;
        };
        return (
          hasValue('textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]') ||
          hasValue('textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"]') ||
          hasValue('input[name="cf-turnstile-response"], input[id^="cf-chl-widget"]') ||
          document.querySelector(".cf-turnstile[data-state='success']") !== null
        );
      })
      .catch(() => false);
  }

  async waitForCaptchaResponseToken(timeoutMs = 5000): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const start = Date.now();
    do {
      if (await this.hasCaptchaResponseToken()) return true;
      await this.sleep(250);
    } while (Date.now() - start < timeoutMs);
    return false;
  }

  // Tier 3 hCaptcha support — extract the hCaptcha sitekey so 2Captcha
  // can solve it. hCaptcha publishes its key on `.h-captcha[data-sitekey]`
  // or in the checkbox iframe's `?sitekey=` query. Keys are UUIDs (the
  // reCAPTCHA `6L` guard in extractRecaptchaSitekey deliberately rejects
  // them, which is why hCaptcha needs its own extractor). Returns null
  // when no hCaptcha widget is present.
  async extractHcaptchaSitekey(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const fromDom = await this.page.evaluate(() => {
        const div = document.querySelector<HTMLElement>(
          ".h-captcha[data-sitekey], [data-hcaptcha-sitekey]",
        );
        if (div !== null) {
          const k = div.getAttribute("data-sitekey") ?? div.getAttribute("data-hcaptcha-sitekey");
          if (k !== null && k.length > 10) return k;
        }
        const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]');
        if (iframe !== null) {
          const url = new URL(iframe.src);
          const k =
            url.searchParams.get("sitekey") ??
            new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash).get(
              "sitekey",
            );
          if (k !== null && k.length > 10) return k;
        }
        return null;
      });
      if (fromDom !== null) return fromDom;
      // INVISIBLE hCaptcha (Hugging Face, Stripe): no .h-captcha div, no
      // iframe `?sitekey=` param — the sitekey lives in the page's JS/JSON
      // config (`captchaApiKey`, `express_hcaptcha_site_key`,
      // `hcaptcha_login_main_site_key`, etc.). Scan the HTML for a UUID-shaped
      // key next to a sitekey/captcha hint, but only when an hCaptcha marker is
      // present so an unrelated config UUID cannot match.
      const html = await this.page.evaluate(() => document.documentElement.outerHTML);
      return extractHcaptchaSitekeyFromHtml(html);
    } catch {
      return null;
    }
  }

  async getBrowserUserAgent(): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => navigator.userAgent);
    } catch {
      return null;
    }
  }

  async getHcaptchaSolveContext(): Promise<{
    invisible: boolean;
    userAgent: string | null;
    rqdata: string | null;
  }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      return await this.page.evaluate(() => {
        let invisible = false;
        let rqdata: string | null = null;
        const useRqdata = (value: string | null): void => {
          if (rqdata === null && value !== null && value.trim().length > 0) rqdata = value;
        };
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(".h-captcha, [data-hcaptcha-widget-id]"),
        )) {
          const size = el.getAttribute("data-size") ?? el.getAttribute("size");
          if (size?.toLowerCase() === "invisible") invisible = true;
          useRqdata(el.getAttribute("data-rqdata"));
        }
        for (const iframe of Array.from(
          document.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]'),
        )) {
          try {
            const url = new URL(iframe.src);
            const hashParams = new URLSearchParams(
              url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
            );
            const size = url.searchParams.get("size") ?? hashParams.get("size");
            const frame = url.searchParams.get("frame") ?? hashParams.get("frame");
            useRqdata(url.searchParams.get("rqdata") ?? hashParams.get("rqdata"));
            const clientOptions =
              url.searchParams.get("clientOptions") ?? hashParams.get("clientOptions");
            if (clientOptions !== null) {
              try {
                const parsed = JSON.parse(clientOptions) as { rqdata?: unknown };
                if (typeof parsed.rqdata === "string") useRqdata(parsed.rqdata);
              } catch {
                // ignore non-JSON client options
              }
            }
            if (
              size?.toLowerCase() === "invisible" ||
              frame?.toLowerCase() === "checkbox-invisible"
            ) {
              invisible = true;
            }
          } catch {
            // ignore malformed extension/proxy iframe URLs
          }
        }
        return { invisible, userAgent: navigator.userAgent, rqdata };
      });
    } catch {
      return {
        invisible: false,
        userAgent: await this.getBrowserUserAgent().catch(() => null),
        rqdata: null,
      };
    }
  }

  // Inject a 2Captcha-resolved hCaptcha token into the page's
  // h-captcha-response textarea(s), update hCaptcha runtime response
  // accessors, and fire registered callbacks. Mirrors injectRecaptchaToken;
  // hCaptcha also mirrors the response token into a g-recaptcha-response
  // textarea on some compat installs, so populate both names if present.
  async injectHcaptchaToken(token: string): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const responseKey = extractHcaptchaResponseKeyFromToken(token);
      const diag = await this.page.evaluate(
        ({ tok, key }: { tok: string; key: string | null }) => {
          const widgetIds = new Set<string>();
          const inputs = Array.from(
            document.querySelectorAll<HTMLTextAreaElement>(
              'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"], textarea[name="g-recaptcha-response"]',
            ),
          );
          for (const input of inputs) {
            input.value = tok;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          for (const host of Array.from(
            document.querySelectorAll<HTMLElement>(
              ".h-captcha, [data-hcaptcha-widget-id], [data-hcaptcha-response]",
            ),
          )) {
            host.setAttribute("data-hcaptcha-response", tok);
            const id =
              host.getAttribute("data-hcaptcha-widget-id") ??
              host.getAttribute("data-hcaptcha-widget-id".toLowerCase());
            if (id !== null && id.length > 0) widgetIds.add(id);
            host.dispatchEvent(new Event("input", { bubbles: true }));
            host.dispatchEvent(new Event("change", { bubbles: true }));
          }
          for (const iframe of Array.from(
            document.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]'),
          )) {
            try {
              const url = new URL(iframe.src);
              const params = new URLSearchParams(
                url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
              );
              const id = params.get("id");
              if (id !== null && id.length > 0) widgetIds.add(id);
            } catch {
              // ignore malformed extension/proxy iframe URLs
            }
          }

          const win = window as unknown as Record<string, unknown>;
          const hcaptcha = win.hcaptcha as
            | {
                getResponse?: (id?: string) => string;
                getRespKey?: (id?: string) => string;
              }
            | undefined;
          if (hcaptcha !== undefined) {
            const originalGetResponse = hcaptcha.getResponse?.bind(hcaptcha);
            const originalGetRespKey = hcaptcha.getRespKey?.bind(hcaptcha);
            hcaptcha.getResponse = (id?: string) => {
              if (id === undefined || widgetIds.size === 0 || widgetIds.has(String(id))) return tok;
              return originalGetResponse?.(id) ?? tok;
            };
            hcaptcha.getRespKey = (id?: string) => {
              if (id === undefined || widgetIds.size === 0 || widgetIds.has(String(id)))
                return key ?? "";
              return originalGetRespKey?.(id) ?? key ?? "";
            };
          }

          let callbackFired = false;
          const fire = (fn: unknown): void => {
            if (typeof fn !== "function") return;
            callbackFired = true;
            try {
              (fn as (t: string, k?: string) => void)(tok, key ?? undefined);
            } catch {
              // A page callback can be stale after React remounts a widget.
            }
          };

          // Fire callbacks registered by markup, e.g. data-callback="onSubmit".
          try {
            for (const host of Array.from(
              document.querySelectorAll<HTMLElement>(".h-captcha[data-callback]"),
            )) {
              const name = host.getAttribute("data-callback");
              if (name !== null && name !== undefined) fire(win[name]);
            }
          } catch {
            // no named callback, continue to runtime config scan.
          }

          // Programmatic hCaptcha integrations pass function callbacks to
          // hcaptcha.render(). The SDK keeps them in ___hcaptcha_cfg; crawl it
          // generically so React/Vue wrappers are handled like plain forms.
          const seen = new Set<unknown>();
          const scan = (value: unknown, depth: number): void => {
            if (value === null || value === undefined || depth > 7 || seen.has(value)) return;
            seen.add(value);
            if (typeof value === "function") return;
            if (typeof value !== "object") return;
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
              const normalized = key.toLowerCase();
              if (
                typeof child === "function" &&
                (normalized === "callback" ||
                  normalized === "success-callback" ||
                  normalized === "verify-callback" ||
                  normalized === "onverify" ||
                  normalized === "onsuccess")
              ) {
                fire(child);
                continue;
              }
              if (typeof child === "object" && child !== null) scan(child, depth + 1);
            }
          };
          scan(win.___hcaptcha_cfg, 0);
          scan(win.hcaptcha, 0);

          return {
            ok: inputs.length > 0 || widgetIds.size > 0 || callbackFired,
            textareas: inputs.length,
            widgets: widgetIds.size,
            callbackFired,
            hasHcaptchaGlobal: win.hcaptcha !== undefined,
          };
        },
        { tok: token, key: responseKey },
      );
      if (process.env.UNIVERSAL_BOT_OAUTH_DEBUG) {
        console.error(
          `[captcha] hCaptcha inject diag: ok=${diag.ok} textareas=${diag.textareas} ` +
            `widgets=${diag.widgets} callbackFired=${diag.callbackFired} hcaptchaGlobal=${diag.hasHcaptchaGlobal}`,
        );
      }
      return diag.ok;
    } catch {
      return false;
    }
  }

  async solveVisibleHcaptchaChallengeWithCoordinates(
    solve: (input: {
      imageBase64: string;
      comment?: string;
      minClicks?: number;
      maxClicks?: number;
    }) => Promise<TwoCaptchaCoordinatesResult>,
  ): Promise<HcaptchaCoordinateSolveResult> {
    if (!this.page) throw new Error("Browser not started");

    const challenge = await this.findVisibleHcaptchaChallengeFrame();
    if (challenge === null) {
      return { found: false, solved: false, reason: "no_visible_challenge" };
    }

    let shot: Buffer;
    try {
      shot = await challenge.locator.screenshot({ type: "png", timeout: 8_000 });
    } catch (err) {
      return {
        found: true,
        solved: false,
        reason: `screenshot_failed:${err instanceof Error ? err.message : String(err)}`,
        clicks: 0,
      };
    }

    const dims = pngDimensions(shot);
    if (dims === null || dims.width <= 0 || dims.height <= 0) {
      return {
        found: true,
        solved: false,
        reason: "invalid_challenge_screenshot",
        clicks: 0,
      };
    }

    const solveRes = await solve({
      imageBase64: shot.toString("base64"),
      comment:
        "hCaptcha challenge screenshot. Click all matching image targets requested by the prompt. If a Verify or Submit button is visible, click it after selecting targets.",
      minClicks: 1,
      maxClicks: 12,
    });
    if (solveRes.kind !== "ok") {
      return {
        found: true,
        solved: false,
        reason: `2captcha_${solveRes.kind}` + ("reason" in solveRes ? `:${solveRes.reason}` : ""),
        clicks: 0,
        ...("durationMs" in solveRes ? { durationMs: solveRes.durationMs } : {}),
      };
    }

    let clicks = 0;
    for (const point of solveRes.coordinates) {
      const box = await challenge.locator.boundingBox({ timeout: 1_500 }).catch(() => null);
      if (box === null || box.width <= 0 || box.height <= 0) break;
      const x = box.x + (point.x / dims.width) * box.width;
      const y = box.y + (point.y / dims.height) * box.height;
      await this.bezierMouseTo(x, y);
      await this.sleep(rand(100, 260));
      await this.page.mouse.click(x, y);
      this.mouseX = x;
      this.mouseY = y;
      clicks += 1;
    }

    await this.sleep(650);
    let settled = await this.waitForCaptchaChallengeToSettle(2_500).catch(() => false);
    if (!settled && clicks > 0) {
      const box = await challenge.locator.boundingBox({ timeout: 1_500 }).catch(() => null);
      if (box !== null && box.width > 0 && box.height > 0) {
        const verifyX = box.x + Math.min(box.width - 32, Math.max(32, box.width * 0.84));
        const verifyY = box.y + Math.min(box.height - 24, Math.max(24, box.height * 0.92));
        await this.bezierMouseTo(verifyX, verifyY);
        await this.sleep(rand(120, 320));
        await this.page.mouse.click(verifyX, verifyY);
        this.mouseX = verifyX;
        this.mouseY = verifyY;
      }
      settled = await this.waitForCaptchaChallengeToSettle(10_000).catch(() => false);
    }

    const responsePresent = await this.page
      .evaluate(() => {
        const ta = document.querySelector(
          'textarea[name="h-captcha-response"], textarea[id^="h-captcha-response"]',
        ) as HTMLTextAreaElement | null;
        return ta !== null && ta.value.length > 0;
      })
      .catch(() => false);

    const out: HcaptchaCoordinateSolveResult = {
      found: true,
      solved: settled || responsePresent,
      clicks,
      durationMs: solveRes.durationMs,
    };
    if (!out.solved) out.reason = "challenge_still_visible";
    return out;
  }

  private async findVisibleHcaptchaChallengeFrame(): Promise<{
    locator: Locator;
    box: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!this.page) throw new Error("Browser not started");
    const selectors = [
      'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
      'iframe[src*="newassets.hcaptcha.com"][src*="frame=challenge"]',
      'iframe[src*="hcaptcha.com"][src*="/challenge"]',
      'iframe[src*="newassets.hcaptcha.com"][src*="/challenge"]',
    ];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = this.page.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          const box = await el.boundingBox({ timeout: 1_000 }).catch(() => null);
          if (box === null) continue;
          if (box.width < 180 || box.height < 160) continue;
          return { locator: el, box };
        }
      }
      await this.sleep(250);
    }
    return null;
  }

  async waitForCaptchaChallengeToSettle(timeoutMs = 4000, stableClearMs = 2_500): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    const hasVisibleChallenge = async (): Promise<boolean> =>
      await this.page!.evaluate(() => {
        const visible = (el: Element): boolean => {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        };
        const selectors = [
          'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
          'iframe[src*="newassets.hcaptcha.com"][src*="frame=challenge"]',
          'iframe[src*="recaptcha/api2/bframe"]',
          'iframe[src*="challenges.cloudflare.com"]',
        ];
        return selectors.some((sel) =>
          Array.from(document.querySelectorAll(sel)).some((el) => visible(el)),
        );
      });
    const deadline = Date.now() + timeoutMs;
    let clearSince: number | null = null;
    while (Date.now() < deadline) {
      const visible = await hasVisibleChallenge().catch(() => false);
      if (!visible) {
        clearSince ??= Date.now();
        if (Date.now() - clearSince >= stableClearMs) return true;
      } else {
        clearSince = null;
      }
      await this.sleep(250);
    }
    return false;
  }

  // Small mouse wiggle near the current position. Used during prewarm
  // so the page sees pointer events before we navigate away.
  private async jitterMouse(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    const wiggles = rand(2, 5);
    for (let i = 0; i < wiggles; i++) {
      const nx = this.mouseX + rand(-50, 50);
      const ny = this.mouseY + rand(-50, 50);
      await this.page.mouse.move(nx, ny);
      this.mouseX = nx;
      this.mouseY = ny;
      await this.sleep(rand(40, 120));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async wait(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  async screenshot(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: JPEG quality=70 yields ~250-400KB vs PNG's 1-3MB, with
    // no loss of legibility for the planner (Claude reads button
    // labels, not pixel detail). Smaller upload + faster Claude
    // tokenization saves ~300-500ms per planner round, and there
    // are 8-15 rounds per signup.
    const buffer = await this.page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 70,
      timeout: 8_000,
    });
    return buffer.toString("base64");
  }

  async getState(): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not started");
    // page.content() / page.title() / screenshot() all throw
    // "Execution context was destroyed" when the page is mid-
    // navigation — common after an OAuth-button click that kicks off
    // a 3-5 hop redirect chain (sentry.io → accounts.google.com →
    // consent → callback → onboarding). Retry once after a short
    // settle: most navigations finish in <500ms even on slow links.
    try {
      return await this.snapshotState();
    } catch {
      await this.wait(0.8);
      return await this.snapshotState();
    }
  }

  private async snapshotState(): Promise<BrowserState> {
    if (!this.page) throw new Error("Browser not started");
    return {
      url: this.page.url(),
      title: await this.page.title(),
      html: await this.page.content(),
      screenshot: await this.screenshot().catch(() => ""),
    };
  }

  async extractText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return (await this.page.textContent("body")) || "";
  }

  // RENDERED, visibility-respecting body text. extractText() reads
  // textContent("body"), which includes display:none / visibility:hidden /
  // off-screen nodes — so a fully-rendered dashboard whose DOM merely
  // CONTAINS a hidden skeleton / "Loading…" / "Please wait 30 seconds…"
  // string (Next.js RSC inline payloads, lazy placeholders, aria-hidden
  // spinners) reads as still-loading and false-trips the loading-shell gate.
  // innerText is layout-aware: it omits hidden text and reflects what a user
  // would actually see. Use this for the SHELL decision ONLY — credential/key
  // extraction and wall-text checks deliberately read RAW text via
  // extractText() and must stay byte-identical, so this is purely additive.
  async extractVisibleText(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(extractObservationVisibleText);
  }

  async readCheckoutSummary(fallbackCurrency?: string): Promise<CheckoutSummary> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const identity = await page.evaluate(() => ({
      title: document.title,
      siteName:
        document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ??
        document.querySelector<HTMLElement>('[itemprop="merchant"]')?.textContent ??
        "",
    }));
    const frames = await this.visibleTrustedCheckoutFrames();
    const parsedFrames = await Promise.all(
      frames.map(async (frame) => {
        const [text, structuredExtract] = await Promise.all([
          scopedOrderSummaryText(await frame.evaluate(extractCheckoutSummaryText).catch(() => "")),
          frame.evaluate(extractStructuredCheckoutData).catch(() => null),
        ]);
        const parsedAmounts = parseCheckoutAmountsResult([text], fallbackCurrency);
        const textAmount = parsedAmounts.payableAmounts.at(-1) ?? parsedAmounts.amounts.at(-1);
        return {
          amount: textAmount ?? parseStructuredCheckoutTotal([structuredExtract]),
          currencyUnresolved: parsedAmounts.currencyUnresolved,
          fallbackCurrencyScaleMismatch: parsedAmounts.fallbackCurrencyScaleMismatch,
        };
      }),
    );
    if (parsedFrames.some((parsed) => parsed.currencyUnresolved)) {
      throw new Error("payment_checkout_currency_unresolved");
    }
    if (parsedFrames.some((parsed) => parsed.fallbackCurrencyScaleMismatch)) {
      throw new Error("payment_checkout_currency_unresolved_scale_mismatch");
    }
    // Structured-data order total (schema.org Order/Invoice.totalPaymentDue).
    // Used only when the visible text yields no clean labeled total: a
    // structured total that CONTRADICTS a clean visible one can't be confirmed
    // current (stale server-rendered JSON-LD is a real pattern), so the total
    // the user actually sees wins; when both agree the value is identical
    // either way. Net effect: structured data only ever rescues a
    // total_not_found, never overrides the text path or its currency guards.
    const mainAmount = parsedFrames[0]?.amount ?? null;
    const childAmounts = parsedFrames
      .slice(1)
      .map((parsed) => parsed.amount)
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

  async readCheckoutConfirmSummary(): Promise<CheckoutSummary> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const identity = await page.evaluate(() => ({
      title: document.title,
      siteName:
        document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ??
        document.querySelector<HTMLElement>('[itemprop="merchant"]')?.textContent ??
        "",
    }));
    const frames = await this.visibleTrustedCheckoutFrames();
    const parsedFrames = await Promise.all(
      frames.map(async (frame) =>
        parseCheckoutConfirmAmountResult([
          scopedOrderSummaryText(
            await frame.evaluate(extractCheckoutConfirmSummaryText).catch(() => ""),
          ),
        ]),
      ),
    );
    if (parsedFrames.some((parsed) => parsed.currencyUnresolved)) {
      throw new Error("payment_checkout_currency_unresolved");
    }
    const mainAmount = parsedFrames[0]?.amount ?? null;
    const childAmounts = parsedFrames
      .slice(1)
      .map((parsed) => parsed.amount)
      .filter((amount): amount is NonNullable<typeof amount> => amount !== null);
    const amount = mainAmount ?? childAmounts[0] ?? null;
    if (amount === null) throw new Error("payment_checkout_total_not_found");
    if (
      childAmounts.some(
        (child) => child.amount_cents !== amount.amount_cents || child.currency !== amount.currency,
      )
    ) {
      throw new Error("payment_checkout_total_conflict");
    }
    return {
      merchant: merchantFromPage(identity.title, identity.siteName, page.url()),
      checkout_origin: new URL(page.url()).origin,
      ...amount,
    };
  }

  private async visibleTrustedCheckoutFrames(): Promise<Frame[]> {
    if (!this.page) return [];
    const page = this.page;
    const pageUrl = page.url();
    const mainFrame = page.mainFrame();
    const visible: Frame[] = [mainFrame];
    for (const frame of page.frames()) {
      if (frame === mainFrame || !recognizedPaymentProviderFrame(frame.url(), pageUrl)) continue;
      let current: Frame | null = frame;
      let trustedAndVisible = true;
      while (current !== null && current !== mainFrame) {
        if (!recognizedPaymentProviderFrame(current.url(), pageUrl)) {
          trustedAndVisible = false;
          break;
        }
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
              trustedAndVisible = false;
              break;
            }
          } finally {
            await owner.dispose().catch(() => undefined);
          }
        } catch {
          trustedAndVisible = false;
          break;
        }
        current = current.parentFrame();
      }
      if (trustedAndVisible && current === mainFrame) visible.push(frame);
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
  async readCheckoutReviewSummary(fallbackCurrency?: string): Promise<CheckoutSummary> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const identity = await page.evaluate(() => ({
      title: document.title,
      siteName:
        document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')?.content ??
        document.querySelector<HTMLElement>('[itemprop="merchant"]')?.textContent ??
        "",
    }));
    const [texts, structuredExtracts] = await Promise.all([
      Promise.all(
        page
          .frames()
          .map(async (frame) =>
            scopedOrderSummaryText(
              await frame.evaluate(extractCheckoutSummaryText).catch(() => ""),
            ),
          ),
      ),
      Promise.all(
        page
          .frames()
          .map(async (frame) => frame.evaluate(extractStructuredCheckoutData).catch(() => null)),
      ),
    ]);
    // Same structured-data precedence as readCheckoutSummary: a machine-
    // readable order total fills in only when no clean labeled text total
    // exists, so the settled-amount contract (readSettledCheckoutReviewSummary
    // re-reads until two consecutive reads agree) is unchanged — a structured
    // total is simply re-read and must be stable like any other source.
    const parsedAmounts = parseCheckoutAmountsResult(texts, fallbackCurrency);
    const textAmount = parsedAmounts.payableAmounts.at(-1) ?? parsedAmounts.amounts.at(-1);
    const structuredAmount =
      textAmount === undefined ? parseStructuredCheckoutTotal(structuredExtracts) : null;
    if (structuredAmount !== null && parsedAmounts.currencyUnresolved) {
      throw new Error("payment_checkout_currency_unresolved");
    }
    if (structuredAmount !== null && parsedAmounts.fallbackCurrencyScaleMismatch) {
      throw new Error("payment_checkout_currency_unresolved_scale_mismatch");
    }
    const amount = textAmount ?? structuredAmount ?? undefined;
    if (amount === undefined) throw new Error("payment_checkout_total_not_found");
    return {
      merchant: merchantFromPage(identity.title, identity.siteName, page.url()),
      checkout_origin: new URL(page.url()).origin,
      ...amount,
    };
  }

  async readCheckoutReviewLineItems(): Promise<Array<{ title: string; quantity: number }>>;
  async readCheckoutReviewLineItems(includeDetails: true): Promise<
    Array<{
      title: string;
      quantity: number;
      details: string;
      product_identities: string[];
      option_signatures: string[];
    }>
  >;
  async readCheckoutReviewLineItems(includeDetails = false): Promise<
    Array<{
      title: string;
      quantity: number;
      details?: string;
      product_identities?: string[];
      option_signatures?: string[];
    }>
  > {
    if (!this.page) throw new Error("Browser not started");
    const items = await this.page.evaluate(() => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const visible = (element: Element): boolean => {
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0)
          return false;
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

  async readSettledCheckoutReviewSummary(
    fallbackCurrency?: string,
    timeoutMs = 12_000,
  ): Promise<CheckoutReviewSummary | undefined> {
    if (!this.page) throw new Error("Browser not started");
    const deadline = Date.now() + timeoutMs;
    let previous: CheckoutReviewSummary | undefined;
    while (Date.now() < deadline) {
      const shippingReady = await this.page
        .evaluate(() => {
          const labels = Array.from(
            document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
          )
            .flatMap((input) => [
              ...(input.labels === null
                ? []
                : Array.from(input.labels, (label) => label.innerText)),
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
          this.readCheckoutReviewSummary(fallbackCurrency),
          this.readCheckoutReviewLineItems(),
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
      await this.page.waitForTimeout(250);
    }
    return undefined;
  }

  async isPayPalHostedCheckout(): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    // Key the refusal off the ACTUAL card (PAN) input's frame, not off "any
    // PayPal iframe on the page." Shopify checkout frames card entry in a
    // recognized PayPal-independent surface (checkout.pci.shopifyinc.com); a
    // PayPal EXPRESS button (an unfillable-wallet iframe, not card fields)
    // must not cause a false-positive refusal of a fillable checkout.
    const panFrame = await this.panFieldFrame();
    if (panFrame === null) return false;
    try {
      return isPayPalBraintreeHostedFieldsHost(new URL(panFrame.url()).hostname);
    } catch {
      return false;
    }
  }

  // The first frame that actually renders a visible card (PAN) input, or null.
  private async panFieldFrame(): Promise<Frame | null> {
    if (!this.page) return null;
    for (const frame of this.page.frames()) {
      const locator = frame.locator(CHECKOUT_PAN_FIELD_SELECTORS);
      const count = Math.min(await locator.count().catch(() => 0), 10);
      for (let i = 0; i < count; i += 1) {
        const input = locator.nth(i);
        if (
          (await input.isVisible().catch(() => false)) &&
          (await input.isEnabled().catch(() => false))
        ) {
          return frame;
        }
      }
    }
    return null;
  }

  // Bounded wait for a PAN field to appear anywhere on the page. A
  // single-page checkout's card entry can live in a cross-origin PCI iframe
  // (e.g. Shopify's checkout.pci.shopifyinc.com) that mounts only after the
  // payment section itself renders — later than the total becomes readable,
  // and later than the approval-ceremony wait that precedes this call ends.
  // fillAndSubmitCheckout/fillCheckoutCardFields used to take one frames()
  // snapshot at call time; a frame that hadn't mounted YET at that exact
  // instant made a genuinely fillable checkout fail closed.
  private async waitForPanField(timeoutMs: number): Promise<void> {
    if (!this.page) return;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if ((await this.panFieldFrame()) !== null) return;
      if (Date.now() >= deadline) return;
      await this.page.waitForTimeout(200).catch(() => undefined);
    }
  }

  // Common autocomplete/name selectors. No PSP-specific adapters. `frames` is
  // the caller's trust decision: fillAndSubmitCheckout passes every
  // CDP-reachable frame (single-page checkout — fill and charge in one vetted
  // call), fillCheckoutCardFields passes only recognized payment-provider
  // frames (split checkout — the filled card outlives the call).
  private async fillCheckoutCardIntoFrames(
    frames: readonly Frame[],
    card: CheckoutCard,
    billingOnly = false,
    assertFrameEgress?: (frame: Frame, resolvedOrigin?: string) => void,
  ): Promise<CheckoutCardGroupScope | undefined> {
    const filled = new Set<string>();
    const expiryMonthSelectors =
      '[autocomplete~="cc-exp-month"],[name*="exp_month" i],[name*="expmonth" i],[name*="exp" i][name*="month" i],[id*="exp" i][id*="month" i]';
    const expiryYearSelectors =
      '[autocomplete~="cc-exp-year"],[name*="exp_year" i],[name*="expyear" i],[name*="exp" i][name*="year" i],[id*="exp" i][id*="year" i]';
    const combinedExpirySelectors =
      'input[autocomplete~="cc-exp"],input[name*="expir" i]:not([name*="month" i]):not([name*="year" i]),input[name="exp" i],input[name*="exp-date" i],input[id*="expir" i]:not([id*="month" i]):not([id*="year" i]),input[id="exp" i],input[id*="exp-date" i],input[placeholder="MM/YY" i],input[placeholder="MM / YY" i],input[aria-label="MM/YY" i],input[aria-label="MM / YY" i],label:has-text("MM/YY") input,label:has-text("MM / YY") input';
    const combinedExpiryGroupSelectors =
      'input[autocomplete~="cc-exp"],input[name*="expir" i]:not([name*="month" i]):not([name*="year" i]),input[name="exp" i],input[name*="exp-date" i],input[id*="expir" i]:not([id*="month" i]):not([id*="year" i]),input[id="exp" i],input[id*="exp-date" i],input[placeholder="MM/YY" i],input[placeholder="MM / YY" i],input[aria-label="MM/YY" i],input[aria-label="MM / YY" i]';
    const cvvSelectors =
      'input[autocomplete~="cc-csc"],input[name*="cvv" i],input[name*="cvc" i],input[name*="security-code" i],input[id*="cvv" i],input[id*="cvc" i]';
    const nameSelectors =
      'input[autocomplete~="cc-name"],input[name*="cardholder" i],input[name*="card-name" i],input[id*="cardholder" i]';

    type CardGroup = CheckoutCardGroupRoot & { panTopmost: boolean };
    const groups = new Map<string, CardGroup>();
    let fillablePanCount = 0;
    let groupSequence = 0;
    await Promise.all(
      frames.map((frame) =>
        frame
          .locator(
            "[data-ts-payment-card-group],[data-ts-payment-card-control-group],[data-ts-payment-billing-context],[data-ts-payment-billing-owner],[data-ts-payment-frame-owner]",
          )
          .evaluateAll((elements) => {
            for (const element of elements) {
              element.removeAttribute("data-ts-payment-card-group");
              element.removeAttribute("data-ts-payment-card-control-group");
              element.removeAttribute("data-ts-payment-billing-context");
              element.removeAttribute("data-ts-payment-billing-owner");
              element.removeAttribute("data-ts-payment-frame-owner");
            }
          })
          .catch(() => undefined),
      ),
    );
    for (const [frameIndex, frame] of frames.entries()) {
      const pans = frame.locator(CHECKOUT_PAN_FIELD_SELECTORS);
      const count = Math.min(await pans.count().catch(() => 0), 10);
      for (let index = 0; index < count; index += 1) {
        const pan = pans.nth(index);
        if (!(await pan.isVisible().catch(() => false))) continue;
        if (!(await pan.isEnabled().catch(() => false))) continue;
        fillablePanCount += 1;
        const proposedToken = `ts-card-group-${groupSequence++}`;
        const group = await pan
          .evaluate(
            (input, selectors) => {
              const isFillable = (element: Element): boolean => {
                if (!(element instanceof HTMLElement)) return false;
                const control = element as HTMLInputElement | HTMLSelectElement;
                if (control.matches(":disabled") || element.getClientRects().length === 0) {
                  return false;
                }
                let current: Element | null = element;
                while (current !== null) {
                  const style = getComputedStyle(current);
                  if (
                    style.display === "none" ||
                    style.visibility === "hidden" ||
                    style.visibility === "collapse" ||
                    Number.parseFloat(style.opacity) <= 0
                  ) {
                    return false;
                  }
                  current = current.parentElement;
                }
                return true;
              };
              const ownedControls = (root: Element): Element[] =>
                root instanceof HTMLFormElement
                  ? Array.from(root.elements)
                  : Array.from(root.querySelectorAll("input,select,textarea,button"));
              const has = (root: Element, selector: string): boolean =>
                ownedControls(root).some(
                  (element) => element.matches(selector) && isFillable(element),
                );
              // Match the operator observation's actual rendered hit-test, rather
              // than trusting structural visibility. Shopify can mount two complete
              // PCI forms at once while one is covered by the other.
              const panTopmost = (): boolean => {
                const rect = input.getBoundingClientRect();
                if (rect.width < 1 || rect.height < 1) return false;
                const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
                const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
                let hit = document.elementFromPoint(x, y);
                if (hit === null) return false;
                while (hit.shadowRoot !== null) {
                  const deeper = hit.shadowRoot.elementFromPoint(x, y);
                  if (deeper === null || deeper === hit) break;
                  hit = deeper;
                }
                return hit === input || input.contains(hit);
              };
              const form = input instanceof HTMLInputElement ? input.form : input.closest("form");
              let root: Element | null = form ?? input.parentElement;
              while (root !== null && root !== document.body && root !== document.documentElement) {
                const hasCombinedExpiry = has(root, selectors.combinedExpiry);
                const hasSplitExpiry =
                  has(root, selectors.expiryMonth) && has(root, selectors.expiryYear);
                const complete =
                  has(root, selectors.pan) &&
                  has(root, selectors.cvv) &&
                  has(root, selectors.name) &&
                  (hasCombinedExpiry || hasSplitExpiry);
                if (complete) {
                  const existing = root.getAttribute("data-ts-payment-card-group");
                  const token = existing ?? selectors.token;
                  if (existing === null) root.setAttribute("data-ts-payment-card-group", token);
                  const controls = ownedControls(root);
                  for (const control of controls) {
                    control.setAttribute("data-ts-payment-card-control-group", token);
                  }
                  return {
                    token,
                    panTopmost: panTopmost(),
                  };
                }
                if (form !== null) break;
                root = root.parentElement;
              }
              return null;
            },
            {
              token: proposedToken,
              pan: CHECKOUT_PAN_FIELD_SELECTORS,
              cvv: cvvSelectors,
              name: nameSelectors,
              combinedExpiry: combinedExpiryGroupSelectors,
              expiryMonth: expiryMonthSelectors,
              expiryYear: expiryYearSelectors,
            },
          )
          .catch(() => null);
        if (group !== null) {
          groups.set(`${frameIndex}:${group.token}`, {
            frame,
            root: frame.locator(`[data-ts-payment-card-group="${group.token}"]`),
            token: group.token,
            panTopmost: group.panTopmost,
          });
        }
      }
    }

    let cardGroup: CardGroup | undefined;
    if (groups.size === 1) {
      cardGroup = [...groups.values()][0];
    } else if (groups.size > 1) {
      // A structurally complete PCI form may still be a covered duplicate. The
      // PAN's center-point hit-test is the decisive live signal: accept exactly
      // one rendered, non-occluded PAN and otherwise retain the fail-closed
      // ambiguity refusal. Do not rank by completeness or active state here.
      const topmost = [...groups.values()].filter((group) => group.panTopmost);
      if (topmost.length !== 1) throw new Error("payment_card_form_ambiguous");
      cardGroup = topmost[0];
    } else if (fillablePanCount > 1) {
      // Multiple PAN anchors with no single complete container are not safe to
      // combine. A provider topology with one PAN and separate hosted-field
      // frames remains supported by the cross-frame fallback below.
      throw new Error("payment_card_form_ambiguous");
    }

    const billingRoots: CheckoutPaymentFieldRoot[] = [];
    const addBillingRoot = async (frame: Frame, anchor: ElementHandle<Element>): Promise<void> => {
      const proposedToken = `ts-billing-context-${groupSequence++}`;
      const token = await anchor
        .evaluate((element, candidateToken) => {
          const isFillable = (control: Element): boolean => {
            if (!(control instanceof HTMLElement)) return false;
            if (control.matches(":disabled") || control.getClientRects().length === 0) {
              return false;
            }
            let current: Element | null = control;
            while (current !== null) {
              const style = getComputedStyle(current);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                Number.parseFloat(style.opacity) <= 0
              ) {
                return false;
              }
              current = current.parentElement;
            }
            return true;
          };
          const isExplicitBillingControl = (control: Element): boolean => {
            if (
              !(control instanceof HTMLInputElement) &&
              !(control instanceof HTMLSelectElement) &&
              !(control instanceof HTMLTextAreaElement)
            ) {
              return false;
            }
            const autocomplete = (control.getAttribute("autocomplete") ?? "")
              .toLowerCase()
              .split(/\s+/);
            return (
              autocomplete.includes("billing") ||
              /billing/i.test(control.getAttribute("name") ?? "") ||
              /billing/i.test(control.id)
            );
          };
          const paymentBoundaryIdentity = (candidate: Element): string =>
            [
              candidate.id,
              candidate.className,
              candidate.getAttribute("name"),
              candidate.getAttribute("aria-label"),
              candidate.getAttribute("data-step"),
              candidate.getAttribute("data-section"),
              candidate.getAttribute("data-testid"),
              candidate.getAttribute("data-payment-method"),
              candidate.getAttribute("data-payment-method-type"),
              candidate.getAttribute("data-payment-gateway"),
              candidate.getAttribute("data-gateway"),
              candidate.getAttribute("data-method"),
              candidate.getAttribute("data-provider"),
            ]
              .filter((value): value is string => typeof value === "string")
              .join(" ");
          const isPaymentBoundary = (candidate: Element): boolean =>
            /(?:^|[^a-z])(?:payment|billing|credit.?card)(?:[^a-z]|$)/i.test(
              paymentBoundaryIdentity(candidate),
            );
          const isPaymentMethodBoundary = (candidate: Element): boolean =>
            candidate.hasAttribute("data-ts-payment-frame-owner") ||
            candidate.hasAttribute("data-ts-payment-card-group") ||
            candidate.hasAttribute("data-payment-method") ||
            candidate.hasAttribute("data-payment-method-type") ||
            candidate.hasAttribute("data-payment-gateway") ||
            candidate.hasAttribute("data-gateway") ||
            candidate.hasAttribute("data-method") ||
            candidate.hasAttribute("data-provider") ||
            /(?:^|[^a-z])(?:payment|credit.?card|paypal|klarna|afterpay|shop.?pay|apple.?pay|google.?pay|bank.?transfer)(?:[^a-z]|$)/i.test(
              paymentBoundaryIdentity(candidate),
            );
          const isTopmost = (control: Element): boolean => {
            if (!(control instanceof HTMLElement)) return false;
            const rect = control.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return false;
            const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
            const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
            let hit = document.elementFromPoint(x, y);
            if (hit === null) return false;
            while (hit.shadowRoot !== null) {
              const deeper = hit.shadowRoot.elementFromPoint(x, y);
              if (deeper === null || deeper === hit) break;
              hit = deeper;
            }
            return hit === control || control.contains(hit);
          };
          const branchUnder = (root: Element, descendant: Element): Element => {
            let branch = descendant;
            while (branch.parentElement !== null && branch.parentElement !== root) {
              branch = branch.parentElement;
            }
            return branch;
          };
          let candidate = element.parentElement;
          while (
            candidate !== null &&
            candidate !== document.body &&
            candidate !== document.documentElement
          ) {
            if (
              isPaymentBoundary(candidate) &&
              Array.from(candidate.querySelectorAll("input,select,textarea")).some(
                (control) => isExplicitBillingControl(control) && isFillable(control),
              )
            ) {
              const frameOwners = Array.from(
                candidate.querySelectorAll("[data-ts-payment-frame-owner]"),
              );
              const cardGroups = Array.from(
                candidate.querySelectorAll("[data-ts-payment-card-group]"),
              );
              if (
                frameOwners.some((owner) => owner !== element) ||
                cardGroups.some((group) => group !== element)
              ) {
                return null;
              }
              const anchorBranch = branchUnder(candidate, element);
              const selectedLeafBoundary =
                frameOwners.length === 1 &&
                frameOwners[0] === element &&
                !Array.from(candidate.querySelectorAll("*")).some(
                  (descendant) =>
                    descendant !== element &&
                    !descendant.contains(element) &&
                    !isExplicitBillingControl(descendant) &&
                    isPaymentMethodBoundary(descendant),
                );
              let marked = 0;
              for (const control of Array.from(
                candidate.querySelectorAll("input,select,textarea"),
              )) {
                if (!isExplicitBillingControl(control) || !isFillable(control)) continue;
                if (!isTopmost(control)) continue;
                if (isPaymentMethodBoundary(control)) continue;
                const owner = control.getAttribute("data-ts-payment-card-control-group");
                const selectedOwner = element.getAttribute("data-ts-payment-card-group");
                if (owner !== null && owner !== selectedOwner) continue;
                const controlForm = control.closest("form");
                const sharesSelectedForm =
                  controlForm !== null && controlForm.contains(element);
                if (controlForm !== null && !sharesSelectedForm) continue;
                const hasSelectedOwner =
                  owner !== null && selectedOwner !== null && owner === selectedOwner;
                let nestedBoundary = control.parentElement;
                while (nestedBoundary !== null && nestedBoundary !== candidate) {
                  if (isPaymentMethodBoundary(nestedBoundary)) break;
                  nestedBoundary = nestedBoundary.parentElement;
                }
                if (
                  nestedBoundary !== null &&
                  nestedBoundary !== candidate &&
                  !nestedBoundary.contains(element)
                ) {
                  continue;
                }
                const controlBranch = branchUnder(candidate, control);
                if (
                  controlBranch !== anchorBranch &&
                  !sharesSelectedForm &&
                  !hasSelectedOwner &&
                  !selectedLeafBoundary
                ) {
                  continue;
                }
                control.setAttribute("data-ts-payment-billing-owner", candidateToken);
                marked += 1;
              }
              if (marked === 0) return null;
              candidate.setAttribute("data-ts-payment-billing-context", candidateToken);
              return candidateToken;
            }
            candidate = candidate.parentElement;
          }
          return null;
        }, proposedToken)
        .catch(() => null);
      await anchor.dispose().catch(() => undefined);
      if (token !== null) {
        billingRoots.push({ frame, token });
      }
    };
    if (cardGroup !== undefined) {
      const directToken = `ts-billing-context-${groupSequence++}`;
      const directCount = await cardGroup.root
        .locator("input,select,textarea")
        .evaluateAll(
          (controls, { token, groupToken, selectors }) => {
            const paymentBoundaryIdentity = (candidate: Element): string =>
              [
                candidate.id,
                candidate.className,
                candidate.getAttribute("name"),
                candidate.getAttribute("aria-label"),
                candidate.getAttribute("data-step"),
                candidate.getAttribute("data-section"),
                candidate.getAttribute("data-testid"),
                candidate.getAttribute("data-payment-method"),
                candidate.getAttribute("data-payment-method-type"),
                candidate.getAttribute("data-payment-gateway"),
                candidate.getAttribute("data-gateway"),
                candidate.getAttribute("data-method"),
                candidate.getAttribute("data-provider"),
              ]
                .filter((value): value is string => typeof value === "string")
                .join(" ");
            const isPaymentMethodBoundary = (candidate: Element): boolean =>
              candidate.hasAttribute("data-payment-method") ||
              candidate.hasAttribute("data-payment-method-type") ||
              candidate.hasAttribute("data-payment-gateway") ||
              candidate.hasAttribute("data-gateway") ||
              candidate.hasAttribute("data-method") ||
              candidate.hasAttribute("data-provider") ||
              /(?:^|[^a-z])(?:payment|card|credit.?card|paypal|klarna|afterpay|shop.?pay|apple.?pay|google.?pay|bank.?transfer)(?:[^a-z]|$)/i.test(
                paymentBoundaryIdentity(candidate),
              );
            const isPan = (input: Element): boolean => {
              const autocomplete = (input.getAttribute("autocomplete") ?? "")
                .toLowerCase()
                .split(/\s+/);
              return (
                autocomplete.includes("cc-number") ||
                /cardnumber/i.test(input.getAttribute("name") ?? "") ||
                /card-?number|cardnumber/i.test(input.id)
              );
            };
            const selectedPan = controls.find(
              (control) =>
                isPan(control) &&
                control.getAttribute("data-ts-payment-card-control-group") === groupToken,
            );
            const groupRoot = selectedPan?.closest("[data-ts-payment-card-group]") ?? null;
            const hasSelectedControl = (candidate: Element, selector: string): boolean =>
              controls.some(
                (control) =>
                  candidate.contains(control) &&
                  control.matches(selector) &&
                  control.getAttribute("data-ts-payment-card-control-group") === groupToken,
              );
            const isCompleteSelectedCardBranch = (candidate: Element): boolean =>
              hasSelectedControl(candidate, selectors.pan) &&
              hasSelectedControl(candidate, selectors.cvv) &&
              hasSelectedControl(candidate, selectors.name) &&
              (hasSelectedControl(candidate, selectors.combinedExpiry) ||
                (hasSelectedControl(candidate, selectors.expiryMonth) &&
                  hasSelectedControl(candidate, selectors.expiryYear)));
            let branchCandidate = selectedPan?.parentElement ?? null;
            let selectedBranch: Element | null = null;
            while (branchCandidate !== null) {
              if (
                isPaymentMethodBoundary(branchCandidate) &&
                isCompleteSelectedCardBranch(branchCandidate)
              ) {
                selectedBranch = branchCandidate;
                break;
              }
              if (branchCandidate === groupRoot) break;
              branchCandidate = branchCandidate.parentElement;
            }
            let marked = 0;
            for (const control of controls) {
              const autocomplete = (control.getAttribute("autocomplete") ?? "")
                .toLowerCase()
                .split(/\s+/);
              const explicit =
                autocomplete.includes("billing") ||
                /billing/i.test(control.getAttribute("name") ?? "") ||
                /billing/i.test(control.id);
              if (!explicit) continue;
              if (isPaymentMethodBoundary(control)) continue;
              const owner = control.getAttribute("data-ts-payment-card-control-group");
              if (owner !== null && owner !== groupToken) continue;
              if (selectedPan === undefined || selectedBranch === null) continue;
              if (!selectedBranch.contains(control)) continue;
              let paymentMethodBoundary = control.parentElement;
              while (
                paymentMethodBoundary !== null &&
                paymentMethodBoundary !== selectedBranch &&
                !isPaymentMethodBoundary(paymentMethodBoundary)
              ) {
                paymentMethodBoundary = paymentMethodBoundary.parentElement;
              }
              if (
                paymentMethodBoundary !== null &&
                paymentMethodBoundary !== selectedBranch &&
                !paymentMethodBoundary.contains(selectedPan)
              ) {
                continue;
              }
              control.setAttribute("data-ts-payment-billing-owner", token);
              marked += 1;
            }
            return marked;
          },
          {
            token: directToken,
            groupToken: cardGroup.token,
            selectors: {
              pan: CHECKOUT_PAN_FIELD_SELECTORS,
              cvv: cvvSelectors,
              name: nameSelectors,
              combinedExpiry: combinedExpiryGroupSelectors,
              expiryMonth: expiryMonthSelectors,
              expiryYear: expiryYearSelectors,
            },
          },
        )
        .catch(() => 0);
      if (directCount > 0) billingRoots.push({ frame: cardGroup.frame, token: directToken });

      const groupFrames = new Set([...groups.values()].map((group) => group.frame));
      for (const groupFrame of groupFrames) {
        let childFrame = groupFrame;
        let parentFrame = childFrame.parentFrame();
        while (parentFrame !== null && frames.includes(parentFrame)) {
          const frameElement = await childFrame.frameElement().catch(() => null);
          if (frameElement === null) break;
          await frameElement
            .evaluate((element, selected) => {
              element.setAttribute("data-ts-payment-frame-owner", selected ? "selected" : "other");
            }, groupFrame === cardGroup.frame)
            .catch(() => undefined);
          await frameElement.dispose().catch(() => undefined);
          childFrame = parentFrame;
          parentFrame = childFrame.parentFrame();
        }
      }

      const cardRoot = await cardGroup.root.elementHandle().catch(() => null);
      if (cardRoot !== null) await addBillingRoot(cardGroup.frame, cardRoot);
      let childFrame = cardGroup.frame;
      let parentFrame = childFrame.parentFrame();
      while (parentFrame !== null && frames.includes(parentFrame)) {
        const frameElement = await childFrame.frameElement().catch(() => null);
        if (frameElement === null) break;
        await addBillingRoot(parentFrame, frameElement);
        childFrame = parentFrame;
        parentFrame = childFrame.parentFrame();
      }
    }

    const fillFirst = async (
      field: string,
      value: string | undefined,
      selectors: string,
      typePerKey = false,
      withinCardGroup = false,
      withinBillingContext = false,
    ): Promise<boolean> => {
      if (value === undefined || value.length === 0) return false;
      const candidates: Array<{ frame: Frame; matches: Locator }> =
        withinCardGroup && cardGroup !== undefined
          ? [
              {
                frame: cardGroup.frame,
                matches: cardGroup.frame
                  .locator(selectors)
                  .and(
                    cardGroup.frame.locator(
                      `[data-ts-payment-card-control-group="${cardGroup.token}"]`,
                    ),
                  ),
              },
            ]
          : withinBillingContext
            ? billingRoots.map(({ frame, token }) => ({
                frame,
                matches: frame
                  .locator(selectors)
                  .and(frame.locator(`[data-ts-payment-billing-owner="${token}"]`)),
              }))
            : frames.map((frame) => ({ frame, matches: frame.locator(selectors) }));
      for (const { frame, matches } of candidates) {
        const count = Math.min(await matches.count().catch(() => 0), 10);
        for (let i = 0; i < count; i += 1) {
          const input = matches.nth(i);
          if (!(await input.isVisible().catch(() => false))) continue;
          if (!(await input.isEnabled().catch(() => false))) continue;
          if (
            withinBillingContext &&
            !(await input
              .evaluate((element) => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                if (rect.width < 1 || rect.height < 1) return false;
                const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
                const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
                const hit = document.elementFromPoint(x, y);
                return hit !== null && (hit === element || element.contains(hit));
              })
              .catch(() => false))
          ) {
            continue;
          }
          if (assertFrameEgress !== undefined) {
            const resolveHandle = async (): Promise<{
              handle: ElementHandle<Element>;
              tag: string;
            } | null> => {
              const handle = await input.elementHandle().catch(() => null);
              if (handle === null) return null;
              if (!(await handle.isVisible().catch(() => false))) {
                await handle.dispose().catch(() => undefined);
                return null;
              }
              if (!(await handle.isEnabled().catch(() => false))) {
                await handle.dispose().catch(() => undefined);
                return null;
              }
              await handle.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
              const context = await handle.evaluate((el) => ({
                tag: el.tagName.toLowerCase(),
                origin: el.ownerDocument.defaultView?.location.origin ?? "",
              }));
              assertFrameEgress(frame, context.origin);
              return { handle, tag: context.tag };
            };
            const resolved = await resolveHandle();
            if (resolved === null) continue;
            let { handle } = resolved;
            try {
              if (resolved.tag === "select") {
                let selected = await handle
                  .selectOption({ value })
                  .then((values) => values.length > 0)
                  .catch(() => {
                    assertFrameEgress(frame);
                    return false;
                  });
                if (!selected) {
                  await handle.dispose().catch(() => undefined);
                  const fallback = await resolveHandle();
                  if (fallback === null) continue;
                  handle = fallback.handle;
                  selected = await handle
                    .selectOption({ label: value })
                    .then((values) => values.length > 0)
                    .catch(() => {
                      assertFrameEgress(frame);
                      return false;
                    });
                }
                if (!selected) continue;
              } else if (typePerKey) {
                await handle.fill("").catch((error) => {
                  assertFrameEgress(frame);
                  throw error;
                });
                const resolvedOrigin = await handle.evaluate(
                  (el) => el.ownerDocument.defaultView?.location.origin ?? "",
                );
                assertFrameEgress(frame, resolvedOrigin);
                await handle
                  .type(value, {
                    delay: this.humanize ? rand(40, 110) : 0,
                  })
                  .catch((error) => {
                    assertFrameEgress(frame);
                    throw error;
                  });
              } else {
                await handle.fill(value).catch((error) => {
                  assertFrameEgress(frame);
                  throw error;
                });
              }
            } finally {
              await handle.dispose().catch(() => undefined);
            }
            filled.add(field);
            return true;
          }
          const tag = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
          await input.evaluate((el) => el.setAttribute("data-ts-sealed-payment", "1"));
          if (tag === "select") {
            const selected =
              (await input
                .selectOption({ value })
                .then(() => true)
                .catch(() => false)) ||
              (await input
                .selectOption({ label: value })
                .then(() => true)
                .catch(() => false));
            if (!selected) continue;
          } else if (typePerKey) {
            await input.fill("");
            await input.pressSequentially(value, { delay: this.humanize ? rand(40, 110) : 0 });
          } else {
            await input.fill(value);
          }
          filled.add(field);
          return true;
        }
      }
      return false;
    };
    const hasFillable = async (selectors: string, withinCardGroup = false): Promise<boolean> => {
      const candidateFrames =
        withinCardGroup && cardGroup !== undefined ? [cardGroup.frame] : frames;
      for (const frame of candidateFrames) {
        const matches =
          withinCardGroup && cardGroup !== undefined
            ? frame
                .locator(selectors)
                .and(frame.locator(`[data-ts-payment-card-control-group="${cardGroup.token}"]`))
            : frame.locator(selectors);
        const count = Math.min(await matches.count().catch(() => 0), 10);
        for (let i = 0; i < count; i += 1) {
          const input = matches.nth(i);
          if (!(await input.isVisible().catch(() => false))) continue;
          if (await input.isEnabled().catch(() => false)) return true;
        }
      }
      return false;
    };

    await fillFirst("pan", card.pan, CHECKOUT_PAN_FIELD_SELECTORS, false, true);
    const hasSplitExpiry =
      (await hasFillable(expiryMonthSelectors, true)) &&
      (await hasFillable(expiryYearSelectors, true));
    if (hasSplitExpiry) {
      await fillFirst(
        "exp_month",
        card.exp_month.padStart(2, "0"),
        expiryMonthSelectors,
        false,
        true,
      );
      await fillFirst("exp_year", card.exp_year, expiryYearSelectors, false, true);
    } else {
      // A combined expiry field's formatter owns the slash. Send only the four
      // digits as real key events so numeric-only fields accept them and the
      // site's key/input handlers can turn e.g. "1230" into "12/30".
      const combined = await fillFirst(
        "expiry",
        `${card.exp_month.padStart(2, "0")}${card.exp_year.slice(-2)}`,
        combinedExpirySelectors,
        true,
        true,
      );
      if (!combined) {
        await fillFirst(
          "exp_month",
          card.exp_month.padStart(2, "0"),
          expiryMonthSelectors,
          false,
          true,
        );
        await fillFirst("exp_year", card.exp_year, expiryYearSelectors, false, true);
      }
    }
    const fields: Array<[string, string | undefined, string, string?]> = [
      ["cvv", card.cvv, cvvSelectors],
      ["name", card.name, nameSelectors],
      [
        "line1",
        card.billing.line1,
        '[autocomplete~="address-line1"],[name*="address_line1" i],[name*="address1" i],[name="line1" i]',
        '[autocomplete~="billing"][autocomplete~="address-line1"],[name*="billing" i][name*="address_line1" i],[name*="billing" i][name*="address1" i],[id*="billing" i][id*="address-line1" i],[id*="billing" i][id*="address_line1" i],[id*="billing" i][id*="address1" i]',
      ],
      [
        "line2",
        card.billing.line2,
        '[autocomplete~="address-line2"],[name*="address_line2" i],[name*="address2" i],[name="line2" i]',
        '[autocomplete~="billing"][autocomplete~="address-line2"],[name*="billing" i][name*="address_line2" i],[name*="billing" i][name*="address2" i],[id*="billing" i][id*="address-line2" i],[id*="billing" i][id*="address_line2" i],[id*="billing" i][id*="address2" i]',
      ],
      [
        "city",
        card.billing.city,
        '[autocomplete~="address-level2"],[name*="city" i],[name*="locality" i]',
        '[autocomplete~="billing"][autocomplete~="address-level2"],[name*="billing" i][name*="city" i],[name*="billing" i][name*="locality" i],[id*="billing" i][id*="city" i],[id*="billing" i][id*="locality" i]',
      ],
      [
        "state",
        card.billing.state,
        '[autocomplete~="address-level1"],[name*="state" i],[name*="region" i]',
        '[autocomplete~="billing"][autocomplete~="address-level1"],[name*="billing" i][name*="state" i],[name*="billing" i][name*="region" i],[id*="billing" i][id*="state" i],[id*="billing" i][id*="region" i]',
      ],
      [
        "postal_code",
        card.billing.postal_code,
        '[autocomplete~="postal-code"],[name*="postal" i],[name*="zip" i]',
        '[autocomplete~="billing"][autocomplete~="postal-code"],[name*="billing" i][name*="postal" i],[name*="billing" i][name*="zip" i],[id*="billing" i][id*="postal" i],[id*="billing" i][id*="zip" i]',
      ],
      [
        "country",
        card.billing.country,
        '[autocomplete~="country"],[name*="country" i]',
        '[autocomplete~="billing"][autocomplete~="country"],[name*="billing" i][name*="country" i],[id*="billing" i][id*="country" i]',
      ],
    ];
    for (const [field, value, selectors, billingSelectors] of fields) {
      const withinBillingContext = billingOnly && billingSelectors !== undefined;
      await fillFirst(
        field,
        value,
        withinBillingContext ? billingSelectors : selectors,
        false,
        field === "cvv" || field === "name",
        withinBillingContext,
      );
    }
    for (const required of ["pan", "expiry", "cvv", "name"]) {
      if (required === "expiry" && filled.has("exp_month") && filled.has("exp_year")) continue;
      if (!filled.has(required)) throw new Error(`payment_field_not_found:${required}`);
    }
    return cardGroup === undefined
      ? undefined
      : { selected: cardGroup, groups: [...groups.values()] };
  }

  async fillAndSubmitCheckout(card: CheckoutCard): Promise<CheckoutSubmitResult> {
    if (!this.page) throw new Error("Browser not started");
    this.checkoutCardGroupScope = undefined;
    try {
      await this.waitForPanField(10_000);
      // A single-page checkout's generic address controls are its shipping
      // controls. Only an explicitly marked billing control is eligible here:
      // sealing a shipping field would make the payment cleanup erase the
      // merchant's selected address, country, and shipping rate after submit.
      const cardGroup = await this.fillCheckoutCardIntoFrames(this.page.frames(), card, true);
      return await this.submitFilledCheckoutInScope(cardGroup);
    } finally {
      await this.clearSealedPaymentFields();
    }
  }

  // Split-checkout card entry (operate_pay phase="fill_card"): fill the
  // vaulted card into the payment fields WITHOUT touching any submit control —
  // filling is not charging. The card may only enter the main frame, a frame
  // on the page's own registrable domain, or a recognized payment-provider
  // frame (recognizedPaymentProviderFrame); when the card fields live only in
  // an unrecognized cross-origin frame the fill is refused and nothing is
  // left behind. On success the filled values STAY in the page (the site
  // needs them at its confirm step) marked data-ts-sealed-payment, which
  // extractInteractiveElements reports as sealed so observations mask them.
  async fillCheckoutCardFields(card: CheckoutCard): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    this.checkoutCardGroupScope = undefined;
    const page = this.page;
    const pageUrl = page.url();
    if (!recognizedPaymentProviderFrame(pageUrl, pageUrl)) {
      throw new Error("payment_checkout_https_required");
    }
    // Same late-mount tolerance as fillAndSubmitCheckout: wait for a PAN
    // field to appear anywhere before taking the trusted-frame snapshot below
    // (which still restricts the actual fill to recognized frames — this only
    // decides WHEN to look, never WHERE it's allowed to write).
    await this.waitForPanField(10_000);
    const allowed = page
      .frames()
      .filter(
        (frame) =>
          frame === page.mainFrame() || recognizedPaymentProviderFrame(frame.url(), pageUrl),
      );
    const expectedPageOrigin = new URL(pageUrl).origin;
    const expectedFrameOrigins = new Map(
      allowed.map((frame) => [frame, new URL(frame.url()).origin] as const),
    );
    const assertFrameEgress = (frame: Frame, resolvedOrigin?: string): void => {
      const livePageUrl = page.url();
      let livePageOrigin: string;
      let liveFrameOrigin: string;
      try {
        livePageOrigin = new URL(livePageUrl).origin;
        liveFrameOrigin = new URL(frame.url()).origin;
      } catch {
        throw new UnrecognizedPaymentFrameError(frame.url());
      }
      if (
        livePageOrigin !== expectedPageOrigin ||
        liveFrameOrigin !== expectedFrameOrigins.get(frame) ||
        (resolvedOrigin !== undefined && resolvedOrigin !== liveFrameOrigin) ||
        (frame !== page.mainFrame() && !recognizedPaymentProviderFrame(frame.url(), livePageUrl))
      ) {
        throw new UnrecognizedPaymentFrameError(liveFrameOrigin);
      }
    };
    try {
      this.checkoutCardGroupScope = await this.fillCheckoutCardIntoFrames(
        allowed,
        card,
        true,
        assertFrameEgress,
      );
    } catch (error) {
      let fillError = error;
      if (error instanceof Error && error.message === "payment_field_not_found:pan") {
        const excluded = await this.excludedPanFrameOrigin(new Set(allowed));
        if (excluded !== null) fillError = new UnrecognizedPaymentFrameError(excluded);
      }
      try {
        await this.clearCheckoutCardFieldsInFrames(allowed);
      } catch {
        throw new PaymentCardFillCleanupError(fillError);
      }
      throw fillError;
    }
  }

  // No PAN field among the allowed frames — name the excluded frame that does
  // carry one (if any) so the refusal is diagnosable without filling it.
  private async excludedPanFrameOrigin(allowed: ReadonlySet<Frame>): Promise<string | null> {
    if (!this.page) return null;
    for (const frame of this.page.frames()) {
      if (allowed.has(frame)) continue;
      const count = await frame
        .locator(CHECKOUT_PAN_FIELD_SELECTORS)
        .count()
        .catch(() => 0);
      if (count > 0) {
        try {
          return new URL(frame.url()).origin;
        } catch {
          return frame.url();
        }
      }
    }
    return null;
  }

  // The charge: find and click the pay/place-order control, then poll for a
  // 3-D Secure challenge. Callers gate this on a verified visible total.
  async submitFilledCheckout(): Promise<CheckoutSubmitResult> {
    return await this.submitFilledCheckoutInScope(this.checkoutCardGroupScope);
  }

  private async submitFilledCheckoutInScope(
    cardGroup?: CheckoutCardGroupScope,
  ): Promise<CheckoutSubmitResult> {
    if (!this.page) throw new Error("Browser not started");
    this.checkoutThreeDsPending = false;
    const failureBaseline = await this.captureVisibleCheckoutFailureSignals();
    let outcomeBaseline: CheckoutOutcomeBaseline | undefined;
    this.checkoutOutcomeBaseline = undefined;
    this.checkoutFailureBaseline = failureBaseline;
    let submitted = false;
    for (const frame of this.page.frames()) {
      const matches = frame.locator('button,input[type="submit"],[role="button"]');
      const count = Math.min(await matches.count().catch(() => 0), 100);
      for (let i = 0; i < count; i += 1) {
        const candidate = matches.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        if (!(await candidate.isEnabled().catch(() => false))) continue;
        if (cardGroup !== undefined) {
          const ownership = await candidate
            .evaluate((element, cardFieldSelectors) => {
              const form =
                element instanceof HTMLButtonElement || element instanceof HTMLInputElement
                  ? element.form
                  : null;
              const owner =
                form?.closest("[data-ts-payment-card-group]") ??
                element.closest("[data-ts-payment-card-group]");
              return {
                ownerToken: owner?.getAttribute("data-ts-payment-card-group") ?? null,
                formOwnsCardFields:
                  form !== null &&
                  Array.from(form.elements).some((control) => control.matches(cardFieldSelectors)),
              };
            }, CHECKOUT_CARD_VALUE_FIELD_SELECTORS)
            .catch(() => undefined);
          if (ownership === undefined) continue;
          if (ownership.ownerToken !== null) {
            const knownOwner = cardGroup.groups.some(
              (group) => group.frame === frame && group.token === ownership.ownerToken,
            );
            if (
              !knownOwner ||
              frame !== cardGroup.selected.frame ||
              ownership.ownerToken !== cardGroup.selected.token
            ) {
              continue;
            }
          } else if (ownership.formOwnsCardFields) {
            continue;
          }
        }
        const label = await candidate
          .evaluate((el) =>
            (
              el.getAttribute("aria-label") ||
              (el instanceof HTMLInputElement ? el.value : el.textContent) ||
              ""
            ).trim(),
          )
          .catch(() => "");
        if (!CHECKOUT_SUBMIT_LABEL_RE.test(label)) continue;
        const dispatchToken = `ts-payment-submit-${this.checkoutSubmitSequence++}`;
        const dispatchBaselineStorageKey = `__trusty_squire_payment_baseline_${dispatchToken}`;
        const dispatchTrackingInstalled = await candidate
          .evaluate((element, options) => {
            const { baselineStorageKey, token } = options;
            const stateWindow = window as Window & {
              __trustySquirePaymentSubmitDispatch?: {
                token: string;
                dispatched: boolean;
              };
            };
            const tracked = element as Element & {
              __tsPaymentSubmitDispatchListener?: EventListener;
            };
            if (tracked.__tsPaymentSubmitDispatchListener !== undefined) {
              element.removeEventListener(
                "click",
                tracked.__tsPaymentSubmitDispatchListener,
                true,
              );
            }
            stateWindow.__trustySquirePaymentSubmitDispatch = {
              token,
              dispatched: false,
            };
            const listener: EventListener = () => {
              const state = stateWindow.__trustySquirePaymentSubmitDispatch;
              if (state?.token !== token) return;
              try {
                const merchantWindow = window.top;
                if (merchantWindow === null) return;
                const snapshot: CheckoutOutcomeDispatchSnapshot = {
                  url: merchantWindow.location.href,
                };
                const baselineWindow = merchantWindow as Window & {
                  __trustySquirePaymentDispatchBaselines?: Record<
                    string,
                    CheckoutOutcomeDispatchSnapshot
                  >;
                };
                baselineWindow.__trustySquirePaymentDispatchBaselines ??= {};
                baselineWindow.__trustySquirePaymentDispatchBaselines[token] = snapshot;
                try {
                  merchantWindow.sessionStorage.setItem(
                    baselineStorageKey,
                    JSON.stringify(snapshot),
                  );
                } catch (error) {
                  void error;
                }
              } finally {
                state.dispatched = true;
              }
            };
            tracked.__tsPaymentSubmitDispatchListener = listener;
            element.addEventListener("click", listener, { capture: true, once: true });
          }, {
            baselineStorageKey: dispatchBaselineStorageKey,
            token: dispatchToken,
          })
          .then(() => true)
          .catch(() => false);
        if (!dispatchTrackingInstalled) continue;
        const readDispatchOutcomeBaseline = async (): Promise<CheckoutOutcomeBaseline | null> => {
          const snapshot = await this.page!
            .mainFrame()
            .evaluate(({ baselineStorageKey, token }) => {
              const baselineWindow = window as Window & {
                __trustySquirePaymentDispatchBaselines?: Record<
                  string,
                  CheckoutOutcomeDispatchSnapshot
                >;
              };
              let captured = baselineWindow.__trustySquirePaymentDispatchBaselines?.[token] ?? null;
              if (captured !== null) {
                delete baselineWindow.__trustySquirePaymentDispatchBaselines?.[token];
              }
              if (captured === null) {
                try {
                  const stored = sessionStorage.getItem(baselineStorageKey);
                  if (stored !== null) {
                    captured = JSON.parse(stored) as CheckoutOutcomeDispatchSnapshot;
                  }
                } catch {
                  captured = null;
                }
              }
              try {
                sessionStorage.removeItem(baselineStorageKey);
              } catch (error) {
                void error;
              }
              return captured;
            }, { baselineStorageKey: dispatchBaselineStorageKey, token: dispatchToken })
            .catch(() => null);
          if (
            snapshot === null ||
            typeof snapshot.url !== "string"
          ) {
            return null;
          }
          return checkoutOutcomeBaselineFromDispatchSnapshot(snapshot);
        };
        const clearDispatchTracking = async (): Promise<void> => {
          await candidate
            .evaluate((element) => {
              const tracked = element as Element & {
                __tsPaymentSubmitDispatchListener?: EventListener;
              };
              if (tracked.__tsPaymentSubmitDispatchListener !== undefined) {
                element.removeEventListener(
                  "click",
                  tracked.__tsPaymentSubmitDispatchListener,
                  true,
                );
                delete tracked.__tsPaymentSubmitDispatchListener;
              }
            })
            .catch(() => undefined);
          await frame
            .evaluate((token) => {
              const stateWindow = window as Window & {
                __trustySquirePaymentSubmitDispatch?: {
                  token: string;
                  dispatched: boolean;
                };
              };
              if (stateWindow.__trustySquirePaymentSubmitDispatch?.token === token) {
                delete stateWindow.__trustySquirePaymentSubmitDispatch;
              }
            }, dispatchToken)
            .catch(() => undefined);
          await readDispatchOutcomeBaseline();
        };
        try {
          await candidate.click();
        } catch (error) {
          const dispatchState = await frame
            .evaluate((token) => {
              const stateWindow = window as Window & {
                __trustySquirePaymentSubmitDispatch?: {
                  token: string;
                  dispatched: boolean;
                };
              };
              const state = stateWindow.__trustySquirePaymentSubmitDispatch;
              return {
                sameDocument: state?.token === token,
                dispatched: state?.token === token && state.dispatched,
              };
            }, dispatchToken)
            .catch(() => null);
          await clearDispatchTracking();
          if (dispatchState?.sameDocument === true && !dispatchState.dispatched) throw error;
          throw new PaymentSubmitOutcomeUnknownError();
        }
        outcomeBaseline =
          (await readDispatchOutcomeBaseline()) ?? (await this.captureCheckoutOutcomeBaseline());
        this.checkoutOutcomeBaseline = outcomeBaseline;
        await clearDispatchTracking();
        submitted = true;
        break;
      }
      if (submitted) break;
    }
    if (!submitted || outcomeBaseline === undefined) throw new Error("payment_submit_not_found");
    try {
      const challengeDeadline = Date.now() + 15_000;
      while (Date.now() < challengeDeadline) {
        if (await this.hasConfirmedCheckoutOutcome(outcomeBaseline)) {
          this.checkoutThreeDsPending = false;
          return { three_ds_required: false, order_confirmed: true };
        }
        const challenge = await this.detectThreeDsChallenge();
        if (challenge.three_ds_required) {
          this.checkoutThreeDsPending = true;
          return challenge;
        }
        await this.page.waitForTimeout(250).catch(() => undefined);
      }
      return { three_ds_required: false, order_confirmed: false };
    } catch (error) {
      if (error instanceof PaymentSubmitOutcomeUnknownError) throw error;
      throw new PaymentSubmitOutcomeUnknownError();
    }
  }

  async clearSealedPaymentFields(): Promise<void> {
    this.checkoutCardGroupScope = undefined;
    if (!this.page) return;
    await this.clearSealedPaymentFieldsInFrames(this.page.frames());
  }

  private async clearSealedPaymentFieldsInFrames(frames: readonly Frame[]): Promise<void> {
    for (const frame of frames) {
      await frame
        .locator('[data-ts-sealed-payment="1"]')
        .evaluateAll((elements) => {
          for (const element of elements) {
            if (
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
            ) {
              element.value = "";
            }
            element.removeAttribute("data-ts-sealed-payment");
          }
        })
        .catch(() => undefined);
    }
  }

  async clearCheckoutCardFields(): Promise<void> {
    this.checkoutCardGroupScope = undefined;
    if (!this.page) return;
    await this.clearCheckoutCardFieldsInFrames(this.page.frames());
  }

  private async clearCheckoutCardFieldsInFrames(frames: readonly Frame[]): Promise<void> {
    if (!this.page) return;
    for (const frame of frames) {
      const fields = frame.locator(CHECKOUT_CARD_VALUE_FIELD_SELECTORS);
      const count = Math.min(await fields.count().catch(() => 0), 40);
      for (let i = 0; i < count; i += 1) {
        const field = fields.nth(i);
        await field.fill("").catch(() => undefined);
        await field
          .evaluate((element) => element.removeAttribute("data-ts-sealed-payment"))
          .catch(() => undefined);
      }
    }
    await this.clearSealedPaymentFieldsInFrames(frames);
    await this.page.waitForTimeout(0).catch(() => undefined);
    for (const frame of frames) {
      const uncleared = await frame
        .locator(CHECKOUT_CARD_VALUE_FIELD_SELECTORS)
        .evaluateAll((elements) =>
          elements.some(
            (element) =>
              (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
              element.value.length > 0,
          ),
        )
        .catch(() => true);
      if (uncleared) throw new Error("payment_fields_not_cleared");
    }
    const visibleTexts = await Promise.all(
      frames.map(async (frame) =>
        frame.evaluate(extractObservationVisibleText).catch(() => undefined),
      ),
    );
    if (
      visibleTexts.some((text) => text === undefined) ||
      visibleTexts.some((text) => containsVisiblePaymentMaterial(text!))
    ) {
      throw new Error("payment_fields_not_cleared");
    }
    const interactiveElements = await this.extractInteractiveElements().catch(() => undefined);
    if (interactiveElements === undefined) throw new Error("payment_fields_not_cleared");
    const interactiveText = interactiveElements
      .flatMap((element) => [
        element.ariaLabel,
        element.title,
        element.value,
        element.labelText,
        element.visibleText,
        element.iconLabel,
        element.placeholder,
        element.name,
        element.testId,
        element.screenPath,
        element.container,
        element.occludedBy,
      ])
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (containsVisiblePaymentMaterial(interactiveText)) {
      throw new Error("payment_fields_not_cleared");
    }
  }

  private async isFrameSurfaceTopmost(frame: Frame): Promise<boolean> {
    let childFrame = frame;
    let parentFrame = childFrame.parentFrame();
    while (parentFrame !== null) {
      const owner = await childFrame.frameElement().catch(() => null);
      if (owner === null) return false;
      const topmost = await owner
        .evaluate((element) => {
          const visualHitAtPoint = (x: number, y: number): Element | null => {
            const restored: Array<{
              element: HTMLElement;
              priority: string;
              value: string;
            }> = [];
            for (const candidate of Array.from(
              document.querySelectorAll<HTMLElement>("body *"),
            )) {
              const style = getComputedStyle(candidate);
              if (
                style.pointerEvents !== "none" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number.parseFloat(style.opacity) <= 0 ||
                !Array.from(candidate.getClientRects()).some(
                  (rect) =>
                    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
                )
              ) {
                continue;
              }
              restored.push({
                element: candidate,
                priority: candidate.style.getPropertyPriority("pointer-events"),
                value: candidate.style.getPropertyValue("pointer-events"),
              });
              candidate.style.setProperty("pointer-events", "auto", "important");
            }
            const hit = document.elementFromPoint(x, y);
            for (const original of restored) {
              if (original.value.length === 0) {
                original.element.style.removeProperty("pointer-events");
              } else {
                original.element.style.setProperty(
                  "pointer-events",
                  original.value,
                  original.priority,
                );
              }
            }
            return hit;
          };
          if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
            return false;
          }
          let current: HTMLElement | null = element;
          while (current !== null) {
            const style = getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              Number.parseFloat(style.opacity) <= 0
            ) {
              return false;
            }
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return false;
          const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
          const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
          const hit = visualHitAtPoint(x, y);
          return hit !== null && (hit === element || element.contains(hit));
        })
        .catch(() => false);
      await owner.dispose().catch(() => undefined);
      if (!topmost) return false;
      childFrame = parentFrame;
      parentFrame = childFrame.parentFrame();
    }
    return true;
  }

  private async detectThreeDsChallenge(): Promise<CheckoutSubmitResult> {
    if (!this.page) throw new Error("Browser not started");
    const urlPattern = /(?:3d[-_ ]?secure|three[-_ ]?d[-_ ]?secure|\/3ds(?:2)?\/|\/acs\/)/i;
    for (const frame of this.page.frames()) {
      if (!(await this.isFrameSurfaceTopmost(frame))) continue;
      let frameContext = frame === this.page.mainFrame() ? "" : `${frame.name()} ${frame.url()}`;
      if (frame !== this.page.mainFrame()) {
        const owner = await frame.frameElement().catch(() => null);
        if (owner !== null) {
          frameContext += await owner
            .evaluate((element) =>
              [
                element.id,
                element.className,
                element.getAttribute("name"),
                element.getAttribute("title"),
                element.getAttribute("aria-label"),
                element.getAttribute("data-testid"),
              ]
                .filter((value): value is string => typeof value === "string")
                .join(" "),
            )
            .catch(() => "");
          await owner.dispose().catch(() => undefined);
        }
      }
      let frameUrlContext = frame.url();
      let shopifyPciFrame = false;
      try {
        const parsedFrameUrl = new URL(frameUrlContext);
        shopifyPciFrame =
          parsedFrameUrl.protocol === "https:" &&
          parsedFrameUrl.hostname === "checkout.pci.shopifyinc.com";
        frameUrlContext = `${parsedFrameUrl.hostname}${parsedFrameUrl.pathname}`;
      } catch {
        frameUrlContext = "";
      }
      const detected =
        urlPattern.test(frameUrlContext) ||
        (await frame
          .evaluate(({ externalContext, shopifyPciFrame }) => {
            const visualHitAtPoint = (x: number, y: number): Element | null => {
              const restored: Array<{
                element: HTMLElement;
                priority: string;
                value: string;
              }> = [];
              for (const candidate of Array.from(
                document.querySelectorAll<HTMLElement>("body *"),
              )) {
                const style = getComputedStyle(candidate);
                if (
                  style.pointerEvents !== "none" ||
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number.parseFloat(style.opacity) <= 0 ||
                  !Array.from(candidate.getClientRects()).some(
                    (rect) =>
                      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
                  )
                ) {
                  continue;
                }
                restored.push({
                  element: candidate,
                  priority: candidate.style.getPropertyPriority("pointer-events"),
                  value: candidate.style.getPropertyValue("pointer-events"),
                });
                candidate.style.setProperty("pointer-events", "auto", "important");
              }
              const hit = document.elementFromPoint(x, y);
              for (const original of restored) {
                if (original.value.length === 0) {
                  original.element.style.removeProperty("pointer-events");
                } else {
                  original.element.style.setProperty(
                    "pointer-events",
                    original.value,
                    original.priority,
                  );
                }
              }
              return hit;
            };
            const visibleAndTopmost = (element: Element): boolean => {
              if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
                return false;
              }
              let current: HTMLElement | null = element;
              while (current !== null) {
                const style = getComputedStyle(current);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  style.visibility === "collapse" ||
                  Number.parseFloat(style.opacity) <= 0
                ) {
                  return false;
                }
                current = current.parentElement;
              }
              return Array.from(element.getClientRects()).some((rect) => {
                const left = Math.max(0, rect.left);
                const right = Math.min(window.innerWidth, rect.right);
                const top = Math.max(0, rect.top);
                const bottom = Math.min(window.innerHeight, rect.bottom);
                if (right <= left || bottom <= top) return false;
                const x = left + (right - left) / 2;
                const y = top + (bottom - top) / 2;
                return visualHitAtPoint(x, y) === element;
              });
            };
            const visibleTextAndTopmost = (node: Text): boolean => {
              const element = node.parentElement;
              if (element === null) return false;
              let current: HTMLElement | null = element;
              while (current !== null) {
                const style = getComputedStyle(current);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  style.visibility === "collapse" ||
                  Number.parseFloat(style.opacity) <= 0
                ) {
                  return false;
                }
                current = current.parentElement;
              }
              const range = document.createRange();
              range.selectNodeContents(node);
              return Array.from(range.getClientRects()).some((rect) => {
                const left = Math.max(0, rect.left);
                const right = Math.min(window.innerWidth, rect.right);
                const top = Math.max(0, rect.top);
                const bottom = Math.min(window.innerHeight, rect.bottom);
                if (right <= left || bottom <= top) return false;
                const x = left + (right - left) / 2;
                const y = top + (bottom - top) / 2;
                return visualHitAtPoint(x, y) === element;
              });
            };
            const structural = Array.from(
              document.querySelectorAll(
                'iframe[title*="3d secure" i],form:has(input[name="creq" i]),form[action*="acs" i]',
              ),
            ).some(
              (element) =>
                visibleAndTopmost(element) ||
                Array.from(element.querySelectorAll("button,input,select,textarea")).some(
                  visibleAndTopmost,
                ),
            );
            if (structural) return true;
            const hasKnownChallengeContext = (context: string): boolean => {
              const explicitThreeDs =
                /(?:3d[-_ ]?secure|three[-_ ]?d[-_ ]?secure|\b3ds2?\b|\bacs\b)/i.test(context);
              const shopifyChallenge =
                /(?:shopify|shopifyinc)/i.test(context) &&
                /(?:authentication|3d[-_ ]?secure|\b3ds2?\b|\bacs\b)/i.test(context);
              const dbsChallenge =
                /\bdbs\b/i.test(context) &&
                /(?:bank(?:ing)?\s+app|authentication|challenge|approval|3d[-_ ]?secure|\b3ds2?\b)/i.test(
                  context,
                );
              const issuerAuthentication =
                /\bissuer\b/i.test(context) &&
                /(?:authentication|challenge|3d[-_ ]?secure|\b3ds2?\b|\bacs\b)/i.test(context);
              return explicitThreeDs || shopifyChallenge || dbsChallenge || issuerAuthentication;
            };
            const explicitText =
              /\b(?:3d secure|authenticate (?:this )?payment|security code sent to)\b/i;
            const contextualText = /\bverify (?:your )?identity\b/i;
            const countdownText = /\b\d{1,3}\s+seconds?\s+to\s+confirm\b/i;
            const bankAppText =
              /\b(?:confirm|approve)\b.{0,80}\b(?:bank|banking|issuer)\s+app\b/i;
            const dbsBankAppText =
              /\b(?:confirm|approve)\b.{0,80}\bdbs\b.{0,80}\b(?:bank(?:ing)?\s+app|digibank)\b|\bdbs\b.{0,80}\b(?:bank(?:ing)?\s+app|digibank)\b.{0,80}\b(?:confirm|approve)\b/i;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node !== null) {
              const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
              const element = node.parentElement;
              if (text.length > 0 && element !== null) {
                const explicitMatch = explicitText.test(text);
                const dbsBankAppMatch = dbsBankAppText.test(text);
                const countdownMatch = countdownText.test(text);
                const bankAppMatch = bankAppText.test(text);
                const contextualMatch = contextualText.test(text);
                if (
                  (explicitMatch ||
                    dbsBankAppMatch ||
                    countdownMatch ||
                    bankAppMatch ||
                    contextualMatch) &&
                  visibleTextAndTopmost(node as Text)
                ) {
                  if (explicitMatch) return true;
                  if (dbsBankAppMatch || (shopifyPciFrame && (countdownMatch || bankAppMatch))) {
                    return true;
                  }
                  const context: string[] = [externalContext];
                  let ancestor: Element | null = element;
                  for (let depth = 0; ancestor !== null && depth < 8; depth += 1) {
                    context.push(
                      [
                        ancestor.id,
                        ancestor.className,
                        ancestor.getAttribute("name"),
                        ancestor.getAttribute("title"),
                        ancestor.getAttribute("aria-label"),
                        ancestor.getAttribute("data-testid"),
                      ]
                        .filter((value): value is string => typeof value === "string")
                        .join(" "),
                    );
                    ancestor = ancestor.parentElement;
                  }
                  if (hasKnownChallengeContext(context.join(" "))) return true;
                }
              }
              node = walker.nextNode();
            }
            return false;
          }, { externalContext: frameContext, shopifyPciFrame })
          .catch(() => false));
      if (detected) {
        return {
          three_ds_required: true,
          order_confirmed: false,
          challenge_url: frame.url() || this.page.url(),
        };
      }
    }
    return { three_ds_required: false, order_confirmed: false };
  }

  private async captureCheckoutOutcomeBaseline(): Promise<CheckoutOutcomeBaseline> {
    if (!this.page) return { url: "", orderUrlIdentities: [], terminalUrlIdentity: null };
    const url = this.page.url();
    const identities = checkoutUrlOrderIdentities(url);
    return {
      url,
      orderUrlIdentities: identities?.orders ?? [],
      terminalUrlIdentity: identities?.terminal ?? null,
    };
  }

  private async hasConfirmedCheckoutOutcome(baseline: CheckoutOutcomeBaseline): Promise<boolean> {
    if (!this.page) return false;
    const current = await this.captureCheckoutOutcomeBaseline();
    let sameCheckoutOrigin = false;
    try {
      const currentUrl = new URL(current.url);
      sameCheckoutOrigin = currentUrl.origin === new URL(baseline.url).origin;
    } catch {
      sameCheckoutOrigin = current.url === baseline.url;
    }
    return (
      sameCheckoutOrigin &&
      current.terminalUrlIdentity !== null &&
      !baseline.orderUrlIdentities.includes(current.terminalUrlIdentity)
    );
  }

  private async captureVisibleCheckoutFailureSignals(): Promise<CheckoutFailureBaseline> {
    if (!this.page) return null;
    const failureText =
      /(?:payment|card|transaction) (?:was )?declined|authentication failed|could not be (?:authenticated|processed|completed)|(?:please )?try (?:a |another )?(?:different )?card|3-?d ?secure (?:failed|unsuccessful)/i;
    const frameSignals = await Promise.all(
      this.page.frames().map(async (frame) => {
        if (!(await this.isFrameSurfaceTopmost(frame))) return {};
        const signals = await frame
          .evaluate(extractVisibleTopmostTextSignals, {
            source: failureText.source,
            flags: failureText.flags,
          })
          .catch(() => null);
        if (signals === null) return null;
        return signals;
      }),
    );
    const combined: Record<string, number> = {};
    for (const signals of frameSignals) {
      if (signals === null) return null;
      for (const [signal, count] of Object.entries(signals)) {
        combined[signal] = (combined[signal] ?? 0) + count;
      }
    }
    return combined;
  }

  private async hasNewVisibleCheckoutFailure(
    baseline: CheckoutFailureBaseline,
  ): Promise<boolean> {
    if (baseline === null) return false;
    const current = await this.captureVisibleCheckoutFailureSignals();
    if (current === null) return false;
    return Object.entries(current).some(
      ([signal, count]) => count > (baseline[signal] ?? 0),
    );
  }

  async waitForThreeDsResolution(timeoutMs: number): Promise<ThreeDsResolution> {
    if (!this.page) throw new Error("Browser not started");
    const outcomeBaseline =
      this.checkoutOutcomeBaseline ?? (await this.captureCheckoutOutcomeBaseline());
    const failureBaseline =
      this.checkoutFailureBaseline ?? (await this.captureVisibleCheckoutFailureSignals());
    const deadline = Date.now() + timeoutMs;
    let challengeWasActive = this.checkoutThreeDsPending;
    let challengeAbsentSince: number | undefined;
    do {
      if (await this.hasConfirmedCheckoutOutcome(outcomeBaseline)) {
        this.checkoutThreeDsPending = false;
        return "succeeded";
      }
      if (await this.hasNewVisibleCheckoutFailure(failureBaseline)) {
        this.checkoutThreeDsPending = false;
        return "failed";
      }
      const challenge = await this.detectThreeDsChallenge();
      if (challenge.three_ds_required) {
        challengeWasActive = true;
        challengeAbsentSince = undefined;
      }
      if (!challenge.three_ds_required && challengeWasActive) {
        challengeAbsentSince ??= Date.now();
        if (Date.now() - challengeAbsentSince >= THREE_DS_RESOLUTION_GRACE_MS) {
          this.checkoutThreeDsPending = false;
          return "unconfirmed";
        }
      }
      await this.page.waitForTimeout(1_000).catch(() => undefined);
    } while (Date.now() <= deadline);
    if (await this.hasConfirmedCheckoutOutcome(outcomeBaseline)) {
      this.checkoutThreeDsPending = false;
      return "succeeded";
    }
    if (await this.hasNewVisibleCheckoutFailure(failureBaseline)) {
      this.checkoutThreeDsPending = false;
      return "failed";
    }
    if (challengeWasActive && !(await this.detectThreeDsChallenge()).three_ds_required) {
      this.checkoutThreeDsPending = false;
      return "unconfirmed";
    }
    return "timeout";
  }

  // Deterministic Firebase/GCP credential extraction. Every Firebase project
  // auto-creates a "Browser key (auto created by Firebase)" in its underlying
  // Google Cloud project — the SAME AIzaSy value as firebaseConfig.apiKey AND a
  // usable GCP API key — even with NO web app registered. PROVEN surface
  // (2026-06-23): console.cloud.google.com/apis/credentials?project=<projectId>
  // → API Keys row "Browser key (auto created by Firebase)" → "Show key" reveals
  // the AIzaSy value inline in that row. Row-scoped so it never grabs one of the
  // console's own internal AIzaSy keys (which live in script/attribute data, not
  // the visible row text). Returns the key, or null when the page didn't render
  // a Browser key (project not provisioned yet / different surface).
  async extractGoogleApiKeyFromCredentials(projectId: string): Promise<string | null> {
    if (!this.page) throw new Error("Browser not started");
    const KEY_RE = /AIzaSy[0-9A-Za-z_-]{33}/;
    const url = `https://console.cloud.google.com/apis/credentials?project=${encodeURIComponent(projectId)}`;
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    // The credentials table renders async (heavy Angular console). Poll for it.
    for (let i = 0; i < 12; i++) {
      await this.wait(2.5);
      const ready = await this.page
        .evaluate(() =>
          /Browser key|API Keys|Create credentials/i.test(document.body?.innerText ?? ""),
        )
        .catch(() => false);
      if (ready) break;
    }
    // Locate the Firebase Browser-key row; return its AIzaSy if already shown,
    // else click the row's "Show key" button to reveal it.
    const readRowKey = (): Promise<string | null> =>
      this.page!.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tr"));
        const row =
          rows.find((r) => /browser key \(auto created by firebase\)/i.test(r.textContent ?? "")) ??
          rows.find((r) => /browser key/i.test(r.textContent ?? ""));
        if (row === undefined) return null;
        const m = (row.textContent ?? "").match(/AIzaSy[0-9A-Za-z_-]{33}/);
        if (m !== null) return m[0];
        const btn = Array.from(row.querySelectorAll("button,a")).find((b) =>
          /show key/i.test(b.textContent ?? ""),
        );
        if (btn !== undefined) (btn as HTMLElement).click();
        return null;
      }).catch(() => null);
    const first = await readRowKey();
    if (first !== null && KEY_RE.test(first)) return first;
    // After the Show-key click, poll the row (reveal is async) and any dialog
    // / readonly input the console may surface the value in.
    for (let i = 0; i < 8; i++) {
      await this.wait(1.5);
      const revealed = await this.page
        .evaluate(() => {
          const rows = Array.from(document.querySelectorAll("tr"));
          const row = rows.find((r) => /browser key/i.test(r.textContent ?? ""));
          const inRow = (row?.textContent ?? "").match(/AIzaSy[0-9A-Za-z_-]{33}/);
          if (inRow !== null) return inRow[0];
          for (const inp of Array.from(document.querySelectorAll("input"))) {
            const v = (inp as HTMLInputElement).value ?? "";
            const m = v.match(/AIzaSy[0-9A-Za-z_-]{33}/);
            if (m !== null) return m[0];
          }
          return null;
        })
        .catch(() => null);
      if (revealed !== null && KEY_RE.test(revealed)) return revealed;
    }
    return null;
  }

  // Deterministically satisfy required, currently-EMPTY combobox/listbox
  // selectors (cmdk / Radix / Headless UI multi-selects) that gate a disabled
  // submit. The dominant `oauth_onboarding_failed` blocker is a post-OAuth
  // "tell us about yourself" survey whose required multi-selects the greedy
  // planner opens but never commits — it concludes "all filled", clicks the
  // disabled Next, and stalls (MEASURED 2026-06-23, meilisearch
  // /welcome-informations: `[data-cy=...-trigger]` role=combobox → cmdk-list of
  // `[role=option][cmdk-item]`). For each unfilled trigger: open it, click the
  // first non-disabled option (Playwright locator click COMMITS where a raw
  // coordinate click drops — same as the post-verify combobox path), and Escape
  // to close the multi-select popover. Returns the labels it satisfied. Tightly
  // scoped: only acts on placeholder-showing (empty) comboboxes, never a
  // combobox that already holds a value.
  async fillRequiredComboboxes(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    let triggerSelectors: string[] = [];
    try {
      triggerSelectors = await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const out: string[] = [];
        const seen = new Set<string>();
        // Candidate trigger elements: an ARIA combobox/listbox-popup, OR a
        // shadcn/Radix `*-trigger` data-cy button. MEASURED 2026-06-23
        // (meilisearch): the clickable trigger carries `data-cy="…-trigger"`
        // but role=combobox lives on a separate inner node with NO data-cy, so
        // a role-only query found an un-addressable element. Collect both and
        // resolve each to its nearest stable data-cy selector.
        const candidates = new Set<Element>();
        for (const e of Array.from(
          document.querySelectorAll(
            "[role='combobox'],[aria-haspopup='listbox'],button[data-cy$='-trigger']",
          ),
        )) {
          candidates.add(e);
        }
        for (const el of Array.from(candidates)) {
          if (!isVisible(el)) continue;
          // Skip text/autocomplete inputs (role=combobox is also set on search
          // multiselects like MongoDB's "data types") — we click-to-pick from a
          // dropdown, never type into a filter box.
          if (el.tagName === "INPUT") continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          // Unfilled signals: (1) Radix sets `data-placeholder` on a SelectTrigger
          // until a value is committed — present even when the trigger PREVIEWS
          // the first option (meilisearch's role/referral show "Founder/CTO" /
          // "Open Source" but stay uncommitted, so Next stays disabled); (2) empty
          // text; (3) a clear "Select…/Choose…/Pick…" placeholder. NOT
          // "search"/"add"/"type" — those are filter inputs we must not auto-pick.
          const hasPlaceholderAttr =
            el.hasAttribute("data-placeholder") || el.querySelector("[data-placeholder]") !== null;
          const placeholderish =
            hasPlaceholderAttr ||
            txt.length === 0 ||
            /^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt);
          if (!placeholderish) continue;
          // Resolve a stable data-cy selector — own, or nearest ancestor — so
          // the locator click can't drift after the portal re-renders.
          const dcEl = el.getAttribute("data-cy") !== null ? el : el.closest("[data-cy]");
          const dc = dcEl !== null ? dcEl.getAttribute("data-cy") : null;
          const sel = dc !== null && dc.length > 0 ? `[data-cy="${dc}"]` : null;
          if (sel === null || seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // LeafyGreen (MongoDB Atlas) path. Its select triggers are
        // `<button data-lgid="lg-button">Select</button>` with NO data-cy and NO
        // data-placeholder — the placeholder is the literal text "Select".
        // Address each by its index among lg-buttons (Playwright `>> nth=`),
        // since there's no stable per-trigger attribute. MEASURED 2026-06-23
        // (mongodb-atlas /atlas onboarding personalization wizard).
        const lgButtons = Array.from(document.querySelectorAll("button[data-lgid='lg-button']"));
        for (let i = 0; i < lgButtons.length; i++) {
          const el = lgButtons[i];
          if (el === undefined || !isVisible(el)) continue;
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!/^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt)) continue;
          const sel = `button[data-lgid="lg-button"] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        // Autocomplete-list combobox INPUTS that are part of the survey and
        // still EMPTY (mongodb's required "data types" multiselect). These are
        // distinct from free-text search boxes: `aria-autocomplete=list/both`
        // means a fixed option list, and an empty value means unfilled. Click +
        // pick-first via the same option locator. Addressed by index.
        const acInputs = Array.from(
          document.querySelectorAll("input[role='combobox'][aria-autocomplete]"),
        );
        for (let i = 0; i < acInputs.length; i++) {
          const el = acInputs[i] as HTMLInputElement | undefined;
          if (el === undefined || !isVisible(el)) continue;
          if ((el.value ?? "").trim().length > 0) continue;
          const sel = `input[role='combobox'][aria-autocomplete] >> nth=${i}`;
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
        return out.slice(0, 8);
      });
    } catch {
      return [];
    }
    const filled: string[] = [];
    for (const sel of triggerSelectors) {
      try {
        const trigger = page.locator(sel).first();
        if ((await trigger.count().catch(() => 0)) === 0) continue;
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        // An autocomplete input may only render its option list after a
        // keystroke — nudge it with ArrowDown so the option locator can resolve.
        if (sel.includes("input[")) {
          await page.keyboard.press("ArrowDown").catch(() => undefined);
          await page.waitForTimeout(400);
        }
        const option = page
          .locator(
            "[role='option']:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[cmdk-item]:not([aria-disabled='true']):not([data-disabled='true'])," +
              "[data-lgid='lg-option']:not([aria-disabled='true'])",
          )
          .first();
        if ((await option.count().catch(() => 0)) > 0) {
          const name = ((await option.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
          await option.click({ timeout: 5000 });
          filled.push(`${sel} → ${name}`);
          await page.waitForTimeout(300);
        }
        // Close the (multi-select) popover so the next trigger isn't occluded.
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      } catch {
        // Best-effort per combobox — a miss falls back to the planner.
      }
    }
    return filled;
  }

  // Satisfy an API-key/token creation form's required ACCESS-SCOPE controls when
  // its submit is disabled. Distinct from fillRequiredComboboxes (cmdk/Radix/
  // LeafyGreen survey selects): the "create a scoped credential" pattern gates
  // submit behind (a) a segmented "All access" / "Full access" button group that
  // starts unselected, and (b) a LemonSelect-style preset trigger
  // (`button[aria-haspopup="true"]` showing "Select…/Choose…") whose options
  // render in a body-portal Popover as `[role="menuitem"]` — NOT an
  // aria listbox, so the combobox filler's role/listbox query never sees it.
  // MEASURED 2026-06-24 (posthog /settings/user-api-keys "Create personal API
  // key": an "Organization & project access" segmented control + a "Select
  // preset" scopes dropdown both gate the aria-disabled "Create key"; picking
  // "All access" on each enables it and mints a phx_ key). Prefers the broadest
  // option so the resulting credential isn't dead-on-arrival. Idempotent and
  // tightly gated (callers only invoke it on a disabled submit).
  async satisfyScopePresets(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const done: string[] = [];
    const dialog = page.locator('[role="dialog"]').first();
    const root = (await dialog.count().catch(() => 0)) > 0 ? dialog : page.locator("body");

    // (1) Segmented access-scope buttons that start unselected. Exclude select
    // triggers (aria-haspopup) — those are handled in (2); a selected preset
    // trigger can also read "All access" and we must not re-open it here.
    try {
      const allAccess = root.locator('button:not([aria-haspopup="true"])', {
        hasText: /^(?:all access|full access|all scopes)$/i,
      });
      const n = Math.min(await allAccess.count().catch(() => 0), 3);
      for (let i = 0; i < n; i += 1) {
        const b = allAccess.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        await b.click({ timeout: 4000 }).catch(() => undefined);
        done.push("access:all-access");
        await page.waitForTimeout(300);
      }
    } catch {
      // best-effort
    }

    // (2) LemonSelect-style preset triggers still showing a placeholder.
    try {
      const triggers = root.locator('button[aria-haspopup="true"]');
      const n = Math.min(await triggers.count().catch(() => 0), 4);
      for (let i = 0; i < n; i += 1) {
        const t = triggers.nth(i);
        if (!(await t.isVisible().catch(() => false))) continue;
        const txt = ((await t.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
        // Only act on an UNSELECTED select (a "Select…/Choose…/Pick…"
        // placeholder) — never re-pick one that already holds a value.
        if (!/^(?:please\s+)?(?:select|choose|pick)\b/i.test(txt)) continue;
        await t.click({ timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        const options = page.locator(
          '.Popover [role="menuitem"], .Popover [role="option"], ' +
            '[role="listbox"] [role="option"], .LemonDropdown [role="menuitem"]',
        );
        const broad = options.filter({ hasText: /all access|full access/i }).first();
        const pick = (await broad.count().catch(() => 0)) > 0 ? broad : options.first();
        if ((await pick.count().catch(() => 0)) > 0) {
          const name = ((await pick.textContent().catch(() => "")) ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 30);
          await pick.click({ timeout: 4000 }).catch(() => undefined);
          done.push(`preset:${name}`);
          await page.waitForTimeout(400);
        } else {
          await page.keyboard.press("Escape").catch(() => undefined);
        }
      }
    } catch {
      // best-effort
    }
    return done;
  }

  // True when a visible advance/submit button (Next / Continue / Create /
  // Register / Submit / Get started / Finish) is currently DISABLED. The gate
  // for the deterministic combobox filler: only auto-satisfy a survey's
  // required selects when something is actually blocking forward progress.
  async hasDisabledSubmit(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const re =
          /\b(?:next|continue|register|submit|get started|finish|complete|done|create account|sign up|create key|create token|create personal)\b/i;
        for (const el of Array.from(document.querySelectorAll("button,[role='button']"))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const disabled =
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute("aria-disabled") === "true" ||
            el.getAttribute("disabled") !== null;
          if (!disabled) continue;
          // A disabled advance/submit button gates the survey. Match by verb
          // text OR by type=submit (meilisearch's button-register is a
          // type=submit whose visible label is icon+text, so a text-only match
          // missed it).
          const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          const isSubmit = (el as HTMLButtonElement).type === "submit";
          if (re.test(txt) || isSubmit) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  async extractScopedRouteCandidates(prefix: string): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(async (rawPrefix) => {
      const prefix = String(rawPrefix ?? "")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
      const candidates: string[] = [];
      const seen = new Set<string>();
      const add = (value: unknown) => {
        if (typeof value !== "string") return;
        const trimmed = value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(trimmed)) return;
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        candidates.push(trimmed);
      };
      const pathSegments = (href: string): string[] => {
        try {
          return new URL(href, location.origin).pathname.split("/").filter(Boolean);
        } catch {
          return [];
        }
      };

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const segs = pathSegments(anchor.getAttribute("href") ?? "");
        if ((segs[0] ?? "").toLowerCase() === prefix) add(segs[1]);
      }

      const walk = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value === null || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const preferredKeys =
          prefix === "p" || prefix.startsWith("project")
            ? ["slug", "projectSlug", "currentProjectSlug", "lastViewedProjectSlug", "id"]
            : prefix.startsWith("org") || prefix.startsWith("organization")
              ? ["slug", "orgSlug", "organizationSlug", "id"]
              : prefix.startsWith("workspace")
                ? ["slug", "workspaceSlug", "id"]
                : ["slug", "id"];
        for (const key of preferredKeys) add(record[key]);
        for (const item of Object.values(record)) walk(item);
      };

      const inspectJsonText = (text: string) => {
        try {
          walk(JSON.parse(text));
        } catch {
          // Ignore non-JSON storage/API payloads.
        }
      };
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key !== null) inspectJsonText(localStorage.getItem(key) ?? "");
        }
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const key = sessionStorage.key(i);
          if (key !== null) inspectJsonText(sessionStorage.getItem(key) ?? "");
        }
      } catch {
        // Storage can be blocked in hardened contexts; DOM/API probes are enough.
      }

      const likelyListApi = (url: string): boolean => {
        const lower = url.toLowerCase();
        if (!lower.includes("api")) return false;
        if (prefix === "p" || prefix.startsWith("project"))
          return /projects?[\w.-]*list|list[\w.-]*projects?/.test(lower);
        if (prefix.startsWith("org") || prefix.startsWith("organization"))
          return /organi[sz]ations?[\w.-]*list|orgs?[\w.-]*list|list[\w.-]*(orgs?|organi[sz]ations?)/.test(
            lower,
          );
        if (prefix.startsWith("workspace"))
          return /workspaces?[\w.-]*list|list[\w.-]*workspaces?/.test(lower);
        return /list/.test(lower);
      };
      const urls = Array.from(
        new Set(
          performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter(likelyListApi),
        ),
      ).slice(-8);
      for (const url of urls) {
        try {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 1_500);
          const res = await fetch(url, {
            credentials: "include",
            signal: controller.signal,
          });
          window.clearTimeout(timeout);
          if (!res.ok) continue;
          inspectJsonText(await res.text());
        } catch {
          // Best-effort only; resolver falls back to text/href matching.
        }
      }

      return candidates.slice(0, 20);
    }, prefix);
  }

  // Discrete strings an API key might occupy — for credential
  // extraction. Gathered so a key is read WHOLE and un-glued from its
  // neighbours: extractText() concatenates the whole <body>, which
  // fuses a key to an adjacent "Copy"/"Done" button with no separator.
  //
  // Two surfaces:
  //   1. input/textarea VALUES — a copy-to-clipboard key field. An
  //      input's value is not in textContent at all. Hidden and
  //      password fields are excluded (captcha tokens / the signup
  //      password), keeping this a clean credential surface.
  //   2. Each element's OWN direct text — the text nodes that are its
  //      immediate children, excluding descendants. A key in a
  //      <code>/<span>/<div> yields its clean value here even when a
  //      sibling button shares the same parent.
  // F10: read the clipboard contents (typically populated by the
  // user-modal's Copy button — every modern API-key reveal modal puts
  // the full secret here while displaying a masked stub). Requires
  // `clipboard-read` permission, granted at context creation. Returns
  // an empty string if the clipboard is empty; throws on permission
  // failure (caller catches and falls through to other paths).
  async readClipboard(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    // navigator.clipboard.readText() REJECTS ("Document is not focused") unless
    // the page has focus — which a sequence of Playwright actions + page.evaluate
    // reads between the copy-click and here can drop, silently yielding "". Bring
    // the tab to front and focus the document first. MEASURED 2026-06-24
    // (deepinfra: the copy-key clipboard held the 32-char key in a probe but the
    // replay's read came back empty — focus was the difference).
    await this.page.bringToFront().catch(() => undefined);
    await this.page.evaluate(() => window.focus()).catch(() => undefined);
    return await this.page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    });
  }

  // F10 fallback: ALL <input> / <textarea> values, ignoring
  // visibility and type filters. extractCredentialCandidates
  // deliberately skips `type=hidden` / `type=password` / invisible
  // elements (correct for general candidate scanning), but some
  // API-key modals stash the full key in a hidden input the masked
  // display reads from — and that needs to be reachable when the
  // visible extraction comes back truncated.
  async extractAllInputValues(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
        const value = el.value;
        if (value.trim().length > 0) out.push(value.trim());
      });
      return out;
    });
  }

  // Last-resort scan: walk innerText looking for credential-shaped
  // tokens (UUIDs and other long alnum+hyphen blobs) inside any DOM
  // subtree that ALSO contains a "Copy" / "Copy token" / "Copy to
  // clipboard" affordance. The Copy-button colocation is what tells
  // us "the UI is presenting this string AS a credential" — without
  // it, we'd false-positive on session IDs in URLs, cache-buster
  // query params, etc. Returns every match it finds; the caller picks
  // the first that survives extractApiKeyFromText.
  async extractCredentialsNearCopyButtons(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Find every Copy- OR reveal-class affordance. A secret table-cell value
      // (deepinfra's keys table) lives in a row next to BOTH a copy and a
      // toggle-visibility/reveal control — but those are often icon buttons
      // whose accessible NAME is the row's date, not "copy". So match the
      // element's id / class / data-testid too, which carry the semantic name
      // ("copy-key", "toggle-token-visibility"). Reveal patterns are scoped to
      // key/token/secret/visibility context so a generic "Show more" doesn't
      // anchor a harvest.
      const copyButtons = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], a, [aria-label]'),
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const name =
          `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`.toLowerCase();
        // el.className is an SVGAnimatedString on SVG elements — read via attr.
        const attrs =
          `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("data-test") ?? ""}`.toLowerCase();
        const hay = `${name} ${attrs}`;
        return /\bcopy\b|clipboard|reveal|toggle[-_ ]?(?:token|visibility)|show[-_ ]?(?:key|token|secret|api)/.test(
          hay,
        );
      });
      // For each, walk up a few ancestors and dump the subtree's
      // innerText. The token is somewhere in there.
      const seen = new Set<string>();
      const harvest = (text: string): void => {
        if (text.length === 0 || text.length > 4096) return;
        // Tokenize by whitespace — each token is a separate candidate.
        text.split(/\s+/).forEach((tok) => {
          if (tok.length < 16 || tok.length > 256) return;
          if (seen.has(tok)) return;
          seen.add(tok);
          out.push(tok);
        });
      };
      for (const btn of copyButtons) {
        // The value often lives in the copy button's OWN aria-label/title
        // ("Copy to clipboard: GOCSPX-…", "Copy api key sk-…") rather than in
        // any visible text node — GCP's new client-secret reveal does exactly
        // this, so the innerText-only walk below would miss it entirely.
        harvest(
          `${btn.getAttribute("aria-label") ?? ""} ${btn.getAttribute("title") ?? ""}`.trim(),
        );
        // Then walk up a few ancestors and dump the subtree's innerText.
        let anc: HTMLElement | null = btn;
        for (let i = 0; i < 6 && anc !== null; i++) {
          anc = anc.parentElement;
        }
        if (anc === null) continue;
        harvest((anc.innerText ?? "").trim());
      }
      return out;
    });
  }

  // DOM-proximity labeled credential candidates. Walks every visible
  // input/code/text element looking for credential-shape strings,
  // pairs each one with its nearest credential-label text in the DOM
  // tree, and returns the labeled tuples for the multi-cred extractor
  // to fold into the credentials Record.
  //
  // Complements the Phase E planner-quoted extractor — when the
  // planner's prose doesn't explicitly label values (multi-cred page
  // where the planner missed one), this DOM-grounded pass picks them
  // up via the visible labels the page itself renders.
  //
  // Returns shape:
  //   { value: "<credential-shape string>",
  //     label: "<the closest matching label text>" | null,
  //     isMasked: true if the value looks like a redacted display
  //               (••••, ****, contains "•" or runs of "*") }
  //
  // The caller maps label
  // text to canonical credential keys using the same vocabulary the
  // Phase E parser uses.
  async extractLabeledCredentialCandidates(): Promise<
    Array<{
      value: string;
      label: string | null;
      isMasked: boolean;
      hasRevealButton: boolean;
    }>
  > {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const LABEL_PHRASES = [
        // Generic
        "api key",
        "api token",
        "api secret",
        "secret key",
        "access key",
        "access token",
        "auth token",
        "bearer token",
        "personal access token",
        "client id",
        "client secret",
        "client key",
        // Cloudinary
        "cloud name",
        "cloudname",
        // Algolia
        "application id",
        "app id",
        "admin api key",
        "search api key",
        "monitoring api key",
        "search-only api key",
        // Twilio
        "account sid",
        "auth token",
        // Stripe
        "publishable key",
        "secret key",
        // AWS
        "access key id",
        "secret access key",
        // OAuth1
        "consumer key",
        "consumer secret",
        "access token secret",
        // Misc
        "project api key",
        "personal api key",
        "organization id",
        "org id",
        "app key",
        "app secret",
        // Pusher (and other keys tables) label fields bare: key / secret /
        // cluster. Without these the value inherits the nearest recognized
        // label (the app_id field), mislabeling key + secret as "app id".
        "cluster",
        "key",
        "secret",
      ];

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const isCredentialShape = (s: string): boolean => {
        // Reasonable credential length range
        if (s.length < 6 || s.length > 256) return false;
        // Reject pure prose (spaces inside)
        if (/\s/.test(s)) return false;
        // Must include some entropy markers: digit + letter combo OR
        // a credential prefix like sk_/pk_/api_/ etc.
        const hasDigit = /\d/.test(s);
        const hasLetter = /[A-Za-z]/.test(s);
        if (!hasDigit && !hasLetter) return false;
        // Reject pure URL fragments
        if (/^https?:\/\//i.test(s)) return false;
        // Reject simple words / capitalized phrases
        if (/^[A-Za-z]+$/.test(s) && s.length < 12) return false;
        // Reject label-text masquerading as a value: a short token of only
        // letters + separators with NO digit (e.g. the literal "app_id" /
        // "secret" label text pusher renders next to the real value). Real
        // credentials carry a digit or are long; field labels don't.
        if (!hasDigit && /^[a-z][a-z_-]*$/i.test(s) && s.length < 16) return false;
        return true;
      };
      // Inline mirror of credential-shape.ts MASKED_DISPLAY_RE — page.evaluate
      // code can't import, so keep this regex byte-identical to the canonical.
      // Any mask glyph: bullet/circle, 3+ asterisks, ellipsis, or 3+ dots. (Was
      // `[•●⬤]{3,}|\*{4,}`, which MISSED the ellipsis masks GCP/Zilliz/S3 use.)
      const isMaskedShape = (s: string): boolean => /[•●⬤]|\*{3,}|…|\.{3,}/.test(s);

      // Compute element-center coords for proximity matching.
      const centerOf = (el: Element): { x: number; y: number } => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      // Collect every visible label-text bounding box on the page.
      // Each label entry = { phrase, x, y }. We pre-compute these so
      // the per-candidate inner loop is O(L) not O(L * N).
      type LabelHit = { phrase: string; x: number; y: number; el: Element };
      const labelHits: LabelHit[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        // Only consider DIRECT text content — child element text gets
        // claimed by THOSE elements' own label scans.
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim().toLowerCase();
        if (direct.length === 0 || direct.length > 100) return;
        // Normalize separators so underscore/hyphen field labels match the
        // space-form phrases: pusher renders "app_id" / "app_key" / "app_secret"
        // and "app_id".includes("app id") is false, so every value used to
        // inherit a far "App keys" heading. With this, each field label matches
        // its own phrase and wins the proximity match.
        const directNorm = direct.replace(/[_-]+/g, " ");
        for (const phrase of LABEL_PHRASES) {
          if (directNorm.includes(phrase)) {
            const c = centerOf(el);
            labelHits.push({ phrase, x: c.x, y: c.y, el });
            break; // one label per element is enough
          }
        }
      });

      // Detect reveal buttons (eye / show / unmask icons) — any visible
      // button or [role=button] / svg whose aria-label / title / text
      // matches the reveal vocabulary. We only check WHETHER one exists
      // near a candidate; the clicker (revealMaskedCredentials below)
      // does the actual click pass.
      const REVEAL_PATTERN = /\b(?:reveal|show|unmask|view|toggle|copy)\b/i;
      const revealButtons: Array<{ x: number; y: number; el: Element }> = [];
      document
        .querySelectorAll<HTMLElement>('button, [role="button"], a, [aria-label], [title]')
        .forEach((el) => {
          if (!isVisible(el)) return;
          const hay = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
          if (!REVEAL_PATTERN.test(hay)) return;
          const c = centerOf(el);
          revealButtons.push({ x: c.x, y: c.y, el });
        });

      // For each candidate, find nearest label by Euclidean distance.
      const findNearestLabel = (x: number, y: number): string | null => {
        let best: { phrase: string; d: number } | null = null;
        for (const lh of labelHits) {
          const dx = lh.x - x;
          const dy = lh.y - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          // Conservative cap — labels more than 400px away from the
          // value aren't visually grouped with it. Roughly: a typical
          // table-row width.
          if (d > 400) continue;
          if (best === null || d < best.d) best = { phrase: lh.phrase, d };
        }
        return best?.phrase ?? null;
      };
      const hasNearbyReveal = (x: number, y: number): boolean => {
        for (const rb of revealButtons) {
          const dx = rb.x - x;
          const dy = rb.y - y;
          // Reveal/copy buttons are usually right next to the value —
          // 200px is generous.
          if (Math.sqrt(dx * dx + dy * dy) < 200) return true;
        }
        return false;
      };

      const seen = new Set<string>();
      const out: Array<{
        value: string;
        label: string | null;
        isMasked: boolean;
        hasRevealButton: boolean;
      }> = [];
      const pushCandidate = (value: string, el: Element): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return;
        const masked = isMaskedShape(trimmed);
        if (!masked && !isCredentialShape(trimmed)) {
          // 0.8.2-rc.17 — when the whole text-node string has
          // whitespace (Cloudinary's "Cloud name: dlq4xgrca" sits
          // in a SINGLE <div> with the label and value glued
          // together), isCredentialShape rejects the whole string.
          // Try to split on the canonical label-value separator
          // patterns ("Label: value", "Label = value", "Label\nvalue")
          // and re-evaluate each side. The token side gets the
          // candidate slot; the label side already lives on its own
          // (we don't need to push it). First-wins on duplicates.
          const split = /^([A-Za-z][A-Za-z _-]{1,40}?)\s*[:=]\s*([A-Za-z0-9._\-]{4,256})$/.exec(
            trimmed,
          );
          if (split === null) return;
          const valueToken = split[2];
          if (valueToken === undefined) return;
          if (!isCredentialShape(valueToken)) return;
          if (seen.has(valueToken)) return;
          seen.add(valueToken);
          const c = centerOf(el);
          const label = findNearestLabel(c.x, c.y);
          out.push({
            value: valueToken,
            label,
            isMasked: false,
            hasRevealButton: false,
          });
          return;
        }
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        const c = centerOf(el);
        const label = findNearestLabel(c.x, c.y);
        const hasReveal = masked ? hasNearbyReveal(c.x, c.y) : false;
        out.push({
          value: trimmed,
          label,
          isMasked: masked,
          hasRevealButton: hasReveal,
        });
      };

      // 0. Inline config snippets: a credential block listing multiple
      //    label = "value" pairs in one text run (pusher's App Keys page:
      //    app_id = "2164307" key = "..." secret = "..." cluster = "ap3").
      //    No separate label ELEMENTS exist, so the proximity matcher mislabels
      //    every value with whatever heading is nearest. Parse the label-value
      //    pairs straight from the page text — each pair's own label is
      //    authoritative. Runs FIRST so its correctly-labeled candidates win
      //    the `seen` dedup over the proximity passes. Noise pairs are harmless:
      //    a skill only matches the labels it asks for.
      const bodyText = document.body?.innerText ?? "";
      const INLINE_PAIR =
        /\b([A-Za-z][A-Za-z0-9_-]{1,40})\s*[:=]\s*["']?([A-Za-z0-9._-]{6,256})["']?/g;
      for (const m of bodyText.matchAll(INLINE_PAIR)) {
        const label = (m[1] ?? "").toLowerCase();
        const value = m[2] ?? "";
        if (!isCredentialShape(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label, isMasked: false, hasRevealButton: false });
      }

      // 1. <input> / <textarea> values (visible only).
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "password"))
          return;
        if (!isVisible(el)) return;
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : "";
        if (value.length > 0) pushCandidate(value, el);
      });

      // 2. Direct text content in visible leaf elements.
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        if (direct.length === 0 || direct.length > 256) return;
        pushCandidate(direct, el);
      });

      // 3. Structural containers (code/pre/kbd) where the credential
      //    is interpolated through nested spans.
      document.querySelectorAll('code, pre, kbd, samp, [role="textbox"]').forEach((el) => {
        if (!isVisible(el)) return;
        const full = (el.textContent ?? "").trim();
        if (full.length === 0 || full.length > 256) return;
        pushCandidate(full, el);
      });

      return out;
    });
  }

  // Click every visible "Reveal" / "Show" / "Eye" / "Copy" button on
  // the page that sits next to a masked credential display. Used as a
  // pre-extract pass for services like Cloudinary that hide the
  // api_secret behind a click-to-reveal icon. Best-effort: failures
  // don't throw; subsequent extract pass tries whatever surfaced.
  // Returns the number of buttons successfully clicked.
  async revealMaskedCredentials(): Promise<{
    clicked: number;
    diagnostic: string[];
  }> {
    if (this.page === null) throw new Error("Browser not started");
    const page = this.page;
    const probe = await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      // Walk up to the nearest "row-like" ancestor — a <tr>, a <li>,
      // or any container ≤ 800px wide with limited height. Cloudinary,
      // Algolia, Twilio all use table rows; clicking the reveal in
      // ROW X must populate the value in ROW X, not some neighbor row.
      const rowAncestor = (el: Element): Element | null => {
        let cur: Element | null = el;
        for (let i = 0; i < 8 && cur !== null; i++) {
          if (cur.tagName === "TR" || cur.tagName === "LI") return cur;
          const r = cur.getBoundingClientRect();
          if (r.width > 200 && r.width < 900 && r.height < 200) return cur;
          cur = cur.parentElement;
        }
        return el.parentElement;
      };

      // 1. Find masked-display elements + their row containers.
      type Masked = { el: Element; row: Element | null };
      const masked: Masked[] = [];
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        const t = direct.trim();
        if (t.length < 3 || t.length > 100) return;
        if (!/[•●⬤*]{3,}/.test(t) && !/^[•*]+$/.test(t)) return;
        masked.push({ el, row: rowAncestor(el) });
      });
      document.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((el) => {
        if (!isVisible(el)) return;
        masked.push({ el, row: rowAncestor(el) });
      });
      const selectorFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const all = Array.from(document.querySelectorAll(tag));
        const idx = all.indexOf(el);
        return `${tag}:nth-of-type(${idx + 1})`;
      };

      // No masked placeholder anywhere — but some consoles hide the key
      // ENTIRELY behind a "View/Show Key" button with no ••• shown at all
      // (Zilliz's "View My Personal Key"). The row-anchored pass below has
      // nothing to anchor on, so without this the reveal pass bails and the
      // extractor reports no_legit_credential on a page that DOES have a key.
      // Anchor-free fallback: click a button whose label pairs a SAFE reveal
      // verb with a credential noun, excluding destructive verbs (reset/
      // regenerate/delete/revoke/rotate would mint or destroy a key, not
      // reveal the existing one).
      if (masked.length === 0) {
        const KEY_NOUN =
          /\b(?:api\s*key|secret|token|credential|personal\s+key|access\s+key|key)\b/i;
        const SAFE_REVEAL = /\b(?:view|show|reveal|display|see)\b/i;
        const DESTRUCTIVE =
          /\b(?:reset|regenerat\w*|delete|revoke|rotate|create|new|remove|add|download)\b/i;
        const out: string[] = [];
        const diag: string[] = [];
        document
          .querySelectorAll<HTMLElement>('button, [role="button"], a[role="button"]')
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay =
              `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`
                .replace(/\s+/g, " ")
                .trim();
            if (hay.length === 0 || hay.length > 60) return;
            if (!SAFE_REVEAL.test(hay) || !KEY_NOUN.test(hay)) return;
            if (DESTRUCTIVE.test(hay)) return;
            out.push(selectorFor(el));
            diag.push(`anchorless_key_reveal:"${hay.slice(0, 40)}"`);
          });
        return {
          selectors: out,
          diagnostic: out.length > 0 ? diag : ["no_masked_displays"],
        };
      }

      // 2. Classify candidate buttons. Prefer SHOW/REVEAL/EYE; fall
      //    back to COPY only when no show button exists in the row.
      //    (Copy generally puts value in clipboard, not in DOM —
      //    which our extractor can't read in headless.)
      const SHOW_PATTERN = /\b(?:reveal|show|unmask|view|toggle|eye)\b/i;
      const COPY_PATTERN = /\bcopy\b/i;

      const collectButtonsInRow = (
        row: Element | null,
      ): { showBtns: Element[]; copyBtns: Element[] } => {
        const showBtns: Element[] = [];
        const copyBtns: Element[] = [];
        if (row === null) return { showBtns, copyBtns };
        row
          .querySelectorAll<HTMLElement>(
            'button, [role="button"], a[role="button"], [aria-label], [title]',
          )
          .forEach((el) => {
            if (!isVisible(el)) return;
            const hay = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.className ?? ""}`;
            if (SHOW_PATTERN.test(hay)) showBtns.push(el);
            else if (COPY_PATTERN.test(hay)) copyBtns.push(el);
          });
        return { showBtns, copyBtns };
      };

      const selectors: string[] = [];
      const diagnostic: string[] = [];
      const usedRows = new Set<Element>();
      for (const m of masked) {
        if (m.row === null) continue;
        if (usedRows.has(m.row)) continue;
        usedRows.add(m.row);
        const { showBtns, copyBtns } = collectButtonsInRow(m.row);
        if (showBtns.length > 0) {
          const btn = showBtns[0]!;
          const sel = selectorFor(btn);
          selectors.push(sel);
          const label = (
            btn.textContent ??
            btn.getAttribute("aria-label") ??
            btn.getAttribute("title") ??
            ""
          )
            .trim()
            .slice(0, 40);
          diagnostic.push(`row→show:"${label}"→${sel}`);
        } else if (copyBtns.length > 0) {
          diagnostic.push(
            `row→copy_only_no_show_button (copy='${copyBtns.length} found' — skipped, would only populate clipboard not DOM)`,
          );
        } else {
          diagnostic.push("row→no_buttons_found");
        }
      }
      return { selectors, diagnostic };
    });

    let clicked = 0;
    for (const sel of probe.selectors) {
      try {
        await page.locator(sel).first().click({ timeout: 1500 });
        clicked += 1;
        // Reveal click often triggers a fetch (Cloudinary returns the
        // secret over an XHR before populating the DOM). Wait longer
        // than the previous 150ms.
        await this.sleep(800);
      } catch {
        // Click failed — best-effort.
      }
    }
    return { clicked, diagnostic: probe.diagnostic };
  }

  async extractCredentialCandidates(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const out: string[] = [];
      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      document.querySelectorAll("input, textarea").forEach((el) => {
        // Only text-shaped inputs can RENDER a credential. A checkbox/
        // radio/button's `value` is a markup constant, not page content —
        // zilliz's CookieScript banner ships `<input type="checkbox"
        // value="personalization">` and those words sit earlier in DOM
        // order than the real key, so the validator-shaped scan tier was
        // returning them as the "credential".
        if (
          el instanceof HTMLInputElement &&
          !["text", "search", "url", "tel", "number", "email", ""].includes(el.type)
        ) {
          return;
        }
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : "";
        if (value.trim().length > 0 && isVisible(el)) out.push(value.trim());
      });
      document.querySelectorAll("body *").forEach((el) => {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        if (!isVisible(el)) return;
        let direct = "";
        el.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) direct += n.textContent ?? "";
        });
        direct = direct.trim();
        // A real key is short; a long blob is a paragraph, not a key.
        if (direct.length > 0 && direct.length <= 256) out.push(direct);
      });
      // Structural containers (<code>, <pre>, kbd, samp, [role=textbox])
      // often render a credential by interpolating it through nested
      // <span>s — the loop above sees an empty direct-text and skips
      // them. Push the full textContent so a UUID built as
      // <code><span>7</span><span>5</span>…</code> is still scannable.
      document.querySelectorAll('code, pre, kbd, samp, [role="textbox"]').forEach((el) => {
        if (!isVisible(el)) return;
        const full = (el.textContent ?? "").trim();
        if (full.length > 0 && full.length <= 256) out.push(full);
      });
      return out;
    });
  }

  // Wait for the signup form to actually render before the planner
  // screenshots the page (F1). SPA and two-stage signup pages render
  // the form after JS executes; planning against a pre-render
  // skeleton makes the planner emit plausible-but-wrong selectors and
  // every executed action then times out. Best-effort — both waits
  // swallow their own timeout so the planner always still runs.
  async waitForFormReady(timeoutMs = 15000): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // PERF: networkidle almost never settles on real signup pages
    // (analytics sockets / long-poll / Intercom widgets keep traffic
    // flowing indefinitely), so the previous 15s ceiling was 15s of
    // pure deadtime per call. Cap at 1500ms so the bot gets the
    // signal-when-it's-real and moves on otherwise. domcontentloaded
    // is the real "DOM is parsed" signal; networkidle here is just
    // a best-effort polish wait for the SPA to settle.
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch {
      // already past domcontentloaded → fine
    }
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 1_500 });
    } catch {
      // expected on most modern pages — fall through to the element wait.
    }
    // F13 follow-up — if we landed on a full-page anti-bot interstitial
    // (Cloudflare "Just a moment..." / Turnstile pre-clear / similar),
    // wait for it to clear and the real page to render. networkidle
    // sometimes fires DURING the interstitial because Cloudflare keeps
    // the connection quiet between the verify-handshake and the
    // redirect to the real page. Without this, the bot snapshots a
    // 2-element interstitial inventory and bails.
    await this.waitForAntiBotInterstitialToClear(timeoutMs);
    // rc.33 — extended the element-wait selector to match the broader
    // inventory walk added in rc.26 (menuitem/option/combobox plus
    // anchors). Porter and Koyeb's API-tokens pages are nested SPAs
    // that initially render with NO <input>/<button> — just <a> and
    // role=button divs. The old selector timed out at 15s on those
    // pages, the planner saw an empty inventory, and the post-verify
    // loop burned rounds clicking nothing.
    try {
      await this.page.waitForSelector(
        'input, button, textarea, select, a[href], [role="button"], [role="menuitem"]',
        { state: "visible", timeout: timeoutMs },
      );
    } catch {
      // No interactive element appeared in time — let the planner run
      // anyway; it fails cleanly rather than hanging.
    }
    // The generic wait above is satisfied by ANY interactive element —
    // on a signup page with marketing chrome (links, marketplace badges)
    // that fires while the actual auth widget is still an async spinner.
    // The bot then snapshots a form-less inventory and bails
    // `oauth_required` ("no email/password form"). MEASURED 2026-06-11
    // (zilliz /signup: right-panel spinner, marketing copy on the left).
    // So: if a loading spinner is visible AND no auth-form signal exists
    // yet, give the widget a bounded extra wait to hydrate.
    await this.waitForAuthWidgetHydration();
  }

  // Bounded poll for an auth-form signal when the page is still showing a
  // loading spinner. Strictly additive: returns immediately unless a
  // spinner is visible AND no auth signal (email/password input or a
  // provider/sign-up button) is present yet. Best-effort — never throws.
  async waitForAuthWidgetHydration(timeoutMs = 8_000): Promise<void> {
    if (!this.page) return;
    const authWidgetHydrationProbe = String.raw`(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const anyVis = (sel) =>
        Array.from(document.querySelectorAll(sel)).some(vis);
      const hasAuthInput = anyVis(
        'input[type="email"],input[type="password"],input[name="email" i],input[name="password" i]',
      );
      let hasAuthButton = false;
      const re = /\b(sign\s?up|continue with|log ?in with|with google|with github|with sso|create account)\b/i;
      for (const el of Array.from(
        document.querySelectorAll('button,a[href],[role="button"]'),
      )) {
        if (!vis(el)) continue;
        if (re.test((el.textContent ?? "").trim())) {
          hasAuthButton = true;
          break;
        }
      }
      const spinnerVisible = anyVis(
        '[role="progressbar"],[aria-busy="true"],[class*="spin" i],[class*="loading" i],[class*="loader" i],.ant-spin,.MuiCircularProgress-root',
      );
      return { hasAuth: hasAuthInput || hasAuthButton, spinnerVisible };
    })()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = (await Promise.race([
          this.page.evaluate(authWidgetHydrationProbe),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("auth widget probe timed out")), 1_500),
          ),
        ])) as {
          hasAuth: boolean;
          spinnerVisible: boolean;
        };
        // Done the moment an auth signal appears, or once nothing is
        // spinning anymore (no point waiting on a page that simply has
        // no auth widget — a true OAuth-less/blank page bails honestly).
        if (state.hasAuth) return;
        if (!state.spinnerVisible) return;
      } catch {
        return; // navigation / context teardown — let the caller proceed
      }
      await this.sleep(500);
    }
  }

  // rc.33 — wait for the DOM to grow past a minimum interactive-
  // element count, polling every 500ms up to timeoutMs. The
  // single-element wait in waitForFormReady is fast-path; this is
  // for SPAs where DOMContentLoaded fires almost immediately but the
  // React/Vue/Svelte tree takes 5-15s more to actually render. Used
  // after navigate() in the post-verify loop so the planner doesn't
  // see a 0-button page that's still rendering. Best-effort —
  // returns whenever the count is reached OR the timeout elapses.
  async waitForInteractiveDom(minElements = 5, timeoutMs = 20_000): Promise<void> {
    if (!this.page) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const count = await Promise.race([
          this.page.evaluate((min: number) => {
            const sels =
              'input,textarea,select,button,a[href],[role="button"],[role="menuitem"],[role="option"]';
            const nodes = Array.from(document.querySelectorAll(sels));
            let visible = 0;
            for (const n of nodes) {
              const el = n as HTMLElement;
              const r = el.getBoundingClientRect();
              if (r.width >= 2 && r.height >= 2) visible++;
              if (visible >= min) return visible;
            }
            return visible;
          }, minElements),
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error("interactive DOM probe timed out")), 1_500),
          ),
        ]);
        if (count >= minElements) return;
      } catch {
        // Page may be mid-navigation — try again on the next tick.
      }
      await this.sleep(500);
    }
  }

  // Find and click an "Accept"-class button to dismiss any visible
  // cookie/consent banner. Returns the clicked button's text when a
  // dismiss fired, or null when no banner / no clickable affordance
  // was found. Best-effort: never throws.
  //
  // Strategy: cookie-banner CTAs use a very narrow vocabulary across
  // the entire web ("Accept all", "Allow all", "Got it", "Reject all"
  // …). Instead of trying to enumerate every vendor's container
  // selector (osano/onetrust/cookiebot/trustarc/iubenda/quantcast/
  // truste/usercentrics/etc. — never complete), we just hunt for any
  // visible button whose TEXT matches the canonical CTA. Risk of a
  // false positive (clicking a non-consent button whose text happens
  // to match) is acceptable because the strings we accept are
  // extremely banner-specific. We don't match bare "accept" / "ok" /
  // "continue" — too generic to be safe.
  async dismissConsentBanner(): Promise<string | null> {
    if (!this.page) return null;
    // Prefer-order: most specific (and most clearly consent-only)
    // first. First visible button matching one of these wins.
    const PREFER_ORDER: RegExp[] = [
      /^\s*(?:accept all cookies|accept all|allow all cookies|allow all)\s*$/i,
      /^\s*(?:i accept|i agree|i understand|got it!?|sounds good)\s*$/i,
      /^\s*(?:accept|agree)\s*(?:cookies|all|&\s*close)?\s*$/i,
      /^\s*(?:reject all cookies|reject all|decline all|deny all)\s*$/i,
    ];
    let target: { x: number; y: number; text: string } | null = null;
    try {
      target = await this.page.evaluate(
        ({ patterns }) => {
          const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="link"]'),
          ) as HTMLElement[];
          const visible = (el: HTMLElement): boolean => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const s = window.getComputedStyle(el);
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              parseFloat(s.opacity || "1") > 0.01
            );
          };
          for (const reStr of patterns) {
            const re = new RegExp(reStr, "i");
            const hit = candidates.find((c) => visible(c) && re.test((c.textContent || "").trim()));
            if (hit !== undefined) {
              const r = hit.getBoundingClientRect();
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                text: (hit.textContent || "").trim().slice(0, 40),
              };
            }
          }
          return null;
        },
        { patterns: PREFER_ORDER.map((p) => p.source) },
      );
    } catch {
      return null;
    }
    if (target === null) return null;
    try {
      await this.page.mouse.click(target.x, target.y);
      // Wait for the banner to fade out + any post-dismiss reflow
      // (e.g. lazy-rendering the previously-blocked OAuth chooser).
      // Try networkidle first for SPA re-renders, fall back to a
      // fixed dwell.
      await this.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      await this.page.waitForTimeout(800);
      return target.text;
    } catch {
      return null;
    }
  }

  // Cloudflare and similar gateways serve a full-page interstitial
  // ("Just a moment..." / Turnstile pre-clear) before the real page.
  // The challenge usually clears within ~5-10s — the bot just needs
  // to wait. Detected from page text patterns rather than URL: the
  // URL stays the same; the body replaces.
  //
  // Returns when the interstitial is gone, or after `timeoutMs` if it
  // never cleared. Best-effort: any unexpected error returns early
  // rather than failing the whole signup.
  private async waitForAntiBotInterstitialToClear(timeoutMs: number): Promise<void> {
    if (!this.page) return;
    const first = await this.pollUntilInterstitialClears(timeoutMs);
    // Never saw an interstitial, or saw one and it cleared on its own —
    // nothing more to do.
    if (!first.detected || first.cleared) return;
    // Still on the interstitial at the deadline. If Cloudflare reported
    // the challenge PASSED ("Verification successful"), the redirect is
    // just racing/stuck — be patient through ANOTHER full window before
    // touching anything (a reload mid-redirect can re-arm the challenge).
    if (first.verificationPassed) {
      const patient = await this.pollUntilInterstitialClears(timeoutMs);
      if (patient.cleared) return;
      // "Verification successful" but the page never advances is the
      // signature of a STALE cf_clearance cookie — issued on a prior visit
      // (often a different egress IP), which CF matches ("successful") but
      // the origin then rejects, looping forever on "Waiting for the page
      // to load." MEASURED: a clean profile clears codesandbox's challenge
      // in ~12s; the stale cookie is what stalls the shared profile. Drop
      // the CF cookies to force a FRESH challenge, then reload.
      if (await this.clearCloudflareCookiesAndRetry(timeoutMs)) return;
      // Or the auto-redirect simply stalled with a still-valid clearance —
      // re-navigate past the one-shot challenge token.
      if (await this.forceNavigatePastClearedChallenge()) return;
    }
    // Force the real page: now that the cf_clearance cookie is set, a
    // reload often renders it. domcontentloaded (not networkidle) — the
    // real page is usually a heavy SPA that never reaches networkidle, so
    // waiting for it just burns the budget back into a timeout. (If it's a
    // server-side risk-score block — fingerprint/IP — reload won't help,
    // but the caller's inventory diagnostic will still surface the block.)
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch {
      // reload failed — proceed with what's there
    }
    await this.pollUntilInterstitialClears(Math.max(5000, timeoutMs / 2));
  }

  // Drop Cloudflare's anti-bot cookies (cf_clearance + __cf_bm) so the next
  // request triggers a FRESH managed challenge, then reload and wait for it
  // to clear. Scoped to cookie NAME — only CF's own cookies are removed, so
  // an OAuth provider's session on accounts.google.com / github.com is
  // untouched. A fresh challenge on a residential IP clears in ~12-15s, so
  // we give it a generous window. Returns true if the interstitial is gone.
  private async clearCloudflareCookiesAndRetry(timeoutMs: number): Promise<boolean> {
    if (!this.page || !this.context) return false;
    try {
      await this.context.clearCookies({ name: "cf_clearance" });
      await this.context.clearCookies({ name: "__cf_bm" });
    } catch {
      // clearCookies filter unsupported / failed — nothing to retry on.
      return false;
    }
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed — still give the poll a chance below.
    }
    const after = await this.pollUntilInterstitialClears(Math.max(20_000, timeoutMs));
    return after.cleared || !after.detected;
  }

  // With a CONFIRMED Cloudflare pass, re-navigate to the current URL with
  // the one-shot `__cf_chl_*` challenge token stripped — the cf_clearance
  // cookie is already set, so the edge serves the real page instead of the
  // stuck redirect. Returns true if the interstitial is gone afterwards.
  // Returns false (caller falls back to a plain reload) when there's no
  // token to strip or the navigation didn't clear the gate.
  private async forceNavigatePastClearedChallenge(): Promise<boolean> {
    if (!this.page) return false;
    const cleaned = stripCloudflareChallengeParams(this.page.url());
    if (!cleaned) return false;
    try {
      await this.page.goto(cleaned, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      return false;
    }
    const after = await this.pollUntilInterstitialClears(Math.max(5000, 8000));
    // cleared = saw it then it went away; !detected = the real page rendered
    // immediately (no interstitial on the post-nav page at all).
    return after.cleared || !after.detected;
  }

  // One poll loop. `detected` = an interstitial was observed at least
  // once; `cleared` = it was observed AND then went away (vs. still there
  // at the deadline); `verificationPassed` = Cloudflare reported the
  // challenge succeeded at some point during the wait (see
  // classifyInterstitialText).
  private async pollUntilInterstitialClears(
    timeoutMs: number,
  ): Promise<{ detected: boolean; cleared: boolean; verificationPassed: boolean }> {
    if (!this.page) return { detected: false, cleared: false, verificationPassed: false };
    const deadline = Date.now() + timeoutMs;
    let detected = false;
    let verificationPassed = false;
    while (Date.now() < deadline) {
      let title = "";
      let bodyText = "";
      try {
        title = await this.page.title();
        bodyText = await this.page.evaluate(() => (document.body?.innerText ?? "").slice(0, 500));
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const c = classifyInterstitialText(title + " " + bodyText);
      if (c.verificationPassed) verificationPassed = true;
      if (!c.onInterstitial) {
        if (detected) {
          // Give the freshly-revealed page a tick to hydrate before
          // the inventory scan.
          await new Promise((r) => setTimeout(r, 800));
        }
        return { detected, cleared: detected, verificationPassed };
      }
      detected = true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { detected, cleared: false, verificationPassed };
  }

  // Walk the live DOM (piercing open shadow roots) and return every
  // visible interactive element with a bot-computed selector (F3 T1).
  // The planner picks from this inventory instead of inventing
  // selector strings. Selectors prefer #id then [name] — Playwright's
  // CSS engine pierces open shadow roots, so those resolve for
  // shadow-DOM fields too.
  // The DOM-walk + extraction logic, generalized to run against ANY frame
  // context (the main page or a child <iframe>'s own Frame) — Playwright's
  // Frame.evaluate reaches a cross-origin frame's main world at the CDP level,
  // the same primitive isPayPalHostedCheckout/fillAndSubmitCheckout/
  // detectThreeDsChallenge already use to read/fill cross-origin PSP fields.
  // Pulled out of extractInteractiveElements (below) so that method can call
  // it once for the main frame and once per child frame, tagging each result
  // with where it came from.
  private async extractElementsFromContext(ctx: Page | Frame) {
    return await ctx.evaluate(() => {
      const SELECTOR =
        // rc.26 — added Radix/Headless-UI menu + option items so
        // dropdown contents (Fireworks "Create API Key" → API Key /
        // Service Account menu, Sentry's per-row permissions) end up
        // in the planner's inventory.
        // rc.35 — added [role="link"] (Google account-chooser cards
        // are <div role="link" data-identifier="…">), and <label>
        // (Koyeb's onboarding renders each radio choice as a styled
        // <label> wrapping a sr-only <input type=radio>; the visible
        // click target is the label, but the bot's inventory selector
        // didn't catch labels so the planner had no clickable target
        // matching the visible button text).
        // T38 — added [role="radio"] for onboarding wizards that mark
        // each card with a semantic radio role (some Cloudinary /
        // Stytch flows). Card-radio clusters with NO role are detected
        // post-extraction by assignCardRadioGroups using bounding-box
        // similarity, so this addition is just for the semantically-
        // tagged case.
        'input,textarea,select,button,a,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="combobox"],[contenteditable=""],[contenteditable="true"]';

      // Collect candidates across the document and every open shadow
      // root. Closed shadow roots are unreachable — accepted.
      const collected: Element[] = [];
      const walk = (root: Document | ShadowRoot): void => {
        // Defensive: a root with no querySelectorAll (a detached/closed
        // node surfaced mid-render by Descope-style web components on
        // app.redislabs.com / console.weaviate.cloud) used to crash the
        // whole inventory with "Cannot read properties of undefined
        // (reading 'querySelectorAll')", failing the run before the
        // planner ever saw the page. Skip such a node instead.
        //
        // `== null` (not `=== null`) is load-bearing: `el.shadowRoot` is
        // typed `ShadowRoot | null`, but a detached/closed custom element
        // can yield `undefined` at runtime. The recursion below calls
        // `walk(el.shadowRoot)` whenever it isn't `null`, so an `undefined`
        // shadowRoot reaches here and `typeof undefined.querySelectorAll`
        // THROWS before the typeof guard can fire — exactly the #59
        // redis-cloud crash, which recurred 2026-06-03 even with the
        // null-only guard in place. The loose check covers both.
        if (root == null || typeof root.querySelectorAll !== "function") return;
        root.querySelectorAll(SELECTOR).forEach((n) => collected.push(n));
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot !== null) walk(el.shadowRoot);
        });
      };
      walk(document);

      // 0.8.3-rc.1 — also collect OAuth-affordance iframes. Modern
      // signup pages (Mixpanel, many Next.js sites) render "Continue
      // with Google" via Google's GIS iframe at
      // `accounts.google.com/gsi/button` — cross-origin, so the
      // button INSIDE the iframe isn't in our DOM. The iframe element
      // ITSELF is clickable from the parent page though; clicking its
      // bounding box dispatches the click event into the iframe, and
      // Google's button-handler then opens the OAuth popup. We
      // surface these iframes as synthetic OAuth buttons (with a
      // visibleText that findOAuthButton matches) so the OAuth-first
      // scan can pick them up.
      document
        .querySelectorAll<HTMLIFrameElement>('iframe[src*="accounts.google.com/gsi/button"]')
        .forEach((n) => collected.push(n));

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0.01
        );
      };

      // G12 — visually-hidden checkbox/radio surfacing. Custom-styled
      // TOS checkboxes are real `<input type=checkbox>` elements with
      // `opacity:0` / `sr-only` styling behind a styled <label>; they
      // are user-clickable (the label's click event fires the input)
      // and `page.check()` reaches them, but isVisible() drops them
      // and the inventory has nothing for the planner to target.
      // Mistral's org-creation TOS gate is the canonical case.
      //
      // Returns true when the hidden input is a checkbox/radio AND
      // its label (associated by `for=` or by ancestor wrap) is
      // itself visible. Standalone hidden checkboxes outside any
      // label stay filtered — they're typically state-tracking inputs
      // the bot must not toggle.
      const isCheckableHiddenByStyledLabel = (el: Element): boolean => {
        if (!(el instanceof HTMLInputElement)) return false;
        const t = el.type;
        if (t !== "checkbox" && t !== "radio") return false;
        // Style-hidden (sr-only / opacity:0) is the case to recover;
        // genuinely display:none is intentionally hidden state, skip.
        const s = window.getComputedStyle(el);
        if (s.display === "none") return false;
        // Find an associated label and check its visibility.
        const id = el.getAttribute("id");
        let label: Element | null = null;
        if (id !== null && id.length > 0) {
          try {
            label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          } catch {
            /* malformed id — fall through */
          }
        }
        if (label === null) label = el.closest("label");
        if (label === null) return false;
        return isVisible(label);
      };

      const clean = (s: string | null | undefined): string | null => {
        if (s === null || s === undefined) return null;
        const t = s.replace(/\s+/g, " ").trim();
        return t.length === 0 ? null : t.slice(0, 120);
      };

      const labelFor = (el: Element): string | null => {
        const id = el.getAttribute("id");
        if (id !== null && id.length > 0) {
          try {
            const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (l !== null) return clean(l.textContent);
          } catch {
            /* malformed id — fall through */
          }
        }
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy !== null && labelledBy.trim().length > 0) {
          const parts: string[] = [];
          for (const part of labelledBy.split(/\s+/)) {
            const t = clean(document.getElementById(part)?.textContent);
            if (t !== null) parts.push(t);
          }
          if (parts.length > 0) return clean(parts.join(" "));
        }
        const anc = el.closest("label");
        const ancestorLabel = anc !== null ? clean(anc.textContent) : null;
        if (ancestorLabel !== null) return ancestorLabel;

        let cur: Element | null = el;
        for (let depth = 0; depth < 3 && cur !== null; depth += 1) {
          let sib = cur.previousElementSibling;
          for (let scanned = 0; scanned < 4 && sib !== null; scanned += 1) {
            const nestedLabel = clean(sib.querySelector("label")?.textContent);
            if (nestedLabel !== null) return nestedLabel;
            const labelish =
              sib.tagName.toLowerCase() === "label" ||
              /\b(label|field|form|control)\b/i.test(sib.getAttribute("class") ?? "");
            const t = clean(sib.textContent);
            if (
              t !== null &&
              t.length <= 80 &&
              !/[{};]/.test(t) &&
              (labelish || t.split(/\s+/).length <= 8)
            ) {
              return t;
            }
            sib = sib.previousElementSibling;
          }
          cur = cur.parentElement;
        }
        return null;
      };

      const inConsent = (el: Element): boolean =>
        el.closest(
          '[class*="osano"],[id*="onetrust"],[id*="cookie"],[class*="cookie-consent"],[class*="cookie-banner"],[class*="cookieConsent"]',
        ) !== null;

      // Accessible label of a descendant icon — an icon-only "Sign in
      // with Google" button carries no text, but its <img alt>, its
      // <svg><title>, or a descendant [aria-label] names the provider.
      const iconLabelFor = (el: Element): string | null => {
        const img = el.querySelector("img[alt]");
        if (img !== null) {
          const alt = clean(img.getAttribute("alt"));
          if (alt !== null) return alt;
        }
        const svgTitle = el.querySelector("svg title");
        if (svgTitle !== null) {
          const t = clean(svgTitle.textContent);
          if (t !== null) return t;
        }
        const labelled = el.querySelector("[aria-label]");
        if (labelled !== null) {
          const l = clean(labelled.getAttribute("aria-label"));
          if (l !== null) return l;
        }
        return null;
      };

      const selectorFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        let base: string;
        const testId =
          el.getAttribute("data-testid") ??
          el.getAttribute("data-test-id") ??
          el.getAttribute("data-test") ??
          el.getAttribute("data-cy") ??
          el.getAttribute("data-qa");
        const id = el.getAttribute("id");
        const name = el.getAttribute("name");
        if (testId !== null && testId.length > 0) {
          const attr = el.hasAttribute("data-testid")
            ? "data-testid"
            : el.hasAttribute("data-test-id")
              ? "data-test-id"
              : el.hasAttribute("data-test")
                ? "data-test"
                : el.hasAttribute("data-cy")
                  ? "data-cy"
                  : "data-qa";
          base = `[${attr}="${CSS.escape(testId)}"]`;
        } else if (id !== null && /^[A-Za-z][\w-]*$/.test(id)) {
          base = `#${id}`;
        } else if (name !== null && name.length > 0) {
          base = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        } else {
          // Structural fallback — a short nth-of-type path.
          const parts: string[] = [];
          let node: Element | null = el;
          for (let depth = 0; depth < 4 && node !== null; depth++) {
            const cur: Element = node;
            const t = cur.tagName.toLowerCase();
            const parent: Element | null = cur.parentElement;
            if (parent === null) {
              parts.unshift(t);
              break;
            }
            const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
            const idx = sibs.indexOf(cur) + 1;
            parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${idx})` : t);
            node = parent;
          }
          base = parts.join(" > ");
        }
        // Guarantee the selector resolves to exactly this element. A
        // 4-level path (or a stray duplicate id) can be ambiguous —
        // Back4App's "Continue with email" path also matched a
        // "Flexibility" tab, and Playwright strict mode then refuses
        // to act. `>> nth=` is Playwright syntax that pins the exact
        // match. (querySelectorAll can't see into shadow roots, so a
        // shadow element's count reads 0 — fine, it returns base.)
        try {
          const matches = document.querySelectorAll(base);
          if (matches.length <= 1) return base;
          const idx = Array.prototype.indexOf.call(matches, el);
          return idx >= 0 ? `${base} >> nth=${idx}` : base;
        } catch {
          return base;
        }
      };

      const slug = (s: string | null, fallback: string): string => {
        const base = (s ?? fallback)
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48);
        return base.length > 0 ? base : fallback;
      };

      const directLabel = (el: Element): string | null =>
        clean(el.getAttribute("aria-label")) ??
        clean(el.getAttribute("title")) ??
        clean(el.getAttribute("name")) ??
        clean(el.textContent);

      const isFormControlElement = (el: Element): boolean =>
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;

      const regionFor = (el: Element): Element | null =>
        el.closest(
          '[role="dialog"],dialog,[aria-modal="true"],nav,main,header,footer,aside,form,section,article',
        );

      const regionName = (region: Element | null): string | null => {
        if (region === null) return null;
        const role = region.getAttribute("role");
        const tag = region.tagName.toLowerCase();
        const kind =
          role === "dialog" || tag === "dialog" || region.getAttribute("aria-modal") === "true"
            ? "dialog"
            : tag === "nav"
              ? "navigation"
              : tag;
        const labelledBy = region.getAttribute("aria-labelledby");
        let label: string | null = null;
        if (labelledBy !== null && labelledBy.length > 0) {
          try {
            label = clean(document.getElementById(labelledBy)?.textContent);
          } catch {
            label = null;
          }
        }
        label =
          label ??
          clean(region.getAttribute("aria-label")) ??
          clean(region.querySelector("h1,h2,h3,[role='heading']")?.textContent) ??
          clean(region.textContent)?.slice(0, 60) ??
          kind;
        return `${kind}:${slug(label, kind)}`;
      };

      const elementKind = (el: Element): string => {
        const role = el.getAttribute("role");
        const tag = el.tagName.toLowerCase();
        if (role !== null && role.length > 0) return role;
        if (tag === "a") return "link";
        return tag;
      };

      const topmostStatus = (el: Element): { topmost: boolean; occludedBy: string | null } => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { topmost: false, occludedBy: null };
        const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
        const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
        let top = document.elementFromPoint(x, y);
        if (top === null) return { topmost: false, occludedBy: null };
        // document.elementFromPoint returns the shadow HOST, not the control
        // nested in its open shadow root — so a shadow-DOM CTA (Casetify's
        // Add-to-Cart web component) hit-tested against its own host would be
        // reported occludedBy that host and topmost:false, and the host agent
        // would skip a button nothing actually covers. Re-hit-test inside each
        // open shadow root at the same point to reach the deepest composed
        // element, matching what the user's pointer would strike. Closed roots
        // yield a null shadowRoot and the descent stops — same as the DOM.
        while (top.shadowRoot !== null) {
          const deeper = top.shadowRoot.elementFromPoint(x, y);
          if (deeper === null || deeper === top) break;
          top = deeper;
        }
        if (top === el || el.contains(top)) return { topmost: true, occludedBy: null };
        let owner: Node | null = top;
        while (owner !== null) {
          if (owner === el) return { topmost: true, occludedBy: null };
          const assignedSlot: HTMLSlotElement | null =
            owner instanceof Element || owner instanceof Text ? owner.assignedSlot : null;
          if (assignedSlot !== null) {
            owner = assignedSlot;
            continue;
          }
          const parent: ParentNode | null = owner.parentNode;
          owner = parent instanceof ShadowRoot ? parent.host : parent;
        }
        return { topmost: false, occludedBy: regionName(regionFor(top)) ?? elementKind(top) };
      };

      // N1 onboarding-wizard cards (2026-06-08). Chakra/React card pickers
      // (imagekit's step-1/3 objective cards, axiom/pusher role cards) render
      // each selectable card as a BARE clickable div — cursor:pointer, but no
      // button/a/role/input semantics — so the SELECTOR walk above misses
      // them entirely and the planner has no target → it hallucinates
      // selectors and the stalled-wizard breaker fires. Collect them so the
      // existing assignCardRadioGroups can cluster them. Tightly scoped to
      // avoid flooding the inventory on ordinary pages:
      //   - cursor:pointer + visible
      //   - card-sized (not a tiny inline link, not a full-page wrapper)
      //   - has its OWN short label text
      //   - does NOT contain an already-collected interactive element (a
      //     wrapper around a real button isn't a card — we already have it)
      //   - OUTERMOST clickable in a nest (keep the card, drop its inner <p>)
      //   - capped
      {
        const alreadyMatched = new Set<Element>(collected);
        const MAX_CARDS = 16;
        const raw: Element[] = [];
        // Eligible tags: generic containers OR any custom element (hyphenated
        // tag). Mirror of exported isBareClickableCardTag — keep in sync.
        // 1inch onboarding renders each choice as a custom UI-kit element
        // (<uikit-internal-chip data-test-id="activity-chip-…">) with
        // cursor:pointer but no button/role/input semantics and no div/section
        // wrapper, so the SELECTOR walk AND the old div-only scan both missed
        // it, leaving the planner no clickable target.
        const isCardTag = (t: string): boolean =>
          t === "div" ||
          t === "li" ||
          t === "article" ||
          t === "section" ||
          t === "label" ||
          t.includes("-");
        // Walk the light DOM AND every open shadow root — a UI-kit chip can
        // live inside a web component's shadow tree.
        const scanRoot = (root: Document | ShadowRoot): void => {
          if (root == null || typeof root.querySelectorAll !== "function") return;
          for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
            if (raw.length >= MAX_CARDS) break;
            if (el.shadowRoot !== null) scanRoot(el.shadowRoot);
            const tag = el.tagName.toLowerCase();
            if (!isCardTag(tag)) continue;
            if (alreadyMatched.has(el)) continue;
            if (!isVisible(el)) continue;
            if (window.getComputedStyle(el).cursor !== "pointer") continue;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 24 || r.width > 900 || r.height > 600) continue;
            const txt = clean(el.textContent);
            const hasText = txt !== null && txt.length >= 2 && txt.length <= 120;
            // A custom element whose label renders inside its shadow DOM has an
            // empty textContent — qualify it on a stable test-id instead, which
            // is exactly what a QA-instrumented chip carries.
            const testId =
              el.getAttribute("data-testid") ??
              el.getAttribute("data-test-id") ??
              el.getAttribute("data-test") ??
              el.getAttribute("data-cy") ??
              el.getAttribute("data-qa");
            const hasTestId = tag.includes("-") && testId !== null && testId.length > 0;
            if (!hasText && !hasTestId) continue;
            try {
              if (el.querySelector(SELECTOR) !== null) continue;
            } catch {
              continue;
            }
            raw.push(el);
          }
        };
        scanRoot(document);
        // Keep only the outermost clickable per nest (Chakra cards wrap an
        // inner <p>; cursor:pointer inherits, so both match — we want the card).
        const rawSet = new Set(raw);
        for (const el of raw) {
          let p = el.parentElement;
          let nested = false;
          while (p !== null) {
            if (rawSet.has(p)) {
              nested = true;
              break;
            }
            p = p.parentElement;
          }
          if (!nested) collected.push(el);
        }
      }

      const seen = new Set<Element>();
      // T38 — parent identity + bounding-box dimensions + clickable
      // bit, captured in lockstep with `out` so the Node-side
      // assignCardRadioGroups can detect card-radio clusters without
      // re-walking the DOM.
      const parentIds = new Map<Element, number>();
      let nextParentId = 0;
      const clusterMeta: Array<{
        parentId: number;
        width: number;
        height: number;
        clickable: boolean;
      }> = [];
      const out: Array<{
        tag: string;
        type: string | null;
        id: string | null;
        name: string | null;
        placeholder: string | null;
        ariaLabel: string | null;
        role: string | null;
        labelText: string | null;
        visibleText: string | null;
        selector: string;
        visible: boolean;
        inViewport: boolean;
        inConsentWidget: boolean;
        href: string | null;
        iconLabel: string | null;
        testId: string | null;
        title: string | null;
        landmark: string | null;
        value: string | null;
        checked: boolean | null;
        selectOptions: Array<{ value: string; text: string }> | null;
        selectedOptionText: string | null;
        interactedThisRun: boolean;
        sealed: boolean;
        screenPath: string | null;
        container: string | null;
        topmost: boolean | null;
        occludedBy: string | null;
        autocomplete: string | null;
        dataRole: string | null;
      }> = [];
      for (const el of collected) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el) && !isCheckableHiddenByStyledLabel(el)) continue;
        const r = el.getBoundingClientRect();
        // T38 — capture parent identity + dimensions in lockstep with
        // the `out.push` below. Pure scalars only; no DOM nodes leak
        // through serialization.
        const parent = el.parentElement;
        let parentId: number;
        if (parent === null) {
          parentId = -1;
        } else if (parentIds.has(parent)) {
          parentId = parentIds.get(parent) as number;
        } else {
          parentId = nextParentId++;
          parentIds.set(parent, parentId);
        }
        const tagLower = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role");
        const clickable =
          tagLower === "button" ||
          tagLower === "a" ||
          tagLower === "label" ||
          roleAttr === "button" ||
          roleAttr === "link" ||
          roleAttr === "radio" ||
          roleAttr === "menuitem" ||
          roleAttr === "menuitemradio" ||
          roleAttr === "option" ||
          window.getComputedStyle(el).cursor === "pointer";
        clusterMeta.push({
          parentId,
          width: r.width,
          height: r.height,
          clickable,
        });
        // 0.8.3-rc.1 — Google Identity Services iframe special-case.
        // The iframe is cross-origin so el.textContent is empty,
        // but we know structurally it's a "Continue with Google"
        // affordance. Surface synthetic text so findOAuthButton
        // matches it and the OAuth-first scan picks it up.
        const isGoogleGSIIframe =
          el instanceof HTMLIFrameElement &&
          (el.getAttribute("src") ?? "").includes("accounts.google.com/gsi/button");
        const container = regionName(regionFor(el));
        const status = topmostStatus(el);
        const pathLabel = isGoogleGSIIframe
          ? "Continue with Google"
          : isFormControlElement(el)
            ? (labelFor(el) ?? directLabel(el) ?? iconLabelFor(el))
            : (directLabel(el) ?? labelFor(el) ?? iconLabelFor(el));
        out.push({
          tag: isGoogleGSIIframe ? "button" : el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: isGoogleGSIIframe ? "Continue with Google" : el.getAttribute("aria-label"),
          role: isGoogleGSIIframe ? "button" : el.getAttribute("role"),
          labelText: labelFor(el),
          visibleText: isGoogleGSIIframe ? "Continue with Google" : clean(el.textContent),
          selector: selectorFor(el),
          visible: true,
          inViewport:
            r.top >= 0 &&
            r.left >= 0 &&
            r.bottom <= window.innerHeight &&
            r.right <= window.innerWidth,
          inConsentWidget: inConsent(el),
          href: (el.getAttribute("href") ?? "").slice(0, 300) || null,
          iconLabel: iconLabelFor(el),
          // The element's test-id, the GOLD-STANDARD stable anchor: authors set
          // data-testid/data-test/data-cy precisely so it survives refactors +
          // copy changes, which is exactly what text_match does not. Captured so
          // the synthesizer can prefer it over planner-gloss text. Common
          // variants folded to one field; first present wins.
          testId:
            el.getAttribute("data-testid") ??
            el.getAttribute("data-test-id") ??
            el.getAttribute("data-test") ??
            el.getAttribute("data-cy") ??
            el.getAttribute("data-qa") ??
            null,
          title: clean(el.getAttribute("title")),
          landmark: (() => {
            // F15 — nearest HTML5 landmark ancestor. Used by the
            // inventory renderer to disambiguate elements with the
            // same visibleText. Returns the lowercased tag name
            // ("header" / "main" / "footer" / "nav" / "aside" /
            // "article" / "section") or null when outside any.
            const lm = el.closest("header,main,footer,nav,aside,article,section");
            return lm !== null ? lm.tagName.toLowerCase() : null;
          })(),
          // Locale-stable role signals for money-path fill guards. Prefer
          // autocomplete over visible labels (labels flip under i18n).
          autocomplete: (el.getAttribute("autocomplete") ?? "").trim() || null,
          dataRole:
            (el.getAttribute("data-field-role") ?? el.getAttribute("data-role") ?? "").trim() ||
            null,
          value:
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : el instanceof HTMLSelectElement
                ? el.value
                : null,
          // 0.8.3-rc.1 — checkbox/radio runtime state. `value` for a
          // checkbox is the static `value` attribute (defaults to
          // "on") regardless of whether it's currently ticked, so any
          // caller wanting to find UNCHECKED checkboxes needs `checked`
          // explicitly. The submit-disabled re-plan hint uses this to
          // surface concrete unticked candidates to the planner.
          checked:
            el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
              ? el.checked
              : null,
          // For <select>: the currently-selected option's visible text
          // and a short list of available option labels. The combination
          // is how the planner detects the "React-defaulted dropdown"
          // pattern that broke Railway — `value=""` + a first option
          // whose text reads as a placeholder ("No workspace", "Select
          // …", "Choose …") means the user (or bot) has not yet
          // committed a choice and React form state still treats the
          // field as untouched. The planner needs that signal to issue
          // a `select` step before clicking submit. Limit to 8 options
          // — long pickers (countries, timezones) would otherwise blow
          // the inventory rendering.
          selectOptions:
            el instanceof HTMLSelectElement
              ? Array.from(el.options)
                  .slice(0, 8)
                  .map((o) => ({
                    value: o.value,
                    text: clean(o.textContent) ?? "",
                  }))
              : null,
          selectedOptionText:
            el instanceof HTMLSelectElement
              ? clean(el.options[el.selectedIndex]?.textContent ?? null)
              : null,
          interactedThisRun: el.getAttribute("data-ts-touched") === "1",
          sealed: el.getAttribute("data-ts-sealed-payment") === "1",
          screenPath:
            `${container ?? "body:root"} > ${elementKind(el)}:` +
            slug(pathLabel, `${elementKind(el)}-${out.length}`),
          container,
          topmost: status.topmost,
          occludedBy: status.occludedBy,
        });
      }
      return { out, clusterMeta, documentOrigin: location.origin };
    });
  }

  private framePath(frame: Frame): string {
    const indexes: number[] = [];
    let current: Frame | null = frame;
    while (current !== null) {
      const parent = current.parentFrame();
      if (parent === null) break;
      const index = parent.childFrames().indexOf(current);
      if (index < 0) return "";
      indexes.unshift(index);
      current = parent;
    }
    return indexes.join("/");
  }

  private frameWithinCaptcha(frame: Frame): boolean {
    let current: Frame | null = frame;
    while (current !== null) {
      if (CAPTCHA_FRAME_HOST_RE.test(current.url())) return true;
      current = current.parentFrame();
    }
    return false;
  }

  private async frameSecurity(frame: Frame): Promise<{ origin: string; opaque: boolean }> {
    const url = frame.url();
    if (url === "" || url === "about:blank" || url === "about:srcdoc") {
      return { origin: "null", opaque: true };
    }
    const origin = new URL(url).origin;
    if (origin === "null") return { origin: "null", opaque: true };
    const activeOrigin = await this.frameActiveOrigin(frame);
    if (activeOrigin === null || activeOrigin !== origin) return { origin: "null", opaque: true };
    if (await this.frameSandboxedWithoutSameOrigin(frame)) return { origin: "null", opaque: true };
    return { origin, opaque: false };
  }

  private async frameActiveOrigin(frame: Frame): Promise<string | null> {
    const page = this.page;
    if (page === null) return null;
    const path = this.framePath(frame);
    if (path === "") return null;
    let cdp: CDPSession | null = null;
    try {
      let frameSession = true;
      try {
        cdp = await page.context().newCDPSession(frame);
      } catch {
        frameSession = false;
        cdp = await page.context().newCDPSession(page);
      }
      const { frameTree } = await cdp.send("Page.getFrameTree");
      let currentTree = frameTree;
      if (frameSession) {
        const frameTreeUrl = `${currentTree.frame.url}${currentTree.frame.urlFragment ?? ""}`;
        if (frameTreeUrl !== frame.url()) return null;
      } else {
        let currentFrame = page.mainFrame();
        for (const part of path.split("/")) {
          const index = Number.parseInt(part, 10);
          const childFrame = currentFrame.childFrames()[index];
          const childTree = currentTree.childFrames?.[index];
          if (childFrame === undefined || childTree === undefined) return null;
          const childTreeUrl = `${childTree.frame.url}${childTree.frame.urlFragment ?? ""}`;
          if (childTreeUrl !== childFrame.url()) return null;
          currentFrame = childFrame;
          currentTree = childTree;
        }
        if (currentFrame !== frame) return null;
      }
      await cdp.send("Storage.getStorageKey", { frameId: currentTree.frame.id });
      return currentTree.frame.securityOrigin || null;
    } catch {
      return null;
    } finally {
      await cdp?.detach().catch(() => undefined);
    }
  }

  // A frame whose owning <iframe> carries a `sandbox` attribute WITHOUT the
  // allow-same-origin token has an OPAQUE active origin per spec, no matter
  // what its URL says — tagging it by URL would let the same-domain secret
  // check trust a frame the browser itself treats as null-origin
  // (nonblank-sandbox-origin-bypass). Sandbox flags propagate to nested
  // browsing contexts, so every ancestor's owning iframe is checked too.
  // This only ever ADDS a restriction: a failure to read the attribute fails
  // closed (opaque), never grants trust.
  private async frameSandboxedWithoutSameOrigin(frame: Frame): Promise<boolean> {
    let current: Frame | null = frame;
    while (current !== null && current.parentFrame() !== null) {
      try {
        const owner = await current.frameElement();
        try {
          const sandbox = await owner.getAttribute("sandbox");
          if (
            sandbox !== null &&
            !sandbox.toLowerCase().split(/\s+/).includes("allow-same-origin")
          ) {
            return true;
          }
        } finally {
          await owner.dispose().catch(() => undefined);
        }
      } catch {
        return true;
      }
      current = current.parentFrame();
    }
    return false;
  }

  // Resolve a previously-tagged frame path back to its live Playwright Frame —
  // used by the frame-aware act helpers below (clickInFrame/typeInFrame/
  // clickViaJsInFrame/selectInFrame) to act on an element that
  // extractInteractiveElements found inside a child <iframe>. Returns null
  // when the frame has since navigated or detached (a fresh observe/extract
  // picks up whatever replaced it); the
  // caller surfaces that as a normal "target not found" error, never a
  // silent wrong-frame action.
  private resolveFrame(target: FrameTarget): Frame | null {
    if (!this.page) return null;
    let frame = this.page.mainFrame();
    for (const part of target.framePath.split("/")) {
      if (!/^\d+$/.test(part)) return null;
      const child = frame.childFrames()[Number.parseInt(part, 10)];
      if (child === undefined) return null;
      frame = child;
    }
    if (frame.isDetached()) return null;
    return frame;
  }

  private async resolveFrameElement(
    target: FrameTarget,
    selector: string,
    index = 0,
  ): Promise<ElementHandle<Element> | null> {
    const frame = this.resolveFrame(target);
    if (frame === null || this.frameWithinCaptcha(frame)) return null;
    const handle = await frame
      .locator(selector)
      .nth(Math.max(0, Math.floor(index)))
      .elementHandle({ timeout: 8000 })
      .catch(() => null);
    if (handle === null) return null;
    try {
      const security = await this.frameSecurity(frame);
      await handle.evaluate((element) => element.isConnected);
      const expectedOpaque = target.frameOpaque === true || target.frameOrigin === "null";
      const matches = expectedOpaque
        ? security.opaque
        : !security.opaque && security.origin === target.frameOrigin;
      if (!matches) {
        await handle.dispose().catch(() => undefined);
        return null;
      }
      return handle;
    } catch {
      await handle.dispose().catch(() => undefined);
      return null;
    }
  }

  private frameLabel(target: FrameTarget): string {
    return target.frameOrigin;
  }

  // Frame-scoped click. Deliberately simpler than click() above (no radio/
  // checkbox/aria-toggle special-casing) — it's the escape hatch for a
  // control that lives inside an <iframe>, mirroring how resolvePageTarget is
  // the escape hatch for a control missing from the main-frame inventory.
  // Plain Playwright locator actions cover the money-path case this exists
  // for (a merchant's own same-domain checkout options rendered in an
  // iframe), the same primitives fillAndSubmitCheckout already relies on for
  // cross-origin PSP fields.
  async clickInFrame(target: FrameTarget, selector: string): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector);
    if (handle === null) {
      throw new Error(
        `click: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      await handle.click({ timeout: 8000 });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async clickViaJsInFrame(target: FrameTarget, selector: string, index = 0): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector, index);
    if (handle === null) {
      throw new Error(
        `js_click: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      await handle.evaluate((el) => (el as HTMLElement).click());
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // Frame-scoped type/fill, for type and (guarded, see provision-session.ts)
  // type_secret targets that resolve into a frame. Same humanized-vs-fast
  // split as type() above, without the multi-input-OTP auto-advance nuance —
  // out of scope for the checkout-option case this exists for.
  async typeInFrame(target: FrameTarget, selector: string, text: string): Promise<void> {
    const handle = await this.resolveFrameElement(target, selector);
    if (handle === null) {
      throw new Error(`type: the target's frame is no longer present (${this.frameLabel(target)})`);
    }
    try {
      await handle.waitForElementState("visible", { timeout: 10000 });
      if (!this.humanize) {
        await handle.fill(text);
        return;
      }
      await handle.click({ timeout: 8000 }).catch(() => undefined);
      await handle.fill("").catch(() => undefined);
      await handle.type(text, { delay: rand(40, 110) });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  // Frame-scoped native-<select> pick. Deliberately narrower than
  // selectOption() above (no custom-combobox path, no row-scan label
  // heuristics — only the direct label→control association): the escape
  // hatch exists for a merchant's own checkout dropdowns rendered inside an
  // <iframe>, which are native selects. Resolution + option match + commit +
  // input/change dispatch all happen in ONE in-frame evaluate, so a frame
  // DOM that re-renders between round-trips can't strand the action halfway.
  async selectInFrame(
    target: FrameTarget,
    selector: string,
    optionMatcher?: string,
  ): Promise<string> {
    const handle = await this.resolveFrameElement(target, selector);
    if (handle === null) {
      throw new Error(
        `select: the target's frame is no longer present (${this.frameLabel(target)})`,
      );
    }
    try {
      const result = await handle.evaluate(
        (element, needle) => {
          let control: Element | null = element;
          if (control instanceof HTMLLabelElement) control = control.control;
          if (!(control instanceof HTMLSelectElement)) {
            return {
              ok: false as const,
              reason:
                `target resolves to <${(control ?? element).tagName.toLowerCase()}>, not a ` +
                `native <select> — only native selects are supported inside a frame ` +
                `(drive a custom widget with click)`,
            };
          }
          const options = Array.from(control.options);
          if (options.length === 0) {
            return { ok: false as const, reason: "the <select> has no selectable option" };
          }
          // Same default as the main-frame path: first NON-empty value when
          // no matcher is given ("Select…" placeholders are the wrong pick).
          let chosen = options.find((option) => option.value.length > 0) ?? options[0]!;
          if (needle !== null) {
            const hit = options.find((option) =>
              (option.textContent ?? "").toLowerCase().includes(needle),
            );
            if (hit === undefined) return { ok: false as const, reason: "no option matched" };
            chosen = hit;
          }
          control.value = chosen.value;
          if (control.value !== chosen.value) {
            return { ok: false as const, reason: "selected value did not stick" };
          }
          // Playwright's own selectOption fires input+change natively — the
          // merchant form listens on these; mirror it.
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
          // Same touched-marker as the main-frame path (DEFAULTED-dropdown
          // warning suppression).
          control.setAttribute("data-ts-touched", "1");
          return {
            ok: true as const,
            text: (chosen.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
        },
        optionMatcher !== undefined ? optionMatcher.toLowerCase() : null,
      );
      if (!result.ok) {
        const detail =
          result.reason === "no option matched" && optionMatcher !== undefined
            ? `no option matched ${JSON.stringify(optionMatcher)}`
            : result.reason;
        throw new Error(`select (frame ${this.frameLabel(target)}) ${selector}: ${detail}`);
      }
      return result.text;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    if (!this.page) throw new Error("Browser not started");
    const page = this.page;
    const mainRaw = await this.extractElementsFromContext(page);
    const mainGroups = assignCardRadioGroups(mainRaw.clusterMeta);
    const mainElements = mainRaw.out.map((e, i) => ({
      ...e,
      cardRadioGroup: mainGroups[i] ?? null,
      frameOrigin: null,
      frameUrl: null,
      framePath: null,
    }));

    // Cross-frame support — surface elements inside child <iframe>s (same- AND
    // cross-origin), each tagged with the frame's own origin/url so a caller
    // can apply domain-lock/secret-fill guards against the ELEMENT's real
    // origin, never the top page's (see frameTargetAllowed in
    // provision-session.ts — the load-bearing reason this tag exists at
    // all). Nothing is flattened away: every frame element keeps its origin.
    // page.frames() is already flat (it includes nested frames, not just
    // direct children) — the same primitive isPayPalHostedCheckout/
    // fillAndSubmitCheckout/detectThreeDsChallenge use to reach cross-origin
    // frame content.
    const framedElements: Array<Omit<InteractiveElement, "index">> = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      const frameUrl = frame.url();
      // Captcha challenge iframes are handled by the dedicated captcha-gate
      // flow, not by ordinary ref-based clicking — surfacing their internal
      // DOM as el_table rows would invite the planner to poke at the
      // challenge instead of going through that flow. Skip them; nothing
      // else about captcha handling changes.
      if (this.frameWithinCaptcha(frame)) continue;
      try {
        const raw = await this.extractElementsFromContext(frame);
        const security = await this.frameSecurity(frame);
        const frameOrigin = security.origin;
        const groups = assignCardRadioGroups(raw.clusterMeta);
        for (const [i, e] of raw.out.entries()) {
          framedElements.push({
            ...e,
            cardRadioGroup: groups[i] ?? null,
            frameOrigin,
            frameUrl,
            framePath: this.framePath(frame),
            ...(security.opaque ? { frameOpaque: true } : {}),
          });
        }
      } catch {
        // Cross-origin frame mid-navigation, torn down, or otherwise
        // unreachable this instant — best-effort; the next observe retries.
      }
    }

    // T38 index is assigned ONCE, after merging, so it stays a stable,
    // collision-free ordinal across the whole combined set.
    return [...mainElements, ...framedElements].map((e, i) => ({ ...e, index: i }));
  }

  // replay-per-leg-signature — the checkout-leg shape signature (see
  // checkoutFieldSetSignature in @trusty-squire/recipe-schema) is computed
  // from a page's FULL field-name set, deliberately including `type=hidden`
  // fields — unlike extractInteractiveElements above (which deliberately
  // skips hidden/password inputs, since those aren't things a planner can
  // act on), a checkout platform's own hidden session/GraphQL-serialized
  // fields are exactly the stable, platform-authored signal the signature
  // depends on. Reads every input/select/textarea's `name` (falling back to
  // `id`) with a single flat query — no visibility/shadow-DOM handling,
  // matching the method proven in the field-name-set discriminator report.
  async extractCheckoutFieldNames(): Promise<string[]> {
    if (!this.page) throw new Error("Browser not started");
    return await this.page.evaluate(() => {
      const names: string[] = [];
      document.querySelectorAll("input,select,textarea").forEach((el) => {
        const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
        if (name.length > 0) names.push(name);
      });
      return names;
    });
  }

  // Resolve a selector against the live page for the verify step
  // (F3 T5). Returns the match count plus the first match's
  // tag/id/name so the caller can confirm a still-resolving selector
  // points at the element it was extracted from (not a recycled
  // node). An invalid selector (e.g. a stray `:contains()`) is caught
  // and reported as count 0 — never an uncaught throw.
  async inspectSelector(
    selector: string,
  ): Promise<{ count: number; tag: string | null; id: string | null; name: string | null }> {
    if (!this.page) throw new Error("Browser not started");
    try {
      const loc = this.page.locator(selector);
      const count = await loc.count();
      if (count === 0) return { count: 0, tag: null, id: null, name: null };
      const info = await loc.first().evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("id"),
        name: el.getAttribute("name"),
      }));
      return { count, tag: info.tag, id: info.id, name: info.name };
    } catch {
      return { count: 0, tag: null, id: null, name: null };
    }
  }

  // ───────────── OAuth handshake (T6/T7) ─────────────

  // Click an OAuth provider button and adopt whichever page now
  // carries the handshake. Google OAuth either redirects the current
  // tab or opens a popup window; this normalizes both so the agent's
  // consent loop can treat `this.page` as "the page showing Google's
  // screens" without caring which transport the service chose.
  // settleAfterOAuth() restores the product page afterwards.
  async startOAuth(selector: string): Promise<void> {
    if (!this.page || !this.context) throw new Error("Browser not started");
    this.maybeAttachOAuthNetListener();
    if (
      !/accounts\.google\.com|github\.com\/login|login\.microsoftonline\.com/i.test(this.page.url())
    ) {
      this.oauthProductPage = this.page;
    }
    this.oauthProviderPage = null;
    this.oauthProviderPageClosed = false;
    // Race a popup `page` event against the click. context-level
    // "page" fires for both window.open popups and target=_blank.
    const popupPromise = this.context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await this.click(selector);
    const popup = await popupPromise;
    if (popup !== null && popup !== this.page && !popup.isClosed()) {
      this.page = popup;
      this.oauthProviderPage = popup;
      // A provider returning from OAuth is allowed to close its own popup.
      // Recover synchronously at that boundary so a follow-up page read never
      // keeps a dead provider handle as the controller's active page.
      this.restoreProductPageWhenOAuthPageCloses(popup, this.oauthProductPage);
    }
    this.adoptLivePage();
    try {
      await this.page?.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort — the agent's consent loop re-reads state regardless
    }
  }

  // Complete an OAuth handshake without exposing the provider page as the
  // operator's active page after the action returns. OAuth providers routinely
  // close the popup (and some close a same-tab callback window) after exchanging
  // the token. A recovery tab keeps the shared browser session reachable if a
  // provider closes the observed product page itself.
  //
  // This intentionally does not broaden authentication authority. It only
  // clicks the product's already-observed OAuth control and waits for the
  // provider-owned window to finish; no credentials, frames, or consent scopes
  // are read or bypassed here.
  async loginWithOAuth(selector: string, settleTimeoutMs = 12_000): Promise<void> {
    const product = this.page;
    const context = this.context;
    if (product === null || product.isClosed() || context === null) {
      throw new Error("OAuth login cannot start because the product page is unavailable");
    }

    this.maybeAttachOAuthNetListener();
    this.oauthProductPage = product;
    this.oauthProviderPage = null;
    this.oauthProviderPageClosed = false;
    const productUrl = product.url();
    let recovery: Page | null = null;
    let providerPage: Page | null = null;
    let productDeparted = false;
    const onProductNavigation = (frame: Frame): void => {
      if (frame !== product.mainFrame()) return;
      if (!this.isOAuthProductUrl(frame.url(), productUrl)) productDeparted = true;
    };
    product.on("framenavigated", onProductNavigation);
    try {
      recovery = await context.newPage();
      await recovery.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      let resolvePopup: (page: Page | null) => void = () => undefined;
      const popupPromise = new Promise<Page | null>((resolve) => {
        resolvePopup = resolve;
      });
      const onPopup = (page: Page): void => {
        context.off("page", onPopup);
        resolvePopup(page);
      };
      context.on("page", onPopup);
      try {
        try {
          await this.click(selector);
        } catch (error) {
          if (!product.isClosed()) throw error;
        }
        providerPage = await Promise.race([
          popupPromise,
          this.sleep(Math.min(settleTimeoutMs, 2_000)).then(() => null),
        ]);
      } finally {
        context.off("page", onPopup);
        resolvePopup(null);
      }
      const transient = providerPage ?? product;
      const durableProduct = providerPage === null ? recovery : product;
      this.oauthProductPage = durableProduct;
      this.oauthProviderPage = transient;
      this.oauthProviderPageClosed = transient.isClosed();
      this.restoreProductPageWhenOAuthPageCloses(transient, durableProduct);
      const settled = await this.waitForOAuthLifecycle(
        transient,
        productUrl,
        settleTimeoutMs,
        providerPage === null,
        productDeparted,
      );
      if (settled === null) {
        throw new Error(
          `OAuth login is still awaiting the provider after ${Math.ceil(settleTimeoutMs / 1000)} seconds. Retry oauth_login; do not read or close the browser session.`,
        );
      }
      if (providerPage === null && product.isClosed()) {
        await recovery.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      }
    } finally {
      product.off("framenavigated", onProductNavigation);
      const retained = product.isClosed() ? recovery : product;
      this.page = retained?.isClosed() === false ? retained : this.primaryPage;
      this.oauthProductPage = null;
      this.oauthProviderPage = null;
      this.oauthProviderPageClosed = false;
      if (providerPage !== null && !providerPage.isClosed()) {
        await providerPage.close().catch(() => undefined);
      }
      if (recovery !== null && recovery !== this.page && !recovery.isClosed()) {
        await recovery.close().catch(() => undefined);
      }
      if (this.page !== null && !this.page.isClosed()) {
        await this.page.bringToFront().catch(() => undefined);
        await this.page
          .waitForLoadState("domcontentloaded", { timeout: 30_000 })
          .catch(() => undefined);
      }
    }
  }

  private restoreProductPageWhenOAuthPageCloses(oauthPage: Page, product: Page | null): void {
    oauthPage.once("close", () => {
      if (this.oauthProviderPage === oauthPage) this.oauthProviderPageClosed = true;
      if (product === null || product.isClosed()) {
        this.adoptLivePage();
        return;
      }
      if (this.page === oauthPage || this.page === null || this.page.isClosed()) {
        this.page = product;
        void product.bringToFront().catch(() => undefined);
      }
    });
  }

  private isOAuthProductUrl(candidateUrl: string, productUrl: string): boolean {
    try {
      const candidate = new URL(candidateUrl);
      const product = new URL(productUrl);
      return product.origin === "null"
        ? candidateUrl === productUrl
        : candidate.origin === product.origin;
    } catch {
      return candidateUrl === productUrl;
    }
  }

  private async waitForOAuthLifecycle(
    page: Page,
    productUrl: string,
    timeoutMs: number,
    startsOnProduct: boolean,
    departedBeforeWait: boolean,
  ): Promise<"closed" | "returned" | null> {
    let departed = departedBeforeWait;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) return "closed";
      const url = page.url();
      const isProduct = this.isOAuthProductUrl(url, productUrl);
      if (startsOnProduct && departed && isProduct) {
        const remaining = Math.max(1, deadline - Date.now());
        const idle = await page
          .waitForLoadState("networkidle", { timeout: remaining })
          .then(() => true)
          .catch(() => false);
        return idle && !page.isClosed() && this.isOAuthProductUrl(page.url(), productUrl)
          ? "returned"
          : null;
      }
      if (!isProduct && url !== "about:blank") departed = true;
      await this.sleep(50);
    }
    return page.isClosed() ? "closed" : null;
  }

  // ── OAuth/SSO debug instrumentation (UNIVERSAL_BOT_OAUTH_DEBUG) ──
  // Attach a context-level response recorder ONCE. Records SSO-relevant
  // responses (the service host + Clerk/Stytch/WorkOS FAPI hosts) with their
  // status + whether they set a cookie — the signal for "did the callback's
  // session-establish request succeed and set the session cookie?"
  private maybeAttachOAuthNetListener(): void {
    if (this.oauthNetListenerAttached) return;
    if (!/^(1|true|on)$/i.test(process.env.UNIVERSAL_BOT_OAUTH_DEBUG ?? "")) return;
    if (!this.context) return;
    this.oauthNetListenerAttached = true;
    const RELEVANT =
      /clerk|stytch|workos|accounts\.|\/sso|\/oauth|\/session|\/sign|callback|\/v1\/client/i;
    this.context.on("response", (res) => {
      void (async () => {
        try {
          const url = res.url();
          if (!RELEVANT.test(url)) return;
          const headers = res.headers();
          if (this.oauthNetLog.length >= 200) return;
          const entry: {
            url: string;
            status: number;
            setCookie: boolean;
            ct: string;
            body?: string;
          } = {
            url: url.slice(0, 200),
            status: res.status(),
            setCookie: "set-cookie" in headers || "Set-Cookie" in headers,
            ct: (headers["content-type"] ?? "").slice(0, 40),
          };
          // Capture the body of a Clerk/Stytch/WorkOS sign-in/up/callback error
          // (>=400) — its error code is the definitive tell (captcha_invalid vs
          // transfer vs identifier_*). JSON only, bounded.
          if (
            res.status() >= 400 &&
            /\/v1\/client\/(sign_ins|sign_ups)|oauth_callback|\/session/i.test(url)
          ) {
            entry.body = (await res.text().catch(() => "")).slice(0, 800);
          }
          this.oauthNetLog.push(entry);
        } catch {
          // best-effort observability — never perturb the run
        }
      })();
    });
  }

  // Dump cookies + the SSO network log to a file for post-mortem. Called at the
  // oauth_session_not_persisted decision point when UNIVERSAL_BOT_OAUTH_DEBUG.
  async dumpOAuthDebug(service: string, label: string): Promise<void> {
    if (!/^(1|true|on)$/i.test(process.env.UNIVERSAL_BOT_OAUTH_DEBUG ?? "")) return;
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      const cookieSummary = cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        len: c.value.length,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
      const url = this.page ? this.page.url() : "(no page)";
      // Capture the live Clerk SDK state — the definitive read on whether a
      // sign-up transfer is available (the new-user-OAuth fix hinges on this).
      const clerkState = this.page
        ? await this.page
            .evaluate(() => {
              const w = window as unknown as { Clerk?: Record<string, unknown> };
              const c = w.Clerk;
              if (c === undefined) return { present: false };
              const client = (c as { client?: Record<string, unknown> }).client;
              const si = client?.["signIn"] as Record<string, unknown> | undefined;
              const su = client?.["signUp"] as Record<string, unknown> | undefined;
              const ffv = si?.["firstFactorVerification"] as Record<string, unknown> | undefined;
              return {
                present: true,
                loaded: (c as { loaded?: unknown }).loaded ?? null,
                signInStatus: si?.["status"] ?? null,
                signInFFVStatus: ffv?.["status"] ?? null,
                signInFFVError: ffv?.["error"] ?? null,
                signUpStatus: su?.["status"] ?? null,
                signUpMissingFields: su?.["missingFields"] ?? null,
                hasSignUpCreate: typeof (su as { create?: unknown })?.create === "function",
              };
            })
            .catch((e: unknown) => ({ present: "evalError", err: String(e).slice(0, 120) }))
        : { present: false };
      const consoleText = await this.extractText().catch(() => "");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(homedir(), ".trusty-squire", "oauth-debug");
      mkdirSync(dir, { recursive: true });
      const ts = process.env.OAUTH_DEBUG_TS ?? String(this.oauthNetLog.length);
      const path = join(dir, `${service}-${label}-${ts}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          {
            service,
            label,
            finalUrl: url,
            clerkState,
            cookies: cookieSummary,
            netLog: this.oauthNetLog,
            pageText: consoleText.slice(0, 600),
          },
          null,
          2,
        ),
      );
      console.error(
        `[oauth-debug] wrote ${path} (${cookieSummary.length} cookies, ${this.oauthNetLog.length} net entries)`,
      );
    } catch (err) {
      console.error(
        `[oauth-debug] dump failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Read the page's Rails/OmniAuth CSRF token (<meta name="csrf-token">).
  // Needed to recover OmniAuth 2.0 POST-only OAuth when the provider button is
  // a GET <a> that page-JS upgrades to a POST.
  async getMetaCsrfToken(): Promise<string | null> {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => {
        const c = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
        return c !== null && c !== undefined && c.length > 0 ? c : null;
      });
    } catch {
      return null;
    }
  }

  // Read an attribute off the first element matching `selector` (e.g. the href
  // of an OAuth affordance). null when absent or the selector doesn't resolve.
  async getElementAttribute(selector: string, attr: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      return await this.page.locator(selector).first().getAttribute(attr);
    } catch {
      return null;
    }
  }

  // Submit a programmatic POST form to `action` with the given hidden fields,
  // from the CURRENT page — so the current-origin session cookies ride along.
  // Recovers OmniAuth 2.0 POST-only OAuth (the GET-click hit "Authentication
  // passthru"): POST /…/auth/<provider> + authenticity_token → 302 to provider.
  async submitPostForm(action: string, fields: Record<string, string>): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.evaluate(
      ({ action, fields }) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = action;
        form.style.display = "none";
        for (const [k, v] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = k;
          input.value = v;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      },
      { action, fields },
    );
    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      // best-effort — the consent loop re-reads state regardless
    }
  }

  // Does the page sign in with Google via Google Identity Services (GSI)
  // rather than classic OAuth redirect? GSI renders its button in a
  // cross-origin iframe (accounts.google.com/gsi/button) and/or exposes the
  // `google.accounts.id` JS API; on use it raises a browser-native FedCM
  // dialog or a popup and returns a JWT to a JS callback — there is NO
  // redirect, so the classic startOAuth flow can't drive it. Detecting this
  // is what lets the agent route to tryGoogleGsiLogin instead.
  async hasGoogleGsiAffordance(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        if (document.querySelector('iframe[src*="accounts.google.com/gsi/"]') !== null) {
          return true;
        }
        // On-demand One-Tap: the page loads the GSI client script but renders
        // no static button and may not have initialized `google.accounts.id`
        // yet (amplitude, clerk). A plain click on the in-page "Sign in with
        // Google" affordance never redirects, so the bot used to falsely
        // conclude "signed in" and bounce to login. Treat the loaded client
        // script as a GSI affordance so the agent routes through
        // tryGoogleGsiLogin, which now raises One-Tap programmatically.
        if (document.querySelector('script[src*="accounts.google.com/gsi/client"]') !== null) {
          return true;
        }
        const g = (
          window as unknown as {
            google?: { accounts?: { id?: unknown } };
          }
        ).google;
        return typeof g?.accounts?.id !== "undefined";
      });
    } catch {
      return false;
    }
  }

  // Drive a Google Identity Services / FedCM sign-in. Two variants are
  // handled:
  //   - FedCM: clicking the GSI widget raises a browser-NATIVE credential
  //     dialog (no DOM, no popup — invisible to Playwright). We enable the
  //     CDP FedCm domain up front and auto-select the first account when
  //     FedCm.dialogShown fires. The page's JS callback then receives the
  //     JWT and establishes the session.
  //   - Popup: older GSI opens a Google account-chooser window; we adopt it
  //     like startOAuth does so the consent loop can drive it.
  // Returns how it resolved. The caller then runs the SAME post-OAuth
  // settle/consent/post-verify path as the redirect flow.
  async tryGoogleGsiLogin(
    triggerSelector: string,
    timeoutMs = 25_000,
  ): Promise<{ ok: boolean; via: "fedcm" | "popup" | "none" }> {
    if (!this.page || !this.context) throw new Error("Browser not started");
    this.oauthProductPage = this.page;
    let fedcmResolved = false;
    let cdp: CDPSession | null = null;
    try {
      cdp = await this.context.newCDPSession(this.page);
      await cdp.send("FedCm.enable", { disableRejectionDelay: true });
      console.error("[operator] FedCm.enable ok — listening for dialogShown");
      cdp.on("FedCm.dialogShown", (ev: unknown) => {
        const e = ev as { dialogId?: string; dialogType?: string; accounts?: unknown[] };
        console.error(
          `[operator] FedCm.dialogShown type=${e.dialogType ?? "?"} accounts=${
            Array.isArray(e.accounts) ? e.accounts.length : "?"
          }`,
        );
        const dialogId = e.dialogId;
        if (dialogId === undefined) return;
        void (async () => {
          // A ConfirmIdpLogin dialog has no account list — it's the "Continue
          // as / sign in to Google" confirmation that precedes the account
          // chooser. selectAccount would error on it, so drive the confirm
          // button directly and skip selectAccount for this dialog type.
          if (e.dialogType === "ConfirmIdpLogin") {
            try {
              await cdp!.send("FedCm.clickDialogButton", {
                dialogId,
                dialogButton: "ConfirmIdpLoginContinue",
              });
            } catch {
              // method/param may not apply to this build/dialog — non-fatal;
              // a subsequent AccountChooser dialog still resolves via select.
            }
            return;
          }
          try {
            // Pick the first account on the account-chooser dialog.
            await cdp!.send("FedCm.selectAccount", { dialogId, accountIndex: 0 });
            fedcmResolved = true;
          } catch {
            // dialog dismissed or already resolved
          }
          if (!fedcmResolved) {
            // Some flows surface a "Continue as <name>" confirm even on the
            // account dialog; selectAccount alone usually completes it, but
            // when it didn't, try the confirm button as a fallback. Failure
            // is non-fatal — the popup/none path still applies.
            try {
              await cdp!.send("FedCm.clickDialogButton", {
                dialogId,
                dialogButton: "ConfirmIdpLoginContinue",
              });
              fedcmResolved = true;
            } catch {
              // button absent or not applicable — degrade to popup/none
            }
          }
        })();
      });
    } catch (err) {
      cdp = null; // FedCm domain unavailable — the popup path still works
      console.error(
        `[operator] FedCm.enable failed (${
          err instanceof Error ? err.message : String(err)
        }) — FedCM path disabled, relying on popup`,
      );
    }

    const popupPromise: Promise<Page | null> = this.context
      .waitForEvent("page", { timeout: timeoutMs })
      .then((p): Page | null => p)
      .catch((): Page | null => null);

    await this.click(triggerSelector);

    // On-demand One-Tap: when the page loaded the GSI client but rendered no
    // static button, the click above hits an in-page affordance that never
    // raises a dialog on its own. If neither a FedCM dialog nor a popup has
    // appeared shortly after the click, ask GSI to raise One-Tap itself.
    // `google.accounts.id.prompt()` triggers the FedCM dialog our handler is
    // already listening for. Guarded — `window.google.accounts.id` may be
    // undefined (no-op) and any failure must degrade to the popup/none path.
    if (cdp !== null) {
      const promptDeadline = Date.now() + Math.min(4_000, timeoutMs);
      while (Date.now() < promptDeadline && !fedcmResolved && this.context.pages().length <= 1) {
        await this.sleep(250);
      }
      if (!fedcmResolved && this.context.pages().length <= 1) {
        try {
          await this.page.evaluate(() => {
            const g = (
              window as unknown as {
                google?: { accounts?: { id?: { prompt?: () => void } } };
              }
            ).google;
            const id = g?.accounts?.id;
            if (id !== undefined && typeof id.prompt === "function") {
              id.prompt();
            }
          });
        } catch {
          // GSI not initialized / prompt unavailable — popup/none still apply
        }
      }
    }

    // Resolve when a popup opens OR FedCM completes OR we hit the deadline.
    const fedcmWait = (async (): Promise<null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !fedcmResolved) {
        await this.sleep(250);
      }
      return null;
    })();
    const popup: Page | null = await Promise.race([popupPromise, fedcmWait]);

    if (cdp !== null) {
      try {
        await cdp.send("FedCm.disable");
      } catch {
        // best-effort
      }
    }

    if (popup !== null && popup !== this.page && !popup.isClosed()) {
      this.page = popup;
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      } catch {
        // consent loop re-reads regardless
      }
      return { ok: true, via: "popup" };
    }
    if (fedcmResolved) {
      // Credential delivered to the page's JS callback — give the app a beat
      // to exchange it for a session and redirect.
      try {
        await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      } catch {
        // best-effort
      }
      return { ok: true, via: "fedcm" };
    }
    console.error(
      `[operator] GSI resolved via none — fedcmEnabled=${cdp !== null} ` +
        `fedcmResolved=${fedcmResolved} pages=${this.context.pages().length}`,
    );
    return { ok: false, via: "none" };
  }

  // URL of the active page (the OAuth page mid-handshake, the product
  // page otherwise). Cheap — no screenshot, unlike getState().
  currentUrl(): string {
    return this.page !== null ? this.page.url() : "";
  }

  recoverActivePage(): boolean {
    return this.adoptLivePage();
  }

  private adoptLivePage(): boolean {
    if (this.page !== null && !this.page.isClosed()) return true;
    if (this.context === null) return false;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (pages.length === 0) return false;
    const product =
      this.oauthProductPage !== null && !this.oauthProductPage.isClosed()
        ? this.oauthProductPage
        : null;
    const nonAuth = [...pages]
      .reverse()
      .find(
        (p) =>
          !/accounts\.google\.com|github\.com\/login|login\.microsoftonline\.com/i.test(p.url()),
      );
    this.page = nonAuth ?? product ?? pages[pages.length - 1] ?? null;
    return this.page !== null;
  }

  // Press a keyboard key (e.g. "Escape" to dismiss a focus-trapped modal that
  // exposes no in-DOM close control). Best-effort. Used by the nav-search
  // overlay handler's dismiss fallback.
  async pressKey(key: string): Promise<void> {
    if (!this.page) return;
    await this.page.keyboard.press(key).catch(() => {});
  }

  async focusedElementLabels(): Promise<string[]> {
    if (!this.page) return [];
    const labels: string[] = [];
    for (const frame of this.page.frames()) {
      const frameLabels = await frame
        .evaluate(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement) || element === document.body) return [];
          const associatedLabels =
            element instanceof HTMLInputElement ||
            element instanceof HTMLButtonElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
              ? Array.from(element.labels ?? [], (label) => label.innerText)
              : [];
          const values = [
            element.getAttribute("aria-label") ?? "",
            element instanceof HTMLInputElement ? element.value : "",
            element.innerText ?? "",
            ...associatedLabels,
          ];
          return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
        })
        .catch(() => []);
      labels.push(...frameLabels);
    }
    return [...new Set(labels)];
  }

  // Open obvious collapsed menus (hamburger / avatar / account / "Settings"
  // toggles) so nav links hidden behind them mount in the DOM before the
  // nav-search enumerates candidates (outside-voice #1: the keys link is often
  // behind a menu, not in the rendered top nav). CONSERVATIVE: only clicks
  // elements that ADVERTISE a popup menu (aria-haspopup=menu/true), capped at 3,
  // short timeouts, best-effort — never a plain link, so it can't wander.
  async expandLatentNav(): Promise<void> {
    if (!this.page) return;
    try {
      const n = await this.page
        .$$eval('[aria-haspopup="menu"], [aria-haspopup="true"]', (els) => {
          const slice = els.slice(0, 3);
          slice.forEach((e, i) => e.setAttribute("data-navsearch-toggle", String(i)));
          return slice.length;
        })
        .catch(() => 0);
      for (let i = 0; i < n; i++) {
        await this.page.click(`[data-navsearch-toggle="${i}"]`, { timeout: 1200 }).catch(() => {});
      }
    } catch {
      // best-effort — never fail the search over menu expansion
    }
  }

  // Fetch a URL's final response (following redirects) and return its
  // status, final URL, and body text — or null on any failure.
  //
  // WHY the CONTEXT request API (this.context.request) and not global
  // fetch / a fresh node http client: the context's APIRequestContext
  // shares the BrowserContext's proxy + cookie jar, so this egresses
  // through the SAME residential tunnel the real navigation uses. That
  // makes a probe here representative of what the browser would actually
  // land on (same IP reputation, same cf_clearance cookie) — and needs no
  // separate SOCKS/HTTP-proxy plumbing. Used by the signup-URL resolver to
  // distinguish a stale /signup that serves a login SPA from the real
  // signup form, BEFORE committing to a ~6-minute navigation.
  //
  // Bounded (15s, ≤10 redirects) and non-throwing — the resolver treats
  // null as "couldn't tell" and escalates.
  async fetchText(
    url: string,
  ): Promise<{ finalUrl: string; status: number; bodyText: string } | null> {
    if (this.context === null) return null;
    try {
      const response = await this.context.request.get(url, {
        maxRedirects: 10,
        timeout: 15_000,
        // We inspect 404/redirect bodies ourselves; don't let a non-2xx
        // throw before we can classify it.
        failOnStatusCode: false,
      });
      return {
        finalUrl: response.url(),
        status: response.status(),
        bodyText: await response.text(),
      };
    } catch {
      return null;
    }
  }

  // True when the active OAuth page is gone — for the popup flow, the
  // popup closing IS the signal the handshake finished.
  oauthPageClosed(): boolean {
    return this.page === null || this.page.isClosed();
  }

  // A legacy oauth_click may still have a provider popup in flight. Keep this
  // intentionally small and non-sensitive so the operator boundary can turn a
  // transient detached Playwright handle into guidance rather than exposing a
  // driver exception to the planning model.
  oauthTransitionStatus(): {
    productUrl: string | null;
    providerPageClosed: boolean;
    productPageViable: boolean;
    browserConnected: boolean;
  } | null {
    const product = this.oauthProductPage;
    if (product === null) return null;
    let productUrl: string | null = null;
    if (!product.isClosed()) {
      try {
        productUrl = product.url();
      } catch {
        // A page may detach between isClosed() and url(); the structured
        // in-progress response must still win over the raw driver error.
      }
    }
    return {
      productUrl,
      providerPageClosed:
        this.oauthProviderPageClosed || this.oauthProviderPage?.isClosed() === true,
      productPageViable: !product.isClosed(),
      browserConnected: this.isConnected(),
    };
  }

  completeOAuthTransitionRecovery(): void {
    const product = this.oauthProductPage;
    if (product !== null && !product.isClosed()) this.page = product;
    this.oauthProductPage = null;
    this.oauthProviderPage = null;
    this.oauthProviderPageClosed = false;
  }

  // Drive a Google sign-in on the ACTIVE OAuth page (already sitting at
  // accounts.google.com/.../identifier). The whole point: replay must not bail
  // `needs_login` where the full discover bot would just type the password —
  // a freshly-created robot account lands on the identifier page the first time
  // a given relying party requests OAuth even with a live session, and the
  // robot's credentials are available to the verifier. Drives the standard
  // Google in-page steps (email → Enter → password →
  // Enter → ToS/continue speedbumps) but operates on `this.page` instead of
  // navigating to myaccount — in the OAuth flow the success terminus is the
  // consent screen or the return to the relying party, NOT myaccount. Returns
  // true when the flow progressed off the Google identifier/password screens
  // (or the popup closed); false on any failure, so the caller can fall back to
  // its existing needs_login path. Never logs the password.
  async loginGoogleInline(email: string, password: string): Promise<boolean> {
    const page = this.page;
    if (page === null || page.isClosed()) return false;
    const onIdentifierOrPwd = (): boolean =>
      /\/signin\/(?:identifier|v\d+\/(?:identifier|challenge|signin)|challenge|pwd|password)/i.test(
        page.url(),
      );
    try {
      // Cookie-consent wall (EU surfaces) — best-effort.
      await page
        .evaluate(() => {
          const want = /^(accept all|i agree|agree|accept|reject all)$/i;
          for (const b of Array.from(document.querySelectorAll("button,[role=button]"))) {
            if (want.test((b.textContent ?? "").trim())) {
              (b as HTMLElement).click();
              return;
            }
          }
        })
        .catch(() => undefined);
      await page.waitForTimeout(1200);
      // Email — #identifierId, never input[type=email] alone (Google uses a
      // custom input). Only fill if the identifier field is actually present;
      // a flow already past identifier (parked on the password screen) skips it.
      const EMAIL = '#identifierId, input[name="identifier"], input[type="email"]';
      const emailField = await page.$(EMAIL);
      if (emailField !== null) {
        await page.fill(EMAIL, email).catch(() => undefined);
        await page.waitForTimeout(400);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(6000);
      }
      // Password.
      const PW = 'input[type="password"][name="Passwd"], input[type="password"]';
      await page.waitForSelector(PW, { state: "visible", timeout: 15_000 });
      await page.fill(PW, password).catch(() => undefined);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(7000);
      // New-account ToS speedbump + OAuth follow-ons — patient (renders late).
      for (let i = 0; i < 8; i++) {
        if (page.isClosed()) return true; // popup closed → handshake done
        const clicked = await page
          .evaluate(() => {
            const want =
              /^(not now|skip|confirm|i understand|i agree|accept|agree|got it|continue|allow|done|maybe later|next)$/i;
            for (const b of Array.from(
              document.querySelectorAll("button,[role=button],a,input[type=submit]"),
            )) {
              const t = (b.textContent ?? (b as HTMLInputElement).value ?? "").trim();
              if (want.test(t)) {
                (b as HTMLElement).click();
                return t;
              }
            }
            return null;
          })
          .catch(() => null);
        if (clicked !== null) {
          await page.waitForTimeout(3500);
        } else {
          if (!onIdentifierOrPwd()) break; // left the sign-in screens → progressed
          await page.waitForTimeout(2500);
        }
      }
      // Success = we are no longer parked on a Google identifier/password
      // screen (moved to consent / back to the relying party / popup closed).
      return page.isClosed() || !onIdentifierOrPwd();
    } catch {
      return false;
    }
  }

  // Which OAuth providers have a LIVE session in this profile's cookie jar.
  // The logged-in-providers.json marker is a memo that drifts out of sync
  // (a --force-relogin clears it, a misclassified run clears it, a parallel
  // run overwrites it) — so a session that is genuinely live in the cookies
  // can go invisible to provider selection, which is exactly how a warm
  // GitHub session got skipped in favour of a broken Google path. The cookie
  // jar is the ground truth: read it directly. Cookie NAMES + presence only;
  // values are never read into logs. Best-effort — a read failure returns [].
  async detectSessionProviders(): Promise<OAuthProviderId[]> {
    if (this.context === null) return [];
    try {
      return sessionProvidersFromCookies(await this.context.cookies());
    } catch {
      return [];
    }
  }

  async detectGoogleAccountEmail(): Promise<string | null> {
    if (this.context === null) return null;
    let identityPage: Page | null = null;
    try {
      identityPage = await this.context.newPage();
      await identityPage.goto("https://myaccount.google.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      if (new URL(identityPage.url()).hostname !== "myaccount.google.com") return null;
      const identityTokens = await identityPage
        .locator("[aria-label]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label") ?? ""),
        );
      for (const token of identityTokens) {
        const trimmed = token.trim();
        const email = /^Google Account:/i.test(trimmed) ? extractGoogleAccountEmail(trimmed) : null;
        if (email !== null) return email;
      }
      return null;
    } catch {
      return null;
    } finally {
      await identityPage?.close().catch(() => undefined);
    }
  }

  // Advance a provider's consent / account-chooser screen by one click
  // — the scope-gated auto-approve (T7/T13). Returns false when no
  // approve control is present — the agent then aborts rather than
  // hang. Clicks only; never types (the critical guarantee holds here).
  async advanceOAuthConsent(provider: OAuthProviderId): Promise<boolean> {
    if (!this.page) throw new Error("Browser not started");
    if (provider === "github") {
      // GitHub App install flow can include an account target chooser before
      // the Install/Authorize screen:
      //   /apps/<app>/installations/select_target
      // It renders account/org cards as links/buttons, not as an approve
      // button. Advance exactly one visible target and let the caller's
      // consent loop re-classify the next GitHub page.
      if (/\/apps\/[^/]+\/installations\/select_target\b/.test(new URL(this.page.url()).pathname)) {
        const startUrl = this.page.url();
        const clicked = await this.page
          .evaluate(() => {
            const visible = (el: HTMLElement): boolean => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return (
                r.width > 2 &&
                r.height > 2 &&
                s.display !== "none" &&
                s.visibility !== "hidden" &&
                parseFloat(s.opacity || "1") > 0.01
              );
            };
            const bad = /\b(settings|marketplace|learn more|cancel|skip|back|terms|privacy)\b/i;
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>(
                'a[href], button, [role="button"], [role="link"]',
              ),
            ).filter((el) => visible(el));
            const byHref = candidates.find((el) => {
              const href =
                el instanceof HTMLAnchorElement ? el.href : (el.getAttribute("href") ?? "");
              return /\/installations\/(?:new|permissions)\b/.test(href);
            });
            const target =
              byHref ??
              candidates.find((el) => {
                const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
                if (text.length === 0 || text.length > 80 || bad.test(text)) return false;
                return true;
              });
            if (target === undefined) return false;
            target.click();
            return true;
          })
          .catch(() => false);
        if (clicked) {
          const advanced = await this.page
            .waitForFunction((s) => window.location.href !== s, startUrl, { timeout: 8000 })
            .then(() => true)
            .catch(() => false);
          if (advanced) return true;
        }
      }
      // GitHub consent screen variants:
      //   Classic OAuth: "Authorize <app>"
      //   GitHub App (install + auth): "Authorize <app>", "Install",
      //                                "Install & authorize"
      //   Some flows show "Continue" or "Approve"
      // Negative match excludes Cancel/Deny.
      const startUrl = this.page.url();
      const patterns: RegExp[] = [
        /^authorize(\b|\s)/i,
        /^install\s*(&|and)\s*authorize\b/i,
        /^install\b/i,
        /^approve\b/i,
        /^continue\b/i,
        /^grant\b/i,
      ];
      for (const re of patterns) {
        const btn = this.page.getByRole("button", { name: re }).first();
        const count = await btn.count().catch(() => 0);
        if (count === 0) continue;
        // GitHub disables the Authorize button with a clickjacking-protection
        // COUNTDOWN (~3-8s) the first time you authorize an OAuth app that
        // requests org scopes (read:org). Clicking while disabled silently
        // no-ops and the URL never changes, so the whole consent bails
        // "no approve control" even though the button is right there
        // (MEASURED 2026-06-11: defang's "Authorize DefangLabs"). Poll up to
        // 12s for it to enable before clicking.
        {
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            const disabled = await btn
              .evaluate((el) => {
                if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
                  if (el.disabled) return true;
                }
                const aria = el.getAttribute("aria-disabled");
                return aria === "true" || aria === "";
              })
              .catch(() => false);
            if (!disabled) break;
            await this.sleep(400);
          }
        }
        try {
          await btn.click({ timeout: 8000 });
        } catch {
          continue;
        }
        // Verify the click actually advanced — GitHub's consent click
        // navigates within ~2s. If the URL is unchanged after 4s the
        // click silently failed (wrong element, or button disabled
        // behind a hidden iframe). Return false so the caller knows.
        const advanced = await this.page
          .waitForFunction((s) => window.location.href !== s, startUrl, { timeout: 4000 })
          .then(() => true)
          .catch(() => false);
        if (advanced) return true;
        // Click logged but URL didn't change — fall through to try the
        // next pattern (rare but covers misnamed candidates).
      }
      // Diagnostic: nothing matched OR every match failed to advance.
      // Log the visible button names so the failure trail tells us
      // what GitHub actually rendered.
      const seen = await this.page
        .evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('button, input[type="submit"], [role="button"]'),
          ) as HTMLElement[];
          return buttons
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.width > 1 && r.height > 1;
            })
            .slice(0, 8)
            .map((b) => {
              const t = (b.textContent || (b as HTMLInputElement).value || "").trim();
              return t.slice(0, 50);
            })
            .filter((t) => t.length > 0);
        })
        .catch(() => [] as string[]);
      console.error(
        `[operator] GitHub advanceOAuthConsent failed — visible buttons: ` +
          `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
      );
      return false;
    }
    // Google. Account chooser: Google renders each account with a
    // stable data-identifier attribute (the account email).
    const tile = this.page.locator("[data-identifier]").first();
    if ((await tile.count().catch(() => 0)) > 0) {
      try {
        await tile.click({ timeout: 8000 });
        return true;
      } catch {
        // fall through to the approve-button path
      }
    }
    // Consent screen: the approve control's name varies by Google's
    // consent layout — "Continue", "Allow", "Allow access" (the
    // /signin/oauth/consent?part=… variant meilisearch hits). Match on a
    // startsWith verb set (not exact) so "Allow access" resolves, while
    // the verbs exclude Cancel/Deny/Back/No. Wait for the button to
    // render — the consent SPA paints the approve control a beat after
    // domcontentloaded, and the old exact-match + no-wait returned false
    // before it appeared.
    const APPROVE_NAME = /^(?:continue|allow|accept|agree)\b/i;
    const approve = this.page.getByRole("button", { name: APPROVE_NAME }).first();
    try {
      await approve.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      // not visible within the window — fall through to the DOM-scan path
    }
    if ((await approve.count().catch(() => 0)) > 0) {
      try {
        await approve.click({ timeout: 8000 });
        return true;
      } catch {
        // fall through to the DOM-scan fallback
      }
    }
    // Fallback: scan the DOM for an approve-like clickable when the ARIA
    // role query missed it (Google occasionally renders the control as a
    // <div role>/<span> or an <input type=submit value="Allow access">).
    // Click the first visible candidate whose text is an approve verb and
    // is NOT a cancel/deny/back. Log what was visible on failure.
    const clicked = await this.page
      .evaluate(() => {
        const APPROVE = /^(?:continue|allow|accept|agree)\b/i;
        const DENY = /\b(?:cancel|deny|back|no\b|not now|reject)\b/i;
        const els = Array.from(
          document.querySelectorAll('button, input[type="submit"], [role="button"], a[href]'),
        ) as HTMLElement[];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const t = (el.textContent || (el as HTMLInputElement).value || "").trim();
          if (t.length === 0 || t.length > 40) continue;
          if (DENY.test(t)) continue;
          if (APPROVE.test(t)) {
            (el as HTMLElement).click();
            return t.slice(0, 40);
          }
        }
        return null;
      })
      .catch(() => null);
    if (clicked !== null) return true;
    const seen = await this.page
      .evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('button, input[type="submit"], [role="button"]'),
        ) as HTMLElement[];
        return els
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 1 && r.height > 1;
          })
          .slice(0, 8)
          .map((b) => (b.textContent || (b as HTMLInputElement).value || "").trim().slice(0, 40))
          .filter((t) => t.length > 0);
      })
      .catch(() => [] as string[]);
    console.error(
      `[operator] Google advanceOAuthConsent failed — visible buttons: ` +
        `${seen.length === 0 ? "<none>" : seen.map((s) => JSON.stringify(s)).join(", ")}`,
    );
    return false;
  }

  // Wait on a Clerk callback for a session to establish, polling COOKIES (which
  // are world-agnostic — unlike window.Clerk, invisible to our isolated-world
  // page.evaluate under patchright). Clerk's main-world JS, if left alone on the
  // /sso-callback page (not navigated away), completes the new-user sign-up
  // transfer and sets a session; this detects that. Returns true once a Clerk
  // session indicator appears (`__session` cookie, or `__client_uat` flips off
  // "0"), false on timeout. Cheap + safe: only the bot's own context cookies.
  async waitForClerkSession(timeoutMs = 12000): Promise<boolean> {
    if (!this.context) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const cookies = await this.context.cookies();
        const signedIn = cookies.some(
          (c) =>
            (c.name === "__session" && c.value.length > 0) ||
            (c.name.startsWith("__client_uat") && c.value.length > 0 && c.value !== "0"),
        );
        if (signedIn) return true;
      } catch {
        // transient — keep polling
      }
      await this.sleep(1000);
    }
    return false;
  }

  // Restore the product page once the OAuth handshake completes. A
  // no-op for the same-tab redirect flow (the active page already IS
  // the product page); for the popup flow, waits briefly for the popup
  // to close, then switches `this.page` back to the product tab.
  async settleAfterOAuth(): Promise<void> {
    const product = this.oauthProductPage;
    try {
      if (product === null || product === this.page) return;
      const provider = this.oauthProviderPage ?? this.page;
      for (let i = 0; i < 12 && provider !== null && !provider.isClosed(); i++) {
        await this.sleep(1000);
      }
      if (provider !== null && provider !== product && !provider.isClosed()) {
        await provider.close().catch(() => undefined);
      }
      if (!product.isClosed()) {
        this.page = product;
        await product.bringToFront().catch(() => undefined);
        await product
          .waitForLoadState("domcontentloaded", { timeout: 30000 })
          .catch(() => undefined);
      } else {
        this.adoptLivePage();
      }
    } finally {
      this.oauthProductPage = null;
      this.oauthProviderPage = null;
      this.oauthProviderPageClosed = false;
    }
  }

  // End one sequential task without tearing down Chrome. The original,
  // handler-bound page survives; OAuth popups and any other incidental tabs are
  // closed. about:blank replaces the task document while the persistent profile
  // (cookies, OAuth identity, local profile data) intentionally remains intact.
  async resetPageForReuse(): Promise<void> {
    if (!this.profilePoolReusable) throw new Error("browser profile is not pool-reusable");
    const context = this.context;
    const primaryPage = this.primaryPage;
    if (!this.isConnected() || context === null || primaryPage === null || primaryPage.isClosed()) {
      throw new Error("warm browser page is not reusable");
    }

    this.page = primaryPage;
    this.oauthProductPage = null;
    this.oauthProviderPage = null;
    this.oauthProviderPageClosed = false;
    this.oauthNetLog = [];
    this.mouseX = 100;
    this.mouseY = 100;

    for (const page of context.pages()) {
      if (page !== primaryPage && !page.isClosed()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            page.close(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("timed out closing warm browser popup")),
                5_000,
              );
              timer.unref();
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    }
    if (context.pages().some((page) => page !== primaryPage && !page.isClosed())) {
      throw new Error("warm browser reset left a non-primary page open");
    }
    await primaryPage.goto("about:blank", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  async close(options: { cancelStart?: boolean } = {}): Promise<ProfileCloseState> {
    if (options.cancelStart === true) {
      this.startCancellationRequested = true;
      this.resolveStartCancellation?.();
      this.resolveStartCancellation = null;
    }
    this.closePromise ??= this.closeAfterStart();
    return await this.closePromise;
  }

  private async closeCancelledStart(): Promise<ProfileCloseState> {
    if (this.persistentFallbackLaunchInFlight) {
      await this.startPromise?.catch(() => undefined);
    }
    if (this.persistentFallbackCancellationState !== null) {
      const closeState = this.persistentFallbackCancellationState;
      if (closeState === "closed") {
        const lease = this.profileOperationLease;
        this.profileOperationLease = null;
        lease?.release();
      }
      return closeState;
    }
    if (!this.startLaunchCommitted) {
      await this.closeWithProfileGuard();
      const lease = this.profileOperationLease;
      this.profileOperationLease = null;
      lease?.release();
      return "closed";
    }
    const [closeState] = await Promise.all([
      this.closeWithProfileGuard(),
      this.reapCancelledStartProcess(),
    ]);
    if (this.startSettled) {
      const lease = this.profileOperationLease;
      this.profileOperationLease = null;
      lease?.release();
    }
    return closeState;
  }

  private async reapCancelledStartProcess(): Promise<void> {
    this.cancelledStartReaper ??= this.monitorCancelledStartProcess();
    await this.cancelledStartReaper;
  }

  private async monitorCancelledStartProcess(): Promise<void> {
    while (!this.startSettled) {
      const identity = this.currentOwnedProfileIdentity();
      if (identity !== null) {
        signalProfileProcess(identity, this.profileDir, "SIGKILL");
        reapProfileHolderIfOwned(this.profileDir, identity);
      }
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 25);
      });
    }
  }

  private currentOwnedProfileIdentity(): ProfileProcessIdentity | null {
    const known = this.childChromeIdentity ?? this.launchedProfileHolderIdentity;
    if (known !== null) return known;
    const holderPid = currentProfileHolderPid(this.profileDir);
    return holderPid === null ? null : profileProcessIdentity(holderPid, this.profileDir);
  }

  private async waitForPersistentFallbackIdentity(): Promise<PersistentFallbackIdentityProof> {
    return await resolvePersistentFallbackIdentity({ profileDir: this.profileDir });
  }

  private async waitForOwnedProfileExit(identity: ProfileProcessIdentity): Promise<boolean> {
    const deadline = Date.now() + PROFILE_IDENTITY_PROOF_TIMEOUT_MS;
    let state = profileProcessIdentityState(identity, this.profileDir);
    while (state !== "stale" && Date.now() < deadline) {
      if (profileProcessMatches(identity, this.profileDir)) {
        signalProfileProcess(identity, this.profileDir, "SIGKILL");
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, PROFILE_IDENTITY_POLL_MS);
        timer.unref();
      });
      state = profileProcessIdentityState(identity, this.profileDir);
    }
    if (state !== "stale") return false;
    reapProfileHolderIfOwned(this.profileDir, identity);
    return true;
  }

  private async closeAfterStart(): Promise<ProfileCloseState> {
    if (this.startPromise !== null && !this.startSettled) {
      await Promise.race([this.startPromise.catch(() => undefined), this.startCancellation]);
    }
    if (this.startCancellationRequested) return await this.closeCancelledStart();
    try {
      return await this.closeWithProfileGuard();
    } finally {
      const lease = this.profileOperationLease;
      this.profileOperationLease = null;
      lease?.release();
    }
  }

  private async closeWithProfileGuard(): Promise<ProfileCloseState> {
    if (this.harnessAttachedPage) {
      this.page = null;
      this.primaryPage = null;
      this.oauthProductPage = null;
      this.oauthProviderPage = null;
      this.oauthProviderPageClosed = false;
      this.oauthNetLog = [];
      this.context = null;
      return "closed";
    }
    // Each step is best-effort and independent: a throw closing the page
    // or context must NOT skip the Xvfb teardown below, or the virtual
    // display leaks (orphaned Xvfb procs pile up over a long-lived MCP
    // server and, worse, the un-closed Chrome keeps the profile's
    // SingletonLock held — bricking the next signup + `mcp login`).
    //
    // EVERY close call is timeout-capped. On a wedged headed Chrome (e.g. a
    // run that crashed mid-captcha-click), BOTH page.close() AND
    // context.close() can hang INDEFINITELY — and an un-capped page.close()
    // blocked the reap below from ever running, so the browser leaked for
    // minutes and bricked the next 3 services (MEASURED 2026-06-09: supabase
    // crash → cockroachdb/weaviate/honeycomb all "profile held"). The cap
    // guarantees we always reach the SIGKILL reap.
    const page = this.page;
    const context = this.context;
    const cdpBrowser = this.cdpBrowser;
    const childIdentity = this.childChromeIdentity;
    const holderIdentity = this.launchedProfileHolderIdentity ?? this.currentOwnedProfileIdentity();
    const identity = childIdentity ?? holderIdentity;
    this.page = null;
    this.primaryPage = null;
    this.oauthProductPage = null;
    this.oauthProviderPage = null;
    this.oauthProviderPageClosed = false;
    this.oauthNetLog = [];
    this.context = null;
    this.cdpBrowser = null;
    this.childChrome = null;
    this.childChromeIdentity = null;
    this.launchedContext = false;
    this.launchedProfileHolderIdentity = null;
    const closeState = await closeProfileWithProof({
      profileDir: this.profileDir,
      identity,
      close: async () => {
        if (page !== null) await page.close();
        if (context !== null) await context.close();
        if (cdpBrowser !== null) await cdpBrowser.close();
        if (childIdentity !== null) {
          signalProfileProcess(childIdentity, this.profileDir, "SIGTERM");
        }
      },
      forceClose: () => {
        if (identity !== null) signalProfileProcess(identity, this.profileDir, "SIGKILL");
        reapProfileHolderIfOwned(this.profileDir, identity);
      },
    });
    // Self-launch path: disconnect the CDP browser and SIGKILL the Chrome we
    // spawned. context.close() on a connectOverCDP context only disconnects —
    // it does NOT necessarily exit the browser process, which would leak the
    // SingletonLock and brick the next run (the reap below is the backstop, but
    // killing our own child directly is cleaner and faster).
    if (childIdentity !== null) selfManagedChromes.delete(childIdentity.pid);
    // F13 — release the on-demand Xvfb if we spawned one. Order
    // matters: kill Chrome (context.close) first so it has its
    // display until it exits, THEN kill Xvfb.
    if (this.xvfb !== null) {
      try {
        this.xvfb.stop();
      } catch {
        /* best-effort */
      }
      this.xvfb = null;
    }
    return closeState;
  }
}

// Random integer in [min, max]. We use Math.random() (not crypto)
// because these values are used for timing only — predictability
// isn't a security concern. The shape of the distribution matters
// for behavior scoring, but uniform-in-range is close enough to the
// human distribution that scorers can't reliably distinguish.
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Score signup-form submit candidates by visible text; return the index
// of the best, or null when none scores positive. Signup pages commonly
// render OAuth buttons ("Continue with Google" / "GitHub") as
// button[type=submit] next to the real account-creation button, so a
// generic selector resolves to several — this picks the right one.
//
// Same shape and rationale as the verification-link picker: a positive
// score gate so an OAuth-only page (every candidate negative) returns
// null rather than mis-clicking "Continue with Google".
// Click disambiguation (regression: #61 weaviate). A bare id selector can
// resolve to >1 element — Descope's <descope-button> stamps the same
// generated id on the web component AND its inner text node — which trips
// Playwright strict mode before the click. When the selector isn't unique,
// narrow to the first match (Playwright's documented click disambiguation).
// Exported so the decision is unit-tested without a live page.
export function pickClickLocator<L extends { first(): L }>(locator: L, count: number): L {
  return count > 1 ? locator.first() : locator;
}

// Reference implementation of the shadow-piercing inventory walk that runs
// inside extractInteractiveElements' page.evaluate. Kept BYTE-FOR-BYTE in
// lockstep with that inline walk's guard + traversal. Exported only so the
// defensive guard (regression: #59 redis-cloud — a detached/closed root with
// no querySelectorAll crashed the whole inventory) is unit-testable in plain
// Node with fake roots. The production copy stays inline because a
// page.evaluate body can't call module code, and injecting source via
// new Function() would trip strict CSPs. If you change the inline walk's
// guard or traversal, change this too.
interface ShadowWalkRoot {
  querySelectorAll(selectors: string): ArrayLike<ShadowWalkEl>;
}
interface ShadowWalkEl {
  // `| undefined` mirrors the live DOM: `Element.shadowRoot` is typed
  // `ShadowRoot | null`, but a detached/closed custom element yields
  // `undefined` at runtime. The walk must survive that — see the guard.
  readonly shadowRoot: ShadowWalkRoot | null | undefined;
}
export function collectAcrossShadowRoots(
  root: ShadowWalkRoot | null | undefined,
  selector: string,
): ShadowWalkEl[] {
  const collected: ShadowWalkEl[] = [];
  const walk = (r: ShadowWalkRoot | null | undefined): void => {
    // `== null` (not `=== null`) covers both null and undefined — the
    // recursion below calls walk() on any non-null shadowRoot, so an
    // `undefined` one reaches here and `typeof undefined.querySelectorAll`
    // would throw before the typeof guard fired (#59 redis-cloud).
    if (r == null || typeof r.querySelectorAll !== "function") return;
    Array.from(r.querySelectorAll(selector)).forEach((n) => collected.push(n));
    Array.from(r.querySelectorAll("*")).forEach((el) => {
      if (el.shadowRoot !== null) walk(el.shadowRoot);
    });
  };
  walk(root);
  return collected;
}

// Tag eligibility for the "bare clickable card" pass in
// extractInteractiveElements. A selectable onboarding choice that carries no
// button/anchor/input/role semantics is collected only when it is a generic
// container (div/li/article/section/label) OR a CUSTOM ELEMENT — any element
// whose tag name contains a hyphen. 1inch's onboarding renders each activity
// choice as `<uikit-internal-chip data-test-id="activity-chip-aiAgents">`; the
// old div-only scan missed the custom tag, so the chip never entered the
// planner's inventory and neither click nor js_click could resolve it (both
// re-resolve against the inventory). Standard interactive/text tags are handled
// by the SELECTOR walk and must NOT be re-collected here.
// Kept in sync with the inline `isCardTag` inside extractInteractiveElements —
// a page.evaluate body can't call module code, so the production copy is inline;
// change both together.
export function isBareClickableCardTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return (
    t === "div" ||
    t === "li" ||
    t === "article" ||
    t === "section" ||
    t === "label" ||
    t.includes("-")
  );
}

// ───────────── phone-country widget selection ─────────────
//
// International checkouts may back their phone-country picker with an
// opacity:0 native <select> that the inventory walker omits. These helpers
// classify the requested country and match it against those native options.

// A phone-country request classified into the strongest available signal. The
// operator passes ONE string; we infer whether it's a dial code ("+81" / "81"),
// an ISO2 alpha-2 code ("JP"), or a country name ("Japan"). Kept mutually
// exclusive so the matcher never fuzzy-matches an exact-signal query on text.
export interface PhoneCountryQuery {
  // Digits only, no "+". Set when the input parsed as a dial code.
  dialCode?: string;
  // Upper-case alpha-2. Set when the input parsed as an ISO2 code.
  iso2?: string;
  // Lower-cased free text for substring matching. Set for a country name.
  name?: string;
}

// One native phone-country option normalized for matching.
export interface PhoneCountryOption {
  // `| undefined` (not just optional) because the page.evaluate reads produce
  // explicit undefined for absent fields, and the repo runs
  // exactOptionalPropertyTypes — a bare `text?: string` would reject it.
  text?: string | undefined;
  iso2?: string | undefined;
  dialCode?: string | undefined;
}

// Classify the operator's single country argument. WHY exact-signal buckets:
// "+1" is a dial code, "US" an ISO2, "United States" a name — matching each
// against the wrong DOM attribute (e.g. substring-matching "US" against option
// text) produces false hits, so we commit to one interpretation per input.
export function classifyPhoneCountryQuery(raw: string): PhoneCountryQuery {
  const t = raw.trim();
  if (t.length === 0) return {};
  // Dial code: an optional leading "+" then 1-4 digits and nothing else.
  if (/^\+?\d{1,4}$/.test(t)) return { dialCode: t.replace(/\D/g, "") };
  // ISO2: exactly two ASCII letters. Almost always an alpha-2 country code
  // ("JP", "US"); a two-letter country NAME doesn't exist, so this is safe.
  if (/^[A-Za-z]{2}$/.test(t)) return { iso2: t.toUpperCase() };
  // Otherwise a free-text country name for case-insensitive substring match.
  return { name: t.toLowerCase() };
}

// Decide whether a picker option satisfies the query. Exact-signal queries
// (iso2/dialCode) match ONLY against the corresponding structured field (with
// a dial-code fallback to a "+NN" embedded in native option text). A name query is a
// case-insensitive substring test against the option's visible text.
export function phoneCountryOptionMatches(
  query: PhoneCountryQuery,
  opt: PhoneCountryOption,
): boolean {
  const digits = (s: string): string => s.replace(/\D/g, "");
  if (query.iso2 !== undefined) {
    return opt.iso2 !== undefined && opt.iso2.toUpperCase() === query.iso2;
  }
  if (query.dialCode !== undefined) {
    if (opt.dialCode !== undefined && digits(opt.dialCode) === query.dialCode) return true;
    if (opt.text !== undefined) {
      const m = opt.text.match(/\+(\d{1,4})/);
      if (m !== null && m[1] === query.dialCode) return true;
    }
    return false;
  }
  if (query.name !== undefined) {
    return opt.text !== undefined && opt.text.toLowerCase().includes(query.name);
  }
  return false;
}

// Index of the first option matching the query, or -1. Extracted so the
// pick-a-row decision is unit-tested independently of the DOM read.
export function pickPhoneCountryOption(
  query: PhoneCountryQuery,
  options: readonly PhoneCountryOption[],
): number {
  return options.findIndex((o) => phoneCountryOptionMatches(query, o));
}

//
// Exported for unit testing — the scoring is the load-bearing logic.
export function pickSubmitButtonIndex(texts: readonly string[]): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;
  texts.forEach((raw, i) => {
    // Shared scorer (F3 Issue 8) — one keyword set for submit
    // disambiguation, the chooser pick, and inventory ranking.
    const score = scoreSignupButton(raw);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

// ───────────── required-agreement checkbox guard ─────────────

// Patterns shared by the pure helper below and the in-page evaluate in
// `checkRequiredAgreementBoxes`. The evaluate runs in the page realm and
// can't import, so the same two regexes are inlined there verbatim —
// keep them BYTE-IDENTICAL with these.
const AGREEMENT_TEXT_RE =
  /terms|tos\b|privacy|consent|policy|i agree|agree to|acknowledge|gdpr|age|18\+|18 years|certif/i;
const MARKETING_TEXT_RE =
  /newsletter|updates|offers|product tips|marketing|promotional|receive emails|opt[- ]?in to|subscribe/i;
const SAFE_SIGNUP_CHOICE_TEXT_RE =
  /digital products?|saas|software|developer tools?|apis?|mobile apps?|data|analytics/i;
const RISKY_SIGNUP_CHOICE_TEXT_RE =
  /gambling|financial services?|physical products?|marketplace|human services?|adult|weapons?|medical|restricted|crypto|payments?|banking/i;

// True when a checkbox's associated text reads as a REQUIRED agreement
// (terms/privacy/consent) and NOT as a marketing/newsletter opt-in.
//
// Why a deterministic check instead of trusting the LLM planner:
// amplitude's signup renders the required TOS checkbox next to a pair of
// data-storage-location card-radios; the planner mistook the whole
// cluster for "ambiguous radios" and skipped the box, and amplitude's
// submit isn't disabled when it's unticked — so the form silently
// no-ops. We must never flip a marketing opt-in on the user's behalf,
// hence the explicit marketing exclusion.
export function isAgreementCheckboxText(text: string): boolean {
  return AGREEMENT_TEXT_RE.test(text) && !MARKETING_TEXT_RE.test(text);
}

// True when a required signup-category choice is a low-risk default the bot can
// select deterministically. Keep byte-identical with the in-page regexes in
// `checkRequiredSignupChoiceBoxes`.
export function isSafeSignupChoiceText(text: string): boolean {
  return (
    SAFE_SIGNUP_CHOICE_TEXT_RE.test(text) &&
    !RISKY_SIGNUP_CHOICE_TEXT_RE.test(text) &&
    !AGREEMENT_TEXT_RE.test(text) &&
    !MARKETING_TEXT_RE.test(text)
  );
}

// ───────────── residential proxy (S1) ─────────────

// Playwright proxy settings, narrowed to the fields we set. Structurally
// assignable to Playwright's launch `proxy` option (which also has an
// optional `bypass`).
export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

// Parse a UNIVERSAL_BOT_PROXY_URL — e.g. "http://user:pass@host:8080" or
// "socks5://host:1080" — into Playwright's proxy option shape. Playwright
// wants credentials separate from `server`, so we split them out and
// percent-decode them (residential providers embed session IDs with
// reserved characters in the username, which arrive %-encoded).
//
// Throws on a URL the WHATWG parser rejects, or one with no host (a bare
// "host:port" parses as a scheme with an empty host) — the caller logs
// and falls back to a direct connection.
//
// Exported for unit testing — URL parsing is the error-prone bit.
// Cheap TCP liveness probe for a proxy `server` string ("socks5://host:port").
// A SOCKS5 proxy listens on TCP; if a connect succeeds within the timeout the
// proxy is up. Resolves false on connect error / timeout / a malformed server.
// Pure (no class state) so resolveProxy can call it before launching Chrome.
export async function isProxyReachable(server: string, timeoutMs = 4000): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server);
    host = u.hostname;
    port = Number(u.port) || (u.protocol.startsWith("socks") ? 1080 : 8080);
  } catch {
    return false;
  }
  if (host.length === 0 || !Number.isFinite(port)) return false;
  return await new Promise<boolean>((resolve) => {
    const sock = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

export function parseProxyUrl(raw: string): ProxySettings {
  const u = new URL(raw.trim());
  if (u.hostname.length === 0) {
    throw new Error(`proxy URL has no host: "${raw}" (expected e.g. http://host:port)`);
  }
  // `host` includes the port; `protocol` keeps its trailing ":".
  const settings: ProxySettings = { server: `${u.protocol}//${u.host}` };
  if (u.username.length > 0) settings.username = decodeURIComponent(u.username);
  if (u.password.length > 0) settings.password = decodeURIComponent(u.password);
  return settings;
}

// Should this run route through the configured proxy? True when the
// egress network is datacenter-class (the case the proxy exists for) or
// when the operator forced it on. Residential/unknown without the
// override stay direct — the ~80% who don't need it pay nothing.
//
// Exported for unit testing.
export function shouldRouteThroughProxy(asnClass: AsnClass, forceAlways: boolean): boolean {
  return forceAlways || asnClass === "datacenter";
}

// ───────────── egress geo match (T3.1) ─────────────

// Browser-context geo derived from the run's actual egress IP. Set on
// newContext() so the browser's declared timezone matches where its
// traffic exits — a US-timezone browser on a foreign proxy IP is
// itself a signal anti-bot scorers check for.
export interface EgressGeo {
  timezoneId: string;
  geolocation?: { latitude: number; longitude: number };
}

// Parse an ipinfo.io/json response body into EgressGeo. Returns null
// when the timezone is absent or not a plausible IANA zone — the
// caller then keeps a default rather than handing Playwright a bad
// timezoneId (which would throw inside newContext()).
//
// geolocation is optional: a valid `loc` ("lat,long") sets it; a
// missing or malformed one leaves a timezone-only result. Exported
// for unit testing — JSON-shape handling is the error-prone bit.
export function parseEgressGeo(text: string): EgressGeo | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const tz = typeof d.timezone === "string" ? d.timezone : null;
  // IANA zones look like "Asia/Seoul" or "America/Argentina/Buenos_Aires".
  // Reject anything else so a garbage value never reaches newContext().
  if (tz === null || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) return null;

  const geo: EgressGeo = { timezoneId: tz };
  if (typeof d.loc === "string") {
    const parts = d.loc.split(",");
    if (parts.length === 2) {
      const latitude = Number(parts[0]);
      const longitude = Number(parts[1]);
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180
      ) {
        geo.geolocation = { latitude, longitude };
      }
    }
  }
  return geo;
}

// ───────────── element inventory (F3) ─────────────

// One interactive element the planner can target. `selector` is
// computed by the bot from the live DOM, so it is known to resolve —
// the planner PICKS from these rather than inventing selector
// strings (the bug behind the 0/14 sweep). `index` is assigned after
// ranking, so it is a stable handle for the planner to reference.
export interface InteractiveElement {
  index: number;
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  labelText: string | null;
  visibleText: string | null;
  selector: string;
  visible: boolean;
  inViewport: boolean;
  inConsentWidget: boolean;
  sealed?: boolean;
  // T13 follow-up — OAuth-affordance signals. `href` is the link
  // target (an OAuth <a> points at e.g. /identity/login/google/);
  // `iconLabel` folds in a descendant <img alt> / <svg><title> /
  // [aria-label] so an icon-only "Sign in with Google" button — no
  // visible text at all — is still discoverable. Optional: only the
  // live extractInteractiveElements sets them; test fixtures omit them.
  href?: string | null;
  iconLabel?: string | null;
  // rc.19 — the element's own `title` attribute. Tooltip-style labels
  // used by icon-only buttons like Railway's modal "Copy Code" copy
  // button, which has no visible text and no aria-label. Without this
  // signal, findCopyButton in the synthesizer falls back to
  // extract_via_regex on bare UUIDs (which the regex library cannot
  // match without a label). Optional; test fixtures may omit.
  title?: string | null;
  // The element's data-testid / data-test / data-cy / data-qa — the most stable
  // selector anchor a site offers (authored to survive refactors + copy
  // changes). pickStableDomHint prefers it; replay's matchesDomHint resolves it
  // ahead of text_match. Optional; test fixtures may omit.
  testId?: string | null;
  // HTML autocomplete attribute (e.g. "given-name", "shipping postal-code").
  // Locale-stable role signal for money-path fill guards. Optional; fixtures
  // may omit (absence ⇒ no confident field fill when role is required).
  autocomplete?: string | null;
  // Site-authored stable role: data-field-role or data-role. Fallback when
  // autocomplete is absent.
  dataRole?: string | null;
  // F15 — nearest HTML5 landmark ancestor: header | main | footer |
  // nav | aside | article | section, or null when the element is
  // outside any landmark. The agent's inventory renderer uses this to
  // disambiguate elements with identical visibleText (a Railway run
  // had "Email" appear twice — body CTA and footer link — with
  // similar selectors that confused the planner). Optional: only the
  // live extractor sets it; fixtures may omit.
  landmark?: string | null;
  // Current value of a text-shaped input/textarea OR a <select>.
  // Surfaces "is this field actually empty / unselected?" to the
  // planner. For an input/textarea: empty string means the field
  // exists and is empty. For a <select>: empty string means the
  // first option's value is "" — typically the "Select…" placeholder
  // option, which is the React-form-state-untouched pattern that
  // broke Railway's token-creation form (clicking Create silently
  // bailed because React Hook Form treated workspaceId as untouched).
  // null means "not applicable (button/link) or not captured (test
  // fixture)".
  value?: string | null;
  // 0.8.3-rc.1 — runtime `checked` state for checkbox/radio inputs.
  // Null for everything else. Use this (not `value`) to identify
  // unticked checkboxes — checkbox `value` is the static attribute.
  checked?: boolean | null;
  // <select>-only: the visible text of the currently-selected option
  // and a short list of available option labels (capped to 8 — long
  // pickers like countries blow the inventory rendering). Lets the
  // planner emit a `{"kind":"select", option_text: …}` step targeting
  // an option by name. Both null for non-select elements.
  selectOptions?: Array<{ value: string; text: string }> | null;
  selectedOptionText?: string | null;
  // True when the bot has issued a selectOption / type / etc. against
  // this element earlier in this run, leaving a `data-ts-touched`
  // attribute. Inventory rendering uses this to suppress the
  // DEFAULTED-dropdown warning on selects we've already committed —
  // a Railway "No workspace" (value="") select otherwise re-trips
  // the warning every round and the planner gets stuck in a select
  // loop. Default false (or absent).
  interactedThisRun?: boolean;
  // Compact visual/structural context for non-vision host agents.
  // screenPath is a stable-ish human target path like
  // "dialog:finish-account > button:create-account"; container names the
  // closest dialog/nav/main/form/etc.; topmost/occludedBy report whether the
  // element is actually reachable at its center point.
  screenPath?: string | null;
  container?: string | null;
  topmost?: boolean | null;
  occludedBy?: string | null;
  // T38 — card-radio cluster membership. Set on elements that are
  // part of a "choose one of these N visually-similar siblings" group:
  // onboarding wizards like Cloudinary's "What are you using
  // Cloudinary for?" and Koyeb's use-case picker render their radio
  // choices as styled cards/labels with no semantic radio role. The
  // detector groups ≥2 sibling clickables that share parentElement
  // and have bounding boxes within ±20%. The planner reads this to
  // know exactly one card needs to be picked and "Continue" is the
  // expected next step. Null/absent when not part of a group.
  cardRadioGroup?: { id: number; position: number; total: number } | null;
  // Frame support — the ORIGIN (scheme://host[:port]) and full URL of the
  // <iframe> this element was extracted from, when it lives inside a child
  // frame (same- or cross-origin). null/undefined for an ordinary main-frame
  // element — every pre-existing element keeps this shape unchanged. This is
  // the load-bearing security signal for frame targets: a guard checks THIS
  // origin, never the top page's, so a rogue or third-party iframe embedded
  // on an otherwise in-scope page can't be acted on (or typed into) just
  // because the outer page passed its own domain check. See
  // frameTargetAllowed / assertSecretFrameTargetAllowed in
  // provision-session.ts.
  frameOrigin?: string | null;
  frameUrl?: string | null;
  framePath?: string | null;
  frameOpaque?: boolean;
}

// T38 — pure clustering logic. Identifies card-radio groups from a
// flat list of inventory candidates: each candidate carries its
// parent's identity (an integer assigned in DOM-walk order) plus
// the rendered bounding-box dimensions. Returns one slot per
// candidate, populated only for members of a qualifying group.
//
// A group qualifies when:
//   - 2..8 clickable siblings share the same parent (a list of N
//     things in a <ul> would usually exceed 8, and ≥9 sibling
//     similar-sized clickables aren't a card-radio in practice);
//   - their widths and heights agree within ±20% (real card grids
//     line up to a CSS grid template, so this is loose enough for
//     pixel rounding but tight enough to reject a button+text-link
//     row).
//
// Exported so the unit tests can exercise the logic in Node — the
// DOM-side caller in extractInteractiveElements feeds the same
// shape from inside page.evaluate.
export function assignCardRadioGroups(
  candidates: ReadonlyArray<{
    parentId: number;
    width: number;
    height: number;
    clickable: boolean;
  }>,
): Array<{ id: number; position: number; total: number } | null> {
  const result: Array<{ id: number; position: number; total: number } | null> = new Array(
    candidates.length,
  ).fill(null);
  // Bucket by parent.
  const byParent = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === undefined || c.parentId < 0) continue;
    const arr = byParent.get(c.parentId) ?? [];
    arr.push(i);
    byParent.set(c.parentId, arr);
  }
  let nextGroupId = 1;
  // Iterate in insertion order — keeps group ids stable across runs
  // for tests that exercise multiple clusters.
  for (const indices of byParent.values()) {
    if (indices.length < 2 || indices.length > 8) continue;
    const clickableIdx = indices.filter((i) => candidates[i]?.clickable === true);
    if (clickableIdx.length < 2) continue;
    const widths = clickableIdx.map((i) => candidates[i]!.width);
    const heights = clickableIdx.map((i) => candidates[i]!.height);
    const minW = Math.min(...widths);
    const minH = Math.min(...heights);
    if (minW < 1 || minH < 1) continue; // degenerate — reject
    const wRatio = Math.max(...widths) / minW;
    const hRatio = Math.max(...heights) / minH;
    if (wRatio > 1.2 || hRatio > 1.2) continue;
    const groupId = nextGroupId++;
    const total = clickableIdx.length;
    clickableIdx.forEach((idx, pos) => {
      result[idx] = { id: groupId, position: pos + 1, total };
    });
  }
  return result;
}

// Score a button/link by how much its text reads like a signup
// action. Shared by submit-button disambiguation, the two-stage
// chooser pick, and inventory button-ranking — one keyword set, no
// drift (F3 Issue 8). OAuth provider names go firmly negative so the
// bot never wanders into a Google/GitHub login dead end.
//
// `oauthProviders` (T6/T13 + auto-prefer) inverts that for OAuth-
// candidate providers: the "Sign in with <provider>" affordance is a
// PRIMARY target, not a dead end — so it must score positive enough to
// survive inventory ranking/capping. Stated as a rule, not arithmetic:
// a candidate provider's button outranks any form field. Only the
// candidate providers flip positive; every other OAuth/SSO button
// stays negative.
export function scoreSignupButton(
  text: string,
  oauthProviders?: readonly OAuthProviderId[],
): number {
  const t = text.toLowerCase();
  let score = 0;
  if (t.includes("create account") || t.includes("create your account")) score += 12;
  if (t.includes("sign up") || t.includes("signup")) score += 10;
  if (t.includes("register")) score += 8;
  if (t.includes("get started")) score += 6;
  // rc.30 — "email" is a strong signal that this button is the
  // signup path even when the page lacks a "Sign up" button (Railway,
  // Vercel, lots of services combine signup + login on one page and
  // label the email path "Log in using email" / "Sign in with email").
  // Bump weight from +5 to +12 so the combined-flow button outranks
  // generic nav anchors that score 0. The compensating auth-verb
  // penalty below is also suppressed when email is present.
  const hasEmail =
    t.includes("continue with email") || t.includes("sign up with email") || t.includes("email");
  if (hasEmail) {
    score += 12;
  }
  // Weak positive: "Continue" is often the real submit on single-field
  // forms; it should beat nothing but lose to OAuth markers.
  if (t.includes("continue")) score += 2;
  // "Next" / "Submit" / "Join" are the real form-submit verb on a multi-step
  // signup (huggingface /join step 1's button is "Next"). Weak positive so the
  // submit survives the button cap among many 0-scored nav anchors — otherwise
  // the planner can't see it and hallucinates a submit_selector. Loses to any
  // real signup CTA / OAuth marker. MEASURED 2026-06-23 (huggingface).
  if (/\bnext\b/.test(t) || /\bsubmit\b/.test(t) || /\bjoin\b/.test(t)) score += 2;
  // Post-signup dashboards reveal the key behind a "Create API Key" /
  // "Add key" / "Generate key" / "Get API Key" CTA — the run's actual
  // goal once the account exists. These score 0 on signup vocabulary, so
  // on a busy dashboard (dozens of nav/account buttons) rankAndCapInventory
  // caps them out: the OpenRouter "Get API Key" + fal.ai "Add key"
  // suppression. Score them as a primary target so they survive ranking.
  if (
    /\b(?:add|create|generate|new|get|reveal|copy)\b[\s\w]{0,20}\b(?:api[\s-]?key|key|token|secret|credential)s?\b/.test(
      t,
    )
  ) {
    score += 14;
  }
  if (
    oauthProviders !== undefined &&
    oauthProviders.some((p) => new RegExp(`\\b${p}\\b`).test(t))
  ) {
    // OAuth-first: a candidate provider's button is the goal. Score it
    // above every form-field-class button so ranking never caps it out.
    score += 50;
  } else if (/\b(google|github|gitlab|microsoft|apple|facebook|okta|sso|saml)\b/.test(t)) {
    // OAuth / SSO buttons are submit-typed too — the provider name is
    // the reliable discriminator, so drive those firmly negative.
    score -= 20;
  }
  // rc.30 — auth-verb penalty applies only when the button is purely
  // sign-in (no email). "Log in using email" / "Sign in with email"
  // are combined paths where the same button serves signup AND login
  // for first-time visitors. Penalizing them drops the actual signup
  // route from the inventory (the Railway regression diagnosed via
  // screenshots after rc.29).
  const hasAuthVerb = t.includes("sign in") || t.includes("log in") || t.includes("login");
  if (hasAuthVerb && !hasEmail) score -= 12;
  return score;
}

// Rank + cap the raw inventory before it goes to the planner. Every
// input/textarea/select is kept — they are the load-bearing form
// fields and a page has few. Only buttons/links/role elements are
// ranked (by signup-relevance) and capped, since a marketing page
// carries dozens of nav/footer buttons (F3 Issue 3 + Tension 2: a
// flat cap could truncate the real email field). Re-indexes the kept
// set and reports how many buttons were dropped.
export function rankAndCapInventory(
  elements: readonly InteractiveElement[],
  buttonCap = 25,
  oauthProviders?: readonly OAuthProviderId[],
): { inventory: InteractiveElement[]; buttonsDropped: number } {
  const isButtonish = (e: InteractiveElement): boolean =>
    e.tag === "button" ||
    e.tag === "a" ||
    e.type === "submit" ||
    e.type === "button" ||
    e.type === "reset";
  const fields = elements.filter((e) => !isButtonish(e));
  const ranked = elements
    .filter(isButtonish)
    .map((e) => ({
      e,
      score: scoreSignupButton(
        `${e.visibleText ?? ""} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`,
        oauthProviders,
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const keptButtons = ranked.slice(0, buttonCap).map((x) => x.e);
  const inventory = [...fields, ...keptButtons].map((e, i) => ({
    ...e,
    index: i,
  }));
  return {
    inventory,
    buttonsDropped: Math.max(0, ranked.length - keptButtons.length),
  };
}
