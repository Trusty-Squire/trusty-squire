// Phase 0 of the operator session-management restructure: a characterization
// ORACLE, not new behavior. It pins what the driving agent and the internal
// callers actually see today so the mechanical extractions that follow
// (session/model, lifecycle, targeting, perception, …) are provably
// behavior-preserving:
//
//   1. the registered operate_* tool surface — exact names, order, and the
//      declared JSON input schema of the observation tools;
//   2. Session CONSTRUCTION, field for field, for BOTH the normal start and
//      the harness start, snapshotted at the exact moment the two initializers
//      finish (inside the first goto, while `initializing` is still true);
//   3. the key lifecycle ordering around start/observe/finish;
//   4. the exact agent-facing observation payloads — compact-v2, V1 compact,
//      V1 full, and operate_observe_query — asserted as complete key sets so a
//      field that silently appears or disappears fails here.
//
// Everything asserted here is current behavior. If a later phase needs one of
// these lines changed, that is a behavior change and belongs in a design
// decision, not in a refactor.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as GoogleLoginModule from "../google-login.js";
import type * as BrowserModule from "../browser.js";
import type { InteractiveElement } from "../browser.js";

const h = vi.hoisted(() => ({
  providers: ["google"] as string[] | null,
  workerEmail: "operator@example.com" as string | null,
  currentUrl: "",
  elements: [] as unknown[],
  visibleText: "",
  gotos: [] as string[],
  closeCalls: 0,
  documentEpoch: 0,
  // Runs inside the first goto — i.e. after the initializer has inserted the
  // Session and started its watchdog, but before the initial observation.
  onFirstGoto: null as null | (() => void),
  // Ordered record of the terminal-teardown steps the browser side observes.
  terminalOrder: [] as string[],
}));

vi.mock("../browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserModule>();
  return {
    ...actual,
    registerLocalBrowserLaunch: (
      _profileDir: string,
      baseEnv: NodeJS.ProcessEnv = process.env,
      marker = "v1:1:characterization",
    ) => ({
      marker,
      env: { ...baseEnv, TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER: marker },
    }),
    BrowserController: class {
      async start(): Promise<void> {}
      isConnected(): boolean {
        return true;
      }
      async close(): Promise<void> {
        h.closeCalls += 1;
        h.terminalOrder.push("browser_close");
      }
      async waitForThreeDsResolution(): Promise<string> {
        return "challenge_pending";
      }
      async detectSessionProviders(): Promise<string[]> {
        return h.providers ?? [];
      }
      async detectGoogleAccountEmail(): Promise<string | null> {
        return h.workerEmail;
      }
      async setHostScopeAllowedHosts(): Promise<void> {}
      async goto(url: string): Promise<void> {
        const first = h.gotos.length === 0;
        h.gotos.push(url);
        h.currentUrl = url;
        h.documentEpoch += 1;
        if (first && h.onFirstGoto !== null) h.onFirstGoto();
      }
      currentUrl(): string {
        return h.currentUrl;
      }
      mainDocumentIdentity(): string {
        return String(h.documentEpoch);
      }
      recoverActivePage(): void {}
      completeOAuthTransitionRecovery(): void {}
      async dismissConsentBanner(): Promise<string | null> {
        return null;
      }
      async waitForCaptchaChallengeToSettle(): Promise<boolean> {
        return false;
      }
      async extractInteractiveElements(): Promise<unknown[]> {
        return h.elements;
      }
      async extractObservationSemantics(): Promise<{ title: string; headings: string[] }> {
        return { title: "", headings: [] };
      }
      async extractVisibleText(): Promise<string> {
        return h.visibleText;
      }
      async extractCheckoutFieldNames(): Promise<string[]> {
        return [];
      }
      async readCheckoutSummary(): Promise<null> {
        return null;
      }
      async readCartLineItems(): Promise<unknown[]> {
        return [];
      }
    },
  };
});

vi.mock("../google-login.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GoogleLoginModule>();
  return {
    ...actual,
    detectActiveProviderSessions: async () => h.providers,
    ensureOAuthSession: async () => ({ status: "already_valid" }),
  };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController } from "../browser.js";
import { TOOLS } from "../../tools/index.js";
import {
  provisionObserveTool,
  provisionObserveQueryTool,
  provisionStartTool,
} from "../../tools/provision-drive.js";
import {
  startProvisionSession,
  startHarnessProvisionSession,
  observe,
  observeQuery,
  paymentSession,
  withProvisionSessionCall,
  finishProvisionSession,
  closeAllProvisionSessions,
  activeSessionCount,
  setActivePendingThreeDs,
  type Session,
} from "../provision-session.js";
import * as provisionSession from "../provision-session.js";
import * as sessionLifecycle from "../session/lifecycle.js";
import type { ApiClient } from "../../api-client.js";

// A Session snapshot reduced to comparable primitives. Collections render as
// kind + size so "empty Map" is asserted as exactly that, rather than as an
// opaque object a loose deep-equal would wave through.
function describeSessionShape(session: Session): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(session).sort()) {
    const value = (session as unknown as Record<string, unknown>)[key];
    if (value instanceof Map) entries[key] = { kind: "Map", size: value.size };
    else if (value instanceof Set) entries[key] = { kind: "Set", size: value.size };
    else if (Buffer.isBuffer(value)) entries[key] = { kind: "Buffer", length: value.length };
    else if (Array.isArray(value)) entries[key] = { kind: "Array", length: value.length };
    else if (value === null) entries[key] = null;
    else if (typeof value === "object")
      entries[key] = { kind: "object", ctor: value.constructor.name };
    else entries[key] = value;
  }
  return entries;
}

let profileDir: string;

beforeEach(() => {
  h.providers = ["google"];
  h.workerEmail = "operator@example.com";
  h.currentUrl = "";
  h.elements = [];
  h.visibleText = "";
  h.gotos = [];
  h.closeCalls = 0;
  h.documentEpoch = 0;
  h.onFirstGoto = null;
  h.terminalOrder = [];
  profileDir = mkdtempSync(join(tmpdir(), "ts-session-characterization-"));
});

afterEach(async () => {
  h.onFirstGoto = null;
  await closeAllProvisionSessions().catch(() => undefined);
  rmSync(profileDir, { recursive: true, force: true });
});

// ── 1. tool surface ───────────────────────────────────────────────────────

describe("characterization: registered operator tool surface", () => {
  it("registers exactly these operate_* tools, in this order", () => {
    expect(TOOLS.map((tool) => tool.name).filter((name) => name.startsWith("operate_"))).toEqual([
      "operate_pay",
      "operate_payment_status",
      "operate_start",
      "operate_observe",
      "operate_screenshot",
      "operate_observe_query",
      "operate_act",
      "operate_recipe_save",
      "operate_recipe_run",
      "operate_finish",
    ]);
  });

  it("declares the observation tools' JSON input schemas unchanged", () => {
    expect(provisionObserveTool.jsonInputSchema).toEqual({
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        detail: { type: "string", enum: ["compact", "full"] },
      },
    });
    expect(provisionObserveQueryTool.jsonInputSchema).toEqual({
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string" },
        query: { type: "string" },
        role: {
          type: "string",
          enum: [
            "button",
            "link",
            "textbox",
            "select",
            "checkbox",
            "radio",
            "tab",
            "menuitem",
            "file",
          ],
        },
        cursor: { type: "string" },
      },
    });
    expect(provisionStartTool.name).toBe("operate_start");
  });
});

// ── 2. session construction, field for field ──────────────────────────────

describe("characterization: Session construction", () => {
  it("startProvisionSession builds exactly this session", async () => {
    let constructed: Record<string, unknown> | null = null;
    let secretA: Buffer | null = null;
    let startedAt = 0;
    const before = Date.now();
    h.onFirstGoto = () => {
      const session = paymentSession();
      constructed = describeSessionShape(session);
      secretA = session.compactV2Secret;
      startedAt = session.startedAt;
    };
    await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      profileDir,
      extraAllowedHosts: ["mail.example.com"],
      consentInboxRead: true,
    });
    const after = Date.now();

    expect(constructed).toEqual({
      activePayment: null,
      actionTrace: { kind: "Array", length: 0 },
      allowedHosts: { kind: "Array", length: 2 },
      browser: { kind: "object", ctor: "BrowserController" },
      callCount: 0,
      callDrainWaiters: { kind: "Set", size: 0 },
      captureRounds: { kind: "Array", length: 0 },
      cartAdds: { kind: "Map", size: 0 },
      cartAddsByIdempotencyKey: { kind: "Map", size: 0 },
      cartUrls: { kind: "Map", size: 0 },
      closing: false,
      committedSelectValues: { kind: "Map", size: 0 },
      compactV2Active: false,
      compactV2HintPages: { kind: "Array", length: 0 },
      compactV2Index: null,
      compactV2Mode: "on",
      compactV2Previous: null,
      compactV2Refs: { kind: "Map", size: 0 },
      compactV2Secret: { kind: "Buffer", length: 32 },
      consentInboxRead: true,
      generation: 0,
      hintServed: false,
      id: expect.any(String),
      initializing: true,
      lastActivityAt: expect.any(Number),
      lastCartCheckout: null,
      lastCartMutation: null,
      lastElements: { kind: "Array", length: 0 },
      observeSnapshotFile: null,
      paymentCallCount: 0,
      paymentCallDrainWaiters: { kind: "Set", size: 0 },
      paymentDispatchClosed: false,
      paymentDispatchHandoff: null,
      paymentFieldSealActive: false,
      placeOrderApproval: null,
      placeOrderAttempted: false,
      pendingThreeDs: null,
      prevObserve: null,
      recipeRejectionReason: null,
      recordedValues: { kind: "Array", length: 0 },
      replayState: null,
      sealedFieldKeys: { kind: "Set", size: 0 },
      secretSlots: { kind: "Map", size: 0 },
      startUrl: "https://app.example.com/signup",
      startedAt: expect.any(Number),
      terminalTeardownOwner: null,
      usedLocatorFallback: false,
      userEmail: "operator@example.com",
      watchdog: { kind: "object", ctor: "OperatorBrowserWatchdog" },
    });
    // `api` is ABSENT (not present-and-undefined) when the tool layer passed none.
    expect(Object.keys(constructed!)).not.toContain("api");
    expect(secretA).toBeInstanceOf(Buffer);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(after);
  });

  it("startProvisionSession seeds allowedHosts as start-sourced and keeps the api client key when supplied", async () => {
    let hosts: unknown = null;
    let hasApi = false;
    const api = { fake: true } as never;
    h.onFirstGoto = () => {
      const session = paymentSession();
      hosts = session.allowedHosts;
      hasApi = Object.keys(session).includes("api");
    };
    await startProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      profileDir,
      extraAllowedHosts: ["mail.example.com"],
      api,
    });
    expect(hosts).toEqual([
      { host: "app.example.com", source: "start" },
      { host: "mail.example.com", source: "start" },
    ]);
    expect(hasApi).toBe(true);
  });

  it("startHarnessProvisionSession builds the same session with its harness-specific fields", async () => {
    let constructed: Record<string, unknown> | null = null;
    h.onFirstGoto = () => {
      constructed = describeSessionShape(paymentSession());
    };
    const browser = new BrowserController({});
    await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      browser,
      hint: "route hint",
      observationFormat: "v1",
    });

    expect(constructed).toEqual({
      activePayment: null,
      actionTrace: { kind: "Array", length: 0 },
      allowedHosts: { kind: "Array", length: 1 },
      browser: { kind: "object", ctor: "BrowserController" },
      callCount: 0,
      callDrainWaiters: { kind: "Set", size: 0 },
      captureRounds: { kind: "Array", length: 0 },
      cartAdds: { kind: "Map", size: 0 },
      cartAddsByIdempotencyKey: { kind: "Map", size: 0 },
      cartUrls: { kind: "Map", size: 0 },
      closing: false,
      committedSelectValues: { kind: "Map", size: 0 },
      compactV2Active: false,
      compactV2HintPages: { kind: "Array", length: 0 },
      compactV2Index: null,
      // harness start derives the mode from observationFormat, never the env.
      compactV2Mode: "off",
      compactV2Previous: null,
      compactV2Refs: { kind: "Map", size: 0 },
      compactV2Secret: { kind: "Buffer", length: 32 },
      // harness start never consents to an inbox read and has no user identity.
      consentInboxRead: false,
      generation: 0,
      hintServed: true,
      id: expect.any(String),
      initializing: true,
      lastActivityAt: expect.any(Number),
      lastCartCheckout: null,
      lastCartMutation: null,
      lastElements: { kind: "Array", length: 0 },
      observeSnapshotFile: null,
      paymentCallCount: 0,
      paymentCallDrainWaiters: { kind: "Set", size: 0 },
      paymentDispatchClosed: false,
      paymentDispatchHandoff: null,
      paymentFieldSealActive: false,
      placeOrderApproval: null,
      placeOrderAttempted: false,
      pendingThreeDs: null,
      prevObserve: null,
      recipeRejectionReason: null,
      recordedValues: { kind: "Array", length: 0 },
      replayState: null,
      sealedFieldKeys: { kind: "Set", size: 0 },
      secretSlots: { kind: "Map", size: 0 },
      startUrl: "https://shop.example.com/cart",
      startedAt: expect.any(Number),
      terminalTeardownOwner: null,
      usedLocatorFallback: false,
      userEmail: null,
      watchdog: { kind: "object", ctor: "OperatorBrowserWatchdog" },
    });
    expect(Object.keys(constructed!)).not.toContain("api");
  });

  it("gives every session its own random 32-byte compact-v2 secret", async () => {
    const secrets: Buffer[] = [];
    h.onFirstGoto = () => {
      secrets.push(paymentSession().compactV2Secret);
    };
    const first = await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/a",
      browser: new BrowserController({}),
    });
    await finishProvisionSession(first.session_id);
    h.gotos = [];
    await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/b",
      browser: new BrowserController({}),
    });
    expect(secrets).toHaveLength(2);
    expect(secrets[0]!.length).toBe(32);
    expect(secrets[1]!.length).toBe(32);
    expect(secrets[0]!.equals(secrets[1]!)).toBe(false);
  });
});

// ── 3. lifecycle ordering ─────────────────────────────────────────────────

describe("characterization: session lifecycle ordering", () => {
  it("clears initializing only after the first observation, then finish removes the exact session", async () => {
    const seen: string[] = [];
    h.onFirstGoto = () => {
      seen.push(`goto:initializing=${paymentSession().initializing}`);
    };
    const observation = await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      browser: new BrowserController({}),
    });
    expect(seen).toEqual(["goto:initializing=true"]);
    expect(activeSessionCount()).toBe(1);

    const afterStart = await withProvisionSessionCall(observation.session_id, async (session) => ({
      initializing: session.initializing,
      closing: session.closing,
      generation: session.generation,
    }));
    expect(afterStart).toEqual({ initializing: false, closing: false, generation: 1 });

    await finishProvisionSession(observation.session_id);
    expect(activeSessionCount()).toBe(0);
    expect(h.closeCalls).toBe(1);
    await expect(observe(observation.session_id)).rejects.toThrow(/unknown provision session/);
  });

  it("bumps the observation generation once per observe", async () => {
    const observation = await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/cart",
      browser: new BrowserController({}),
    });
    await observe(observation.session_id);
    await observe(observation.session_id);
    const generation = await withProvisionSessionCall(
      observation.session_id,
      async (session) => session.generation,
    );
    expect(generation).toBe(3);
  });
});

// ── 4. agent-facing observation payload shapes ────────────────────────────

// The COMPLETE agent-visible key set of each observation payload. Asserted as
// a whole set (not "contains") so a silently added or dropped field fails.
const FIRST_V2_KEYS = ["format", "safe_table", "session_id", "stage", "text", "url"];
// A repeat compact-v2 read on an unchanged page collapses to a delta: no
// safe_table and no stage.
const REOBSERVE_V2_KEYS = ["delta", "format", "session_id", "text", "url"];
const V1_COMPACT_KEYS = [
  "delta",
  "elements_total",
  "guidance",
  "session_id",
  "snapshot_file",
  "text",
  "text_unchanged",
  "unchanged",
  "url",
];
const V1_FULL_KEYS = [
  "accessibility",
  "elements",
  "guidance",
  "screen",
  "session_id",
  "text",
  "url",
];
const QUERY_KEYS = ["format", "safe_table", "session_id", "stage", "text", "url"];

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

const SAMPLE_ELEMENTS: InteractiveElement[] = [
  el({
    index: 0,
    tag: "input",
    type: "email",
    name: "email",
    labelText: "Email",
    placeholder: "you@example.com",
    selector: "#email",
  }),
  el({ index: 1, tag: "button", type: "submit", visibleText: "Sign up", selector: "#submit" }),
];

// ── 3b. lifecycle facade + terminal-transaction ordering ──────────────────
//
// Phase 2 moved the registry transaction to session/lifecycle.ts behind the
// facade. These two pin the properties that move could silently break: the
// facade must FORWARD (not re-implement) each lifecycle export, and the
// terminal transition must still audit a pending 3-D Secure outcome BEFORE the
// browser closes, then clear artifacts and drop the exact session.

describe("characterization: session lifecycle facade", () => {
  it("re-exports the lifecycle transaction as forwards, not copies", () => {
    for (const name of [
      "startProvisionSession",
      "startHarnessProvisionSession",
      "finishProvisionSession",
      "finishProvisionSessionWithPreparation",
      "closeAllProvisionSessions",
      "activeSessionCount",
      "paymentSession",
      "withProvisionSessionCall",
      "withPaymentSessionCall",
      "googleSessionGate",
    ] as const) {
      const facade = (provisionSession as unknown as Record<string, unknown>)[name];
      const owner = (sessionLifecycle as unknown as Record<string, unknown>)[name];
      expect(typeof facade).toBe("function");
      expect(typeof owner).toBe("function");
      // The two start paths bind perception ports, so they are thin wrappers;
      // everything else must be the identical function object.
      if (name === "startProvisionSession" || name === "startHarnessProvisionSession") continue;
      expect(facade).toBe(owner);
    }
  });

  it("audits a pending 3-D Secure outcome before closing the browser, then clears the session", async () => {
    const auditPayment = vi.fn().mockImplementation(async () => {
      h.terminalOrder.push("3ds_audit");
      return { id: "evt_characterization" };
    });
    let session: Session | null = null;
    h.onFirstGoto = () => {
      session = paymentSession();
    };
    const started = await startHarnessProvisionSession({
      serviceUrl: "https://shop.example.com/checkout",
      browser: new BrowserController({}),
      api: { auditPayment } as unknown as ApiClient,
    });
    const live = session as Session | null;
    expect(live).not.toBeNull();
    live!.secretSlots.set("slot_1", "value");
    live!.sealedFieldKeys.add("#card");
    setActivePendingThreeDs({
      approval_id: "appr_characterization",
      approval_url: "https://web.test/vault/pay/appr_characterization",
      checkout: {
        merchant: "Shop",
        checkout_origin: "https://shop.example.com",
        amount_cents: 100,
        currency: "USD",
      },
      last4: "4242",
      deadline: Date.now() + 60_000,
      outcome: "three_ds",
    });

    await finishProvisionSession(started.session_id);

    expect(h.terminalOrder).toEqual(["3ds_audit", "browser_close"]);
    expect(auditPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: "payment_3ds_unresolved" }),
    );
    // Artifacts cleared and the exact session dropped from the registry.
    expect(live!.secretSlots.size).toBe(0);
    expect(live!.sealedFieldKeys.size).toBe(0);
    expect(live!.prevObserve).toBeNull();
    expect(live!.observeSnapshotFile).toBeNull();
    expect(live!.pendingThreeDs).toBeNull();
    expect(activeSessionCount()).toBe(0);
  });
});

describe("characterization: agent-facing observation payload shapes", () => {
  beforeEach(() => {
    h.elements = SAMPLE_ELEMENTS;
    h.visibleText = "Create your account. Email. Sign up.";
  });

  it("compact-v2 operate_observe returns exactly these payload keys, first read and re-read", async () => {
    const start = await startHarnessProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      browser: new BrowserController({}),
      observationFormat: "compact-v2",
    });
    expect(start.format).toBe("compact-v2");
    expect(Object.keys(start).sort()).toEqual(FIRST_V2_KEYS);
    // V1-only fields must be ABSENT from a compact-v2 payload, never null.
    for (const legacy of ["elements", "el_table", "snapshot_file", "screen", "accessibility"]) {
      expect(Object.keys(start)).not.toContain(legacy);
    }

    const again = await observe(start.session_id);
    expect(again.format).toBe("compact-v2");
    expect(Object.keys(again).sort()).toEqual(REOBSERVE_V2_KEYS);
  });

  it("V1 compact operate_observe returns exactly these payload keys", async () => {
    const start = await startHarnessProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      browser: new BrowserController({}),
      observationFormat: "v1",
    });
    expect(start.format).toBeUndefined();
    const observation = await observe(start.session_id, "compact");
    expect(observation.session_id).toBe(start.session_id);
    expect(observation.url).toBe("https://app.example.com/signup");
    expect(Object.keys(observation).sort()).toEqual(V1_COMPACT_KEYS);
    expect(observation.safe_table).toBeUndefined();
  });

  it("V1 full operate_observe returns exactly these payload keys", async () => {
    const start = await startHarnessProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      browser: new BrowserController({}),
      observationFormat: "v1",
    });
    const observation = await observe(start.session_id, "full");
    expect(Object.keys(observation).sort()).toEqual(V1_FULL_KEYS);
    expect(observation.elements?.length ?? 0).toBeGreaterThan(0);
    expect(observation.safe_table).toBeUndefined();
  });

  it("operate_observe_query returns exactly these sealed lookup payload keys", async () => {
    const start = await startHarnessProvisionSession({
      serviceUrl: "https://app.example.com/signup",
      browser: new BrowserController({}),
      observationFormat: "compact-v2",
    });
    const result = await observeQuery(start.session_id, "sign up");
    expect(Object.keys(result).sort()).toEqual(QUERY_KEYS);
    expect(JSON.stringify(result)).not.toContain("#submit");
  });
});
