// Real-browser regression for LIVE #6 (Whitejade): a Shopify checkout parks
// "Pay now" below the fold, so the drive must still offer it and the act path
// must scroll to it and click; a checkout that genuinely carries no submit
// control must stop naming what it saw instead of clicking a substitute. Jev
// is mocked; the browser, the snapshot, and the act path are real.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import type { JevCallOutcome } from "../jev-client.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

const VIEWPORT = { width: 1280, height: 720 };
// Whitejade's live "Pay now" sat at top≈1458 in a 720px viewport.
const PAY_TOP_PX = 1458;
const CHECKOUT_PATH = "/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/en-us";
const PROCESSING_PATH = "/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/processing";

function payButton(label: string): string {
  return `<button type="button" id="pay" style="position:absolute;top:${PAY_TOP_PX}px"
  onclick="document.querySelector('#status').textContent='order placed';location.href='${PROCESSING_PATH}'"
  >${label}</button>`;
}

function checkoutHtml(submit: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<main style="min-height:2200px;position:relative">
  <h1>Checkout</h1>
  <p id="status">idle</p>
  <a id="back" href="#back" onclick="document.querySelector('#status').textContent='went back'">Back to finalize order</a>
  ${submit}
</main>`;
}

const PROCESSING_HTML = `<!doctype html><meta charset="utf-8"><title>Processing</title>
<main><h1>Your order is being processed</h1><p id="status">order placed</p></main>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

function api(): ApiClient {
  return { useCredential: vi.fn() } as unknown as ApiClient;
}

const EVIDENCE = process.env.DRIVE_EVIDENCE_DIR;
async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (EVIDENCE === undefined || EVIDENCE === "") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage });
}

/** Jev stand-in: takes the CLICK target whose offered text names `prefer`. */
function jevPreferring(prefer: string, seen: unknown[]) {
  return async (
    _api: unknown,
    _state: unknown,
    questions: Record<string, { type?: string; criteria?: Record<string, string> }>,
  ): Promise<JevCallOutcome> => {
    seen.push(questions);
    const clicks = questions.CLICK_target?.criteria ?? {};
    const wanted = Object.entries(clicks).find(([, text]) =>
      text.toLowerCase().includes(prefer.toLowerCase()),
    )?.[0];
    const answers: Record<
      string,
      { choice: string; confidence: number; probabilities: Record<string, number> }
    > = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question.criteria === undefined) continue;
      const keys = Object.keys(question.criteria);
      const choice =
        name === "operation"
          ? wanted === undefined
            ? "DONE"
            : "CLICK"
          : name === "CLICK_target" && wanted !== undefined
            ? wanted
            : (keys[0] ?? "none");
      answers[name] = { choice, confidence: 0.95, probabilities: peaked(keys, choice) };
    }
    return { attempts: 1, elapsedMs: 5, result: { answers } };
  };
}

function peaked(ids: string[], pick: string, peak = 0.95): Record<string, number> {
  const out: Record<string, number> = {};
  if (ids.length <= 1) {
    if (ids[0] !== undefined) out[ids[0]] = 1;
    return out;
  }
  const rest = (1 - peak) / (ids.length - 1);
  for (const id of ids) out[id] = id === pick ? peak : rest;
  return out;
}

function deps(ask: DriveDependencies["askJev"]): DriveDependencies {
  return {
    askJev: ask,
    act,
    observe,
    startSession: async () => {
      throw new Error("fixture uses an existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
}

async function openCheckout(html: string, path: string) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const url = `https://whitejade.xyz${path}`;
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: new URL(route.request().url()).pathname === PROCESSING_PATH ? PROCESSING_HTML : html,
    }),
  );
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
  });
  const session = sessionForCall(started.session_id)!;
  // The captain already signed and inject_card already landed: the card is
  // released and only the submit remains.
  session.releasedPaymentCard = {
    approvalId: "approved",
    approvalUrl: "https://approval.test",
    checkout: {
      merchant: "whitejade.xyz",
      checkout_origin: "https://whitejade.xyz",
      amount_cents: 6800,
      currency: "USD",
    },
    cardRef: "card-1",
    last4: "1111",
    deadline: Date.now() + 60_000,
    card: {
      pan: "4111111111111111",
      cvv: "739",
      exp_month: "12",
      exp_year: "2030",
      name: "Ada Lovelace",
      billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
    },
  };
  return { context, page, started };
}

describe("checkout pay-submit reachability (real browser)", () => {
  it("offers and clicks an offscreen Pay now on a checkout", async () => {
    const { context, page, started } = await openCheckout(
      checkoutHtml(payButton("Pay now")),
      CHECKOUT_PATH,
    );
    try {
      const box = await page.locator("#pay").boundingBox();
      // Precondition: the submit sits below the fold, exactly as LIVE #6 found it.
      expect(box?.y ?? 0).toBeGreaterThan(VIEWPORT.height);
      await shoot(page, "01-pay-now-below-the-fold", true);
      const asked: unknown[] = [];
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "pay for the order with the saved card",
          facts: { card_ref: "card-1", merchant: "whitejade.xyz" },
          max_steps: 6,
        },
        api(),
        undefined,
        deps(jevPreferring("Pay now", asked)),
      );
      expect(JSON.stringify(asked)).toContain("Pay now");
      expect(page.url()).toContain(PROCESSING_PATH);
      expect(await page.locator("#status").textContent()).toBe("order placed");
      expect(result.status).not.toBe("stuck");
      await shoot(page, "02-pay-now-order-processing");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("offers an offscreen localized submit without reporting it missing", async () => {
    const { context, page, started } = await openCheckout(
      checkoutHtml(payButton("Payer maintenant")),
      "/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/fr",
    );
    try {
      const asked: unknown[] = [];
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "payer la commande avec la carte enregistree",
          facts: { card_ref: "card-1", merchant: "whitejade.xyz" },
          max_steps: 6,
        },
        api(),
        undefined,
        deps(jevPreferring("Payer maintenant", asked)),
      );
      expect(JSON.stringify(asked)).toContain("Payer maintenant");
      expect(result.status).not.toBe("stuck");
      expect(page.url()).toContain(PROCESSING_PATH);
      await shoot(page, "03-payer-maintenant-order-processing");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("stops naming what it saw instead of clicking Back to finalize order", async () => {
    const { context, page, started } = await openCheckout(checkoutHtml(""), CHECKOUT_PATH);
    try {
      const asked: unknown[] = [];
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "pay for the order with the saved card",
          facts: { card_ref: "card-1", merchant: "whitejade.xyz" },
          max_steps: 12,
        },
        api(),
        undefined,
        deps(jevPreferring("Back to finalize order", asked)),
      );
      expect(result.status).toBe("stuck");
      expect(result.reason).toContain(
        "the control for this operation is not present (CLICK pay/place-order)",
      );
      expect(result.reason).toContain("Back to finalize order");
      // The substitute was never offered to the planner, so it cannot be clicked.
      expect(asked).toEqual([]);
      expect(await page.locator("#status").textContent()).toBe("idle");
      await shoot(page, "04-missing-pay-control-stuck");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("never offers an offscreen Buy now away from a checkout", async () => {
    const { context, page, started } = await openCheckout(
      checkoutHtml(payButton("Buy now")),
      "/products/the-recovery-creme",
    );
    try {
      const asked: unknown[] = [];
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "read the product page",
          facts: { card_ref: "card-1", merchant: "whitejade.xyz" },
          max_steps: 4,
        },
        api(),
        undefined,
        deps(jevPreferring("Buy now", asked)),
      );
      expect(asked.length).toBeGreaterThan(0);
      expect(JSON.stringify(asked)).not.toContain("Buy now");
      expect(await page.locator("#status").textContent()).toBe("idle");
      expect(result.status).not.toBe("stuck");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);
});
