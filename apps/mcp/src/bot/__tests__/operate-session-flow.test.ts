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
  visibleText: "",
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
    text: "Add To Cart",
    safetySignals: { billingObject: false, accountSetup: false },
  } as
    | {
        ok: true;
        text: string;
        safetySignals: { billingObject: boolean; accountSetup: boolean };
      }
    | { ok: false; reason: "none" | "ambiguous"; candidates: string[] },
  locatorClickCalls: 0,
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
    async extractVisibleText(): Promise<string> {
      return h.visibleText;
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
    async resolvePageTarget(
      _mode: string,
      _value: string,
    ): Promise<
      | {
          ok: true;
          handle: { dispose: () => Promise<void> };
          text: string;
          safetySignals: { billingObject: boolean; accountSetup: boolean };
        }
      | { ok: false; reason: "none" | "ambiguous"; candidates: string[] }
    > {
      if (h.locatorResolve.ok) {
        return {
          ok: true,
          handle: {
            dispose: async () => {
              h.locatorDisposeCalls += 1;
            },
          },
          text: h.locatorResolve.text,
          safetySignals: h.locatorResolve.safetySignals,
        };
      }
      return h.locatorResolve;
    }
    async clickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
    }
    async jsClickHandle(): Promise<void> {
      h.locatorClickCalls += 1;
    }
    async uploadFile(selector: string, filePath: string): Promise<void> {
      h.uploads.push({ selector, filePath });
    }
    async startOAuth(): Promise<void> {}
    async settleAfterOAuth(): Promise<void> {}
    async pressKey(): Promise<void> {}
    async close(): Promise<void> {
      h.closeCalls += 1;
      if (h.connections[this.index] === true) h.started -= 1;
      h.connections[this.index] = false;
    }
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
  recordActivePaymentProvenance,
} from "../provision-session.js";
import { readRecipeForTask, type OperatorRecipe } from "../operator-recipe.js";
import {
  provisionRememberTool,
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
  h.visibleText = "";
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
    text: "Add To Cart",
    safetySignals: { billingObject: false, accountSetup: false },
  };
  h.locatorClickCalls = 0;
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
              target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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

  it("blocks payment until the exact missed field is repaired and replay resumes", async () => {
    h.elements = [];
    const recipe = replayRecipe({
      trace: [
        {
          action: {
            kind: "type",
            target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
            target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
            target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
              target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
              target: { dom_hint: { testid: "shipping-city" }, css: "#city", field_role: "ac:address-level2" },
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
              target: { dom_hint: { testid: "shipping-country" }, accessible_name: "Country", field_role: "ac:country" },
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
              target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
              target: { dom_hint: { testid: "shipping-city" }, accessible_name: "City", field_role: "ac:address-level2" },
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
    await act(obs.session_id, { kind: "click", target: "css=#atc" });
    expect(h.locatorClickCalls).toBe(1);
  });

  it("refuses to remember a session that used a locator fallback", async () => {
    h.visibleText = "Product configurator";
    h.locatorResolve = {
      ok: true,
      text: "Add To Cart",
      safetySignals: { billingObject: false, accountSetup: false },
    };
    const obs = await startProvisionSession({ serviceUrl: "https://dashboard.example.com/" });
    await act(obs.session_id, { kind: "click", target: "css=#atc" });

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
