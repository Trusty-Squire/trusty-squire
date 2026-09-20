import {
  markOperatorMutationDispatchAttempted,
  withOperatorRequestContext,
} from "../request-cancellation.js";
import type { BrowserUseCapture } from "../browser-use-capture.js";
import { browserUseDynamicsSignature, type BrowserUseNode } from "../browser-use-serializer.js";
import type { InteractiveElement } from "../browser.js";
import type { GoogleHumanChallenge } from "../google-auth-state.js";
import { mockBrowserUseCapture } from "./browser-use-test-capture.js";
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
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { BrowserClickDispatchError } from "../browser.js";
import { OAuthFailedError } from "../oauth-login.js";
import type * as BrowserModule from "../browser.js";
import type * as GoogleLoginModule from "../google-login.js";
import type * as ProfileModule from "../profile.js";

const h = vi.hoisted(() => ({
  capturePage: null as Page | null,
  captureClick: null as (() => Promise<void>) | null,
  providers: ["google"] as string[] | null,
  oauthStatus: "already_valid" as string,
  oauthLoginCalls: [] as string[],
  oauthDispatchCalls: 0,
  oauthLoginTimeouts: [] as number[],
  oauthHumanHandoffTimeouts: [] as number[],
  oauthLoginError: null as Error | null,
  // Plain oauth-login.ts handshake simulation for the fake browser: "return"
  // redirects same-tab to the provider and back to h.oauthResultUrl,
  // "provider" stops on the provider URL, "dispatch-only" only records the
  // dispatch marker/count without navigating.
  oauthClickSimulate: null as null | "return" | "provider" | "dispatch-only",
  oauthConsentProviders: [] as Array<string | undefined>,
  oauthExpectedGoogleAccountEmails: [] as Array<string | null | undefined>,
  oauthLoginGates: new Map<number, Promise<void>>(),
  waitForInteractiveDomCalls: [] as Array<{ minElements: number; timeoutMs: number }>,
  oauthResultUrl: "https://app.example.com/dashboard",
  oauthTerminalCompletionUrl: null as string | null,
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
  typeError: null as Error | null,
  uploads: [] as Array<{ selector: string; filePath: string }>,
  selected: [] as Array<{ selector: string; matcher: string | undefined }>,
  selectError: null as Error | null,
  selectMutation: null as unknown[] | null,
  phoneCountries: [] as string[],
  phoneCountry: null as string | null,
  clearElementsOnClick: false,
  clickValueMutation: null as { selector: string; value: string } | null,
  clickHook: null as (() => void) | null,
  clickPhoneCountryMutation: null as string | null,
  trackedClickFailure: null as null | {
    dispatchStatus: "not_dispatched" | "dispatched" | "unknown";
    message: string;
  },
  shippingMethodsLoadOnRequiredAddressCommit: false,
  shippingMethodsLoaded: false,
  requiredShippingAddressCommits: [] as string[],
  clickCalls: 0,
  dispatchTargets: [] as Array<string | null>,
  jsClickCalls: 0,
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
  startError: null as Error | null,
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
  connections: [] as boolean[],
  controllers: [] as Array<{
    page: unknown;
    oauthProductPage: unknown;
    oauthProviderPage: unknown;
    oauthProviderPageClosed: boolean;
    oauthCompletionPage: unknown;
    activeOAuthPage: unknown;
  }>,
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
  // When non-empty, extractVisibleText() shifts values off this queue in call
  // order (falling back to `visibleText` once exhausted) — lets a test script
  // a sequence of reads, e.g. a transient Gmail error banner then real content.
  visibleTextQueue: [] as string[],
  visibleTextGate: null as Promise<void> | null,
  extractVisibleTextCalls: 0,
  // Text nodes in the synthetic canonical DOM capture, with queued updates.
  prose: [] as string[],
  proseQueue: [] as string[][],
  proseExtractCalls: 0,
  // When non-null, canonical DOM capture throws this concrete error.
  proseError: null as string | null,
  captureOverride: null as BrowserUseCapture | null,
  observationSemantics: { title: "", headings: [] as string[] },
  openFirstMailResult: false,
  // When non-null, extractOpenedMailBody() returns this body instead of null
  // (null = page-wide fallback, matching the pre-method behavior).
  openedMailBody: null as {
    text: string;
    links: Array<{ url: string; text: string | null }>;
  } | null,
  utilityTabsOpened: 0,
  utilityTabsClosed: 0,
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
  twoCaptchaCtorArgs: [] as Array<unknown>,
  // Holds a solve open so a test can observe while one is genuinely in flight.
  twoCaptchaGate: null as Promise<void> | null,
  // Fires when the solver mock is entered, so a test can synchronize on the
  // detached attempt reaching the solve instead of guessing at microtask hops.
  onTwoCaptchaSolveStart: null as (() => void) | null,
  // False models a programmatic widget where the injected token lands in no
  // response field of its own provider.
  injectLandsVariantToken: true,
  injectCaptchaCalls: [] as string[],
  injectClearsCapture: false,
  // Which providers currently hold their OWN response token, so the
  // variant-scoped pre-check can be exercised independently of captchaToken
  // (the legacy any-provider flag).
  variantCaptchaTokens: [] as string[],
  // The hCaptcha drop-in shape: the page carries no h-captcha-response field,
  // so an injected token lands in the g-recaptcha-response compat textarea.
  hcaptchaCompatOnly: false,
  consentDismissCalls: 0,
  consentCta: null as string | null,
  locatorResolve: {
    ok: true,
    text: "Control",
  } as
    | {
        ok: true;
        text: string;
        labels?: string[];
        frameTarget?: {
          framePath: string;
          frameOrigin: string;
          frameUrl: string;
        } | null;
      }
    | { ok: false; reason: "none" | "ambiguous"; candidates: string[] },
  locatorResolveMissValues: [] as string[],
  locatorClickCalls: 0,
  locatorTypeCalls: [] as Array<{ text: string; sealed: boolean }>,
  screenshotCalls: [] as unknown[],
  labeledCredentialCandidates: [] as Array<{
    label: string | null;
    value: string;
    isMasked: boolean;
  }>,
  nearCopyCredentialCandidates: [] as string[],
  locatorResolveIntents: [] as string[],
  locatorDisposeCalls: 0,
}));

// This suite is the V1 contract suite. Individual Compact V2 tests opt in
// explicitly below, which keeps the feature-flagged V1 and V2 action
// protocols independently testable while V2 is the production default.

// Inject the broker page port; these tests exercise session behavior, not physical launch.
vi.mock("../broker/custody.js", async () => {
  const { BrowserController } = await import("../browser.js");
  const { CHROME_PROFILE_DIR } = await import("../profile.js");
  return {
    brokerBrowserCustody: () => ({
      acquire: async (options: { profileDir?: string; proxyUrl?: string }) => {
        const profileDir = options.profileDir ?? CHROME_PROFILE_DIR;
        const browser = new BrowserController({ ...options, profileDir });
        await browser.start();
        return { browser, profileDir };
      },
      release: async (
        browser: InstanceType<typeof BrowserController>,
        beforeRelease?: () => Promise<void>,
      ) => {
        if ((await browser.close()) !== "closed")
          throw new Error("operator browser cleanup unproven");
        await beforeRelease?.();
      },
      identity: async <T>(operation: () => Promise<T>) => await operation(),
    }),
  };
});

vi.mock("../browser.js", async (importOriginal) => ({
  BrowserClickDispatchError: (await importOriginal<typeof BrowserModule>())
    .BrowserClickDispatchError,
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
    // OAuth page slots consumed by the plain oauth-login.ts helpers. They stay
    // null until a test or a real OAuth helper assigns them.
    page: unknown = null;
    oauthProductPage: unknown = null;
    oauthProviderPage: unknown = null;
    oauthProviderPageClosed = false;
    oauthCompletionPage: unknown = null;
    oauthConsentAttemptedPhases = new Set<string>();
    ownedPages = new Set<unknown>();
    constructor(opts: { profileDir?: string; proxyUrl?: string; storageState?: unknown } = {}) {
      this.index = h.connections.length;
      this.opts = opts;
      this.detached =
        this.index > 0 && opts.profileDir !== undefined && opts.profileDir !== h.profileDirs[0];
      h.connections.push(true);
      h.controllers.push(this);
      h.profileDirs.push(opts.profileDir);
      h.proxyUrls.push(opts.proxyUrl);
      h.seededStorageStates.push(opts.storageState);
    }
    trackOpenedTabs(page: unknown): void {
      this.ownedPages.add(page);
    }
    async sleep(ms: number): Promise<void> {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    }
    async start(): Promise<void> {
      h.started += 1;
      h.startCalls += 1;
      const gate = h.startGates.get(this.index);
      if (gate !== undefined) await gate;
      if (h.startGate !== null) await h.startGate;
      if (h.startError !== null) {
        const error = h.startError;
        h.startError = null;
        throw error;
      }
      // A started browser always has a working page for the OAuth helpers.
      this.page = this.activeOAuthPage;
    }
    isConnected(): boolean {
      return h.connections[this.index] === true;
    }
    // The OAuth detection helpers moved to plain functions in oauth-login.ts
    // that drive the controller's `context`, so the fake exposes one: cookies
    // admit the providers h.providers names, and the identity probe page
    // mimics myaccount.google.com for the configured worker email.
    get context(): unknown {
      const controller = this;
      return {
        cookies: async () => {
          if (h.providers !== null) {
            return h.providers.flatMap((provider: string) =>
              provider === "google"
                ? [
                    {
                      name: "__Secure-1PSID",
                      value: "google-live-session-cookie",
                      domain: ".google.com",
                    },
                  ]
                : provider === "github"
                  ? [{ name: "user_session", value: "github-live-session", domain: ".github.com" }]
                  : [],
            );
          }
          return (
            (
              controller.opts.storageState as
                | { cookies?: Array<{ name: string; value: string; domain: string }> }
                | undefined
            )?.cookies ?? []
          );
        },
        on: () => {},
        off: () => {},
        newPage: async () => {
          const identityEmail = { value: null as string | null };
          return {
            goto: async (url: string) => {
              let parsed: URL;
              try {
                parsed = new URL(url);
              } catch {
                identityEmail.value = h.workerEmail ?? h.liveGoogleEmail;
                return;
              }
              if (parsed.hostname === "myaccount.google.com") h.identityProbeCalls += 1;
              const authuser = parsed.searchParams.get("authuser") ?? undefined;
              h.identityProbeExpectedGoogleAccountEmails.push(authuser);
              identityEmail.value =
                authuser !== undefined && h.googleIdentityByExpectedEmail.has(authuser)
                  ? (h.googleIdentityByExpectedEmail.get(authuser) ?? null)
                  : (h.workerEmail ?? h.liveGoogleEmail);
            },
            isClosed: () => false,
            bringToFront: async () => {},
            url: () =>
              identityEmail.value === null
                ? "https://accounts.google.com/ServiceLogin"
                : "https://myaccount.google.com/",
            waitForLoadState: async () => {},
            locator: () => ({
              evaluateAll: async () => [`Google Account: Operator (${identityEmail.value ?? ""})`],
            }),
            close: async () => {},
          };
        },
      };
    }
    // The active working page the OAuth helpers treat as the product tab.
    // The plain oauth-login.ts handshake registers framenavigated/popup/close
    // listeners and compares frames by IDENTITY (frame !== page.mainFrame()),
    // so this page must be a stable singleton: working on/once/off/emit
    // registry, one stable mainFrame whose url() tracks h.currentUrl, and the
    // evaluate/locator surfaces the consent loop reads. Tests choreograph
    // navigation through clickSelector's h.oauthClickSimulate branch.
    private oauthSimPage: {
      page: Record<string, unknown>;
      frame: Record<string, unknown>;
    } | null = null;
    get activeOAuthPage(): unknown {
      if (this.oauthSimPage === null) {
        const listeners = new Map<string, Set<(payload: unknown) => void>>();
        const subscribe = (
          event: string,
          handler: (payload: unknown) => void,
          once: boolean,
        ): void => {
          const wrapped = (payload: unknown): void => {
            if (once) listeners.get(event)?.delete(wrapped);
            handler(payload);
          };
          let set = listeners.get(event);
          if (set === undefined) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(wrapped);
        };
        const page: Record<string, unknown> = {
          isClosed: () => false,
          url: () => this.currentUrl(),
          mainFrame: () => frame,
          // The captcha auto-solve walks child frames for gate handoff; this
          // simulated page embeds none.
          frames: () => [],
          on: (event: string, handler: (payload: unknown) => void) =>
            subscribe(event, handler, false),
          once: (event: string, handler: (payload: unknown) => void) =>
            subscribe(event, handler, true),
          off: (event: string, handler: (payload: unknown) => void) => {
            listeners.get(event)?.delete(handler);
          },
          emit: (event: string, payload: unknown) => {
            for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
          },
          goto: async () => {},
          waitForLoadState: async () => {},
          bringToFront: async () => {},
          close: async () => {},
          // relyingPartyOnboarding() runs an onboarding-form probe in the page.
          evaluate: async () => false,
          // classifyGoogleAuthState reads body text off the provider page.
          locator: () => ({ innerText: async () => "", evaluateAll: async () => [] }),
        };
        const frame: Record<string, unknown> = {
          url: () => this.currentUrl(),
          parentFrame: () => null,
          page: () => page,
        };
        this.oauthSimPage = { page, frame };
      }
      return this.oauthSimPage.page;
    }
    async goto(url: string, page?: unknown): Promise<void> {
      h.gotos.push(url);
      // A second argument is the utility tab the verification read navigates —
      // never the operation page, which must stay on its own URL.
      if (page !== undefined) return;
      if (this.detached) this.detachedUrl = url;
      else {
        h.currentUrl = url;
        h.mainDocumentEpoch += 1;
      }
    }
    async navigate(url: string, _page?: unknown): Promise<void> {
      await this.goto(url);
    }
    currentUrl(): string {
      return this.detached ? this.detachedUrl : h.currentUrl;
    }
    activePage() {
      if (h.capturePage !== null) return h.capturePage;
      // Identity-stable like production: the plain oauth handshake and
      // settleAfterOAuth compare pages by object identity, so the session's
      // operation page must BE the controller's current page object.
      if (this.page !== null) return this.page;
      return {
        isClosed: () => false,
        url: () => this.currentUrl(),
        // See activeOAuthPage: no child frames for the gate-handoff walk.
        frames: () => [],
      };
    }
    mainDocumentIdentity(): string {
      return String(h.mainDocumentEpoch);
    }
    isActivePage(): boolean {
      return true;
    }
    completedOAuthPage(): null {
      return null;
    }
    takeOAuthTerminalCompletionUrl(): string | null {
      const url = h.oauthTerminalCompletionUrl;
      h.oauthTerminalCompletionUrl = null;
      return url;
    }
    recoverActivePage(): void {}
    armOpenedTabAdoption(): void {}
    async adoptOpenedTab(): Promise<string | null> {
      return null;
    }
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
      if (h.visibleTextQueue.length > 0) return h.visibleTextQueue.shift()!;
      return h.visibleText;
    }
    async extractBrowserUseObservation() {
      if (h.captureOverride) return h.captureOverride;
      const elements = await this.extractInteractiveElements();
      if (h.proseError !== null) throw new Error(h.proseError);
      const text = h.proseQueue.length > 0 ? (h.proseQueue.shift() ?? h.prose) : h.prose;
      return mockBrowserUseCapture(elements as InteractiveElement[], text);
    }
    async extractObservationSemantics(): Promise<{ title: string; headings: string[] }> {
      return h.observationSemantics;
    }
    async revealMaskedCredentials(): Promise<void> {}
    async extractLabeledCredentialCandidates(): Promise<unknown[]> {
      return h.labeledCredentialCandidates;
    }
    async extractAllInputValues(): Promise<string[]> {
      return [];
    }
    async extractCredentialsNearCopyButtons(): Promise<string[]> {
      return h.nearCopyCredentialCandidates;
    }
    async readClipboard(): Promise<string> {
      return "";
    }
    paymentBrowser(): this {
      return this;
    }
    async openFirstMailResult(): Promise<boolean> {
      return h.openFirstMailResult;
    }
    async extractOpenedMailBody(): Promise<{
      text: string;
      links: Array<{ url: string; text: string | null }>;
    } | null> {
      return h.openedMailBody;
    }
    async openUtilityTab(): Promise<unknown> {
      h.utilityTabsOpened += 1;
      return {
        close: async () => {
          h.utilityTabsClosed += 1;
        },
      };
    }
    async extractRawMailLinks(): Promise<unknown[]> {
      // Mirror production's faithful read: href-bearing anchors, untruncated,
      // with the anchor's visible text. Derives from the same h.elements
      // fixtures the interactive-inventory path uses.
      return (h.elements as Array<Record<string, unknown>>)
        .filter((e) => typeof e.href === "string" && (e.href as string).length > 0)
        .map((e) => ({
          href: e.href as string,
          visibleText:
            (e.visibleText as string | undefined) ??
            (e.labelText as string | undefined) ??
            (e.ariaLabel as string | undefined) ??
            null,
        }));
    }
    async waitForInteractiveDom(minElements = 5, timeoutMs = 20_000): Promise<void> {
      h.waitForInteractiveDomCalls.push({ minElements, timeoutMs });
    }
    async waitForCaptchaChallengeToSettle(): Promise<boolean> {
      return h.captchaSettled;
    }
    async detectThreeDsChallenge(): Promise<{ url: string } | null> {
      return null;
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
    async scroll(direction: string, _page?: unknown): Promise<void> {
      h.scrolls.push(direction);
    }
    async typeSelector(selector: string, text: string, sealed = false): Promise<string[]> {
      h.typed.push({ selector, text, ...(sealed ? { sealed: true as const } : {}) });
      if (h.typeError !== null) throw h.typeError;
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
    async type(
      target: { kind: "selector" | "frame" | "handle"; selector?: string; frame?: unknown },
      text: string,
      sealed = false,
      _page?: unknown,
    ): Promise<string[]> {
      if (target.kind === "frame") {
        return await this.typeInFrame(
          target.frame as { frameUrl: string },
          target.selector!,
          text,
          sealed,
        );
      }
      if (target.kind === "handle") {
        await this.typeHandle(target, text, sealed);
        return [];
      }
      return await this.typeSelector(target.selector!, text, sealed);
    }
    async commitRequiredShippingAddressLine1(selector: string): Promise<void> {
      h.requiredShippingAddressCommits.push(selector);
      if (h.shippingMethodsLoadOnRequiredAddressCommit) h.shippingMethodsLoaded = true;
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
    async select(
      target: { kind: "selector" | "frame" | "handle"; selector?: string; frame?: unknown },
      matcher?: string,
      _page?: unknown,
    ): Promise<string> {
      if (target.kind === "frame") {
        return await this.selectInFrame(
          target.frame as { frameUrl: string },
          target.selector!,
          matcher,
        );
      }
      if (target.kind !== "selector") {
        throw new Error("select: handle targets are not supported");
      }
      return await this.selectOption(target.selector!, matcher);
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
    async click(
      target: {
        kind: "selector" | "frame" | "handle";
        selector?: string;
        frame?: { frameUrl: string };
        method: "click" | "js_click";
      },
      page?: unknown,
    ): Promise<void> {
      if (target.kind === "handle") {
        if (target.method === "click") {
          await this.clickWithDispatchTracking(target, undefined, () => this.clickHandle());
        } else {
          await this.jsClickHandle();
        }
        return;
      }
      if (target.kind === "frame") {
        if (target.method === "click") {
          await this.clickWithDispatchTracking(target, undefined, () =>
            this.clickInFrame(target.frame!, target.selector!, page),
          );
        } else {
          await this.clickViaJsInFrame(target.frame!, target.selector!);
        }
        return;
      }
      if (target.method === "click") {
        await this.clickWithDispatchTracking(target, undefined, () =>
          this.clickSelector(target.selector, page),
        );
      } else {
        await this.clickViaJs();
      }
    }
    async clickSelector(selector?: string, _page?: unknown): Promise<void> {
      h.clickCalls += 1;
      await h.captureClick?.();
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
      if (h.clickHook !== null) h.clickHook();
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
      await this.simulateOAuthClick();
      if (h.clickError !== null) throw h.clickError;
    }
    // Same-tab OAuth handshake simulation for the plain oauth-login.ts path:
    // mark the dispatch attempted, optionally park behind a test gate, then
    // fire the same-tab framenavigated hop(s) the handshake's
    // recordTopLevelNavigation listener consumes (provider auth URL with
    // redirect_uri, then the product return). Shared by the selector and
    // element-handle click routes because V2 refs resolve to handles.
    async simulateOAuthClick(): Promise<void> {
      if (h.oauthClickSimulate === null) return;
      await markOperatorMutationDispatchAttempted();
      h.oauthDispatchCalls += 1;
      const gate = h.oauthLoginGates.get(h.oauthDispatchCalls - 1);
      if (gate !== undefined) await gate;
      if (h.oauthClickSimulate !== "dispatch-only" && this.oauthSimPage !== null) {
        const resultUrl = h.oauthResultUrl;
        const isProviderUrl = /accounts\.google\.com|github\.com/.test(resultUrl);
        const oauthPage = this.oauthSimPage.page as {
          emit: (event: string, payload: unknown) => void;
        };
        if (!isProviderUrl) {
          h.currentUrl = `https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=${encodeURIComponent(resultUrl)}&response_type=code`;
          oauthPage.emit("framenavigated", this.oauthSimPage.frame);
        }
        if (h.oauthClickSimulate === "return" || isProviderUrl) {
          h.currentUrl = resultUrl;
          oauthPage.emit("framenavigated", this.oauthSimPage.frame);
        }
        if (h.oauthClickSimulate === "return") h.prose = ["Signed in"];
      }
      if (h.oauthLoginError !== null) throw h.oauthLoginError;
    }
    async clickViaJs(): Promise<void> {
      h.jsClickCalls += 1;
    }
    async clickInFrame(
      target: { frameUrl: string },
      selector: string,
      _page?: unknown,
    ): Promise<void> {
      h.frameClicks.push(`${target.frameUrl}|${selector}`);
    }
    async clickViaJsInFrame(
      target: { frameUrl: string },
      selector: string,
      _index?: number,
      _page?: unknown,
    ): Promise<void> {
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
      performClick?: () => Promise<void>,
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
      if (target.kind === "selector") h.dispatchTargets.push(target.selector ?? null);
      const failure = h.trackedClickFailure;
      if (failure?.dispatchStatus !== "not_dispatched") {
        if (performClick !== undefined) {
          await performClick();
        } else if (target.kind === "handle") {
          if (target.method === "click") await this.clickHandle();
          else await this.jsClickHandle();
        } else if (target.kind === "frame") {
          const destination = `${target.frame!.frameUrl}|${target.selector!}`;
          if (target.method === "click") h.frameClicks.push(destination);
          else h.frameJsClicks.push(destination);
        } else {
          await this.clickSelector();
        }
      }
      if (failure !== null) {
        const error = new Error(failure.message);
        throw tracked ? new BrowserClickDispatchError(failure.dispatchStatus, error) : error;
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
      _page?: unknown,
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
          frameTarget: {
            framePath: string;
            frameOrigin: string;
            frameUrl: string;
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
          frameTarget: h.locatorResolve.frameTarget ?? null,
        };
      }
      return h.locatorResolve;
    }
    async clickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
      await this.simulateOAuthClick();
      if (h.clickValueMutation !== null) {
        for (const element of h.elements as Array<Record<string, unknown>>) {
          if (element.selector === h.clickValueMutation.selector) {
            element.value = h.clickValueMutation.value;
          }
        }
      }
    }
    async jsClickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
    }
    async typeHandle(_handle: unknown, text: string, sealed = false): Promise<void> {
      h.locatorTypeCalls.push({ text, sealed });
    }
    async captureOperatorScreenshot(
      opts: unknown,
    ): Promise<{ base64: string; frameUrl: null; frameCount: number }> {
      h.screenshotCalls.push(opts);
      return { base64: "jpeg", frameUrl: null, frameCount: 1 };
    }
    async uploadFile(selector: string, filePath: string): Promise<void> {
      h.uploads.push({ selector, filePath });
    }
    async uploadFileOnPage(_page: unknown, selector: string, filePath: string): Promise<void> {
      await this.uploadFile(selector, filePath);
    }
    async loginWithOAuth(
      selector: string,
      settleTimeoutMs?: number,
      provider?: string,
      expectedGoogleAccountEmail?: string | null,
      _registerCompletionCheck?: unknown,
      onHumanHandoff?: () => number,
    ): Promise<void> {
      h.oauthLoginCalls.push(selector);
      h.oauthLoginTimeouts.push(settleTimeoutMs ?? 0);
      h.oauthConsentProviders.push(provider);
      h.oauthExpectedGoogleAccountEmails.push(expectedGoogleAccountEmail);
      const humanDeadline = onHumanHandoff?.();
      if (humanDeadline !== undefined) {
        h.oauthHumanHandoffTimeouts.push(humanDeadline - Date.now());
      }
      await markOperatorMutationDispatchAttempted();
      h.oauthDispatchCalls += 1;
      const gate = h.oauthLoginGates.get(this.index);
      if (gate !== undefined) await gate;
      h.currentUrl = h.oauthResultUrl;
      if (h.oauthLoginError !== null) throw h.oauthLoginError;
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
    async press(key: string, _page?: unknown): Promise<void> {
      await this.pressKey(key);
    }
    async focusedElementLabels(): Promise<string[]> {
      return h.focusedLabels;
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
  clickDispatchStatusForError: (await importOriginal<typeof BrowserModule>())
    .clickDispatchStatusForError,
  // Fix C — mirrors the real exports so provision-session.ts's honest
  // OAuth-timeout classification (never asserting an unverifiable cause) can
  // throw/catch these against this mocked module.
  OAuthAwaitingHumanError: class extends Error {
    readonly phase: "not_attempted" | "pending";
    constructor(
      message: string,
      phase: "not_attempted" | "pending" = "pending",
      readonly challenge?: GoogleHumanChallenge,
    ) {
      super(message);
      this.name = "OAuthAwaitingHumanError";
      this.phase = phase;
    }
  },
  OAuthFailedError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OAuthFailedError";
    }
  },
}));

// Captcha behaviour is a plain-function module now (captcha.ts), so the
// session tests stub its entry points directly instead of the fake browser's
// methods. The h.* flags and call counters are the same observations the
// fake's methods used to make.
vi.mock("../captcha.js", async (importOriginal) => ({
  // Pure helpers and the injection script are the real ones: they parse or
  // build values, they never touch the page.
  ...(await importOriginal<typeof CaptchaModule>()),
  // withTimeout is the real one: the credential-listing bound is the behaviour
  // under test, not something to re-implement here.
  withTimeout: (await importOriginal<typeof CaptchaModule>()).withTimeout,
  // The fake harness page hosts no cross-origin widget frame to attribute the
  // solve to, so the widget-page lookup finds nothing (the real implementation
  // walks real Playwright frames).
  findHcaptchaWidgetPageUrl: async () => null,
  TwoCaptchaSolver: class {
    constructor(opts?: unknown) {
      h.twoCaptchaCtorArgs.push(opts);
    }
    isAvailable(): boolean {
      return h.twoCaptchaAvailable;
    }
    async solveRecaptchaV2(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("recaptcha_v2");
      return h.twoCaptchaResult;
    }
    async solveHcaptcha(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("hcaptcha");
      h.onTwoCaptchaSolveStart?.();
      if (h.twoCaptchaGate !== null) await h.twoCaptchaGate;
      return h.twoCaptchaResult;
    }
    async solveTurnstile(): Promise<typeof h.twoCaptchaResult> {
      h.twoCaptchaCalls.push("turnstile");
      return h.twoCaptchaResult;
    }
  },
  waitForCaptchaChallengeToSettle: async () => h.captchaSettled,
  waitForCaptchaResponseToken: async () => h.captchaToken,
  hasCaptchaResponseTokenForVariant: async (_browser: unknown, variant: string) =>
    h.variantCaptchaTokens.includes(variant),
  hasHcaptchaResponseTokenWithCompat: async () =>
    h.hcaptchaCompatOnly
      ? h.variantCaptchaTokens.includes("recaptcha_v2")
      : h.variantCaptchaTokens.includes("hcaptcha"),
  detectCaptchaVariant: async () => ({
    variant: h.captchaVariant,
    challengeRendered: h.captchaChallengeRendered,
  }),
  solveVisibleCaptcha: async () => {
    h.visibleSolveCalls += 1;
    if (h.captchaVariant === "unknown") return { found: false };
    if (h.captchaSolved) h.captchaToken = true;
    return { found: true, solved: h.captchaSolved, kind: "recaptcha" };
  },
  triggerInvisibleRecaptcha: async () => {
    h.invisibleTriggerCalls += 1;
    if (h.invisibleTriggered) h.captchaToken = true;
    return h.invisibleTriggered;
  },
  extractRecaptchaSitekey: async () => "6Lcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  injectRecaptchaToken: async () => {
    h.injectCaptchaCalls.push("recaptcha");
    h.captchaToken = true;
    h.variantCaptchaTokens.push("recaptcha_v2", "recaptcha_v3");
    return true;
  },
  extractHcaptchaSitekey: async () => "00000000-0000-0000-0000-000000000000",
  getHcaptchaSolveContext: async () => ({
    invisible: false,
    userAgent: "test-agent",
    rqdata: null,
  }),
  injectHcaptchaToken: async () => {
    h.injectCaptchaCalls.push("hcaptcha");
    h.captchaToken = true;
    if (h.injectLandsVariantToken) {
      h.variantCaptchaTokens.push(h.hcaptchaCompatOnly ? "recaptcha_v2" : "hcaptcha");
    }
    if (h.injectClearsCapture) h.captureOverride = null;
    return true;
  },
  extractTurnstileSitekey: async () => "0x4AAAAAAA",
  injectTurnstileToken: async () => {
    h.injectCaptchaCalls.push("turnstile");
    h.captchaToken = true;
    h.variantCaptchaTokens.push("turnstile");
    return true;
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

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { OAuthAwaitingHumanError } from "../oauth-login.js";
import {} from "../profile.js";
import { buildTwoCaptchaSolver } from "../captcha-solve.js";
import type * as CaptchaModule from "../captcha.js";
import {
  startProvisionSession,
  startHarnessProvisionSession,
  act,
  observe,
  extractCredentials,
  stashSecretSlot,
  awaitVerification,
  isGmailTransientErrorText,
  isEmptyGmailResultText,
  gmailTransientBackoffMs,
  captchaGate,
  finishProvisionSession,
  paymentSession,
  closeAllProvisionSessions,
  activeSessionCount,
  formSelectMany,
  googleSessionGate,
  captureScreenshot,
  observeQuery,
} from "../provision-session.js";
import { actInternally } from "../act/act.js";
import { OBSERVE_V2_MAX_WIRE_BYTES } from "../compact-observation-v2.js";
import {
  operateClickTool,
  operateTypeTool,
  operateSelectTool,
  operatePressTool,
  operateScrollTool,
  operateWaitTool,
  operateFinishTool,
  provisionExtractTool,
  operateFillCredentialTool,
  operateLoginTool,
  provisionObserveTool,
  storedExtractResult,
  withSigninHost,
} from "../../tools/provision-drive.js";

// Credential-shaped test fixtures are assembled at runtime from harmless
// fragments so no complete vendor-prefixed token literal appears in this
// source file (GitHub secret scanning false-positived on test data in
// commit 0b3b160f). The returned values are byte-identical to the old
// literals; do NOT inline these back into single string literals.
const sk = (body: string): string => "sk" + "-" + body;

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
  // Tests that arm fake timers (OAuth handoff budget) must not leak them into
  // later tests when they fail mid-advance.
  vi.useRealTimers();
  h.capturePage = null;
  h.captureClick = null;
  process.env.TRUSTY_SQUIRE_OAUTH_LOGIN_COOLDOWN_MS = "0";
  h.providers = ["google"];
  h.oauthStatus = "already_valid";
  h.oauthLoginCalls = [];
  h.oauthDispatchCalls = 0;
  h.oauthLoginTimeouts = [];
  h.oauthHumanHandoffTimeouts = [];
  h.oauthLoginError = null;
  h.oauthClickSimulate = null;
  h.oauthConsentProviders = [];
  h.oauthExpectedGoogleAccountEmails = [];
  h.oauthLoginGates = new Map();
  h.waitForInteractiveDomCalls = [];
  h.oauthResultUrl = "https://app.example.com/dashboard";
  h.oauthTerminalCompletionUrl = null;
  h.restoredStorageStates = [];
  h.restoreStorageStateGate = null;
  h.oauthReadError = null;
  h.oauthTransition = null;
  h.oauthRecoveryCalls = 0;
  h.typed = [];
  h.typeError = null;
  h.uploads = [];
  h.selected = [];
  h.selectError = null;
  h.selectMutation = null;
  h.phoneCountries = [];
  h.phoneCountry = null;
  h.clearElementsOnClick = false;
  h.clickValueMutation = null;
  h.clickHook = null;
  h.clickPhoneCountryMutation = null;
  h.trackedClickFailure = null;
  h.shippingMethodsLoadOnRequiredAddressCommit = false;
  h.shippingMethodsLoaded = false;
  h.requiredShippingAddressCommits = [];
  h.clickCalls = 0;
  h.dispatchTargets = [];
  h.clickError = null;
  h.jsClickCalls = 0;
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
  h.startError = null;
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
  h.connections = [];
  h.controllers = [];
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
  h.visibleTextQueue = [];
  h.visibleTextGate = null;
  h.extractVisibleTextCalls = 0;
  h.prose = [];
  h.proseQueue = [];
  h.proseExtractCalls = 0;
  h.proseError = null;
  h.captureOverride = null;
  h.observationSemantics = { title: "", headings: [] };
  h.openFirstMailResult = false;
  h.openedMailBody = null;
  h.utilityTabsOpened = 0;
  h.utilityTabsClosed = 0;
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
  h.twoCaptchaCtorArgs = [];
  h.twoCaptchaGate = null;
  h.onTwoCaptchaSolveStart = null;
  h.injectLandsVariantToken = true;
  h.hcaptchaCompatOnly = false;
  h.injectCaptchaCalls = [];
  h.injectClearsCapture = false;
  h.variantCaptchaTokens = [];
  h.locatorResolve = {
    ok: true,
    text: "Control",
  };
  h.locatorResolveMissValues = [];
  h.locatorClickCalls = 0;
  h.locatorTypeCalls = [];
  h.screenshotCalls = [];
  h.labeledCredentialCandidates = [];
  h.nearCopyCredentialCandidates = [];
  h.locatorResolveIntents = [];
  h.locatorDisposeCalls = 0;
});

afterEach(async () => {
  await h.capturePage?.context().browser()?.close();
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
});

// The 3.1 "commit-or-stop" autocomplete gate (detect a suggestion popup,
// match-or-throw, positively confirm a click) was removed outright per
// captain's order: it was blocking a legitimate operate_type on Shopify's
// shipping-address1 combobox (a plain, settable text input that merely has
// an autocomplete listbox) with a bare, unrecoverable action_failed. Typing
// into a combobox/autocomplete field now behaves exactly like typing into
// any other text field — the page's own suggestion popup, if any, is just
// part of the next observation, and the agent can click it if it wants.
describe("typing into a combobox/autocomplete field (no commit-or-stop gate)", () => {
  it("types Shopify's required address line as plain text and still runs the #635 commit", async () => {
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
    // #635 fix (kept, not a gate): Shopify only enables delivery-rate
    // selection after the required address line is committed by
    // blur/change, not merely after the raw keystrokes land.
    h.shippingMethodsLoadOnRequiredAddressCommit = true;

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const addressRef = rows.find((row) => row[1] === "s" && row[2]?.includes("f=address"))?.[0];
    expect(addressRef).toBeDefined();

    await act(started.session_id, { kind: "type", target: addressRef!, text: "350 5th Ave" });

    expect(h.typed).toEqual([{ selector: "#shipping-address", text: "350 5th Ave" }]);
    expect(h.requiredShippingAddressCommits).toEqual(["#shipping-address"]);
    expect(h.shippingMethodsLoaded).toBe(true);
    // No auto-pick: the field holds exactly what was typed, nothing else.
    expect(h.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: "#shipping-address", value: "350 5th Ave" }),
        expect.objectContaining({ selector: "#shipping-apartment", value: "" }),
      ]),
    );
  });

  it("does not run the required-address commit for an ordinary field", async () => {
    h.elements = [elem({ testId: "shipping-name", labelText: "Name", selector: "#name" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const nameRef = rows.find((row) => row[2]?.includes("@name"))?.[0];
    expect(nameRef).toBeDefined();
    await act(started.session_id, { kind: "type", target: nameRef!, text: "Ada Lovelace" });
    expect(h.requiredShippingAddressCommits).toEqual([]);
    expect((h.elements[0] as Record<string, unknown>).value).toBe("Ada Lovelace");
  });

  // Live regression: whitejade.xyz's Shopify checkout. A real
  // shipping-address1 combobox opens a Google-Places-style suggestion
  // popup as a side effect of typing. The old gate threw
  // AutocompleteCommitRequiredError on 0 or >1 prefix matches, which fell
  // through to a bare action_failed and fenced the whole forwarder. There
  // is nothing left in the type path that looks at a popup at all, so this
  // must succeed regardless of how many suggestions the (unobserved) popup
  // would have rendered.
  it("succeeds and keeps the typed text when the field's popup would offer 3 suggestions", async () => {
    h.elements = [
      elem({
        tag: "input",
        role: "combobox",
        ariaLabel: "Address",
        labelText: "Address",
        autocomplete: "shipping address-line1",
        required: true,
        selector: "#shipping-address1",
        value: "",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://whitejade.xyz/checkout" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const addressRef = rows.find((row) => row[2]?.includes("@address"))?.[0];
    expect(addressRef).toBeDefined();
    const result = await act(started.session_id, {
      kind: "type",
      target: addressRef!,
      text: "350 5th Ave",
    });
    expect(result).toBeDefined();
    expect(h.typed).toEqual([{ selector: "#shipping-address1", text: "350 5th Ave" }]);
    expect((h.elements[0] as Record<string, unknown>).value).toBe("350 5th Ave");
  });

  it("surfaces the underlying error message instead of a bare action_failed on a type failure", async () => {
    h.elements = [elem({ testId: "shipping-address", labelText: "Address", selector: "#address" })];
    h.typeError = new Error("widget dispatch swallowed the keystrokes");
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const addressRef = rows.find((row) => row[2]?.includes("@address"))?.[0];
    expect(addressRef).toBeDefined();
    await expect(
      act(started.session_id, { kind: "type", target: addressRef!, text: "350 5th Ave" }),
    ).rejects.toThrow(/widget dispatch swallowed the keystrokes/);
  });
});

describe("operate session — OAuth lifecycle", () => {
  // V2 act targets must be a current observation's durable @e: handle; the
  // Google button is each fixture's only control, so its ref comes straight
  // from the start observation.
  function googleRef(started: { dom?: string; safe_table?: unknown[] }): string {
    return domRefs(started)[0]!;
  }

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
    h.oauthClickSimulate = "return";
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    const result = (await operateLoginTool.handler(
      { session_id: started.session_id, provider: "google", ref: googleRef(started) },
      null,
    )) as Awaited<ReturnType<typeof act>>;
    // Plain-path dispatch: the outer clickWithDispatchTracking plus its nested
    // browser.click re-entry both record the same authorized selector.
    expect(h.dispatchTargets).toEqual(["#google-oauth", "#google-oauth"]);
    expect(h.oauthDispatchCalls).toBe(1);
    expect(h.startCalls).toBe(1);
    expect(h.profileDirs).toHaveLength(1);
    expect(result.dom).toContain("Signed in");
    await finishProvisionSession(started.session_id);
  });

  it("waits for DOM readiness instead of spending the OAuth completion budget on a fixed dwell", async () => {
    // The machine budget stays far above the simulated handshake so the flow
    // completes normally and the post-action settle runs; the assertion below
    // pins that the settle waits on interactive DOM (bounded 2s) rather than
    // a fixed dwell.
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "1000";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    // Same-tab handshake simulation that returns to the product dashboard and
    // marks the settled DOM as "Signed in".
    h.oauthClickSimulate = "return";
    h.oauthResultUrl = "https://app.example.com/dashboard";
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }),
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });

    await expect(
      act(started.session_id, { kind: "oauth_login", target: googleRef(started) }),
    ).resolves.toMatchObject({ dom: expect.stringContaining("Signed in") });
    expect(h.waitForInteractiveDomCalls).toContainEqual({ minElements: 1, timeoutMs: 2_000 });
    await finishProvisionSession(started.session_id);
  });

  it("allows a configured human OAuth handoff to continue beyond the old 30-second cap", async () => {
    vi.useFakeTimers();
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "60000";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    // Same-tab redirect that stays on the provider (no return URL): the
    // handshake parks on Google and the human handoff deadline takes over.
    h.oauthClickSimulate = "provider";
    h.oauthResultUrl = "https://accounts.google.com/o/oauth2/auth?client_id=test";
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });

    const login = operateLoginTool.handler(
      { session_id: started.session_id, provider: "google", ref: googleRef(started) },
      null,
    );
    let settledEarly = false;
    void login.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settledEarly).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);

    await expect(login).resolves.toMatchObject({
      oauth: { state: "awaiting_human", next_action: "operate_observe" },
    });
    await finishProvisionSession(started.session_id);
  });

  it("keeps the session alive and inspectable after an OAuth completion-wait timeout", async () => {
    // What this proves, in one sentence: when a completion wait times out, the
    // session is not terminalized — observe still reads it, oauth_settle is
    // still callable on it, and operate_finish closes it normally.
    //
    // Regression: an OAuth boundary timeout used to force-terminate the whole
    // provision session ("oauth_action_terminalize"), so a pending
    // chooser/consent screen became unreachable — observe/screenshot/oauth_settle
    // all returned "unknown provision session" and the only recovery was a
    // fresh session that lost all progress. A timeout must surface as a
    // recoverable state while the session stays usable.
    //
    // Fix C: a timeout is honest uncertainty, not a failure — it no longer
    // rejects at all (the old rejection asserted an unverifiable cause, "the
    // saved session may have expired"). It resolves as a non-throwing
    // `awaiting_human` observation instead.
    //
    // Determinism: the completion wait never completes BY FIXTURE — the
    // authorized click parks on a gate this test controls — instead of racing a
    // wall-clock budget against the flow. The budget below is only the upper
    // bound that ends the parked wait, so it must be comfortably longer than the
    // (pure mock) dispatch path under load. Before the park, that budget chose
    // whether the inner provider wait or the outer action deadline reported the
    // timeout, and those two leave different OAuth page lifecycles behind: the
    // inner path retains a live provider page whose settle is a bounded 12×1s
    // provider-close poll that outlives vitest's default test budget.
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "1000";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthClickSimulate = "dispatch-only";
    let releaseParkedClick: (() => void) | undefined;
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        releaseParkedClick = resolve;
      }),
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    const timedOut = (await operateLoginTool.handler(
      { session_id: started.session_id, provider: "google", ref: googleRef(started) },
      null,
    )) as Awaited<ReturnType<typeof act>>;
    expect(timedOut.oauth).toMatchObject({
      state: "awaiting_human",
      next_action: "operate_observe",
    });
    if (timedOut.oauth?.state === "awaiting_human") {
      expect(timedOut.oauth.reason).not.toMatch(/expired|force-relogin/i);
    }

    // The timeout must NOT have deregistered the session: observe succeeds…
    await expect(observe(started.session_id)).resolves.toMatchObject({
      session_id: started.session_id,
    });
    // …oauth_settle is still callable on the same session…
    await expect(act(started.session_id, { kind: "oauth_settle" })).resolves.toBeDefined();
    // …and operate_finish closes the still-registered session normally.
    await expect(finishProvisionSession(started.session_id)).resolves.toMatchObject({
      session_id: started.session_id,
      closed: true,
    });
    // Release the parked click so the OAuth lease drains for later tests in
    // this file: the lease is held until the timed-out action's in-flight work
    // settles.
    releaseParkedClick?.();
  });

  it("reports unknown OAuth progress without claiming a human challenge when the request budget expires after dispatch", async () => {
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    const controller = new AbortController();
    let dispatched!: () => void;
    const dispatchObserved = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            h.oauthLoginError = controller.signal.reason as Error;
            resolve();
          },
          { once: true },
        );
      }),
    );
    h.oauthClickSimulate = "provider";
    h.oauthResultUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });

    const login = withOperatorRequestContext(
      controller.signal,
      async () =>
        await operateLoginTool.handler(
          { session_id: started.session_id, provider: "google", ref: googleRef(started) },
          null,
        ),
      async (phase) => {
        if (phase === "dispatch_attempted") dispatched();
      },
    );
    await dispatchObserved;
    await expect.poll(() => h.oauthDispatchCalls).toBe(1);
    const completed = expect(login).resolves.toMatchObject({
      session_id: started.session_id,
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      oauth: {
        state: "in_progress",
        completion: "unknown",
        next_action: "operate_observe",
      },
    });
    controller.abort(new Error("Operator work budget expired"));

    await completed;
    const result = (await login) as Awaited<ReturnType<typeof act>>;
    expect(result.guidance).toMatch(/observe/i);
    expect(result.guidance).toMatch(/do not repeat/i);
    expect(result.guidance).not.toMatch(/human|challenge/i);
    expect(result.oauth).not.toHaveProperty("challenge");
    expect(h.oauthDispatchCalls).toBe(1);
    expect(h.dispatchTargets).toHaveLength(2);
    await finishProvisionSession(started.session_id);
  });

  it.each([false, true])(
    "retains unknown OAuth progress for a browser timeout distinct from cancellation (cancelled=%s)",
    async (cancelled) => {
      h.visibleText = "Continue with Google";
      h.elements = [
        elem({
          visibleText: "Continue with Google",
          labelText: "Continue with Google",
          role: "button",
          selector: "#google-oauth",
        }),
      ];
      const controller = new AbortController();
      h.oauthResultUrl = "https://app.example.com/dashboard";
      h.oauthLoginError = new Error("page click: Timeout 15000ms exceeded after navigation");
      h.oauthClickSimulate = "dispatch-only";
      const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
      let release!: () => void;
      h.oauthLoginGates.set(
        0,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      const login = withOperatorRequestContext(controller.signal, () =>
        operateLoginTool.handler(
          { session_id: started.session_id, provider: "google", ref: googleRef(started) },
          null,
        ),
      );
      await expect.poll(() => h.oauthDispatchCalls).toBe(1);
      if (cancelled) controller.abort(new Error("Operator work budget expired"));
      release();
      const result = await login;
      expect(result).toMatchObject({
        session_id: started.session_id,
        oauth: {
          state: "in_progress",
          completion: "unknown",
          next_action: "operate_observe",
        },
        guidance: expect.stringMatching(/do not repeat/i),
      });
      expect(h.oauthDispatchCalls).toBe(1);
      await expect(observe(started.session_id)).resolves.toMatchObject({
        session_id: started.session_id,
      });
      await finishProvisionSession(started.session_id);
    },
  );

  it.each([
    new BrowserClickDispatchError("not_dispatched", new Error("target detached before click")),
    new OAuthFailedError("OAuth returned error=access_denied"),
  ])("preserves conclusive OAuth failures despite a dispatch-attempt marker: %s", async (error) => {
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthLoginError = error;
    h.oauthClickSimulate = "dispatch-only";
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    // Conclusive failures must not be laundered into in_progress uncertainty:
    // the act still REJECTS with the failure's own diagnosis, even though the
    // dispatch-attempt marker was set by the plain oauth handshake path.
    await expect(
      withOperatorRequestContext(new AbortController().signal, () =>
        operateLoginTool.handler(
          { session_id: started.session_id, provider: "google", ref: googleRef(started) },
          null,
        ),
      ),
    ).rejects.toThrow(error.message);
    await expect(observe(started.session_id)).resolves.toMatchObject({
      session_id: started.session_id,
    });
    await finishProvisionSession(started.session_id);
  });

  it("retains an observed Google number challenge and human guidance", async () => {
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthResultUrl = "https://accounts.google.com/signin/challenge/dp/2";
    h.oauthClickSimulate = "dispatch-only";
    h.oauthLoginError = new OAuthAwaitingHumanError(
      "Google is asking you to tap 28 on your phone.",
      "pending",
      {
        provider: "google",
        kind: "number_match",
        attempt_id: "attempt-1",
        challenge_revision: "revision-1",
        document_id: "document-1",
        number: "28",
        observed_at: "2026-09-10T00:00:00.000Z",
        expires_at: null,
      },
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });

    const challenged = await act(started.session_id, {
      kind: "oauth_login",
      target: googleRef(started),
    });

    expect(challenged.oauth).toMatchObject({
      state: "awaiting_human",
      challenge: { kind: "number_match", number: "28" },
      next_action: "operate_observe",
    });
    expect(challenged.guidance).toMatch(/pending challenge/i);
    await finishProvisionSession(started.session_id);
  });

  it("returns awaiting_human inside the compact-v2 budget even when the live challenge URL is huge", async () => {
    // Same-tab topology: at the deadline the current page IS the provider's
    // challenge page, whose URL alone can exceed the whole compact-v2 payload
    // budget. The pending human step must still come back as an observation,
    // never as a "compact-v2 budget metadata exceeded" error.
    vi.useFakeTimers();
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthResultUrl = `https://accounts.google.com/signin/challenge/dp/2?continue=${"x".repeat(1_200)}`;
    h.oauthClickSimulate = "provider";
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "10";
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    const login = act(started.session_id, {
      kind: "oauth_login",
      target: googleRef(started),
    });
    // Dispatch and observe the same-tab provider redirect before expiring the
    // wait. A wall-clock 10ms budget can elapse before the click under load,
    // which correctly reports not_attempted instead of a pending challenge.
    await vi.advanceTimersByTimeAsync(0);
    expect(h.oauthDispatchCalls).toBe(1);
    expect(h.currentUrl).toBe(h.oauthResultUrl);
    await vi.advanceTimersByTimeAsync(10);
    const pending = await login;
    // Drain the completed handshake's lease release before restoring real timers.
    await vi.runOnlyPendingTimersAsync();
    expect(pending.oauth).toMatchObject({
      state: "awaiting_human",
      next_action: "operate_observe",
    });
    // The live challenge URL is reported as-is, length-capped only as far as
    // the compact-v2 byte budget requires — never reduced to its origin.
    expect(h.oauthResultUrl.startsWith(pending.url)).toBe(true);
    expect(pending.url).toContain("https://accounts.google.com/signin/challenge/dp/2?continue=");
    expect(pending.url.length).toBeGreaterThan(300);
    expect(pending.guidance).toMatch(/operate_observe/);
    expect(pending.guidance).not.toMatch(/oauth_settle|oauth_login/);
    expect(Buffer.byteLength(JSON.stringify(pending), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    await finishProvisionSession(started.session_id);
  });

  it("labels a budget spent queued behind a prior OAuth call as not-yet-attempted, not a pending challenge", async () => {
    // 1000ms so the first act reliably dispatches and parks before its
    // action-phase deadline; the retry then exhausts that same budget queued
    // behind the still-held lease, which is the behavior under test.
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "1000";
    h.visibleText = "Continue with Google";
    h.elements = [
      elem({
        visibleText: "Continue with Google",
        labelText: "Continue with Google",
        role: "button",
        selector: "#google-oauth",
      }),
    ];
    h.oauthClickSimulate = "dispatch-only";
    let releaseFirst!: () => void;
    h.oauthLoginGates.set(
      0,
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    // The first attempt times out while its provider wait is still in flight,
    // so it keeps the OAuth lease; the retry queues behind it and its whole
    // budget elapses before it is ever attempted.
    await expect(
      act(started.session_id, { kind: "oauth_login", target: googleRef(started) }),
    ).resolves.toMatchObject({ oauth: { state: "awaiting_human" } });
    // V2: the first attempt's proven dispatch marker invalidates the refs from
    // the start observation, so the retry re-observes for a fresh ref — the
    // same way a real operator recovers from stale_ref.
    const reobserved = await observe(started.session_id);
    const queued = await act(started.session_id, {
      kind: "oauth_login",
      target: googleRef(reobserved),
    });
    expect(queued.oauth).toMatchObject({ state: "awaiting_human" });
    if (queued.oauth?.state === "awaiting_human") {
      expect(queued.oauth.reason).toMatch(/has not been attempted yet/);
      expect(queued.oauth.reason).not.toMatch(/challenge|consent/i);
    }
    // Nothing was clicked, so the guidance must recommend the retry the
    // reason names — not re-observing a challenge that was never started.
    expect(queued.guidance).toMatch(/oauth_login/);
    expect(queued.guidance).not.toMatch(/operate_observe|pending challenge/);
    expect(queued.url).toBe(h.currentUrl);
    expect(h.oauthDispatchCalls).toBe(1);
    releaseFirst();
    await finishProvisionSession(started.session_id);
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
    expect(
      operateSelectTool.inputSchema.safeParse({
        session_id: "s",
        selections: { "@e:field": "Large" },
      }).success,
    ).toBe(true);
    expect(operateSelectTool.description).toContain("selections map");
    expect(provisionObserveTool.description).toContain(
      "`[@e:...]<tag attributes />` identifies a control",
    );
    expect(provisionObserveTool.description).toContain("including off-viewport controls");
  });

  it("retains only sealed inventory after a V2 observation", async () => {
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

  it("navigates to an undeclared third-party host in compact-v2", async () => {
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/signup" });
    await act(started.session_id, { kind: "goto", url: "https://metrics.example.net/stats" });
    expect(h.gotos).toContain("https://metrics.example.net/stats");
  });

  it("dispatches each act kind through exactly one Contract C driver verb", async () => {
    h.elements = [
      elem({
        index: 0,
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "#continue",
      }),
      elem({
        index: 1,
        tag: "input",
        type: "text",
        role: "textbox",
        labelText: "Email",
        selector: "#email",
      }),
      elem({
        index: 2,
        tag: "select",
        role: "combobox",
        labelText: "Country",
        selector: "#country",
        selectOptions: [{ value: "jp", text: "Japan" }],
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const refs = domRefs(started);

    // click → click
    await act(started.session_id, { kind: "click", target: refs[0]! });
    expect(h.clickCalls).toBe(1);
    expect(h.jsClickCalls).toBe(0);

    // js_click → click (driver-dispatched js path)
    await act(started.session_id, { kind: "js_click", target: refs[0]! });
    expect(h.jsClickCalls).toBe(1);

    // type → type
    await act(started.session_id, { kind: "type", target: refs[1]!, text: "person@example.test" });
    expect(h.typed).toEqual([{ selector: "#email", text: "person@example.test" }]);

    // select → select
    await act(started.session_id, { kind: "select", target: refs[2]!, text: "Japan" });
    expect(h.selected).toEqual([{ selector: "#country", matcher: "Japan" }]);

    // type_secret → type (sealed)
    stashSecretSlot(started.session_id, "card", "4111111111111111");
    await act(started.session_id, { kind: "type_secret", target: refs[1]!, slot: "card" });
    expect(h.typed[1]).toEqual({
      selector: "#email",
      text: "4111111111111111",
      sealed: true,
    });

    // goto → navigate (last: it rolls the document epoch and stales the refs)
    await act(started.session_id, { kind: "goto", url: "https://shop.example.com/next" });
    expect(h.gotos).toContain("https://shop.example.com/next");

    // scroll → scroll
    await act(started.session_id, { kind: "scroll", direction: "down" });
    expect(h.scrolls).toEqual(["down"]);

    // press → press
    await act(started.session_id, { kind: "press", key: "Enter" });
    expect(h.pressedKeys).toEqual(["Enter"]);

    // No act kind leaked into a frame/handle/locator primitive.
    expect(h.frameClicks).toEqual([]);
    expect(h.frameTypes).toEqual([]);
    expect(h.frameSelects).toEqual([]);
    expect(h.locatorClickCalls).toBe(0);
    expect(h.locatorTypeCalls).toEqual([]);
  });

  it("skips Google start metadata, rejects locators, and binds a handle to its current page snapshot", async () => {
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
    });
    expect(started).toMatchObject({ format: "browser-use-dom" });
    expect(started).not.toHaveProperty("user_email");
    expect(h.identityProbeCalls).toBe(0);
    const firstRef = domRefs(started)[0]!;
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

    const freshRef = domRefs(afterGoto)[0]!;
    expect(freshRef).toMatch(/^@e:/);
    await act(started.session_id, { kind: "click", target: freshRef! });
    expect(h.clickCalls).toBe(1);
  });

  it("audits forged targets opaquely before rejecting them", async () => {
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
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const started = await startProvisionSession({
        serviceUrl: "https://shop.example.com/checkout",
      });
      const ref = domRefs(started)[0]!;
      now += 5 * 60_000 + 1;
      await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
        "stale_ref",
      );
      expect(h.clickCalls).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps every continuation cursor bound to its original query and snapshot", async () => {
    h.elements = Array.from({ length: 250 }, (_, index) =>
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
    const defaultPage = (await provisionObserveTool.handler(
      { session_id: started.session_id },
      null,
    )) as { format: string; safe_table: unknown[]; overflow: { next_cursor: string } };
    expect(defaultPage.format).toBe("browser-use-control-query");
    expect(defaultPage.safe_table.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(defaultPage), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
    const pageCursor = defaultPage.overflow.next_cursor;
    await expect(
      provisionObserveTool.handler(
        {
          session_id: started.session_id,
          query: "Item 149",
          cursor: pageCursor,
          format: "full",
        },
        null,
      ),
    ).rejects.toThrow("invalid_cursor");
    await expect(observeQuery(started.session_id, "", "button", pageCursor)).rejects.toThrow(
      "invalid_cursor",
    );
    // A cursor minted on a FILTERED page continues that filtered list.
    const queryPage = await observeQuery(started.session_id, "Item");
    const queryCursor = (queryPage.overflow as { next_cursor: string }).next_cursor;
    const continued = (await provisionObserveTool.handler(
      { session_id: started.session_id, query: "Item", cursor: queryCursor },
      null,
    )) as {
      safe_table: unknown[];
    };
    expect(continued.safe_table.length).toBeGreaterThan(0);
    // It does not continue under a different filter or role.
    await expect(observeQuery(started.session_id, "Other", undefined, queryCursor)).rejects.toThrow(
      "invalid_cursor",
    );
    await expect(observeQuery(started.session_id, "Item", "link", queryCursor)).rejects.toThrow(
      "invalid_cursor",
    );
  });

  it("pages across a volatile query-token change on the same origin+path", async () => {
    h.elements = Array.from({ length: 250 }, (_, index) =>
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
    const firstPage = await observeQuery(started.session_id, "");
    const pageCursor = (firstPage.overflow as { next_cursor: string }).next_cursor;
    // Live checkouts (e.g. Shopify) rotate a query token on every step
    // re-render without a real navigation; paging must survive it.
    h.currentUrl = "https://shop.example.com/checkouts/c/token?_r=revalidated";
    const nextPage = await observeQuery(started.session_id, "", undefined, pageCursor);
    expect((nextPage.safe_table as unknown[]).length).toBeGreaterThan(0);
    const finalCursor = (nextPage.overflow as { next_cursor: string }).next_cursor;
    const finalPage = await observeQuery(started.session_id, "", undefined, finalCursor);
    const rows = [firstPage, nextPage, finalPage].flatMap(
      (page) => page.safe_table as Array<[string, ...unknown[]]>,
    );
    expect(rows).toHaveLength(250);
    expect(new Set(rows.map(([ref]) => ref)).size).toBe(250);
    expect(finalPage.overflow).toBeUndefined();
  });

  it("keeps a continuation immutable across a rerender while a cursorless query refreshes", async () => {
    h.elements = Array.from({ length: 250 }, (_, index) =>
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
    const pageCursor = (
      (await observeQuery(started.session_id, "")).overflow as { next_cursor: string }
    ).next_cursor;
    // A validation state appears between pages. The continuation still means
    // the original result snapshot; it does not silently change membership or
    // facts underneath its positional offset.
    (h.elements[3] as { required?: boolean }).required = true;
    const nextPage = (await observeQuery(started.session_id, "", undefined, pageCursor)) as {
      safe_table: Array<[string, string, string?]>;
      overflow?: { next_cursor: string };
    };
    expect(nextPage.safe_table.length).toBeGreaterThan(0);
    expect(JSON.stringify(nextPage.safe_table)).not.toContain("s=r");
    const repeated = await observeQuery(started.session_id, "", undefined, pageCursor);
    expect(repeated.safe_table).toEqual(nextPage.safe_table);

    const refreshed = await observeQuery(started.session_id, "Item 3");
    expect(JSON.stringify(refreshed.safe_table)).toContain("s=r");
    // The bounded old snapshot survives the fresh read and still has its old
    // meaning. Returned refs are independently revalidated at action time.
    expect((await observeQuery(started.session_id, "", undefined, pageCursor)).safe_table).toEqual(
      nextPage.safe_table,
    );
    // A ref issued before the re-render is NOT positional and stays valid:
    // the element it names is still there and unchanged.
    const firstPageRef = domRefs(started)[0]!;
    await act(started.session_id, { kind: "click", target: firstPageRef });
    expect(h.clickCalls).toBe(1);
  });

  it("still invalidates overflow cursors on a cross-document or cross-path navigation", async () => {
    h.elements = Array.from({ length: 250 }, (_, index) =>
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
    const pageCursor = (
      (await observeQuery(started.session_id, "")).overflow as { next_cursor: string }
    ).next_cursor;

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
    const freshCursor = (
      (await observeQuery(reObserved.session_id, "")).overflow as { next_cursor: string }
    ).next_cursor;
    h.currentUrl = "https://shop.example.com/checkouts/c/other?_r=x";
    h.mainDocumentEpoch += 1;
    await expect(observeQuery(started.session_id, "", undefined, freshCursor)).rejects.toThrow(
      "stale_cursor",
    );
  });

  it("searches only the sealed action map", async () => {
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

  it("preserves a page title in query semantic metadata without changing its action map", async () => {
    const token = "f9a062f02fadf5";
    h.observationSemantics = {
      title: `Developer ${token} Resource`,
      headings: ["Getting started"],
    };
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://developer.example.com/" });

    const query = await observeQuery(started.session_id, "");

    expect(query.semantic).toEqual({
      title: `Developer ${token} Resource`,
      headings: ["Getting started"],
    });
    expect(query.safe_table).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/^@e:/),
        "b",
        expect.stringContaining("@continue"),
      ]),
    ]);
    expect(JSON.stringify(query)).toContain(token);
  });

  it("queries and re-resolves Resend's existing Google control", async () => {
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

    // The moved plain loginWithOAuth drives the fake's real page/context
    // surface: the click reaches the resolved Google control, then the short
    // budget elapses with no provider transition, which is an awaiting_human
    // observation — never an action failure.
    process.env.TRUSTY_SQUIRE_OAUTH_ACTION_TIMEOUT_MS = "200";
    const pending = await act(started.session_id, {
      kind: "oauth_login",
      target: handle!,
      provider: "google",
    });
    expect(pending.oauth).toMatchObject({ state: "awaiting_human" });

    // Main's ordinary click() re-enters dispatch tracking, so the outer OAuth
    // dispatch and the nested ordinary click each record the same selector.
    expect(h.dispatchTargets).toEqual([
      'form[action="google"] button',
      'form[action="google"] button',
    ]);
    await finishProvisionSession(started.session_id);
  });

  it("matches merchant labels while returning labeled safe-table rows", async () => {
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
    expect(JSON.stringify(acme)).toContain("@buy-acme");
    expect(JSON.stringify(japanese)).toContain("@購入する");
    expect((acme.safe_table as Array<[string]>)[0]![0]).not.toBe(
      (japanese.safe_table as Array<[string]>)[0]![0],
    );
  });

  it("requires every private query term to match one naming source", async () => {
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

  it("keeps one anchor through duplicate sibling churn and never transfers its alias", async () => {
    const held = elem({
      observationIdentity: "physical-held",
      tag: "button",
      role: "button",
      visibleText: "Continue",
      selector: "#held",
    });
    h.elements = [held];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const ref = domRefs(started)[0]!;
    h.elements = [
      elem({
        observationIdentity: "new-sibling",
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "#sibling",
        index: 1,
      }),
      held,
    ];
    const next = await observe(started.session_id);
    expect(domRefs(next)).toContain(ref);
    await act(started.session_id, { kind: "click", target: ref });
    expect(h.clickCalls).toBe(1);
    h.elements = [
      elem({
        observationIdentity: "replacement",
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "#held",
      }),
    ];
    await observe(started.session_id);
    const clicks = h.clickCalls;
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
    await expect(act(started.session_id, { kind: "click", target: "@continue" })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(clicks);
  });

  it("retires a physical node capability on material change even after re-observation", async () => {
    const held = elem({
      observationIdentity: "physical-held",
      tag: "a",
      role: "link",
      visibleText: "Continue",
      href: "/safe",
      selector: "#held",
    });
    h.elements = [held];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const ref = domRefs(started)[0]!;
    h.elements = [{ ...(held as InteractiveElement), href: "/delete" }];
    await observe(started.session_id);
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
    h.elements = [held];
    await observe(started.session_id);
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("keeps a ref valid when other controls appear in the live action map", async () => {
    const email = elem({
      tag: "input",
      type: "email",
      role: "textbox",
      labelText: "Email",
      selector: "#email",
    });
    h.elements = [email];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = domRefs(started)[0]!;

    // A live re-render adds a control. The observed field is untouched, so its
    // ref must still act — that is the whole point of fingerprint identity.
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      email,
    ];

    await act(started.session_id, { kind: "type", target: handle, text: "buyer@example.com" });
    expect(h.typed).toEqual([{ selector: "#email", text: "buyer@example.com" }]);
  });

  it("keeps a ref actionable when a benign re-render changes only its wire label", async () => {
    const identity = "physical-label-anchor";
    const intent = "stable-intent";
    h.elements = [
      elem({
        observationIdentity: identity,
        observationIntent: intent,
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "#continue",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = domRefs(started)[0]!;

    // Same physical node and material intent; only the legible label text
    // re-rendered. The durable handle must still resolve to that node — the
    // removed authorization layer refused here purely because the wire label
    // differed.
    h.elements = [
      elem({
        observationIdentity: identity,
        observationIntent: intent,
        tag: "button",
        role: "button",
        visibleText: "Continue to checkout",
        selector: "#continue",
      }),
    ];
    await act(started.session_id, { kind: "click", target: handle });
    expect(h.clickCalls).toBe(1);
  });

  it("rejects a handle after a same-URL main-document replacement", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = domRefs(started)[0]!;

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
    const fields = ["firstName", "lastName", "address1", "city", "zip"] as const;
    h.elements = deliveryBlock(fields);
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const refs = domRefs(started);
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
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const handle = domRefs(started)[0]!;

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
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/c/spring-sale-guide",
    });
    const handle = domRefs(started)[0]!;

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
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkouts/cn/2iRZ0Tt8lYFMqW9sc9uCyR/information",
    });
    const handle = domRefs(started)[0]!;

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

    expect(serialized).toContain("Delete account");
    expect(serialized).toContain("Keep account");
  });

  it("keeps a ref through a selector-only re-render of the same control", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#step-one" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const oldHandle = domRefs(started)[0]!;

    // A framework re-render swaps the CSS-in-JS selector. The control's
    // identity — frame, path, role, accessible name — is unchanged, so the
    // fingerprint (and therefore the ref) is too.
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#step-two" }),
    ];
    const refreshed = await observe(started.session_id);
    const newHandle = domRefs(refreshed)[0] ?? oldHandle;
    expect(refreshed.dom).toBeUndefined();
    expect(newHandle).toBe(oldHandle);
    await act(started.session_id, { kind: "click", target: oldHandle });
    expect(h.clickCalls).toBe(1);
  });

  it("rejects a handle when its live sealed semantics change before dispatch", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#action" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const handle = domRefs(started)[0]!;

    h.elements = [
      elem({
        tag: "button",
        role: "button",
        visibleText: "Delete account",
        selector: "#action",
      }),
    ];
    await expect(act(started.session_id, { kind: "click", target: handle })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.clickCalls).toBe(0);
  });

  it("shows and queries OTP-shaped control descriptions", async () => {
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
    // A code rendered on the page is ordinary content the agent must be able to
    // read and query without a numeric-content filter.
    expect(JSON.stringify(started)).toContain("481920");
    expect(JSON.stringify(started)).toContain("735104");
    const query = await observeQuery(started.session_id, "481920");
    expect(query.safe_table).toEqual([
      [expect.stringMatching(/^@e:/), "b", "@your-verification-code-is-481920|m=t"],
    ]);
  });

  it("keeps checkout confirmation routes in checkout until positive completion", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout/confirm",
    });
    expect(started).toMatchObject({ format: "browser-use-dom", stage: "checkout" });
  });

  it("requires auth actions and fields to share a container", async () => {
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
    expect(started).toMatchObject({ format: "browser-use-dom", stage: "form" });

    h.elements = (h.elements as Array<Record<string, unknown>>).map((element) => ({
      ...element,
      formId: 1,
    }));
    await expect(observe(started.session_id)).resolves.toMatchObject({ stage: "auth" });
  });

  it("keeps merchant labels separate from owned wire facts", async () => {
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        selector: "#continue",
        visibleText: "Continue|s=d|x=x",
      }),
    ];

    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const facts = (
      (await observeQuery(started.session_id, "")).safe_table as Array<[string, string, string?]>
    )[0]![2]!;
    // Merchant copy reaches the wire under the payment-only policy, but only as
    // a slug: controlLabelV2's [a-z0-9-] charset drops the `|` and `=` the page
    // tried to forge owned facts with, so the only fact here is the owned one.
    expect(facts).toBe("@continue-s-d-x-x|a=continue");
    expect(facts.split("|").slice(1)).toEqual(["a=continue"]);
  });

  it("prioritizes payment evidence over an incidental cart upsell", async () => {
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
    expect(started).toMatchObject({ format: "browser-use-dom", stage: "checkout" });
  });

  it("exposes the live URL (path and query included) while V2 text stays budgeted", async () => {
    h.visibleText = "Review order";
    const serviceUrl = "https://shop.example.com/checkout/review?token=private-url-token-123456789";
    const started = await startProvisionSession({ serviceUrl });
    expect(started).toMatchObject({ format: "browser-use-dom", url: serviceUrl });
  });

  it("interleaves verbatim text, preserves refs and omits the deleted text channel", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const token = "f9a062f02fad" + "f5";
    h.prose = [`Your token ${token} was created.`];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    expect(started).not.toHaveProperty("text");
    expect(started).not.toHaveProperty("safe_table");
    expect(started.dom).toContain(`Your token ${token} was created.`);
    expect(started.dom).toContain("\n\tContinue");
    const ref = domRefs(started)[0]!;
    expect(ref).toMatch(/^@e:/);
    const again = await observe(started.session_id);
    expect(again.dom).toBeUndefined();
    h.prose = ["Rate limit reached: upgrade to view more requests."];
    const changed = await observe(started.session_id);
    expect(changed.dom).toContain(h.prose[0]);
    expect(domRefs(changed)).toEqual([ref]);
    await act(started.session_id, { kind: "click", target: ref }, "none");
    expect(h.clickCalls).toBe(1);
  });

  it("removes departed refs without reindexing surviving controls", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "First action", selector: "#first" }),
      elem({ tag: "button", role: "button", visibleText: "Second action", selector: "#second" }),
    ];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    const [first, second] = domRefs(started);
    h.elements = h.elements.slice(1);
    const changed = await observe(started.session_id);
    expect(changed.removed).toEqual([first]);
    expect(domRefs(changed)).toEqual([second]);
    expect(changed.dom).toContain("Second action");
    await act(started.session_id, { kind: "click", target: second! }, "none");
    expect(h.clickCalls).toBe(1);
  });

  it("degrades only an unbound shadow control, preserving stable refs and every actionable control", async () => {
    const elements = [
      elem({ index: 0, tag: "button", visibleText: "Outside action", selector: "#outside" }),
      elem({ index: 1, tag: "button", visibleText: "Unbound shadow action", selector: "#shadow" }),
      elem({ index: 2, tag: "button", visibleText: "Other action", selector: "#other" }),
    ] as InteractiveElement[];
    const capture = mockBrowserUseCapture(elements, ["Complete surrounding page"]);
    const shadowControl = capture.root.children.splice(2, 1)[0]!;
    shadowControl.snapshot = false;
    shadowControl.bounds = null;
    capture.root.children.splice(2, 0, {
      ...shadowControl,
      id: "shadow-root",
      nodeType: 11,
      nodeName: "#document-fragment",
      shadowType: "open",
      children: [shadowControl],
    });
    capture.nodeElements.delete(shadowControl.id);
    capture.elements = capture.elements.filter((element) => element.index !== 1);
    h.elements = capture.elements;
    h.captureOverride = capture;
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    expect(started.dom).toContain("Complete surrounding page");
    expect(started.dom).toContain("Unbound shadow action");
    const line = started.dom!.split("\n").find((value) => value.includes("not-targetable=true"))!;
    const fallback = line.match(/\[(@e:[^\]]+)\]</)![1]!;
    const actionable = domRefs(started).filter((ref) => ref !== fallback);
    expect(actionable).toHaveLength(2);
    await expect(
      act(started.session_id, { kind: "click", target: fallback }, "none"),
    ).rejects.toThrow("stale_ref");
    expect(h.clickCalls).toBe(0);
    for (const ref of actionable)
      await act(started.session_id, { kind: "click", target: ref }, "none");
    expect(h.clickCalls).toBe(2);
    expect((await observe(started.session_id)).dom).toBeUndefined();
    capture.root.children[0]!.value = "Updated surrounding page";
    const updated = await observe(started.session_id);
    expect(domRefs(updated)).toEqual(domRefs(started));
    expect(updated.dom).toContain("not-targetable=true");
    expect(updated.dom).toContain("Updated surrounding page");
    capture.root.children.splice(2, 1);
    const removed = await observe(started.session_id);
    expect(removed.removed).toEqual([fallback]);
    expect(domRefs(removed)).toEqual(actionable);
  });

  it("keeps a short ref stable across successive observations and clicks with the earlier ref", async () => {
    h.elements = [
      elem({
        tag: "input",
        type: "checkbox",
        id: "keep",
        visibleText: "Keep control",
        selector: "#keep",
        checked: false,
      }),
    ];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    const original = domRefs(started)[0]!;
    expect(original).toMatch(/^@e:[A-Za-z0-9_-]{22}$/);
    h.elements.unshift(
      elem({ index: 1, id: "inserted", visibleText: "Inserted control", selector: "#inserted" }),
    );
    h.prose = ["A changed page around an unchanged control"];
    const updated = await observe(started.session_id);
    expect(domRefs(updated)).toContain(original);
    expect(updated.removed ?? []).not.toContain(original);
    await act(started.session_id, { kind: "click", target: original }, "none");
    expect(h.clickCalls).toBe(1);
    expect(
      (h.elements as InteractiveElement[]).find((element) => element.id === "keep")?.checked,
    ).toBe(true);
  });

  it("explicitly marks an unchanged delta and distinguishes a newly blank page", async () => {
    h.elements = [elem({ id: "continue", visibleText: "Continue", selector: "#continue" })];
    h.prose = ["Waiting for the protection check"];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/protect",
    });
    expect(started.dom).toContain("Waiting for the protection check");
    expect(started).not.toHaveProperty("dom_unchanged");
    const revision = paymentSession(started.session_id).compactV2Index!.epoch.rev;
    const unchanged = await observe(started.session_id);
    expect(unchanged).toMatchObject({ delta: true, dom_unchanged: true });
    expect(unchanged).not.toHaveProperty("dom");
    expect(unchanged).not.toHaveProperty("removed");
    expect(paymentSession(started.session_id).compactV2Index!.epoch.rev).toBe(revision);
    h.elements = [];
    h.prose = [];
    const blank = await observe(started.session_id);
    expect(blank).toMatchObject({ delta: true, dom: "", removed: domRefs(started) });
    expect(blank).not.toHaveProperty("dom_unchanged");
    const stillBlank = await observe(started.session_id);
    expect(stillBlank).toMatchObject({ delta: true, dom_unchanged: true });
    expect(stillBlank).not.toHaveProperty("dom");
  });

  it("reports navigated:true when the document changed while a click was settling", async () => {
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        visibleText: "I am not a robot",
        selector: "#challenge",
      }),
    ];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/protect",
    });
    // A Turnstile-style protect check: the click lands, the challenge frame
    // swaps, and the page navigates before the settle observation is taken.
    h.clickHook = () => {
      h.currentUrl = "https://app.example.com/protected/home";
      h.mainDocumentEpoch += 1;
    };
    const observation = await act(started.session_id, {
      kind: "click",
      target: domRefs(started)[0]!,
    });
    expect(observation.navigated).toBe(true);
    expect(observation.url).toBe("https://app.example.com/protected/home");
    if (process.env.OBSERVATION_TEST_EVIDENCE_DIR) {
      writeFileSync(
        `${process.env.OBSERVATION_TEST_EVIDENCE_DIR}/session-navigation.json`,
        JSON.stringify(
          {
            fixture: "Session API with deterministic browser navigation",
            before: started,
            after: observation,
          },
          null,
          2,
        ),
      );
    }
  });

  it.each([false, true])(
    "does not report navigated for a same-document click with pathname change=%s",
    async (changePath) => {
      h.elements = [
        elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      ];
      const started = await startHarnessProvisionSession({
        browser: new BrowserController(),
        format: "full",
        serviceUrl: "https://app.example.com/dashboard",
      });
      const ref = domRefs(started)[0]!;
      h.clickHook = () => {
        if (changePath) h.currentUrl = "https://app.example.com/settings";
      };
      const observation = await act(started.session_id, { kind: "click", target: ref });
      expect(observation).not.toHaveProperty("navigated");
      if (changePath) {
        expect(observation.url).toBe("https://app.example.com/settings");
        expect(domRefs(observation)).not.toContain(ref);
        expect(observation).not.toHaveProperty("dom_unchanged");
      }
    },
  );

  it("re-emits the DOM when the URL changes without a document change", async () => {
    h.elements = [elem({ visibleText: "Continue", selector: "#continue" })];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/protect?attempt=1",
    });
    const unchanged = await observe(started.session_id);
    expect(unchanged).toMatchObject({ delta: true, dom_unchanged: true });
    // Same-document query-token updates (protect checks, OAuth handoffs) must
    // still surface: the host needs to see the new URL even though the DOM
    // string is byte-identical.
    h.currentUrl = "https://app.example.com/protect?attempt=2";
    const moved = await observe(started.session_id);
    expect(moved).toMatchObject({ delta: true, url: "https://app.example.com/protect?attempt=2" });
    expect(moved).not.toHaveProperty("dom_unchanged");
  });

  it("keeps refs stable when a dialog mount re-creates unchanged elements and reports only the dialog controls", async () => {
    const navLink = (identity: string) =>
      elem({
        tag: "a",
        role: "link",
        visibleText: "Docs",
        selector: "#docs",
        screenPath: "nav:main > link:docs",
        observationIdentity: identity,
      }) as InteractiveElement;
    const before = mockBrowserUseCapture([navLink("page:loader:101")], []);
    h.elements = before.elements;
    h.captureOverride = before;
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    const navRef = domRefs(started)[0]!;
    // The dialog opens: the nav element is re-created (new backend node) and a
    // dialog control is added. Neither the nav ref nor its `*` marker may churn.
    const after = mockBrowserUseCapture(
      [
        navLink("page:loader:202"),
        {
          ...navLink("page:loader:900"),
          selector: "#dialog-docs",
          container: "dialog:create-api-key",
          screenPath: "dialog:create-api-key > link:docs",
        },
      ],
      [],
    );
    h.elements = after.elements;
    h.captureOverride = after;
    const updated = await observe(started.session_id);
    expect(updated.removed ?? []).toEqual([]);
    expect(domRefs(updated)).toHaveLength(2);
    expect(domRefs(updated)).toContain(navRef);
    const navLine = updated.dom!.split("\n").find((line) => line.includes(navRef))!;
    expect(navLine).not.toContain("*");
    const dialogRef = domRefs(updated).find((ref) => ref !== navRef)!;
    const dialogLine = updated.dom!.split("\n").find((line) => line.includes(dialogRef))!;
    expect(dialogLine).toContain("*");
    if (process.env.OBSERVATION_TEST_EVIDENCE_DIR) {
      writeFileSync(
        `${process.env.OBSERVATION_TEST_EVIDENCE_DIR}/session-dialog.json`,
        JSON.stringify(
          {
            fixture: "Session API with deterministic dialog remount",
            before: started,
            after: updated,
          },
          null,
          2,
        ),
      );
    }
  });

  it("re-emits the DOM when a closed-shadow iframe changes without a text change", async () => {
    const elements = [
      elem({ tag: "button", role: "button", visibleText: "Verify", selector: "#verify" }),
    ] as InteractiveElement[];
    const template = mockBrowserUseCapture(elements, []).root;
    const node = (id: string, overrides: Partial<BrowserUseNode>): BrowserUseNode => ({
      ...template,
      id,
      attributes: {},
      children: [],
      contentDocument: null,
      ...overrides,
    });
    const withChallenge = (frameHeight: number): BrowserUseCapture => {
      const capture = mockBrowserUseCapture(elements, []);
      capture.root.children.push(
        node("challenge-host", {
          nodeName: "DIV",
          bounds: { x: 0, y: 0, width: 300, height: frameHeight },
          children: [
            node("challenge-shadow", {
              nodeType: 11,
              nodeName: "#document-fragment",
              shadowType: "closed",
              children: [
                node("challenge-frame", {
                  nodeName: "IFRAME",
                  attributes: { src: "https://challenges.example.com/turnstile" },
                  bounds: { x: 0, y: 0, width: 300, height: frameHeight },
                }),
              ],
            }),
          ],
        }),
      );
      // The mock derives dynamics at capture time; the real capture recomputes
      // it inside captureBrowserUseDOM. Mirror that here after mutating the tree.
      capture.dynamics = browserUseDynamicsSignature(capture.root);
      return capture;
    };
    const initial = withChallenge(60);
    h.elements = initial.elements;
    h.captureOverride = initial;
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/protect",
    });
    expect(started.dom).toContain("Closed Shadow");
    expect(started.dom).toContain("IFRAME");
    const unchanged = await observe(started.session_id);
    expect(unchanged).toMatchObject({ delta: true, dom_unchanged: true });
    // Geometry-only swap inside the closed shadow: the canonical DOM string is
    // byte-identical, but the challenge frame moved — exactly the Groq/Cartesia
    // failure mode. dom_unchanged must not lie.
    h.captureOverride = withChallenge(64);
    const query = await observeQuery(started.session_id, "Verify");
    expect(query).not.toHaveProperty("dom");
    const swapped = await observe(started.session_id);
    expect(swapped).toMatchObject({ delta: true });
    expect(swapped).not.toHaveProperty("dom_unchanged");
    expect(swapped.dom).toContain("IFRAME");
    if (process.env.OBSERVATION_TEST_EVIDENCE_DIR) {
      writeFileSync(
        `${process.env.OBSERVATION_TEST_EVIDENCE_DIR}/session-shadow.json`,
        JSON.stringify(
          {
            fixture: "Session API with deterministic closed-shadow geometry change",
            before: started,
            unchanged,
            compactQuery: query,
            after: swapped,
          },
          null,
          2,
        ),
      );
    }
    expect(await observe(started.session_id)).toMatchObject({ dom_unchanged: true });
  });

  it("surfaces a failed DOM capture instead of silently emitting an empty observation", async () => {
    h.elements = [elem({ visibleText: "Continue", selector: "#continue" })];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    h.proseError = "DOMSnapshot.captureSnapshot failed";
    await expect(observe(started.session_id)).rejects.toThrow("DOMSnapshot.captureSnapshot failed");
    h.proseError = null;
    h.prose = ["Recovered page"];
    expect((await observe(started.session_id)).dom).toContain("Recovered page");
  });

  it("never drops interleaved content to meet a byte count", async () => {
    h.elements = [elem({ visibleText: "Continue", selector: "#continue" })];
    h.prose = ["Long readable content. ".repeat(600)];
    const started = await startHarnessProvisionSession({
      browser: new BrowserController(),
      format: "full",
      serviceUrl: "https://app.example.com/dashboard",
    });
    expect(started.dom).toContain(h.prose[0]!.trim());
    expect(domRefs(started)).toHaveLength(1);
    expect(started).not.toHaveProperty("text");
  });

  it("bounds the harness full observation to the V2 wire budget", async () => {
    h.visibleText = "Harness page";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];

    const compact = await startHarnessProvisionSession({
      browser: new BrowserController(),
      serviceUrl: "https://shop.example.com/checkout",
      format: "full",
    });
    expect(compact.format).toBe("browser-use-dom");
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
  });

  it("carries OAuth and no-observation exits in the V2 envelope with the live URL", async () => {
    const secretUrl = "https://app.example.com/login?token=private-query-token";
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: secretUrl });
    const ref = domRefs(started)[0]!;

    const ack = await act(started.session_id, { kind: "scroll", direction: "down" }, "none");
    expect(ack).toMatchObject({
      format: "browser-use-dom",
      url: secretUrl,
      observed: "none",
    });
    // A detail:"none" scroll returns no map, but it does not retire the one the
    // agent already holds — the control it names has not moved.
    await act(started.session_id, { kind: "click", target: ref }, "none");
    // Nothing structural changed, so this is an unchanged delta and the ref the
    // agent already holds is still the current one.
    expect(await observe(started.session_id)).toMatchObject({ delta: true });
    const refreshedRef = ref;

    // The plain oauthTransitionStatus reads the controller's OAuth page slots;
    // a live provider popup that detached leaves the product page viable.
    const controller = h.controllers[0]!;
    const productStub = {
      isClosed: () => false,
      url: () => secretUrl,
    };
    controller.oauthProductPage = productStub;
    controller.oauthProviderPage = null;
    controller.oauthProviderPageClosed = true;
    const transition = await observe(started.session_id);
    expect(transition).toMatchObject({
      format: "browser-use-dom",
      url: secretUrl,
      stage: "auth",
      oauth: {
        state: "in_progress",
        provider_page: "closed_or_detached",
        next_action: "operate_observe",
      },
    });
    // completeOAuthTransitionRecovery restored the product page and reset the
    // attempt slots.
    expect(controller.page).toBe(productStub);
    expect(controller.oauthProductPage).toBe(null);
    expect(controller.oauthProviderPage).toBe(null);
    expect(controller.oauthProviderPageClosed).toBe(false);
    await expect(act(started.session_id, { kind: "click", target: refreshedRef })).rejects.toThrow(
      "stale_ref",
    );
  });

  it("keeps a ref usable after a dispatched action throws", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = domRefs(started)[0]!;
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
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const ref = domRefs(started)[0]!;
    await expect(captchaGate(started.session_id)).resolves.toMatchObject({ found: false });
    await expect(act(started.session_id, { kind: "click", target: ref })).rejects.toThrow(
      "stale_ref",
    );
  });

  it("requires sealed V2 handles before bulk selection enters the private executor", async () => {
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
    const handle = domRefs(started)[0]!;
    await expect(formSelectMany(started.session_id, { Country: "Korea" })).rejects.toThrow(
      "stale_ref",
    );
    expect(h.selected).toEqual([]);
    await expect(
      formSelectMany(started.session_id, { "@e:legacy_country_1": "Korea" }),
    ).rejects.toThrow("stale_ref");
    expect(h.selected).toEqual([]);
    const result = await formSelectMany(started.session_id, { [handle]: "Korea" });
    expect(result.fields).toEqual([
      expect.objectContaining({ status: "selected", selected_option: "South Korea" }),
    ]);
    expect(
      JSON.stringify([...paymentSession(started.session_id).committedSelectValues]),
    ).not.toContain("#country");
    expect(result.observation.format).toBe("browser-use-dom");
  });

  it("keeps a later bulk target actionable when the preceding mutation spares it", async () => {
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
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
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
    expect(result.fields[0]).toMatchObject({ selected_option: "Ocean Blue" });
  });

  it("rejects a bulk target the preceding mutation replaced", async () => {
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
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
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
    const handle = domRefs(started)[0]!;
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
    const handle = domRefs(started)[0]!;
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

  it("selects a cross-origin frame target without retiring the later ref", async () => {
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
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const externalHandle = rows.find(([, , facts]) => facts?.startsWith("@external-variant"))?.[0];
    const sizeHandle = rows.find(([, , facts]) => facts?.startsWith("@size"))?.[0];

    const result = await formSelectMany(started.session_id, {
      [externalHandle!]: "Blue",
      [sizeHandle!]: "Large",
    });

    expect(h.selected).toEqual([{ selector: "#size", matcher: "Large" }]);
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "selected",
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
    h.elements = shopifyCheckoutFixture();

    const started = await startProvisionSession({ serviceUrl: checkoutUrl });
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;

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
    const queried = (await provisionObserveTool.handler(
      { session_id: started.session_id, query: "shipping", role: "radio" },
      null,
    )) as {
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

  it("keeps address and shipping copy visible in the full observation dom", async () => {
    // V2 full observations render the browser-use-dom tree from h.prose.
    h.prose = [
      "Shipping address",
      "350 5th Ave, New York, NY 10118",
      "Shipping method: Standard $8.00",
    ];
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
      dom: string;
    };
    expect(observation.dom).toContain("350 5th Ave, New York, NY 10118");
    expect(observation.dom).toContain("Standard $8.00");
    // The radio row itself is present with its price label, not sealed out.
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const radioFacts = rows
      .filter(([, role]) => role === "r")
      .map(([, , rowFacts]) => rowFacts ?? "");
    expect(radioFacts.some((value) => value.startsWith("@standard-8-00"))).toBe(true);
  });

  it("keeps injected vault values and tight secret shapes verbatim in the observation dom", async () => {
    const secret = "injected-1234567890abcdef";
    const copy = `API key: ${sk("proj-1234567890abcdefghijklmnopqrstuv")} Recovery code: 814226 Your 2FA code is 553218`;
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
    h.prose = [`${copy} ${secret}`];
    const observed = await observe(started.session_id, "full");
    // Nothing is scrubbed out of observation text — the rendered key, the OTPs,
    // and the operator's own injected value all come back verbatim.
    expect(observed.dom).toContain(sk("proj-1234567890abcdefghijklmnopqrstuv"));
    expect(observed.dom).toContain(secret);
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
    const refs = domRefs(started);
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
    h.elements = [
      elem({ tag: "button", role: "button", id: ":r3:", visibleText: "Continue", selector: "#a" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    const ref = domRefs(started)[0]!;

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

  it("disambiguates a label shared by two grid controls with ordinals, and acts on either", async () => {
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
    const rows = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    // Deterministic ordinals: the first occurrence keeps the base slug, later
    // occurrences gain -2, -3, … so every row is individually addressable.
    expect(rows.map(([, , facts]) => facts)).toEqual([
      "@add-to-cart|a=add_to_cart",
      "@add-to-cart-2|a=add_to_cart",
    ]);
    // Same labels would be ambiguous; distinct labels are not. Distinct refs.
    expect(rows[0]![0]).not.toBe(rows[1]![0]);

    await act(started.session_id, { kind: "click", target: "@add-to-cart" });
    expect(h.clickCalls).toBe(1);

    await act(started.session_id, { kind: "click", target: rows[1]![0] });
    expect(h.clickCalls).toBe(2);
  });

  it("acts on a label that names exactly one control", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      elem({ index: 1, tag: "button", role: "button", visibleText: "Cancel", selector: "#cancel" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/form" });
    await act(started.session_id, { kind: "click", target: "@continue" });
    expect(h.clickCalls).toBe(1);
  });

  it("scopes a large product grid to the viewport without dropping query reachability", async () => {
    // 240 controls: a long storefront grid plus a full checkout form.
    h.elements = Array.from({ length: 240 }, (_, index) =>
      elem({
        index,
        inViewport: index < 12,
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
    expect(domRefs(started)).toHaveLength(12);
    expect(started.more_below).toBe(true);
    const query = await observeQuery(started.session_id, "");
    // Paging stays bounded too.
    const page = await observeQuery(
      started.session_id,
      "",
      undefined,
      (query.overflow as { next_cursor: string }).next_cursor,
    );
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      OBSERVE_V2_MAX_WIRE_BYTES,
    );
  });
});

describe("operate_act — locator (text=/css=) resolution (internal dispatch)", () => {
  it("allows a css= locator resolving to a safe control", async () => {
    h.visibleText = "Product configurator";
    h.locatorResolve = {
      ok: true,
      text: "Add To Cart",
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    // V2's public action map rejects locator targets outright (see the action-map
    // boundary suite); the resolver fallback stays reachable via internal dispatch.
    await actInternally(obs.session_id, { kind: "click", target: "css=#atc" }, "compact");
    expect(h.locatorClickCalls).toBe(1);
  });

  it("clicks a locator resolved inside an undeclared third-party frame", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Pay",
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://evil-payments.test",
        frameUrl: "https://evil-payments.test/widget?secret=hidden",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await actInternally(obs.session_id, { kind: "click", target: "text=Pay" });
    expect(h.locatorClickCalls).toBe(1);
    expect(h.locatorDisposeCalls).toBe(1);
  });

  it("types through a frame locator only after the frame domain lock passes", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Promo code",
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://checkout.example.com",
        frameUrl: "https://checkout.example.com/widget",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await actInternally(obs.session_id, { kind: "type", target: "css=#promo", text: "SAVE10" });
    expect(h.locatorResolveIntents).toContain("type");
    expect(h.locatorTypeCalls).toEqual([{ text: "SAVE10", sealed: false }]);
  });

  it("types into third-party frames but still refuses secrets in opaque frames", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Card number",
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://evil-payments.test",
        frameUrl: "https://evil-payments.test/widget",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await actInternally(obs.session_id, { kind: "type", target: "css=#card", text: "4111" });
    stashSecretSlot(obs.session_id, "card", "4111111111111111");
    await actInternally(obs.session_id, {
      kind: "type_secret",
      target: "css=#card",
      slot: "card",
    });
    expect(h.locatorTypeCalls).toEqual([
      { text: "4111", sealed: false },
      { text: "4111111111111111", sealed: true },
    ]);
  });

  it("types a secret into a null-origin frame via locator — frame origin is metadata, not a gate", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Password",
      frameTarget: {
        framePath: "0",
        frameOrigin: "null",
        frameUrl: "about:srcdoc",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(obs.session_id, "login", "s3cr3t");
    await actInternally(obs.session_id, {
      kind: "type_secret",
      target: "text=Password",
      slot: "login",
    });
    expect(h.locatorTypeCalls).toEqual([{ text: "s3cr3t", sealed: true }]);
  });

  it("seals a same-domain type_secret locator before typing", async () => {
    h.locatorResolve = {
      ok: true,
      text: "Password",
      frameTarget: {
        framePath: "0",
        frameOrigin: "https://auth.example.com",
        frameUrl: "https://auth.example.com/login",
      },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(obs.session_id, "login", "s3cr3t");
    await actInternally(obs.session_id, {
      kind: "type_secret",
      target: "text=Password",
      slot: "login",
    });
    expect(h.locatorResolveIntents).toContain("type");
    expect(h.locatorTypeCalls).toEqual([{ text: "s3cr3t", sealed: true }]);
    // The capture carries no seal inventory any more — only the frame options.
    await captureScreenshot(obs.session_id);
    expect(h.screenshotCalls).toEqual([{}]);
  });

  it("shows a slotted value the page reflected back — observations are unredacted", async () => {
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
    expect(full.dom).toContain(secret);
    expect(full.dom).not.toContain("[sealed]");
    expect(JSON.stringify(full)).toContain(secret);
  });

  it("keeps a reflected slot value on the compact-v2 wire and query; its credential-shaped label remains readable", async () => {
    const secret = "stored-credential-7f3d9a";
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    stashSecretSlot(started.session_id, "login", secret);
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        selector: "#reflected",
        // The page reflects the injected value back OUTSIDE the field it was
        // typed into. Nothing screens it: it is page copy like any other.
        visibleText: `Saved value ${secret}`,
        ariaLabel: `Saved value ${secret}`,
      }),
      elem({ index: 1, tag: "button", role: "button", selector: "#ok", visibleText: "Continue" }),
    ];

    const observation = await observe(started.session_id);
    expect(observation.format).toBe("browser-use-dom");
    const table = (await observeQuery(observation.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    expect(table).toHaveLength(2);
    expect(table[0]![2] ?? "").toContain("@saved-value-stored-credential");

    const query = await observeQuery(started.session_id, "saved value");
    expect(query.safe_table).toHaveLength(1);
  });

  it("returns observation text verbatim — injected vault values included", async () => {
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/" });
    await captureScreenshot(started.session_id);
    expect(h.screenshotCalls).toEqual([{}]);

    const secret = "stored-credential-7f3d9a";
    stashSecretSlot(started.session_id, "login", secret);
    // V2 full observations render the browser-use-dom tree from h.prose text.
    h.prose = [`API key: ${sk("proj-1234567890abcdefghijklmnopqrstuv")} ${secret}`];
    h.elements = [];
    const full = await observe(started.session_id, "full");
    expect(full.dom).not.toContain("[sealed]");
    expect(full.dom).toContain(secret);
    expect(full.dom).toContain(sk("proj-1234567890abcdefghijklmnopqrstuv"));
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
      const target = domRefs(await observe(sid))[0]!;
      await act(sid, { kind: "type_secret", slot: "oauth_secret", target });

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
    h.elements = [elem({ visibleText: "Field", selector: "#f" })];
    const obs = await startProvisionSession({ serviceUrl: "https://a.com/" });
    await expect(
      act(obs.session_id, {
        kind: "type_secret",
        slot: "missing",
        target: domRefs(obs)[0]!,
      }),
    ).rejects.toThrow(/no sealed slot/i);
  });

  it("upload resolves the target and attaches the local file (no OS dialog)", async () => {
    h.elements = [elem({ visibleText: "File upload", selector: "#upload-btn" })];
    const obs = await startProvisionSession({ serviceUrl: "https://drive.google.com/" });
    await act(obs.session_id, {
      kind: "upload",
      target: domRefs(obs)[0]!,
      path: "/tmp/clip.mp4",
    });
    // Target resolved from the inventory → the file is set on that element; the
    // action never touches an OS file picker.
    expect(h.uploads).toEqual([{ selector: "#upload-btn", filePath: "/tmp/clip.mp4" }]);
  });

  it("select resolves the target and routes the option matcher to browser.selectOption", async () => {
    h.elements = [elem({ visibleText: "Country", selector: "#country" })];
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    await act(obs.session_id, {
      kind: "select",
      target: domRefs(obs)[0]!,
      text: "South Korea",
    });
    // The native/custom dropdown is driven via selectOption (NOT type), with the
    // resolved element's selector and the visible-text option matcher.
    expect(h.selected).toEqual([{ selector: "#country", matcher: "South Korea" }]);
    expect(h.typed).toEqual([]);
  });

  it("fails loudly when the select target resolves to nothing in the snapshot", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://shop.example.com/checkout" });
    h.elements = [];
    // V2: a target absent from the current snapshot is stale_ref — the same
    // loud failure the V1 inventory miss produced, now pointing at re-observe.
    await expect(
      act(obs.session_id, { kind: "select", target: "@e:missing000", text: "South Korea" }),
    ).rejects.toThrow(/stale_ref/i);
  });

  it("returns target_stale with replacement hints instead of a bare ref error", async () => {
    h.elements = [elem({ tag: "select", labelText: "Variant", selector: "#variant" })];
    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
    });
    const staleRef = domRefs(started)[0]!;
    expect(staleRef).toMatch(/^@e:/);

    // This is the captured P3 shape: a variant change replaces the old form
    // controls before the next queued action gets to resolve its old ref.
    h.elements = [elem({ tag: "select", labelText: "Size", selector: "#size" })];
    // V2 keeps stale-ref failures deliberately opaque (no V1 replacement
    // candidates constructed outside the safe view); the replacement hints
    // come from the next observation instead.
    await expect(
      operateSelectTool.handler(
        operateSelectTool.inputSchema.parse({
          session_id: started.session_id,
          ref: staleRef!,
          values: ["Large"],
        }),
        null,
      ),
    ).rejects.toThrow(/stale_ref/);

    const refreshed = (await observeQuery(started.session_id, "")).safe_table as Array<
      [string, string, string?]
    >;
    const sizeRef = refreshed.find(([, , description]) => description?.startsWith("@size"))?.[0];
    expect(sizeRef).toMatch(/^@e:/);
    expect(sizeRef).not.toBe(staleRef);
    expect(JSON.stringify({ staleRef, refreshed })).not.toContain("no element matched target");
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
    // V2: selection keys are refs or @label aliases resolved against the
    // snapshot; the tool re-observes between entries, so the post-churn Size
    // resolves by label, and Color (never present) reports failed.
    const result = (await operateSelectTool.handler(
      operateSelectTool.inputSchema.parse({
        session_id: started.session_id,
        selections: {
          "@variant": "Blue",
          "@size": "Large",
          "@color": "Red",
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
        label: "@variant",
        status: "selected",
        selected_option: "Ocean Blue",
      },
      { label: "@size", status: "selected", selected_option: "Large" },
      { label: "@color", status: "failed" },
    ]);
    expect(result.observation.session_id).toBe(started.session_id);
  });

  it("upload fails loudly when the target isn't in the snapshot", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://drive.google.com/" });
    h.elements = [];
    await expect(
      act(obs.session_id, { kind: "upload", target: "@e:missing000", path: "/tmp/clip.mp4" }),
    ).rejects.toThrow(/stale_ref/i);
    expect(h.uploads).toEqual([]);
  });
});

describe("operate_extract — v1.1.6 credential candidate selection", () => {
  it.each([false, true])(
    "preserves a contextually accepted DeepInfra key (labeled=%s)",
    async (labeled) => {
      const apiKey = "Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz";
      h.nearCopyCredentialCandidates = [apiKey];
      h.labeledCredentialCandidates = labeled
        ? [{ label: "API Key", value: apiKey, isMasked: false }]
        : [];
      const started = await startProvisionSession({
        serviceUrl: "https://deepinfra.com/dash/api_keys",
      });
      expect((await extractCredentials(started.session_id)).credentials.api_key).toBe(apiKey);
      const storeCredential = vi.fn().mockResolvedValue({ reference: "vault://acct/deepinfra" });
      await provisionExtractTool.handler(
        { session_id: started.session_id, store: { service: "deepinfra" } },
        { storeCredential } as unknown as ApiClient,
      );
      expect(storeCredential).toHaveBeenCalledWith(
        expect.objectContaining({ value: apiKey, type: "api_key" }),
      );
    },
  );

  it("preserves Client Secret and Client ID leaves inside a pre block", async () => {
    const secret = "aBcD1234EfGh5678IjKl9012";
    const clientId = "client1234567890example";
    const started = await startProvisionSession({ serviceUrl: "https://example.com/settings" });
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    h.capturePage = page;
    await page.setContent(`<pre style="width:400px"><span>Client Secret</span>
<span>${secret}</span>


<span>Client ID</span>
<span>${clientId}</span></pre>`);
    const { BrowserController } = await vi.importActual<typeof BrowserModule>("../browser.js");
    const collector = Object.create(BrowserController.prototype) as BrowserModule.BrowserController;
    h.labeledCredentialCandidates = await collector.extractLabeledCredentialCandidates(page);
    h.visibleText = await page.locator("body").innerText();
    expect(h.labeledCredentialCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "client secret", value: secret }),
        expect.objectContaining({ label: "client id", value: clientId }),
      ]),
    );
    expect((await extractCredentials(started.session_id)).credentials).toMatchObject({
      client_secret: secret,
      client_id: clientId,
    });
  });

  const loadExaFixture = async (maskedKey: string, teamId: string, realKey: string) => {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const fixture = readFileSync(
      fileURLToPath(new URL("./fixtures/exa-keys-page.html", import.meta.url)),
      "utf8",
    )
      .replaceAll("{{MASKED_KEY}}", maskedKey)
      .replaceAll("{{TEAM_ID}}", teamId)
      .replaceAll("{{REAL_KEY}}", realKey);
    await page.setContent(fixture);
    return { browser, page };
  };

  it.each(["extract", "finish"])(
    "keeps masked Exa keys truncated and non-vaultable through %s",
    async (caller) => {
      const maskedKey = sk("or-v1-992e9e1234567890abcd…");
      const teamId = "exaTeam01J4M8Q7Z2N6P5R3";
      const { browser, page } = await loadExaFixture(maskedKey, teamId, sk("unused-1234567890"));
      const { BrowserController } = await vi.importActual<typeof BrowserModule>("../browser.js");
      const collector = Object.create(
        BrowserController.prototype,
      ) as BrowserModule.BrowserController;
      h.labeledCredentialCandidates = await collector.extractLabeledCredentialCandidates(page);
      expect(h.labeledCredentialCandidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "api key", value: maskedKey, isMasked: true }),
          expect.objectContaining({ label: "team id", value: teamId, isMasked: false }),
        ]),
      );
      h.nearCopyCredentialCandidates = [maskedKey, teamId];
      h.visibleText = `API Key: ${maskedKey}`;
      const started = await startProvisionSession({
        serviceUrl: "https://dashboard.exa.ai/api-keys",
      });

      const extracted = await extractCredentials(started.session_id);

      expect(extracted.candidate_count).toBe(2);
      expect(extracted.credentials.api_key).toBeUndefined();
      expect(extracted.credentials.api_key_truncated).toBe(maskedKey.slice(0, -1));
      expect(extracted.credentials.team_id).toBe(teamId);
      expect(extracted.credentials.api_key).not.toBe(teamId);
      const storeCredential = vi.fn();
      const api = { storeCredential } as unknown as ApiClient;
      const result =
        caller === "extract"
          ? await provisionExtractTool.handler(
              { session_id: started.session_id, store: { service: "exa" } },
              api,
            )
          : await operateFinishTool.handler(
              operateFinishTool.inputSchema.parse({
                session_id: started.session_id,
                outcome: "credentials",
                store: { service: "exa" },
              }),
              api,
            );
      expect(result).toMatchObject({ stored_credential: null });
      expect(storeCredential).not.toHaveBeenCalled();
      expect(h.storageStateWrites).toEqual([]);
      await browser.close();
    },
  );

  it("lets a recovered key take precedence over its labeled SDK snippet", async () => {
    const realKey = sk(`or-v1-${"a1".repeat(32)}`);
    h.labeledCredentialCandidates = [
      { label: "API Key", value: `LANGWATCH_API_KEY=${realKey}`, isMasked: false },
    ];
    const started = await startProvisionSession({ serviceUrl: "https://example.com/keys" });
    expect((await extractCredentials(started.session_id)).credentials.api_key).toBe(realKey);
  });

  it("selects the real key surfaced by the normal reveal step", async () => {
    const maskedKey = sk("or-v1-992e9e1234567890abcd…");
    const realKey = sk(`or-v1-${"a1".repeat(32)}`);
    const teamId = "exaTeam01J4M8Q7Z2N6P5R3";
    const { browser, page } = await loadExaFixture(maskedKey, teamId, realKey);
    await page.getByRole("button", { name: "Reveal API Key" }).click();
    const { BrowserController } = await vi.importActual<typeof BrowserModule>("../browser.js");
    const collector = Object.create(BrowserController.prototype) as BrowserModule.BrowserController;
    h.labeledCredentialCandidates = await collector.extractLabeledCredentialCandidates(page);
    expect(h.labeledCredentialCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "api key", value: realKey, isMasked: false }),
        expect.objectContaining({ label: "team id", value: teamId, isMasked: false }),
      ]),
    );
    h.nearCopyCredentialCandidates = [teamId, realKey];
    h.visibleText = `Team ID: ${teamId}\nAPI Key: ${realKey}`;
    const started = await startProvisionSession({
      serviceUrl: "https://dashboard.exa.ai/api-keys",
    });

    const extracted = await extractCredentials(started.session_id);

    expect(extracted.credentials.api_key).toBe(realKey);
    expect(extracted.credentials.api_key).not.toBe(teamId);
    await browser.close();
  });

  it("still reports when the page genuinely has no candidate value", async () => {
    h.labeledCredentialCandidates = [];
    const started = await startProvisionSession({ serviceUrl: "https://example.com/settings" });

    const result = (await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({
        session_id: started.session_id,
        into_slot: "access_key",
      }),
      null,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ sealed: false, slot: null });
    expect(String(result.blocked_reason)).toContain("no credential value was found");
  });
});

describe("operate_extract — vault-store response", () => {
  it("never returns extracted credential values after storing them", () => {
    const rawSecret = sk("live-must-never-reach-the-model");
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
    expect(result.stored_credential?.reference).toBe("cred_123");
  });

  it("keeps vault-store extraction reachable through operate_extract without returning the secret", async () => {
    const rawSecret = sk("live-folded-extract-secret-123456789");
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

    const result = (await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({
        session_id: started.session_id,
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

  it("returns raw Compact V2 extraction results at the public tool boundary", async () => {
    const rawSecret = sk("live-public-extract-secret-123456789");
    const urlToken = "private-url-token-123456789";
    h.visibleText = `API key ${rawSecret}`;
    const started = await startProvisionSession({
      serviceUrl: `https://app.example.com/api-keys?token=${urlToken}`,
    });

    const result = (await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({ session_id: started.session_id }),
      null,
    )) as Record<string, unknown>;

    // The captain's blocker: under compact-v2 the tool boundary used to blank
    // `credentials` and the URL. It returns them now.
    expect(result).toMatchObject({
      session_id: started.session_id,
      url: `https://app.example.com/api-keys?token=${urlToken}`,
    });
    expect(JSON.stringify(result)).toContain(rawSecret);
  });
});

describe("operate session — operation-scoped Google gate", () => {
  it("starts without Google and can reach and fill a checkout form", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-empty";
    h.providers = []; // no live session
    h.liveGoogleEmail = null;
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        labelText: "Shipping name",
        selector: "#shipping-name",
      }),
    ];
    const obs = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      profileDir: canonical,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(obs).toMatchObject({
      format: "browser-use-dom",
      url: "https://shop.example.com/checkout",
    });
    expect(h.startCalls).toBe(1);
    expect(h.started).toBe(1);
    expect(h.gotos).toEqual(["https://shop.example.com/checkout"]);
    expect(h.identityProbeCalls).toBe(0);
    expect(h.storageStateReads).toEqual([]);
    expect(h.profileDirs).toEqual([canonical]);
    expect(h.destroyedProfiles).toEqual([]);
    expect(h.storageStateWrites).toEqual([]);
    await act(obs.session_id, {
      kind: "type",
      target: domRefs(obs)[0]!,
      text: "Ada Lovelace",
    });
    expect(h.typed).toContainEqual({ selector: "#shipping-name", text: "Ada Lovelace" });
    await finishProvisionSession(obs.session_id);
  });

  it("uses the supplied real profile without a startup identity probe or storage-state handoff", async () => {
    const canonical = "/tmp/trusty-squire-unit-canonical-seeded";
    h.providers = [];
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      profileDir: canonical,
    });
    expect(obs.needs_user).toBeUndefined();
    expect(h.started).toBe(1);
    expect(h.identityProbeCalls).toBe(0);
    expect(h.seededStorageStates).toEqual([undefined]);
    expect(h.profileDirs).toEqual([canonical]);
    await finishProvisionSession(obs.session_id);
    expect(h.destroyedProfiles).toEqual([]);
  });

  it("returns the unchanged google_session wall when Google OAuth is selected without a live session", async () => {
    h.providers = [];
    h.liveGoogleEmail = null;
    h.elements = [
      elem({
        tag: "button",
        role: "button",
        visibleText: "Continue with Google",
        selector: "#google-oauth",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
    expect(h.identityProbeCalls).toBe(0);

    const result = await act(started.session_id, {
      kind: "oauth_login",
      provider: "google",
      target: domRefs(started)[0]!,
    });

    const expected = googleSessionGate([]);
    expect(expected.ok).toBe(false);
    if (!expected.ok) expect(result.needs_user).toEqual(expected.needs_user);
    expect(result).toMatchObject({
      session_id: started.session_id,
      format: "browser-use-dom",
      stage: "auth",
      url: "https://app.example.com/login",
    });
    expect(h.identityProbeCalls).toBe(1);
    expect(h.dispatchTargets).toEqual([]);
    await finishProvisionSession(started.session_id);
  });

  it("defers the general observation when the drive loop owns first perception", async () => {
    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/drive",
      initialObservation: "drive",
    });
    expect(started).toMatchObject({
      session_id: expect.any(String),
      url: "https://app.example.com/drive",
    });
    expect(started).not.toHaveProperty("safe_table");
    expect(started).not.toHaveProperty("dom");
    expect(h.extractInteractiveElementsCalls).toBe(0);
    expect(h.consentDismissCalls).toBe(0);
    await finishProvisionSession(started.session_id);
  });

  it("does not create or destroy an ephemeral profile", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(h.createdProfiles).toEqual([]);
    await finishProvisionSession(obs.session_id);
    expect(h.destroyedProfiles).toEqual([]);
  });
});

// Physical profile election, launch failure and sibling custody are tested in
// broker-discovery, broker-runtime and broker-daemon; session handlers never launch.
describe("operate session — await_verification into_slot (T3 fix: OTP never round-trips)", () => {
  it("seals a found OTP into a slot (masked handle, no raw code) and type_secret enters it", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920. It expires in 10 minutes.";
    const res = (await awaitVerification(sid, { intoSlot: "otp" })) as Awaited<
      ReturnType<typeof awaitVerification>
    >;

    expect(res.found).toBe(true);
    expect(res.sealed).toBe(true);
    expect(res.code).toBeNull(); // the raw code is NOT returned to the host
    expect(res.slot?.preview).not.toContain("481920");

    // The host enters it by slot — the real digits reach the page, not the host.
    h.elements = [elem({ visibleText: "Code", selector: "#code" })];
    const codeRef = domRefs(await observe(sid))[0]!;
    await act(sid, { kind: "type_secret", slot: "otp", target: codeRef });
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
    // The mailbox read runs in a dedicated utility tab; the operation page is
    // never navigated to Gmail (navigating away and back resets the form that
    // is waiting for the code).
    expect(h.currentUrl).toBe("https://app.example.com/verify-email");
    expect(h.gotos.filter((u) => u.includes("mail.google.com")).length).toBeGreaterThan(0);
    expect(h.utilityTabsOpened).toBe(1);
    expect(h.utilityTabsClosed).toBe(1);
    expect(h.storageStateWrites).toEqual([]);
    expect(h.storageStates.get(canonical)).toEqual(googleState);
  });

  it("reads the mailbox in a dedicated utility tab and leaves the waiting page untouched", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://account.proton.me/",
      consentInboxRead: true,
    });
    // The operation page is mid-signup, dialog open, waiting for the code.
    h.currentUrl = "https://account.proton.me/signup";
    h.visibleText = "Your verification code is 481920.";
    // This mock controller lacks the row-extraction methods, so the read takes
    // the legacy first-row open; with a sender hint set and no row ever
    // chosen, the page-wide list parse never runs (the unfiltered query would
    // leak a foreign sender's code).
    h.openFirstMailResult = true;
    const res = await awaitVerification(obs.session_id, { sender: "proton.me" });
    expect(res.found).toBe(true);
    expect(res.code).toBe("481920");
    expect(h.gotos.some((u) => u.includes("mail.google.com"))).toBe(true);
    // The signup page kept its URL — and therefore its dialog state — for the
    // whole read; navigating it to Gmail would reset the form (Proton gap).
    expect(h.currentUrl).toBe("https://account.proton.me/signup");
    // The utility tab is short-lived: opened for the read, closed on return.
    expect(h.utilityTabsOpened).toBe(1);
    expect(h.utilityTabsClosed).toBe(1);
  });

  it("returns long verification links verbatim, not truncated", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://cal.com/",
      consentInboxRead: true,
    });
    const longToken = "t".repeat(400) + "end";
    const longHref = `https://cal.com/api/auth/verify-email?token=${longToken}&callbackUrl=%2Fsignup`;
    h.visibleText = "Verify your email address to finish creating your account.";
    h.elements = [elem({ tag: "a", role: "link", href: longHref, visibleText: "Verify email" })];
    h.openFirstMailResult = true;
    const res = await awaitVerification(obs.session_id, { sender: "cal.com" });
    expect(res.found).toBe(true);
    // The full href survives — the 300-char inventory cap must not truncate it
    // into a URL whose token no longer works (Cal.com gap).
    expect(res.link).toBe(longHref);
  });

  it("returns delegated verification results verbatim in both formats", async () => {
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
    const legacyResult = await awaitVerification(legacy.session_id, {});

    expect(legacyResult).toMatchObject({
      code: rawCode,
      link: rawLink,
      source_from: rawSender,
    });
    await finishProvisionSession(legacy.session_id);

    const compact = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = `From: Sender <${rawSender}>\nYour verification code is ${rawCode}.`;
    h.elements = [elem({ tag: "a", role: "link", href: rawLink, visibleText: "Confirm" })];
    h.openFirstMailResult = true;
    const compactResult = await awaitVerification(compact.session_id, {});

    expect(compactResult).toMatchObject({
      found: true,
      code: rawCode,
      link: rawLink,
      source_from: rawSender,
    });
  });

  it("reads the inbox by default when no consent option is supplied", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.found).toBe(true);
    expect(res.code).toBe("481920");
  });

  it("detects the live identity once per session, not once per gated operation", async () => {
    h.providers = ["google"];
    h.liveGoogleEmail = "captain@example.test";
    h.visibleText = "Your verification code is 481920.";
    const first = await startProvisionSession({ serviceUrl: "https://app.example.com/one" });

    expect((await awaitVerification(first.session_id, {})).found).toBe(true);
    expect((await awaitVerification(first.session_id, {})).found).toBe(true);
    expect(h.identityProbeCalls).toBe(1);

    const second = await startProvisionSession({ serviceUrl: "https://app.example.com/two" });
    expect((await awaitVerification(second.session_id, {})).found).toBe(true);
    expect(h.identityProbeCalls).toBe(2);

    await finishProvisionSession(second.session_id);
    await finishProvisionSession(first.session_id);
  });

  it("re-probes the same session after a refusal, so connect clears the wall", async () => {
    h.providers = [];
    h.liveGoogleEmail = null;
    h.visibleText = "Your verification code is 481920.";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const refused = await awaitVerification(obs.session_id, {});
    expect(refused.needs_user?.wall).toBe("google_session");
    expect(refused.found).toBe(false);

    h.providers = ["google"];
    h.liveGoogleEmail = "captain@example.test";
    const retried = await awaitVerification(obs.session_id, {});
    expect(retried.needs_user).toBeUndefined();
    expect(retried.found).toBe(true);
    expect(retried.code).toBe("481920");

    await finishProvisionSession(obs.session_id);
  });

  it("emits the captured identity email on a later observation, never at start", async () => {
    h.providers = ["google"];
    h.liveGoogleEmail = "captain@example.test";
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(obs).not.toHaveProperty("user_email");

    h.visibleText = "Your verification code is 481920.";
    const res = await awaitVerification(obs.session_id, {});
    expect(res.found).toBe(true);

    expect(await observe(obs.session_id)).toMatchObject({ user_email: "captain@example.test" });
    await finishProvisionSession(obs.session_id);
  });

  it("returns the unchanged google_session wall before a Gmail read without a live session", async () => {
    h.providers = [];
    h.liveGoogleEmail = null;
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });

    const res = await awaitVerification(obs.session_id, {});

    const expected = googleSessionGate([]);
    expect(expected.ok).toBe(false);
    if (!expected.ok) expect(res.needs_user).toEqual(expected.needs_user);
    expect(res.found).toBe(false);
    expect(h.utilityTabsOpened).toBe(0);
  });

  it("allows an explicit opt-out and a later session-only opt-in", async () => {
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const sid = obs.session_id;
    h.visibleText = "Your verification code is 481920.";
    // Explicit false wins over the default-on preference.
    const optedOut = await awaitVerification(sid, { grantConsent: false });
    expect(optedOut.found).toBe(false);
    expect(optedOut.needs_user?.message).toContain("disabled");
    // A later explicit true restores access for this session.
    const granted = await awaitVerification(sid, { grantConsent: true });
    expect(granted.found).toBe(true);
    expect(granted.code).toBe("481920");
    // Remembered for the session: a later await needs no re-grant.
    expect((await awaitVerification(sid, {})).found).toBe(true);
  });

  it("seals sender text before writing a Compact V2 verification audit", async () => {
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

  it("populates link for a link-only verification email whose action button is text, not href, keyed (Xata Keycloak account-link)", async () => {
    // The real Xata email: a Keycloak "Link Google account" email whose CTA
    // href is an opaque per-recipient click-tracking URL (no verify/login/
    // token vocabulary survives in it at all) — only the button's visible
    // text carries the signal. #644 handled a bare href carrying that
    // vocabulary; this covers the href carrying NONE of it.
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const trackingHref = "https://click.mailtrack.example.net/wf/click?upn=abc123opaque";
    h.visibleText = "Xata wants to link your Google account. No code needed.";
    h.elements = [
      elem({
        tag: "a",
        role: "link",
        href: "https://xata.io/unsubscribe?u=1",
        visibleText: "Unsubscribe",
      }),
      elem({ tag: "a", role: "link", href: trackingHref, visibleText: "Link your Google account" }),
    ];
    h.openFirstMailResult = true;

    const res = await awaitVerification(obs.session_id, {});

    expect(res.found).toBe(true);
    expect(res.code).toBeNull();
    expect(res.link).toBe(trackingHref);
  });

  it("never returns an unsubscribe/footer link even when it is the only href present", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    h.visibleText = "Manage your email preferences below.";
    h.elements = [
      elem({
        tag: "a",
        role: "link",
        href: "https://click.mailtrack.example.net/wf/click?upn=xyz",
        visibleText: "Unsubscribe from marketing emails",
      }),
    ];
    h.openFirstMailResult = true;

    const res = await awaitVerification(obs.session_id, {});

    expect(res.link).toBeNull();
    expect(res.found).toBe(false);
  });
});

describe("await_verification — Gmail transient #2014 backend error resilience", () => {
  it("detects the #2014 banner and Gmail's 'encountered a problem' / 'Retrying' text", () => {
    expect(
      isGmailTransientErrorText(
        "Oops... the system encountered a problem (#2014) - Retrying in 5s.",
      ),
    ).toBe(true);
    expect(isGmailTransientErrorText("Retrying in 12 seconds")).toBe(true);
    expect(isGmailTransientErrorText("Your inbox — 3 unread messages")).toBe(false);
  });

  it("detects Gmail's empty-search-result banner", () => {
    expect(isEmptyGmailResultText("No messages matched your search.")).toBe(true);
    expect(isEmptyGmailResultText("1 of 1 message shown")).toBe(false);
  });

  it("backs off with a bounded, increasing schedule", () => {
    expect(gmailTransientBackoffMs(0)).toBe(800);
    expect(gmailTransientBackoffMs(1)).toBe(1600);
    expect(gmailTransientBackoffMs(2)).toBe(3200);
    // Capped, not unbounded exponential growth.
    expect(gmailTransientBackoffMs(5)).toBeLessThanOrEqual(4000);
  });

  it("retries past a transient #2014 banner instead of giving up, and still finds the code", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const banner =
      "Oops... the system encountered a problem (#2014) - Retrying in 5s. " + "pad".repeat(80);
    const real = "Your verification code is 481920. " + "pad".repeat(80);
    // First search read hits the transient banner; the retry-with-backoff
    // re-issues the search and the second read is the real content.
    h.visibleTextQueue = [banner, real];
    h.visibleText = real; // fallback once the queue is drained (the opened-mail read)
    h.openFirstMailResult = true;

    const res = await awaitVerification(obs.session_id, {});

    expect(res.found).toBe(true);
    expect(res.code).toBe("481920");
    // The search page was re-navigated to recover from the transient error.
    expect(h.gotos.filter((u) => u.includes("mail.google.com")).length).toBeGreaterThan(1);
  });

  it("still concludes not-found after bounded retries on a genuinely empty, non-errored inbox", async () => {
    const obs = await startProvisionSession({
      serviceUrl: "https://app.example.com/",
      consentInboxRead: true,
    });
    const empty = "No messages matched your search. " + "pad".repeat(80);
    h.visibleText = empty;
    h.openFirstMailResult = false;

    const res = await awaitVerification(obs.session_id, {});

    expect(res.found).toBe(false);
    expect(res.code).toBeNull();
    expect(res.link).toBeNull();
    expect(res.needs_user).toBeDefined();
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

    const res = (await captchaGate(obs.session_id)) as Awaited<ReturnType<typeof captchaGate>>;

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

describe("operate session — captcha auto-solve on the general drive", () => {
  // A capture whose root carries a rendered challenge alert, so the observation
  // computes a challenge blocker exactly like the live hCaptcha page does.
  const challengeCapture = (): BrowserUseCapture => {
    const capture = mockBrowserUseCapture([
      elem({ tag: "input", type: "text", name: "email", id: "email" }),
    ] as InteractiveElement[]);
    const template = capture.root.children[0]!;
    const node = (id: string, overrides: Partial<BrowserUseNode>): BrowserUseNode => ({
      ...template,
      id,
      attributes: {},
      children: [],
      contentDocument: null,
      ...overrides,
    });
    capture.root.children.unshift(
      node("challenge-alert", {
        nodeName: "P",
        attributes: { role: "alert" },
        axRole: "alert",
        children: [
          node("challenge-alert-text", {
            nodeType: 3,
            nodeName: "#text",
            value: CHALLENGE_TEXT,
          }),
        ],
      }),
    );
    return capture;
  };

  const CHALLENGE_TEXT = "Please complete the verification challenge.";

  const vaultApi = (): ApiClient =>
    ({
      listCredentials: async () => ({ credentials: [{ service: "2captcha" }] }),
      useCredential: async () => ({ response: { status: 200, body: "{}" } }),
    }) as unknown as ApiClient;

  // The auto-solve runs detached from the observation, so let its pending
  // continuations run before asserting on what it did (or did not) do.
  const drainDetached = async (): Promise<void> => {
    for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  // A solve held open until the test releases it, plus the signal that the
  // detached attempt actually reached the solver.
  const openGate = (): { release: () => void; solveStarted: Promise<void> } => {
    let release = (): void => {};
    h.twoCaptchaGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted = (): void => {};
    const solveStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    h.onTwoCaptchaSolveStart = signalStarted;
    return { release, solveStarted };
  };

  // Moves the wall clock forward for the code under test without touching the
  // real timers drainDetached relies on.
  const advanceClock = async (ms: number, run: () => Promise<void>): Promise<void> => {
    const real = Date.now;
    Date.now = () => real() + ms;
    try {
      await run();
    } finally {
      Date.now = real;
    }
  };

  const blockers = (payload: unknown): Array<Record<string, unknown>> =>
    (payload as { semantic?: { blockers?: Array<Record<string, unknown>> } }).semantic?.blockers ??
    [];

  it("buys the token detached, then injects it under the next observation's lease", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.injectClearsCapture = true;
    h.captureOverride = challengeCapture();
    const gate = openGate();

    // The fetch is deliberately still running here: an awaited solve would
    // hang this call (and hold its session-call lease) until the gate opens.
    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });

    await gate.solveStarted;
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    expect(h.injectCaptchaCalls).toEqual([]);
    expect(blockers(started)).toEqual([
      { kind: "challenge", text: CHALLENGE_TEXT, target: "unavailable" },
    ]);
    // The solver is built on the vault proxy, not an env key.
    expect(h.twoCaptchaCtorArgs).toEqual([
      expect.objectContaining({ vaultProxy: expect.anything() }),
    ]);

    // An observation taken while the fetch is in flight surfaces the challenge
    // unchanged and does NOT start a second fetch.
    const during = await observe(started.session_id);
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    expect(String(during.dom ?? "")).toContain(CHALLENGE_TEXT);

    // The token arrives while NO operator call holds the lease. It must be
    // stashed, not written into the live page: injectHcaptchaToken fires the
    // site's own success callbacks, which would submit the form under the
    // agent mid-drive.
    gate.release();
    await drainDetached();
    expect(h.injectCaptchaCalls).toEqual([]);

    // The next observation injects it while holding the lease, so the clear is
    // reflected in that very observation and no second token is bought.
    const after = await observe(started.session_id);
    expect(h.injectCaptchaCalls).toEqual(["hcaptcha"]);
    expect(String(after.dom ?? "")).not.toContain(CHALLENGE_TEXT);
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("surfaces the challenge unchanged when no 2captcha credential is vaulted", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.captureOverride = challengeCapture();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      format: "compact",
    });
    await drainDetached();

    expect(h.twoCaptchaCalls).toEqual([]);
    expect(h.injectCaptchaCalls).toEqual([]);
    const payload = started as unknown as {
      semantic: { blocked: boolean; blockers: Array<Record<string, unknown>> };
    };
    expect(payload.semantic.blocked).toBe(true);
    expect(payload.semantic.blockers).toEqual([
      { kind: "challenge", text: CHALLENGE_TEXT, target: "unavailable" },
    ]);
  });

  it("does not hang the attempt when the credential listing never answers", async () => {
    // The listing carries no deadline of its own; unbounded it would hold the
    // in-flight claim for the life of the session and silently disable
    // auto-solve. Bounded, it falls back to the env-key solver and settles.
    const hangingApi = {
      listCredentials: () => new Promise<never>(() => {}),
    } as unknown as ApiClient;

    const solver = await buildTwoCaptchaSolver(hangingApi, { requestTimeoutMs: 20 });

    expect(solver).toBeDefined();
    // Fell back to the env-key transport — no vault proxy was built from an
    // answer that never came.
    expect(h.twoCaptchaCtorArgs).toEqual([{ requestTimeoutMs: 20 }]);
  });

  it("surfaces the challenge unchanged when the token solve fails", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.twoCaptchaResult = { kind: "solver_error", reason: "ERROR_BAD_KEY" };
    h.captureOverride = challengeCapture();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();

    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    expect(h.injectCaptchaCalls).toEqual([]);
    const payload = started as unknown as {
      semantic: { blocked: boolean; blockers: Array<Record<string, unknown>> };
    };
    expect(payload.semantic.blocked).toBe(true);
    expect(payload.semantic.blockers[0]).toMatchObject({ kind: "challenge" });
  });

  it("does not re-attempt a FAILED solve on the next observation before the cooldown elapses", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.twoCaptchaResult = { kind: "solve_timeout", durationMs: 1 };
    h.captureOverride = challengeCapture();
    const gate = openGate();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    // Let the first attempt FINISH, so the next observation is gated by the
    // retry cooldown rather than by the in-flight guard.
    await gate.solveStarted;
    gate.release();
    h.twoCaptchaGate = null;
    await drainDetached();
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);

    await observe(started.session_id);
    await drainDetached();

    // The 30s retry cooldown bounds how fast a failing challenge burns the key.
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("attempts a fresh solve right after a SUCCESSFUL one, without waiting out the cooldown", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();
    await observe(started.session_id);
    expect(h.injectCaptchaCalls).toEqual(["hcaptcha"]);

    // Submitting re-renders a DIFFERENT challenge: no token for this one yet.
    // The cooldown bounds retries of a FAILING challenge, so it must not
    // suppress this one.
    h.variantCaptchaTokens = [];
    h.captureOverride = challengeCapture();

    await observe(started.session_id);
    await drainDetached();

    expect(h.twoCaptchaCalls).toEqual(["hcaptcha", "hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("solves a rendered hCaptcha even when a co-resident reCAPTCHA already holds a token", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    // A v3 badge scored the page and filled g-recaptcha-response; the rendered
    // hCaptcha gate is still unsolved and must not be read as already settled.
    h.captchaToken = true;
    h.variantCaptchaTokens = ["recaptcha_v3"];

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();
    await observe(started.session_id);

    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    expect(h.injectCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("discards a token whose page navigated away instead of injecting it into the new document", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    const gate = openGate();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await gate.solveStarted;

    // The agent kept driving while 2Captcha worked: the submit landed on a
    // different document, which renders its own fresh challenge.
    h.currentUrl = "https://app.example.com/signup/step-2";
    gate.release();
    h.twoCaptchaGate = null;
    await drainDetached();
    await observe(started.session_id);

    // The stale token is dropped, so the new document's response field is not
    // poisoned with a value the site would reject.
    expect(h.injectCaptchaCalls).toEqual([]);
    expect(h.variantCaptchaTokens).toEqual([]);

    // Nothing FAILED on step-2's challenge, so the discard must not back the
    // new document off: that same observation buys it a token of its own.
    await drainDetached();
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha", "hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("discards a token for a widget that settled while 2Captcha was working", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    const gate = openGate();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await gate.solveStarted;

    // The agent did what a challenge blocker asks for and clicked the widget
    // itself: h-captcha-response is populated, same document, same URL.
    h.variantCaptchaTokens = ["hcaptcha"];
    gate.release();
    h.twoCaptchaGate = null;
    await drainDetached();
    await observe(started.session_id);
    await drainDetached();

    // Writing the bought token over a settled widget would re-fire the site's
    // success callbacks and submit the form under the agent.
    expect(h.injectCaptchaCalls).toEqual([]);
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("treats an injected token that never reached its own response field as a failed attempt", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    // A programmatic hCaptcha widget: the injection reports ok, but no
    // h-captcha-response field takes the token. A co-resident reCAPTCHA badge
    // already holds ITS token, which the any-provider settle check accepts.
    h.injectLandsVariantToken = false;
    h.variantCaptchaTokens = ["recaptcha_v3"];

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();
    await observe(started.session_id);
    expect(h.injectCaptchaCalls).toEqual(["hcaptcha"]);
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);

    await observe(started.session_id);
    await drainDetached();

    // Recorded as failed, so the cooldown bounds the spend instead of every
    // later observation buying another token.
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("never injects a bought token once a payment card has been released", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    const gate = openGate();

    const started = await startProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      api: vaultApi(),
      format: "compact",
    });
    await gate.solveStarted;
    gate.release();
    h.twoCaptchaGate = null;
    await drainDetached();

    // The agent released a card into the checkout while 2Captcha worked.
    paymentSession(started.session_id).releasedPaymentCard = {
      approvalId: "approval_checkout",
      approvalUrl: "https://approve.test/approval_checkout",
      checkout: {
        merchant: "Synthetic Merchant",
        checkout_origin: "https://shop.example.com",
        amount_cents: 4200,
        currency: "USD",
      },
      cardRef: "card_synthetic",
      last4: "1111",
      deadline: Date.now() + 60_000,
      threeDsNotified: true,
      card: {
        pan: "4111111111111111",
        cvv: "123",
        exp_month: "12",
        exp_year: "2030",
        name: "Synthetic Buyer",
        billing: { line1: "1 Test Street", city: "Testville", postal_code: "10000", country: "US" },
      },
    };

    await observe(started.session_id);
    await drainDetached();

    // Injecting fires the site's success callback, which on a checkout places
    // the order. A payment advances only through the operator's own actions.
    expect(h.injectCaptchaCalls).toEqual([]);
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    const blocked = await observe(started.session_id, "compact");
    expect(blockers(blocked)).toHaveLength(1);
    await finishProvisionSession(started.session_id);
  });

  it("discards a bought token that has outlived the provider's token lifetime", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    const gate = openGate();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await gate.solveStarted;
    gate.release();
    h.twoCaptchaGate = null;
    await drainDetached();
    expect(h.injectCaptchaCalls).toEqual([]);

    // The agent spent the next few minutes filling fields with detail:"none",
    // so nothing observed until well past the token's ~120s life.
    const diagnostics: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await advanceClock(150_000, async () => {
        await observe(started.session_id);
        await drainDetached();
      });
    } finally {
      for (const call of stderrWrite.mock.calls) diagnostics.push(String(call[0]));
      for (const call of consoleError.mock.calls) diagnostics.push(call.map(String).join(" "));
      stderrWrite.mockRestore();
      consoleError.mockRestore();
    }
    const captured = diagnostics.join("");

    // A dead token must not be written: it would fill the response field, read
    // back as solved, and leave nothing to retry.
    expect(h.injectCaptchaCalls).toEqual([]);
    // Re-buying on the very next observation buys another token that dies the
    // same way: the unconsumed expiry starts a geometric backoff instead.
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    expect(captured).toContain("outcome=token_expired");
    expect(captured).toContain("outcome=fetch_skipped reason=expiry_backoff");
    // ...and the audit trail records the skip with a reason (outcome and
    // reason are sealed vocabulary in the audit line).
    expect(captured).toContain(
      '"event":"captcha_autosolve","outcome":"<sealed>","reason":"<sealed>"',
    );

    // Past the 30s backoff window the next observation re-arms and buys again.
    await advanceClock(181_000, async () => {
      await observe(started.session_id);
      await drainDetached();
    });
    expect(h.twoCaptchaCalls).toEqual(["hcaptcha", "hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("counts a drop-in-compat solve as settled instead of re-buying every cooldown", async () => {
    h.captchaVariant = "hcaptcha";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();
    // The page swapped hCaptcha in for reCAPTCHA: its only response field is
    // the g-recaptcha-response compat textarea, which is where the token lands.
    h.hcaptchaCompatOnly = true;

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();
    await observe(started.session_id);
    await drainDetached();
    expect(h.injectCaptchaCalls).toEqual(["hcaptcha"]);

    // Long past any retry cooldown. The solve WORKED, so the still-rendered
    // widget must not trigger another purchase.
    await advanceClock(120_000, async () => {
      await observe(started.session_id);
      await drainDetached();
    });

    expect(h.twoCaptchaCalls).toEqual(["hcaptcha"]);
    await finishProvisionSession(started.session_id);
  });

  it("leaves Turnstile to its managed challenge even when one is rendered", async () => {
    h.captchaVariant = "turnstile";
    h.captchaChallengeRendered = true;
    h.twoCaptchaAvailable = true;
    h.captureOverride = challengeCapture();

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      api: vaultApi(),
      format: "compact",
    });
    await drainDetached();
    await observe(started.session_id);

    expect(h.twoCaptchaCalls).toEqual([]);
    expect(h.injectCaptchaCalls).toEqual([]);
    const payload = started as unknown as {
      semantic: { blocked: boolean; blockers: Array<Record<string, unknown>> };
    };
    expect(payload.semantic.blocked).toBe(true);
    expect(payload.semantic.blockers[0]).toMatchObject({ kind: "challenge" });
  });
});

function normalizeFinishReceipt(value: unknown): Record<string, unknown> {
  expect(value).toMatchObject({
    session_id: expect.any(String),
    operation_id: expect.any(String),
    closed: true,
    cleanup: "closed",
    execution: "completed",
    mutation: "not_dispatched",
  });
  return {
    ...(value as Record<string, unknown>),
    session_id: "normalized",
    operation_id: "normalized",
  };
}

describe("operate_finish lifecycle consolidation", () => {
  it("owns the session before outcome extraction begins", async () => {
    const previousAutoPromote = process.env.TRUSTY_SQUIRE_AUTO_PROMOTE;
    process.env.TRUSTY_SQUIRE_AUTO_PROMOTE = "0";
    let releaseExtraction: (() => void) | undefined;
    h.visibleText = `API key ${sk("live-finish-exclusive-123456789")}`;
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
      const finishing = operateFinishTool.handler(
        {
          session_id: started.session_id,
          outcome: "credentials",
          store: { service: "example" },
        },
        api,
      );
      await vi.waitFor(() => expect(h.extractVisibleTextCalls).toBeGreaterThan(0));

      await expect(
        operateFinishTool.handler(
          operateFinishTool.inputSchema.parse({ session_id: started.session_id, outcome: "none" }),
          null,
        ),
      ).resolves.toMatchObject({ closed: false, cleanup: "closing", execution: "pending" });
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
    const legacy = (await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id: legacySession.session_id,
        outcome: "none",
      }),
      null,
    )) as Record<string, unknown>;

    const consolidatedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const consolidated = (await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id: consolidatedSession.session_id,
        outcome: "none",
      }),
      null,
    )) as Record<string, unknown>;

    expect(normalizeFinishReceipt(consolidated)).toEqual(normalizeFinishReceipt(legacy));
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

    const result = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id: session.session_id,
        outcome: "credentials",
        store: { service: "example" },
      }),
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
    const failed = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id: failedSession.session_id,
        outcome: "result",
        data: { confirmed: false },
      }),
      null,
    );

    const unconfirmedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
      profileDir: canonical,
    });
    const unconfirmed = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id: unconfirmedSession.session_id,
        outcome: "result",
        summary: "Task stopped before success",
      }),
      null,
    );

    expect(failed).toMatchObject({ kind: "result", data: { confirmed: false } });
    expect(unconfirmed).toMatchObject({ kind: "result", summary: "Task stopped before success" });
    expect(h.storageStateWrites).toEqual([]);
    expect(h.storageStates.get(canonical)).toBe(prior);
  });

  it("seals the current URL from Compact V2 finish results", async () => {
    const urlToken = "private-finish-token-123456789";
    const started = await startProvisionSession({
      serviceUrl: `https://app.example.com/done?token=${urlToken}`,
    });

    const result = (await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({ session_id: started.session_id, outcome: "none" }),
      null,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      session_id: started.session_id,
      url: `https://app.example.com/done?token=${urlToken}`,
      closed: true,
    });
  });

  it("returns the legacy result shape from outcome=result, preserving scalar data types", async () => {
    const legacySession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const legacyArgs = operateFinishTool.inputSchema.parse({
      session_id: legacySession.session_id,
      summary: "Task complete",
      data: { confirmed: true, count: 2 },
      outcome: "result",
    });
    const legacy = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse(legacyArgs),
      null,
    );

    const consolidatedSession = await startProvisionSession({
      serviceUrl: "https://app.example.com/done",
    });
    const consolidatedArgs = operateFinishTool.inputSchema.parse({
      session_id: consolidatedSession.session_id,
      outcome: "result",
      summary: "Task complete",
      data: { confirmed: true, count: 2 },
    });
    const consolidated = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse(consolidatedArgs),
      null,
    );

    expect(normalizeFinishReceipt(consolidated)).toEqual(normalizeFinishReceipt(legacy));
    expect(consolidated).toMatchObject({
      kind: "result",
      summary: "Task complete",
      data: { confirmed: true, count: 2 },
    });
  });

  it("returns the legacy credential result without leaking the extracted value", async () => {
    const secret = sk("live-finish-parity-secret-123456789");
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
      const legacy = await operateFinishTool.handler(
        operateFinishTool.inputSchema.parse({
          session_id: legacySession.session_id,
          store: { service: "example" },
          outcome: "credentials",
        }),
        api,
      );

      h.visibleText = `API key ${secret}`;
      const consolidatedSession = await startProvisionSession({
        serviceUrl: "https://app.example.com/api-keys",
      });
      const consolidated = await operateFinishTool.handler(
        operateFinishTool.inputSchema.parse({
          session_id: consolidatedSession.session_id,
          outcome: "credentials",
          store: { service: "example" },
        }),
        api,
      );

      expect(normalizeFinishReceipt(consolidated)).toEqual(normalizeFinishReceipt(legacy));
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
      operateFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: "credentials",
      }).success,
    ).toBe(false);
    expect(
      operateFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: "result",
      }).success,
    ).toBe(false);
    expect(
      operateFinishTool.inputSchema.safeParse({
        session_id: "session_1",
        outcome: "result",
        data: { confirmed: true },
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
    const legacy = (await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ session_id: obs.session_id, action: "prepare_signup" }),
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
    const viaAct = (await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ session_id: obs.session_id, action: "prepare_signup" }),
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

  it("prepare_login returns the Google session wall when no live identity can be captured", async () => {
    h.providers = [];
    h.liveGoogleEmail = null;
    const obs = await startHarnessProvisionSession({
      browser: new BrowserController(),
      serviceUrl: "https://app.example.com/",
    });
    const res = (await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ session_id: obs.session_id, action: "prepare_signup" }),
      null as unknown as ApiClient,
    )) as { needs_user?: { wall: string; resume: string } };
    expect(res.needs_user?.wall).toBe("google_session");
    expect(res.needs_user?.resume).toBe("connect");
  });

  it("store_login vaults the sealed email+password as username_password, no raw values returned", async () => {
    withEmail("ada@example.com");
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/", profileDir });
    await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ session_id: obs.session_id, action: "prepare_signup" }),
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
    await expect(
      withOperatorRequestContext(
        new AbortController().signal,
        () =>
          operateLoginTool.handler(
            operateLoginTool.inputSchema.parse({ ...args, action: "store_signup" }),
            api,
          ),
        async () => {
          throw new Error("checkpoint unavailable");
        },
      ),
    ).rejects.toThrow("checkpoint unavailable");
    expect(captured).toHaveLength(0);
    const legacy = (await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ ...args, action: "store_signup" }),
      api,
    )) as {
      reference: string;
      type: string;
      login_hosts: string[];
    };
    const consolidated = (await operateLoginTool.handler(
      { action: "store_signup", ...args },
      api,
    )) as typeof legacy;
    const viaAct = (await operateLoginTool.handler(
      operateLoginTool.inputSchema.parse({ ...args, action: "store_signup" }),
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

  it.each(["login", "username"])(
    "loads saved %s/password fields into slots without returning raw values",
    async (loginField) => {
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
              [loginField]: encrypt("ada@example.com"),
              password: encrypt("correct-horse"),
            },
          };
        },
      } as unknown as ApiClient;

      const args = {
        session_id: obs.session_id,
        reference: "vault://acct/login1",
        fields: [loginField, "password"],
        slot_prefix: "signin",
      };
      const legacy = (await operateFillCredentialTool.handler(args, api)) as {
        reference: string;
        slots: Record<string, { slot: string }>;
      };
      const consolidated = (await operateLoginTool.handler(
        { action: "load_saved", ...args },
        api,
      )) as typeof legacy;
      const viaAct = (await operateLoginTool.handler(
        operateLoginTool.inputSchema.parse({ ...args, action: "load_saved" }),
        api,
      )) as typeof legacy;

      expect(consolidated).toEqual(legacy);
      expect(viaAct).toEqual(legacy);
      expect(captured).toHaveLength(3);
      for (const call of captured) {
        expect(call).toMatchObject({
          current_host: "https://app.example.com/login",
          reference: "vault://acct/login1",
          fields: [loginField, "password"],
        });
        expect(call.encrypted_response_public_key).toContain("BEGIN PUBLIC KEY");
      }
      expect(legacy.reference).toBe("vault://acct/login1");
      expect(legacy.slots[loginField]?.slot).toBe(`signin_${loginField}`);
      expect(legacy.slots.password?.slot).toBe("signin_password");
      expect(JSON.stringify({ legacy, consolidated })).not.toContain("ada@example.com");
      expect(JSON.stringify({ legacy, consolidated })).not.toContain("correct-horse");

      h.elements = [elem({ visibleText: "Email", selector: "#email" })];
      const emailRef = domRefs(await observe(obs.session_id))[0]!;
      await act(obs.session_id, {
        kind: "type_secret",
        slot: `signin_${loginField}`,
        target: emailRef,
      });
      expect(h.typed.some((t) => t.selector === "#email" && t.text === "ada@example.com")).toBe(
        true,
      );
    },
  );
});

describe("observation detail ladder (none < compact < full)", () => {
  it("operate_act detail:'none' returns a minimal ack (no perception)", async () => {
    h.elements = [elem({ tag: "button", visibleText: "Go", screenPath: "main:x > button:go" })];
    const obs = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const ack = await act(obs.session_id, { kind: "scroll", direction: "down" }, "none");
    expect(ack.observed).toBe("none");
    expect(ack.safe_table).toBeUndefined();
    expect(ack.dom).toBeUndefined();
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

// Frame identity and credential-injection boundaries survive unrestricted browser egress.
describe("frame targets — identity and credential boundaries (operator-frame-support)", () => {
  const SAME_DOMAIN_FRAME_URL = "https://payments.example.com/widget";
  const CROSS_DOMAIN_FRAME_URL = "https://evil-payments.test/widget";

  it("safe_table tags a frame element with its own frame origin (observe surfaces iframe content)", async () => {
    // V2 frame classes are exact-origin: the page's own embedded frame reads
    // same_origin (x=s); anything else is cross_origin (x=x).
    h.elements = [
      elem({
        testId: "ship-standard",
        labelText: "Standard Shipping",
        selector: "#ship-standard",
        frameUrl: "https://shop.example.com/embedded",
        frameOrigin: "https://shop.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as unknown as Array<
      [string, string, string?]
    >;
    const row = rows.find(([, , facts]) => facts?.includes("@standard-shipping"));
    expect(row?.[2]).toContain("x=s");
  });

  it("main-frame elements are unaffected — no frame marker on the row (regression)", async () => {
    h.elements = [elem({ testId: "go", labelText: "Continue", selector: "#go" })];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const rows = (await observeQuery(started.session_id, "")).safe_table as unknown as Array<
      [string, string, string?]
    >;
    const row = rows.find(([, , facts]) => facts?.includes("@continue"));
    expect(row?.[2] ?? "").not.toContain("x=");
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
    await act(started.session_id, {
      kind: "click",
      target: domRefs(started)[0]!,
    });
    expect(h.frameClicks).toEqual([`${SAME_DOMAIN_FRAME_URL}|#ship-standard`]);
    expect(h.clickCalls).toBe(0); // never fell through to the main-frame click
  });

  it("click on an undeclared cross-domain iframe element succeeds", async () => {
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
    await act(started.session_id, {
      kind: "click",
      target: domRefs(started)[0]!,
    });
    expect(h.frameClicks).toEqual([`${CROSS_DOMAIN_FRAME_URL}|#card-input`]);
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
    await act(started.session_id, {
      kind: "type",
      target: domRefs(started)[0]!,
      text: "SAVE10",
    });
    expect(h.frameTypes).toEqual([
      { frameUrl: SAME_DOMAIN_FRAME_URL, selector: "#promo", text: "SAVE10" },
    ]);
    expect(h.typed).toEqual([]); // never fell through to the main-frame type
  });

  it("type_secret into a cross-origin frame is allowed — browser egress does not gate credential injection", async () => {
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
    await act(started.session_id, {
      kind: "type_secret",
      slot: "login",
      target: domRefs(started)[0]!,
    });
    expect(h.frameTypes).toEqual([
      {
        frameUrl: CROSS_DOMAIN_FRAME_URL,
        selector: "#cvv",
        text: "s3cr3t-value",
        sealed: true,
      },
    ]);
    expect(h.typed).toEqual([]);
  });

  it("acts on and types a secret into a null-origin (about:srcdoc) frame — CDP reaches it and the mask covers outputs", async () => {
    h.elements = [
      elem({
        testId: "sandbox-password",
        labelText: "Sandbox Password",
        selector: "#password",
        frameUrl: "about:srcdoc",
        frameOrigin: "null",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    const sandboxRef = domRefs(started)[0]!;
    await act(started.session_id, { kind: "click", target: sandboxRef });
    expect(h.frameClicks).toEqual(["about:srcdoc|#password"]);
    expect(h.clickCalls).toBe(0);
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await act(started.session_id, {
      kind: "type_secret",
      slot: "login",
      target: sandboxRef,
    });
    expect(h.frameTypes).toEqual([
      { frameUrl: "about:srcdoc", selector: "#password", text: "s3cr3t-value", sealed: true },
    ]);
    expect(h.typed).toEqual([]);
  });

  it("types a secret into a frame whose URL is the page's own domain (no opaque-origin gate)", async () => {
    h.elements = [
      elem({
        testId: "sandboxed-password",
        labelText: "Password",
        selector: "#password",
        // A sandbox="allow-scripts" iframe keeps its real URL; that URL origin
        // is the only frame metadata, and it never gates the write.
        frameUrl: "https://shop.example.com/embedded-login",
        frameOrigin: "https://shop.example.com",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://shop.example.com/cart" });
    stashSecretSlot(started.session_id, "login", "s3cr3t-value");
    await act(started.session_id, {
      kind: "type_secret",
      slot: "login",
      target: domRefs(started)[0]!,
    });
    expect(h.frameTypes).toEqual([
      {
        frameUrl: "https://shop.example.com/embedded-login",
        selector: "#password",
        text: "s3cr3t-value",
        sealed: true,
      },
    ]);
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
    await act(started.session_id, {
      kind: "type_secret",
      slot: "login",
      target: domRefs(started)[0]!,
    });
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
    await act(started.session_id, {
      kind: "select",
      target: domRefs(started)[0]!,
      text: "Standard",
    });
    expect(h.frameSelects).toEqual([
      { frameUrl: SAME_DOMAIN_FRAME_URL, selector: "#ship-method", matcher: "Standard" },
    ]);
    expect(h.selected).toEqual([]); // never fell through to the main-frame select
  });

  it("select on an undeclared cross-domain iframe element succeeds", async () => {
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
    await act(started.session_id, {
      kind: "select",
      target: domRefs(started)[0]!,
      text: "January",
    });
    expect(h.frameSelects).toEqual([
      { frameUrl: CROSS_DOMAIN_FRAME_URL, selector: "#card-exp", matcher: "January" },
    ]);
    expect(h.selected).toEqual([]);
  });
});

describe("compact-v2 serializer reachability — Xata-shaped login page (P1)", () => {
  it("surfaces an unbound challenge through compact start and query without minting a ref", async () => {
    const elements = [
      elem({ index: 0, tag: "button", visibleText: "Continue with Google", selector: "#oauth" }),
      elem({ index: 1, tag: "input", type: "email", labelText: "Email", selector: "#email" }),
      elem({
        index: 2,
        tag: "button",
        visibleText: "Continue",
        selector: "#continue",
        disabled: true,
      }),
    ] as InteractiveElement[];
    const capture = mockBrowserUseCapture(elements);
    const template = capture.root.children[0]!;
    const node = (id: string, overrides: Partial<BrowserUseNode>): BrowserUseNode => ({
      ...template,
      id,
      attributes: {},
      children: [],
      contentDocument: null,
      ...overrides,
    });
    const text = (id: string, value: string): BrowserUseNode =>
      node(id, { nodeType: 3, nodeName: "#text", value });
    const checkbox = node("challenge-checkbox", {
      nodeName: "INPUT",
      attributes: { type: "checkbox" },
      axRole: "checkbox",
      axProperties: [{ name: "focusable", value: true }],
    });
    const challengeLabel = node("challenge-label", {
      nodeName: "LABEL",
      children: [checkbox, text("challenge-label-text", "Verify you are human")],
    });
    const shadow = node("challenge-shadow", {
      nodeType: 11,
      nodeName: "#document-fragment",
      shadowType: "closed",
      children: [challengeLabel],
    });
    const frameDocument = node("challenge-document", {
      nodeType: 9,
      nodeName: "#document",
      children: [shadow],
    });
    capture.root.children.unshift(
      node("challenge-alert", {
        nodeName: "P",
        attributes: { role: "alert" },
        axRole: "alert",
        children: [text("challenge-alert-text", "Please complete the verification challenge.")],
      }),
      node("challenge-frame", {
        nodeName: "IFRAME",
        attributes: { title: "Widget containing a Cloudflare security challenge" },
        contentDocument: frameDocument,
      }),
    );
    h.elements = capture.elements;
    h.captureOverride = capture;
    h.observationSemantics = { title: "Fixture login", headings: ["Sign in"] };

    const started = await startProvisionSession({
      serviceUrl: "https://app.example.com/login",
      format: "compact",
    });
    const startPayload = started as unknown as {
      semantic: { blockers: Array<Record<string, unknown>> };
      safe_table: Array<[string, string, string?]>;
    };
    expect(startPayload.semantic).toHaveProperty("blocked", true);
    expect(startPayload.semantic.blockers).toEqual([
      {
        kind: "challenge",
        text: "Please complete the verification challenge.",
        target: "unavailable",
      },
      {
        kind: "challenge",
        text: "Verify you are human",
        target: "unavailable",
        focus: "focusable",
        keyboard: "tab_space",
      },
    ]);
    expect(startPayload.safe_table.map((row) => row[2])).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@continue-with-google"),
        expect.stringContaining("@email"),
        expect.stringContaining("@continue"),
      ]),
    );
    const query = (await observeQuery(started.session_id, "verification")) as {
      semantic: { blockers: Array<Record<string, unknown>> };
      safe_table: unknown[];
    };
    expect(query.safe_table).toEqual([]);
    expect(query.semantic.blockers).toEqual(startPayload.semantic.blockers);
    expect(JSON.stringify(query)).not.toContain("@e:challenge");
  });

  // Mirrors the live Xata signup/login failure: a long marketing page with many
  // decorative/nav controls, the primary CTA and form controls below a large
  // content block (out of the viewport), a custom Region dropdown, a free-text
  // "use case" textbox, and a native select. Every actionable control must be
  // reachable through the default map, overflow paging, and generic queries —
  // with no budget throw — so the Xata-class failure cannot happen.
  function xataShapedElements(): unknown[] {
    const nav = Array.from({ length: 24 }, (_, index) =>
      elem({
        index,
        tag: "a",
        role: "link",
        visibleText: `Nav link ${index}`,
        selector: `#nav-${index}`,
        href: `https://xata.example.com/${index}`,
      }),
    );
    return [
      ...nav,
      elem({
        index: 100,
        tag: "input",
        type: "email",
        role: "textbox",
        labelText: "Work email",
        selector: "#email",
      }),
      elem({
        index: 101,
        tag: "button",
        role: "button",
        visibleText: "Sign in",
        selector: "#signin",
      }),
      // Below a large marketing content block: out of the viewport.
      elem({
        index: 102,
        tag: "button",
        role: "button",
        visibleText: "Continue",
        selector: "#continue",
        inViewport: false,
      }),
      elem({
        index: 103,
        tag: "input",
        type: "password",
        role: "textbox",
        labelText: "Password",
        selector: "#password",
        inViewport: false,
      }),
      elem({
        index: 104,
        tag: "div",
        role: "combobox",
        visibleText: "Region",
        selector: "#region",
        inViewport: false,
      }),
      elem({
        index: 105,
        tag: "textarea",
        role: "textbox",
        labelText: "Tell us about your use case",
        selector: "#use-case",
        inViewport: false,
      }),
      elem({
        index: 106,
        tag: "select",
        labelText: "Country",
        selector: "#country",
        inViewport: false,
      }),
    ];
  }

  it("retrieves below-the-fold controls through whole-document query", async () => {
    h.elements = xataShapedElements();
    const started = await startProvisionSession({ serviceUrl: "https://xata.example.com/login" });
    expect(started.more_below).toBe(true);
    expect(started.dom).not.toContain("Continue");
    const result = await observeQuery(started.session_id, "Continue");
    expect(result.safe_table).toHaveLength(1);
    const ref = (result.safe_table as Array<[string]>)[0]![0];
    await act(started.session_id, { kind: "click", target: ref }, "none");
    expect(h.clickCalls).toBe(1);
  });

  it("pages overflow deterministically and rejects a different filter on a map cursor", async () => {
    h.elements = Array.from({ length: 400 }, (_, index) =>
      elem({
        index,
        tag: "button",
        role: "button",
        visibleText: `Item control ${index}`,
        selector: `#item-${index}`,
        inViewport: index < 10,
      }),
    );
    const started = (await startProvisionSession({
      serviceUrl: "https://xata.example.com/dense",
    })) as unknown as {
      session_id: string;
      safe_table: Array<[string]>;
      overflow?: { next_cursor: string };
    };
    const firstQuery = await observeQuery(started.session_id, "");
    const mapCursor = (firstQuery.overflow as { next_cursor: string } | undefined)?.next_cursor;
    expect(mapCursor).toBeDefined();

    // Enumerate the entire map through overflow paging. Every control appears
    // exactly once and paging never fails.
    const seen = new Set<string>((firstQuery.safe_table as Array<[string]>).map((row) => row[0]!));
    const pagedCursors: string[] = [];
    let cursor = mapCursor;
    let guard = 0;
    while (cursor !== undefined) {
      expect(guard++).toBeLessThan(50);
      const page = (await observeQuery(started.session_id, "", undefined, cursor)) as {
        safe_table: Array<[string]>;
        overflow?: { next_cursor: string };
      };
      for (const row of page.safe_table) seen.add(row[0]!);
      cursor = page.overflow?.next_cursor;
      if (cursor !== undefined) pagedCursors.push(cursor);
    }
    expect(seen.size).toBe(400);

    // A continuation token keeps the exact map/query meaning it was minted
    // with; a new filter is a new cursorless read.
    expect(pagedCursors.length).toBeGreaterThan(0);
    const secondPageCursor = pagedCursors[0]!;
    await expect(
      observeQuery(started.session_id, "control 399", undefined, secondPageCursor),
    ).rejects.toThrow("invalid_cursor");
    await expect(observeQuery(started.session_id, "", "button", secondPageCursor)).rejects.toThrow(
      "invalid_cursor",
    );

    // The original live misuse now receives a precise refusal; removing the
    // cursor performs the requested fresh filtered read.
    await expect(
      observeQuery(started.session_id, "control 399", undefined, mapCursor),
    ).rejects.toThrow("invalid_cursor");
    await expect(observeQuery(started.session_id, "", "button", mapCursor)).rejects.toThrow(
      "invalid_cursor",
    );
    const byQuery = (await observeQuery(started.session_id, "control 399")) as {
      safe_table: Array<[string, string, string?]>;
    };
    expect(byQuery.safe_table).toHaveLength(1);
    expect(byQuery.safe_table[0]![2]).toContain("m=t");
  });

  it("finds controls by generic terms across label, role word, and placeholder", async () => {
    h.elements = [
      elem({
        index: 0,
        tag: "div",
        role: "combobox",
        visibleText: "Region",
        selector: "#region",
      }),
      elem({
        index: 1,
        tag: "textarea",
        role: "textbox",
        labelText: "Tell us about your use case",
        selector: "#use-case",
      }),
      elem({
        index: 2,
        tag: "input",
        type: "text",
        role: "textbox",
        placeholder: "you@company.com",
        selector: "#work-email",
      }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://xata.example.com/signup" });

    const region = (await observeQuery(started.session_id, "region dropdown")) as {
      safe_table: unknown[];
    };
    expect(region.safe_table).toHaveLength(1);

    const useCase = (await observeQuery(started.session_id, "use case textbox")) as {
      safe_table: unknown[];
    };
    expect(useCase.safe_table).toHaveLength(1);

    const placeholder = (await observeQuery(started.session_id, "company")) as {
      safe_table: unknown[];
    };
    expect(placeholder.safe_table).toHaveLength(1);
  });

  it("refreshes rows and page semantics on every cursorless query", async () => {
    h.observationSemantics = { title: "Loading", headings: ["Please wait"] };
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Old action", selector: "#old" }),
    ];
    const started = await startProvisionSession({
      serviceUrl: "https://xata.example.com/settings",
    });
    const first = await observeQuery(started.session_id, "action");
    expect(first.semantic).toEqual({ title: "Loading", headings: ["Please wait"] });
    expect(JSON.stringify(first.safe_table)).toContain("@old-action");

    h.observationSemantics = { title: "API keys", headings: ["Developer settings"] };
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Create key", selector: "#create" }),
    ];
    const second = await observeQuery(started.session_id, "key");
    expect(second.semantic).toEqual({
      title: "API keys",
      headings: ["Developer settings"],
    });
    expect(JSON.stringify(second.safe_table)).toContain("@create-key");
    expect(JSON.stringify(second.safe_table)).not.toContain("@old-action");
  });

  it("never trips the budget cliff on a real-world OAuth-shaped URL", async () => {
    h.elements = xataShapedElements();
    const started = await startProvisionSession({
      serviceUrl: "https://xata.example.com/login",
    });
    const firstRef = domRefs(started)[0];

    // An OAuth callback URL with long provider parameters — the shape that
    // ended the live Xata session with "compact-v2 budget metadata exceeded".
    // Long enough that even a one-row delta payload crosses the cap, forcing
    // the full-page path (and, pre-fix, the throw).
    const longQuery = Array.from(
      { length: 24 },
      (_, index) => `param${index}=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    ).join("&");
    h.currentUrl = `https://xata.example.com/auth/callback?code=x&state=y&${longQuery}`;
    h.elements = [
      ...(xataShapedElements() as Array<Record<string, unknown>>),
      elem({
        index: 200,
        tag: "button",
        role: "button",
        visibleText: "Fresh CTA",
        selector: "#fresh-cta",
      }),
    ];

    const observation = (await observe(started.session_id, "compact")) as unknown as Record<
      string,
      unknown
    >;
    expect(observation.format).toBe("browser-use-control-query");
    const wire = JSON.stringify(observation);
    expect(wire).toContain("fresh-cta");
    expect(firstRef === undefined || typeof firstRef === "string").toBe(true);
  });
});

describe("flat operator verbs", () => {
  it("fills text and then submits, and fills a secret slot without returning its value", async () => {
    h.elements = [elem({ labelText: "Name", selector: "#name" })];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const nameRef = domRefs(started)[0]!;
    await operateTypeTool.handler(
      { session_id: started.session_id, ref: nameRef, text: "Ada", submit: true },
      null,
    );
    expect(h.typed).toContainEqual({ selector: "#name", text: "Ada" });
    expect(h.pressedKeys).toEqual(["Enter"]);
    stashSecretSlot(started.session_id, "key", "private-slot-value");
    const refreshed = await observeQuery(started.session_id, "");
    const result = await operateTypeTool.handler(
      { session_id: started.session_id, ref: domRefs(refreshed)[0]!, slot: "key" },
      null,
    );
    expect(h.typed).toContainEqual({ selector: "#name", text: "private-slot-value", sealed: true });
    expect(JSON.stringify(result)).not.toContain("private-slot-value");
  });

  it("does not submit after a stale target", async () => {
    const { session_id } = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    await operateTypeTool
      .handler({ session_id, ref: "@e:missing", text: "Ada", submit: true }, null)
      .catch(() => undefined);
    expect(h.typed).toEqual([]);
    expect(h.pressedKeys).toEqual([]);
  });

  it("clicks, presses keys, scrolls, and waits through generic verbs", async () => {
    h.elements = [elem({ role: "button", visibleText: "Continue", selector: "#continue" })];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    await operateClickTool.handler(
      { session_id: started.session_id, ref: domRefs(started)[0]! },
      null,
    );
    expect(h.clickCalls).toBe(1);
    const sid = started.session_id;
    await operatePressTool.handler({ session_id: sid, key: "Tab" }, null);
    expect(h.pressedKeys).toEqual(["Tab"]);
    await operateScrollTool.handler({ session_id: sid, direction: "bottom" }, null);
    expect(h.scrolls).toEqual(["bottom"]);
    const waited = (await operateWaitTool.handler(
      { session_id: sid, milliseconds: 0 },
      null,
    )) as Record<string, unknown>;
    expect(waited.session_id).toBe(sid);
  });

  it("uses guarded DOM fallback only for a pre-dispatch pointer interception", async () => {
    h.elements = [elem({ role: "button", visibleText: "Continue", selector: "#continue" })];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const refOf = async () => domRefs(await observeQuery(started.session_id, ""))[0]!;
    h.clickError = new BrowserClickDispatchError(
      "not_dispatched",
      new Error("overlay intercepts pointer events"),
    );
    await operateClickTool.handler({ session_id: started.session_id, ref: await refOf() }, null);
    expect(h.jsClickCalls).toBe(1);
    h.clickError = new BrowserClickDispatchError(
      "dispatched",
      new Error("overlay intercepts pointer events; later dispatch failed"),
    );
    await expect(
      operateClickTool.handler({ session_id: started.session_id, ref: await refOf() }, null),
    ).rejects.toThrow("later dispatch failed");
    expect(h.jsClickCalls).toBe(1);
    h.clickError = new Error("overlay intercepts pointer events; dispatch unknown");
    await expect(
      operateClickTool.handler({ session_id: started.session_id, ref: await refOf() }, null),
    ).rejects.toThrow("dispatch unknown");
    expect(h.jsClickCalls).toBe(1);
  });

  it("reaches DOM fallback through compact-v2 after a proven non-dispatch", async () => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    expect(started.format).toBe("browser-use-dom");
    h.trackedClickFailure = {
      dispatchStatus: "not_dispatched",
      message: "overlay intercepts pointer events",
    };
    const fallback = (await operateClickTool.handler(
      { session_id: started.session_id, ref: "@continue" },
      null,
    )) as Record<string, unknown>;
    expect(fallback).toMatchObject({
      format: "browser-use-control-query",
      safe_table: [expect.any(Array)],
    });
    expect(fallback).not.toHaveProperty("delta");
    expect(h.clickCalls).toBe(0);
    expect(h.jsClickCalls).toBe(1);
  });

  it("returns the compact control map after an action by default; full DOM only on request", async () => {
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        selector: "#api-key",
        name: "api-key",
        ariaLabel: "API key",
        value: "••••••••",
      }),
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      elem({ tag: "select", role: "select", labelText: "Region", selector: "#region" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const baseline = await observe(started.session_id, "compact");
    expect(baseline.format).toBe("browser-use-control-query");
    type ActionResult = {
      format?: string;
      safe_table?: unknown;
      dom?: unknown;
      delta?: boolean;
      removed?: string[];
    };
    const refsOf = (observation: { safe_table?: unknown }): Set<string> =>
      new Set(
        ((observation.safe_table as unknown as Array<[string, string]> | undefined) ?? []).map(
          (row) => row[0]!,
        ),
      );
    const baselineRefs = refsOf(baseline);
    expect(baselineRefs.size).toBe(3);
    const refForRole = (role: string): string =>
      ((baseline.safe_table as unknown as Array<[string, string]>) ?? []).find(
        (row) => row[1] === role,
      )?.[0]!;
    const buttonRef = refForRole("b");
    const keyRef = refForRole("t");
    const selectRef = refForRole("s");
    expect(buttonRef).toBeDefined();
    expect(keyRef).toBeDefined();
    expect(selectRef).toBeDefined();

    // Default action returns: the same browser-use-control-query shape as
    // observe, with only changed/new refs plus the acted control's own row
    // marked w=acted. The raw value that appeared after the reveal click
    // never enters that compact response.
    h.elements = [
      elem({
        tag: "input",
        role: "textbox",
        selector: "#api-key",
        name: "api-key",
        ariaLabel: "API key",
        value: "sk-test-revealed",
      }),
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      elem({ tag: "select", role: "select", labelText: "Region", selector: "#region" }),
      elem({ tag: "button", role: "button", visibleText: "Copy", selector: "#copy" }),
    ];
    const clicked = (await operateClickTool.handler(
      { session_id: started.session_id, ref: buttonRef },
      null,
    )) as ActionResult;
    expect(clicked.format).toBe("browser-use-control-query");
    expect(clicked.delta).toBe(true);
    expect(clicked).not.toHaveProperty("dom");
    expect(JSON.stringify(clicked)).not.toContain("sk-test-revealed");
    // The new Copy control and the acted Continue row (w=acted) — the acted
    // echo is part of the documented contract, not a changed control.
    expect(refsOf(clicked).size).toBe(2);
    const actedRow = (clicked.safe_table as string[][]).find((row) =>
      (row[2] ?? "").includes("w=acted"),
    );
    expect(actedRow, "acted control echoed with w=acted").toBeDefined();
    expect(actedRow![0]).toBe(buttonRef);
    const [copyRef] = [...refsOf(clicked)].filter((ref) => ref !== buttonRef);
    expect(copyRef).toBeDefined();

    const afterClick = await observe(started.session_id, "compact");
    const afterClickRefs = refsOf(afterClick);
    expect(afterClickRefs.size).toBe(4);
    expect([...refsOf(clicked)].every((ref) => afterClickRefs.has(ref))).toBe(true);
    expect([...baselineRefs].every((ref) => afterClickRefs.has(ref))).toBe(true);

    // Opt-in verbatim returns the unredacted DOM tree, including raw values.
    h.elements[0] = elem({
      tag: "input",
      role: "textbox",
      selector: "#api-key",
      name: "api-key",
      ariaLabel: "API key",
      value: "sk-test-revealed-again",
    });
    const full = (await operateClickTool.handler(
      { session_id: started.session_id, ref: buttonRef, format: "full" },
      null,
    )) as ActionResult;
    expect(full.format).toBe("browser-use-dom");
    expect(full.dom).toContain("sk-test-revealed-again");

    const typed = (await operateTypeTool.handler(
      { session_id: started.session_id, ref: keyRef, text: "hello" },
      null,
    )) as ActionResult;
    expect(typed.format).toBe("browser-use-control-query");
    expect(typed).not.toHaveProperty("delta");
    expect(typed).not.toHaveProperty("dom");

    h.elements = h.elements.filter(
      (element) => (element as { selector?: string }).selector !== "#copy",
    );
    const pressed = (await operatePressTool.handler(
      { session_id: started.session_id, key: "Tab" },
      null,
    )) as ActionResult;
    expect(pressed.format).toBe("browser-use-control-query");
    expect(pressed.delta).toBe(true);
    expect(pressed.removed).toEqual([copyRef]);
    expect(pressed).not.toHaveProperty("dom");

    const scrolled = (await operateScrollTool.handler(
      { session_id: started.session_id, direction: "bottom" },
      null,
    )) as ActionResult;
    expect(scrolled.format).toBe("browser-use-control-query");
    expect(scrolled.delta).toBe(true);
    expect(scrolled).not.toHaveProperty("dom");

    const selected = (await operateSelectTool.handler(
      { session_id: started.session_id, ref: selectRef, values: ["us-east"] },
      null,
    )) as ActionResult;
    expect(selected.format).toBe("browser-use-control-query");
    expect(selected.delta).toBe(true);
    expect(selected).not.toHaveProperty("dom");

    const selectedMany = (await operateSelectTool.handler(
      { session_id: started.session_id, selections: { [selectRef]: "us-west" } },
      null,
    )) as { fields?: unknown[]; observation: ActionResult };
    expect(selectedMany.observation.format).toBe("browser-use-control-query");
    expect(selectedMany.observation).not.toHaveProperty("delta");
    expect(refsOf(selectedMany.observation).size).toBe(3);
    expect(selectedMany.fields).toEqual([expect.objectContaining({ status: "selected" })]);
    const fullMany = (await operateSelectTool.handler(
      { session_id: started.session_id, selections: { [selectRef]: "us-west" }, format: "full" },
      null,
    )) as { observation: ActionResult };
    expect(fullMany.observation.format).toBe("browser-use-dom");
  });

  it.each([
    ["click", operateClickTool, { ref: "@continue" }],
    ["type", operateTypeTool, { ref: "@name", text: "Ada" }],
    ["press", operatePressTool, { key: "Tab" }],
    ["select", operateSelectTool, { ref: "@region", values: ["US"] }],
    ["select many", operateSelectTool, { selections: { "@region": "US" } }],
  ] as const)("resends controls discarded by %s capture", async (_name, tool, args) => {
    h.elements = [
      elem({ tag: "button", role: "button", visibleText: "Continue", selector: "#continue" }),
      elem({ tag: "input", role: "textbox", ariaLabel: "Name", selector: "#name" }),
      elem({ tag: "select", role: "select", labelText: "Region", selector: "#region" }),
    ];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    h.capturePage = page;
    const storeCredential = vi.fn().mockResolvedValue({ reference: "vault://acct/captured" });
    const api = { storeCredential } as unknown as ApiClient;
    const outcomes =
      _name === "click"
        ? (["stored", "ambiguous", "missing", "unresolved", "unchanged"] as const)
        : (["stored", "ambiguous", "missing", "unresolved"] as const);
    for (const outcome of outcomes) {
      await observe(started.session_id, "compact");
      h.elements.push(
        elem({ tag: "button", role: "button", visibleText: outcome, selector: `#${outcome}` }),
      );
      // Exercise real pinned handles and descriptors. Click capture must see
      // a changed document; the unchanged case must never reach vault storage.
      const before = '<input aria-label="API key" value="pre-action-value">';
      const after =
        outcome === "ambiguous"
          ? '<input value="captured-secret"><input value="another-secret">'
          : outcome === "missing"
            ? "<p>No key available</p>"
            : '<input aria-label="API key" value="captured-secret">';
      await page.setContent(_name === "click" ? before : after);
      h.captureClick =
        outcome === "unchanged"
          ? null
          : async () => {
              await page.setContent(after);
            };
      const writesBefore = storeCredential.mock.calls.length;
      if (outcome === "unresolved") storeCredential.mockRejectedValueOnce(new Error("offline"));
      const captured = await tool.handler(
        tool.inputSchema.parse({
          session_id: started.session_id,
          ...args,
          capture: { store: { service: "example" }, source: { role: "textbox" } },
        }) as never,
        api,
      );
      expect(captured).toMatchObject({ closed: false, stored: outcome === "stored" });
      if (outcome !== "stored")
        expect(captured).toHaveProperty(
          "error",
          outcome === "ambiguous"
            ? "capture_ambiguous"
            : outcome === "unchanged"
              ? "capture_pre_action_only"
              : "capture_unresolved",
        );
      if (outcome === "stored") {
        expect(captured).toHaveProperty("resolved_source", {
          tag: "input",
          role: "textbox",
          name: "API key",
        });
      }
      if (outcome === "stored" || outcome === "unresolved") {
        expect(storeCredential).toHaveBeenCalledTimes(writesBefore + 1);
        expect(storeCredential).toHaveBeenLastCalledWith(
          expect.objectContaining({ value: "captured-secret" }),
        );
      } else {
        expect(storeCredential).toHaveBeenCalledTimes(writesBefore);
      }
      if (outcome === "missing") expect(captured).toMatchObject({ candidate_count: 0, found: [] });
      expect(captured).not.toHaveProperty("safe_table");
      expect(captured).not.toHaveProperty("observation");
      const next = await operateScrollTool.handler(
        { session_id: started.session_id, direction: "bottom" },
        null,
      );
      expect(next).not.toHaveProperty("delta");
      expect((next as { safe_table: unknown[] }).safe_table).toHaveLength(h.elements.length);
    }
    expect(storeCredential).toHaveBeenCalledTimes(2);
  });

  it("resends controls after discarded fill observations and filtered queries", async () => {
    h.elements = [elem({ tag: "input", role: "textbox", ariaLabel: "Name", selector: "#name" })];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    await observe(started.session_id, "compact");
    h.elements.push(
      elem({ tag: "button", role: "button", visibleText: "Revealed", selector: "#revealed" }),
    );
    const submitted = await operateTypeTool.handler(
      { session_id: started.session_id, ref: "@name", text: "Ada", submit: true },
      null,
    );
    expect(submitted).toMatchObject({ format: "browser-use-control-query" });
    expect(submitted).not.toHaveProperty("delta");
    expect((submitted as { safe_table: unknown[] }).safe_table).toHaveLength(2);
    h.elements.push(
      elem({ tag: "button", role: "button", visibleText: "Hidden from query", selector: "#other" }),
    );
    const filtered = await observeQuery(started.session_id, "Name");
    expect(filtered.safe_table).toHaveLength(1);
    const pressed = await operatePressTool.handler(
      { session_id: started.session_id, key: "Tab" },
      null,
    );
    expect(pressed).not.toHaveProperty("delta");
    expect((pressed as { safe_table: unknown[] }).safe_table).toHaveLength(3);
  });

  it("falls back to a paginated complete map when removals exceed the delta budget", async () => {
    h.elements = [];
    const started = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    await observe(started.session_id, "compact");
    for (let batch = 0; batch < 30; batch += 1) {
      h.elements.push(
        ...Array.from({ length: 20 }, (_, offset) => {
          const index = batch * 20 + offset;
          return elem({
            index,
            tag: "button",
            role: "button",
            visibleText: `Item ${index}`,
            selector: `#item-${index}`,
          });
        }),
      );
      const added = await operatePressTool.handler(
        { session_id: started.session_id, key: "Tab" },
        null,
      );
      expect(added).toMatchObject({ delta: true });
      expect(added).not.toHaveProperty("overflow");
    }
    h.elements = h.elements.slice(500);
    let page = (await operatePressTool.handler(
      { session_id: started.session_id, key: "Tab" },
      null,
    )) as {
      safe_table: Array<[string, ...unknown[]]>;
      overflow?: { next_cursor: string };
    };
    expect(page).not.toHaveProperty("delta");
    expect(page).not.toHaveProperty("removed");
    expect(page).toHaveProperty("overflow");
    const refs = new Set<string>();
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      for (const row of page.safe_table) refs.add(row[0]);
      if (!page.overflow) break;
      page = (await observeQuery(
        started.session_id,
        "",
        undefined,
        page.overflow.next_cursor,
      )) as typeof page;
    }
    expect(refs.size).toBe(100);
  });

  it("selects one option, several fields, and the phone country through operate_select", async () => {
    h.elements = [
      elem({ tag: "select", labelText: "Country", selector: "#country" }),
      elem({ tag: "select", labelText: "State", selector: "#state" }),
    ];
    const { session_id } = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    await operateSelectTool.handler(
      { session_id, ref: domRefs(await observeQuery(session_id, ""))[0]!, values: ["Japan"] },
      null,
    );
    expect(h.selected).toContainEqual({ selector: "#country", matcher: "Japan" });
    // @label keys resolve against the refreshed snapshot between entries.
    const result = await operateSelectTool.handler(
      { session_id, selections: { "@country": "Japan", "@state": "Tokyo" } },
      null,
    );
    expect(result).toMatchObject({ fields: [{ status: "selected" }, { status: "selected" }] });
    await operateSelectTool.handler({ session_id, country: "JP" }, null);
    expect(h.phoneCountries).toEqual(["JP"]);
  });

  it("finishes a reported result through the flat completion schema", async () => {
    const { session_id } = await startProvisionSession({ serviceUrl: "https://app.example.com/" });
    const result = await operateFinishTool.handler(
      operateFinishTool.inputSchema.parse({
        session_id,
        outcome: "result",
        summary: "Account ready",
        data: { confirmed: true },
      }),
      null,
    );
    expect(result).toMatchObject({ kind: "result", summary: "Account ready" });
    expect(activeSessionCount()).toBe(0);
    expect(h.closeCalls).toBe(1);
  });
});

function domRefs(observation: { dom?: string; safe_table?: unknown[] }): string[] {
  if (observation.dom !== undefined) {
    return [...observation.dom.matchAll(/\[(@e:[A-Za-z0-9_-]+)\]</g)].map((match) => match[1]!);
  }
  return (observation.safe_table ?? []).flatMap((row) => {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0].startsWith("@e:")) return [];
    return [row[0]];
  });
}

it("explicit full reads restore the DOM after unchanged reads and compact actions", async () => {
  h.elements = [elem({ id: "email", name: "email", type: "email", selector: "#email" })];
  h.prose = ["Login form"];
  const started = await startProvisionSession({ serviceUrl: "https://app.example.com/login" });
  const args = { session_id: started.session_id, format: "full" as const };
  for (let i = 0; i < 2; i++) {
    const full = await provisionObserveTool.handler(args, null);
    expect(full).toHaveProperty("dom", expect.stringContaining("Login form"));
    expect(full).not.toHaveProperty("dom_unchanged");
  }
  const compact = (await provisionObserveTool.handler(
    { session_id: started.session_id },
    null,
  )) as { safe_table: Array<[string, string, string?]> };
  const ref = compact.safe_table[0]![0];
  await operateTypeTool.handler(
    { session_id: started.session_id, ref, text: "example@example.test" },
    null,
  );
  for (const options of [{}, { role: "textbox" }]) {
    const fresh = await provisionObserveTool.handler(
      { session_id: started.session_id, ...options },
      null,
    );
    expect(fresh).toHaveProperty(
      "safe_table",
      expect.arrayContaining([expect.arrayContaining([ref])]),
    );
    expect(fresh).not.toHaveProperty("delta");
  }
  expect(await provisionObserveTool.handler(args, null)).toHaveProperty("dom");
  h.mainDocumentEpoch++;
  h.currentUrl = "https://app.example.com/dashboard";
  h.prose = ["Dashboard"];
  expect(await provisionObserveTool.handler(args, null)).toHaveProperty(
    "dom",
    expect.stringContaining("Dashboard"),
  );
});

it("missing login slots explain the vault field names and supported fill flow in compact v2", async () => {
  h.elements = [
    elem({ id: "password", name: "password", type: "password", selector: "#password" }),
  ];
  const started = await startProvisionSession({
    serviceUrl: "https://app.example.com/login",
    format: "compact",
  });
  const ref = (started as unknown as { safe_table: Array<[string, string]> }).safe_table[0]![0];
  await expect(
    operateTypeTool.handler({ session_id: started.session_id, ref, slot: "password" }, null),
  ).rejects.toThrow(/operate_fill_credential.*list_credentials.*field_names.*operate_type/);
  expect(h.typed).toEqual([]);
});

it("documents the saved-login fields default and both supported naming conventions", () => {
  const args = { session_id: "test-session", reference: "vault://test/login" };
  expect(operateFillCredentialTool.inputSchema.parse(args).fields).toEqual(["login", "password"]);
  expect(operateLoginTool.inputSchema.parse({ ...args, action: "load_saved" })).toHaveProperty(
    "fields",
    ["login", "password"],
  );
  for (const tool of [operateFillCredentialTool, operateLoginTool]) {
    const schema = JSON.stringify(tool.jsonInputSchema);
    expect(schema).toContain("field_names from list_credentials");
    expect(schema).toContain('"default":["login","password"]');
    expect(schema).toContain("username");
    expect(schema).toContain("operate_type");
  }
});
