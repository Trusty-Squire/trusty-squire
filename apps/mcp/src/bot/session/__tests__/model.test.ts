// Phase 1: createSession is the SINGLE construction contract that replaced the
// two near-identical initializers in operate_start and the harness start. These
// assertions pin the construction itself; session-characterization.test.ts
// independently pins that both live starts still produce the same object.
import { describe, it, expect } from "vitest";
import type { BrowserController } from "../../browser.js";
// The facade must keep re-exporting Session: `SessionViaFacade` below is a
// compile-time assertion that no caller's import had to change.
import type { Session as SessionViaFacade } from "../../provision-session.js";
import { createSession, type CreateSessionInput, type Session } from "../model.js";

const browser = { id: "fake-controller" } as unknown as BrowserController;

function input(over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: "session-1",
    browser,
    allowedHosts: [{ host: "app.example.com", source: "start" }],
    compactV2Mode: "on",
    startUrl: "https://app.example.com/signup",
    hintServed: false,
    consentInboxRead: false,
    userEmail: null,
    ...over,
  };
}

describe("createSession", () => {
  it("builds every field of a fresh session exactly once", () => {
    const before = Date.now();
    const session = createSession(input());
    const after = Date.now();

    expect(session.id).toBe("session-1");
    expect(session.browser).toBe(browser);
    expect(session.allowedHosts).toEqual([{ host: "app.example.com", source: "start" }]);
    expect(session.generation).toBe(0);
    expect(session.startUrl).toBe("https://app.example.com/signup");
    expect(session.compactV2Mode).toBe("on");
    expect(session.hintServed).toBe(false);
    expect(session.consentInboxRead).toBe(false);
    expect(session.userEmail).toBeNull();

    // Every collection starts empty and is this session's own instance.
    for (const collection of [
      session.secretSlots,
      session.compactV2Refs,
      session.committedSelectValues,
      session.cartAdds,
      session.cartAddsByIdempotencyKey,
      session.cartUrls,
    ]) {
      expect(collection).toBeInstanceOf(Map);
      expect(collection.size).toBe(0);
    }
    for (const collection of [
      session.callDrainWaiters,
      session.paymentCallDrainWaiters,
    ]) {
      expect(collection).toBeInstanceOf(Set);
      expect(collection.size).toBe(0);
    }
    for (const list of [
      session.lastElements,
      session.compactV2HintPages,
      session.actionTrace,
      session.recordedValues,
      session.captureRounds,
    ]) {
      expect(list).toEqual([]);
    }

    // Every overlay starts unset — no payment, replay, cart or teardown state.
    expect(session.prevObserve).toBeNull();
    expect(session.observeSnapshotFile).toBeNull();
    expect(session.compactV2Index).toBeNull();
    expect(session.compactV2Previous).toBeNull();
    expect(session.recipeRejectionReason).toBeNull();
    expect(session.replayState).toBeNull();
    expect(session.activePayment).toBeNull();
    expect(session.pendingThreeDs).toBeNull();
    expect(session.paymentDispatchHandoff).toBeNull();
    expect(session.placeOrderApproval).toBeNull();
    expect(session.lastCartCheckout).toBeNull();
    expect(session.lastCartMutation).toBeNull();
    expect(session.watchdog).toBeNull();
    expect(session.terminalTeardownOwner).toBeNull();

    expect(session.compactV2Active).toBe(false);
    expect(session.usedLocatorFallback).toBe(false);
    expect(session.paymentFieldSealActive).toBe(false);
    expect(session.placeOrderAttempted).toBe(false);
    expect(session.paymentDispatchClosed).toBe(false);
    expect(session.closing).toBe(false);
    expect(session.initializing).toBe(true);
    expect(session.callCount).toBe(0);
    expect(session.paymentCallCount).toBe(0);

    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.startedAt).toBeLessThanOrEqual(after);
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(session.lastActivityAt).toBeLessThanOrEqual(after);
  });

  it("mints an independent random 32-byte compact-v2 secret per session", () => {
    const first = createSession(input({ id: "a" }));
    const second = createSession(input({ id: "b" }));
    expect(first.compactV2Secret).toHaveLength(32);
    expect(second.compactV2Secret).toHaveLength(32);
    expect(first.compactV2Secret.equals(second.compactV2Secret)).toBe(false);
  });

  it("gives each session its own collection instances", () => {
    const first = createSession(input({ id: "a" }));
    const second = createSession(input({ id: "b" }));
    first.secretSlots.set("slot", "value");
    first.actionTrace.push({} as never);
    expect(second.secretSlots.size).toBe(0);
    expect(second.actionTrace).toEqual([]);
  });

  it("omits `api` entirely when no client was threaded through", () => {
    const withoutApi = createSession(input());
    expect(Object.keys(withoutApi)).not.toContain("api");
    expect("api" in withoutApi).toBe(false);

    const api = { marker: "api-client" } as never;
    const withApi = createSession(input({ api }));
    expect(Object.keys(withApi)).toContain("api");
    expect(withApi.api).toBe(api);
  });

  it("carries the harness start's differing inputs without changing anything else", () => {
    const harness = createSession(
      input({
        compactV2Mode: "off",
        startUrl: "https://shop.example.com/cart",
        hintServed: true,
        consentInboxRead: false,
        userEmail: null,
      }),
    );
    const normal = createSession(input({ consentInboxRead: true, userEmail: "u@example.com" }));

    expect(harness.compactV2Mode).toBe("off");
    expect(harness.hintServed).toBe(true);
    expect(normal.consentInboxRead).toBe(true);
    expect(normal.userEmail).toBe("u@example.com");
    // The two differ ONLY on the declared inputs.
    const varying = new Set([
      "compactV2Mode",
      "startUrl",
      "hintServed",
      "consentInboxRead",
      "userEmail",
      "compactV2Secret",
      "startedAt",
      "lastActivityAt",
    ]);
    for (const key of Object.keys(harness) as Array<keyof Session>) {
      if (varying.has(key)) continue;
      expect([key, JSON.stringify(harness[key])]).toEqual([key, JSON.stringify(normal[key])]);
    }
  });

  it("still satisfies the Session type re-exported from the facade", () => {
    const viaFacade: SessionViaFacade = createSession(input());
    expect(viaFacade.id).toBe("session-1");
  });
});
