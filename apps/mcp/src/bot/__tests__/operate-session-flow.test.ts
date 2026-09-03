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
import type * as ProfileModule from "../profile.js";

const h = vi.hoisted(() => ({
  providers: ["google"] as string[] | null,
  oauthStatus: "already_valid" as string,
  oauthLoginCalls: [] as string[],
  oauthLoginTimeouts: [] as number[],
  oauthLoginError: null as Error | null,
  oauthConsentProviders: [] as Array<string | undefined>,
  oauthExpectedGoogleAccountEmails: [] as Array<string | null | undefined>,
  oauthLoginGates: new Map<number, Promise<void>>(),
  waitForInteractiveDomCalls: [] as Array<{ minElements: number; timeoutMs: number }>,
  oauthResultUrl: "https://app.example.com/dashboard",
  restoredStorageStates: [] as Array<{ browserIndex: number; state: unknown }>,
  restoreStorageStateGate: null as Promise<void> | null,
  oauthReadError: null as string | null,
  oauthTransition: null as null | {
    productUrl: string | null;
    providerPageClosed: boolean;
    productPageViable: boolean;
    browserConnected: boolean;
  },
  oauthRecoveryCalls: 0,
  typed: [] as Array<{ selector: string; text: string; sealed?: true }>,
  uploads: [] as Array<{ selector: string; filePath: string }>,
  selected: [] as Array<{ selector: string; matcher: string | undefined }>,
  selectError: null as Error | null,
  selectMutation: null as unknown[] | null,
  phoneCountries: [] as string[],
  phoneCountry: null as string | null,
  clearElementsOnClick: false,
  clickValueMutation: null as { selector: string; value: string } | null,
  clickPhoneCountryMutation: null as string | null,
  trackedClickFailure: null as null | {
    dispatchStatus: "not_dispatched" | "dispatched" | "unknown";
    message: string;
  },
  autocompleteSuggestions: [] as string[],
  autocompleteCommitMutation: null as { selector: string; value: string } | null,
  shippingMethodsLoadOnAutocompleteCommit: false,
  shippingMethodsLoaded: false,
  requiredShippingAddressCommits: [] as string[],
  autocompleteCommitCalls: [] as number[],
  autocompleteConfirmOverride: null as boolean | null,
  autocompleteConfirmCalls: [] as Array<{ selector: string; pickedText: string }>,
  autocompleteDiscardCalls: 0,
  autocompleteDiscardEscapeCalls: [] as boolean[],
  clickCalls: 0,
  clickError: null as Error | null,
  frameClicks: [] as string[],
  frameJsClicks: [] as string[],
  frameTypes: [] as Array<{ frameUrl: string; selector: string; text: string; sealed?: true }>,
  frameSelects: [] as Array<{ frameUrl: string; selector: string; matcher: string | undefined }>,
  gotos: [] as string[],
  started: 0,
  startCalls: 0,
  startGate: null as Promise<void> | null,
  startGates: new Map<number, Promise<void>>(),
  closeCalls: 0,
  forceCloseCalls: 0,
  closeState: "closed" as "closed" | "force_closed_unproven" | "unknown",
  closeStates: new Map<number, "closed" | "force_closed_unproven" | "unknown">(),
  closeGates: new Map<number, Promise<void>>(),
  profileProbeCalls: 0,
  controllerProviderProbeCalls: 0,
  workerEmail: null as string | null,
  liveGoogleEmail: "default-google@example.com" as string | null,
  identityProbeCalls: 0,
  identityProbeExpectedGoogleAccountEmails: [] as Array<string | undefined>,
  googleIdentityByExpectedEmail: new Map<string, string | null>(),
  temporaryHostScopes: [] as Array<{ hosts: string[]; phase: "enter" | "exit" }>,
  hostScopeProviders: [] as Array<{
    allowedHosts: () => readonly string[];
    siblingDomainHosts: () => readonly string[];
  }>,
  connections: [] as boolean[],
  profileDirs: [] as Array<string | undefined>,
  proxyUrls: [] as Array<string | undefined>,
  seededStorageStates: [] as unknown[],
  storageStates: new Map<string, unknown>(),
  identityMetadata: new Map<string, { googleAccountEmail: string }>(),
  storageStateReads: [] as string[],
  storageStateReadGate: null as Promise<void> | null,
  storageStateWrites: [] as Array<{ profileDir: string; state: unknown }>,
  pendingStorageStates: [] as Array<{ path: string; profileDir: string; state: unknown }>,
  pendingStorageStateOversized: false,
  storageStateWriteError: null as Error | null,
  storageStateWriteGate: null as Promise<void> | null,
  storageStateWriteAttempts: 0,
  profileDestroyGate: null as Promise<void> | null,
  profileOperationProbeGate: null as Promise<void> | null,
  ephemeralSerial: 0,
  createdProfiles: [] as string[],
  destroyedProfiles: [] as string[],
  captureStorageState: { cookies: [], origins: [] } as unknown,
  captureStorageStates: new Map<number, unknown>(),
  captureStorageStateSequences: new Map<number, unknown[]>(),
  captureStorageStateCalls: 0,
  captureStorageStateGate: null as Promise<void> | null,
  captureStorageStateError: null as Error | null,
  currentUrl: "",
  mainDocumentEpoch: 0,
  elements: [] as unknown[],
  extractInteractiveElementsCalls: 0,
  checkoutFieldNames: [] as string[],
  visibleText: "",
  visibleTextGate: null as Promise<void> | null,
  extractVisibleTextCalls: 0,
  openFirstMailResult: false,
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
  locatorResolveMissValues: [] as string[],
  locatorClickCalls: 0,
  locatorTypeCalls: [] as Array<{ text: string; sealed: boolean }>,
  capturedSealedFieldKeys: [] as string[][],
  capturedRedactionOptions: [] as unknown[],
  locatorResolveIntents: [] as string[],
  locatorDisposeCalls: 0,
  isPayPalHostedCheckout: false,
  filledCards: [] as unknown[],
  fillAndSubmitError: null as Error | null,
  fillAndSubmitResult: { three_ds_required: false, order_confirmed: true } as {
    three_ds_required: boolean;
    order_confirmed: boolean;
    challenge_url?: string;
  },
  clearSealedPaymentFieldsCalls: 0,
  waitForThreeDsResult: "timeout" as "succeeded" | "failed" | "challenge_pending" | "timeout",
  waitForThreeDsCalls: [] as number[],
  paymentInstrumentMismatch: null as null | {
    kind: "payment_instrument_mismatch";
    confidence: "high" | "low";
    evidence_used: Array<"last4" | "issuer" | "network">;
    expected: { last4: string };
    observed: { last4: string };
    provenance: {
      expected: { last4: "released_card" };
      observed: "3ds_challenge";
    };
  },
}));

// This suite is the V1 contract suite. Individual Compact V2 tests opt in
// explicitly below, which keeps the feature-flagged V1 and V2 action
// protocols independently testable while V2 is the production default.
let compactV2ModeBeforeTest: string | undefined;

vi.mock("../browser.js", () => ({
  registerLocalBrowserLaunch: (
    _profileDir: string,
    baseEnv: NodeJS.ProcessEnv = process.env,
    marker = "v1:1:test-browser",
  ) => ({
    marker,
    env: { ...baseEnv, TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER: marker },
  }),
  BrowserController: class {
    private readonly index: number;
    private readonly opts: { profileDir?: string; proxyUrl?: string; storageState?: unknown };
    private readonly detached: boolean;
    private detachedUrl = "about:blank";
    constructor(opts: { profileDir?: string; proxyUrl?: string; storageState?: unknown } = {}) {
      this.index = h.connections.length;
      this.opts = opts;
      this.detached =
        this.index > 0 && opts.profileDir !== undefined && opts.profileDir !== h.profileDirs[0];
      h.connections.push(true);
      h.profileDirs.push(opts.profileDir);
      h.proxyUrls.push(opts.proxyUrl);
      h.seededStorageStates.push(opts.storageState);
    }
    async start(): Promise<void> {
      h.started += 1;
      h.startCalls += 1;
      const gate = h.startGates.get(this.index);
      if (gate !== undefined) await gate;
      if (h.startGate !== null) await h.startGate;
    }
    isConnected(): boolean {
      return h.connections[this.index] === true;
    }
    async detectSessionProviders(): Promise<string[]> {
      h.controllerProviderProbeCalls += 1;
      if (h.providers !== null) return h.providers;
      const cookies = (this.opts.storageState as { cookies?: Array<{ name: string }> } | undefined)
        ?.cookies;
      return cookies?.some((cookie) => cookie.name === "__Secure-1PSID") ? ["google"] : [];
    }
    async detectGoogleAccountEmail(expectedGoogleAccountEmail?: string): Promise<string | null> {
      h.identityProbeCalls += 1;
      h.identityProbeExpectedGoogleAccountEmails.push(expectedGoogleAccountEmail);
      if (
        expectedGoogleAccountEmail !== undefined &&
        h.googleIdentityByExpectedEmail.has(expectedGoogleAccountEmail)
      ) {
        return h.googleIdentityByExpectedEmail.get(expectedGoogleAccountEmail) ?? null;
      }
      return h.workerEmail ?? h.liveGoogleEmail;
    }
    async goto(url: string): Promise<void> {
      h.gotos.push(url);
      if (this.detached) this.detachedUrl = url;
      else {
        h.currentUrl = url;
        h.mainDocumentEpoch += 1;
      }
    }
    currentUrl(): string {
      return this.detached ? this.detachedUrl : h.currentUrl;
    }
    mainDocumentIdentity(): string {
      return String(h.mainDocumentEpoch);
    }
    recoverActivePage(): void {}
    async extractInteractiveElements(): Promise<unknown[]> {
      h.extractInteractiveElementsCalls += 1;
      if (h.oauthReadError !== null) throw new Error(h.oauthReadError);
      return h.elements;
    }
    async extractCheckoutFieldNames(): Promise<string[]> {
      return h.checkoutFieldNames;
    }
    async extractVisibleText(): Promise<string> {
      h.extractVisibleTextCalls += 1;
      if (h.visibleTextGate !== null) await h.visibleTextGate;
      if (h.oauthReadError !== null) throw new Error(h.oauthReadError);
      return h.visibleText;
    }
    async revealMaskedCredentials(): Promise<void> {}
    async extractLabeledCredentialCandidates(): Promise<unknown[]> {
      return [];
    }
    async extractAllInputValues(): Promise<string[]> {
      return [];
    }
    async extractCredentialsNearCopyButtons(): Promise<string[]> {
      return [];
    }
    async readClipboard(): Promise<string> {
      return "";
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
    async readCheckoutReviewLineItems(): Promise<
      Array<{
        title: string;
        quantity: number;
        details?: string;
        product_identities: string[];
        option_signatures: string[];
      }>
    > {
      if (h.cartLineReadFailuresRemaining > 0) {
        h.cartLineReadFailuresRemaining -= 1;
        throw new Error("cart line observation failed");
      }
      return h.cartLineItems.map((line) => ({ ...line, details: line.details ?? line.title }));
    }
    async openFirstMailResult(): Promise<boolean> {
      return h.openFirstMailResult;
    }
    async waitForInteractiveDom(minElements = 5, timeoutMs = 20_000): Promise<void> {
      h.waitForInteractiveDomCalls.push({ minElements, timeoutMs });
    }
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
    async type(selector: string, text: string, sealed = false): Promise<string[]> {
      h.typed.push({ selector, text, ...(sealed ? { sealed: true as const } : {}) });
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector === selector) element.value = text;
      }
      const element = (h.elements as Array<Record<string, unknown>>).find(
        (candidate) => candidate.selector === selector,
      );
      return sealed
        ? [element?.screenPath, element?.testId, element?.visibleText].filter(
            (key): key is string => typeof key === "string" && key.length > 0,
          )
        : [];
    }
    async commitRequiredShippingAddressLine1(selector: string): Promise<void> {
      h.requiredShippingAddressCommits.push(selector);
      if (h.shippingMethodsLoadOnAutocompleteCommit) h.shippingMethodsLoaded = true;
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
      if (h.shippingMethodsLoadOnAutocompleteCommit) h.shippingMethodsLoaded = true;
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
      if (h.selectError !== null) throw h.selectError;
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
      if (h.selectMutation !== null) {
        h.elements = h.selectMutation;
        h.selectMutation = null;
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
    async click(selector?: string): Promise<void> {
      h.clickCalls += 1;
      if (selector !== undefined) {
        const element = (h.elements as Array<Record<string, unknown>>).find(
          (candidate) => candidate.selector === selector,
        );
        if (element?.tag === "input" && (element.type === "checkbox" || element.type === "radio")) {
          element.checked = true;
        }
        if (element?.role === "switch" || element?.role === "checkbox") {
          element.ariaChecked = element.ariaChecked !== true;
        }
      }
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
      if (h.clickError !== null) throw h.clickError;
    }
    async clickViaJs(): Promise<void> {}
    async clickInFrame(target: { frameUrl: string }, selector: string): Promise<void> {
      h.frameClicks.push(`${target.frameUrl}|${selector}`);
    }
    async clickViaJsInFrame(target: { frameUrl: string }, selector: string): Promise<void> {
      h.frameJsClicks.push(`${target.frameUrl}|${selector}`);
    }
    async clickWithDispatchTracking(
      target: {
        kind: "selector" | "handle" | "frame";
        selector?: string;
        frame?: { frameUrl: string };
        method: "click" | "js_click";
      },
      shouldTrack: (labels: readonly string[]) => boolean = () => true,
    ): Promise<"not_dispatched" | "dispatched" | "unknown"> {
      const element =
        target.kind === "handle"
          ? null
          : (h.elements as Array<Record<string, unknown>>).find(
              (candidate) => candidate.selector === target.selector,
            );
      const labels =
        target.kind === "handle" && h.locatorResolve.ok
          ? (h.locatorResolve.labels ?? [h.locatorResolve.text])
          : target.kind === "handle"
            ? []
            : [element?.ariaLabel, element?.value, element?.visibleText, element?.labelText].filter(
                (label): label is string => typeof label === "string",
              );
      const tracked = shouldTrack(labels);
      const failure = h.trackedClickFailure;
      if (failure?.dispatchStatus !== "not_dispatched") {
        if (target.kind === "handle") {
          h.locatorClickCalls += 1;
        } else if (target.kind === "frame") {
          const destination = `${target.frame!.frameUrl}|${target.selector!}`;
          if (target.method === "click") h.frameClicks.push(destination);
          else h.frameJsClicks.push(destination);
        } else {
          await this.click();
        }
      }
      if (failure !== null) {
        const error = new Error(failure.message);
        throw tracked ? Object.assign(error, { dispatchStatus: failure.dispatchStatus }) : error;
      }
      return "dispatched";
    }
    async typeInFrame(
      target: { frameUrl: string },
      selector: string,
      text: string,
      sealed = false,
    ): Promise<string[]> {
      h.frameTypes.push({
        frameUrl: target.frameUrl,
        selector,
        text,
        ...(sealed ? { sealed: true as const } : {}),
      });
      for (const element of h.elements as Array<Record<string, unknown>>) {
        if (element.selector === selector && element.frameUrl === target.frameUrl)
          element.value = text;
      }
      const element = (h.elements as Array<Record<string, unknown>>).find(
        (candidate) => candidate.selector === selector && candidate.frameUrl === target.frameUrl,
      );
      return sealed
        ? [element?.screenPath, element?.testId, element?.visibleText].filter(
            (key): key is string => typeof key === "string" && key.length > 0,
          )
        : [];
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
      value: string,
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
      if (h.locatorResolveMissValues.includes(value)) {
        return { ok: false, reason: "none", candidates: [] };
      }
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
    async typeHandle(_handle: unknown, text: string, sealed = false): Promise<string[]> {
      h.locatorTypeCalls.push({ text, sealed });
      return sealed ? [h.locatorResolve.ok ? h.locatorResolve.text : ""] : [];
    }
    async captureOperatorScreenshot(
      _opts: unknown,
      sealedFieldKeys: readonly string[],
      _knownSecrets: readonly string[] = [],
      redactionOptions?: unknown,
    ): Promise<{ base64: string; frameUrl: null; frameCount: number; redactedCount: number }> {
      h.capturedSealedFieldKeys.push([...sealedFieldKeys]);
      h.capturedRedactionOptions.push(redactionOptions);
      return { base64: "jpeg", frameUrl: null, frameCount: 1, redactedCount: 0 };
    }
    async uploadFile(selector: string, filePath: string): Promise<void> {
      h.uploads.push({ selector, filePath });
    }
    async startOAuth(): Promise<void> {}
    async loginWithOAuth(
      selector: string,
      settleTimeoutMs?: number,
      provider?: string,
      expectedGoogleAccountEmail?: string | null,
    ): Promise<void> {
      h.oauthLoginCalls.push(selector);
      h.oauthLoginTimeouts.push(settleTimeoutMs ?? 0);
      h.oauthConsentProviders.push(provider);
      h.oauthExpectedGoogleAccountEmails.push(expectedGoogleAccountEmail);
      const gate = h.oauthLoginGates.get(this.index);
      if (gate !== undefined) await gate;
      if (h.oauthLoginError !== null) throw h.oauthLoginError;
      h.currentUrl = h.oauthResultUrl;
      h.visibleText = "Signed in";
    }
    async settleAfterOAuth(): Promise<void> {}
    oauthTransitionStatus(): typeof h.oauthTransition {
      return h.oauthTransition;
    }
    completeOAuthTransitionRecovery(): void {
      h.oauthRecoveryCalls += 1;
      h.oauthTransition = null;
      h.oauthReadError = null;
    }
    async pressKey(key: string): Promise<void> {
      h.pressedKeys.push(key);
    }
    async focusedElementLabels(): Promise<string[]> {
      return h.focusedLabels;
    }
    // Payment surface (operate_pay completion-resume coverage) — the real
    // isPayPalHostedCheckout/fillAndSubmitCheckout/etc. live in browser.ts;
    // these mirror only what executeOperatePay actually calls.
    async isPayPalHostedCheckout(): Promise<boolean> {
      return h.isPayPalHostedCheckout;
    }
    async readCheckoutConfirmSummary(): Promise<{
      merchant: string;
      checkout_origin: string;
      amount_cents: number;
      currency: string;
    }> {
      if (h.checkoutSummary === null) throw new Error("payment_checkout_total_not_found");
      return h.checkoutSummary;
    }
    async fillAndSubmitCheckout(card: unknown): Promise<{
      three_ds_required: boolean;
      order_confirmed: boolean;
      challenge_url?: string;
    }> {
      h.filledCards.push(card);
      if (h.fillAndSubmitError !== null) throw h.fillAndSubmitError;
      return h.fillAndSubmitResult;
    }
    async fillCheckoutCardFields(card: unknown): Promise<void> {
      h.filledCards.push(card);
      if (h.fillAndSubmitError !== null) throw h.fillAndSubmitError;
    }
    async submitFilledCheckout(): Promise<{
      three_ds_required: boolean;
      order_confirmed: boolean;
      challenge_url?: string;
    }> {
      return h.fillAndSubmitResult;
    }
    async clearSealedPaymentFields(): Promise<void> {
      h.clearSealedPaymentFieldsCalls += 1;
    }
    async waitForThreeDsResolution(
      timeoutMs: number,
    ): Promise<"succeeded" | "failed" | "challenge_pending" | "timeout"> {
      h.waitForThreeDsCalls.push(timeoutMs);
      return h.waitForThreeDsResult;
    }
    paymentInstrumentMismatch(): typeof h.paymentInstrumentMismatch {
      return h.paymentInstrumentMismatch;
    }
    operatorBrowserMarker(): string {
      return `v1:1:mock-${this.index}`;
    }
    async captureStorageState(): Promise<unknown> {
      h.captureStorageStateCalls += 1;
      if (h.captureStorageStateGate !== null) await h.captureStorageStateGate;
      if (h.captureStorageStateError !== null) throw h.captureStorageStateError;
      const sequence = h.captureStorageStateSequences.get(this.index);
      if (sequence !== undefined && sequence.length > 0) {
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return h.captureStorageStates.get(this.index) ?? h.captureStorageState;
    }
    async restoreStorageState(state: unknown): Promise<void> {
      if (h.restoreStorageStateGate !== null) await h.restoreStorageStateGate;
      h.restoredStorageStates.push({ browserIndex: this.index, state });
    }
    async setHostScopeAllowedHosts(
      allowedHosts: () => readonly string[],
      siblingDomainHosts: () => readonly string[] = allowedHosts,
    ): Promise<void> {
      h.hostScopeProviders.push({ allowedHosts, siblingDomainHosts });
    }
    async withTemporaryHostScopeAllowedHosts<T>(
      hosts: readonly string[],
      operation: () => Promise<T>,
    ): Promise<T> {
      h.temporaryHostScopes.push({ hosts: [...hosts], phase: "enter" });
      try {
        return await operation();
      } finally {
        h.temporaryHostScopes.push({ hosts: [...hosts], phase: "exit" });
      }
    }
    async close(options?: {
      cancelStart?: boolean;
    }): Promise<"closed" | "force_closed_unproven" | "unknown"> {
      h.closeCalls += 1;
      const closeGate = h.closeGates.get(this.index);
      if (closeGate !== undefined) await closeGate;
      if (options?.cancelStart === true) {
        const gate = h.startGates.get(this.index);
        if (gate !== undefined) await gate;
        if (h.startGate !== null) await h.startGate;
      }
      if (h.connections[this.index] === true) h.started -= 1;
      h.connections[this.index] = false;
      return h.closeStates.get(this.index) ?? h.closeState;
    }
    async waitForCancelledStartQuiescence(): Promise<void> {
      const gate = h.startGates.get(this.index);
      if (gate !== undefined) await gate;
      if (h.startGate !== null) await h.startGate;
    }
    async forceCloseOwnedProcessTree(): Promise<"closed" | "force_closed_unproven" | "unknown"> {
      h.forceCloseCalls += 1;
      const closeGate = h.closeGates.get(this.index);
      if (closeGate !== undefined) await closeGate;
      if (h.connections[this.index] === true) h.started -= 1;
      h.connections[this.index] = false;
      return h.closeStates.get(this.index) ?? h.closeState;
    }
  },
  // Mirrors the real export — the pending-card-fill charge guard reads it.
  CHECKOUT_SUBMIT_LABEL_RE:
    /^(?:pay(?:\s+now)?|place\s+order|complete\s+(?:order|purchase|payment)|submit\s+payment|buy\s+now|confirm\s+(?:order|payment))\b/i,
  checkoutSubmitLabel: (signals: {
    ariaLabel?: string | null;
    inputValue?: string | null;
    textContent?: string | null;
  }) => (signals.ariaLabel || signals.inputValue || signals.textContent || "").trim(),
  clickDispatchStatusForError: (error: unknown) => {
    if (error instanceof Error && "dispatchStatus" in error) {
      const status = error.dispatchStatus;
      if (status === "not_dispatched" || status === "dispatched" || status === "unknown") {
        return status;
      }
    }
    return "unknown";
  },
  parseCheckoutAmount: (texts: readonly string[], fallbackCurrency?: string) => {
    for (const text of texts) {
      const match = text.match(
        /^\s*(?:total\s+)?(?:([A-Z]{3})\s*)?([$¥￥])?\s*([0-9]+(?:[.,][0-9]+)?)\s*(円|[A-Z]{3})?\s*$/i,
      );
      if (match?.[3] === undefined) continue;
      const currency = (
        match[1] ??
        match[4] ??
        (match[2] === "$" ? "USD" : undefined) ??
        fallbackCurrency
      )
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

vi.mock("../profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProfileModule>();
  return {
    ...actual,
    acquireFreeProfileOperationGuard: async (
      ...args: Parameters<typeof actual.acquireFreeProfileOperationGuard>
    ) => {
      if (h.profileOperationProbeGate !== null) await h.profileOperationProbeGate;
      return await actual.acquireFreeProfileOperationGuard(...args);
    },
  };
});

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import canonicalize from "canonicalize";
import { exportJWK, SignJWT } from "jose";
import { sealToRecipient } from "../payment-hpke.js";
import { operatePayTool, operatePaymentStatusTool } from "../../tools/operate-pay.js";
import { ApiClient } from "../../api-client.js";
import { dispatchOperatorBrowserProcessTermination } from "../operator-browser-watchdog.js";
import { BrowserController } from "../browser.js";
import { acquireProfileOperationGuard } from "../profile.js";
import {
  startProvisionSession,
  startHarnessProvisionSession,
  act,
  observe,
  observedHostsForSession,
  stashSecretSlot,
  awaitVerification,
  captchaGate,
  finishProvisionSession,
  finishProvisionSessionWithPreparation,
  withPaymentSessionCall,
  withProvisionSessionCall,
  paymentSession,
  closeAllProvisionSessions,
  activeSessionCount,
  getSessionUserEmail,
  parseElementsTable,
  replayOperatorRecipe,
  activeProvisionBrowserForPayment,
  activeCartCheckoutForOrigin,
  armPaymentDispatchHandoff,
  cartAdd,
  coordinatePaymentDispatchAudit,
  finishPaymentDispatchHandoff,
  formSelectMany,
  recordActivePaymentProvenance,
  setActivePendingCardFill,
  claimActivePaymentForOperatePay,
  completeActivePaymentLeaseWithPendingApproval,
  completeActivePaymentLeaseWithPendingFill,
  completeActivePaymentLeaseWithTerminalApproval,
  getActivePendingApproval,
  getTerminalPaymentApproval,
  getActivePendingCardFill,
  releaseActivePaymentLease,
  markActivePendingCardFillSubmitStarted,
  restoreActivePendingCardFillAfterConfirmThrow,
  retainActivePaymentFieldSeal,
  clearActivePendingCardFill,
  recipeTargetFor,
  captureObserved,
  getActivePendingThreeDs,
  setActivePendingThreeDs,
  clearActivePendingThreeDsIfCurrent,
  captureScreenshot,
  captureAndPromoteSession,
  observeQuery,
  verifyPostcondition,
} from "../provision-session.js";
import { OBSERVE_V2_MAX_TOKENS, OBSERVE_V2_MAX_WIRE_BYTES } from "../compact-observation-v2.js";
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
  provisionFinishTool,
  provisionPrepareLoginTool,
  provisionSealVaultCredentialTool,
  provisionStoreLoginTool,
  operateLoginTool,
  operateRecipeRunTool,
  operateRecipeSaveTool,
  provisionActTool,
  provisionObserveTool,
  storedExtractResult,
  withSigninHost,
} from "../../tools/provision-drive.js";

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
  compactV2ModeBeforeTest = process.env.TRUSTY_SQUIRE_OBSERVE_V2;
  process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "off";
  process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
  h.providers = ["google"];
  h.oauthStatus = "already_valid";
  h.oauthLoginCalls = [];
  h.oauthLoginTimeouts = [];
  h.oauthLoginError = null;
  h.oauthConsentProviders = [];
  h.oauthExpectedGoogleAccountEmails = [];
  h.oauthLoginGates = new Map();
  h.waitForInteractiveDomCalls = [];
  h.oauthResultUrl = "https://app.example.com/dashboard";
  h.restoredStorageStates = [];
  h.restoreStorageStateGate = null;
  h.oauthReadError = null;
  h.oauthTransition = null;
  h.oauthRecoveryCalls = 0;
  h.typed = [];
  h.uploads = [];
  h.selected = [];
  h.selectError = null;
  h.selectMutation = null;
  h.phoneCountries = [];
  h.phoneCountry = null;
  h.clearElementsOnClick = false;
  h.clickValueMutation = null;
  h.clickPhoneCountryMutation = null;
  h.trackedClickFailure = null;
  h.autocompleteSuggestions = [];
  h.autocompleteCommitMutation = null;
  h.shippingMethodsLoadOnAutocompleteCommit = false;
  h.shippingMethodsLoaded = false;
  h.requiredShippingAddressCommits = [];
  h.autocompleteCommitCalls = [];
  h.autocompleteConfirmOverride = null;
  h.autocompleteConfirmCalls = [];
  h.autocompleteDiscardCalls = 0;
  h.autocompleteDiscardEscapeCalls = [];
  h.clickCalls = 0;
  h.clickError = null;
  h.frameClicks = [];
  h.frameJsClicks = [];
  h.frameTypes = [];
  h.frameSelects = [];
  h.gotos = [];
  h.consentDismissCalls = 0;
  h.consentCta = null;
  h.started = 0;
  h.startCalls = 0;
  h.startGate = null;
  h.startGates = new Map();
  h.closeCalls = 0;
  h.forceCloseCalls = 0;
  h.closeState = "closed";
  h.closeStates = new Map();
  h.closeGates = new Map();
  h.profileProbeCalls = 0;
  h.controllerProviderProbeCalls = 0;
  h.workerEmail = null;
  h.liveGoogleEmail = "default-google@example.com";
  h.identityProbeCalls = 0;
  h.identityProbeExpectedGoogleAccountEmails = [];
  h.googleIdentityByExpectedEmail = new Map();
  h.temporaryHostScopes = [];
  h.hostScopeProviders = [];
  h.connections = [];
  h.profileDirs = [];
  h.proxyUrls = [];
  h.seededStorageStates = [];
  h.storageStates = new Map();
  h.identityMetadata = new Map();
  h.storageStateReads = [];
  h.storageStateReadGate = null;
  h.storageStateWrites = [];
  h.pendingStorageStates = [];
  h.pendingStorageStateOversized = false;
  h.storageStateWriteError = null;
  h.storageStateWriteGate = null;
  h.storageStateWriteAttempts = 0;
  h.profileDestroyGate = null;
  h.profileOperationProbeGate = null;
  h.ephemeralSerial = 0;
  h.createdProfiles = [];
  h.destroyedProfiles = [];
  h.captureStorageState = { cookies: [], origins: [] };
  h.captureStorageStates = new Map();
  h.captureStorageStateSequences = new Map();
  h.captureStorageStateCalls = 0;
  h.captureStorageStateGate = null;
  h.captureStorageStateError = null;
  h.currentUrl = "";
  h.mainDocumentEpoch = 0;
  h.elements = [];
  h.extractInteractiveElementsCalls = 0;
  h.checkoutFieldNames = [];
  h.visibleText = "";
  h.visibleTextGate = null;
  h.extractVisibleTextCalls = 0;
  h.openFirstMailResult = false;
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
  h.locatorResolveMissValues = [];
  h.locatorClickCalls = 0;
  h.locatorTypeCalls = [];
  h.capturedSealedFieldKeys = [];
  h.capturedRedactionOptions = [];
  h.locatorResolveIntents = [];
  h.locatorDisposeCalls = 0;
  h.isPayPalHostedCheckout = false;
  h.filledCards = [];
  h.fillAndSubmitError = null;
  h.fillAndSubmitResult = { three_ds_required: false, order_confirmed: true };
  h.clearSealedPaymentFieldsCalls = 0;
  h.waitForThreeDsResult = "timeout";
  h.waitForThreeDsCalls = [];
  h.paymentInstrumentMismatch = null;
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
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
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

  it("normalizes private browser failures during V2 recipe replay", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        testId: "variant",
        labelText: "Variant",
        selector: "#private-variant-selector",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    h.selectError = new Error(
      'select <select> #private-variant-selector: option "Private option" was not found',
    );

    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [
          {
            action: {
              kind: "select",
              target: { dom_hint: { testid: "variant" }, accessible_name: "Variant" },
              value: "Blue",
            },
          },
        ],
      }),
      {},
    );

    expect(result).toMatchObject({ status: "fallback_required", reason: "selection_failed" });
    expect(JSON.stringify(result)).not.toContain("private-variant-selector");
    expect(JSON.stringify(result)).not.toContain("Private option");
  });

  it("never replays operate_pay and hands the charge to the fresh approval flow", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    let replayDispatchedPayment = false;
    const result = await replayOperatorRecipe(
      started.session_id,
      replayRecipe({
        trace: [{ action: { kind: "operate_pay", value: { hole: "card" } } }],
      }),
      {},
      0,
      {
        beforeAction: () => {
          replayDispatchedPayment = true;
        },
      },
    );

    expect(result).toMatchObject({
      status: "fallback_required",
      step_index: 0,
      next_index: 1,
      reason: "payment requires the existing operate_pay approval flow",
    });
    expect(replayDispatchedPayment).toBe(false);
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
    await finishProvisionSession(started.session_id);
    expect(h.destroyedProfiles).toEqual([]);
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

  // Money rule simplification (2026-08-16): the post-transition field
  // re-verification this test used to exercise was deleted — the fence is
  // the live human biometric approval per charge, not a software re-check
  // of address/contact fields after a page transition. A field mutated or
  // unmounted by a later transition no longer forces human intervention.
  it("does not require a human when a later transition mutates or unmounts an already-verified field", async () => {
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
    expect(result).toMatchObject({ status: "complete" });
    expect(h.elements).toEqual([]);
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
    await finishProvisionSession(started.session_id);
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

  // Money rule simplification (2026-08-16): cross-transition field
  // re-verification was deleted along with the software payment-validation
  // guards. A field mutated by a later, unrelated transition is no longer
  // re-checked before payment — the fence is the human biometric approval.
  it("does not re-verify phone country after a later transition mutates it", async () => {
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
    expect(result).toMatchObject({ status: "complete" });
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
  });

  // Money rule simplification (2026-08-16): the mismatch this scenario used
  // to detect (a later click transition silently mutating an already-typed
  // field) was only caught by the deleted post-transition re-verification.
  it("replay-per-leg-signature: a later transition mutating an already-set field is not re-verified (deleted software guard)", async () => {
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
    expect(result).toMatchObject({ status: "complete" });
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
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

    // Money rule simplification (2026-08-16): the deleted repair-retargeting
    // guard used to let a host repair land on a DIFFERENT element than the
    // one recorded and still resume cleanly (money-path recipes only). That
    // capability is gone; the general (non-money-specific) resume check still
    // requires the repair to land on the originally recorded target.
    h.elements = [
      elem({
        testId: "shipping-city",
        labelText: "City",
        selector: "#live-city",
        value: "",
      }),
    ];
    await act(started.session_id, {
      kind: "type",
      target: "shipping-city",
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
  });

  // Money rule simplification (2026-08-16): act()'s own replayRepair
  // validation (value-mismatch / target-mismatch thrown at repair time) was
  // deleted along with the software payment-validation guards. A repair now
  // always succeeds at act() time; a wrong value is instead caught by the
  // general (non-money-specific) resume-time field re-verification, which
  // only ever checks the ORIGINALLY recorded target.
  it("a wrong field repair is not rejected at act() time, but is caught on replay resume", async () => {
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
    ).resolves.toBeDefined();
    const resumed = await replayOperatorRecipe(
      started.session_id,
      recipe,
      { "address.city": "Queens" },
      1,
    );
    expect(resumed).toMatchObject({
      status: "human_required",
      reason: "field_value_mismatch",
      field: "address.city",
    });
  });

  // Money rule simplification (2026-08-16): the deleted repair-time target
  // check no longer rejects an ambiguous sibling repair in act(). The general
  // resume-time verification still checks the originally recorded target.
  it("an ambiguous sibling repair succeeds at act() time but fails replay resume", async () => {
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
    ).resolves.toBeDefined();
    const resumed = await replayOperatorRecipe(
      started.session_id,
      recipe,
      { "address.city": "Queens" },
      1,
    );
    expect(resumed).toMatchObject({
      status: "human_required",
      reason: "field_missing",
      field: "address.city",
    });
  });

  // Money rule simplification (2026-08-16): activeProvisionBrowserForPayment
  // no longer re-verifies field mounts/values before handing the browser to
  // operate_pay — that software re-check was deleted along with the rest of
  // the payment-validation guards.
  it("does not re-check mounted verified fields at the payment boundary", async () => {
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
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
  });

  // Money rule simplification (2026-08-16): a verified target drifting after
  // replay is no longer detected before payment — see comment above.
  it("does not block payment when a verified target drifts without a replay transition", async () => {
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
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
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
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
  });

  // Money rule simplification (2026-08-16): the pre/post-transition field
  // re-verification this test used to exercise was deleted.
  it("does not detect field drift caused by a replay transition (deleted software guard)", async () => {
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
    expect(result).toMatchObject({ status: "complete" });
    await expect(activeProvisionBrowserForPayment()).resolves.toBeDefined();
  });

  // Money rule simplification (2026-08-16): a later, out-of-band act() call
  // that overwrites an already-verified field is no longer detected — the
  // deleted refreshReplayVerificationAfterAction guard used to catch this.
  it("does not invalidate a verified field when a later value action changes it", async () => {
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
    ).resolves.toBeDefined();
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

  it("SAFETY: refuses a goto step targeting a different eTLD+1, hard-stops (not resumable)", async () => {
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

  it("refuses process-watchdog ownership while operate_start is initializing", async () => {
    let releaseObservation: (() => void) | undefined;
    h.visibleTextGate = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const starting = startProvisionSession({ serviceUrl: "https://app.example.com/" });
    try {
      await vi.waitFor(() => expect(activeSessionCount()).toBe(1));
      await vi.waitFor(() => expect(h.extractVisibleTextCalls).toBeGreaterThan(0));

      await expect(
        dispatchOperatorBrowserProcessTermination("v1:1:mock-0", {
          kind: "cpu_budget_exceeded",
          cpu_percent: 800,
          ceiling_percent: 200,
          consecutive_samples: 3,
        }),
      ).resolves.toBe(false);
      expect(h.closeCalls).toBe(0);
      expect(activeSessionCount()).toBe(1);
    } finally {
      releaseObservation?.();
      const started = await starting;
      await finishProvisionSession(started.session_id);
    }
  });

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
    expect(operateRecipeRunTool.handler).toBe(provisionUseTool.handler);
    expect(operateRecipeRunTool.inputSchema).toBe(provisionUseTool.inputSchema);
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
      operateRecipeRunTool.handler({ name: `purchase--${shapeKey}` }, null as unknown as ApiClient),
    ).rejects.toThrow(/checkout-leg recipe.*operate_recipe_run\{leg:"checkout"\}/i);
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
    const result = (await operateRecipeRunTool.handler(
      { verb: "purchase", session_id: started.session_id, leg: "checkout", params: {} },
      null as unknown as ApiClient,
    )) as { replay: { status: string } };
    expect(result.replay.status).toBe("complete");
    expect(h.clickCalls).toBe(1);

    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses canonical public tools in operator recovery guidance", async () => {
    expect(provisionActTool.description).toContain(
      'operate_act { kind: "extract", into_slot: "<slot>" }',
    );
    expect(provisionActTool.description).toContain("Under default compact-v2");
    expect(provisionActTool.description).toContain("opaque `stale_ref`");
    expect(provisionActTool.description).toContain("@label alias of exactly one of its rows");
    expect(provisionActTool.description).toContain("In V1, stable target refs remain reusable");
    expect(provisionObserveTool.description).toContain("default compact-v2 mode");
    expect(provisionObserveTool.description).toContain("[ref,role,facts?]");
    expect(provisionObserveTool.description).toContain("s=<state bitset>");
    expect(provisionObserveTool.description).toContain(
      "c=checked,u=unchecked,d=disabled,r=required",
    );
    expect(provisionObserveTool.description).toContain("x=s for a same-origin child");
    expect(provisionObserveTool.description).toContain("Fact-only rows begin with a keyed segment");
    expect(provisionObserveTool.description).toContain("In V1 only, pass detail");

    const dir = mkdtempSync(join(tmpdir(), "recipe-guidance-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    await writeRecipe(
      replayRecipe({
        name: "missing-param-test",
        verb: undefined,
        domain: undefined,
        entry_url: "https://${TENANT}.example.com/start",
      }),
    );

    await expect(
      operateRecipeRunTool.handler({ name: "missing-param-test" }, null as unknown as ApiClient),
    ).rejects.toThrow(/pass them as operate_recipe_run\{ params:/i);

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

  it("fails the save when the required degenerate catch-all cannot be refreshed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-degenerate-fail-"));
    const degenerateFile = join(dir, "purchase--example.com.json");
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    writeFileSync(degenerateFile, `${JSON.stringify(replayRecipe(), null, 2)}\n`, "utf8");
    chmodSync(degenerateFile, 0o400);
    h.visibleText = "Review order";
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    try {
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
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(readdirSync(dir)).toContain("purchase--example.com--cart.json");
    } finally {
      chmodSync(degenerateFile, 0o600);
      delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(operateRecipeSaveTool.handler).toBe(provisionRememberTool.handler);
    expect(operateRecipeSaveTool.inputSchema).toBe(provisionRememberTool.inputSchema);
    const saved = await operateRecipeSaveTool.handler(
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
    // recipe-key-redesign: the service URL's path ("/cart") hits the
    // action_path allow-list, so the specific (verb, domain, action_path)
    // file is written, AND the degenerate (verb, domain) catch-all is
    // refreshed alongside it (the no-regression guarantee).
    expect(readdirSync(dir).sort()).toEqual([
      "purchase--example.com--cart.json",
      "purchase--example.com.json",
    ]);
    const raw = JSON.parse(
      readFileSync(join(dir, "purchase--example.com--cart.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw).toMatchObject({
      verb: "purchase",
      domain: "example.com",
      action_path: "cart",
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
    // recipe-key-redesign: the service URL's path ("/cart") hits the
    // action_path allow-list, so the whole-task recipe writes BOTH its
    // specific and degenerate catch-all file, alongside the checkout leg.
    expect(files).toContain("purchase--example.com.json");
    expect(files).toContain("purchase--example.com--cart.json");
    expect(files.length).toBe(3);
    const wholeTaskFiles = new Set([
      "purchase--example.com.json",
      "purchase--example.com--cart.json",
    ]);
    const checkoutLegFile = files.find((f) => !wholeTaskFiles.has(f))!;
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
    // recipe-key-redesign: the service URL's path ("/cart") hits the
    // action_path allow-list, so both the specific and degenerate
    // catch-all files are written — still no checkout leg, though.
    expect(readdirSync(dir).sort()).toEqual([
      "purchase--example.com--cart.json",
      "purchase--example.com.json",
    ]);
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves an exact known-email transform as an attested hole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-known-email-"));
    const profileDir = mkdtempSync(join(tmpdir(), "verified-recipe-known-email-profile-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.workerEmail = "buyer@example.com";
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
    h.workerEmail = "buyer@example.com";
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
    // BrowserController is mocked here, so advance the production navigation
    // pacing without spending several seconds of wall time on each replay.
    vi.useFakeTimers();
    const settleNavigation = async <T>(pending: Promise<T>): Promise<T> => {
      await vi.advanceTimersByTimeAsync(2_000);
      return await pending;
    };
    const dir = mkdtempSync(join(tmpdir(), "verified-recipe-email-url-"));
    const profileDir = mkdtempSync(join(tmpdir(), "verified-recipe-email-url-profile-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.workerEmail = "buyer@example.com";
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
    await settleNavigation(
      provisionRememberTool.handler(
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
      ),
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
    const replay = await settleNavigation(
      replayOperatorRecipe(replayStarted.session_id, recipe, {
        "address.email": "buyer@example.com",
      }),
    );
    expect(replay.status).toBe("complete");
    const finished = await settleNavigation(
      provisionFinishTaskTool.handler(
        {
          session_id: replayStarted.session_id,
          kind: "result",
          summary: "Account created",
          verify_recipe: "email-url",
        },
        null as unknown as ApiClient,
      ),
    );
    expect(finished).toMatchObject({
      kind: "result",
      verified: { confirmed: true },
    });

    const consolidatedReplayStarted = await startProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
    });
    const consolidatedReplay = await settleNavigation(
      replayOperatorRecipe(consolidatedReplayStarted.session_id, recipe, {
        "address.email": "buyer@example.com",
      }),
    );
    expect(consolidatedReplay.status).toBe("complete");
    const consolidatedFinished = await settleNavigation(
      provisionFinishTool.handler(
        {
          session_id: consolidatedReplayStarted.session_id,
          outcome: {
            kind: "result",
            summary: "Account created",
            verify_recipe: "email-url",
          },
        },
        null,
      ),
    );
    expect(consolidatedFinished).toEqual(finished);
    expect(h.gotos).toContain("https://shop.example.com/account/buyer%2540example.com");
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
    vi.useRealTimers();
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
  vi.useRealTimers();
  // An unproven close deliberately retains the real-profile lease in the
  // runtime. The mock has no process to prove dead, so restore its normal
  // close result before cross-test cleanup.
  h.closeState = "closed";
  h.closeStates.clear();
  await closeAllProvisionSessions();
  delete process.env.BOT_START_TIMEOUT_MS;
  delete process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS;
  delete process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS;
  if (compactV2ModeBeforeTest === undefined) delete process.env.TRUSTY_SQUIRE_OBSERVE_V2;
  else process.env.TRUSTY_SQUIRE_OBSERVE_V2 = compactV2ModeBeforeTest;
});

describe("3.1 — autocomplete-aware type fill", () => {
  it("fills Shopify's required address combobox, commits its suggestion, and leaves apartment empty", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        role: "combobox",
        labelText: "Address",
        autocomplete: "shipping address-line1",
        required: true,
        selector: "#shipping-address",
        value: "",
      }),
      elem({
        index: 1,
        tag: "input",
        role: "textbox",
        labelText: "Apartment, suite, etc. (optional)",
        autocomplete: "shipping address-line2",
        selector: "#shipping-apartment",
        value: "",
      }),
    ];
    h.autocompleteSuggestions = ["350 5th Ave, New York, NY 10118, USA"];
    h.autocompleteCommitMutation = {
      selector: "#shipping-address",
      value: "350 5th Ave, New York, NY 10118, USA",
    };
    // Shopify only enables delivery-rate selection after the required address
    // line is committed by blur/change, not merely after a Places selection.
    h.shippingMethodsLoadOnAutocompleteCommit = true;

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> }).safe_table;
    const addressRef = rows.find((row) => row[1] === "s" && row[2]?.includes("f=address"))?.[0];

    // The old observation exposed both controls as f=address, allowing the
    // textbox below the required line to receive this value and leaving
    // shipping blocked. The only f=address ref now identifies line 1.
    expect(addressRef).toBeDefined();
    await act(started.session_id, { kind: "type", target: addressRef!, text: "350 5th Ave" });

    expect(h.typed).toEqual([{ selector: "#shipping-address", text: "350 5th Ave" }]);
    expect(h.autocompleteCommitCalls).toEqual([0]);
    expect(h.requiredShippingAddressCommits).toEqual(["#shipping-address"]);
    expect(h.shippingMethodsLoaded).toBe(true);
    expect(h.autocompleteConfirmCalls).toEqual([
      { selector: "#shipping-address", pickedText: "350 5th Ave, New York, NY 10118, USA" },
    ]);
    expect(h.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: "#shipping-address", value: "350 5th Ave, New York, NY 10118, USA" }),
        expect.objectContaining({ selector: "#shipping-apartment", value: "" }),
      ]),
    );
  });

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

describe("operate session — OAuth lifecycle", () => {
  it("preserves the authorized target and completes OAuth in the existing real-profile browser", async () => {
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    const result = await act(started.session_id, {
      kind: "oauth_login",
      target: "Continue with Google",
    });
    expect(h.oauthLoginCalls).toEqual(["#google-oauth"]);
    expect(h.startCalls).toBe(1);
    expect(h.profileDirs).toHaveLength(1);
    expect(result.text).toBe("Signed in");
    await finishProvisionSession(started.session_id);
  });

  it("waits for DOM readiness instead of spending the OAuth completion budget on a fixed dwell", async () => {
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "30";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }),
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });

    await expect(
      act(started.session_id, { kind: "oauth_login", target: "Continue with Google" }),
    ).resolves.toMatchObject({ text: "Signed in" });
    expect(h.waitForInteractiveDomCalls).toContainEqual({ minElements: 1, timeoutMs: 2_000 });
    await finishProvisionSession(started.session_id);
  });

  it("keeps the session alive and inspectable after an OAuth completion-wait timeout", async () => {
    // Regression: an OAuth boundary timeout used to force-terminate the whole
    // provision session ("oauth_action_terminalize"), so a pending
    // chooser/consent screen became unreachable — observe/screenshot/oauth_settle
    // all returned "unknown provision session" and the only recovery was a
    // fresh session that lost all progress. A timeout must surface as a
    // recoverable error while the session stays usable.
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "10";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    let releaseOAuth!: () => void;
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        releaseOAuth = resolve;
      }),
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    await expect(
      act(started.session_id, { kind: "oauth_login", target: "Continue with Google" }),
    ).rejects.toMatchObject({ code: "google_session" });

    // The timeout must NOT have deregistered the session: observe succeeds…
    await expect(observe(started.session_id)).resolves.toMatchObject({
      session_id: started.session_id,
    });
    // …oauth_settle is still callable on the same session…
    await expect(act(started.session_id, { kind: "oauth_settle" })).resolves.toBeDefined();
    releaseOAuth();
    // …and operate_finish closes the still-registered session normally.
    await expect(finishProvisionSession(started.session_id)).resolves.toMatchObject({
      session_id: started.session_id,
      closed: true,
    });
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

describe("Compact V2 action-map boundary", () => {
  it("publishes mode-correct selection and wire contracts", () => {
    const properties = provisionActTool.jsonInputSchema.properties as Record<string, unknown>;
    const selectionDescription = (properties.selections as { description: string }).description;

    expect(selectionDescription).toBe(
      "Map each current Compact V2 @e: ref or @label, or V1 observed label/ref, to its visible option text.",
    );
    expect(provisionActTool.description).toContain(
      "Compact V2 keys are current safe_table @e: refs or @labels, while V1 keys may be observed labels or refs",
    );
    expect(provisionObserveTool.description).toContain(
      "the row's @label alias, a slug of its screened short label",
    );
    expect(provisionObserveTool.description).toContain(
      "matching actionable refs with screened labels and code-owned facts",
    );
  });

  it("retains only sealed inventory after a V2 observation", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        selector: "#card-number",
        autocomplete: "cc-number",
        value: "4111111111111111",
        visibleText: "correcthorsebattery",
        sealed: true,
      }),
      elem({
        index: 1,
        tag: "input",
        role: "textbox",
        selector: "#security-code",
        autocomplete: "cc-csc",
        value: "123",
        sealed: true,
      }),
    ];

    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const retained = paymentSession(started.session_id).lastElements;
    const serialized = JSON.stringify(retained);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("correcthorsebattery");
    expect(serialized).not.toContain("#card-number");
    expect(retained[0]).toMatchObject({
      value: null,
      selector: expect.stringMatching(/^@c:/),
      autocomplete: "cc-number",
    });
  });

  it("uses opaque correlation for sealed trace capture and promotion", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const captureDir = mkdtempSync(join(tmpdir(), "compact-v2-promotion-"));
    const previousCaptureDir = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
    process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = captureDir;
    try {
      h.elements = [
        elem({
          tag: "button",
          role: "button",
          id: "correcthorsebattery",
          name: "correcthorsebattery",
          selector: "#private-action-selector",
          visibleText: "Create account",
        }),
      ];
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/signup",
      });
      const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
        .safe_table[0]![0];
      await act(started.session_id, { kind: "click", target: handle });

      const session = paymentSession(started.session_id);
      const actionRound = session.captureRounds[0]!;
      const observedSelector = (actionRound.observed as { selector: string }).selector;
      expect(observedSelector).toMatch(/^@c:/);
      expect(actionRound.inventory.some((element) => element.selector === observedSelector)).toBe(
        true,
      );
      expect(JSON.stringify(session.actionTrace)).not.toContain("private-action-selector");
      expect(JSON.stringify(session.actionTrace)).not.toContain("correcthorsebattery");
      expect(session.actionTrace[0]?.action).not.toHaveProperty("target.css");

      h.elements = [
        elem({
          tag: "button",
          role: "button",
          selector: "#private-copy-selector",
          visibleText: "Copy API key",
        }),
      ];
      await observe(started.session_id);
      const promoted = await captureAndPromoteSession(started.session_id);
      expect(promoted).toMatchObject({ kind: "ok" });
      expect(JSON.stringify(session.captureRounds)).not.toContain("private-action-selector");
      expect(JSON.stringify(session.captureRounds)).not.toContain("private-copy-selector");
    } finally {
      if (previousCaptureDir === undefined) {
        delete process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
      } else {
        process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE = previousCaptureDir;
      }
      rmSync(captureDir, { recursive: true, force: true });
    }
  });

  it("fails V2 recording closed when an action value cannot cross the seal", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        labelText: "Name",
        selector: "#private-name",
      }),
    ];
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/signup",
      });
      const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
        .safe_table[0]![0];
      const rawValue = "correct horse battery staple";
      await act(started.session_id, {
        kind: "type",
        target: handle,
        text: rawValue,
        provenance: { hole: "address.line1" },
      });

      const token = "ab12cd34ef56gh78ij90kl";
      const magicUrl = `https://shop.example.com/magic?code=${token}`;
      await act(started.session_id, { kind: "goto", url: magicUrl });

      const session = paymentSession(started.session_id);
      const retained = JSON.stringify({
        trace: session.actionTrace,
        capture: session.captureRounds,
      });
      expect(h.typed).toContainEqual({ selector: "#private-name", text: rawValue });
      expect(h.gotos).toContain(magicUrl);
      expect(retained).not.toContain(rawValue);
      expect(retained).not.toContain(token);
      expect(writes.join("")).not.toContain(token);
      expect(session.recipeRejectionReason).toBe("compact_v2_unrepresentable_value_action");
      await expect(captureAndPromoteSession(started.session_id)).resolves.toEqual({
        kind: "skipped",
        reason: "compact_v2_unrepresentable_value_action",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("marks unsupported select and phone-country values non-recordable", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Country",
        selector: "#country",
        selectOptions: [{ value: "kr", text: "South Korea" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const handle = (started as unknown as { safe_table: Array<[string]> }).safe_table[0]![0];

    await act(started.session_id, {
      kind: "select",
      target: handle,
      text: "South Korea",
      provenance: { hole: "address.country" },
    });
    await act(started.session_id, {
      kind: "set_phone_country",
      country: "Japan",
      provenance: { hole: "contact.phone_country" },
    });

    const session = paymentSession(started.session_id);
    expect(h.selected).toContainEqual({ selector: "#country", matcher: "South Korea" });
    expect(h.phoneCountries).toContain("Japan");
    expect(JSON.stringify(session.actionTrace)).not.toContain("South Korea");
    expect(JSON.stringify(session.actionTrace)).not.toContain("Japan");
    expect(session.recipeRejectionReason).toBe("compact_v2_unrepresentable_value_action");
    await expect(captureAndPromoteSession(started.session_id)).resolves.toEqual({
      kind: "skipped",
      reason: "compact_v2_unrepresentable_value_action",
    });
  });

  it("refuses V2 replay recording for unsafe URL paths and query-dependent navigation", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const pathSession = await startProvisionSession({
        serviceUrl: "https://shop.example.com/signup",
      });
      const secretPath = "https://shop.example.com/keys/sk_live_1234567890abcdef";
      await act(pathSession.session_id, { kind: "goto", url: secretPath });
      expect(h.gotos).toContain(secretPath);
      expect(JSON.stringify(paymentSession(pathSession.session_id).actionTrace)).not.toContain(
        "sk_live_1234567890abcdef",
      );
      await expect(captureAndPromoteSession(pathSession.session_id)).resolves.toEqual({
        kind: "skipped",
        reason: "compact_v2_unrepresentable_goto",
      });
      await finishProvisionSession(pathSession.session_id);

      const querySession = await startProvisionSession({
        serviceUrl: "https://shop.example.com/signup",
      });
      const queryUrl = "https://shop.example.com/settings?tab=api-keys";
      await act(querySession.session_id, { kind: "goto", url: queryUrl });
      expect(h.gotos).toContain(queryUrl);
      await expect(captureAndPromoteSession(querySession.session_id)).resolves.toEqual({
        kind: "skipped",
        reason: "compact_v2_unrepresentable_goto",
      });
      expect(writes.join("")).not.toContain("sk_live_1234567890abcdef");
      expect(writes.join("")).not.toContain("tab=api-keys");
    } finally {
      spy.mockRestore();
    }
  });

  it("screens host metadata before V2 audit and replay retention", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const secretHost = "4111-1111-1111-1111.attacker.test";
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/signup",
      });
      await expect(
        act(started.session_id, { kind: "goto", url: `https://${secretHost}/checkout` }),
      ).rejects.toThrow("target_not_allowed");
      await act(started.session_id, { kind: "allow_host", host: secretHost });

      const session = paymentSession(started.session_id);
      expect(session.recipeRejectionReason).toBe("compact_v2_unrepresentable_host");
      expect(JSON.stringify(session.actionTrace)).not.toContain(secretHost);
      expect(writes.join("")).not.toContain(secretHost);
      expect(writes.join("")).toContain("<sealed-host>");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps start metadata, rejects locators, and binds a handle to its current page snapshot", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.workerEmail = "operator@example.test";
    h.elements = [
      elem({
        tag: "button",
        type: "button",
        role: "button",
        selector: "#continue",
        visibleText: "Continue",
      }),
    ];

    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      hint: "Complete the storefront form.",
    });
    expect(started).toMatchObject({
      format: "compact-v2",
      hint: expect.stringContaining("Complete the storefront form."),
      user_email: "operator@example.test",
    });
    const firstRef = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]?.[0];
    expect(firstRef).toMatch(/^@e:/);

    // V2's sealed membership check runs before locator parsing, so a CSS/text
    // fallback cannot escape the action map.
    await expect(
      act(started.session_id, { kind: "click", target: "css=#continue" }),
    ).rejects.toThrow("stale_ref");
    expect(h.locatorClickCalls).toBe(0);

    // A page transition invalidates all handles issued from the old map.
    const afterGoto = await act(started.session_id, {
      kind: "goto",
      url: "https://shop.example.com/next",
    });
    await expect(act(started.session_id, { kind: "click", target: firstRef! })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);

    const freshRef = (afterGoto as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]?.[0];
    expect(freshRef).toMatch(/^@e:/);
    await act(started.session_id, { kind: "click", target: freshRef! });
    expect(h.clickCalls).toBe(1);
  });

  it("audits forged targets opaquely before rejecting them", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/checkout",
      });
      const forged = "4111111111111111";
      await expect(act(started.session_id, { kind: "click", target: forged })).rejects.toThrow(
        "stale_ref",
      );
      const auditText = writes.join("");
      expect(auditText).toContain('"target":"<sealed>"');
      expect(auditText).not.toContain(forged);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a handle after its snapshot lifetime expires", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/checkout",
      });
      const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
        .safe_table[0]![0];
      now += 5 * 60_000 + 1;
      await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
        "stale_ref",
      );
      expect(h.clickCalls).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("binds paging cursors to the normalized query and role", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = Array.from({ length: 8 }, (_, index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: `Item ${index}`,
        selector: `#item-${index}`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });
    const pageCursor = (started.overflow as { next_cursor: string }).next_cursor;
    await expect(observeQuery(started.session_id, "Item", undefined, pageCursor)).rejects.toThrow(
      "invalid_cursor",
    );
    retainActivePaymentFieldSeal();
    const nextPage = await observeQuery(started.session_id, "", undefined, pageCursor);
    expect(nextPage.safe_table).toHaveLength(4);
    const queryPage = await observeQuery(started.session_id, "Item");
    const queryCursor = (queryPage.overflow as { next_cursor: string }).next_cursor;
    await expect(observeQuery(started.session_id, "Other", undefined, queryCursor)).rejects.toThrow(
      "invalid_cursor",
    );
    await expect(observeQuery(started.session_id, "Item", "link", queryCursor)).rejects.toThrow(
      "invalid_cursor",
    );
  });

  it("pages across a volatile query-token change on the same origin+path", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = Array.from({ length: 8 }, (_, index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: `Item ${index}`,
        selector: `#item-${index}`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/c/token",
    });
    const pageCursor = (started.overflow as { next_cursor: string }).next_cursor;
    // Live checkouts (e.g. Shopify) rotate a query token on every step
    // re-render without a real navigation; paging must survive it.
    h.currentUrl = "https://shop.example.com/checkouts/c/token?_r=revalidated";
    const nextPage = await observeQuery(started.session_id, "", undefined, pageCursor);
    expect((nextPage.safe_table as unknown[]).length).toBeGreaterThan(0);
    expect(nextPage.overflow).toBeUndefined();
  });

  it("pages across a benign form re-render, retiring cursors but not refs", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = Array.from({ length: 8 }, (_, index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: `Item ${index}`,
        selector: `#item-${index}`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/c/token",
    });
    const pageCursor = (started.overflow as { next_cursor: string }).next_cursor;
    // A validation state appears on a live field between pages: the element
    // set no longer byte-matches the frozen snapshot, but paging must
    // re-serialize the same document instead of failing with stale_cursor.
    (h.elements[3] as { required?: boolean }).required = true;
    const nextPage = (await observeQuery(started.session_id, "", undefined, pageCursor)) as {
      safe_table: Array<[string]>;
      overflow?: { next_cursor: string };
    };
    expect(nextPage.safe_table.length).toBe(4);
    // The pre-resync cursor is a positional offset into the OLD serialization
    // and must be dead, never silently re-paged.
    await expect(observeQuery(started.session_id, "", undefined, pageCursor)).rejects.toThrow(
      "stale_cursor",
    );
    // A ref issued before the re-render is NOT positional and stays valid:
    // the element it names is still there and unchanged.
    const firstPageRef = (started as unknown as { safe_table: Array<[string]> }).safe_table[0]![0];
    await act(started.session_id, { kind: "click", target: firstPageRef });
    expect(h.clickCalls).toBe(1);
  });

  it("still invalidates overflow cursors on a cross-document or cross-path navigation", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = Array.from({ length: 8 }, (_, index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: `Item ${index}`,
        selector: `#item-${index}`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/c/token",
    });
    const pageCursor = (started.overflow as { next_cursor: string }).next_cursor;

    // A replaced main document on the same URL still invalidates.
    h.mainDocumentEpoch += 1;
    await expect(observeQuery(started.session_id, "", undefined, pageCursor)).rejects.toThrow(
      "stale_cursor",
    );

    // Re-establish the snapshot, then navigate to a different path (a real
    // navigation also replaces the document): the normalized origin+pathname
    // page key must change and the cursor must die — refs never leak across
    // documents.
    const reObserved = await observe(started.session_id);
    const freshCursor = (reObserved.overflow as { next_cursor: string }).next_cursor;
    h.currentUrl = "https://shop.example.com/checkouts/c/other?_r=x";
    h.mainDocumentEpoch += 1;
    await expect(observeQuery(started.session_id, "", undefined, freshCursor)).rejects.toThrow(
      "stale_cursor",
    );
  });

  it("searches only the sealed action map", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        value: "private-query-token",
        selector: "#secret-bearing-field",
      }),
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });

    const secretGuess = await observeQuery(started.session_id, "private-query-token");
    expect(secretGuess.safe_table).toEqual([]);
    const safeLabel = await observeQuery(started.session_id, "continue");
    expect(safeLabel.safe_table).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/^@e:/),
        "b",
        expect.stringContaining("@continue"),
      ]),
    ]);
  });

  it("queries and re-resolves Resend's existing Google control", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        visibleText: "Log in with Google",
        selector: 'form[action="google"] button',
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://resend.com/signup" });

    const query = await observeQuery(started.session_id, "Google");
    const handle = (query.safe_table as Array<[string]>)[0]?.[0];
    expect(handle).toMatch(/^@e:/);

    await act(started.session_id, {
      kind: "oauth_login",
      target: handle!,
      provider: "google",
    });

    expect(h.oauthLoginCalls).toEqual(['form[action="google"] button']);
    await finishProvisionSession(started.session_id);
  });

  it("matches private merchant labels while returning only sealed rows", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Buy Acme", selector: "#acme" }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        visibleText: "Buy Beta",
        selector: "#beta",
      }),
      elem({
        index: 2,
        tag: "button",
        role: "button",
        visibleText: "購入する",
        selector: "#purchase-ja",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });

    const acme = await observeQuery(started.session_id, "Acme");
    const japanese = await observeQuery(started.session_id, "購入する");

    expect(acme.safe_table).toHaveLength(1);
    expect(japanese.safe_table).toHaveLength(1);
    expect(JSON.stringify(acme)).not.toContain("Acme");
    expect(JSON.stringify(japanese)).not.toContain("購入する");
    expect((acme.safe_table as Array<[string]>)[0]![0]).not.toBe(
      (japanese.safe_table as Array<[string]>)[0]![0],
    );
  });

  it("requires every private query term to match one naming source", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Buy Acme Basic", selector: "#basic" }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        visibleText: "Buy Acme Pro",
        selector: "#pro",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });

    const result = await observeQuery(started.session_id, "Acme Pro");

    expect(result.safe_table).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Acme");
    expect(JSON.stringify(result)).not.toContain("Pro");
  });

  it("uses four-digit private query terms to distinguish sealed controls", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Buy Model 2023", selector: "#2023" }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        visibleText: "Buy Model 2024",
        selector: "#2024",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });

    const result = await observeQuery(started.session_id, "Model 2024");

    expect(result.safe_table).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("Model");
  });

  it("keeps a ref valid when other controls appear in the live action map", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const email = elem({
      tag: "input",
      type: "email",
      role: "textbox",
      labelText: "Email",
      selector: "#email",
    });
    h.elements = [email];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = (started as unknown as { safe_table: Array<[string]> }).safe_table[0]![0];

    // A live re-render adds a control. The observed field is untouched, so its
    // ref must still act — that is the whole point of fingerprint identity.
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      email,
    ];

    await act(started.session_id, { kind: "type", target: handle, text: "buyer@example.com" });
    expect(h.typed).toEqual([{ selector: "#email", text: "buyer@example.com" }]);
  });

  it("rejects a handle after a same-URL main-document replacement", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = (started as unknown as { safe_table: Array<[string]> }).safe_table[0]![0];

    h.mainDocumentEpoch += 1;

    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  // A live Shopify checkout re-renders the delivery block while the agent is
  // still filling it: Places autocomplete reorders the address inputs (which
  // shifts the positional slug baked into screenPath) and the checkout rewrites
  // the volatile `/checkouts/cn/<token>/<step>` path segment. Neither replaces
  // the document, so every ref from the opening observation must still act.
  function deliveryBlock(order: readonly string[], suffix = ""): unknown[] {
    const byName: Record<string, Record<string, unknown>> = {
      firstName: { labelText: "First name", selector: "#first-name" },
      lastName: { labelText: "Last name", selector: "#last-name" },
      address1: { labelText: "Address", selector: "#address1" },
      city: { labelText: "City", selector: "#city" },
      zip: { labelText: "Postal code", selector: "#zip" },
    };
    return order.map((name, position) =>
      elem({
        ...byName[name],
        index: position,
        tag: "input",
        type: "text",
        role: "textbox",
        name,
        // Shopify's inputs carry framework-random ids, so identity falls to the
        // structural branch — the branch the reorder used to break.
        id: `:r${position + 4}:`,
        container: `form:delivery-${suffix}`,
        screenPath: `form:delivery-${suffix} > input:input-${position}`,
      }),
    );
  }

  it("fills a whole delivery block across an autocomplete re-render and a checkout token rewrite", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const fields = ["firstName", "lastName", "address1", "city", "zip"] as const;
    h.elements = deliveryBlock(fields);
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const page = started as unknown as {
      safe_table: Array<[string, string, string?]>;
      overflow: { next_cursor: string };
    };
    const rest = (await observeQuery(
      started.session_id,
      "",
      undefined,
      page.overflow.next_cursor,
    )) as { safe_table: Array<[string, string, string?]> };
    const refs = [...page.safe_table, ...rest.safe_table].map((row) => row[0]);
    expect(refs).toHaveLength(fields.length);

    // The re-render: siblings reordered, every screenPath ordinal shifted, and
    // the container's text-derived slug changed. Same document throughout.
    h.elements = deliveryBlock([...fields].reverse(), "suggestions-open");
    h.currentUrl = "https://shop.example.com/checkouts/cn/8kQm4Xd1pWvB6nHy3LrTzE/shipping?_r=2";

    for (const ref of refs) {
      await act(started.session_id, { kind: "type", target: ref, text: "filled" });
    }
    expect(h.typed.map((entry: { selector: string }) => entry.selector).sort()).toEqual([
      "#address1",
      "#city",
      "#first-name",
      "#last-name",
      "#zip",
    ]);
  });

  it("still retires refs on a same-document route change to a different logical page", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    // An SPA pushState off the checkout, with NO document replacement: the
    // normalized origin+pathname backstop is the only thing standing between
    // the ref and another logical page, and it must refuse.
    h.currentUrl = "https://shop.example.com/account/addresses";

    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("does not collapse an authored path slug that merely sits under /checkouts/", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/c/spring-sale-guide",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    // Only a MINTED-looking token is treated as volatile. A readable slug is a
    // real page name, so a same-document route change between two of them must
    // still retire the ref.
    h.currentUrl = "https://shop.example.com/checkouts/c/summer-sale-guide";

    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("still retires refs when a different checkout replaces the document", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    // Two different checkouts normalize onto the same page key on purpose, so
    // the document-identity half of the epoch is what keeps them isolated.
    h.currentUrl = "https://shop.example.com/checkouts/cn/5vNc9Jt2hQwR7bKx4MpZfD/information";
    h.mainDocumentEpoch += 1;

    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("distinguishes destructive and affirmative controls with code-owned semantics", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Delete account", selector: "#delete" }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        visibleText: "Keep account",
        selector: "#keep",
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/account" });
    const serialized = JSON.stringify(started);

    expect(serialized).toContain("a=destructive");
    expect(serialized).toContain("a=continue");
    expect(serialized).not.toContain("Delete account");
    expect(serialized).not.toContain("Keep account");
  });

  it("keeps a ref through a selector-only re-render of the same control", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#step-one" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const oldHandle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    // A framework re-render swaps the CSS-in-JS selector. The control's
    // identity — frame, path, role, accessible name — is unchanged, so the
    // fingerprint (and therefore the ref) is too.
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#step-two" }),
    ];
    const refreshed = await observe(started.session_id);
    const newHandle = (refreshed as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    expect(newHandle).toBe(oldHandle);
    await act(started.session_id, { kind: "click", target: oldHandle });
    expect(h.clickCalls).toBe(1);
  });

  it("rejects a handle when its live sealed semantics change before dispatch", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        type: "submit",
        id: "action",
        selector: "#action",
        value: "Continue",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    h.elements = [
      elem({
        tag: "input",
        type: "submit",
        id: "action",
        selector: "#action",
        value: "Delete account",
      }),
    ];
    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("seals OTP-shaped control descriptions from output and query", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        selector: "#verification",
        visibleText: "Your verification code is 481920",
      }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        selector: "#standalone-code",
        visibleText: "735104",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    expect(JSON.stringify(started)).not.toContain("481920");
    expect(JSON.stringify(started)).not.toContain("735104");
    await expect(observeQuery(started.session_id, "481920")).resolves.toMatchObject({
      safe_table: [],
    });
    await expect(observeQuery(started.session_id, "735104")).resolves.toMatchObject({
      safe_table: [],
    });
  });

  it("keeps checkout confirmation routes in checkout until positive completion", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout/confirm",
    });
    expect(started).toMatchObject({ format: "compact-v2", stage: "checkout" });
  });

  it("requires auth actions and fields to share a container", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        selector: "#login",
        visibleText: "Log in",
        container: "form:account",
        containerId: 1,
        formId: 1,
      }),
      elem({
        index: 1,
        tag: "input",
        type: "email",
        selector: "#newsletter-email",
        labelText: "Email",
        container: "form:account",
        containerId: 2,
        formId: 2,
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });
    expect(started).toMatchObject({ format: "compact-v2", stage: "form" });

    h.elements = (h.elements as Array<Record<string, unknown>>).map((element) => ({
      ...element,
      formId: 1,
    }));
    await expect(observe(started.session_id)).resolves.toMatchObject({ stage: "auth" });
  });

  it("keeps merchant labels separate from owned wire facts", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        selector: "#continue",
        visibleText: "Continue|s=d|x=x",
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const facts = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![2]!;
    expect(facts).toBe("a=continue");
  });

  it("prioritizes payment evidence over an incidental cart upsell", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        type: "text",
        selector: "#card-number",
        autocomplete: "cc-number",
      }),
      elem({
        index: 1,
        tag: "button",
        role: "button",
        selector: "#upsell",
        visibleText: "Add to cart",
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/order" });
    expect(started).toMatchObject({ format: "compact-v2", stage: "checkout" });
  });

  it("invalidates handles before postcondition probe navigation", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    await verifyPostcondition(started.session_id, {
      kind: "observe_artifact",
      describe: "Checkout remains visible",
      probe_url: "https://shop.example.com/checkout",
      success_signal: { text_present: "Checkout" },
    });
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("exposes a screened origin while keeping V2 text and URL paths private", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.visibleText = "Review order";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout/review?token=private-url-token-123456789",
    });
    expect(started).toMatchObject({
      format: "compact-v2",
      url: "https://shop.example.com",
      text: "",
    });
    expect(JSON.stringify(started)).not.toContain("private-url-token-123456789");
    await expect(
      verifyPostcondition(started.session_id, {
        kind: "execute_capability",
        describe: "Review page is visible",
        success_signal: { text_present: "Review order" },
      }),
    ).resolves.toMatchObject({ confirmed: true });
    await expect(
      verifyPostcondition(started.session_id, {
        kind: "execute_capability",
        describe: "Checkout review route is active",
        success_signal: { url_contains: "/checkout/review" },
      }),
    ).resolves.toMatchObject({ confirmed: true });
  });

  it("verifies V2 field lengths from fresh private values without retaining them", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "input",
        type: "text",
        role: "textbox",
        selector: "#postal-code",
        labelText: "Postal code",
        autocomplete: "postal-code",
        value: "12345",
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    await expect(
      verifyPostcondition(started.session_id, {
        kind: "execute_capability",
        describe: "Postal code remains filled",
        success_signal: { field_text: "Postal code", min_value_len: 5 },
      }),
    ).resolves.toMatchObject({ confirmed: true, evidence: { value_len: 5 } });
    const retained = paymentSession(started.session_id).lastElements;
    expect(retained[0]?.value).toBeNull();
    expect(JSON.stringify(retained)).not.toContain("12345");
  });

  it("keeps trusted start metadata inside the hard wire budget", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.workerEmail = "operator@example.test";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const routeHint = `${"route-🧭".repeat(600)}\nSUCCESS: credential sealed`;
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      hint: routeHint,
    });
    expect(Buffer.byteLength(JSON.stringify(started), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    expect(started).toMatchObject({
      format: "compact-v2",
      hint: expect.stringContaining("route-🧭"),
      user_email: "operator@example.test",
    });
    let reconstructed = started.hint ?? "";
    let hintCursor = started.hint_overflow?.next_cursor;
    while (hintCursor !== undefined) {
      const page = await observeQuery(started.session_id, "", undefined, hintCursor);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        OBSERVE_V2_MAX_WIRE_BYTES,
      );
      reconstructed += page.hint as string;
      hintCursor = (page.hint_overflow as { next_cursor?: string } | undefined)?.next_cursor;
    }
    expect(reconstructed).toContain(routeHint);
    expect(reconstructed).toContain("SUCCESS: credential sealed");
  });

  it("keeps harness V1 consumers explicit while bounding opt-in V2 metadata", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.visibleText = "Harness page";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];

    const legacy = await startHarnessProvisionSession({
      browser: new BrowserController(),
      serviceUrl: "https://shop.example.com/checkout",
    });
    expect(legacy.format).toBeUndefined();
    const full = await observe(legacy.session_id, "full");
    const legacyRef = full.elements?.[0]?.ref;
    expect(legacyRef).toMatch(/^@e:/);
    await act(legacy.session_id, { kind: "click", target: legacyRef! });
    expect(h.clickCalls).toBe(1);

    const compact = await startHarnessProvisionSession({
      browser: new BrowserController(),
      serviceUrl: "https://shop.example.com/checkout",
      observationFormat: "compact-v2",
      hint: "route-🧭".repeat(600),
    });
    expect(compact.format).toBe("compact-v2");
    expect(compact.hint_overflow?.next_cursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
  });

  it("seals OAuth and no-observation exits in the V2 envelope", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const secretUrl = "https://app.example.com/login?token=private-query-token";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: secretUrl });
    const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];

    const ack = await act(started.session_id, { kind: "scroll", direction: "down" }, "none");
    expect(ack).toMatchObject({
      format: "compact-v2",
      url: "https://app.example.com",
      text: "",
      observed: "none",
    });
    expect(ack.elements).toBeUndefined();
    // A detail:"none" scroll returns no map, but it does not retire the one the
    // agent already holds — the control it names has not moved.
    await act(started.session_id, { kind: "click", target: ref }, "none");
    // Nothing structural changed, so this is an unchanged delta and the ref the
    // agent already holds is still the current one.
    expect(await observe(started.session_id)).toMatchObject({ delta: true });
    const refreshedRef = ref;

    h.oauthTransition = {
      productUrl: secretUrl,
      providerPageClosed: true,
      productPageViable: true,
      browserConnected: true,
    };
    const transition = await observe(started.session_id);
    expect(transition).toMatchObject({
      format: "compact-v2",
      url: "https://app.example.com",
      text: "",
      stage: "auth",
      oauth: {
        state: "in_progress",
        provider_page: "closed_or_detached",
        next_action: "operate_observe",
      },
    });
    expect(transition.elements).toBeUndefined();
    expect(JSON.stringify(transition)).not.toContain("private-query-token");
    expect(h.oauthRecoveryCalls).toBe(1);
    await expect(act(started.session_id, { kind: "click", target: refreshedRef })).rejects.toThrow(
      "stale_ref",
    );
  });

  it("keeps shadow observations on the V1 action contract", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "shadow";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    expect(started.format).toBeUndefined();
    await act(started.session_id, { kind: "click", target: "Continue" });
    expect(h.clickCalls).toBe(1);
  });

  it("keeps a ref usable after a dispatched action throws", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    h.clickError = new Error("dispatch failed after click");
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "action_failed",
    );
    // The action failed; the control did not move. Retrying the same ref is
    // legitimate — only leaving the document retires it.
    h.clickError = null;
    await act(started.session_id, { kind: "click", target: ref });
    expect(h.clickCalls).toBe(2);
  });

  it("invalidates a handle before the captcha driver receives the browser", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    await expect(captchaGate(started.session_id)).resolves.toMatchObject({ found: false });
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
  });

  it("invalidates a handle before the payment driver receives the browser", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    await activeProvisionBrowserForPayment(paymentSession(started.session_id));
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
  });

  it("requires sealed V2 handles before bulk selection enters the private executor", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Country",
        selector: "#country",
        selectOptions: [{ value: "kr", text: "South Korea" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    await expect(formSelectMany(started.session_id, { Country: "Korea" })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.selected).toEqual([]);
    await expect(
      formSelectMany(started.session_id, { "@e:legacy_country_1": "Korea" }),
    ).rejects.toThrow("stale_ref");
    expect(h.selected).toEqual([]);
    const result = await formSelectMany(started.session_id, { [handle]: "Korea" });
    expect(result.fields).toEqual([expect.objectContaining({ status: "selected" })]);
    expect(JSON.stringify(result.fields)).not.toContain("South Korea");
    expect(
      JSON.stringify([...paymentSession(started.session_id).committedSelectValues]),
    ).not.toContain("#country");
    expect(result.observation.format).toBe("compact-v2");
  });

  it("keeps a later bulk target actionable when the preceding mutation spares it", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Variant",
        selector: "#variant",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
      elem({
        index: 1,
        tag: "select",
        role: "combobox",
        labelText: "Size",
        selector: "#size",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    h.selectMutation = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Size",
        selector: "#size",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table;
    const variantHandle = rows.find(([, , description]) =>
      description?.startsWith("@variant"),
    )?.[0];
    const sizeHandle = rows.find(([, , description]) => description?.startsWith("@size"))?.[0];
    expect(variantHandle).toMatch(/^@e:/);
    expect(sizeHandle).toMatch(/^@e:/);

    const result = await formSelectMany(started.session_id, {
      [variantHandle!]: "Blue",
      [sizeHandle!]: "Large",
    });

    expect(h.selected).toEqual([
      { selector: "#variant", matcher: "Blue" },
      { selector: "#size", matcher: "Large" },
    ]);
    expect(result.fields).toEqual([
      expect.objectContaining({ status: "selected" }),
      expect.objectContaining({ status: "selected" }),
    ]);
    expect(JSON.stringify(result.fields)).not.toContain("Ocean Blue");
  });

  it("rejects a bulk target the preceding mutation replaced", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Variant",
        selector: "#variant",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
      elem({
        index: 1,
        tag: "select",
        role: "combobox",
        labelText: "Size",
        selector: "#size",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    // The mutation swaps the second control for a DIFFERENT one. The observed
    // Size ref names an element that no longer exists, so it must fail closed
    // rather than slide onto the replacement.
    h.selectMutation = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Shipping",
        selector: "#shipping",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table;
    const variantHandle = rows.find(([, , description]) =>
      description?.startsWith("@variant"),
    )?.[0];
    const sizeHandle = rows.find(([, , description]) => description?.startsWith("@size"))?.[0];

    const result = await formSelectMany(started.session_id, {
      [variantHandle!]: "Blue",
      [sizeHandle!]: "Large",
    });

    expect(h.selected).toEqual([{ selector: "#variant", matcher: "Blue" }]);
    expect(result.fields).toEqual([
      expect.objectContaining({ status: "selected" }),
      expect.objectContaining({ status: "failed", reason: "stale_ref" }),
    ]);
  });

  it("normalizes private browser selection failures in V2 results", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Variant",
        selector: "#private-variant-selector",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    h.selectError = new Error(
      'select <select> #private-variant-selector: option "Private option" was not found',
    );

    const result = await formSelectMany(started.session_id, { [handle]: "Missing" });

    expect(result.fields).toEqual([
      expect.objectContaining({ status: "failed", reason: "selection_failed" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private-variant-selector");
    expect(JSON.stringify(result)).not.toContain("Private option");
  });

  it("normalizes private browser selection failures from direct V2 actions", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "Variant",
        selector: "#shipping-frame",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const handle = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table[0]![0];
    h.selectError = new Error(
      'select <select> #shipping-frame: option "Private option" was not found',
    );

    const error = await act(started.session_id, {
      kind: "select",
      target: handle,
      text: "Missing",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("selection_failed");
    expect((error as Error).message).not.toContain("shipping-frame");
    expect((error as Error).message).not.toContain("Private option");
  });

  it("refuses a cross-origin frame target without retiring the later ref", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({
        tag: "select",
        role: "combobox",
        labelText: "External variant",
        selector: "#external-variant",
        frameOrigin: "https://untrusted.example",
        frameUrl: "https://untrusted.example/variant",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
      elem({
        index: 1,
        tag: "select",
        role: "combobox",
        labelText: "Size",
        selector: "#size",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table;
    const externalHandle = rows.find(([, , facts]) => facts?.startsWith("@external-variant"))?.[0];
    const sizeHandle = rows.find(([, , facts]) => facts?.startsWith("@size"))?.[0];

    const result = await formSelectMany(started.session_id, {
      [externalHandle!]: "Blue",
      [sizeHandle!]: "Large",
    });

    expect(h.selected).toEqual([{ selector: "#size", matcher: "Large" }]);
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "target_not_allowed",
      }),
      expect.objectContaining({ status: "selected" }),
    ]);
  });
});

// Over-broad node redaction on live Shopify checkouts masked the shipping
// block ("pin" substring-matched inside "shipping", and a broad vendor-token
// heuristic matched checkout DOM slugs like checkout_shipping_address_address1),
// which emptied operate_observe_query results for shipping-method radios and
// magenta-masked addresses, prices, and radio labels. Node redaction must stay
// exactly: injected vault values + tight secret-shape signatures.
describe("Compact V2 checkout copy stays unredacted", () => {
  const checkoutUrl = "https://shop.example.com/checkouts/c/token?_r=revalidated";

  function shopifyCheckoutFixture(): unknown[] {
    return [
      elem({
        tag: "input",
        role: "textbox",
        labelText: "Address",
        name: "checkout[shipping_address][address1]",
        id: "checkout_shipping_address_address1",
        selector: "#checkout_shipping_address_address1",
        autocomplete: "shipping address-line1",
        required: true,
        value: "",
      }),
      elem({
        index: 1,
        tag: "input",
        role: "textbox",
        labelText: "City",
        name: "checkout[shipping_address][city]",
        id: "checkout_shipping_address_city",
        selector: "#checkout_shipping_address_city",
        autocomplete: "shipping address-level2",
        value: "",
      }),
      elem({
        index: 2,
        tag: "input",
        type: "radio",
        role: "radio",
        labelText: "Standard $8.00",
        name: "checkout[shipping_rate][id]",
        id: "checkout_shipping_rate_standard",
        selector: "#checkout_shipping_rate_standard",
        checked: true,
      }),
      elem({
        index: 3,
        tag: "input",
        type: "radio",
        role: "radio",
        labelText: "Express $15.00",
        name: "checkout[shipping_rate][id]",
        id: "checkout_shipping_rate_express",
        selector: "#checkout_shipping_rate_express",
        checked: false,
      }),
    ];
  }

  it("exposes shipping-method radios in the V2 map and their query results", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = shopifyCheckoutFixture();

    const started = await startProvisionSession({ serviceUrl: checkoutUrl });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table;

    // Both shipping-rate options are in the map with role radio and their
    // price-bearing labels; the standard option carries its checked state.
    const radioRows = rows.filter(([, role]) => role === "r");
    expect(radioRows).toHaveLength(2);
    const facts = radioRows.map(([, , rowFacts]) => rowFacts ?? "");
    expect(facts.some((value) => value.startsWith("@standard-8-00"))).toBe(true);
    expect(facts.some((value) => value.startsWith("@express-15-00"))).toBe(true);
    expect(facts.find((value) => value.startsWith("@standard-8-00"))).toContain("s=c");

    // operate_observe_query resolves the shipping methods — previously EMPTY
    // when the radios were redacted out of the map.
    retainActivePaymentFieldSeal();
    const queried = (await observeQuery(started.session_id, "shipping", "radio")) as {
      safe_table: Array<[string, string, string?]>;
    };
    expect(queried.safe_table).toHaveLength(2);
    const queriedLabels = queried.safe_table.map(([, , rowFacts]) => rowFacts ?? "");
    expect(queriedLabels.some((value) => value.startsWith("@standard-8-00"))).toBe(true);
    expect(queriedLabels.some((value) => value.startsWith("@express-15-00"))).toBe(true);

    // The queried ref is selectable through the normal act path.
    const expressRef = queried.safe_table.find(([, , rowFacts]) =>
      rowFacts?.startsWith("@express-15-00"),
    )![0]!;
    await act(started.session_id, { kind: "click", target: expressRef });
    expect(h.clickCalls).toBe(1);
  });

  it("keeps address and shipping copy visible in the legacy observation text", async () => {
    // V2 off (forced by beforeEach): the legacy observation renders page text.
    h.visibleText =
      "Shipping address\n350 5th Ave, New York, NY 10118\nShipping method: Standard $8.00";
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        labelText: "Address",
        name: "checkout[shipping_address][address1]",
        id: "checkout_shipping_address_address1",
        selector: "#checkout_shipping_address_address1",
        autocomplete: "shipping address-line1",
        value: "350 5th Ave",
      }),
      elem({
        index: 1,
        tag: "input",
        type: "radio",
        role: "radio",
        labelText: "Standard $8.00",
        name: "checkout[shipping_rate][id]",
        id: "checkout_shipping_rate_standard",
        selector: "#checkout_shipping_rate_standard",
        checked: true,
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: checkoutUrl });
    const observation = (await observe(started.session_id, "full")) as unknown as {
      text: string;
      elements: Array<{ role?: string; label?: string }>;
    };
    expect(observation.text).toContain("350 5th Ave, New York, NY 10118");
    expect(observation.text).toContain("Standard $8.00");
    // The radio row itself is present with its price label, not sealed out.
    const radioElement = observation.elements.find((entry) => entry.role === "radio");
    expect(radioElement?.label).toContain("Standard $8.00");
  });

  it("still redacts injected vault values and tight secret shapes from observation text", async () => {
    const secret = "injected-1234567890abcdef";
    h.visibleText =
      "API key: sk-proj-1234567890abcdefghijklmnopqrstuv Recovery code: 814226 Your 2FA code is 553218";
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        labelText: "Address",
        name: "checkout[shipping_address][address1]",
        id: "checkout_shipping_address_address1",
        selector: "#checkout_shipping_address_address1",
        autocomplete: "shipping address-line1",
        value: "",
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: checkoutUrl });
    // An operator-injected vault value reflected onto the page copy.
    stashSecretSlot(started.session_id, "login", secret);
    h.visibleText = `${h.visibleText} ${secret}`;
    const observed = await observe(started.session_id, "full");
    expect(observed.text).not.toContain("sk-proj-1234567890abcdefghijklmnopqrstuv");
    expect(observed.text).not.toContain("814226");
    expect(observed.text).not.toContain("553218");
    expect(observed.text).not.toContain(secret);
  });
});

// docs/observation-model.md §4.1/§4.2 — the identity model's own contract.
describe("Compact V2 durable ref identity", () => {
  function field(index: number, overrides: Record<string, unknown>): unknown {
    return elem({
      index,
      tag: "input",
      type: "text",
      role: "textbox",
      inViewport: true,
      screenPath: "form:checkout > input",
      ...overrides,
    });
  }

  it("fills a multi-field form from ONE observation while the page re-renders", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const fields = [
      field(0, { id: "first-name", labelText: "First name", selector: "#first-name" }),
      field(1, { id: "email", labelText: "Email", selector: "#email" }),
      // No authored id: this one rides the structural fallback.
      field(2, { labelText: "City", selector: "form > div:nth-child(3) > input" }),
      field(3, { id: "postal", labelText: "Postal code", selector: "#postal" }),
    ];
    h.elements = fields;
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const refs = (
      started as unknown as { safe_table: Array<[string, string, string?]> }
    ).safe_table.map(([ref]) => ref);
    expect(refs).toHaveLength(4);

    const values = ["Ada", "ada@example.com", "Cambridge", "CB2 1TN"];
    for (const [index, ref] of refs.entries()) {
      // detail:"none" — no observation between acts at all, so every ref comes
      // from the single observation the session started with.
      await act(started.session_id, { kind: "type", target: ref, text: values[index]! }, "none");
      // The form re-renders between every act: a validation flag flips and the
      // framework hands out fresh selectors. Neither is an identity change.
      h.elements = fields.map((entry, position) => ({
        ...(entry as Record<string, unknown>),
        required: position <= index,
        selector: `${(entry as { selector: string }).selector}.render-${index}`,
      }));
    }

    expect(h.typed.map((entry) => (entry as { text: string }).text)).toEqual(values);
    expect(h.extractInteractiveElementsCalls).toBeGreaterThan(0);
  });

  it("survives a useId re-render, and dies on a real navigation", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", id: ":r3:", visibleText: "Continue", selector: "#a" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const ref = (started as unknown as { safe_table: Array<[string]> }).safe_table[0]![0];

    // React re-runs useId: the id is different every render, so it must not be
    // part of the fingerprint.
    h.elements = [
      elem({ tag: "button", role: "button", id: ":r9:", visibleText: "Continue", selector: "#b" }),
    ];
    await act(started.session_id, { kind: "click", target: ref });
    expect(h.clickCalls).toBe(1);

    // A real navigation replaces the document and retires the ref.
    h.mainDocumentEpoch += 1;
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(1);
  });

  it("refuses a label shared by two grid controls, and acts on either ref", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [0, 1].map((index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: "Add to cart",
        screenPath: "main > button:add",
        selector: `.product:nth-child(${index + 1}) button`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });
    const rows = (started as unknown as { safe_table: Array<[string, string, string?]> })
      .safe_table;
    expect(rows.map(([, , facts]) => facts)).toEqual([
      "@add-to-cart|a=add_to_cart",
      "@add-to-cart|a=add_to_cart",
    ]);
    // Same label, different fingerprints.
    expect(rows[0]![0]).not.toBe(rows[1]![0]);

    const error = await act(started.session_id, {
      kind: "click",
      target: "@add-to-cart",
    }).catch((cause: unknown) => cause);
    expect((error as Error).message).toContain('ambiguous_target: "@add-to-cart" names 2 controls');
    expect((error as Error).message).toContain(rows[0]![0]);
    expect((error as Error).message).toContain(rows[1]![0]);
    expect(h.clickCalls).toBe(0);

    await act(started.session_id, { kind: "click", target: rows[1]![0] });
    expect(h.clickCalls).toBe(1);
  });

  it("acts on a label that names exactly one control", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      elem({ index: 1, tag: "button", role: "button", visibleText: "Cancel", selector: "#cancel" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    await act(started.session_id, { kind: "click", target: "@continue" });
    expect(h.clickCalls).toBe(1);
  });

  it("keeps the default observation bounded on a large product grid", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    // 240 controls: a long storefront grid plus a full checkout form.
    h.elements = Array.from({ length: 240 }, (_, index) =>
      elem({
        index,
        tag: index % 3 === 0 ? "button" : "input",
        type: index % 3 === 0 ? "button" : "text",
        role: index % 3 === 0 ? "button" : "textbox",
        id: `product-control-${index}-with-a-long-authored-identifier`,
        labelText: `Add to cart ${index}`,
        ariaLabel: `Add the ${index}th product to your shopping cart right now`,
        selector: `.grid .product-${index} .control-${index}`,
      }),
    );
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/products",
    });
    const bytes = Buffer.byteLength(JSON.stringify(started), "utf8");
    expect(bytes).toBeLessThanOrEqual(OBSERVE_V2_MAX_TOKENS);
    // Bounded, not proportional to the page: the rest is behind overflow.
    expect((started as unknown as { safe_table: unknown[] }).safe_table.length).toBeLessThanOrEqual(
      4,
    );
    expect((started.overflow as { remaining: number }).remaining).toBeGreaterThan(200);

    // Paging stays bounded too.
    const page = await observeQuery(
      started.session_id,
      "",
      undefined,
      (started.overflow as { next_cursor: string }).next_cursor,
    );
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_TOKENS,
    );
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
    await captureScreenshot(obs.session_id);
    expect(h.capturedSealedFieldKeys).toEqual([["Password"]]);
  });

  it("redacts a sealed slot reflected into observation text and control metadata", async () => {
    const secret = "stored-credential-7f3d9a";
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(started.session_id, "login", secret);
    h.visibleText = `Saved credential preview: ${secret}`;
    h.elements = [
      elem({
        selector: "#reflected",
        labelText: `Autocomplete preview ${secret}`,
        ariaLabel: `Saved value ${secret}`,
        value: secret,
      }),
    ];

    const full = await observe(started.session_id, "full");
    expect(full.text).toContain("[sealed]");
    expect(JSON.stringify(full)).not.toContain(secret);
  });

  it("keeps the screenshot redaction posture on the default path and widens it only under the debug switch", async () => {
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await captureScreenshot(started.session_id);
    // Default path: no redaction options — byte-identical to the pre-flag call.
    expect(h.capturedRedactionOptions).toEqual([undefined]);

    const previous = process.env.SQUIRE_OBSERVE_REDACTION_DEBUG;
    process.env.SQUIRE_OBSERVE_REDACTION_DEBUG = "1";
    try {
      h.capturedRedactionOptions = [];
      await captureScreenshot(started.session_id);
      expect(h.capturedRedactionOptions).toEqual([
        { shapeRedaction: false, unstablePolicy: "union" },
      ]);

      // Vault guarantee holds under the flag: a reflected slot value is still
      // scrubbed from observation text (only the SHAPE heuristics lift).
      const secret = "stored-credential-7f3d9a";
      stashSecretSlot(started.session_id, "login", secret);
      h.visibleText = `API key: sk-proj-1234567890abcdefghijklmnopqrstuv ${secret}`;
      h.elements = [];
      const full = await observe(started.session_id, "full");
      expect(full.text).toContain("[sealed]");
      expect(full.text).toContain("sk-proj-1234567890abcdefghijklmnopqrstuv");
      expect(full.text).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.SQUIRE_OBSERVE_REDACTION_DEBUG;
      else process.env.SQUIRE_OBSERVE_REDACTION_DEBUG = previous;
    }
    h.capturedRedactionOptions = [];
    await captureScreenshot(started.session_id);
    expect(h.capturedRedactionOptions).toEqual([undefined]);
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
  it("feeds only Neon's exact login route into the browser request scope", async () => {
    await startProvisionSession({ serviceUrl: "https://neon.com/signup" });

    expect(h.hostScopeProviders).toHaveLength(1);
    expect(h.hostScopeProviders[0]!.allowedHosts()).toEqual(["neon.com", "console.neon.tech"]);
    expect(h.hostScopeProviders[0]!.siblingDomainHosts()).toEqual(["neon.com"]);
  });

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
    expect(h.typed).toEqual([{ selector: "#sealed", text: sealedPan, sealed: true }]);
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

  it("returns target_stale with replacement hints instead of a bare ref error", async () => {
    h.elements = [elem({ tag: "select", labelText: "Variant", selector: "#variant" })];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const staleRef = parseElementsTable(started.el_table ?? "")[0]?.ref;
    expect(staleRef).toMatch(/^@e:/);

    // This is the captured P3 shape: a variant change replaces the old form
    // controls before the next queued action gets to resolve its old ref.
    h.elements = [elem({ tag: "select", labelText: "Size", selector: "#size" })];
    const result = (await provisionActTool.handler(
      { session_id: started.session_id, kind: "select", target: staleRef!, text: "Large" },
      null,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "target_stale",
      after_generation: expect.any(Number),
      reobserve_required: true,
      retry_policy: "do_not_retry_old_ref",
    });
    expect(result.replacement_candidates).toMatchObject({ Size: [expect.stringMatching(/^@e:/)] });
    expect(JSON.stringify(result)).not.toContain("no element matched target");
  });

  it("serializes coupled selects, refreshes after variant DOM churn, and reports partial failure", async () => {
    h.visibleText = "Configure product";
    h.elements = [
      elem({
        tag: "select",
        labelText: "Variant",
        selector: "#variant",
        selectOptions: [{ value: "blue", text: "Ocean Blue" }],
      }),
    ];
    h.selectMutation = [
      elem({
        tag: "select",
        labelText: "Size",
        selector: "#size",
        selectOptions: [{ value: "large", text: "Large" }],
      }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });

    const result = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: started.session_id,
        kind: "select_many",
        selections: {
          Variant: "Blue",
          Size: "Large",
          Color: "Red",
        },
      }),
      null,
    )) as Awaited<ReturnType<typeof formSelectMany>>;

    expect(h.selected).toEqual([
      { selector: "#variant", matcher: "Blue" },
      { selector: "#size", matcher: "Large" },
    ]);
    expect(result.fields).toMatchObject([
      {
        label: "Variant",
        option: "Blue",
        status: "selected",
        selected_option: "Ocean Blue",
      },
      { label: "Size", option: "Large", status: "selected", selected_option: "Large" },
      { label: "Color", option: "Red", status: "failed" },
    ]);
    expect(result.observation.session_id).toBe(started.session_id);
    expect(h.extractInteractiveElementsCalls).toBe(7);
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

  it("keeps vault-store extraction reachable through operate_act without returning the secret", async () => {
    const rawSecret = "sk-live-folded-extract-secret-123456789";
    h.visibleText = `API key ${rawSecret}`;
    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/api-keys",
    });
    const storeCredential = vi.fn().mockResolvedValue({
      reference: "vault://acct/folded-extract",
      service: "example",
      label: "default",
      field_names: ["api_key"],
      allowed_hosts: ["app.example.com"],
      created_at: "now",
      updated: false,
    });
    const api = { storeCredential } as unknown as ApiClient;

    const result = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: started.session_id,
        kind: "extract",
        store: { service: "example" },
      }),
      api,
    )) as Record<string, unknown>;

    expect(storeCredential).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      session_id: started.session_id,
      stored_credential: { reference: "vault://acct/folded-extract" },
    });
    expect(JSON.stringify(result)).not.toContain(rawSecret);
  });

  it("seals raw Compact V2 extraction results at the public tool boundary", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const rawSecret = "sk-live-public-extract-secret-123456789";
    const urlToken = "private-url-token-123456789";
    h.visibleText = `API key ${rawSecret}`;
    const started = await startProvisionSession({
      serviceUrl: `https://app.example.com/api-keys?token=${urlToken}`,
    });

    const result = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: started.session_id,
        kind: "extract",
      }),
      null,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      session_id: started.session_id,
      url: "",
      credentials: {},
    });
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain(urlToken);
  });
});

describe("operate session — live-profile precondition gate", () => {
  it("fails closed after probing the real profile with no live Google session", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-empty";
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.providers = []; // no live session
    h.liveGoogleEmail = null;
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      profileDir: canonical,
    });
    expect(obs.needs_user).toBeDefined();
    expect(obs.needs_user?.wall).toBe("google_session");
    expect(obs).toMatchObject({ format: "compact-v2", stage: "auth", url: "", text: "" });
    expect(obs.elements).toBeUndefined();
    expect(h.startCalls).toBe(1);
    expect(h.started).toBe(0); // the rejected profile is closed before handoff
    expect(h.gotos).toHaveLength(0);
    expect(h.identityProbeCalls).toBe(1); // warm the real context before provider admission
    expect(h.storageStateReads).toEqual([]);
    expect(h.profileDirs).toEqual([canonical]);
    expect(h.destroyedProfiles).toEqual([]);
    expect(h.storageStateWrites).toEqual([]);
    await expect(finishProvisionSession(obs.session_id)).resolves.toEqual({
      session_id: obs.session_id,
      url: "",
      closed: true,
    });
  });

  it("uses the supplied real profile without a storage-state handoff", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-seeded";
    h.providers = ["google"];
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      profileDir: canonical,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(h.started).toBe(1);
    expect(h.identityProbeCalls).toBe(2); // warm admission, then optional session metadata
    expect(h.seededStorageStates).toEqual([undefined]);
    expect(h.profileDirs).toEqual([canonical]);
    await finishProvisionSession(obs.session_id);
    expect(h.destroyedProfiles).toEqual([]);
  });

  it("admits a live Google provider probe without requiring account-email metadata", async () => {
    h.providers = ["google"];
    h.liveGoogleEmail = null;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(obs.needs_user).toBeUndefined();
    await expect(finishProvisionSession(obs.session_id)).resolves.toMatchObject({ closed: true });
  });

  it("accepts the live provider probe without consulting a snapshot", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-probe-only";
    h.providers = ["google"];
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      profileDir: canonical,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(h.started).toBe(1);
    await finishProvisionSession(obs.session_id);
  });

  it("does not create or destroy an ephemeral profile", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(h.createdProfiles).toEqual([]);
    await finishProvisionSession(obs.session_id);
    expect(h.destroyedProfiles).toEqual([]);
  });
});

describe("operate session — real-profile lifecycle", () => {
  it("holds the profile lease for the complete session and releases it on finish", async () => {
    const profileDir = "/tmp/trusty-squire-unit-live-profile-lease";
    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/one",
      profileDir,
    });
    expect(() => acquireProfileOperationGuard(profileDir)).toThrow(
      /another Trusty Squire session/i,
    );
    await finishProvisionSession(started.session_id);
    const lease = acquireProfileOperationGuard(profileDir);
    lease.release();
  });

  it("refuses a live profile holder before launching a browser", async () => {
    const profileDir = "/tmp/trusty-squire-unit-live-profile-busy";
    const lease = acquireProfileOperationGuard(profileDir);
    try {
      await expect(
        startProvisionSession({ serviceUrl: "https://app.example.com/one", profileDir }),
      ).rejects.toThrow(/another Trusty Squire session/i);
      expect(h.started).toBe(0);
    } finally {
      lease.release();
    }
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
    const res = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: sid,
        kind: "await_verification",
        into_slot: "otp",
      }),
      null,
    )) as Awaited<ReturnType<typeof awaitVerification>>;

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
    const canonical = "/tmp/trusty-squire-unit-canonical-gmail-read";
    const googleState = {
      cookies: [
        {
          name: "SID",
          value: "live-google-session-for-gmail",
          domain: ".google.com",
          path: "/",
        },
      ],
      origins: [{ origin: "https://mail.google.com", localStorage: [] }],
    };
    h.storageStates.set(canonical, googleState);
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
      profileDir: canonical,
    });
    h.currentUrl = "https://app.example.com/verify-email";
    h.visibleText = "Your verification code is 481920.";
    h.captureStorageStates.set(1, {
      ...googleState,
      origins: [
        {
          origin: "https://mail.google.com",
          localStorage: [{ name: "state", value: "x".repeat(4 * 1024 * 1024) }],
        },
      ],
    });
    const res = await awaitVerification(obs.session_id, {});
    expect(res.code).toBe("481920");
    expect(res.sealed).toBeUndefined();
    expect(h.seededStorageStates).toEqual([undefined]);
    expect(h.connections[0]).toBe(true);
    expect(h.temporaryHostScopes).toEqual([
      { hosts: ["mail.google.com"], phase: "enter" },
      { hosts: ["mail.google.com"], phase: "exit" },
    ]);
    expect(h.currentUrl).toContain("mail.google.com");
    expect(h.storageStateWrites).toEqual([]);
    expect(h.storageStates.get(canonical)).toEqual(googleState);
  });

  it("recursively seals delegated verification results in Compact V2 only", async () => {
    const rawCode = "481920";
    const rawSender = "private.sender@example.com";
    const rawLink = "https://app.example.com/verify?token=private-link-token-123456789";

    const legacy = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = `From: Sender <${rawSender}>\nYour verification code is ${rawCode}.`;
    h.elements = [elem({ tag: "a", role: "link", href: rawLink, visibleText: "Confirm" })];
    h.openFirstMailResult = true;
    const legacyResult = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: legacy.session_id,
        kind: "await_verification",
      }),
      null,
    )) as Record<string, unknown>;

    expect(legacyResult).toMatchObject({
      code: rawCode,
      link: rawLink,
      source_from: rawSender,
    });
    await finishProvisionSession(legacy.session_id);

    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const compact = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = `From: Sender <${rawSender}>\nYour verification code is ${rawCode}.`;
    h.elements = [elem({ tag: "a", role: "link", href: rawLink, visibleText: "Confirm" })];
    h.openFirstMailResult = true;
    const compactResult = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: compact.session_id,
        kind: "await_verification",
      }),
      null,
    )) as Record<string, unknown>;

    expect(compactResult).toMatchObject({
      found: true,
      code: null,
      link: null,
      source_from: null,
    });
    expect(JSON.stringify(compactResult)).not.toContain(rawCode);
    expect(JSON.stringify(compactResult)).not.toContain(rawSender);
    expect(JSON.stringify(compactResult)).not.toContain("private-link-token");
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

  it("seals sender text before writing a Compact V2 verification audit", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const privateSender = "private.sender@example.com";
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = `From: Sender <${privateSender}>\nYour verification code is 481920.`;
    h.openFirstMailResult = true;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const result = await awaitVerification(obs.session_id, {});
      const auditLine = stderrWrite.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('"event":"await_verification"'));

      expect(result.source_from).toBe(privateSender);
      expect(auditLine).toBeDefined();
      expect(auditLine).not.toContain(privateSender);
      expect(auditLine).toContain('"source_from":"<sealed>"');
    } finally {
      stderrWrite.mockRestore();
    }
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

    const res = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: obs.session_id,
        kind: "solve_captcha",
      }),
      null,
    )) as Awaited<ReturnType<typeof captchaGate>>;

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
    expect(res.needs_user?.remedy).toContain("operate_start");
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

describe("operate_finish lifecycle consolidation", () => {
  it("owns the session before outcome extraction begins", async () => {
    const previousAutoPromote = process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
    process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = "0";
    let releaseExtraction: (() => void) | undefined;
    h.visibleText = "API key sk-live-finish-exclusive-123456789";
    const storeCredential = vi.fn().mockResolvedValue({
      reference: "vault://acct/finish-exclusive",
      service: "example",
      label: "default",
      field_names: ["api_key"],
      allowed_hosts: ["app.example.com"],
      created_at: "now",
      updated: false,
    });
    const api = { storeCredential } as unknown as ApiClient;
    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/api-keys",
    });
    h.visibleTextGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });

    try {
      const finishing = provisionFinishTool.handler(
        {
          session_id: started.session_id,
          outcome: { kind: "credentials", store: { service: "example" } },
        },
        api,
      );
      await vi.waitFor(() => expect(h.extractVisibleTextCalls).toBeGreaterThan(0));

      await expect(
        provisionFinishTool.handler({ session_id: started.session_id }, null),
      ).rejects.toThrow(/already closing/);
      expect(h.closeCalls).toBe(0);

      releaseExtraction?.();
      await expect(finishing).resolves.toMatchObject({
        kind: "credentials",
        stored_credential: { reference: "vault://acct/finish-exclusive" },
      });
      expect(h.closeCalls).toBe(1);
    } finally {
      releaseExtraction?.();
      if (previousAutoPromote === undefined) delete process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
      else process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = previousAutoPromote;
    }
  });

  it("keeps the no-outcome close shape identical with explicit or omitted kind=none", async () => {
    const legacySession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const legacy = (await provisionFinishTool.handler(
      { session_id: legacySession.session_id },
      null,
    )) as Record<string, unknown>;

    const consolidatedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const consolidated = (await provisionFinishTool.handler(
      {
        session_id: consolidatedSession.session_id,
        outcome: { kind: "none" },
      },
      null,
    )) as Record<string, unknown>;

    expect({ ...consolidated, session_id: "normalized" }).toEqual({
      ...legacy,
      session_id: "normalized",
    });
    expect(h.storageStateWrites).toEqual([]);
    expect(h.destroyedProfiles).toEqual([]);
  });

  it("preserves prior state when an explicit credential outcome fails", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-failed-outcome";
    const prior = { cookies: [{ name: "SID", value: "prior" }], origins: [] };
    h.storageStates.set(canonical, prior);
    h.visibleText = "No credential is present";
    const storeCredential = vi.fn();
    const session = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
      profileDir: canonical,
    });

    const result = await provisionFinishTool.handler(
      {
        session_id: session.session_id,
        outcome: { kind: "credentials", store: { service: "example" } },
      },
      { storeCredential } as unknown as ApiClient,
    );

    expect(result).toMatchObject({ kind: "credentials", stored_credential: null });
    expect(storeCredential).not.toHaveBeenCalled();
    expect(h.storageStateWrites).toEqual([]);
    expect(h.storageStates.get(canonical)).toBe(prior);
  });

  it("preserves prior state for failed or unconfirmed result outcomes", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-failed-result";
    const prior = { cookies: [{ name: "SID", value: "prior" }], origins: [] };
    h.storageStates.set(canonical, prior);

    const failedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
      profileDir: canonical,
    });
    const failed = await provisionFinishTool.handler(
      provisionFinishTool.inputSchema.parse({
        session_id: failedSession.session_id,
        outcome: { kind: "result", data: { confirmed: false } },
      }),
      null,
    );

    const unconfirmedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
      profileDir: canonical,
    });
    const unconfirmed = await provisionFinishTool.handler(
      provisionFinishTool.inputSchema.parse({
        session_id: unconfirmedSession.session_id,
        outcome: { kind: "result", summary: "Task stopped before success" },
      }),
      null,
    );

    expect(failed).toMatchObject({ kind: "result", data: { confirmed: "false" } });
    expect(unconfirmed).toMatchObject({ kind: "result", summary: "Task stopped before success" });
    expect(h.storageStateWrites).toEqual([]);
    expect(h.storageStates.get(canonical)).toBe(prior);
  });

  it("seals the current URL from Compact V2 finish results", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const urlToken = "private-finish-token-123456789";
    const started = await startProvisionSession({
      serviceUrl: `https://app.example.com/done?token=${urlToken}`,
    });

    const result = (await provisionFinishTool.handler(
      { session_id: started.session_id },
      null,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      session_id: started.session_id,
      url: "",
      closed: true,
    });
    expect(JSON.stringify(result)).not.toContain(urlToken);
  });

  it("seals Compact V2 measurement service labels before stderr emission", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    const panHost = "4111-1111-1111-1111.com";
    const started = await startProvisionSession({ serviceUrl: `https://${panHost}/done` });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await provisionFinishTool.handler(
        {
          session_id: started.session_id,
          outcome: { kind: "result", summary: "Done" },
        },
        null,
      );
      const measurement = stderrWrite.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('"marker":"provision-measurement"'));

      expect(measurement).toBeDefined();
      expect(measurement).not.toContain(panHost);
      expect(measurement).toContain('"service":"<sealed>"');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("returns the legacy result shape from outcome=result, including scalar data coercion", async () => {
    const legacySession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const legacyArgs = provisionFinishTaskTool.inputSchema.parse({
      session_id: legacySession.session_id,
      kind: "result",
      summary: "Task complete",
      data: { confirmed: true, count: 2 },
    });
    const legacy = await provisionFinishTaskTool.handler(legacyArgs, null);

    const consolidatedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const consolidatedArgs = provisionFinishTool.inputSchema.parse({
      session_id: consolidatedSession.session_id,
      outcome: {
        kind: "result",
        summary: "Task complete",
        data: { confirmed: true, count: 2 },
      },
    });
    const consolidated = await provisionFinishTool.handler(consolidatedArgs, null);

    expect(consolidated).toEqual(legacy);
    expect(consolidated).toMatchObject({
      kind: "result",
      summary: "Task complete",
      data: { confirmed: "true", count: "2" },
    });
  });

  it("returns the legacy credential result without leaking the extracted value", async () => {
    const secret = "sk-live-finish-parity-secret-123456789";
    const previousAutoPromote = process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
    process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = "0";
    try {
      const storeCredential = vi.fn().mockImplementation(async (input: { service: string }) => ({
        reference: "vault://acct/finish-parity",
        service: input.service,
        label: "default",
        field_names: ["api_key"],
        allowed_hosts: ["app.example.com"],
        created_at: "now",
        updated: false,
      }));
      const api = { storeCredential } as unknown as ApiClient;

      h.visibleText = `API key ${secret}`;
      const legacySession = await startProvisionSession({
        serviceUrl: "https://app.example.com/api-keys",
      });
      const legacy = await provisionFinishTaskTool.handler(
        {
          session_id: legacySession.session_id,
          kind: "credentials",
          store: { service: "example" },
        },
        api,
      );

      h.visibleText = `API key ${secret}`;
      const consolidatedSession = await startProvisionSession({
        serviceUrl: "https://app.example.com/api-keys",
      });
      const consolidated = await provisionFinishTool.handler(
        {
          session_id: consolidatedSession.session_id,
          outcome: { kind: "credentials", store: { service: "example" } },
        },
        api,
      );

      expect(consolidated).toEqual(legacy);
      expect(consolidated).toMatchObject({
        kind: "credentials",
        stored_credential: { reference: "vault://acct/finish-parity" },
      });
      expect(storeCredential).toHaveBeenCalledTimes(2);
      expect(JSON.stringify({ legacy, consolidated })).not.toContain(secret);
    } finally {
      if (previousAutoPromote === undefined) delete process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
      else process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = previousAutoPromote;
    }
  });

  it("rejects invalid consolidated outcomes at schema parse time", () => {
    expect(
      provisionFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: { kind: "credentials" },
      }).success,
    ).toBe(false);
    expect(
      provisionFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: { kind: "result" },
      }).success,
    ).toBe(false);
    expect(
      provisionFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: { kind: "result", data: { confirmed: true } },
      }).success,
    ).toBe(true);
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
    h.workerEmail = email;
    h.liveGoogleEmail = email;
  }

  it("prepare_login seals the captured user email + a generated password (masked handles only)", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    const legacy = (await provisionPrepareLoginTool.handler(
      { session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as {
      slots: {
        login: { slot: string; preview: string; length: number };
        password: { slot: string; preview: string; length: number };
      };
      email_preview: string;
    };
    const consolidated = (await operateLoginTool.handler(
      { action: "prepare_signup", session_id: obs.session_id },
      null as unknown as ApiClient,
    )) as typeof legacy;
    // The bare-essentials default surface: operate_act{kind:"login_prepare_signup"}.
    const viaAct = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: obs.session_id,
        kind: "login_prepare_signup",
      }),
      null,
    )) as typeof legacy;

    expect(consolidated).toMatchObject({
      session_id: obs.session_id,
      slots: {
        login: { slot: legacy.slots.login.slot, length: legacy.slots.login.length },
        password: { slot: legacy.slots.password.slot, length: legacy.slots.password.length },
      },
      email_preview: legacy.email_preview,
    });
    expect(viaAct).toMatchObject({
      session_id: obs.session_id,
      slots: {
        login: { slot: legacy.slots.login.slot, length: legacy.slots.login.length },
        password: { slot: legacy.slots.password.slot, length: legacy.slots.password.length },
      },
      email_preview: legacy.email_preview,
    });
    // Neither the handle preview nor the email_preview leaks the raw address.
    expect(JSON.stringify({ legacy, consolidated, viaAct })).not.toContain("ada@example.com");
    expect(consolidated.slots.password.length).toBeGreaterThanOrEqual(16);
  });

  it("prepare_login hands back when no user email was captured", async () => {
    const obs = await startHarnessProvisionSession({
      browser: new BrowserController(),
      serviceUrl: "https://app.example.com/",
    });
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

    const captured: {
      service: string;
      type?: string;
      auth_strategy?: string;
      fields?: Record<string, string>;
      login_hosts?: string[];
      signin_url?: string;
    }[] = [];
    const api = {
      storeCredential: async (input: {
        service: string;
        type?: string;
        auth_strategy?: string;
        fields?: Record<string, string>;
        login_hosts?: string[];
        signin_url?: string;
      }) => {
        captured.push(input);
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

    const args = {
      session_id: obs.session_id,
      service: "example",
      login_hosts: ["example.com"],
      signin_url: "https://app.example.com/login",
    };
    const legacy = (await provisionStoreLoginTool.handler(args, api)) as {
      reference: string;
      type: string;
      login_hosts: string[];
    };
    const consolidated = (await operateLoginTool.handler(
      { action: "store_signup", ...args },
      api,
    )) as typeof legacy;
    const viaAct = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...args, kind: "login_store_signup" }),
      api,
    )) as typeof legacy;

    expect(consolidated).toEqual(legacy);
    expect(viaAct).toEqual(legacy);
    expect(captured).toHaveLength(3);
    for (const call of captured) {
      expect(call.type).toBe("username_password");
      expect(call.auth_strategy).toBe("username_password");
      expect(call.fields?.login).toBe("ada@example.com");
      expect((call.fields?.password ?? "").length).toBeGreaterThanOrEqual(16);
      expect(call.login_hosts).toEqual(["example.com", "app.example.com"]);
    }
    expect(legacy.login_hosts).toEqual(["example.com", "app.example.com"]);
    expect(legacy.reference).toBe("vault://acct/login1");
    // The raw password must not appear in the tool's response.
    expect(JSON.stringify({ legacy, consolidated })).not.toContain(
      captured[0]?.fields?.password ?? "UNSET",
    );
  });

  it("seal_vault_credential stashes browser-fill fields as slots without returning raw values", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/login",
      profileDir,
    });
    const captured: {
      current_host: string;
      reference?: string;
      fields: string[];
      encrypted_response_public_key: string;
    }[] = [];
    const api = {
      browserFillCredential: async (input: {
        current_host: string;
        reference?: string;
        fields: string[];
        encrypted_response_public_key: string;
      }) => {
        captured.push(input);
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

    const args = {
      session_id: obs.session_id,
      reference: "vault://acct/login1",
      fields: ["login", "password"],
      slot_prefix: "signin",
    };
    const legacy = (await provisionSealVaultCredentialTool.handler(args, api)) as {
      reference: string;
      slots: Record<string, { slot: string }>;
    };
    const consolidated = (await operateLoginTool.handler(
      { action: "load_saved", ...args },
      api,
    )) as typeof legacy;
    const viaAct = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({ ...args, kind: "login_load_saved" }),
      api,
    )) as typeof legacy;

    expect(consolidated).toEqual(legacy);
    expect(viaAct).toEqual(legacy);
    expect(captured).toHaveLength(3);
    for (const call of captured) {
      expect(call).toMatchObject({
        current_host: "https://app.example.com/login",
        reference: "vault://acct/login1",
        fields: ["login", "password"],
      });
      expect(call.encrypted_response_public_key).toContain("BEGIN PUBLIC KEY");
    }
    expect(legacy.reference).toBe("vault://acct/login1");
    expect(legacy.slots.login?.slot).toBe("signin_login");
    expect(legacy.slots.password?.slot).toBe("signin_password");
    expect(JSON.stringify({ legacy, consolidated })).not.toContain("ada@example.com");
    expect(JSON.stringify({ legacy, consolidated })).not.toContain("correct-horse");

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
      {
        frameUrl: SAME_DOMAIN_FRAME_URL,
        selector: "#password",
        text: "s3cr3t-value",
        sealed: true,
      },
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
// page. The operator's job ends at the fill — operate_act is not otherwise
// blocked from driving the checkout, and Enter/Space presses are never
// gated (they carry no resolvable label). The card VALUES stay masked in
// observations throughout (session.paymentFieldSealActive), which is one
// money-fence pillar — see the masking tests below. A SEPARATE guard
// (placeOrderApproval/placeOrderAttempted) caps operate_act clicks that
// target a checkout-submit-labeled control (CHECKOUT_SUBMIT_LABEL_RE — the
// same label heuristic Squire's own retired single-phase submit used) at
// one attempt per approval — see the place-order-attempt tests below.
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

  it("serializes concurrent payment leases without blocking ordinary clicks", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const claim = claimActivePaymentForOperatePay("fill_card");

    expect(claim.kind).toBe("lease");
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(/already in progress/);
    // operate_act is never gated on an in-flight payment lease — only a
    // second operate_pay call is serialized behind it.
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);

    if (claim.kind !== "lease") throw new Error("expected fill-card payment lease");
    expect(releaseActivePaymentLease(claim.lease, true)).toBe(true);
  });

  it("serializes fill-card behind every other payment lease", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const claim = claimActivePaymentForOperatePay(undefined);
    if (claim.kind !== "lease") throw new Error("expected payment lease");

    expect(() => claimActivePaymentForOperatePay("fill_card")).toThrow(/already in progress/);
    await expect(captureScreenshot(started.session_id)).resolves.toBeDefined();
    expect(h.capturedSealedFieldKeys).toEqual([[]]);
    expect(releaseActivePaymentLease(claim.lease)).toBe(true);
  });

  it("refuses charge clicks while a prior 3DS outcome is unresolved", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
      elem({ tag: "button", type: null, visibleText: "Continue to review", selector: "#next" }),
    ];
    h.visibleText = "Checkout";
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit_close" });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      api: { auditPayment } as unknown as ApiClient,
    });
    setActivePendingThreeDs({
      approval_id: "appr_pending_charge",
      approval_url: "https://web.test/vault/pay/appr_pending_charge",
      checkout: pending.checkout,
      last4: pending.last4,
      deadline: Date.now() + 60_000,
      outcome: "three_ds",
    });

    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /call operate_payment_status first/,
    );
    h.locatorResolve = {
      ok: true,
      text: "Place order",
      labels: ["Place order"],
      safetySignals: { billingObject: false, accountSetup: false },
    };
    await expect(
      act(started.session_id, { kind: "js_click", target: "css=#place-order" }),
    ).rejects.toThrow(/call operate_payment_status first/);
    expect(h.clickCalls).toBe(0);
    expect(h.locatorClickCalls).toBe(0);

    await act(started.session_id, { kind: "click", target: "Continue to review" });
    expect(h.clickCalls).toBe(1);
    await finishProvisionSession(started.session_id);
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

  it("allows non-charge-verb clicks, unlabeled key presses, and oauth_click freely while filled", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
      elem({ tag: "button", type: null, visibleText: "Continue to review", selector: "#next" }),
    ];
    // Non-empty so settleAfterStateChange's post-click text poll resolves on
    // its first check instead of retrying for 1.2s per click.
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    // A non-charge-verb click is never gated by the place-order guard, no
    // matter how many times it fires.
    await act(started.session_id, { kind: "click", target: "Continue to review" });
    expect(h.clickCalls).toBe(1);
    await act(started.session_id, { kind: "click", target: "Continue to review" });
    expect(h.clickCalls).toBe(2);

    // Key presses carry no resolvable label, so they can't be matched against
    // CHECKOUT_SUBMIT_LABEL_RE and are never gated.
    await act(started.session_id, { kind: "press", key: "Enter" });
    await act(started.session_id, { kind: "press", key: "NumpadEnter" });
    h.focusedLabels = ["Pay now"];
    await act(started.session_id, { kind: "press", key: "Space" });
    h.focusedLabels = ["Continue to review"];
    await act(started.session_id, { kind: "press", key: "Space" });
    await act(started.session_id, { kind: "press", key: "Tab" });

    // oauth_click is a distinct action kind (starts an OAuth popup, never a
    // form submit) — it is routed to a different code path entirely and is
    // never gated by the place-order guard, regardless of its target's label.
    await act(started.session_id, { kind: "oauth_click", target: "Place order" });
  });

  it("preserves ordinary checkbox and ARIA-toggle semantics while an approval is active", async () => {
    h.elements = [
      elem({
        tag: "input",
        type: "checkbox",
        checked: false,
        visibleText: null,
        labelText: "Accept terms",
        selector: "#terms",
      }),
      elem({
        tag: "button",
        type: null,
        role: "switch",
        ariaChecked: false,
        visibleText: "Enable alerts",
        selector: "#alerts",
      }),
    ];
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    await act(started.session_id, { kind: "click", target: "Accept terms" });
    await act(started.session_id, { kind: "click", target: "Enable alerts" });

    expect((h.elements[0] as { checked: boolean }).checked).toBe(true);
    expect((h.elements[1] as { ariaChecked: boolean }).ariaChecked).toBe(true);
    expect(h.clickCalls).toBe(2);
  });

  it("allows exactly one charge-verb click per approval, then refuses a repeat — one approval, one place-order attempt", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
      elem({ tag: "button", type: null, visibleText: "Continue to review", selector: "#next" }),
    ];
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    // The FIRST charge-verb click succeeds — this is the caller placing the
    // order.
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);

    // A second charge-verb click on the SAME approval — any click-kind — is
    // refused, whether it's a retry after a perceived failure or a
    // double-click.
    await expect(
      act(started.session_id, { kind: "js_click", target: "Place order" }),
    ).rejects.toThrow(/place-order attempt already fired/);
    expect(h.clickCalls).toBe(1);
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /fresh operate_pay approval is required/,
    );
    expect(h.clickCalls).toBe(1);

    // Non-charge-verb clicks stay completely unaffected by the guard.
    await act(started.session_id, { kind: "click", target: "Continue to review" });
    expect(h.clickCalls).toBe(2);
  });

  it("checks input submit values independently from non-charge aria labels", async () => {
    h.elements = [
      elem({
        tag: "input",
        type: "submit",
        value: "Place order",
        visibleText: null,
        labelText: null,
        ariaLabel: "Checkout",
        selector: "#place-order-input",
      }),
    ];
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    await act(started.session_id, { kind: "click", target: "Checkout" });
    expect(h.clickCalls).toBe(1);
    await expect(act(started.session_id, { kind: "click", target: "Checkout" })).rejects.toThrow(
      /place-order attempt already fired/,
    );
    expect(h.clickCalls).toBe(1);
  });

  it("audits a caller place-order attempt from a recipe-run-created session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recipe-audit-client-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    h.visibleText = "Checkout";
    const auditPayment = vi.fn().mockResolvedValue({ id: "evt_recipe" });
    const api = { auditPayment } as unknown as ApiClient;

    try {
      const started = (await operateRecipeRunTool.handler(
        {
          verb: "purchase",
          service_url: "https://shop.example.com/checkout",
          params: {},
        },
        api,
      )) as { session_id: string; replay: { status: string } };
      expect(started.replay.status).toBe("cache_miss");

      setActivePendingCardFill(pending);
      await act(started.session_id, { kind: "click", target: "Place order" });

      expect(auditPayment).toHaveBeenCalledTimes(1);
      expect(auditPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          approval_id: "appr_guard",
          card_ref: "card_guard",
          status: "payment_place_order_attempted",
        }),
      );
    } finally {
      delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the place-order guard bound to its approval across confirm, resets only on a fresh fill", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);

    // clearActivePendingCardFill(false, ...) is the real confirm-path call
    // (operate-pay.ts) — it moves the session to "sealed" WITHOUT resetting
    // the guard: the same approval's attempt stays consumed either before or
    // after the caller closes out confirm.
    clearActivePendingCardFill(false);
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /place-order attempt already fired/,
    );

    // A verified full clear (paymentFieldsCleared=true) IS a clean slate.
    // Used here only to simulate a genuinely fresh approval's fill — a real
    // session can never refill a card once sealed (Pillar 2).
    clearActivePendingCardFill(true);
    setActivePendingCardFill({ ...pending, approval_id: "appr_guard_2" });
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(2);
  });

  it("records exactly one attempt-semantics audit event for the caller's place-order click", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    h.visibleText = "Checkout";
    const auditPayment = vi.fn().mockResolvedValue({ id: "evt_1" });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      api: { auditPayment } as unknown as ApiClient,
    });
    setActivePendingCardFill(pending);

    await act(started.session_id, { kind: "click", target: "Place order" });

    expect(auditPayment).toHaveBeenCalledTimes(1);
    expect(auditPayment).toHaveBeenCalledWith({
      merchant: "Shop",
      amount_cents: 100,
      currency: "USD",
      last4: "4242",
      card_ref: "card_guard",
      approval_id: "appr_guard",
      // Attempt semantics, never "executed" — Squire cannot verify what the
      // merchant did after the caller's click.
      status: "payment_place_order_attempted",
    });

    // The refused second attempt fires no second audit event.
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /place-order attempt already fired/,
    );
    expect(auditPayment).toHaveBeenCalledTimes(1);
  });

  it.each(["dispatched", "unknown"] as const)(
    "records the attempt when a click throws with %s dispatch state",
    async (dispatchStatus) => {
      h.elements = [
        elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
      ];
      h.visibleText = "Checkout";
      h.trackedClickFailure = {
        dispatchStatus,
        message: "page detached during navigation",
      };
      const auditPayment = vi.fn().mockResolvedValue({ id: "evt_1" });
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/checkout",
        api: { auditPayment } as unknown as ApiClient,
      });
      setActivePendingCardFill(pending);

      await expect(
        act(started.session_id, { kind: "click", target: "Place order" }),
      ).rejects.toThrow(/page detached during navigation/);
      expect(auditPayment).toHaveBeenCalledTimes(1);
      await expect(
        act(started.session_id, { kind: "click", target: "Place order" }),
      ).rejects.toThrow(/place-order attempt already fired/);
      expect(auditPayment).toHaveBeenCalledTimes(1);
    },
  );

  it("does not audit or consume the approval when click dispatch is disproven", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    h.visibleText = "Checkout";
    h.trackedClickFailure = {
      dispatchStatus: "not_dispatched",
      message: "target detached before click",
    };
    const auditPayment = vi.fn().mockResolvedValue({ id: "evt_1" });
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      api: { auditPayment } as unknown as ApiClient,
    });
    setActivePendingCardFill(pending);

    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /target detached before click/,
    );
    expect(auditPayment).not.toHaveBeenCalled();
    expect(h.clickCalls).toBe(0);

    h.trackedClickFailure = null;
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);
    expect(auditPayment).toHaveBeenCalledTimes(1);
  });

  it("does not audit or block when no api client was threaded through", async () => {
    h.elements = [
      elem({ tag: "button", type: null, visibleText: "Place order", selector: "#place-order" }),
    ];
    h.visibleText = "Checkout";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    // No session.api — recordPlaceOrderAttemptAudit is a no-op, but the
    // click itself, and the guard against a second attempt, still work.
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);
    await expect(act(started.session_id, { kind: "click", target: "Place order" })).rejects.toThrow(
      /place-order attempt already fired/,
    );
  });

  it("allows a locator-fallback click on a charge control while filled", async () => {
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

    await act(started.session_id, { kind: "click", target: "text=Pay now" });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("confirm seals the real session, keeps observations masked, permits the caller's click, and allows finish", async () => {
    h.elements = [
      elem({
        id: "card-number",
        autocomplete: "cc-number",
        selector: "#card-number",
        value: "4242424242424242",
      }),
      elem({ tag: "button", type: null, visibleText: "Confirm and pay", selector: "#pay" }),
    ];
    h.visibleText = "Card 4242 4242 4242 4242 · Confirm and pay";
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    setActivePendingCardFill(pending);

    const result = (await operatePayTool.handler(
      operatePayTool.inputSchema.parse({
        session_id: started.session_id,
        phase: "confirm",
        item: "Widget",
        reason: "Synthetic purchase",
      }),
      {} as ApiClient,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "payment_ready_to_place",
      merchant: "Shop",
      amount_cents: 100,
      currency: "USD",
      approval_url: "https://web.test/vault/pay/appr_guard",
    });
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(
      /payment field cleanup remains unverified/,
    );

    const full = await observe(started.session_id, "full");
    expect(JSON.stringify(full)).not.toContain("4242424242424242");
    expect(full.text).toContain("[sealed payment]");

    await act(started.session_id, { kind: "click", target: "Confirm and pay" });
    expect(h.clickCalls).toBe(1);
    await finishProvisionSession(started.session_id);
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
    expect(full.text).toContain("Card preview [sealed payment]");
    expect(full.text).toContain("CVV [sealed");
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

  it("keeps masking after retry state is cleared without DOM cleanup", async () => {
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
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(1);

    clearActivePendingCardFill(true);
    await act(started.session_id, { kind: "click", target: "Place order" });
    expect(h.clickCalls).toBe(2);
  });
});

// [P0] The non-blocking approval rest state: operate_pay no longer holds the
// "operating" lease across a human's phone tap, so a new state exists for
// "the human hasn't responded yet." A later call claims it for live-resource
// validation instead of throwing "already in progress".
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

  it("keeps a denial observed by operate_pay terminal under the owned lease", async () => {
    await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    const terminalState = {
      ...approvalState,
      keypair: { ...approvalState.keypair, privateKey: "terminal-private" },
    };
    const claim = claimActivePaymentForOperatePay(undefined);
    if (claim.kind !== "lease") throw new Error("expected a fresh lease");

    completeActivePaymentLeaseWithTerminalApproval(claim.lease, terminalState, "denied");

    expect(terminalState.keypair.privateKey).toBe("");
    expect(getActivePendingApproval()).toBeNull();
    expect(getTerminalPaymentApproval()).toEqual({
      state: terminalState,
      terminalStatus: "denied",
    });
    expect(claimActivePaymentForOperatePay(undefined)).toEqual({
      kind: "terminal",
      state: terminalState,
      terminalStatus: "denied",
    });
  });
});

// ── operate_pay tool completion — system-owned approval wait [P0] ──────────
//
// The full operate_pay MCP tool (session lease + executeOperatePay), not just
// the pure executeOperatePay unit. A single-page checkout whose card fields
// live in a late-mounting cross-origin PCI iframe: the approval URL is surfaced
// while the call remains open, the server detects the phone response, and the
// same call fills/submits. A no-progress-transport fallback still resumes the
// exact approval on one later call without minting another.
describe("operate_pay tool completion — system-owned approval wait [P0]", () => {
  const CHECKOUT = {
    merchant: "Kobee Japan",
    checkout_origin: "https://store.kobeejapan.net",
    amount_cents: 490_000,
    currency: "JPY",
  };
  const SYNTHETIC_CARD = {
    pan: "4242424242424242",
    exp_month: "12",
    exp_year: "30",
    name: "Synthetic Cardholder",
    cvv: "123",
    billing: {
      line1: "123 Test Street",
      city: "Testville",
      postal_code: "10001",
      country: "US",
    },
  };
  const baseArgs = {
    card_ref: "card_kobee",
    merchant: CHECKOUT.merchant,
    amount_cents: CHECKOUT.amount_cents,
    currency: CHECKOUT.currency,
    item: "Matcha set",
    reason: "gift",
  };

  // Mirrors buildResumableEnv in pay-operator.test.ts but drives the payment
  // through the REAL operate_pay tool + session-lease glue instead of calling
  // executeOperatePay directly — the layer that has no coverage otherwise.
  function buildPaymentEnv(): {
    api: ApiClient;
    fetch: typeof fetch;
    approvalBodies: Array<Record<string, unknown>>;
    immediateApprovalReads: boolean[];
    setApproved: () => void;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let approved = false;
    const approvalBodies: Array<Record<string, unknown>> = [];
    const immediateApprovalReads: boolean[] = [];
    const nonce = "kobee-nonce";
    const agent = "kobee-agent";
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://vouchflow.test/.well-known/jwks.json") {
        const jwk = await exportJWK(publicKey);
        return Response.json({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "test-key" }] });
      }
      if (url.endsWith("/v1/pay/approvals") && init?.method === "POST") {
        approvalBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json(
          { id: "appr_kobee", nonce, agent, expires_at: expiresAt },
          { status: 201 },
        );
      }
      if (
        (url.endsWith("/v1/pay/approvals/appr_kobee") ||
          url.includes("/v1/pay/approvals/appr_kobee?wait_for_submission=1") ||
          url.endsWith("/v1/pay/approvals/appr_kobee?read_submission=1")) &&
        init?.method === "GET"
      ) {
        const approval = approvalBodies[0]!;
        const operatorPublicKey = String(approval.operator_pubkey);
        const readsRelayCandidate =
          url.includes("?wait_for_submission=1") || url.endsWith("?read_submission=1");
        if (url.endsWith("?read_submission=1")) immediateApprovalReads.push(approved);
        if (!approved || !readsRelayCandidate) {
          return Response.json({
            id: "appr_kobee",
            status: "pending",
            ...CHECKOUT,
            nonce,
            card_ref: "card_kobee",
            operator_pubkey: operatorPublicKey,
            jws: null,
            sealed_card: null,
            expires_at: expiresAt,
          });
        }
        const recipientHash = createHash("sha256")
          .update(Buffer.from(operatorPublicKey, "base64url"))
          .digest("base64url");
        const canonical = canonicalize({
          approval_id: "appr_kobee",
          merchant: CHECKOUT.merchant,
          checkout_origin: CHECKOUT.checkout_origin,
          amount_cents: CHECKOUT.amount_cents,
          currency: CHECKOUT.currency,
          nonce,
          card_ref: "card_kobee",
          recipient_pubkey_hash: recipientHash,
          item: approval.item,
          reason: approval.reason,
          agent,
        })!;
        const aad = createHash("sha256").update(canonical, "utf8").digest();
        const jws = await new SignJWT({
          payload_sha256: aad.toString("base64url"),
          context: "purchase",
          confidence: "high",
          mandate_id: "mandate_kobee",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://vouchflow.dev")
          .setAudience("customer_test")
          .sign(privateKey);
        const sealed_card = await sealToRecipient(
          operatorPublicKey,
          new TextEncoder().encode(JSON.stringify(SYNTHETIC_CARD)),
          aad,
        );
        return Response.json({
          id: "appr_kobee",
          status: "approved",
          ...CHECKOUT,
          nonce,
          card_ref: "card_kobee",
          operator_pubkey: operatorPublicKey,
          jws,
          sealed_card,
          expires_at: expiresAt,
        });
      }
      if (url.endsWith("/v1/pay/approvals/appr_kobee/confirm") && init?.method === "POST") {
        return Response.json({ status: "approved" });
      }
      if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
        return Response.json({ id: "audit_kobee" }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;

    const api = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "synthetic-session-token",
      fetch: fetchMock,
    });

    return {
      api,
      fetch: fetchMock,
      approvalBodies,
      immediateApprovalReads,
      setApproved: () => (approved = true),
    };
  }

  let originalAudience: string | undefined;
  let originalVouchflowBase: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalAudience = process.env.VOUCHFLOW_EXPECTED_AUDIENCE;
    originalVouchflowBase = process.env.VOUCHFLOW_API_BASE;
    process.env.VOUCHFLOW_EXPECTED_AUDIENCE = "customer_test";
    process.env.VOUCHFLOW_API_BASE = "https://vouchflow.test";
    originalFetch = global.fetch;
    h.checkoutSummary = CHECKOUT;
    h.isPayPalHostedCheckout = false;
  });
  afterEach(() => {
    if (originalAudience === undefined) delete process.env.VOUCHFLOW_EXPECTED_AUDIENCE;
    else process.env.VOUCHFLOW_EXPECTED_AUDIENCE = originalAudience;
    if (originalVouchflowBase === undefined) delete process.env.VOUCHFLOW_API_BASE;
    else process.env.VOUCHFLOW_API_BASE = originalVouchflowBase;
    global.fetch = originalFetch;
  });

  it("detects the phone approval and submits in the same operate_pay call", async () => {
    const env = buildPaymentEnv();
    // executeOperatePay's own JWKS fetch goes through the real global fetch
    // (the tool layer never overrides deps.fetch) — route it through the same
    // mock backing the ApiClient.
    global.fetch = env.fetch;

    await startProvisionSession({ serviceUrl: "https://store.kobeejapan.net/checkout" });

    const notifyUser = vi.fn().mockImplementation(async () => {
      // The notification is delivered before executeOperatePay enters its
      // server-owned wait, so the human can respond while this call is open.
      env.setApproved();
    });
    const result = (await operatePayTool.handler(baseArgs, env.api, { notifyUser })) as Record<
      string,
      unknown
    >;

    expect(result.status).toBe("payment_submitted");
    expect(notifyUser).toHaveBeenCalledOnce();
    // Exactly ONE approval was minted and spent in this call.
    expect(env.approvalBodies).toHaveLength(1);
    expect(h.filledCards).toEqual([SYNTHETIC_CARD]);
    // The lease resolved to a terminal outcome — no dangling approval state
    // for an agent-side polling loop.
    expect(getActivePendingApproval()).toBeNull();
  });
});

// Regression coverage for the decoupled/out-of-band 3DS completion gap
// (companion to pay-operator.test.ts's "a timed-out 3DS wait persists
// resumable state" unit test): operate_payment_status must actually consume
// that resumable state — re-checking the SAME live browser rather than
// leaving it to rot once set.
describe("operate_payment_status — resumable post-submit 3DS wait", () => {
  const CHECKOUT = {
    merchant: "Hibiya Kadan",
    checkout_origin: "https://hibiyakadan.example.test",
    amount_cents: 8_800,
    currency: "JPY",
  };
  function buildThreeDsState(
    deadline = Date.now() + 60_000,
    payment_instrument_mismatch?: {
      kind: "payment_instrument_mismatch";
      confidence: "high" | "low";
      evidence_used: Array<"last4" | "issuer" | "network">;
      expected: { last4: string; issuer?: string; network?: string; label?: string };
      observed: { last4?: string; issuer?: string; network?: string };
      provenance: {
        expected: {
          last4: "released_card";
          issuer?: "bin_metadata" | "vault_metadata" | "vault_label";
          network?: "vault_metadata";
          label?: "vault_label";
        };
        observed: "3ds_challenge";
      };
    },
    outcome: "three_ds" | "unknown" = "three_ds",
  ) {
    return {
      approval_id: "appr_3ds",
      approval_url: "https://web.test/vault/pay/appr_3ds",
      checkout: CHECKOUT,
      last4: "9192",
      mandate_id: "mandate_3ds",
      deadline,
      outcome,
      ...(payment_instrument_mismatch !== undefined ? { payment_instrument_mismatch } : {}),
    };
  }

  function buildStatusEnv(): { api: ApiClient; auditBodies: Array<Record<string, unknown>> } {
    const auditBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/vault/payments/audit") && init?.method === "POST") {
        auditBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ id: "audit_3ds" }, { status: 201 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    const api = new ApiClient({
      apiBaseUrl: "https://api.test",
      registryBaseUrl: "https://registry.test",
      agentSessionToken: "synthetic-session-token",
      fetch: fetchMock,
    });
    return { api, auditBodies };
  }

  it("keeps checking the same live browser and clears state once the OOB challenge resolves", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: env.api,
    });
    const threeDsState = buildThreeDsState();
    setActivePendingThreeDs(threeDsState);
    expect(getActivePendingThreeDs()).toEqual(threeDsState);

    h.waitForThreeDsResult = "timeout";
    const pending = (await operatePaymentStatusTool.handler({}, env.api)) as Record<
      string,
      unknown
    >;
    expect(pending).toMatchObject({
      status: "payment_3ds_pending",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
    });
    expect(getActivePendingThreeDs()).not.toBeNull();
    expect(env.auditBodies).toHaveLength(0);

    // The cardholder approves the OOB push between polls; a LATER
    // operate_payment_status call must observe it via the SAME session's
    // browser without operate_pay ever being called again.
    h.waitForThreeDsResult = "succeeded";
    const resolved = (await operatePaymentStatusTool.handler({}, env.api)) as Record<
      string,
      unknown
    >;
    expect(resolved).toMatchObject({
      status: "payment_submitted",
      audit_recorded: true,
      merchant: CHECKOUT.merchant,
      amount_cents: CHECKOUT.amount_cents,
      currency: CHECKOUT.currency,
    });
    expect(getActivePendingThreeDs()).toBeNull();
    expect(env.auditBodies).toEqual([
      expect.objectContaining({
        last4: "9192",
        status: "payment_submitted",
        approvalId: "appr_3ds",
        mandateId: "mandate_3ds",
      }),
    ]);
  });

  it("preserves an unknown outcome while no 3DS or merchant evidence appears", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: env.api,
    });
    const unknownState = buildThreeDsState(Date.now() + 60_000, undefined, "unknown");
    setActivePendingThreeDs(unknownState);
    h.waitForThreeDsResult = "timeout";

    await expect(operatePaymentStatusTool.handler({}, env.api)).resolves.toMatchObject({
      status: "payment_outcome_unknown",
      next: { tool: "operate_payment_status", wait_seconds: 15 },
    });
    expect(getActivePendingThreeDs()).toBe(unknownState);
    expect(env.auditBodies).toHaveLength(0);
  });

  it("reports 3DS pending only after the browser observes a challenge", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: env.api,
    });
    const unknownState = buildThreeDsState(Date.now() + 60_000, undefined, "unknown");
    setActivePendingThreeDs(unknownState);
    h.waitForThreeDsResult = "challenge_pending";

    await expect(operatePaymentStatusTool.handler({}, env.api)).resolves.toMatchObject({
      status: "payment_3ds_pending",
    });
    expect(unknownState.outcome).toBe("three_ds");
  });

  it("keeps an ACS instrument-mismatch warning visible across 3DS status waits", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
    });
    setActivePendingThreeDs(
      buildThreeDsState(Date.now() + 60_000, {
        kind: "payment_instrument_mismatch",
        confidence: "high",
        evidence_used: ["issuer"],
        expected: { last4: "9192", issuer: "DBS" },
        observed: { issuer: "ENBDX" },
        provenance: {
          expected: { last4: "released_card", issuer: "bin_metadata" },
          observed: "3ds_challenge",
        },
      }),
    );
    h.waitForThreeDsResult = "timeout";

    await expect(operatePaymentStatusTool.handler({}, env.api)).resolves.toMatchObject({
      status: "payment_3ds_pending",
      warning: {
        kind: "payment_instrument_mismatch",
        expected: { last4: "9192", issuer: "DBS" },
        observed: { issuer: "ENBDX" },
        provenance: {
          expected: { last4: "released_card", issuer: "bin_metadata" },
          observed: "3ds_challenge",
        },
      },
    });
    h.waitForThreeDsResult = "failed";
    await operatePaymentStatusTool.handler({}, env.api);
  });

  it("persists mismatch evidence first observed by a resumable status poll", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: env.api,
    });
    setActivePendingThreeDs(buildThreeDsState());
    h.paymentInstrumentMismatch = {
      kind: "payment_instrument_mismatch",
      confidence: "high",
      evidence_used: ["last4"],
      expected: { last4: "9192" },
      observed: { last4: "0005" },
      provenance: {
        expected: { last4: "released_card" },
        observed: "3ds_challenge",
      },
    };

    await expect(operatePaymentStatusTool.handler({}, env.api)).resolves.toMatchObject({
      status: "payment_3ds_pending",
      warning: h.paymentInstrumentMismatch,
    });
    expect(getActivePendingThreeDs()).toMatchObject({
      payment_instrument_mismatch: h.paymentInstrumentMismatch,
    });
  });

  it("records a declined outcome and clears state when the OOB challenge fails", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
    });
    setActivePendingThreeDs(buildThreeDsState());

    h.waitForThreeDsResult = "failed";
    const result = (await operatePaymentStatusTool.handler(
      { wait_seconds: 15 },
      env.api,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ status: "payment_declined", audit_recorded: true });
    expect(getActivePendingThreeDs()).toBeNull();
    expect(env.auditBodies).toEqual([expect.objectContaining({ status: "payment_declined" })]);
  });

  it("hands back an accurate unresolved status once the resumable deadline passes — never fabricates success", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
    });
    setActivePendingThreeDs(buildThreeDsState(Date.now() - 1));

    h.waitForThreeDsResult = "timeout";
    const result = (await operatePaymentStatusTool.handler(
      { wait_seconds: 15 },
      env.api,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "payment_3ds_unresolved",
      audit_recorded: true,
      needs_user: { wall: "3ds", resume: "checkout" },
    });
    expect(getActivePendingThreeDs()).toBeNull();
    expect(env.auditBodies).toEqual([
      expect.objectContaining({ status: "payment_3ds_unresolved" }),
    ]);
    expect(h.waitForThreeDsCalls).toEqual([0]);
  });

  it("retains an expired unknown attempt for merchant reconciliation", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: env.api,
    });
    const unknownState = buildThreeDsState(Date.now() - 1, undefined, "unknown");
    setActivePendingThreeDs(unknownState);
    h.waitForThreeDsResult = "timeout";

    await expect(operatePaymentStatusTool.handler({}, env.api)).resolves.toMatchObject({
      status: "payment_outcome_unknown",
      audit_recorded: true,
      needs_user: { wall: "merchant_reconciliation", resume: "checkout" },
    });
    expect(getActivePendingThreeDs()).toBe(unknownState);
    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(
      /prior charge has unresolved 3-D Secure state/,
    );
    expect(env.auditBodies).toEqual([
      expect.objectContaining({ status: "payment_outcome_unknown" }),
    ]);
  });

  it("retains reconciliation custody when an unknown-outcome audit fails", async () => {
    const closeAuditPayment = vi.fn().mockResolvedValue({ id: "audit_close" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment: closeAuditPayment } as unknown as ApiClient,
    });
    const unknownState = buildThreeDsState(Date.now() - 1, undefined, "unknown");
    setActivePendingThreeDs(unknownState);
    const auditPayment = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    h.waitForThreeDsResult = "timeout";

    await expect(
      operatePaymentStatusTool.handler({}, { auditPayment } as unknown as ApiClient),
    ).resolves.toMatchObject({
      status: "payment_outcome_unknown",
      audit_recorded: false,
      needs_user: { wall: "merchant_reconciliation", resume: "checkout" },
    });
    expect(auditPayment).toHaveBeenCalledTimes(1);
    expect(getActivePendingThreeDs()).toBe(unknownState);
    await finishProvisionSession(started.session_id);
  });

  it("retains expired 3DS state when its required terminal audit cannot be written", async () => {
    const closeAuditPayment = vi.fn().mockResolvedValue({ id: "audit_close" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment: closeAuditPayment } as unknown as ApiClient,
    });
    const threeDsState = buildThreeDsState(Date.now() - 1);
    setActivePendingThreeDs(threeDsState);
    const auditPayment = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    h.waitForThreeDsResult = "timeout";

    await expect(
      operatePaymentStatusTool.handler({}, { auditPayment } as unknown as ApiClient),
    ).rejects.toThrow("audit unavailable");
    expect(auditPayment).toHaveBeenCalledTimes(1);
    expect(getActivePendingThreeDs()).toEqual(threeDsState);
    await finishProvisionSession(started.session_id);
  });

  it("does not let a stale status call clear newer pending 3DS state", async () => {
    const finishAuditPayment = vi.fn().mockResolvedValue({ id: "audit_finish" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment: finishAuditPayment } as unknown as ApiClient,
    });
    const oldState = buildThreeDsState(Date.now() - 1);
    setActivePendingThreeDs(oldState);
    h.waitForThreeDsResult = "timeout";

    let signalFirstAuditStarted: (() => void) | undefined;
    const firstAuditStarted = new Promise<void>((resolve) => {
      signalFirstAuditStarted = resolve;
    });
    let releaseFirstAudit: (() => void) | undefined;
    const firstAuditGate = new Promise<void>((resolve) => {
      releaseFirstAudit = resolve;
    });
    const firstAuditPayment = vi.fn(async () => {
      signalFirstAuditStarted?.();
      await firstAuditGate;
      return { id: "audit_first" };
    });
    const firstStatus = operatePaymentStatusTool.handler({}, {
      auditPayment: firstAuditPayment,
    } as unknown as ApiClient);
    await firstAuditStarted;

    const secondAuditPayment = vi.fn().mockResolvedValue({ id: "audit_second" });
    await operatePaymentStatusTool.handler({}, {
      auditPayment: secondAuditPayment,
    } as unknown as ApiClient);
    expect(getActivePendingThreeDs()).toBeNull();

    const newerState = {
      ...buildThreeDsState(),
      approval_id: "appr_newer_3ds",
      approval_url: "https://web.test/vault/pay/appr_newer_3ds",
    };
    setActivePendingThreeDs(newerState);
    releaseFirstAudit?.();
    await firstStatus;

    expect(getActivePendingThreeDs()).toBe(newerState);
    expect(firstAuditPayment).toHaveBeenCalledTimes(1);
    expect(secondAuditPayment).toHaveBeenCalledTimes(1);
    await finishProvisionSession(started.session_id);
  });

  it("refuses a new operate_pay lease while a prior 3DS outcome is unresolved", async () => {
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit_finish" });
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment } as unknown as ApiClient,
    });
    const threeDsState = buildThreeDsState();
    setActivePendingThreeDs(threeDsState);

    expect(() => claimActivePaymentForOperatePay(undefined)).toThrow(
      /call operate_payment_status first/,
    );
    expect(getActivePendingThreeDs()).toEqual(threeDsState);
    await finishProvisionSession(paymentSession().id);
  });

  it("checks and audits an unresolved 3DS charge before operate_finish closes the browser", async () => {
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit_finish" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment } as unknown as ApiClient,
    });
    setActivePendingThreeDs(buildThreeDsState());
    h.waitForThreeDsResult = "timeout";

    await expect(
      provisionFinishTool.handler(
        provisionFinishTool.inputSchema.parse({
          session_id: started.session_id,
          outcome: { kind: "result", data: { confirmed: true } },
        }),
        null,
      ),
    ).resolves.toMatchObject({ kind: "result" });
    expect(h.waitForThreeDsCalls).toEqual([0]);
    expect(auditPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        approval_id: "appr_3ds",
        mandate_id: "mandate_3ds",
        last4: "9192",
        status: "payment_3ds_unresolved",
      }),
    );
    expect(h.captureStorageStateCalls).toBe(0);
    expect(h.storageStateWrites).toEqual([]);
  });

  it("retains the pending 3DS fence when finish preparation fails", async () => {
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit_finish" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
      api: { auditPayment } as unknown as ApiClient,
    });
    const threeDsState = buildThreeDsState();
    setActivePendingThreeDs(threeDsState);

    await expect(
      finishProvisionSessionWithPreparation(started.session_id, async () => {
        throw new Error("preparation failed");
      }),
    ).rejects.toThrow("preparation failed");
    expect(getActivePendingThreeDs()).toEqual(threeDsState);
    expect(h.waitForThreeDsCalls).toEqual([]);
    expect(auditPayment).not.toHaveBeenCalled();

    await finishProvisionSession(started.session_id);
  });

  it("checks and audits the pending 3DS charge during bulk session shutdown", async () => {
    const auditPayment = vi.fn().mockResolvedValue({ id: "audit" });
    const started = await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/checkout",
      api: { auditPayment } as unknown as ApiClient,
    });
    setActivePendingThreeDs(buildThreeDsState(), paymentSession(started.session_id));
    h.waitForThreeDsResult = "timeout";

    await closeAllProvisionSessions();

    expect(h.waitForThreeDsCalls).toEqual([0]);
    expect(auditPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_3ds_unresolved" }),
    );
    expect(activeSessionCount()).toBe(0);
  });

  it("reports no_pending_payment once nothing is outstanding", async () => {
    const env = buildStatusEnv();
    await startProvisionSession({
      serviceUrl: "https://hibiyakadan.example.test/cart_seisan.html",
    });

    const result = (await operatePaymentStatusTool.handler({}, env.api)) as Record<string, unknown>;

    expect(result).toMatchObject({ status: "no_pending_payment" });
  });
});

describe("fill_card cart-total carry-forward (Session.lastCartCheckout)", () => {
  it("tries the next code-owned cart locator after a V2 target miss", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 0 Total 968円";
    h.elements = [elem({ name: "quantity", labelText: "Quantity", selector: "#qty", value: "0" })];
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 968,
      currency: "JPY",
    };
    h.locatorResolveMissValues = ["Add to Cart"];
    h.cartLineItemsAfterClick = [
      {
        title: "Tiara",
        quantity: 1,
        product_identities: ["sku:tiara"],
        option_signatures: ["size=M"],
      },
    ];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    await expect(
      cartAdd(started.session_id, "sku:tiara", "size=M", "cart-add-bag-fallback"),
    ).resolves.toMatchObject({ status: "added", cart_delta: "+1" });
    expect(h.locatorResolveIntents).toEqual(["click", "click"]);
    expect(h.locatorClickCalls).toBe(1);
  });

  it("returns legible post-add cart state and suppresses a retry for the same line", async () => {
    process.env.TRUSTY_SQUIRE_OBSERVE_V2 = "on";
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Cart Quantity: 0 Subtotal 968円 Shipping Free Total 968円";
    h.elements = [elem({ name: "quantity", labelText: "Quantity", selector: "#qty", value: "0" })];
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 968,
      currency: "JPY",
    };
    h.clickValueMutation = { selector: "#qty", value: "1" };
    h.cartLineItemsAfterClick = [
      {
        title: "Tiara",
        quantity: 1,
        product_identities: ["sku:tiara"],
        option_signatures: ["size=M"],
      },
    ];
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const added = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: started.session_id,
        kind: "cart_add",
        product_identity: "sku:tiara",
        options_hash: "size=M",
        idempotency_key: "cart-add-1",
      }),
      null,
    )) as Awaited<ReturnType<typeof cartAdd>>;

    expect(added).toMatchObject({
      status: "added",
      cart_delta: "+1",
      cart_url: "",
      checkout_state: {
        authority: "informational_only",
        completeness: "best_effort",
        authoritative_for_payment: false,
        stage: "cart",
        product_identity: "<requested>",
        options_hash: "<requested>",
        quantity: 1,
        subtotal: { amount_cents: 968, currency: "JPY" },
        shipping: { amount_cents: 0, currency: "JPY" },
        payable_total: { amount_cents: 968, currency: "JPY" },
        cart_url: "",
        next_action: { tool: "operate_act", kind: "click", intent: "proceed_to_checkout" },
      },
      postcondition: {
        product_identity: "<requested>",
        options_hash: "<requested>",
        quantity: 1,
      },
    });
    expect(JSON.stringify(added)).not.toContain("https://shop.example.com/cart");
    expect(JSON.stringify(added)).not.toContain("sku:tiara");
    expect(JSON.stringify(added)).not.toContain("size=M");
    expect(h.locatorClickCalls).toBe(1);

    const retried = (await provisionActTool.handler(
      provisionActTool.inputSchema.parse({
        session_id: started.session_id,
        kind: "cart_add",
        product_identity: "sku:tiara",
        options_hash: "size=M",
        idempotency_key: "cart-add-1",
      }),
      null,
    )) as Awaited<ReturnType<typeof cartAdd>>;
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
    h.cartLineItemsAfterClick = [
      {
        title: "Tiara",
        quantity: 1,
        product_identities: ["sku:tiara"],
        option_signatures: ["size=M"],
      },
    ];
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
    h.cartLineItemsAfterClick = [
      {
        title: "Tiara",
        quantity: 1,
        product_identities: ["sku:tiara"],
        option_signatures: ["size=M"],
      },
    ];
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

  it("does not fabricate component amounts from the payable total", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Total $15.00";
    h.checkoutSummary = {
      merchant: "Synthetic Shop",
      checkout_origin: "https://shop.example.com",
      amount_cents: 1_500,
      currency: "USD",
    };
    const started = await startProvisionSession({ serviceUrl: h.currentUrl });

    const observed = await observe(started.session_id, "compact");

    expect(observed.checkout_state).toMatchObject({
      subtotal: null,
      shipping: null,
      payable_total: { amount_cents: 1_500, currency: "USD" },
    });
  });

  it("keeps a labeled shipping charge over value-leading promotional copy", async () => {
    h.currentUrl = "https://shop.example.com/cart";
    h.visibleText = "Shipping $0 on orders over $50. Subtotal $10.00 Shipping $5.00 Total $15.00";
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

  it("allows generic quantity controls without identity and emits supplied hints", async () => {
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

    const unbound = await act(started.session_id, { kind: "click", target: "+" });
    expect(unbound.checkout_state).toMatchObject({
      product_identity: null,
      options_hash: null,
    });
    const observed = await act(started.session_id, { kind: "click", target: "+" }, "compact", {
      productIdentity: "sku:tiara",
      optionsHash: "size=M",
    });

    expect(observed.checkout_state).toMatchObject({
      product_identity: "sku:tiara",
      options_hash: "size=M",
    });
  });

  it("allows row-scoped remove controls without identity and binds supplied hints", async () => {
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

    const unbound = await act(started.session_id, { kind: "click", target: "Remove" });
    expect(unbound.checkout_state).toMatchObject({
      product_identity: null,
      options_hash: null,
    });
    expect(h.clickCalls).toBe(1);
    const observed = await act(started.session_id, { kind: "click", target: "Remove" }, "compact", {
      productIdentity: "sku:tiara",
      optionsHash: "size=M",
    });

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
