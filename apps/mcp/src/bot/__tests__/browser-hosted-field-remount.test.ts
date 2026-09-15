// Real-Chromium regression for inject_card against HOSTED-FIELD IFRAMES THAT
// REMOUNT after the first input — the Braintree checkout shape (same design
// as PayPal and Stripe Elements), which blocked the Oura Ring purchase on
// 1.1.14-rc.25 (session d67d9049) and again on rc.26 (sessions 5315edce and
// b753b224, ouraring.com Braintree checkout, 2026-09-15):
//
// #788 fixed IDENTIFYING a hosted-field input across the remount: the frame's
// URL, not the positional path, is the durable frame identity, and the write
// path re-resolves by URL when the recorded path no longer lands. With that,
// one inject_card call fills pan + cvv + exp_month + exp_year and every later
// call resolves its refs — but the ORDER STILL FAILED at submit with
// Braintree's "Verification details were not entered correctly" (the CVV was
// gone by then). What the live page showed:
//
//   - A write into any ONE card field remounts ALL the sibling card frames
//     (the hosted-fields client rebuilds every frame after the first input),
//     and a rebuilt frame reopens EMPTY — so every write after the first
//     discards the values already sitting in the other frames.
//   - capture_omissions reporting frame_binding_failed for the card frames is
//     #788 correctly refusing to bind a stale frame; a symptom, not the bug.
//
// The live page does not allow the old harness's recovery (re-filling whatever
// the remount cleared in a LATER call), because each write clears the others —
// only a fill pass that ends by re-verifying every value INSIDE the live
// frames and re-filling whatever the rebuild cleared, all within the same
// call, leaves all values present at once.
//
// Harness shape (mirrors the live failing page): the parent mounts three
// site-isolated <iframe>s on DIFFERENT registrable domains (Chromium
// site-isolation makes each an OOPIF), each child exposes its input inside an
// OPEN SHADOW ROOT, and after the first input into ANY field the parent
// replaces EVERY field <iframe> — the fresh frames reopen empty. The harness
// is instrumented to discriminate the two candidate loss mechanisms:
//
//   (a) the value is written into the input but never committed (the child
//       never sees an input event carrying it), so the client rebuilds the
//       frame from its own empty state; vs
//   (b) the child DOES commit the value, and the frame is then rebuilt.
//
// Every child input posts a `committed` message (with the value LENGTH, never
// the value) before its remount request; the parent logs both plus which
// frames it replaced into `window.__fieldLog`, which the test reads to assert
// the loss is (b).

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

type FieldLogEntry =
  | { type: "committed"; frame: string; len: number }
  | { type: "remount-request"; frame: string }
  | { type: "remounted"; frames: string[] };
type FieldLogWindow = { __fieldLog?: FieldLogEntry[] };

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
      // Instrumentation: report the commit (length only — never the value)
      // BEFORE the remount request, so the log can prove the write reached
      // this document with its full value before the frame was rebuilt.
      parent.postMessage({ committed: window.name, len: el.value.length }, "*");
      if (announced) return;
      announced = true;
      parent.postMessage({ remount: window.name }, "*");
    });
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
        // Braintree's hosted-fields client rebuilds EVERY hosted-field frame
        // after the first input into any one field — the rebuild is triggered
        // by the input event itself, and each rebuilt frame reopens EMPTY.
        // Rebuild each frame at most once per page load: the client settles
        // after that initial rebuild (later input is committed in place).
        let remounted = new Set();
        window.__fieldLog = [];
        window.addEventListener("message", (event) => {
          const data = event.data || {};
          if (data.committed !== undefined) {
            window.__fieldLog.push({ type: "committed", frame: data.committed, len: data.len });
            return;
          }
          if (!data.remount) return;
          window.__fieldLog.push({ type: "remount-request", frame: data.remount });
          const replaced = [];
          for (const frame of document.querySelectorAll("iframe[name^='braintree-hosted-field']")) {
            if (remounted.has(frame.name)) continue;
            remounted.add(frame.name);
            const replacement = frame.cloneNode();
            frame.replaceWith(replacement);
            replaced.push(frame.name);
          }
          if (replaced.length > 0) window.__fieldLog.push({ type: "remounted", frames: replaced });
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

async function frameValue(page: Page, host: string, name: string): Promise<string | null> {
  const frame: Frame | undefined = page
    .frames()
    .find((candidate) => !candidate.isDetached() && candidate.url().includes(host));
  if (frame === undefined) return null;
  return await frame
    .locator(`input[name="${name}"]`)
    .inputValue({ timeout: 3_000 })
    .catch(() => null);
}

describe("inject_card across remounting hosted-field iframes (real Chromium)", () => {
  it.skipIf(!available)(
    "leaves every written card value present in the live frames after the sibling rebuild",
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

        const rows1 = ((await observe(sessionId!, "compact")) as unknown as Record<
          string,
          unknown
        >).safe_table as Array<[string, string, string?]>;
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
          )) as {
            complete: boolean;
            fields: Record<string, { status: string }>;
          };

        // The live failing shape: ONE call carrying pan + cvv + exp_month +
        // exp_year (session 5315edce). The first write triggers the rebuild of
        // every field frame — the fresh frames reopen empty.
        const result1 = await inject({
          pan: { ref: numberRow1[0] },
          cvv: { ref: cvvRow1[0] },
          exp_month: { ref: expiryRow1[0] },
          exp_year: { ref: expiryRow1[0] },
        });

        // Call 2: name with the FIRST observation's refs (the rebuild shifted
        // every positional frame path — the frame URL, not the path, is the
        // identity, so the stale refs must still resolve).
        const result2 = await inject({ name: { ref: nameRow1[0] } });

        // THE assertion: every written value is simultaneously present in the
        // live frames. A per-field "filled" status that does not survive the
        // sibling rebuild is a lie the caller cannot detect — the values must
        // actually be there.
        expect(await frameValue(isolated.page, FRAME_HOSTS[0], "credit-card-number")).toBe(
          CARD.pan,
        );
        // The single harness expiry input receives both exp writes; exp_year
        // lands last.
        expect(await frameValue(isolated.page, FRAME_HOSTS[0], "expiry")).toBe(CARD.exp_year);
        expect(await frameValue(isolated.page, FRAME_HOSTS[1], "cvv")).toBe(CARD.cvv);
        expect(await frameValue(isolated.page, FRAME_HOSTS[2], "cardholder-name")).toBe(CARD.name);
        expect(result1.complete).toBe(true);
        expect(result2.complete).toBe(true);
        expect(result1.fields).toMatchObject({
          pan: { status: "filled" },
          cvv: { status: "filled" },
          exp_month: { status: "filled" },
          exp_year: { status: "filled" },
        });
        expect(result2.fields).toMatchObject({ name: { status: "filled" } });

        // Harness honesty: the rebuild really fired, and every field really
        // committed its full value into its document BEFORE that document was
        // rebuilt — the loss mechanism is the rebuild, not a missing commit.
        await isolated.page.waitForFunction(
          () =>
            ((window as unknown as FieldLogWindow).__fieldLog ?? []).some(
              (entry) => entry.type === "remounted" && entry.frames.length === 3,
            ),
          undefined,
          { timeout: 10_000 },
        );
        const entries = ((await isolated.page.evaluate(
          () => (window as unknown as FieldLogWindow).__fieldLog,
        )) ?? []).filter(
          (entry): entry is Extract<FieldLogEntry, { type: "committed" }> =>
            entry.type === "committed",
        );
        const committedLens = (frame: string): number[] =>
          entries.filter((entry) => entry.frame === frame).map((entry) => entry.len);
        // Frame 0 hosts the number AND expiry inputs; frame 1 the CVV; frame
        // 2 the cardholder name. Every field's full value was committed into
        // its document at least once.
        expect(committedLens("braintree-hosted-field-0")).toContain(CARD.pan.length);
        expect(committedLens("braintree-hosted-field-1")).toContain(CARD.cvv.length);
        expect(committedLens("braintree-hosted-field-2")).toContain(CARD.name.length);
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
        await isolated.context.close();
      }
    },
    120_000,
  );
});
