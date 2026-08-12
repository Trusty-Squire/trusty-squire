// Functional tests for the operator-surface session state machine — the
// stateful flows the pure-helper unit tests can't reach. The real
// BrowserController + google-login are mocked so we exercise startProvisionSession
// → act(allow_host/type_secret) → observedHostsForSession → finish against the
// live `sessions` registry, asserting the SECURITY-relevant behavior:
//   - allow_host actually unblocks a previously-blocked goto
//   - a sealed slot value is typed into the page but NEVER appears in the audit
//   - the precondition gate fails closed without starting the browser
//   - credential egress seed excludes mid_session task scope
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { constants, publicEncrypt } from "node:crypto";
import type * as GoogleLoginModule from "../google-login.js";

const h = vi.hoisted(() => ({
  providers: ["google"] as string[],
  oauthStatus: "already_valid" as string,
  typed: [] as Array<{ selector: string; text: string }>,
  uploads: [] as Array<{ selector: string; filePath: string }>,
  selected: [] as Array<{ selector: string; matcher: string | undefined }>,
  phoneCountries: [] as string[],
  phoneCountry: null as string | null,
  clearElementsOnClick: false,
  clickValueMutation: null as { selector: string; value: string } | null,
  clickPhoneCountryMutation: null as string | null,
  autocompleteSuggestions: [] as string[],
  autocompleteCommitMutation: null as { selector: string; value: string } | null,
  autocompleteCommitCalls: [] as number[],
  autocompleteConfirmOverride: null as boolean | null,
  autocompleteConfirmCalls: [] as Array<{ selector: string; pickedText: string }>,
  autocompleteDiscardCalls: 0,
  autocompleteDiscardEscapeCalls: [] as boolean[],
  clickCalls: 0,
  frameClicks: [] as string[],
  frameJsClicks: [] as string[],
  frameTypes: [] as Array<{ frameUrl: string; selector: string; text: string }>,
  frameSelects: [] as Array<{ frameUrl: string; selector: string; matcher: string | undefined }>,
  gotos: [] as string[],
  started: 0,
  startCalls: 0,
  closeCalls: 0,
  resetCalls: 0,
  resetFailuresRemaining: 0,
  profileProbeCalls: 0,
  controllerProviderProbeCalls: 0,
  connections: [] as boolean[],
  currentUrl: "",
  elements: [] as unknown[],
  checkoutFieldNames: [] as string[],
  visibleText: "",
  // fill_card cart-total-carry-forward (Session.lastCartCheckout): null means
  // "no total on this page" (readCheckoutSummary rejects, the common case).
  checkoutSummary: null as {
    merchant: string;
    checkout_origin: string;
    amount_cents: number;
    currency: string;
  } | null,
  cartLineItems: [] as Array<{
    title: string;
    quantity: number;
    details?: string;
    product_identities: string[];
    option_signatures: string[];
  }>,
  cartLineItemsAfterClick: null as Array<{
    title: string;
    quantity: number;
    details?: string;
    product_identities: string[];
    option_signatures: string[];
  }> | null,
  cartLineReadFailuresRemaining: 0,
  failNextCartLineReadAfterClick: false,
  readCheckoutSummaryCalls: 0,
  focusedLabels: [] as string[],
  pressedKeys: [] as string[],
  scrolls: [] as string[],
  captchaVariant: "unknown" as string,
  captchaChallengeRendered: false,
  captchaToken: false,
  captchaSettled: true,
  captchaSolved: true,
  invisibleTriggered: true,
  visibleSolveCalls: 0,
  invisibleTriggerCalls: 0,
  twoCaptchaAvailable: false,
  twoCaptchaResult: { kind: "ok", token: "captcha-token", durationMs: 1 } as
    | { kind: "ok"; token: string; durationMs: number }
    | { kind: "no_key" }
    | { kind: "submission_failed"; reason: string }
    | { kind: "solve_timeout"; durationMs: number }
    | { kind: "solver_error"; reason: string },
  twoCaptchaCalls: [] as string[],
  consentDismissCalls: 0,
  consentCta: null as string | null,
  locatorResolve: {
    ok: true,
    text: "Control",
    safetySignals: { billingObject: false, accountSetup: false },
  } as
    | {
        ok: true;
        text: string;
        labels?: string[];
        safetySignals: { billingObject: boolean; accountSetup: boolean };
        frameTarget?: {
          framePath: string;
          frameOrigin: string;
          frameUrl: string;
          frameOpaque?: boolean;
        } | null;
      }
    | { ok: false; reason: "none" | "ambiguous"; candidates: string[] },
  locatorClickCalls: 0,
  locatorTypeCalls: [] as Array<{ text: string; sealed: boolean }>,
  locatorResolveIntents: [] as string[],
  locatorDisposeCalls: 0,
}));

vi.mock("../browser.js", () => ({
  BrowserController: class {
    private readonly index: number;
    private readonly opts: { profileDir?: string; proxyUrl?: string };
    constructor(opts: { profileDir?: string; proxyUrl?: string } = {}) {
      this.index = h.connections.length;
      this.opts = opts;
      h.connections.push(true);
    }
    async start(): Promise<void> {
      h.started += 1;
      h.startCalls += 1;
    }
    matchesLaunchOptions(opts: { profileDir?: string; proxyUrl?: string }): boolean {
      const proxy = (value: string | undefined): string | null => value?.trim() || null;
      return (
        this.opts.profileDir === opts.profileDir &&
        proxy(this.opts.proxyUrl) === proxy(opts.proxyUrl)
      );
    }
    isConnected(): boolean {
      return h.connections[this.index] === true;
    }
    async resetPageForReuse(): Promise<void> {
      h.resetCalls += 1;
      if (h.resetFailuresRemaining > 0) {
        h.resetFailuresRemaining -= 1;
        throw new Error("page reset failed");
      }
      h.currentUrl = "about:blank";
    }
    async detectSessionProviders(): Promise<string[]> {
      h.controllerProviderProbeCalls += 1;
      return h.providers;
    }
    async goto(url: string): Promise<void> {
      h.gotos.push(url);
      h.currentUrl = url;
    }
    currentUrl(): string {
      return h.currentUrl;
    }
    recoverActivePage(): void {}
    async extractInteractiveElements(): Promise<unknown[]> {
      return h.elements;
    }
    async extractCheckoutFieldNames(): Promise<string[]> {
      return h.checkoutFieldNames;
    }
    async extractVisibleText(): Promise<string> {
      return h.visibleText;
    }
    async readCheckoutSummary(): Promise<{
      merchant: string;
      checkout_origin: string;
      amount_cents: number;
      currency: string;
    }> {
      h.readCheckoutSummaryCalls += 1;
      if (h.checkoutSummary === null) throw new Error("payment_checkout_total_not_found");
      return h.checkoutSummary;
    }
    async readCheckoutReviewLineItems(): Promise<Array<{
      title: string;
      quantity: number;
      details?: string;
      product_identities: string[];
      option_signatures: string[];
    }>> {
      if (h.cartLineReadFailuresRemaining > 0) {
        h.cartLineReadFailuresRemaining -= 1;
        throw new Error("cart line observation failed");
      }
      return h.cartLineItems.map((line) => ({ ...line, details: line.details ?? line.title }));
    }
    async openFirstMailResult(): Promise<boolean> {
      return false;
    }
    async waitForInteractiveDom(): Promise<void> {}
    async waitForCaptchaChallengeToSettle(): Promise<boolean> {
      return h.captchaSettled;
    }
    async dismissConsentBanner(): Promise<string | null> {
      h.consentDismissCalls += 1;
      return h.consentCta;
    }
    async waitForCaptchaResponseToken(): Promise<boolean> {
      return h.captchaToken;
    }
    async hasCaptchaResponseToken(): Promise<boolean> {
      return h.captchaToken;
    }
    async detectCaptchaVariant(): Promise<{ variant: string; challengeRendered: boolean }> {
      return { variant: h.captchaVariant, challengeRendered: h.captchaChallengeRendered };
    }
    async solveVisibleCaptcha(): Promise<{ found: boolean; solved?: boolean; kind?: string }> {
      h.visibleSolveCalls += 1;
      if (h.captchaVariant === "unknown") return { found: false };
      if (h.captchaSolved) h.captchaToken = true;
      return { found: true, solved: h.captchaSolved, kind: "recaptcha" };
    }
    async triggerInvisibleRecaptcha(): Promise<boolean> {
      h.invisibleTriggerCalls += 1;
      if (h.invisibleTriggered) h.captchaToken = true;
      return h.invisibleTriggered;
    }
    async extractRecaptchaSitekey(): Promise<string | null> {
      return "6Lcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    }
    async injectRecaptchaToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async extractHcaptchaSitekey(): Promise<string | null> {
      return "00000000-0000-0000-0000-000000000000";
    }
    async getHcaptchaSolveContext(): Promise<{
      invisible: boolean;
      userAgent: string | null;
      rqdata: string | null;
    }> {
      return { invisible: false, userAgent: "test-agent", rqdata: null };
    }
    async injectHcaptchaToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async extractTurnstileSitekey(): Promise<string | null> {
      return "0x4AAAAAAA";
    }
    async injectTurnstileToken(): Promise<boolean> {
      h.captchaToken = true;
      return true;
    }
    async scrollViewport(direction: string): Promise<void> {
      h.scrolls.push(direction);
    }
    async type(selector: string, text: string): Promise<void> {
      h.typed.push({ selector, text });
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector === selector) element.value = text;
      }
    }
    async markPreexistingTypeSuggestionPopups(): Promise<void> {}
    async detectTypeSuggestionPopup(_selector: string): Promise<string[]> {
      return h.autocompleteSuggestions;
    }
    async commitTypeSuggestion(index: number): Promise<void> {
      h.autocompleteCommitCalls.push(index);
      if (h.autocompleteCommitMutation !== null) {
        for (const element of h.elements as Array<Record<string, unknown>>) {
          if (element.selector === h.autocompleteCommitMutation.selector) {
            element.value = h.autocompleteCommitMutation.value;
          }
        }
      }
    }
    async discardTypeSuggestionPopup(dismissWithEscape: boolean): Promise<void> {
      h.autocompleteDiscardCalls += 1;
      h.autocompleteDiscardEscapeCalls.push(dismissWithEscape);
    }
    async confirmAutocompleteCommitted(selector: string, pickedText: string): Promise<boolean> {
      h.autocompleteConfirmCalls.push({ selector, pickedText });
      if (h.autocompleteConfirmOverride !== null) return h.autocompleteConfirmOverride;
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const el = (h.elements as Array<Record<string, unknown>>).find(
        (e) => e.selector === selector,
      );
      return normalize(String(el?.value ?? "")) === normalize(pickedText);
    }
    async selectOption(selector: string, matcher?: string): Promise<string> {
      h.selected.push({ selector, matcher });
      let committed = matcher ?? "";
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector !== selector) continue;
        const options = element.selectOptions as Array<{ value: string; text: string }> | undefined;
        const selected = options?.find((option) =>
          option.text.toLowerCase().includes((matcher ?? "").toLowerCase()),
        );
        committed = selected?.text ?? matcher ?? "";
        if (element.tag === "select") {
          element.value = selected?.value ?? matcher ?? "";
          element.selectedOptionText = committed;
        }
      }
      return committed;
    }
    async setPhoneCountry(country: string): Promise<void> {
      h.phoneCountries.push(country);
      h.phoneCountry = country;
    }
    async verifyPhoneCountry(country: string): Promise<boolean> {
      return h.phoneCountry === country;
    }
    async hasPhoneCountryControl(): Promise<boolean> {
      return h.phoneCountry !== null;
    }
    async click(): Promise<void> {
      h.clickCalls += 1;
      if (h.clickValueMutation !== null) {
        for (const element of h.elements as Array<Record<string, unknown>>) {
          if (element.selector === h.clickValueMutation.selector) {
            element.value = h.clickValueMutation.value;
          }
        }
      }
      if (h.clickPhoneCountryMutation !== null) {
        h.phoneCountry = h.clickPhoneCountryMutation;
      }
      if (h.clearElementsOnClick) h.elements = [];
    }
    async clickViaJs(): Promise<void> {}
    async clickInFrame(target: { frameUrl: string }, selector: string): Promise<void> {
      h.frameClicks.push(`${target.frameUrl}|${selector}`);
    }
    async clickViaJsInFrame(target: { frameUrl: string }, selector: string): Promise<void> {
      h.frameJsClicks.push(`${target.frameUrl}|${selector}`);
    }
    async typeInFrame(target: { frameUrl: string }, selector: string, text: string): Promise<void> {
      h.frameTypes.push({ frameUrl: target.frameUrl, selector, text });
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector === selector && element.frameUrl === target.frameUrl)
          element.value = text;
      }
    }
    async selectInFrame(
      target: { frameUrl: string },
      selector: string,
      matcher?: string,
    ): Promise<string> {
      h.frameSelects.push({ frameUrl: target.frameUrl, selector, matcher });
      let committed = matcher ?? "";
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector !== selector || element.frameUrl !== target.frameUrl) continue;
        const options = element.selectOptions as Array<{ value: string; text: string }> | undefined;
        const selected = options?.find((option) =>
          option.text.toLowerCase().includes((matcher ?? "").toLowerCase()),
        );
        committed = selected?.text ?? matcher ?? "";
        element.value = selected?.value ?? matcher ?? "";
        element.selectedOptionText = committed;
      }
      return committed;
    }
    async resolvePageTarget(
      _mode: string,
      _value: string,
      intent = "click",
    ): Promise<
      | {
          ok: true;
          handle: { dispose: () => Promise<void> };
          text: string;
          labels: string[];
          safetySignals: { billingObject: boolean; accountSetup: boolean };
          frameTarget: {
            framePath: string;
            frameOrigin: string;
            frameUrl: string;
            frameOpaque?: boolean;
          } | null;
        }
      | { ok: false; reason: "none" | "ambiguous"; candidates: string[] }
    > {
      h.locatorResolveIntents.push(intent);
      if (h.locatorResolve.ok) {
        return {
          ok: true,
          handle: {
            dispose: async () => {
              h.locatorDisposeCalls += 1;
            },
          },
          text: h.locatorResolve.text,
          labels: h.locatorResolve.labels ?? [h.locatorResolve.text],
          safetySignals: h.locatorResolve.safetySignals,
          frameTarget: h.locatorResolve.frameTarget ?? null,
        };
      }
      return h.locatorResolve;
    }
    async clickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
      if (h.clickValueMutation !== null) {
        for (const element of h.elements as Array<Record<string, unknown>>) {
          if (element.selector === h.clickValueMutation.selector) {
            element.value = h.clickValueMutation.value;
          }
        }
      }
      if (h.cartLineItemsAfterClick !== null) h.cartLineItems = h.cartLineItemsAfterClick;
      if (h.failNextCartLineReadAfterClick) {
        h.cartLineReadFailuresRemaining = 1;
        h.failNextCartLineReadAfterClick = false;
      }
    }
    async jsClickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
    }
    async typeHandle(_handle: unknown, text: string, sealed = false): Promise<void> {
      h.locatorTypeCalls.push({ text, sealed });
    }
    async uploadFile(selector: string, filePath: string): Promise<void> {
      h.uploads.push({ selector, filePath });
    }
    async startOAuth(): Promise<void> {}
    async settleAfterOAuth(): Promise<void> {}
    async pressKey(key: string): Promise<void> {
      h.pressedKeys.push(key);
    }
    async focusedElementLabels(): Promise<string[]> {
      return h.focusedLabels;
    }
    async close(): Promise<void> {
      h.closeCalls += 1;
      if (h.connections[this.index] === true) h.started -= 1;
      h.connections[this.index] = false;
    }
  },
  // Mirrors the real export — the pending-card-fill charge guard reads it.
  CHECKOUT_SUBMIT_LABEL_RE:
    /^(?:pay(?:\s+now)?|place\s+order|complete\s+(?:order|purchase|payment)|submit\s+payment|buy\s+now|confirm\s+(?:order|payment))\b/i,
  parseCheckoutAmount: (texts: readonly string[], fallbackCurrency?: string) => {
    for (const text of texts) {
      const match = text.match(/(?:([A-Z]{3})\s*)?([$¥￥])?\s*([0-9]+(?:[.,][0-9]+)?)\s*(円|[A-Z]{3})?/i);
      if (match?.[3] === undefined) continue;
      const currency = (match[1] ?? match[4] ?? (match[2] === "$" ? "USD" : undefined) ?? fallbackCurrency)
        ?.replace("円", "JPY")
        .toUpperCase();
      if (currency === undefined) continue;
      const amount = Number(match[3].replace(",", "."));
      return { amount_cents: Math.round(amount * (currency === "JPY" ? 1 : 100)), currency };
    }
    return null;
  },
}));

vi.mock("../captcha-solver-2captcha.js", () => ({
  TwoCaptchaSolver: class {
    isAvailable(): boolean {
      return h.twoCaptchaAvailable;
    }
    async solveRecaptchaV2(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("recaptcha_v2");
      return h.twoCaptchaResult;
    }
    async solveHcaptcha(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("hcaptcha");
      return h.twoCaptchaResult;
    }
    async solveTurnstile(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("turnstile");
      return h.twoCaptchaResult;
    }
  },
}));

vi.mock("../google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    detectActiveProviderSessions: async () => {
      h.profileProbeCalls += 1;
      return h.providers;
    },
    ensureOAuthSession: async () => ({ status: h.oauthStatus }),
  };
});

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startProvisionSession,
  act,
  observe,
  observedHostsForSession,
  stashSecretSlot,
  awaitVerification,
  captchaGate,
  finishProvisionSession,
  closeAllProvisionSessions,
  parseElementsTable,
  replayOperatorRecipe,
  activeProvisionBrowser,
  activeProvisionBrowserForPayment,
  activeCartCheckoutForOrigin,
  cartAdd,
  recordActivePaymentProvenance,
  setActivePendingCardFill,
  claimActivePaymentForOperatePay,
  completeActivePaymentLeaseWithPendingApproval,
  completeActivePaymentLeaseWithPendingFill,
  getActivePendingApproval,
  releaseActivePaymentLease,
  markActivePendingCardFillSubmitStarted,
  restoreActivePendingCardFillAfterConfirmThrow,
  retainActivePaymentFieldSeal,
  clearActivePendingCardFill,
  recipeTargetFor,
  captureObserved,
} from "../provision-session.js";
import {
  isRecipeDomainLocked,
  isRecipeShareEligible,
  checkoutFieldSetSignature,
  checkoutShapeKey,
  OperatorRecipeSchema,
  readRecipeForTask,
  writeRecipe,
  type OperatorRecipe,
} from "../operator-recipe.js";
import {
  provisionRememberTool,
  provisionUseTool,
  provisionFinishTaskTool,
  provisionPrepareLoginTool,
  provisionSealVaultCredentialTool,
  provisionStoreLoginTool,
  storedExtractResult,
  withSigninHost,
} from "../../tools/provision-drive.js";
import type { ApiClient } from "../../api-client.js";

function elem(partial: Record<string, unknown>): unknown {
  // Default locale-stable role signals for money-path fixtures so the
  // field_role fill guard can match without every call site restating them.
  const testId = typeof partial.testId === "string" ? partial.testId : "";
  const name = typeof partial.name === "string" ? partial.name : "";
  let autocomplete: string | null = null;
  if (partial.autocomplete !== undefined) {
    autocomplete = partial.autocomplete as string | null;
  } else if (testId.includes("city") || name === "city") {
    autocomplete = "address-level2";
  } else if (testId.includes("country") || name === "country") {
    autocomplete = "country";
  } else if (testId.includes("email") || name === "email") {
    autocomplete = "email";
  } else if (testId.includes("phone") || name === "phone") {
    autocomplete = "tel";
  } else if (name === "firstName" || testId.includes("first")) {
    autocomplete = "given-name";
  } else if (name === "lastName" || testId.includes("last")) {
    autocomplete = "family-name";
  }
  return {
    index: 0,
    tag: "input",
    type: "text",
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "input",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    autocomplete,
    ...partial,
    // Keep derived autocomplete unless the caller overrode it.
    ...(partial.autocomplete !== undefined ? {} : { autocomplete }),
    ...(typeof partial.frameUrl === "string" && partial.framePath === undefined
      ? { framePath: "0" }
      : {}),
  };
}

beforeEach(() => {
  h.providers = ["google"];
  h.oauthStatus = "already_valid";
  h.typed = [];
  h.uploads = [];
  h.selected = [];
  h.phoneCountries = [];
  h.phoneCountry = null;
  h.clearElementsOnClick = false;
  h.clickValueMutation = null;
  h.clickPhoneCountryMutation = null;
  h.autocompleteSuggestions = [];
  h.autocompleteCommitMutation = null;
  h.autocompleteCommitCalls = [];
  h.autocompleteConfirmOverride = null;
  h.autocompleteConfirmCalls = [];
  h.autocompleteDiscardCalls = 0;
  h.autocompleteDiscardEscapeCalls = [];
  h.clickCalls = 0;
  h.frameClicks = [];
  h.frameJsClicks = [];
  h.frameTypes = [];
  h.frameSelects = [];
  h.gotos = [];
  h.consentDismissCalls = 0;
  h.consentCta = null;
  h.started = 0;
  h.startCalls = 0;
  h.closeCalls = 0;
  h.resetCalls = 0;
  h.resetFailuresRemaining = 0;
  h.profileProbeCalls = 0;
  h.controllerProviderProbeCalls = 0;
  h.connections = [];
  h.currentUrl = "";
  h.elements = [];
  h.checkoutFieldNames = [];
  h.visibleText = "";
  h.checkoutSummary = null;
  h.cartLineItems = [];
  h.cartLineItemsAfterClick = null;
  h.cartLineReadFailuresRemaining = 0;
  h.failNextCartLineReadAfterClick = false;
  h.readCheckoutSummaryCalls = 0;
  h.focusedLabels = [];
  h.pressedKeys = [];
  h.scrolls = [];
  h.captchaVariant = "unknown";
  h.captchaChallengeRendered = false;
  h.captchaToken = false;
  h.captchaSettled = true;
  h.captchaSolved = true;
  h.invisibleTriggered = true;
  h.visibleSolveCalls = 0;
  h.invisibleTriggerCalls = 0;
  h.twoCaptchaAvailable = false;
  h.twoCaptchaResult = { kind: "ok", token: "captcha-token", durationMs: 1 };
  h.twoCaptchaCalls = [];
  h.locatorResolve = {
    ok: true,
    text: "Control",
    safetySignals: { billingObject: false, accountSetup: false },
  };
  h.locatorClickCalls = 0;
  h.locatorTypeCalls = [];
  h.locatorResolveIntents = [];
  h.locatorDisposeCalls = 0;
});

const replayRecipe = (overrides: Partial<OperatorRecipe> = {}): OperatorRecipe => ({
  name: "checkout-coffee",
  schema_version: 1,
  goal: "Buy the selected coffee",
  verb: "purchase",
  domain: "example.com",
  entry_url: "https://shop.example.com/checkout",
  allowed_hosts: ["shop.example.com"],
  trace: [],
  secrets: [],
  postcondition: {
    kind: "execute_capability",
    describe: "Order is ready for approval",
    success_signal: { text_present: "Review order" },
  },
  ...overrides,
});

describe("prepared-statement replay", () => {
  it("resolves, binds, and acts without putting the host in the hot path", async () => {
    h.elements = [
      elem({
        testId: "shipping-city",
        name: "city",
        labelText: "City",
        selector: "#city",
        value: "",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city", name: "city" },
                accessible_name: "City",
                css: "#city",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    expect(result.status).toBe("complete");
    expect(result.status === "complete" && result.field_values_verified).toBe(true);
    expect(h.typed).toEqual([{ selector: "#city", text: "Queens" }]);
  });

  it("hands one missed step to the host and provides a continuation index", async () => {
    h.elements = [];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "click",
              target: {
                dom_hint: { testid: "review-order" },
                visible_text: "Review order",
              },
            },
          },
          { action: { kind: "press", key: "Enter" } },
        ],
      }),
      {},
    );
    expect(result.status).toBe("fallback_required");
    expect(result.status === "fallback_required" && result.step_index).toBe(0);
    expect(result.status === "fallback_required" && result.next_index).toBe(1);
  });

  it("makes manual card-entry refusal terminal without exposing replay data", async () => {
    const pan = "5555 5555 5555 4444";
    h.elements = [
      elem({
        testId: "card-number",
        labelText: "Card number",
        selector: "#card-number",
        value: "",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "type",
            target: {
              dom_hint: { testid: "card-number" },
              accessible_name: "Card number",
              css: "#card-number",
            },
            value: pan,
          },
        },
      ],
    });

    let refusal: unknown;
    try {
      await replayOperatorRecipe(started.session_id, recipe, {});
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    const surfaced = String(refusal);
    expect(surfaced).toMatch(/operate_pay/);
    expect(surfaced).not.toContain(pan);
    expect(surfaced).not.toContain("fallback_required");
    expect(surfaced).not.toContain("next_index");
    expect(refusal).not.toHaveProperty("step");
    expect(refusal).not.toHaveProperty("next_index");
    expect(h.typed).toEqual([]);
    await expect(replayOperatorRecipe(started.session_id, recipe, {}, 1)).rejects.toThrow(
      /invalid replay continuation/i,
    );
  });

  it("rejects fresh, wrong-index, and changed-binding replay continuations", async () => {
    h.elements = [];
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "click",
            target: { dom_hint: { testid: "review-order" }, visible_text: "Review order" },
          },
        },
      ],
    });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const fallback = await replayOperatorRecipe(started.session_id, recipe, { quantity: "1" });
    expect(fallback.status).toBe("fallback_required");
    await expect(
      replayOperatorRecipe(started.session_id, recipe, { quantity: "1" }, 2),
    ).rejects.toThrow(/invalid replay continuation/i);
    await expect(
      replayOperatorRecipe(started.session_id, recipe, { quantity: "2" }, 1),
    ).rejects.toThrow(/invalid replay continuation/i);
    await finishProvisionSession(started.session_id);

    const fresh = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await expect(replayOperatorRecipe(fresh.session_id, recipe, {}, 1)).rejects.toThrow(
      /invalid replay continuation/i,
    );
  });

  it("requires a human when a transition mutates and unmounts a field", async () => {
    h.elements = [
      elem({
        testId: "shipping-city",
        labelText: "City",
        selector: "#city",
        value: "",
      }),
      elem({
        tag: "button",
        testId: "continue",
        role: "button",
        ariaLabel: "Continue",
        selector: "#continue",
      }),
    ];
    h.clearElementsOnClick = true;
    h.clickValueMutation = { selector: "#city", value: "Brooklyn" };
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city" },
                accessible_name: "City",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
          {
            action: {
              kind: "click",
              target: { dom_hint: { testid: "continue" }, accessible_name: "Continue" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    expect(result).toMatchObject({
      status: "human_required",
      reason: "field_missing",
      field: "address.city",
    });
    expect(h.elements).toEqual([]);
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("rejects unclassified legacy recipes from deterministic replay", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await expect(
      replayOperatorRecipe(
        started.session_id,
        replayRecipe({ verb: undefined, domain: undefined }),
        {},
      ),
    ).rejects.toThrow(/legacy named recipes are hint-only/i);
  });

  it("does not resolve a vanished shipping field to a unique billing sibling", async () => {
    h.elements = [
      elem({
        testId: "billing-city",
        name: "city",
        labelText: "City",
        selector: "#billing-city",
        value: "",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city", name: "city" },
                accessible_name: "City",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    expect(result).toMatchObject({ status: "fallback_required", step_index: 0 });
    expect(h.typed).toEqual([]);
  });

  it("revalidates phone country across transitions and at payment", async () => {
    h.elements = [
      elem({
        tag: "button",
        testId: "continue",
        role: "button",
        ariaLabel: "Continue",
        selector: "#continue",
      }),
    ];
    h.clickPhoneCountryMutation = "Japan";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "set_phone_country",
              value: { hole: "contact.country" },
            },
          },
          {
            action: {
              kind: "click",
              target: { dom_hint: { testid: "continue" }, accessible_name: "Continue" },
            },
          },
        ],
      }),
      { "contact.country": "United States" },
    );
    expect(result).toMatchObject({
      status: "human_required",
      reason: "field_value_mismatch",
      field: "contact.country",
    });
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("replay-per-leg-signature: degrades to leg_fallback_required (not human_required) when a genuine catalog prefix precedes the failing checkout field", async () => {
    h.elements = [
      elem({
        tag: "button",
        testId: "add-to-cart",
        role: "button",
        ariaLabel: "Add to cart",
        selector: "#add",
      }),
      elem({
        tag: "button",
        testId: "continue",
        role: "button",
        ariaLabel: "Continue",
        selector: "#continue",
      }),
    ];
    h.clickPhoneCountryMutation = "Japan";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const recipe = replayRecipe({
      trace: [
        // A genuine catalog/storefront-leg step BEFORE any money field —
        // this is what makes the money-path guard failure below degrade to
        // a leg-scoped fallback instead of the whole-run human_required.
        {
          action: {
            kind: "click",
            target: { dom_hint: { testid: "add-to-cart" }, accessible_name: "Add to cart" },
          },
        },
        {
          action: {
            kind: "set_phone_country",
            value: { hole: "contact.country" },
          },
        },
        {
          action: {
            kind: "click",
            target: { dom_hint: { testid: "continue" }, accessible_name: "Continue" },
          },
        },
      ],
    });
    const result = await replayOperatorRecipe(started.session_id, recipe, {
      "contact.country": "United States",
    });
    expect(result).toMatchObject({
      status: "leg_fallback_required",
      leg: "checkout",
      from_step_index: 1,
    });
    expect((result as { reason: string }).reason).toContain("field_value_mismatch");
    // Not resumable — the run degrades to cold driving for the leg, it
    // doesn't hand back a continuation the way fallback_required does.
    await expect(
      replayOperatorRecipe(started.session_id, recipe, { "contact.country": "United States" }, 1),
    ).rejects.toThrow(/invalid replay continuation/i);
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  }, 10_000);

  it("blocks payment until the exact missed field is repaired and replay resumes", async () => {
    h.elements = [];
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "type",
            target: {
              dom_hint: { testid: "shipping-city" },
              accessible_name: "City",
              field_role: "ac:address-level2",
            },
            value: { hole: "address.city" },
          },
        },
        { action: { kind: "press", key: "Enter" } },
      ],
    });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const fallback = await replayOperatorRecipe(started.session_id, recipe, {
      "address.city": "Queens",
    });
    expect(fallback).toMatchObject({ status: "fallback_required", next_index: 1 });
    expect(() => activeProvisionBrowser()).toThrow(/verification is not satisfied/i);

    h.elements = [
      elem({
        testId: "live-city",
        labelText: "City",
        selector: "#live-city",
        value: "",
      }),
    ];
    await act(started.session_id, {
      kind: "type",
      target: "live-city",
      text: "Queens",
      replayRepair: { stepIndex: 0, hole: "address.city" },
    });
    const complete = await replayOperatorRecipe(
      started.session_id,
      recipe,
      { "address.city": "Queens" },
      1,
    );
    expect(complete.status).toBe("complete");
    expect(() => activeProvisionBrowser()).not.toThrow();
  });

  it("rejects a wrong field repair and keeps payment blocked", async () => {
    h.elements = [];
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "type",
            target: {
              dom_hint: { testid: "shipping-city" },
              accessible_name: "City",
              field_role: "ac:address-level2",
            },
            value: { hole: "address.city" },
          },
        },
      ],
    });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await replayOperatorRecipe(started.session_id, recipe, { "address.city": "Queens" });
    h.elements = [
      elem({
        testId: "shipping-city",
        labelText: "Shipping city",
        selector: "#live-city",
        value: "",
      }),
    ];
    await expect(
      act(started.session_id, {
        kind: "type",
        target: "shipping-city",
        text: "Brooklyn",
        replayRepair: { stepIndex: 0, hole: "address.city" },
      }),
    ).rejects.toThrow(/replay repair value mismatch/i);
    expect(() => activeProvisionBrowser()).toThrow(/verification is not satisfied/i);
  });

  it("rejects an ambiguous sibling repair with the expected value", async () => {
    h.elements = [];
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "type",
            target: {
              dom_hint: { testid: "shipping-city" },
              accessible_name: "City",
              field_role: "ac:address-level2",
            },
            value: { hole: "address.city" },
          },
        },
      ],
    });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await replayOperatorRecipe(started.session_id, recipe, { "address.city": "Queens" });
    h.elements = [
      elem({ testId: "new-shipping-city", labelText: "City", selector: "#shipping", value: "" }),
      elem({ testId: "billing-city", labelText: "City", selector: "#billing", value: "" }),
    ];
    await expect(
      act(started.session_id, {
        kind: "type",
        target: "billing-city",
        text: "Queens",
        replayRepair: { stepIndex: 0, hole: "address.city" },
      }),
    ).rejects.toThrow(/repair target mismatch/i);
    expect(() => activeProvisionBrowser()).toThrow(/verification is not satisfied/i);
  });

  it("rechecks mounted verified fields at the payment boundary", async () => {
    h.elements = [
      elem({
        testId: "shipping-city",
        labelText: "City",
        selector: "#city",
        value: "",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city" },
                accessible_name: "City",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    expect(result.status).toBe("complete");
    (h.elements[0] as Record<string, unknown>).value = "Brooklyn";
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("blocks payment when a verified target drifts without a replay transition", async () => {
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city" },
                css: "#city",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    h.elements = [elem({ testId: "new-city", selector: "#new-city", value: "Brooklyn" })];
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("uses a committed custom-combobox value only for immediate attestation", async () => {
    h.elements = [
      elem({
        tag: "input",
        role: "combobox",
        testId: "shipping-country",
        labelText: "Country",
        selector: "#country",
        value: "",
        selectedOptionText: null,
        visibleText: null,
        selectOptions: [{ value: "US", text: "United States" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "select",
              target: {
                dom_hint: { testid: "shipping-country" },
                accessible_name: "Country",
                field_role: "ac:country",
              },
              value: { hole: "address.country" },
            },
          },
        ],
      }),
      { "address.country": "United States" },
    );
    expect(result).toMatchObject({ status: "complete", field_values_verified: true });
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("detects field drift caused by a replay transition before retirement", async () => {
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
      elem({
        tag: "button",
        testId: "recalculate",
        role: "button",
        ariaLabel: "Recalculate",
        selector: "#recalculate",
      }),
    ];
    h.clickValueMutation = { selector: "#city", value: "Brooklyn" };
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city" },
                accessible_name: "City",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
          {
            action: {
              kind: "click",
              target: { dom_hint: { testid: "recalculate" }, accessible_name: "Recalculate" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    expect(result).toMatchObject({
      status: "human_required",
      reason: "field_value_mismatch",
      field: "address.city",
    });
    expect(() => activeProvisionBrowser()).toThrow(/verification is not satisfied/i);
  });

  it("invalidates a verified field when a later value action changes it", async () => {
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "type",
              target: {
                dom_hint: { testid: "shipping-city" },
                accessible_name: "City",
                field_role: "ac:address-level2",
              },
              value: { hole: "address.city" },
            },
          },
        ],
      }),
      { "address.city": "Queens" },
    );
    await expect(
      act(started.session_id, { kind: "type", target: "shipping-city", text: "Brooklyn" }),
    ).rejects.toThrow(/field value mismatch/i);
    expect(() => activeProvisionBrowser()).toThrow(/verification is not satisfied/i);
  });

  it("does not let a caller skip straight past a mis-filled money field", async () => {
    h.elements = [
      elem({
        testId: "shipping-city",
        labelText: "City",
        selector: "#city",
        value: "Wrong city",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await expect(
      replayOperatorRecipe(
        started.session_id,
        replayRecipe({
          trace: [
            {
              action: {
                kind: "type",
                target: {
                  dom_hint: { testid: "shipping-city" },
                  accessible_name: "City",
                  css: "#city",
                  field_role: "ac:address-level2",
                },
                value: { hole: "address.city" },
              },
            },
          ],
        }),
        { "address.city": "Queens" },
        1,
      ),
    ).rejects.toThrow(/invalid replay continuation/i);
  });
});

describe("replay-serve-live-domainlock — hard domain-lock at replay time", () => {
  const shapeDomain = `shape:${"a".repeat(64)}`;

  it("SAFETY: refuses a goto step targeting a different eTLD+1, hard-stops (not resumable), and shuts the payment gate", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [{ action: { kind: "goto", url_template: "https://attacker.net/phish" } }],
      }),
      {},
    );
    expect(result).toMatchObject({
      status: "domain_lock_violation",
      step_index: 0,
      host: "attacker.net",
      recipe_domain: "example.com",
    });
    expect(h.gotos).not.toContain("https://attacker.net/phish");
    await expect(activeProvisionBrowserForPayment()).rejects.toThrow(
      /verification is not satisfied/i,
    );
  });

  it("SAFETY: refuses an allow_host step declaring a different eTLD+1", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [{ action: { kind: "allow_host", host: "attacker.net" } }],
      }),
      {},
    );
    expect(result).toMatchObject({
      status: "domain_lock_violation",
      step_index: 0,
      host: "attacker.net",
      recipe_domain: "example.com",
    });
  });

  it("SAFETY: refuses a look-alike domain (example.com.attacker.net) even though it contains the real domain", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          { action: { kind: "goto", url_template: "https://example.com.attacker.net/phish" } },
        ],
      }),
      {},
    );
    expect(result.status).toBe("domain_lock_violation");
  });

  it.each([
    "https://accounts.google.com/o/oauth2/auth",
    "https://recipe-escape.firebaseapp.com/__/auth/handler",
  ])(
    "SAFETY: refuses a pre-approved session auth host outside the recipe domain: %s",
    async (url) => {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/checkout",
      });
      const result = await replayOperatorRecipe(
        started.session_id,
        replayRecipe({
          trace: [{ action: { kind: "goto", url_template: url } }],
        }),
        {},
      );
      expect(result).toMatchObject({
        status: "domain_lock_violation",
        step_index: 0,
        recipe_domain: "example.com",
      });
      expect(h.gotos).not.toContain(url);
    },
  );

  it("allows a goto step to a subdomain of the recipe's own domain", async () => {
    h.elements = [];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      // The new recipe-domain lock allows any subdomain of "example.com";
      // the target must ALSO clear the session's own (pre-existing,
      // unrelated) host-scope gate, so declare it there too.
      extraAllowedHosts: ["checkout.example.com"],
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [{ action: { kind: "goto", url_template: "https://checkout.example.com/next" } }],
      }),
      {},
    );
    expect(result.status).toBe("complete");
    expect(h.gotos).toContain("https://checkout.example.com/next");
  });

  it.each([
    ["goto", { action: { kind: "goto" as const, url_template: "https://store.example/next" } }],
    ["allow_host", { action: { kind: "allow_host" as const, host: "store.example" } }],
  ])("SAFETY: refuses a %s step in a checkout-shape recipe", async (_kind, step) => {
    const started = await startProvisionSession({ serviceUrl: "https://store.example/checkout" });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({ domain: shapeDomain, entry_url: undefined, allowed_hosts: [], trace: [step] }),
      {},
    );
    expect(result).toMatchObject({
      status: "domain_lock_violation",
      step_index: 0,
      recipe_domain: shapeDomain,
    });
  });

  it("allows field-only actions in a checkout-shape recipe", async () => {
    h.elements = [
      elem({
        tag: "button",
        testId: "continue",
        role: "button",
        ariaLabel: "Continue",
        selector: "#continue",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://store.example/checkout" });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        domain: shapeDomain,
        entry_url: undefined,
        allowed_hosts: [],
        trace: [{ action: { kind: "click", target: { dom_hint: { testid: "continue" } } } }],
      }),
      {},
    );
    expect(result.status).toBe("complete");
  });

  it("only replays a shape recipe through the dedicated checkout-leg path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shape-recipe-path-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    const fields = ["email", "firstName", "lastName"];
    const signature = checkoutFieldSetSignature(fields)!;
    const shapeKey = checkoutShapeKey(signature);
    const recipe = replayRecipe({
      name: "checkout-leg--path-test",
      domain: shapeKey,
      entry_url: "https://attacker.net/checkout",
      allowed_hosts: [],
      trace: [{ action: { kind: "click", target: { dom_hint: { testid: "continue" } } } }],
    });
    await writeRecipe(recipe);

    await expect(
      provisionUseTool.handler({ name: `purchase--${shapeKey}` }, null as unknown as ApiClient),
    ).rejects.toThrow(/checkout-leg recipe.*leg:"checkout"/i);
    expect(h.startCalls).toBe(0);

    h.checkoutFieldNames = fields;
    h.elements = [
      elem({
        tag: "button",
        testId: "continue",
        role: "button",
        ariaLabel: "Continue",
        selector: "#continue",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://store.example/checkout" });
    const result = (await provisionUseTool.handler(
      { verb: "purchase", session_id: started.session_id, leg: "checkout", params: {} },
      null as unknown as ApiClient,
    )) as { replay: { status: string } };
    expect(result.replay.status).toBe("complete");
    expect(h.clickCalls).toBe(1);

    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("verified recipe recording", () => {
  it("never writes a recipe when the machine postcondition fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-fail-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.visibleText = "Still editing";
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "buy-coffee",
          goal: "Buy coffee",
          verb: "purchase",
          inputs: {},
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/postcondition not confirmed/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("never writes a cold trace after a checkout transition loses attestation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-transition-fail-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
      elem({ tag: "button", testId: "continue", labelText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "City",
      text: "Queens",
      provenance: { hole: "address.city" },
    });
    h.clearElementsOnClick = true;
    h.clickValueMutation = { selector: "#city", value: "Brooklyn" };
    await act(started.session_id, { kind: "click", target: "Continue" });
    h.visibleText = "Review order";
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "failed-transition",
          goal: "Buy coffee",
          verb: "purchase",
          inputs: { address: { city: "Queens" } },
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/checkout transition could not be attested/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to save an unprovenanced value action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-unbound-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "City", text: "Brooklyn" });
    h.visibleText = "Review order";
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "unsafe-checkout",
          goal: "Buy coffee",
          verb: "purchase",
          inputs: { address: { city: "Brooklyn" } },
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/lacks explicit provenance/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to save when the complete provenance ledger is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-no-ledger-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.visibleText = "Review order";
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "missing-ledger",
          goal: "Buy coffee",
          verb: "purchase",
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        } as never,
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/complete provenance inputs are required/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records stable targets and provenance holes only after verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-ok-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({
        testId: "product-search",
        id: "query",
        name: "query",
        role: "textbox",
        ariaLabel: "Search products",
        visibleText: "Search",
        selector: "#query",
        value: "",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "Search",
      text: "dark roast",
      provenance: { hole: "product_query" },
    });
    h.visibleText = "Review order";
    const saved = await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "buy-coffee",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: { product_query: "dark roast" },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    expect(saved).toMatchObject({ verified: { confirmed: true } });
    expect(readdirSync(dir)).toEqual(["purchase--example.com.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "purchase--example.com.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toMatchObject({
      verb: "purchase",
      domain: "example.com",
      trace: [
        {
          action: {
            kind: "type",
            value: { hole: "product_query" },
            target: {
              dom_hint: { testid: "product-search", id: "query", name: "query" },
              role_hint: "textbox",
              accessible_name: "Search products",
              css: "#query",
              visible_text: "Search",
            },
          },
        },
      ],
    });
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("replay-per-leg-signature: also writes a checkout-leg recipe, keyed by the live checkout field-name-set signature, when the trace has a catalog prefix before a money field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-checkout-leg-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({
        tag: "button",
        testId: "add-to-cart",
        role: "button",
        ariaLabel: "Add to cart",
        selector: "#add",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      extraAllowedHosts: ["checkout.example.com", "accounts.example.com"],
    });
    // Catalog/storefront leg — a non-money click.
    await act(started.session_id, { kind: "click", target: "Add to cart" });
    // Checkout leg — a money field.
    h.elements = [
      elem({
        testId: "shipping-city",
        name: "city",
        labelText: "City",
        selector: "#city",
        value: "",
      }),
    ];
    await act(started.session_id, {
      kind: "type",
      target: "City",
      text: "Brooklyn",
      provenance: { hole: "address.city" },
    });
    h.visibleText = "Review order";
    // What extractCheckoutFieldNames() would read off the live checkout
    // page at operate_remember time — independent of the recorded trace's
    // own targets, exactly as production computes it.
    h.checkoutFieldNames = ["city", "email", "firstName", "lastName"];
    const saved = await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "buy-coffee",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: { address: { city: "Brooklyn" } },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    expect((saved as { checkout_leg_file?: string }).checkout_leg_file).toBeDefined();
    const files = readdirSync(dir).sort();
    expect(files).toContain("purchase--example.com.json");
    expect(files.length).toBe(2);
    const checkoutLegFile = files.find((f) => f !== "purchase--example.com.json")!;
    const raw = JSON.parse(readFileSync(join(dir, checkoutLegFile), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw.verb).toBe("purchase");
    expect(raw.domain).toMatch(/^shape:[0-9a-f]{64}$/);
    const checkoutRecipe = OperatorRecipeSchema.parse(raw);
    expect(checkoutRecipe.allowed_hosts).toEqual([]);
    expect(isRecipeDomainLocked(checkoutRecipe)).toBe(true);
    expect(isRecipeShareEligible(checkoutRecipe).eligible).toBe(true);
    // Only the money-field step made it into the leg — not the earlier
    // catalog "Add to cart" click.
    expect((raw.trace as unknown[]).length).toBe(1);
    expect(raw).toMatchObject({
      trace: [{ action: { kind: "type", value: { hole: "address.city" } } }],
    });
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("replay-per-leg-signature: writes only the whole-task recipe (no checkout leg) when the trace has no money field", async () => {
    // Existing single-user behavior is unchanged: a non-money-path save
    // (e.g. an API-key signup) never gains a second file.
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-no-checkout-leg-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({
        testId: "product-search",
        id: "query",
        name: "query",
        role: "textbox",
        ariaLabel: "Search products",
        visibleText: "Search",
        selector: "#query",
        value: "",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "Search",
      text: "dark roast",
      provenance: { hole: "product_query" },
    });
    h.visibleText = "Review order";
    h.checkoutFieldNames = ["query"]; // present, but never consulted — no money field exists
    const saved = await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "buy-coffee",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: { product_query: "dark roast" },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    expect((saved as { checkout_leg_file?: string }).checkout_leg_file).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["purchase--example.com.json"]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves an exact known-email transform as an attested hole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-known-email-"));
    const profileDir = mkdtempSync(join(tmpdir(), "verified-recipe-known-email-profile-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    writeFileSync(
      join(profileDir, "provider-emails.json"),
      JSON.stringify({ google: "buyer@example.com" }),
    );
    h.elements = [
      elem({
        testId: "email-buyer@example.com",
        id: "buyer@example.com",
        name: "buyer@example.com",
        labelText: "buyer@example.com",
        ariaLabel: "buyer@example.com",
        visibleText: "buyer@example.com",
        href: "https://shop.example.com/account/buyer@example.com",
        selector: '[data-testid="email-buyer\\@example\\.com"]',
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      profileDir,
    });
    await act(started.session_id, {
      kind: "type",
      target: "buyer@example.com",
      text: "buyer@example.com",
      provenance: { hole: "address.email" },
    });
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "known-email",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: { address: { email: "buyer@example.com" } },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    const raw = readFileSync(join(dir, "purchase--example.com.json"), "utf8");
    expect(raw).toContain('"hole": "address.email"');
    expect(raw).toContain('"email_hole": "address.email"');
    expect(raw).toContain("${EMAIL_ALIAS}");
    expect(raw).toContain("${EMAIL_ALIAS_CSS}");
    expect(raw).not.toContain("buyer@example.com");
    expect(raw).not.toContain("buyer\\\\@example\\\\.com");
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("preserves a credential-backed known-email transform as an attested hole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-credential-email-"));
    const profileDir = mkdtempSync(join(tmpdir(), "verified-recipe-credential-profile-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    writeFileSync(
      join(profileDir, "provider-emails.json"),
      JSON.stringify({ google: "buyer@example.com" }),
    );
    h.elements = [
      elem({
        testId: "email-buyer@example.com",
        labelText: "buyer@example.com",
        selector: '[data-testid="email-buyer\\@example\\.com"]',
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      profileDir,
    });
    stashSecretSlot(started.session_id, "login", "buyer@example.com");
    await act(started.session_id, {
      kind: "type_secret",
      slot: "login",
      target: "buyer@example.com",
    });
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "credential-email",
        goal: "Create account",
        verb: "signup",
        inputs: { credential: { login: "buyer@example.com" } },
        postcondition: {
          kind: "execute_capability",
          describe: "Account created",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    const raw = readFileSync(join(dir, "signup--example.com.json"), "utf8");
    expect(raw).toContain('"email_hole": "credential.login"');
    expect(raw).not.toContain("buyer@example.com");
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("scrubs known-email variants from every persisted URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-email-url-"));
    const profileDir = mkdtempSync(join(tmpdir(), "verified-recipe-email-url-profile-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    writeFileSync(
      join(profileDir, "provider-emails.json"),
      JSON.stringify({ google: "buyer@example.com" }),
    );
    h.elements = [elem({ testId: "email", labelText: "Email", selector: "#email", value: "" })];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart?email=buyer%40example%2Ecom",
      profileDir,
    });
    await act(started.session_id, {
      kind: "type",
      target: "Email",
      text: "buyer@example.com",
      provenance: { hole: "address.email" },
    });
    await act(started.session_id, {
      kind: "goto",
      url: "https://shop.example.com/account/buyer%40example%2Ecom",
    });
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "email-url",
        goal: "Create account",
        verb: "signup",
        inputs: { address: { email: "buyer@example.com" } },
        postcondition: {
          kind: "observe_artifact",
          describe: "Account created",
          probe_url: "https://shop.example.com/account/buyer%2540example.com",
          success_signal: { url_contains: "/account/buyer%2540example.com" },
        },
      },
      null as unknown as ApiClient,
    );
    const raw = readFileSync(join(dir, "signup--example.com.json"), "utf8");
    expect(raw).toContain('"entry_mode": "runtime_service_url"');
    expect(raw).toContain("${EMAIL_ALIAS_URI}");
    expect(raw).toContain("${EMAIL_ALIAS_URI_URI}");
    expect(raw).toContain('"email_hole": "address.email"');
    expect(raw).not.toMatch(/buyer(?:@|%40)example(?:\.|%2e)com/i);
    expect(raw).not.toContain("buyer%2540example.com");
    const recipe = await readRecipeForTask("signup", "https://shop.example.com/cart");
    await finishProvisionSession(started.session_id);
    const replayStarted = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
    });
    const replay = await replayOperatorRecipe(replayStarted.session_id, recipe, {
      "address.email": "buyer@example.com",
    });
    expect(replay.status).toBe("complete");
    const finished = await provisionFinishTaskTool.handler(
      {
        session_id: replayStarted.session_id,
        kind: "result",
        summary: "Account created",
        verify_recipe: "email-url",
      },
      null as unknown as ApiClient,
    );
    expect(finished).toMatchObject({
      kind: "result",
      verified: { confirmed: true },
    });
    expect(h.gotos).toContain("https://shop.example.com/account/buyer%2540example.com");
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("rejects an unlabelled literal that matches a known input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-unlabelled-known-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [elem({ testId: "query", labelText: "Search", selector: "#query" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Search", text: "dark roast" });
    h.visibleText = "Review order";
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "unlabelled-query",
          goal: "Buy coffee",
          verb: "purchase",
          inputs: { product_query: "dark roast" },
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/value.*lacks explicit provenance/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a provenance label that disagrees with the injected source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-wrong-source-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [elem({ testId: "shipping-city", labelText: "City", selector: "#city" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "City",
      text: "Queens",
      provenance: { hole: "contact.email" },
    });
    h.visibleText = "Review order";
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "wrong-source",
          goal: "Buy coffee",
          verb: "purchase",
          inputs: { address: { city: "Queens" }, contact: { email: "buyer@example.com" } },
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/provenance contact\.email does not match/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("records credential and card provenance without storing either value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-sensitive-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [elem({ labelText: "Client secret", selector: "#secret", value: "" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "oauth_secret", "vault-secret-value");
    await act(started.session_id, {
      kind: "type_secret",
      slot: "oauth_secret",
      target: "Client secret",
    });
    recordActivePaymentProvenance("payment-card");
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "sensitive-checkout",
        goal: "Complete checkout",
        verb: "purchase",
        inputs: { credential: { oauth_secret: "vault-secret-value" }, card: "payment-card" },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    const raw = readFileSync(join(dir, "purchase--example.com.json"), "utf8");
    expect(raw).toContain('"hole": "credential.oauth_secret"');
    expect(raw).toContain('"hole": "card"');
    expect(raw).not.toContain("vault-secret-value");
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects sensitive provenance that changed after the action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-sensitive-drift-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [elem({ labelText: "Client secret", selector: "#secret", value: "" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "oauth_secret", "action-time-secret");
    await act(started.session_id, {
      kind: "type_secret",
      slot: "oauth_secret",
      target: "Client secret",
    });
    stashSecretSlot(started.session_id, "oauth_secret", "later-secret");
    h.visibleText = "Review order";
    await expect(
      provisionRememberTool.handler(
        {
          session_id: started.session_id,
          name: "sensitive-drift",
          goal: "Complete checkout",
          verb: "purchase",
          inputs: { credential: { oauth_secret: "later-secret" } },
          postcondition: {
            kind: "execute_capability",
            describe: "Ready to approve",
            success_signal: { text_present: "Review order" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/does not match the injected value/i);
    expect(readdirSync(dir)).toEqual([]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores single-use session entries as runtime-resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-runtime-entry-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    const token = "ab12cd34ef56gh78ij90kl";
    const started = await startProvisionSession({
      serviceUrl: `https://shop.example.com/magic?code=${token}`,
    });
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "runtime-entry",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: {},
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    const raw = readFileSync(join(dir, "purchase--example.com.json"), "utf8");
    expect(raw).toContain('"entry_mode": "runtime_service_url"');
    expect(raw).not.toContain(token);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
});
afterEach(async () => {
  await closeAllProvisionSessions();
});

describe("3.1 — autocomplete-aware type fill", () => {
  it("commits the single matching suggestion and verifies the underlying value actually committed", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteCommitMutation = {
      selector: "#address",
      value: "350 5th Ave, New York, NY 10118, USA",
    };
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" });
    expect(h.typed).toEqual([{ selector: "#address", text: "350 5th Ave" }]);
    expect(h.autocompleteCommitCalls).toEqual([0]);
    expect((h.elements[0] as Record<string, unknown>).value).toBe(
      "350 5th Ave, New York, NY 10118, USA",
    );
  });

  it("no-ops when typing opens no suggestion popup (plain text field, unchanged behavior)", async () => {
    h.elements = [elem({ testId: "shipping-name", labelText: "Name", selector: "#name" })];
    h.autocompleteSuggestions = [];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Name", text: "Ada Lovelace" });
    expect(h.autocompleteCommitCalls).toEqual([]);
    expect((h.elements[0] as Record<string, unknown>).value).toBe("Ada Lovelace");
  });

  it("stops on an ambiguous autocomplete match instead of guessing", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [
      "350 5th Ave, New York, NY 10118, USA",
      "350 5th Avenue, Brooklyn, NY 11215, USA",
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/autocomplete_commit_required/i);
    expect(h.autocompleteCommitCalls).toEqual([]);
    // Never a confident wrong commit — the field still holds only what was
    // typed, not a guessed option.
    expect((h.elements[0] as Record<string, unknown>).value).toBe("350 5th Ave");
  });

  it("stops when a popup opened but no suggestion matches the typed text", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["1 Infinite Loop, Cupertino, CA 95014, USA"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/autocomplete_commit_required/i);
    expect(h.autocompleteCommitCalls).toEqual([]);
  });

  // Gate-decision-2 fix (wrong-error-branch): the error must report the
  // MATCHED subset, not the raw popup — otherwise a genuine zero-match
  // never takes the "no option started with the typed text" branch (the
  // popup itself is always non-empty here) and the multi-match branch
  // reports the wrong count.
  it("reports a genuine zero-match with the zero-match message, not a miscounted multi-match message", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["1 Infinite Loop, Cupertino, CA 95014, USA"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/no visible option started with the typed text/i);
  });

  it("reports the matched-candidate count, not the popup size, on an ambiguous match", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [
      "350 5th Ave, New York, NY 10118, USA",
      "350 5th Avenue, Brooklyn, NY 11215, USA",
      "1 Infinite Loop, Cupertino, CA 95014, USA",
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/matched 2 suggestions, not one/i);
  });

  // Gate-decision-2 fix (double-slice-undercounts-matches): the call site
  // used to slice the matched subset to 8 before constructing the error,
  // whose message ALSO slices for display — so with more than 8 matches the
  // reported count was capped at 8 instead of the true count.
  it("reports the true match count, not a display-capped count, when more than 8 suggestions match", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = Array.from(
      { length: 12 },
      (_, i) => `350 5th Ave Suite ${i}, New York, NY 10118, USA`,
    );
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/matched 12 suggestions, not one/i);
  });

  // Gate-decision-2 fix (incidental-popup-collateral): 3.1 must only
  // engage for a form/recipe field where a committed value is actually
  // required — a site-search/catalog-search box that happens to open its
  // own suggestion listbox must keep ordinary free-text behavior.
  it("keeps free-text behavior for a search box that opens its own suggestion popup", async () => {
    h.elements = [elem({ testId: "site-search-box", labelText: "Search", selector: "#search" })];
    h.autocompleteSuggestions = ["Wireless Mouse", "Wireless Keyboard"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/catalog" });
    await expect(
      act(started.session_id, { kind: "type", target: "Search", text: "Wireless" }),
    ).resolves.toBeDefined();
    expect(h.autocompleteCommitCalls).toEqual([]);
    expect((h.elements[0] as Record<string, unknown>).value).toBe("Wireless");
  });

  it("still applies the autocomplete-commit rule when the host explicitly tags a non-money-shaped field with a recipe hole", async () => {
    h.elements = [elem({ testId: "site-search-box", labelText: "Search", selector: "#search" })];
    h.autocompleteSuggestions = ["Wireless Mouse", "Wireless Keyboard"];
    h.autocompleteCommitMutation = { selector: "#search", value: "Wireless Mouse" };
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/catalog" });
    await act(started.session_id, {
      kind: "type",
      target: "Search",
      text: "Wireless Mouse",
      provenance: { hole: "product_query" },
    });
    expect(h.autocompleteCommitCalls).toEqual([0]);
  });

  it("throws when a commit click lands but the underlying value never actually changed", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    // No autocompleteCommitMutation configured — the click "lands" (per the
    // mock's commitTypeSuggestion) but the field's live value never changes,
    // simulating a widget whose onSelect didn't actually fire.
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/did not take/i);
    expect(h.autocompleteCommitCalls).toEqual([0]);
  });

  // Gate-decision fix (2): the commit-took check must accept a broader
  // positive signal than the typed-into selector's own live value — a
  // react-select/cmdk-style widget clears its search input on selection and
  // renders the committed choice in a nearby element instead. The mock's
  // confirmAutocompleteCommitted override stands in for that nearby-signal
  // path (el.value never changes here, only the override says "confirmed").
  it("accepts a broader commit-confirmation signal than the same-selector value", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteConfirmOverride = true;
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).resolves.toBeDefined();
    expect(h.autocompleteConfirmCalls).toEqual([
      { selector: "#address", pickedText: "350 5th Ave, New York, NY 10118, USA" },
    ]);
  });

  // Gate-decision hard constraint on fix (2): a can't-tell must never be
  // assumed a success — the override defaults to null (mock falls back to
  // the realistic same-selector-value check), so with no mutation and no
  // override this must still stop, exactly like the existing
  // same-selector-only test above (regression guard for the broadened
  // signal not accidentally loosening the "never assume success" rule).
  it("still stops on a can't-tell commit even with the broadened confirmation signal", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/did not take/i);
  });

  // Gate-decision auto-fix: the popup lifecycle (Escape + clear markers)
  // must run on EVERY outcome — ambiguous stop, a failed "did not take"
  // commit, and success — not just the ambiguous path, or leftover markers
  // (and a still-open popup) desync the next type action's detection.
  it("cleans up the popup on an ambiguous stop", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [
      "350 5th Ave, New York, NY 10118, USA",
      "350 5th Avenue, Brooklyn, NY 11215, USA",
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/autocomplete_commit_required/i);
    expect(h.autocompleteDiscardCalls).toBe(1);
  });

  it("cleans up the popup after a failed 'did not take' commit", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/did not take/i);
    expect(h.autocompleteDiscardCalls).toBe(1);
  });

  it("cleans up the popup after a successful commit", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteCommitMutation = {
      selector: "#address",
      value: "350 5th Ave, New York, NY 10118, USA",
    };
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" });
    expect(h.autocompleteDiscardCalls).toBe(1);
  });

  // Gate-decision-2 fix (zero-suggestion-path-leaks-popup-markers): cleanup
  // used to be scoped INSIDE the `suggestionTexts.length > 0` branch, so a
  // type into a scoped field that opened NO popup left the "preexisting"
  // markers set by markPreexistingTypeSuggestionPopups uncleared —
  // markComboboxPreexistingElements only ADDS markers, so a stale one could
  // exclude a genuine popup from detection on a later type/select into the
  // same element.
  it("cleans up markers even when the field opens no suggestion popup at all", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" });
    expect(h.autocompleteDiscardCalls).toBe(1);
  });

  // Captain decision (unconditional-escape-closes-modals, narrowed by the
  // escape-after-successful-commit finding): Escape must only fire when a
  // detected popup is plausibly still open — the ambiguous/zero-match stop
  // (no option was ever clicked) and the failed-commit path (the click may
  // not have registered). It must NEVER fire when no popup was detected,
  // nor after a confirmed successful commit (the widget already closed its
  // popup on selection) — Escape commonly bubbles to close an enclosing
  // modal/dialog too (a cmdk-in-Radix-dialog combobox, a cart-drawer
  // quantity field, an address-edit modal).
  it("tells the browser NOT to press Escape when no popup was ever detected", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" });
    expect(h.autocompleteDiscardEscapeCalls).toEqual([false]);
  });

  it("tells the browser NOT to press Escape after a confirmed successful commit", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteCommitMutation = {
      selector: "#address",
      value: "350 5th Ave, New York, NY 10118, USA",
    };
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" });
    expect(h.autocompleteDiscardEscapeCalls).toEqual([false]);
  });

  it("tells the browser to press Escape on an ambiguous-match stop", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = [
      "350 5th Ave, New York, NY 10118, USA",
      "350 5th Avenue, Brooklyn, NY 11215, USA",
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/autocomplete_commit_required/i);
    expect(h.autocompleteDiscardEscapeCalls).toEqual([true]);
  });

  it("tells the browser to press Escape after a failed 'did not take' commit", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "type", target: "Address", text: "350 5th Ave" }),
    ).rejects.toThrow(/did not take/i);
    expect(h.autocompleteDiscardEscapeCalls).toEqual([true]);
  });

  // The committed value (not the raw typed draft) must be what recordTrace
  // records, so the saved trace reflects what actually ended up on the
  // page.
  it("records the committed value, not the raw typed draft, after a successful autocomplete commit", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteCommitMutation = {
      selector: "#address",
      value: "350 5th Ave, New York, NY 10118, USA",
    };
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "Address",
      text: "350 5th Ave",
      provenance: { hole: "address.line1" },
    });
    expect((h.elements[0] as Record<string, unknown>).value).toBe(
      "350 5th Ave, New York, NY 10118, USA",
    );
  });

  // Nearby-signal commits (react-select/cmdk clear their search input and
  // render the choice in a separate element) must record the field's LIVE
  // post-commit value, not pickedText — the cold-path transition
  // attestation re-reads the live value, so a pickedText literal would flag
  // every such commit as a mismatch and silently disqualify recipe
  // recording for exactly the widgets 3.1 targets.
  it("records the field's live value on a nearby-signal commit so cold attestation still passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-nearby-commit-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({ testId: "shipping-city", labelText: "City", selector: "#city", value: "" }),
      elem({ tag: "button", testId: "continue", labelText: "Continue", selector: "#continue" }),
    ];
    h.autocompleteSuggestions = ["Queens, NY, USA"];
    h.autocompleteConfirmOverride = true;
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, {
      kind: "type",
      target: "City",
      text: "Queens",
      provenance: { hole: "address.city" },
    });
    await act(started.session_id, { kind: "click", target: "Continue" });
    h.visibleText = "Review order";
    await provisionRememberTool.handler(
      {
        session_id: started.session_id,
        name: "nearby-commit",
        goal: "Buy coffee",
        verb: "purchase",
        inputs: { address: { city: "Queens" } },
        postcondition: {
          kind: "execute_capability",
          describe: "Ready to approve",
          success_signal: { text_present: "Review order" },
        },
      },
      null as unknown as ApiClient,
    );
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("operate_start — consent-overlay auto-dismiss", () => {
  // Regression: dismissConsentBanner() shipped as DEAD CODE (zero call sites), so
  // a cookie/consent overlay (Usercentrics/OneTrust) occluded the whole form and
  // the agent gave up — the Robinhood-faucet bug. operate_start must call it
  // before the first observation.
  it("calls dismissConsentBanner before the first observation", async () => {
    await startProvisionSession({ serviceUrl: "https://faucet.example.com/" });
    expect(h.consentDismissCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops retrying as soon as a banner CTA is clicked", async () => {
    h.consentCta = "Reject all";
    await startProvisionSession({ serviceUrl: "https://faucet.example.com/" });
    // Dismissed on the first attempt → the second (retry) attempt is skipped.
    expect(h.consentDismissCalls).toBe(1);
  });
});

describe("operate_act — locator (text=/css=) unsafe-action re-guard", () => {
  // The raw-target unsafe guard can't see through an opaque css= selector: the
  // target string carries no verb/noun, so a css=#save that resolves to
  // "Save product" on a LIVE-mode page slips past the first check. act() must
  // re-run the guard against the RESOLVED visible text before clicking.
  it("blocks a css= locator that resolves to a billing-object control in live mode", async () => {
    h.visibleText = "Dashboard Products Live mode";
    h.locatorResolve = {
      ok: true,
      text: "Save product",
      safetySignals: { billingObject: true, accountSetup: false },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    await expect(act(obs.session_id, { kind: "click", target: "css=#save" })).rejects.toThrow(
      /Mode safety guard/,
    );
    // The click must NOT have been dispatched.
    expect(h.locatorClickCalls).toBe(0);
  });

  it("blocks an icon-only css= target using its accessible label", async () => {
    const token = "tokensecretvalue123";
    h.visibleText = "Dashboard Products Live mode";
    h.locatorResolve = {
      ok: true,
      text: token,
      safetySignals: { billingObject: true, accountSetup: false },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    const error = await act(obs.session_id, {
      kind: "click",
      target: "css=#save-icon",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Mode safety guard/);
    expect((error as Error).message).not.toContain(token);
    expect(h.locatorClickCalls).toBe(0);
    expect(h.locatorDisposeCalls).toBe(1);
  });

  it("blocks a locator resolving to an account-setup control over authenticated UI", async () => {
    h.visibleText =
      "Finish creating your account Create account CP Cactus Practice Test mode Products";
    h.locatorResolve = {
      ok: true,
      text: "",
      safetySignals: { billingObject: false, accountSetup: true },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    await expect(
      act(obs.session_id, { kind: "click", target: "css=#finish-account" }),
    ).rejects.toThrow(/Perception guard/);
    expect(h.locatorClickCalls).toBe(0);
    expect(h.locatorDisposeCalls).toBe(1);
  });

  it("allows a css= locator resolving to a safe control (guard is not over-eager)", async () => {
    h.visibleText = "Product configurator";
    h.locatorResolve = {
      ok: true,
      text: "Add To Cart",
      safetySignals: { billingObject: false, accountSetup: false },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    await act(obs.session_id, { kind: "click", target: "css=#atc" }, "compact", {
      productIdentity: "sku:configured-product",
      optionsHash: "variant=default",
    });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("applies the domain lock to a locator resolved inside a frame", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Pay",
      safetySignals: { billingObject: false, accountSetup: false },
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://evil-payments.test",
        frameUrl: "https://evil-payments.test/widget?secret=hidden",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await expect(act(obs.session_id, { kind: "click", target: "text=Pay" })).rejects.toThrow(
      /blocked by domain-scope/i,
    );
    expect(h.locatorClickCalls).toBe(0);
    expect(h.locatorDisposeCalls).toBe(1);
  });

  it("types through a frame locator only after the frame domain lock passes", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Promo code",
      safetySignals: { billingObject: false, accountSetup: false },
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://checkout.example.com",
        frameUrl: "https://checkout.example.com/widget",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await act(obs.session_id, { kind: "type", target: "css=#promo", text: "SAVE10" });
    expect(h.locatorResolveIntents).toContain("type");
    expect(h.locatorTypeCalls).toEqual([{ text: "SAVE10", sealed: false }]);
  });

  it("blocks type and type_secret locators in untrusted frames", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Card number",
      safetySignals: { billingObject: false, accountSetup: false },
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://evil-payments.test",
        frameUrl: "https://evil-payments.test/widget",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await expect(
      act(obs.session_id, { kind: "type", target: "css=#card", text: "4111" }),
    ).rejects.toThrow(/blocked by domain-scope/i);
    stashSecretSlot(obs.session_id, "card", "4111111111111111");
    await expect(
      act(obs.session_id, { kind: "type_secret", target: "css=#card", slot: "card" }),
    ).rejects.toThrow(/type_secret refused/i);
    expect(h.locatorTypeCalls).toEqual([]);
  });

  it("refuses secret locator typing into an opaque sandboxed frame", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Password",
      safetySignals: { billingObject: false, accountSetup: false },
      frameTarget: {
        framePath: "0",
        frameOrigin: "null",
        frameUrl: "about:srcdoc",
        frameOpaque: true,
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(obs.session_id, "login", "s3cr3t");
    await expect(
      act(obs.session_id, { kind: "type_secret", target: "text=Password", slot: "login" }),
    ).rejects.toThrow(/opaque frame/i);
    expect(h.locatorTypeCalls).toEqual([]);
  });

  it("seals a same-domain type_secret locator before typing", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Password",
      safetySignals: { billingObject: false, accountSetup: false },
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://auth.example.com",
        frameUrl: "https://auth.example.com/login",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(obs.session_id, "login", "s3cr3t");
    await act(obs.session_id, { kind: "type_secret", target: "text=Password", slot: "login" });
    expect(h.locatorResolveIntents).toContain("type");
    expect(h.locatorTypeCalls).toEqual([{ text: "s3cr3t", sealed: true }]);
  });

  it("refuses to remember a session that used a locator fallback", async () => {
    h.visibleText = "Product configurator";
    h.locatorResolve = {
      ok: true,
      text: "Add To Cart",
      safetySignals: { billingObject: false, accountSetup: false },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    await act(obs.session_id, { kind: "click", target: "css=#atc" }, "compact", {
      productIdentity: "sku:configured-product",
      optionsHash: "variant=default",
    });

    await expect(
      provisionRememberTool.handler(
        {
          session_id: obs.session_id,
          name: "locator-session",
          goal: "Add a product to the cart",
          verb: "add_to_cart",
          inputs: {},
          postcondition: {
            kind: "execute_capability",
            describe: "Cart contains the product",
            success_signal: { text_present: "Cart" },
          },
        },
        null as unknown as ApiClient,
      ),
    ).rejects.toThrow(/locator fallback.*cannot represent/i);
  });
});

describe("operate session — multi-host allow-set + allow_host", () => {
  it("blocks a goto outside the start scope, then allow_host unblocks it", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
    });
    const sid = obs.session_id;

    // A cross-app host not declared at start is blocked.
    await expect(
      act(sid, { kind: "goto", url: "https://console.firebase.google.com/project" }),
    ).rejects.toThrow(/domain-scope/i);

    // Declare it mid-session, then the same goto is permitted.
    await act(sid, { kind: "allow_host", host: "console.firebase.google.com" });
    await act(sid, { kind: "goto", url: "https://console.firebase.google.com/project" });
    expect(h.gotos).toContain("https://console.firebase.google.com/project");
  });

  it("accepts a host declared at start via allowed_hosts (multi-app)", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
      extraAllowedHosts: ["console.firebase.google.com", "myapp.com"],
    });
    // Both declared hosts are immediately navigable (no allow_host needed).
    await act(obs.session_id, { kind: "goto", url: "https://myapp.com/settings" });
    expect(h.gotos).toContain("https://myapp.com/settings");
  });

  it("rejects a malformed allow_host (punycode spoof) and keeps the goto blocked", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://a.com/" });
    await expect(
      act(obs.session_id, { kind: "allow_host", host: "xn--80ak6aa92e.com" }),
    ).rejects.toThrow(/punycode|rejected/i);
  });
});

describe("operate session — egress seed excludes mid_session task scope", () => {
  it("does not include an allow_host (mid_session) host in the egress seed", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://console.cloud.google.com/start",
    });
    const sid = obs.session_id;
    await act(sid, { kind: "allow_host", host: "console.firebase.google.com" });
    const egress = observedHostsForSession(sid);
    expect(egress).toContain("console.cloud.google.com"); // start host included
    expect(egress).not.toContain("console.firebase.google.com"); // mid_session excluded
  });
});

describe("operate session — manual card-entry guard", () => {
  it("refuses to type a Luhn-valid card number (spaced) and types nothing", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [elem({ visibleText: "Card number", selector: "#card" })];
    await expect(
      act(obs.session_id, { kind: "type", target: "Card number", text: "5555 5555 5555 4444" }),
    ).rejects.toThrow(/operate_pay/);
    expect(h.typed).toEqual([]);
  });

  it("refuses the same card number unspaced and hyphenated", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [elem({ visibleText: "Card number", selector: "#card" })];
    await expect(
      act(obs.session_id, { kind: "type", target: "Card number", text: "5555555555554444" }),
    ).rejects.toThrow(/operate_pay/);
    await expect(
      act(obs.session_id, { kind: "type", target: "Card number", text: "5555-5555-5555-4444" }),
    ).rejects.toThrow(/operate_pay/);
    expect(h.typed).toEqual([]);
  });

  it("refuses a card number on the locator-fallback type path too", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    await expect(
      act(obs.session_id, { kind: "type", target: "css=#card", text: "4242 4242 4242 4242" }),
    ).rejects.toThrow(/operate_pay/);
    expect(h.locatorTypeCalls).toEqual([]);
    expect(h.typed).toEqual([]);
  });

  it("allows a 16-digit NON-Luhn value (an order number) through", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/support" });
    h.elements = [elem({ visibleText: "Order number", selector: "#order" })];
    await act(obs.session_id, { kind: "type", target: "Order number", text: "4242424242424243" });
    expect(h.typed).toEqual([{ selector: "#order", text: "4242424242424243" }]);
  });

  it("allows ordinary non-card text through", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [elem({ visibleText: "City", selector: "#city" })];
    await act(obs.session_id, { kind: "type", target: "City", text: "Brooklyn" });
    expect(h.typed).toEqual([{ selector: "#city", text: "Brooklyn" }]);
  });

  it("does not gate a card-shaped type_secret sealed-slot transfer (vault flow unaffected)", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://console.example.com/" });
    const sealedPan = "5555 5555 5555 4444";
    stashSecretSlot(obs.session_id, "sealed_card", sealedPan);
    h.elements = [elem({ visibleText: "Sealed field", selector: "#sealed" })];
    await act(obs.session_id, {
      kind: "type_secret",
      slot: "sealed_card",
      target: "Sealed field",
    });
    expect(h.typed).toEqual([{ selector: "#sealed", text: sealedPan }]);
  });
});

describe("operate session — sealed credential transfer", () => {
  it("type_secret types the real slot value into the page but never logs it", async () => {
    const secret = "GOCSPX-supersecret-value-1234567890";
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const obs = await startProvisionSession({
        serviceUrl: "https://console.firebase.google.com/",
      });
      const sid = obs.session_id;
      // Seal a secret (as operate_extract{into_slot} would) and target a field.
      stashSecretSlot(sid, "oauth_secret", secret);
      h.elements = [elem({ visibleText: "Client secret", selector: "#secret" })];
      await act(sid, { kind: "type_secret", slot: "oauth_secret", target: "Client secret" });

      // The REAL value reached the page...
      expect(h.typed.some((t) => t.text === secret)).toBe(true);
      // ...but NEVER appears in any audit line.
      const auditText = writes.join("");
      expect(auditText).not.toContain(secret);
      expect(auditText).toContain("type_secret"); // the action IS audited (by slot, not value)
    } finally {
      spy.mockRestore();
    }
  });

  it("type_secret on an unknown slot fails loudly", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://a.com/" });
    h.elements = [elem({ visibleText: "Field", selector: "#f" })];
    await expect(
      act(obs.session_id, { kind: "type_secret", slot: "missing", target: "Field" }),
    ).rejects.toThrow(/no sealed slot/i);
  });

  it("upload resolves the target and attaches the local file (no OS dialog)", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://drive.google.com/" });
    h.elements = [elem({ visibleText: "File upload", selector: "#upload-btn" })];
    await act(obs.session_id, { kind: "upload", target: "File upload", path: "/tmp/clip.mp4" });
    // Target resolved from the inventory → the file is set on that element; the
    // action never touches an OS file picker.
    expect(h.uploads).toEqual([{ selector: "#upload-btn", filePath: "/tmp/clip.mp4" }]);
  });

  it("select resolves the target and routes the option matcher to browser.selectOption", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [elem({ visibleText: "Country", selector: "#country" })];
    await act(obs.session_id, { kind: "select", target: "Country", text: "South Korea" });
    // The native/custom dropdown is driven via selectOption (NOT type), with the
    // resolved element's selector and the visible-text option matcher.
    expect(h.selected).toEqual([{ selector: "#country", matcher: "South Korea" }]);
    expect(h.typed).toEqual([]);
  });

  it("select fails loudly when the target isn't in the inventory", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [];
    await expect(
      act(obs.session_id, { kind: "select", target: "Country", text: "South Korea" }),
    ).rejects.toThrow(/no element matched target/i);
  });

  it("upload fails loudly when the target isn't in the inventory", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://drive.google.com/" });
    h.elements = [];
    await expect(
      act(obs.session_id, { kind: "upload", target: "File upload", path: "/tmp/clip.mp4" }),
    ).rejects.toThrow(/no element matched target/i);
    expect(h.uploads).toEqual([]);
  });
});

describe("operate_extract — vault-store response", () => {
  it("never returns extracted credential values after storing them", () => {
    const rawSecret = "sk-live-must-never-reach-the-model";
    const result = storedExtractResult(
      {
        session_id: "session-1",
        url: "https://example.com/api-keys",
        credentials: { api_key: rawSecret, client_secret: "also-secret" },
        candidate_count: 2,
      },
      {
        reference: "cred_123",
        service: "example",
        label: undefined,
        field_names: ["api_key", "client_secret"],
        allowed_hosts: ["api.example.com"],
        updated: false,
      },
    );

    expect(result).not.toHaveProperty("credentials");
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain("also-secret");
    expect(result.stored_credential.reference).toBe("cred_123");
  });
});

describe("operate session — Change 5 precondition gate", () => {
  it("fails closed (needs_user) without starting the browser when no live Google session", async () => {
    h.providers = []; // no live session
    h.oauthStatus = "failed"; // and we cannot establish one
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      requireLiveIdentity: true,
    });
    expect(obs.needs_user).toBeDefined();
    expect(obs.needs_user?.wall).toBe("google_session");
    expect(h.started).toBe(0); // the browser was NEVER started — task did not begin
    expect(h.gotos).toHaveLength(0);
  });

  it("proceeds normally when a live Google session exists", async () => {
    h.providers = ["google"];
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      requireLiveIdentity: true,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(h.started).toBe(1);
    await finishProvisionSession(obs.session_id);
  });
});

describe("operate session — warm browser lifecycle", () => {
  it("reuses the warm browser for the same profile and proxy without a second boot", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com/one",
      profileDir: "/tmp/operator-a",
      proxyUrl: "http://proxy-a.test:8080",
    });
    await finishProvisionSession(first.session_id);

    const second = await startProvisionSession({
      serviceUrl: "https://app.example.com/two",
      profileDir: "/tmp/operator-a",
      proxyUrl: "http://proxy-a.test:8080",
    });

    expect(h.startCalls).toBe(1);
    expect(h.resetCalls).toBeGreaterThanOrEqual(2);
    expect(h.profileProbeCalls).toBe(1);
    expect(h.controllerProviderProbeCalls).toBe(1);
    await finishProvisionSession(second.session_id);
  });

  it.each([
    {
      label: "profile",
      second: { profileDir: "/tmp/operator-b", proxyUrl: "http://proxy-a.test:8080" },
    },
    {
      label: "proxy",
      second: { profileDir: "/tmp/operator-a", proxyUrl: "http://proxy-b.test:8080" },
    },
  ])("cold-boots on a $label mismatch", async ({ second }) => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com/one",
      profileDir: "/tmp/operator-a",
      proxyUrl: "http://proxy-a.test:8080",
    });
    await finishProvisionSession(first.session_id);

    const next = await startProvisionSession({
      serviceUrl: "https://app.example.com/two",
      ...second,
    });

    expect(h.startCalls).toBe(2);
    expect(h.closeCalls).toBe(1);
    await finishProvisionSession(next.session_id);
  });

  it("discards a disconnected warm browser and cold-boots", async () => {
    const first = await startProvisionSession({ serviceUrl: "https://app.example.com/one" });
    await finishProvisionSession(first.session_id);
    h.connections[0] = false;

    const second = await startProvisionSession({ serviceUrl: "https://app.example.com/two" });

    expect(h.startCalls).toBe(2);
    expect(h.closeCalls).toBe(1);
    await finishProvisionSession(second.session_id);
  });

  it("discards a warm browser and cold-boots when page reset fails", async () => {
    const first = await startProvisionSession({ serviceUrl: "https://app.example.com/one" });
    await finishProvisionSession(first.session_id);
    h.resetFailuresRemaining = 1;

    const second = await startProvisionSession({ serviceUrl: "https://app.example.com/two" });

    expect(h.startCalls).toBe(2);
    expect(h.closeCalls).toBe(1);
    await finishProvisionSession(second.session_id);
  });

  it("refuses a second task while the single shared page is in flight", async () => {
    const first = await startProvisionSession({ serviceUrl: "https://app.example.com/one" });

    await expect(
      startProvisionSession({ serviceUrl: "https://app.example.com/two" }),
    ).rejects.toThrow(/another operator session is already in flight/);
    expect(h.startCalls).toBe(1);
    await finishProvisionSession(first.session_id);
  });

  it("does not reap the shared browser while a session is in flight", async () => {
    vi.useFakeTimers();
    try {
      const session = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000);

      expect(h.closeCalls).toBe(0);
      await finishProvisionSession(session.session_id);
      await closeAllProvisionSessions();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers max-age recycling until the in-flight task reaches finish", async () => {
    vi.useFakeTimers();
    try {
      const session = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(h.closeCalls).toBe(0);

      await finishProvisionSession(session.session_id);
      expect(h.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recycles at the configured default reuse-count boundary", async () => {
    for (let index = 0; index <= 50; index += 1) {
      const session = await startProvisionSession({
        serviceUrl: `https://app.example.com/task-${index}`,
      });
      await finishProvisionSession(session.session_id);
    }

    expect(h.startCalls).toBe(1);
    expect(h.closeCalls).toBe(1);

    const next = await startProvisionSession({ serviceUrl: "https://app.example.com/task-51" });
    expect(h.startCalls).toBe(2);
    await finishProvisionSession(next.session_id);
  });
});

describe("operate session — await_verification into_slot (T3 fix: OTP never round-trips)", () => {
  it("seals a found OTP into a slot (masked handle, no raw code) and type_secret enters it", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920. It expires in 10 minutes.";
    const res = await awaitVerification(sid, { intoSlot: "otp" });

    expect(res.found).toBe(true);
    expect(res.sealed).toBe(true);
    expect(res.code).toBeNull(); // the raw code is NOT returned to the host
    expect(res.slot?.preview).not.toContain("481920");

    // The host enters it by slot — the real digits reach the page, not the host.
    h.elements = [elem({ visibleText: "Code", selector: "#code" })];
    await act(sid, { kind: "type_secret", slot: "otp", target: "Code" });
    expect(h.typed.some((t) => t.text === "481920")).toBe(true);
  });

  it("returns the code normally when into_slot is NOT requested", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.code).toBe("481920");
    expect(res.sealed).toBeUndefined();
  });

  it("PR2: refuses the inbox read without consent and hands the code request back", async () => {
    // No consentInboxRead → default OFF → must NOT read the (mocked) inbox.
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.found).toBe(false);
    expect(res.code).toBeNull();
    expect(res.needs_user?.resume).toBe("code");
    expect(res.needs_user?.message).toContain("not consented");
  });

  it("PR3b: grant_inbox_consent reads the inbox after an in-context yes, and is remembered", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920.";
    // First call refuses (consent OFF).
    expect((await awaitVerification(sid, {})).found).toBe(false);
    // Host relays the user's yes → grant + read.
    const granted = await awaitVerification(sid, { grantConsent: true });
    expect(granted.found).toBe(true);
    expect(granted.code).toBe("481920");
    // Remembered for the session: a later await needs no re-grant.
    expect((await awaitVerification(sid, {})).found).toBe(true);
  });
});

describe("operate session — scroll (T5 fix: reveal below-the-fold controls)", () => {
  it("scrolls the viewport down by default and re-observes", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://console.cloud.google.com/" });
    await act(obs.session_id, { kind: "scroll" });
    expect(h.scrolls).toEqual(["down"]);
  });
  it("honors an explicit direction", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://console.cloud.google.com/" });
    await act(obs.session_id, { kind: "scroll", direction: "bottom" });
    expect(h.scrolls).toEqual(["bottom"]);
  });
});

describe("operate session — captcha gate", () => {
  it("solves a visible reCAPTCHA before returning settled=true", async () => {
    h.captchaVariant = "recaptcha_v2";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: true });
    expect(h.visibleSolveCalls).toBe(1);
  });

  it("does not treat a cleared visible challenge as solved without a token", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false;
    h.captchaSettled = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: false });
    expect(h.visibleSolveCalls).toBe(1);
  });

  it("escalates visible reCAPTCHA to the token solver when configured", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false;
    h.twoCaptchaAvailable = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v2", settled: true });
    expect(h.visibleSolveCalls).toBe(0);
    expect(h.twoCaptchaCalls).toEqual(["recaptcha_v2"]);
  });

  it("fail-fast: blocked v2 + no 2Captcha → needs_user(captcha_solver) with a settings remedy", async () => {
    h.captchaVariant = "recaptcha_v2";
    h.captchaSolved = false; // checkbox doesn't yield a token
    h.captchaSettled = false; // challenge stays up
    h.twoCaptchaAvailable = false; // no solver configured → no_key
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res.settled).toBe(false);
    expect(res.needs_user?.gate).toBe("captcha_solver");
    expect(res.needs_user?.remedy).toMatch(/2Captcha/i);
    expect(res.needs_user?.remedy).toMatch(/settings/i);
  });

  it("fail-fast: a scoring wall (blocked invisible v3) → needs_user(captcha_wall) suggesting a proxy", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false; // scoring never mints a token
    h.captchaSettled = false;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res.settled).toBe(false);
    expect(res.needs_user?.gate).toBe("captcha_wall");
    expect(res.needs_user?.remedy).toMatch(/proxy|manual/i);
  });

  it("executes invisible reCAPTCHA and waits for a response token", async () => {
    h.captchaVariant = "recaptcha_v3";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: true });
    expect(h.invisibleTriggerCalls).toBe(1);
  });

  it("blocks invisible reCAPTCHA when no response token is minted", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: false });
    expect(h.invisibleTriggerCalls).toBe(1);
  });

  it("escalates invisible reCAPTCHA to the token solver when configured", async () => {
    h.captchaVariant = "recaptcha_v3";
    h.invisibleTriggered = false;
    h.twoCaptchaAvailable = true;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await captchaGate(obs.session_id);

    expect(res).toMatchObject({ found: true, variant: "recaptcha_v3", settled: true });
    expect(h.invisibleTriggerCalls).toBe(1);
    expect(h.twoCaptchaCalls).toEqual(["recaptcha_v2"]);
  });
});

describe("operate session — PR3c username/password login (capture-at-login sourced)", () => {
  let profileDir: string;
  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), "ts-pr3c-"));
  });
  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  function withEmail(email: string): void {
    writeFileSync(join(profileDir, "provider-emails.json"), JSON.stringify({ google: email }));
  }

  it("prepare_login seals the captured user email + a generated password (masked handles only)", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    const res = (await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as {
      slots: { login: { preview: string }; password: { length: number } };
      email_preview: string;
    };
    // Neither the handle preview nor the email_preview leaks the raw address.
    expect(res.email_preview).not.toContain("ada@example.com");
    expect(res.slots.login.preview).not.toContain("ada@example.com");
    expect(res.slots.password.length).toBeGreaterThanOrEqual(16);
  });

  it("prepare_login hands back when no user email was captured", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    const res = (await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as { needs_user?: { wall: string; resume: string } };
    expect(res.needs_user?.wall).toBe("user_email");
    expect(res.needs_user?.resume).toBe("connect");
  });

  it("store_login vaults the sealed email+password as username_password, no raw values returned", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    );

    let captured:
      | {
          service: string;
          type?: string;
          auth_strategy?: string;
          fields?: Record<string, string>;
          login_hosts?: string[];
          signin_url?: string;
        }
      | undefined;
    const api = {
      storeCredential: async (input: {
        service: string;
        type?: string;
        auth_strategy?: string;
        fields?: Record<string, string>;
        login_hosts?: string[];
        signin_url?: string;
      }) => {
        captured = input;
        return {
          reference: "vault://acct/login1",
          service: input.service,
          label: "default",
          field_names: ["login", "password"],
          auth_strategy: "username_password",
          login_hosts: input.login_hosts ?? [],
          signin_url: input.signin_url ?? null,
          allowed_hosts: [],
          created_at: "now",
          updated: false,
        };
      },
    } as unknown as ApiClient;

    const res = (await provisionStoreLoginTool.handler(
      {
        session_id: obs.session_id,
        service: "example",
        login_hosts: ["app.example.com"],
        signin_url: "https://app.example.com/login",
      },
      api,
    )) as { reference: string; type: string; login_hosts: string[] };

    expect(captured?.type).toBe("username_password");
    expect(captured?.auth_strategy).toBe("username_password");
    expect(captured?.fields?.login).toBe("ada@example.com");
    expect((captured?.fields?.password ?? "").length).toBeGreaterThanOrEqual(16);
    expect(captured?.login_hosts).toEqual(["app.example.com"]);
    expect(res.login_hosts).toEqual(["app.example.com"]);
    expect(res.reference).toBe("vault://acct/login1");
    // The raw password must not appear in the tool's response.
    expect(JSON.stringify(res)).not.toContain(captured?.fields?.password ?? "UNSET");
  });

  it("seal_vault_credential stashes browser-fill fields as slots without returning raw values", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/login",
      profileDir,
    });
    let captured:
      | {
          current_host: string;
          reference?: string;
          fields: string[];
          encrypted_response_public_key: string;
        }
      | undefined;
    const api = {
      browserFillCredential: async (input: {
        current_host: string;
        reference?: string;
        fields: string[];
        encrypted_response_public_key: string;
      }) => {
        captured = input;
        const encrypt = (value: string) =>
          publicEncrypt(
            {
              key: input.encrypted_response_public_key,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(value, "utf8"),
          ).toString("base64");
        return {
          reference: input.reference ?? "vault://acct/login1",
          encrypted_fields: {
            login: encrypt("ada@example.com"),
            password: encrypt("correct-horse"),
          },
        };
      },
    } as unknown as ApiClient;

    const res = (await provisionSealVaultCredentialTool.handler(
      {
        session_id: obs.session_id,
        reference: "vault://acct/login1",
        fields: ["login", "password"],
        slot_prefix: "signin",
      },
      api,
    )) as { reference: string; slots: Record<string, { slot: string }> };

    expect(captured).toMatchObject({
      current_host: "https://app.example.com/login",
      reference: "vault://acct/login1",
      fields: ["login", "password"],
    });
    expect(res.reference).toBe("vault://acct/login1");
    expect(res.slots.login?.slot).toBe("signin_login");
    expect(res.slots.password?.slot).toBe("signin_password");
    expect(JSON.stringify(res)).not.toContain("ada@example.com");
    expect(JSON.stringify(res)).not.toContain("correct-horse");

    h.elements = [elem({ visibleText: "Email", selector: "#email" })];
    await act(obs.session_id, { kind: "type_secret", slot: "signin_login", target: "Email" });
    expect(h.typed.some((t) => t.selector === "#email" && t.text === "ada@example.com")).toBe(true);
  });
});

describe("observation detail ladder (none < compact < full)", () => {
  it("default is compact: no screen/accessibility, value_len, elements_total, no container, path DROPPED", async () => {
    h.elements = [
      elem({
        tag: "input",
        type: "text",
        value: "acme",
        screenPath: "form:x > input:org",
        container: "form:x",
      }),
    ];
    h.visibleText = "Org";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(obs.screen).toBeUndefined();
    expect(obs.accessibility).toBeUndefined();
    expect(obs.elements_total).toBe(1);
    // Compact wire carries the element set as the columnar el_table (Phase 4).
    const e = parseElementsTable(obs.el_table!)[0]!;
    const bag = e as unknown as Record<string, unknown>;
    expect(bag.value).toBeUndefined();
    expect(e.value_len).toBe(4);
    expect(bag.container).toBeUndefined();
    // path is now dropped from the default payload (retained only in the
    // persisted snapshot file, whose path the response carries).
    expect("path" in e).toBe(false);
    expect(typeof obs.snapshot_file).toBe("string");
  });

  it("operate_observe detail:'full' restores the screen + accessibility views", async () => {
    h.elements = [
      elem({
        tag: "button",
        visibleText: "Go",
        screenPath: "main:x > button:go",
        container: "main:x",
      }),
    ];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const full = await observe(obs.session_id, "full");
    expect(full.screen).toBeDefined();
    expect(full.accessibility).toBeDefined();
  });

  it("operate_act detail:'none' returns a minimal ack (no perception)", async () => {
    h.elements = [elem({ tag: "button", visibleText: "Go", screenPath: "main:x > button:go" })];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const ack = await act(obs.session_id, { kind: "scroll", direction: "down" }, "none");
    expect(ack.observed).toBe("none");
    expect(ack.elements).toEqual([]);
    expect(ack.screen).toBeUndefined();
  });

  it("operate_act detail:'full' returns the legacy payload", async () => {
    h.elements = [
      elem({
        tag: "button",
        visibleText: "Go",
        screenPath: "main:x > button:go",
        container: "main:x",
      }),
    ];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const full = await act(obs.session_id, { kind: "scroll", direction: "down" }, "full");
    expect(full.screen).toBeDefined();
    expect(full.accessibility).toBeDefined();
  });
});

describe("withSigninHost (operate_store_login — cover the sign-in page's host)", () => {
  it("folds the signin_url host into login_hosts (the Plunk browser-fill 403)", () => {
    // Agent stored the apex, but the login form lives on app.<domain> — the
    // signin_url host must be a valid fill target.
    expect(withSigninHost(["useplunk.com"], "https://app.useplunk.com/login")).toEqual([
      "useplunk.com",
      "app.useplunk.com",
    ]);
  });
  it("does not duplicate an already-listed host, strips www, no-ops without a signin_url", () => {
    expect(withSigninHost(["app.useplunk.com"], "https://app.useplunk.com/login")).toEqual([
      "app.useplunk.com",
    ]);
    expect(withSigninHost(["x.com"], "https://www.x.com/login")).toEqual(["x.com"]);
    expect(withSigninHost(["x.com"], undefined)).toEqual(["x.com"]);
    expect(withSigninHost(["x.com"], "not a url")).toEqual(["x.com"]);
  });
});

// operator-frame-support — the frame boundary must stay load-bearing for
// security: a weak model can reach content inside iframes without reasoning
// about frames, but an action on a frame element must never skip the SAME
// domain-scope check a main-frame goto already gets. The page's own eTLD+1
// (here "example.com", from serviceUrl "https://shop.example.com/cart") is
// freely reachable via any subdomain (a merchant's own checkout iframe,
// possibly on a different subdomain than the page); a genuinely unrelated
// domain is refused exactly like an off-domain goto.
describe("frame targets — domain-lock (operator-frame-support)", () => {
  const SAME_DOMAIN_FRAME_URL = "https://payments.example.com/widget";
  const CROSS_DOMAIN_FRAME_URL = "https://evil-payments.test/widget";

  it("el_table tags a frame element with its own frame_origin (observe surfaces iframe content)", async () => {
    h.elements = [
      elem({
        testId: "ship-standard",
        labelText: "Standard Shipping",
        selector: "#ship-standard",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = parseElementsTable(started.el_table ?? "");
    const row = rows.find((r) => r.label === "Standard Shipping");
    expect(row?.frame_origin).toBe("https://payments.example.com");
  });

  it("main-frame elements are unaffected — no frame_origin column noise (regression)", async () => {
    h.elements = [elem({ testId: "go", labelText: "Continue", selector: "#go" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = parseElementsTable(started.el_table ?? "");
    const row = rows.find((r) => r.label === "Continue");
    expect(row?.frame_origin).toBeUndefined();
  });

  it("click on a same-registrable-domain iframe element succeeds (the merchant's own checkout widget)", async () => {
    h.elements = [
      elem({
        testId: "ship-standard",
        labelText: "Standard Shipping",
        selector: "#ship-standard",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "click", target: "Standard Shipping" });
    expect(h.frameClicks).toEqual([`${SAME_DOMAIN_FRAME_URL}|#ship-standard`]);
    expect(h.clickCalls).toBe(0); // never fell through to the main-frame click
  });

  it("click on a cross-domain iframe element is refused, exactly like an off-domain goto", async () => {
    h.elements = [
      elem({
        testId: "card-input",
        labelText: "Enter Card Number",
        selector: "#card-input",
        frameUrl: CROSS_DOMAIN_FRAME_URL,
        frameOrigin: "https://evil-payments.test",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "click", target: "Enter Card Number" }),
    ).rejects.toThrow(/blocked by domain-scope/i);
    expect(h.frameClicks).toEqual([]);
    expect(h.clickCalls).toBe(0);
  });

  it("type into a same-registrable-domain iframe element succeeds", async () => {
    h.elements = [
      elem({
        testId: "promo",
        labelText: "Promo Code",
        selector: "#promo",
        value: "",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "type", target: "Promo Code", text: "SAVE10" });
    expect(h.frameTypes).toEqual([
      { frameUrl: SAME_DOMAIN_FRAME_URL, selector: "#promo", text: "SAVE10" },
    ]);
    expect(h.typed).toEqual([]); // never fell through to the main-frame type
  });

  it("type_secret into a cross-origin frame is refused (the one non-negotiable)", async () => {
    h.elements = [
      elem({
        testId: "card-cvv",
        labelText: "CVV",
        selector: "#cvv",
        frameUrl: CROSS_DOMAIN_FRAME_URL,
        frameOrigin: "https://evil-payments.test",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await expect(
      act(started.session_id, { kind: "type_secret", slot: "login", target: "CVV" }),
    ).rejects.toThrow(/type_secret refused/i);
    expect(h.frameTypes).toEqual([]);
    expect(h.typed).toEqual([]);
  });

  it("refuses actions and secrets in an opaque frame with a terminal message — never the allow_host remedy, which can't satisfy a null origin", async () => {
    h.elements = [
      elem({
        testId: "sandbox-password",
        labelText: "Sandbox Password",
        selector: "#password",
        frameUrl: "about:srcdoc",
        frameOrigin: "null",
        frameOpaque: true,
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const clickError = await act(started.session_id, {
      kind: "click",
      target: "Sandbox Password",
    }).catch((cause: unknown) => cause);
    expect(clickError).toBeInstanceOf(Error);
    expect((clickError as Error).message).toMatch(/opaque/i);
    expect((clickError as Error).message).not.toMatch(/allow_host/);
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await expect(
      act(started.session_id, {
        kind: "type_secret",
        slot: "login",
        target: "Sandbox Password",
      }),
    ).rejects.toThrow(/opaque frame/i);
    expect(h.frameClicks).toEqual([]);
    expect(h.frameTypes).toEqual([]);
  });

  it("type_secret is refused for a sandboxed frame tagged opaque even when its URL is the page's own domain (nonblank-sandbox-origin-bypass)", async () => {
    h.elements = [
      elem({
        testId: "sandboxed-password",
        labelText: "Password",
        selector: "#password",
        // A sandbox="allow-scripts" iframe keeps its real URL but has a null
        // active origin — extraction tags it frameOpaque; the guard must key
        // on that tag, never the URL.
        frameUrl: "https://shop.example.com/embedded-login",
        frameOrigin: "null",
        frameOpaque: true,
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await expect(
      act(started.session_id, { kind: "type_secret", slot: "login", target: "Password" }),
    ).rejects.toThrow(/opaque frame/i);
    expect(h.frameTypes).toEqual([]);
    expect(h.typed).toEqual([]);
  });

  it("type_secret into a same-registrable-domain frame is allowed", async () => {
    h.elements = [
      elem({
        testId: "login-password",
        labelText: "Password",
        selector: "#password",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await act(started.session_id, { kind: "type_secret", slot: "login", target: "Password" });
    expect(h.frameTypes).toEqual([
      { frameUrl: SAME_DOMAIN_FRAME_URL, selector: "#password", text: "s3cr3t-value" },
    ]);
  });

  it("select on a same-registrable-domain iframe element succeeds through selectInFrame (the Rakuten-class checkout dropdown)", async () => {
    h.elements = [
      elem({
        tag: "select",
        testId: "ship-method",
        labelText: "Shipping Method",
        selector: "#ship-method",
        selectOptions: [
          { value: "", text: "Choose…" },
          { value: "std", text: "Standard" },
        ],
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await act(started.session_id, { kind: "select", target: "Shipping Method", text: "Standard" });
    expect(h.frameSelects).toEqual([
      { frameUrl: SAME_DOMAIN_FRAME_URL, selector: "#ship-method", matcher: "Standard" },
    ]);
    expect(h.selected).toEqual([]); // never fell through to the main-frame select
  });

  it("select on a cross-domain iframe element is refused by the domain lock, exactly like an off-domain goto", async () => {
    h.elements = [
      elem({
        tag: "select",
        testId: "card-exp",
        labelText: "Expiry Month",
        selector: "#card-exp",
        selectOptions: [{ value: "01", text: "January" }],
        frameUrl: CROSS_DOMAIN_FRAME_URL,
        frameOrigin: "https://evil-payments.test",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "select", target: "Expiry Month", text: "January" }),
    ).rejects.toThrow(/blocked by domain-scope/i);
    expect(h.frameSelects).toEqual([]);
    expect(h.selected).toEqual([]);
  });

  it("upload/oauth_click on a frame target are still refused explicitly, not silently mis-targeted", async () => {
    h.elements = [
      elem({
        tag: "input",
        type: "file",
        testId: "avatar",
        labelText: "Avatar",
        selector: "#avatar",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
      elem({
        tag: "button",
        testId: "oauth-google",
        labelText: "Continue with Google",
        selector: "#oauth-google",
        frameUrl: SAME_DOMAIN_FRAME_URL,
        frameOrigin: "https://payments.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    await expect(
      act(started.session_id, { kind: "upload", target: "Avatar", path: "/tmp/a.png" }),
    ).rejects.toThrow(/does not yet support a target inside an <iframe>/i);
    await expect(
      act(started.session_id, { kind: "oauth_click", target: "Continue with Google" }),
    ).rejects.toThrow(/does not yet support a target inside an <iframe>/i);
    expect(h.uploads).toEqual([]);
  });

  it("preserves frame scope through recording and re-gates it during replay", async () => {
    const main = elem({
      testId: "continue",
      labelText: "Continue",
      selector: "#continue",
    }) as Record<string, unknown>;
    const framed = elem({
      testId: "continue",
      labelText: "Continue",
      selector: "#continue",
      frameUrl: CROSS_DOMAIN_FRAME_URL,
      frameOrigin: "https://evil-payments.test",
      framePath: "0",
    }) as Record<string, unknown>;
    h.elements = [main, framed];
    const target = recipeTargetFor(framed as never, h.elements as never);
    expect(target).toMatchObject({
      css: "#continue",
      frame_origin: "https://evil-payments.test",
      frame_path: "0",
    });
    expect(captureObserved({ kind: "click", target: "Continue" }, framed as never)).toMatchObject({
      selector: "#continue",
      frame_origin: "https://evil-payments.test",
      frame_path: "0",
    });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({ trace: [{ action: { kind: "click", target } }] }),
      {},
    );
    expect(result.status).not.toBe("complete");
    expect(h.frameClicks).toEqual([]);
    expect(h.clickCalls).toBe(0);
  });
});

// ── Pending card-fill charge guard (split checkout) ─────────────────────────
//
// After operate_pay {phase:"fill_card"} the vaulted card sits filled in the
// page, so the ONLY sanctioned path to the charge is operate_pay
// {phase:"confirm"} (which verifies the live total first). A weak model must
// not be able to fire the charge itself through operate_act.
describe("pending card-fill charge guard", () => {
  const pending = {
    approval_id: "appr_guard",
    approval_url: "https://web.test/vault/pay/appr_guard",
    checkout: {
      merchant: "Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 100,
      currency: "USD",
    },
    card_ref: "card_guard",
    last4: "4242",
  };

  it("tracks pending, confirming, and submit-started states distinctly", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    setActivePendingCardFill(pending);

    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/phase="confirm"/);
    expect(claimActivePaymentForOperatePay("confirm")).toEqual({ kind: "confirm", pending });
    expect(() => claimActivePaymentForOperatePay("confirm")).toThrow(/already in progress/);
    expect(restoreActivePendingCardFillAfterConfirmThrow(pending)).toBe(true);

    expect(claimActivePaymentForOperatePay("confirm")).toEqual({ kind: "confirm", pending });
    markActivePendingCardFillSubmitStarted();
    expect(restoreActivePendingCardFillAfterConfirmThrow(pending)).toBe(false);
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/already in progress/);
  });

  it("locks charge actions for the full fill-card lease", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const claim = claimActivePaymentForOperatePay("fill_card");

    expect(claim.kind).toBe("lease");
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/already in progress/);
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /operate_pay/,
    );

    if (claim.kind !== "lease") throw new Error("expected fill-card payment lease");
    expect(releaseActivePaymentLease(claim.lease, true)).toBe(true);
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);
  });

  it("serializes fill-card behind every other payment lease", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay(undefined);
    if (claim.kind !== "lease") throw new Error("expected payment lease");

    expect(() => claimActivePaymentForOperatePay("fill_card")).toThrow(/already in progress/);
    expect(releaseActivePaymentLease(claim.lease)).toBe(true);
  });

  it("transitions a successful fill-card lease to pending confirmation", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay("fill_card");
    if (claim.kind !== "lease") throw new Error("expected fill-card payment lease");

    completeActivePaymentLeaseWithPendingFill(claim.lease, pending);
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/phase="confirm"/);
    expect(claimActivePaymentForOperatePay("confirm")).toEqual({ kind: "confirm", pending });
  });

  it("retains the payment lock when fill-card cleanup is unverified", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay("fill_card");
    if (claim.kind !== "lease") throw new Error("expected fill-card payment lease");

    expect(releaseActivePaymentLease(claim.lease, false)).toBe(true);
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/cleanup remains unverified/);
  });

  it("refuses charge-verb clicks and Enter while filled, frees them after confirm clears", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
      elem({ tag: "button", type: null, visibleText: "Continue to review", selector: "#next" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /operate_pay \{phase:"confirm"\}/,
    );
    await expect(
      act(started.session_id, { kind: "js_click", target: "Place order" }),
    ).rejects.toThrow(/operate_pay \{phase:"confirm"\}/);
    // oauth_click clicks too — it must not be a side door to the charge.
    await expect(
      act(started.session_id, { kind: "oauth_click", target: "Place order" }),
    ).rejects.toThrow(/operate_pay \{phase:"confirm"\}/);
    expect(h.clickCalls).toBe(0);

    // Between-step navigation stays free — that's how the host reaches the
    // confirmation page at all.
    await act(started.session_id, { kind: "click", target: "Continue to review" });
    expect(h.clickCalls).toBe(1);

    // Enter fires the form's default submit → refused; other keys pass.
    await expect(act(started.session_id, { kind: "press", key: "Enter" })).rejects.toThrow(
      /operate_pay/,
    );
    await expect(act(started.session_id, { kind: "press", key: "NumpadEnter" })).rejects.toThrow(
      /operate_pay/,
    );
    h.focusedLabels = ["Pay now"];
    await expect(act(started.session_id, { kind: "press", key: "Space" })).rejects.toThrow(
      /operate_pay/,
    );
    h.focusedLabels = ["Continue to review"];
    await act(started.session_id, { kind: "press", key: "Space" });
    await act(started.session_id, { kind: "press", key: "Tab" });

    // Once confirm consumes the fill, the ordinary rules return.
    clearActivePendingCardFill();
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(2);
  });

  it("refuses a locator-fallback click on a charge control while filled", async () => {
    h.locatorResolve = {
      ok: true,
      text: "",
      labels: ["Pay now"],
      safetySignals: { billingObject: false, accountSetup: false },
    };
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    await expect(
      act(started.session_id, { kind: "click", target: "text=Pay now" }),
    ).rejects.toThrow(/operate_pay \{phase:"confirm"\}/);
    expect(h.locatorClickCalls).toBe(0);
  });

  it("masks re-rendered payment fields while a fill remains pending", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);
    h.elements = [
      elem({
        id: "card-number",
        autocomplete: "cc-number",
        selector: "#card-number",
        value: "4242424242424242",
      }),
      elem({
        id: "security-code",
        autocomplete: "cc-csc",
        selector: "#security-code",
        value: "123",
      }),
    ];
    h.visibleText =
      "Card preview 4242·4242·4242·4242, 4242.4242.4242.4242, 4242|4242|4242|4242, 4242×4242×4242×4242, and 4242∙4242∙4242∙4242 · CVV 123";

    const full = await observe(started.session_id, "full");
    expect(JSON.stringify(full)).not.toContain("4242424242424242");
    expect(JSON.stringify(full)).not.toContain("4242·4242·4242·4242");
    expect(JSON.stringify(full)).not.toContain("4242.4242.4242.4242");
    expect(JSON.stringify(full)).not.toContain("4242|4242|4242|4242");
    expect(JSON.stringify(full)).not.toContain("4242×4242×4242×4242");
    expect(JSON.stringify(full)).not.toContain("4242∙4242∙4242∙4242");
    expect(JSON.stringify(full)).not.toContain('"123"');
    expect(full.text).toBe(
      "Card preview [sealed payment], [sealed payment], [sealed payment], [sealed payment], and [sealed payment] · CVV [sealed payment]",
    );
    expect(full.elements?.map((element) => element.value)).toEqual(["[sealed]", "[sealed]"]);
  });

  it("masks multiline PAN previews without a surviving payment input", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);
    h.elements = [];
    h.visibleText = "Card preview 4242\n4242\n4242\n4242";

    const full = await observe(started.session_id, "full");
    expect(full.text).toBe("Card preview [sealed payment]");
    expect(JSON.stringify(full)).not.toContain("4242");
  });

  it("masks card material in all host-facing interactive metadata", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);
    const pan = "4242|4242|4242|4242";
    h.elements = [
      elem({ index: 0, tag: "button", ariaLabel: `Card ${pan}`, selector: "#aria" }),
      elem({ index: 1, tag: "button", title: `Card ${pan}`, selector: "#title" }),
      elem({ index: 2, tag: "button", labelText: `Card ${pan}`, selector: "#label" }),
      elem({ index: 3, tag: "button", iconLabel: `Card ${pan}`, selector: "#icon" }),
      elem({ index: 4, tag: "input", placeholder: `Card ${pan}`, selector: "#placeholder" }),
      elem({ index: 5, tag: "button", value: pan, selector: "#value" }),
      elem({ index: 6, tag: "button", ariaLabel: "CVV 123", selector: "#cvv" }),
      elem({ index: 7, tag: "button", visibleText: `Card ${pan}`, selector: "#visible" }),
      elem({ index: 8, tag: "input", name: `Card ${pan}`, selector: "#name" }),
      elem({
        index: 9,
        tag: "button",
        visibleText: "Preview",
        href: `https://shop.example.com/card/${pan}`,
        testId: `card-${pan}`,
        screenPath: `main:Card ${pan} > button:preview`,
        container: `main:Card ${pan}`,
        topmost: false,
        occludedBy: `Card ${pan}`,
        selector: "#metadata",
      }),
    ];

    const compact = await observe(started.session_id, "compact");
    const compactJson = JSON.stringify(compact);
    expect(compactJson).not.toContain("4242");
    expect(compactJson).not.toContain("CVV 123");
    expect(readFileSync(compact.snapshot_file!, "utf8")).not.toMatch(/4242|CVV 123/);

    const full = await observe(started.session_id, "full");
    expect(JSON.stringify(full)).not.toMatch(/4242|CVV 123/);
  });

  it("keeps masking and charge locking after retry state is cleared without DOM cleanup", async () => {
    h.elements = [
      elem({
        id: "card-number",
        autocomplete: "cc-number",
        selector: "#card-number",
        value: "4242424242424242",
      }),
      elem({ tag: "button", visibleText: "Place order", selector: "#place-order" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);
    retainActivePaymentFieldSeal();

    const full = await observe(started.session_id, "full");
    expect(JSON.stringify(full)).not.toContain("4242424242424242");
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /operate_pay/,
    );

    clearActivePendingCardFill(true);
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);
  });
});

// [P0] The non-blocking approval rest state: operate_pay no longer holds the
// "operating" lease across a human's phone tap, so a new state exists for
// "the human hasn't responded yet." A later call resumes it (idempotent —
// never a duplicate approval) instead of throwing "already in progress".
describe("awaiting-approval payment lease [P0]", () => {
  const approvalState = {
    approval_id: "appr_wait",
    approval_url: "https://web.test/vault/pay/appr_wait",
    nonce: "n",
    agent: "a",
    checkout: {
      merchant: "Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 100,
      currency: "USD",
    },
    jit: false,
    boundCardRef: "card_wait",
    deadline: Date.now() + 60_000,
    rejectedCandidates: [],
    keypair: { publicKey: "pub", privateKey: "priv" },
    item: "Widget",
    reason: "test",
    cardRef: "card_wait",
  };

  it("transitions operating -> awaiting_approval, then resumes it on the next call", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay(undefined);
    if (claim.kind !== "lease") throw new Error("expected a fresh lease");
    expect(claim.resumeApproval).toBeUndefined();
    expect(getActivePendingApproval()).toBeNull();

    completeActivePaymentLeaseWithPendingApproval(claim.lease, approvalState);
    expect(getActivePendingApproval()).toEqual(approvalState);

    // A later call (re-initiation after the host's own timeout, or a retry)
    // resumes the SAME approval instead of throwing "already in progress" —
    // this is what makes idempotent re-initiation possible.
    const resumed = claimActivePaymentForOperatePay(undefined);
    expect(resumed).toMatchObject({ kind: "lease", resumeApproval: approvalState });
  });

  it('refuses phase="confirm" while still awaiting approval — no card has been filled yet', async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay("fill_card");
    if (claim.kind !== "lease") throw new Error("expected a fresh lease");
    completeActivePaymentLeaseWithPendingApproval(claim.lease, approvalState);

    expect(claimActivePaymentForOperatePay("confirm")).toEqual({ kind: "missing_confirm" });
  });

  it("clears back to null once a resumed wait is released — no stale resume data survives", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const first = claimActivePaymentForOperatePay(undefined);
    if (first.kind !== "lease") throw new Error("expected a fresh lease");
    completeActivePaymentLeaseWithPendingApproval(first.lease, approvalState);

    const resumed = claimActivePaymentForOperatePay(undefined);
    if (resumed.kind !== "lease") throw new Error("expected a resumed lease");
    expect(releaseActivePaymentLease(resumed.lease, true)).toBe(true);
    expect(getActivePendingApproval()).toBeNull();

    const fresh = claimActivePaymentForOperatePay(undefined);
    expect(fresh).toMatchObject({ kind: "lease" });
    expect((fresh as { resumeApproval?: unknown }).resumeApproval).toBeUndefined();
  });

  it("serializes a resume attempt behind another in-flight call, same as a fresh lease", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const claim = claimActivePaymentForOperatePay(undefined);
    if (claim.kind !== "lease") throw new Error("expected a fresh lease");
    completeActivePaymentLeaseWithPendingApproval(claim.lease, approvalState);

    const resumed = claimActivePaymentForOperatePay(undefined);
    if (resumed.kind !== "lease") throw new Error("expected a resumed lease");
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/already in progress/);
    expect(releaseActivePaymentLease(resumed.lease, true)).toBe(true);
  });
});

describe("fill_card cart-total carry-forward (Session.lastCartCheckout)", () => {
  it("returns legible post-add cart state and suppresses a retry for the same line", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 0 Subtotal 968円 Shipping Free Total 968円";
    h.elements = [
      elem({ name: "quantity", labelText: "Quantity", selector: "#qty", value: "0" }),
    ];
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 968,
      currency: "JPY",
    };
    h.clickValueMutation = { selector: "#qty", value: "1" };
    h.cartLineItemsAfterClick = [{
      title: "Tiara",
      quantity: 1,
      product_identities: ["sku:tiara"],
      option_signatures: ["size=M"],
    }];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const added = await cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-1");

    expect(added).toMatchObject({
      status: "added",
      cart_delta: "+1",
      cart_url: "https://shop.example.com/cart",
      checkout_state: {
        stage: "cart",
        product_identity: "sku:tiara",
        options_hash: "size=M",
        quantity: 1,
        subtotal: { amount_cents: 968, currency: "JPY" },
        shipping: { amount_cents: 0, currency: "JPY" },
        payable_total: { amount_cents: 968, currency: "JPY" },
        next_action: { tool: "operate_act", kind: "click", intent: "proceed_to_checkout" },
      },
    });
    expect(h.locatorClickCalls).toBe(1);

    const retried = await cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-1");
    expect(retried).toMatchObject({ status: "already_in_cart", cart_delta: "0" });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("shares an atomic reservation across concurrent retries", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 1 Total 968円";
    h.elements = [elem({ name: "quantity", labelText: "Quantity", selector: "#qty", value: "1" })];
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 968,
      currency: "JPY",
    };
    h.cartLineItemsAfterClick = [{
      title: "Tiara",
      quantity: 1,
      product_identities: ["sku:tiara"],
      option_signatures: ["size=M"],
    }];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const [first, second] = await Promise.all([
      cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-concurrent"),
      cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-concurrent"),
    ]);

    expect(first.status).toBe("added");
    expect(second).toMatchObject({ status: "already_in_cart", cart_delta: "0" });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("reconciles the requested line after post-click observation failure", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 1 Total 968円";
    h.elements = [elem({ name: "quantity", labelText: "Quantity", selector: "#qty", value: "1" })];
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 968,
      currency: "JPY",
    };
    h.cartLineItemsAfterClick = [{
      title: "Tiara",
      quantity: 1,
      product_identities: ["sku:tiara"],
      option_signatures: ["size=M"],
    }];
    h.failNextCartLineReadAfterClick = true;
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    await expect(
      cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-reconcile"),
    ).rejects.toThrow("cart line observation failed");
    await expect(
      cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-reconcile"),
    ).resolves.toMatchObject({ status: "already_in_cart", cart_delta: "0" });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("does not infer checkout stage from ordinary body copy", async () => {
    h.currentUrl = "https://shop.example.com/products/checkout-tote";
    h.visibleText = "Add to Cart. We accept many payment methods.";
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state).toBeUndefined();
  });

  it("reports independently labeled money components", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Subtotal $10.00 Shipping $5.00 Total $15.00";
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 1_500,
      currency: "USD",
    };
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state).toMatchObject({
      subtotal: { amount_cents: 1_000, currency: "USD" },
      shipping: { amount_cents: 500, currency: "USD" },
      payable_total: { amount_cents: 1_500, currency: "USD" },
    });
  });

  it("keeps a labeled shipping charge authoritative over promotional copy", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText =
      "Free shipping on orders over $50. Subtotal $10.00 Shipping $5.00 Total $15.00";
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 1_500,
      currency: "USD",
    };
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state?.shipping).toEqual({ amount_cents: 500, currency: "USD" });
  });

  it("resolves a cart drawer to its canonical cart link", async () => {
    h.currentUrl = "https://shop.example.com/products/tiara";
    h.visibleText = "Mini cart";
    h.elements = [
      elem({
        tag: "a",
        selector: "#view-cart",
        visibleText: "View cart",
        href: "/cart",
        container: "cart drawer",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state).toMatchObject({
      stage: "cart",
      cart_url: "https://shop.example.com/cart",
    });
  });

  it("does not carry money or cart URLs across origins", async () => {
    h.currentUrl = "https://merchant-a.example/cart";
    h.visibleText = "Total $15.00";
    h.checkoutSummary = {
      merchant: "Merchant A",
      checkout_origin: "https://merchant-a.example",
      amount_cents: 1_500,
      currency: "USD",
    };
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });
    await observe(started.session_id, "compact");
    h.currentUrl = "https://merchant-b.example/cart";
    h.checkoutSummary = null;

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state).toMatchObject({
      payable_total: null,
      cart_url: "https://merchant-b.example/cart",
    });
  });

  it("requires and emits identity for generic quantity controls", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 1";
    h.elements = [
      elem({
        selector: "#increase",
        role: "button",
        visibleText: "+",
        ariaLabel: "Increase quantity",
        container: "cart item Tiara size M",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    await expect(act(started.session_id, { kind: "click", target: "Increase quantity" }))
      .rejects.toThrow("requires product_identity and options_hash");
    const observed = await act(
      started.session_id,
      { kind: "click", target: "Increase quantity" },
      "compact",
      { productIdentity: "sku:tiara", optionsHash: "size=M" },
    );

    expect(observed.checkout_state).toMatchObject({
      product_identity: "sku:tiara",
      options_hash: "size=M",
    });
  });

  it("binds row-scoped remove controls before dispatch", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Tiara size M";
    h.elements = [
      elem({
        selector: "#remove-tiara",
        role: "button",
        visibleText: "Remove",
        container: "cart item Tiara size M",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    await expect(act(started.session_id, { kind: "click", target: "Remove" }))
      .rejects.toThrow("requires product_identity and options_hash");
    expect(h.clickCalls).toBe(0);
    const observed = await act(
      started.session_id,
      { kind: "click", target: "Remove" },
      "compact",
      { productIdentity: "sku:tiara", optionsHash: "size=M" },
    );

    expect(observed).toMatchObject({
      cart_delta: "unknown",
      checkout_state: {
        product_identity: "sku:tiara",
        options_hash: "size=M",
      },
    });
  });

  it("captures a real total observed on an earlier page and serves it for the SAME origin", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://cart.step.rakuten.co.jp/cart",
    });
    h.checkoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://cart.step.rakuten.co.jp",
      amount_cents: 2_904,
      currency: "JPY",
    };
    await observe(started.session_id, "compact");

    expect(activeCartCheckoutForOrigin("https://cart.step.rakuten.co.jp")).toEqual({
      checkout: h.checkoutSummary,
      url: "https://cart.step.rakuten.co.jp/cart",
      observedAt: expect.any(Number),
    });
  });

  it("never serves a cached total to a DIFFERENT origin", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://cart.step.rakuten.co.jp/cart",
    });
    h.checkoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://cart.step.rakuten.co.jp",
      amount_cents: 2_904,
      currency: "JPY",
    };
    await observe(started.session_id, "compact");

    expect(activeCartCheckoutForOrigin("https://evil.example.test")).toBeNull();
  });

  it("leaves the cache untouched when a later page has no readable total (e.g. the card-entry step)", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://cart.step.rakuten.co.jp/cart",
    });
    h.checkoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://cart.step.rakuten.co.jp",
      amount_cents: 2_904,
      currency: "JPY",
    };
    await observe(started.session_id, "compact");

    // Navigate to the card-entry step: same origin, but no total on the page.
    h.currentUrl = "https://cart.step.rakuten.co.jp/payment";
    h.checkoutSummary = null;
    await observe(started.session_id, "compact");

    expect(activeCartCheckoutForOrigin("https://cart.step.rakuten.co.jp")).toEqual({
      checkout: {
        merchant: "Rakuten",
        checkout_origin: "https://cart.step.rakuten.co.jp",
        amount_cents: 2_904,
        currency: "JPY",
      },
      url: "https://cart.step.rakuten.co.jp/cart",
      observedAt: expect.any(Number),
    });
  });

  it("replaces (never accumulates) the cache on each subsequent successful capture", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://cart.step.rakuten.co.jp/cart",
    });
    h.checkoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://cart.step.rakuten.co.jp",
      amount_cents: 1_936,
      currency: "JPY",
    };
    await observe(started.session_id, "compact");
    h.checkoutSummary = {
      merchant: "Rakuten",
      checkout_origin: "https://cart.step.rakuten.co.jp",
      amount_cents: 3_872,
      currency: "JPY",
    };
    await observe(started.session_id, "compact");

    expect(activeCartCheckoutForOrigin("https://cart.step.rakuten.co.jp")).toMatchObject({
      checkout: { amount_cents: 3_872 },
      url: "https://cart.step.rakuten.co.jp/cart",
    });
  });

  it("returns null when this session never observed a page with a readable total", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://cart.step.rakuten.co.jp/payment",
    });
    await observe(started.session_id, "compact");

    expect(activeCartCheckoutForOrigin("https://cart.step.rakuten.co.jp")).toBeNull();
  });
});
