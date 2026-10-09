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

function stubApi(): {
  api: ApiClient;
  notifyThreeDs: ReturnType<typeof vi.fn>;
  auditPayment: ReturnType<typeof vi.fn>;
} {
  const notifyThreeDs = vi.fn(async () => ({ sent: true }));
  const auditPayment = vi.fn(async () => ({ id: "audit_1" }));
  return {
    api: { notifyThreeDs, auditPayment } as unknown as ApiClient,
    notifyThreeDs,
    auditPayment,
  };
}

// A released card is the only state in which a 3-D Secure challenge is ours to
// report: the operator nudges the cardholder once, then keeps returning the
// fact without waiting on, blocking, or taking custody of the challenge.
async function releasedCardSession(
  isolated: { context: BrowserContext; page: Page },
  body: string,
): Promise<{
  sessionId: string;
  notifyThreeDs: ReturnType<typeof vi.fn>;
  auditPayment: ReturnType<typeof vi.fn>;
}> {
  const topUrl = "https://merchant.test/checkout";
  await isolated.page.route("**/*", (route) =>
    route.request().url() === topUrl
      ? route.fulfill({ contentType: "text/html", body })
      : route.fulfill({ status: 404, body: "not found" }),
  );
  const controller = BrowserController.fromHarnessPage(isolated.page);
  const { api, notifyThreeDs, auditPayment } = stubApi();
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
  return { sessionId: started.session_id, notifyThreeDs, auditPayment };
}

describe("3-D Secure detection and notification", () => {
  it.skipIf(!available)("records a confirmed order once after a flat checkout click", async () => {
    const isolated = await page();
    let sessionId: string | undefined;
    try {
      const released = await releasedCardSession(
        isolated,
        '<button id="pay" onclick="document.body.innerHTML = \'<h1>Your order is confirmed</h1>\'">Pay now</button>',
      );
      sessionId = released.sessionId;
      await isolated.page.locator("#pay").click();
      expect((await observe(sessionId)).three_ds).toMatchObject({
        state: "merchant_order_confirmed",
      });
      expect((await observe(sessionId)).three_ds).toMatchObject({
        state: "merchant_order_confirmed",
      });
      expect(released.auditPayment).toHaveBeenCalledTimes(1);
      expect(released.auditPayment).toHaveBeenCalledWith({
        merchant: "Synthetic Merchant",
        amount_cents: 123,
        currency: "JPY",
        last4: "1111",
        status: "merchant_order_confirmed",
        card_ref: "card_synthetic",
        approval_id: "approval_3ds",
      });
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await isolated.context.close();
    }
  });

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
        expect(first.three_ds?.state === "challenge_detected" && first.three_ds.hint).toContain(
          "Do not click, type, navigate, reload, resubmit, or trigger another verification",
        );
        expect(first.three_ds?.state === "challenge_detected" && first.three_ds.hint).toContain(
          "operate_screenshot or operate_observe (short, non-blocking checks)",
        );
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

  it.skipIf(!available)(
    "does not call a generic verification error authentication failure",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          "<div>Verification details were not entered correctly. Please try again.</div>",
        );
        sessionId = released.sessionId;
        expect((await observe(sessionId)).three_ds).toBeUndefined();
        expect(released.notifyThreeDs).not.toHaveBeenCalled();
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );

  // A real Cardinal/Braintree failure mode (Oura, 2026-09): the ACS render
  // races the SDK's own UI-framework chunk load, loses, and the processor
  // surfaces THREEDS_CARDINAL_SDK_ERROR through the page's telemetry while the
  // rendered page shows only a generic checkout error. The observation must
  // report the transient, retryable failure — never notify (no challenge is
  // up yet) and never take over the retry.
  // These tests poll for page telemetry evidence at 250ms cadence for up to
  // 5s before observing, on top of real Chromium context/session work — the
  // poll alone can consume vitest's default 5000ms budget under runner load.
  // An explicit budget keeps the assertions intact without the lottery.
  const evidencePollTimeoutMs = 30_000;

  // The injected telemetry must survive a race with the evidence collector's
  // own attachment: the harness controller attaches its CDP Network capture
  // asynchronously around the navigation, so a SINGLE document-parse POST can
  // fire before capture is live and be missed permanently — the latch would
  // never arm and every poll would observe undefined. Re-emitting on an
  // interval makes the synthetic evidence reach the stream reliably; the
  // assertions about the retryable outcome are unchanged.
  const sdkErrorTelemetryScript = (payload: string): string =>
    "<script>" +
    `const emit = () => fetch("/log", { method: "POST", body: JSON.stringify(${payload}) });` +
    "emit(); setInterval(emit, 250);" +
    "</script>";

  it.skipIf(!available)(
    "reports a Cardinal SDK challenge-launch failure as retryable, without notifying",
    { timeout: evidencePollTimeoutMs },
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          "<div>Verification details were not entered correctly.</div><button disabled>Place Order</button>" +
            sdkErrorTelemetryScript(
              '{ "event": "3ds_verification.error", "code": "THREEDS_CARDINAL_SDK_ERROR" }',
            ),
        );
        sessionId = released.sessionId;

        // Wait until the telemetry POST actually reached the evidence stream.
        let observed: Awaited<ReturnType<typeof observe>> | undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          observed = await observe(sessionId);
          if (observed.three_ds !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(observed?.three_ds).toMatchObject({
          state: "sdk_error_retryable",
          submit_enabled: false,
          reason: expect.stringMatching(/re-arm.*existing approval/i),
          evidence: {
            code: "THREEDS_CARDINAL_SDK_ERROR",
            source: "network_request_body",
            observed_at: expect.any(Number),
          },
        });
        expect(
          observed?.three_ds?.state === "sdk_error_retryable" ? observed.three_ds.reason : "",
        ).not.toContain("Resubmit the payment with ordinary actions");
        await isolated.page.getByRole("button", { name: "Place Order" }).evaluate((button) => {
          (button as HTMLButtonElement).disabled = false;
        });
        const ready = await observe(sessionId);
        expect(ready.three_ds).toMatchObject({
          state: "sdk_error_retryable",
          submit_enabled: true,
          reason: expect.stringContaining("Resubmit the payment with ordinary actions"),
        });
        expect(released.notifyThreeDs).not.toHaveBeenCalled();
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );

  // A detected challenge always wins over the stale SDK-error evidence: after
  // a resubmit the challenge is live and the cardholder nudge is what matters.
  it.skipIf(!available)(
    "prefers a rendered challenge over stale SDK-error evidence",
    { timeout: evidencePollTimeoutMs },
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          sdkErrorTelemetryScript('{ "code": "THREEDS_CARDINAL_SDK_ERROR" }') +
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
    },
  );

  // Once a challenge has rendered in this session, a LATER absence of one means
  // it resolved and the checkout is settling — often on the order-confirmation
  // page. The SDK-launch-failure advisory must not ride that state: telling the
  // agent to resubmit a payment that already went through is a double-purchase
  // hazard. `threeDsNotified` is the existing record that a challenge launched.
  it.skipIf(!available)(
    "suppresses the SDK-error advisory once a challenge already rendered this session",
    { timeout: evidencePollTimeoutMs },
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const released = await releasedCardSession(
          isolated,
          "<div>Thank you — your order is confirmed.</div>" +
            sdkErrorTelemetryScript('{ "code": "THREEDS_CARDINAL_SDK_ERROR" }'),
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
        expect(observed.three_ds).toMatchObject({
          state: "merchant_order_confirmed",
          evidence: { source: "page_text", observed_at: expect.any(Number) },
        });
        expect(released.notifyThreeDs).not.toHaveBeenCalled();
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
  );

  it.skipIf(!available)("distinguishes challenge loading from cardholder approval", async () => {
    const isolated = await page();
    let sessionId: string | undefined;
    try {
      const released = await releasedCardSession(
        isolated,
        '<iframe src="/acs/challenge" title="Bank frame"></iframe>',
      );
      sessionId = released.sessionId;
      await expect.poll(() => isolated.page.frames().length).toBe(2);
      const observed = await observe(sessionId);
      expect(observed.three_ds).toMatchObject({ state: "challenge_loading" });
      expect(released.notifyThreeDs).not.toHaveBeenCalled();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await isolated.context.close();
    }
  });

  it.skipIf(!available).each([
    ["3-D Secure authentication failed. Please try again.", "authentication_failed"],
    ["3-D Secure authentication successful.", "authentication_succeeded"],
  ] as const)("reports explicit %s page outcome", async (body, state) => {
    const isolated = await page();
    let sessionId: string | undefined;
    try {
      const released = await releasedCardSession(isolated, `<div>${body}</div>`);
      sessionId = released.sessionId;
      expect((await observe(sessionId)).three_ds).toMatchObject({
        state,
        evidence: { source: "page_text", observed_at: expect.any(Number) },
      });
      expect(released.notifyThreeDs).not.toHaveBeenCalled();
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
      await isolated.context.close();
    }
  });
});
