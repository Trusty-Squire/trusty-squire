// Real-Chromium regression for inject_card against HOSTED-FIELD IFRAMES THAT
// REMOUNT after the first input — the Braintree checkout shape (same design
// as PayPal and Stripe Elements), which blocked the Oura Ring purchase on
// 1.1.14-rc.25 (session d67d9049, ouraring.com Braintree checkout):
//
// Braintree's hosted-fields client remounts each card <iframe> after the
// first input event. Playwright appends the replacement frame to the parent's
// childFrames() list, so every POSITIONAL frame path shifts. Two consequences
// shipped as "at most one productive inject_card call per page load":
//
//   1. The @e: ref identity folded the positional framePath in, so the
//      remount re-minted every framed field's identity and later inject_card
//      calls resolved even freshly observed refs to not_found.
//   2. The write path resolved the frame by the recorded positional path, so
//      a stale path failed the origin check (or matched a shifted sibling).
//
// The frame's URL is the durable frame identity: a remount keeps the iframe's
// src. Identity now hashes the frame URL (never the positional path), and
// resolveFrameElement re-resolves by URL at write time when the positional
// path no longer lands.
//
// Harness shape (mirrors the live failing page): the parent mounts three
// site-isolated <iframe>s on DIFFERENT registrable domains (Chromium
// site-isolation makes each an OOPIF), each child exposes its input inside an
// OPEN SHADOW ROOT, and the parent replaces an <iframe> element after the
// first input inside it. The remount also CLEARS what was already entered —
// so completing the checkout means re-filling cleared fields after the
// remount, exactly what the live operator had to do.
//
// #772's cross-origin regression served the child from a second localhost
// PORT — same site, same process — so it never exercised the OOPIF path.
// This file maps four different registrable domains to loopback over a real
// local HTTP server, asserts each child really is a separate CDP target
// first, and only then trusts the result.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { injectCardTool } from "../../tools/inject-card.js";
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

const PARENT_HOST = "example.com";
// Three DIFFERENT registrable domains (none shares an eTLD+1 with the parent
// or with each other) — like braintree-hosted-field-number/-cvv/-cardholderName.
const FRAME_HOSTS = ["example.org", "example.net", "example.edu"] as const;
// iframe 0: number + expiry, iframe 1: cvv, iframe 2: cardholder name.

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let server: Server;
let port: number;
let browser: Browser | undefined;

const childPage = (fields: Array<{ name: string; label: string }>): string =>
  `<!doctype html><html><body><script>
  const root = document.body.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  ${fields
    .map(
      (f) =>
        `const ${f.name.replace(/[^a-z]/g, "")} = document.createElement("input"); ` +
        `${f.name.replace(/[^a-z]/g, "")}.name = "${f.name}"; ` +
        `${f.name.replace(/[^a-z]/g, "")}.ariaLabel = "${f.label}"; ` +
        `${f.name.replace(/[^a-z]/g, "")}.placeholder = "${f.label}"; ` +
        `inner.appendChild(${f.name.replace(/[^a-z]/g, "")});`,
    )
    .join("\n  ")}
  root.appendChild(inner);
  let announced = false;
  for (const el of inner.querySelectorAll("input")) {
    el.addEventListener("input", () => {
      if (!announced) { announced = true; parent.postMessage({ remount: window.name }, "*"); }
    }, { once: true });
  }
  </script></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const host = (req.headers.host ?? "").split(":")[0];
    if (host === PARENT_HOST) {
      res.end(
        `<!doctype html><html><body><main>Checkout</main>
        ${FRAME_HOSTS.map(
          (host, i) =>
            `<iframe name="braintree-hosted-field-${i}" src="http://${host}:${port}/frame${i}" ` +
            'style="width:320px;height:60px;border:0"></iframe>',
        ).join("\n")}
        <script>
        // Braintree's hosted-fields client remounts the <iframe> after the
        // first input. Replacing the element makes Chromium swap the frame
        // out and back in under the same src.
        let remounted = new Set();
        window.addEventListener("message", (event) => {
          const name = event.data && event.data.remount;
          if (!name || remounted.has(name)) return;
          remounted.add(name);
          const frame = document.querySelector('iframe[name="' + name + '"]');
          if (frame) { const replacement = frame.cloneNode(); frame.replaceWith(replacement); }
        });
        </script></body></html>`,
      );
    } else if (host === FRAME_HOSTS[0]) {
      res.end(
        childPage([
          { name: "credit-card-number", label: "Card number" },
          { name: "expiry", label: "Expiration" },
        ]),
      );
    } else if (host === FRAME_HOSTS[1]) {
      res.end(childPage([{ name: "cvv", label: "Security code" }]));
    } else if (host === FRAME_HOSTS[2]) {
      res.end(childPage([{ name: "cardholder-name", label: "Name on card" }]));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  if (available) {
    browser = await chromium.launch({
      headless: true,
      // Force site isolation: production Chrome site-isolates cross-site
      // frames (hosted card fields are a different SITE, hence a different
      // process — a real OOPIF); Playwright's bundled Chromium needs the flag.
      args: [
        "--site-per-process",
        `--host-resolver-rules=MAP ${PARENT_HOST} 127.0.0.1,${FRAME_HOSTS.map(
          (h) => `MAP ${h} 127.0.0.1`,
        ).join(",")}`,
      ],
    });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function page(): Promise<{ context: BrowserContext; page: Page }> {
  if (browser === undefined) throw new Error("Chromium unavailable");
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Every child frame's own CDP target exists — i.e. they really are OOPIFs. */
async function childrenAreSeparateTargets(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const client = await page.context().newCDPSession(page);
    try {
      const targets = await client.send("Target.getTargets");
      if (
        FRAME_HOSTS.every((host) =>
          targets.targetInfos.some(
            (target) => target.type === "iframe" && target.url.includes(host),
          ),
        )
      )
        return true;
    } finally {
      await client.detach().catch(() => undefined);
    }
    await page.waitForTimeout(100);
  }
  return false;
}

function textboxRow(
  rows: Array<[string, string, string?]>,
  label: string,
): [string, string, string?] {
  const row = rows.find(
    (candidate) => candidate[1] === "t" && (candidate[2] ?? "").includes(`@${label}`),
  );
  if (row === undefined) throw new Error(`compact map is missing textbox ${label}`);
  return row;
}

async function frameValue(frame: Frame, name: string): Promise<string | null> {
  return await frame
    .locator(`input[name="${name}"]`)
    .inputValue({ timeout: 3_000 })
    .catch(() => null);
}

describe("inject_card across remounting hosted-field iframes (real Chromium)", () => {
  it.skipIf(!available)(
    "fills all card fields across remounts with re-observed refs",
    async () => {
      const isolated = await page();
      let sessionId: string | undefined;
      try {
        const topUrl = `http://${PARENT_HOST}:${port}/checkout`;
        const controller = BrowserController.fromHarnessPage(isolated.page);
        const started = await startHarnessProvisionSession({
          browser: controller,
          serviceUrl: topUrl,
          format: "compact",
        });
        sessionId = started.session_id;

        // Precondition: genuinely site-isolated OOPIFs, not same-process frames.
        expect(await childrenAreSeparateTargets(isolated.page)).toBe(true);

        const rowsOf = async (): Promise<Array<[string, string, string?]>> => {
          const compact = (await observe(sessionId!, "compact")) as unknown as Record<
            string,
            unknown
          >;
          return compact.safe_table as Array<[string, string, string?]>;
        };

        const rows1 = await rowsOf();
        const numberRow1 = textboxRow(rows1, "card-number");
        const expiryRow1 = textboxRow(rows1, "expiration");
        const cvvRow1 = textboxRow(rows1, "security-code");
        const nameRow1 = textboxRow(rows1, "name-on-card");

        paymentSession(sessionId).releasedPaymentCard = {
          approvalId: "approval_remount",
          approvalUrl: "https://approve.test/approval_remount",
          checkout: {
            merchant: "Synthetic Merchant",
            checkout_origin: `http://${PARENT_HOST}:${port}`,
            amount_cents: 123,
            currency: "JPY",
          },
          cardRef: "card_synthetic",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card: CARD,
        };
        const base = {
          session_id: sessionId,
          merchant: "Synthetic Merchant",
          amount_cents: 123,
          currency: "JPY",
          item: "Synthetic item",
          reason: "Synthetic test purchase",
          card_ref: "card_synthetic",
          approval_id: "approval_remount",
        };
        const inject = async (fields: Record<string, { ref: string }>) =>
          (await injectCardTool.handler(
            injectCardTool.inputSchema.parse({ ...base, fields }),
            {} as ApiClient,
          )) as { fields: Record<string, { status: string }> };

        // Call 1: cvv + expiry. The FIRST write triggers the remount of that
        // field's iframe — the live failing shape.
        const result1 = await inject({
          cvv: { ref: cvvRow1[0] },
          exp_month: { ref: expiryRow1[0] },
        });
        expect(result1.fields).toMatchObject({
          cvv: { status: "filled" },
          exp_month: { status: "filled" },
        });

        // Call 2: pan + name with the FIRST observation's refs. Before the
        // fix this returned not_found for every field: the remount shifted
        // the positional frame path folded into the ref identity.
        const result2 = await inject({
          pan: { ref: numberRow1[0] },
          name: { ref: nameRow1[0] },
        });
        expect(result2.fields).toMatchObject({
          pan: { status: "filled" },
          name: { status: "filled" },
        });

        // The remounts cleared the earlier fields (a fresh iframe reloads) —
        // the live operator must re-fill them. Refs from observation 1 still
        // resolve: the frame URL, not the positional path, is the identity.
        const result3 = await inject({
          cvv: { ref: cvvRow1[0] },
          exp_month: { ref: expiryRow1[0] },
          exp_year: { ref: expiryRow1[0] },
          name: { ref: nameRow1[0] },
        });
        expect(result3.fields).toMatchObject({
          cvv: { status: "filled" },
          exp_month: { status: "filled" },
          exp_year: { status: "filled" },
          name: { status: "filled" },
        });

        // Every field holds its value in the live (post-remount) frames.
        const frameByHost = (host: string): Frame =>
          isolated.page.frames().find((candidate) => candidate.url().includes(host))!;
        expect(await frameValue(frameByHost(FRAME_HOSTS[0]), "credit-card-number")).toBe(
          CARD.pan,
        );
        // The single harness expiry input receives both exp writes; exp_year
        // lands last.
        expect(await frameValue(frameByHost(FRAME_HOSTS[0]), "expiry")).toBe(CARD.exp_year);
        expect(await frameValue(frameByHost(FRAME_HOSTS[1]), "cvv")).toBe(CARD.cvv);
        expect(await frameValue(frameByHost(FRAME_HOSTS[2]), "cardholder-name")).toBe(CARD.name);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );
});
