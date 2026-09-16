import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { BrowserController, type CheckoutCard } from "../browser.js";
import {
  finishProvisionSession,
  observe,
  paymentSession,
  startHarnessProvisionSession,
} from "../provision-session.js";

const CARD: CheckoutCard = {
  pan: "4111111111111111",
  cvv: "123",
  exp_month: "12",
  exp_year: "2030",
  name: "Synthetic Buyer",
  billing: {
    line1: "1 Test Street",
    city: "Testville",
    postal_code: "10000",
    country: "US",
  },
};

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}
let browser: Browser | undefined;
beforeAll(async () => {
  if (available) browser = await chromium.launch({ headless: true });
});
afterAll(async () => await browser?.close());

async function page(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function stubApi(): { api: ApiClient; notifyThreeDs: ReturnType<typeof vi.fn> } {
  const notifyThreeDs = vi.fn(async () => ({ sent: true }));
  return { api: { notifyThreeDs } as unknown as ApiClient, notifyThreeDs };
}

// A released card is the only state in which a 3-D Secure challenge is ours to
// report: the operator nudges the cardholder once, then keeps returning the
// fact without waiting on, blocking, or taking custody of the challenge.
async function releasedCardSession(
  isolated: { context: BrowserContext; page: Page },
  body: string,
): Promise<{ sessionId: string; notifyThreeDs: ReturnType<typeof vi.fn> }> {
  const topUrl = "https://merchant.test/checkout";
  await isolated.page.route("**/*", (route) =>
    route.request().url() === topUrl
      ? route.fulfill({ contentType: "text/html", body })
      : route.fulfill({ status: 404, body: "not found" }),
  );
  const controller = BrowserController.fromHarnessPage(isolated.page);
  const { api, notifyThreeDs } = stubApi();
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: topUrl,
    api,
  });
  paymentSession(started.session_id).releasedPaymentCard = {
    approvalId: "approval_3ds",
    approvalUrl: "https://approve.test/approval_3ds",
    checkout: {
      merchant: "Synthetic Merchant",
      checkout_origin: "https://merchant.test",
      amount_cents: 123,
      currency: "JPY",
    },
    cardRef: "card_synthetic",
    last4: "1111",
    deadline: Date.now() + 60_000,
    card: CARD,
  };
  return { sessionId: started.session_id, notifyThreeDs };
}

describe("3-D Secure detection and notification", () => {
  it.skipIf(!available)(
    "reports a rendered challenge and notifies the cardholder exactly once",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          '<div>Verify your identity to continue</div><form action="/acs/challenge"><button>Approve</button></form>',
        );
        sessionId = released.sessionId;

        const first = await observe(sessionId);
        expect(first.three_ds).toMatchObject({ state: "challenge_detected", notified: true });
        expect(released.notifyThreeDs).toHaveBeenCalledTimes(1);
        expect(released.notifyThreeDs).toHaveBeenCalledWith("approval_3ds", "detected_challenge");

        // The fact is still reported while the challenge is rendered; the nudge
        // is not repeated.
        const second = await observe(sessionId);
        expect(second.three_ds).toMatchObject({ state: "challenge_detected" });
        expect(
          second.three_ds?.state === "challenge_detected" ? second.three_ds.notified : undefined,
        ).toBeUndefined();
        expect(released.notifyThreeDs).toHaveBeenCalledTimes(1);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );

  it.skipIf(!available)("reports nothing on a checkout with no challenge", async () => {
    const isolated = await page();
    let sessionId: string | undefined;
    try {
      const released = await releasedCardSession(
        isolated,
        '<div>Pay with card</div><input name="card-number">',
      );
      sessionId = released.sessionId;

      const observed = await observe(sessionId);
      expect(observed.three_ds).toBeUndefined();
      expect(released.notifyThreeDs).not.toHaveBeenCalled();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await isolated.context.close();
    }
  });

  // A real Cardinal/Braintree failure mode (Oura, 2026-09): the ACS render
  // races the SDK's own UI-framework chunk load, loses, and the processor
  // surfaces THREEDS_CARDINAL_SDK_ERROR through the page's telemetry while the
  // rendered page shows only a generic checkout error. The observation must
  // report the transient, retryable failure — never notify (no challenge is
  // up yet) and never take over the retry.
  it.skipIf(!available)(
    "reports a Cardinal SDK challenge-launch failure as retryable, without notifying",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          "<div>Verification details were not entered correctly.</div>" +
            '<script>fetch("/log", { method: "POST", body: JSON.stringify({ "event": "3ds_verification.error", "code": "THREEDS_CARDINAL_SDK_ERROR" }) });</script>',
        );
        sessionId = released.sessionId;

        // Wait until the telemetry POST actually reached the evidence stream.
        let observed: Awaited<ReturnType<typeof observe>> | undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          observed = await observe(sessionId);
          if (observed.three_ds !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(observed?.three_ds).toMatchObject({ state: "sdk_error_retryable" });
        expect(released.notifyThreeDs).not.toHaveBeenCalled();
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );

  // A detected challenge always wins over the stale SDK-error evidence: after
  // a resubmit the challenge is live and the cardholder nudge is what matters.
  it.skipIf(!available)("prefers a rendered challenge over stale SDK-error evidence", async () => {
    const isolated = await page();
    let sessionId: string | undefined;
    try {
      const released = await releasedCardSession(
        isolated,
        '<script>fetch("/log", { method: "POST", body: JSON.stringify({ "code": "THREEDS_CARDINAL_SDK_ERROR" }) });</script>' +
          '<div>Verify your identity to continue</div><form action="/acs/challenge"><button>Approve</button></form>',
      );
      sessionId = released.sessionId;

      // The precedence decision is only exercised once the SDK-error
      // evidence has actually landed, so wait for it before observing.
      const session = paymentSession(sessionId);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (session.browser.hasThreeDsSdkErrorEvidence()) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(session.browser.hasThreeDsSdkErrorEvidence()).toBe(true);

      const observed = await observe(sessionId);
      expect(observed.three_ds).toMatchObject({ state: "challenge_detected" });
      expect(released.notifyThreeDs).toHaveBeenCalledTimes(1);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await isolated.context.close();
    }
  });

  // Once a challenge has rendered in this session, a LATER absence of one means
  // it resolved and the checkout is settling — often on the order-confirmation
  // page. The SDK-launch-failure advisory must not ride that state: telling the
  // agent to resubmit a payment that already went through is a double-purchase
  // hazard. `threeDsNotified` is the existing record that a challenge launched.
  it.skipIf(!available)(
    "suppresses the SDK-error advisory once a challenge already rendered this session",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          "<div>Thank you — your order is confirmed.</div>" +
            '<script>fetch("/log", { method: "POST", body: JSON.stringify({ "code": "THREEDS_CARDINAL_SDK_ERROR" }) });</script>',
        );
        sessionId = released.sessionId;

        const session = paymentSession(sessionId);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (session.browser.hasThreeDsSdkErrorEvidence()) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(session.browser.hasThreeDsSdkErrorEvidence()).toBe(true);

        // A challenge launched earlier and the cardholder was nudged for it.
        session.releasedPaymentCard!.threeDsNotified = true;

        const observed = await observe(sessionId);
        expect(observed.three_ds).toBeUndefined();
        expect(released.notifyThreeDs).not.toHaveBeenCalled();
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );
});
