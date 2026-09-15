// Real-Chromium regression for inject_card against HOSTED-FIELD IFRAMES THAT
// REMOUNT on the provider's own schedule — the Braintree checkout shape (same
// design as PayPal and Stripe Elements), which blocked the Oura Ring purchase
// on 1.1.14-rc.25 (session d67d9049), again on rc.26 (sessions 5315edce and
// b753b224), and five consecutive times on rc.28 (session 6dcd7859,
// 2026-09-15 12:18-12:25 UTC): every attempt resolved a DIFFERENT subset of
// card fields — exp_month/exp_year, then name, then pan/cvv/exp_month/exp_year,
// then the same again with freshly re-observed refs, then after a full reload
// name/exp_month/exp_year — and the one attempt that submitted took Oura's
// generic "something went wrong" with the card-number input carrying
// invalid=true.
//
// Three distinct defects are covered here:
//
//   1. RESOLUTION RACE. inject_card resolved every field once, up front, from
//      one shared extractInteractiveElements() snapshot, then wrote. Braintree
//      serves each box from its own cross-origin iframe and remounts those
//      frames in response to input AND to its own lifecycle, so the walk is
//      not atomic across siblings: a frame mid-remount contributes nothing,
//      the field silently drops out, and which fields make it in is a race.
//      The fix resolves each field at its OWN write step and retries a miss
//      within a bounded window; `not_found` now means "still absent after we
//      waited", and `detached` (the ref was live in the last observation, so
//      its frame is remounting) is retried rather than reported.
//
//   2. `filled` COULD BE A LIE. #792 verified a written value with
//      `actual === expected || digits(actual) === digits(expected)`, which can
//      accept a value that merely CONTAINS the intended digits. The fix
//      normalises ONLY formatting separators on BOTH sides and requires
//      equality: a reformatted card number still matches, a superset /
//      truncation / doubled value does not.
//
//   3. fill() EMITTED NO KEY EVENTS. The card writer used handle.fill(), which
//      sets the value with no keydown/keypress. A hosted-field client that
//      tracks real typing can treat that as invalid even though the DOM value
//      looks right — exactly the filled-then-invalid=true observation. The fix
//      reuses the ordinary humanized typing core (one pressSequentially call
//      with a randomised per-key delay).
//
// Harness shape (mirrors the live failing page): the parent mounts three
// site-isolated <iframe>s on DIFFERENT registrable domains (Chromium
// site-isolation makes each an OOPIF), each child exposes its input inside an
// OPEN SHADOW ROOT, and the child frames remount on their OWN schedule as well
// as on the first input into any field. The rest of the file adds a
// key-event-driven provider page (defect 3) and page-side value mutators
// (defect 2).
//
// Every child input posts a `committed` message (with the value LENGTH, never
// the value) before its remount request; the parent logs both plus which
// frames it replaced into `window.__fieldLog`, which the tests read.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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

const RUNS = 20;

type FieldLogEntry =
  | { type: "committed"; frame: string; len: number }
  | { type: "remount-request"; frame: string }
  | { type: "remounted"; frames: string[] };
type FieldLogWindow = { __fieldLog?: FieldLogEntry[] };
type StormWindow = {
  __stormStart?: (ms: number) => void;
  __stormStop?: () => void;
};

let available = false;
try {
  available = existsSync(chromium.executablePath());
} catch {
  available = false;
}

let server: Server;
let port: number;
let browser: Browser | undefined;

// Self-driven remount: the provider's client rebuilds its frame on its own
// lifecycle, independent of any input. Every child posts a remount REQUEST on
// a short jittered interval; the parent rebuilds ALL field frames only while a
// storm is active, so the siblings are detached at different instants and a
// single snapshot walk can miss whichever field's frame is mid-remount. This
// is the piece the pre-fix test did not model — remount-on-first-input alone
// cannot race a snapshot that is taken before any write.
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
      parent.postMessage({ remount: window.name, cause: "input" }, "*");
    });
  }
  // Self-driven remount requests. The parent ignores them unless a storm is
  // active; each rebuilt frame starts a fresh interval, so a storm rebuilds
  // every sibling frame repeatedly. The interval is deliberately comparable
  // to a hosted-field client's own lifecycle (~150ms), not a thundering herd —
  // enough to desynchronise the sibling frames during a snapshot walk without
  // rebuilding faster than the frames can settle.
  setInterval(() => {
    parent.postMessage({ remount: window.name, cause: "self" }, "*");
  }, 120 + Math.random() * 80);
  </script></body></html>`;

// Page-side value mutators for the defect-2 (verification) tests. Each page
// holds a single card-number input; the script alters what the field holds.
const SIMPLE_PAGES: Record<string, string> = {
  // The page keeps only the first four digits — a truncation that must never
  // report `filled`.
  truncate: `<!doctype html><html><body>
    <input id="number" name="card-number" aria-label="Card number">
    <script>
    const el = document.getElementById("number");
    el.addEventListener("input", () => {
      const digits = el.value.replace(/\\D/g, "");
      el.value = digits.slice(0, 4);
    });
    </script></body></html>`,
  // The page doubles a complete number — a superset that must never report
  // `filled`, and does so again after every re-fill, so the verdict stays.
  doubled: `<!doctype html><html><body>
    <input id="number" name="card-number" aria-label="Card number">
    <script>
    const el = document.getElementById("number");
    el.addEventListener("input", () => {
      const digits = el.value.replace(/\\D/g, "");
      if (digits.length === 16) el.value = digits + digits;
    });
    </script></body></html>`,
  // The page reformats the number with separators as you type — the legitimate
  // reason the loose comparison existed. Normalising both sides must still
  // report `filled`.
  grouped: `<!doctype html><html><body>
    <input id="number" name="card-number" aria-label="Card number">
    <script>
    const el = document.getElementById("number");
    el.addEventListener("input", () => {
      const digits = el.value.replace(/\\D/g, "");
      const grouped = digits.replace(/(.{4})(?=.)/g, "$1 ");
      if (el.value !== grouped) {
        el.value = grouped;
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    </script></body></html>`,
  // A provider client that accepts a number only when every character arrived
  // as a real key event (keydown), i.e. it tracks typing, not the DOM value.
  // fill() leaves it invalid; pressSequentially satisfies it.
  keyevents: `<!doctype html><html><body>
    <input id="number" name="card-number" aria-label="Card number">
    <script>
    const el = document.getElementById("number");
    let keys = 0;
    const evaluate = () => {
      const digits = el.value.replace(/\\D/g, "");
      const ok = digits.length === 16 && keys >= digits.length;
      el.dataset.providerInvalid = ok ? "false" : "true";
      window.__providerAccepted = ok;
    };
    el.addEventListener("keydown", () => { keys++; evaluate(); });
    el.addEventListener("input", evaluate);
    </script></body></html>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const host = (req.headers.host ?? "").split(":")[0];
    const url = req.url ?? "/";
    if (host === PARENT_HOST) {
      const mode = url.startsWith("/simple")
        ? new URL(url, `http://${PARENT_HOST}`).searchParams.get("mode")
        : null;
      if (mode !== null && SIMPLE_PAGES[mode] !== undefined) {
        res.end(SIMPLE_PAGES[mode]);
      } else {
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
          // by the input event itself, and each rebuilt frame reopens EMPTY —
          // and it also rebuilds on its own lifecycle. A self-driven storm
          // (window.__stormStart) rebuilds the siblings repeatedly so that a
          // single snapshot walk can catch one of them mid-remount.
          let remounted = new Set();
          let stormUntil = 0;
          let lastStormRebuild = 0;
          window.__stormStart = (ms) => { stormUntil = performance.now() + ms; };
          window.__stormStop = () => { stormUntil = 0; };
          window.__fieldLog = [];
          window.addEventListener("message", (event) => {
            const data = event.data || {};
            if (data.committed !== undefined) {
              window.__fieldLog.push({ type: "committed", frame: data.committed, len: data.len });
              return;
            }
            if (!data.remount) return;
            window.__fieldLog.push({ type: "remount-request", frame: data.remount });
            if (data.cause !== "input") {
              // Self-driven request: only acted on during a storm, and at most
              // one sibling-wide rebuild per settle gap so the fresh frames
              // have time to load before the next one.
              if (performance.now() >= stormUntil) return;
              if (performance.now() - lastStormRebuild < 140) return;
              lastStormRebuild = performance.now();
            } else if (remounted.has(data.remount)) {
              // The first-input rebuild fires once per frame per page load,
              // matching the pre-existing harness contract.
              return;
            }
            const replaced = [];
            for (const frame of document.querySelectorAll("iframe[name^='braintree-hosted-field']")) {
              remounted.add(frame.name);
              const replacement = frame.cloneNode();
              frame.replaceWith(replacement);
              replaced.push(frame.name);
            }
            if (replaced.length > 0) window.__fieldLog.push({ type: "remounted", frames: replaced });
          });
          </script></body></html>`,
        );
      }
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

/** Wait until all three site-isolated child frames are attached and live. */
async function waitForLiveFrames(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const live = page
      .frames()
      .filter(
        (candidate) =>
          !candidate.isDetached() && FRAME_HOSTS.some((host) => candidate.url().includes(host)),
      );
    if (live.length >= FRAME_HOSTS.length) return;
    await page.waitForTimeout(50);
  }
  throw new Error("hosted-field frames did not attach");
}

/**
 * Wait until the set of live frames stops changing, so a post-storm read sees
 * the settled frames rather than a stale copy the browser still enumerates.
 */
async function waitForStableFrames(page: Page, quietMs = 600): Promise<void> {
  const snapshot = (): string =>
    page
      .frames()
      .filter((candidate) => !candidate.isDetached())
      .map((candidate) => candidate.url())
      .join("|");
  let last = snapshot();
  let stableSince = Date.now();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = snapshot();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return;
  }
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
  const frames = page
    .frames()
    .filter((candidate) => !candidate.isDetached() && candidate.url().includes(host));
  for (const frame of frames) {
    const value = await frame
      .locator(`input[name="${name}"]`)
      .first()
      .inputValue({ timeout: 1_500 })
      .catch(() => null);
    if (value !== null) return value;
  }
  return null;
}

function releasedCard() {
  return {
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
}

const injectArgs = (sessionId: string) => ({
  session_id: sessionId,
  merchant: "Synthetic Merchant",
  amount_cents: 123,
  currency: "JPY",
  item: "Synthetic item",
  reason: "Synthetic test purchase",
  card_ref: "card_synthetic",
  approval_id: "approval_remount",
});

/** One full single-call trial: observe → storm → ONE inject_card → read back. */
async function singleCallTrial(): Promise<{ ok: boolean; detail: string }> {
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
    await waitForLiveFrames(isolated.page);

    const rows = ((await observe(sessionId, "compact")) as unknown as Record<string, unknown>)
      .safe_table as Array<[string, string, string?]>;
    const numberRow = textboxRow(rows, "card-number");
    const expiryRow = textboxRow(rows, "expiration");
    const cvvRow = textboxRow(rows, "security-code");
    const nameRow = textboxRow(rows, "name-on-card");

    paymentSession(sessionId).releasedPaymentCard = releasedCard();

    // Start the self-driven sibling-remount storm AFTER the refs are captured,
    // so this isolates the resolution race from observation.
    await isolated.page.evaluate(() => (window as unknown as StormWindow).__stormStart?.(1_200));

    // A SINGLE call carrying every field.
    const result = (await injectCardTool.handler(
      injectCardTool.inputSchema.parse({
        ...injectArgs(sessionId),
        fields: {
          pan: { ref: numberRow[0] },
          cvv: { ref: cvvRow[0] },
          exp_month: { ref: expiryRow[0] },
          exp_year: { ref: expiryRow[0] },
          name: { ref: nameRow[0] },
        },
      }),
      {} as ApiClient,
    )) as { complete: boolean; fields: Record<string, { status: string }> };

    await isolated.page.evaluate(() => (window as unknown as StormWindow).__stormStop?.());
    await waitForStableFrames(isolated.page);

    const pan = await frameValue(isolated.page, FRAME_HOSTS[0], "credit-card-number");
    const expiry = await frameValue(isolated.page, FRAME_HOSTS[0], "expiry");
    const cvv = await frameValue(isolated.page, FRAME_HOSTS[1], "cvv");
    const name = await frameValue(isolated.page, FRAME_HOSTS[2], "cardholder-name");
    const statuses = Object.entries(result.fields)
      .map(([field, value]) => `${field}=${value.status}`)
      .join(",");
    const valuesOk =
      pan === CARD.pan && expiry === CARD.exp_year && cvv === CARD.cvv && name === CARD.name;
    const statusesOk = result.complete === true;
    const ok = valuesOk && statusesOk;
    return {
      ok,
      detail: ok
        ? "pan/cvv/expiry/name all present, every status filled"
        : `values(pan=${pan},expiry=${expiry},cvv=${cvv},name=${name}) ` +
          `complete=${result.complete} statuses[${statuses}]`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (sessionId !== undefined) await finishProvisionSession(sessionId).catch(() => undefined);
    await isolated.context.close();
  }
}

/** Boot a harness session on a single-input `/simple` page. */
async function simpleSession(mode: string): Promise<{
  context: BrowserContext;
  page: Page;
  controller: BrowserController;
  sessionId: string;
}> {
  const isolated = await page();
  const pageUrl = `http://${PARENT_HOST}:${port}/simple?mode=${mode}`;
  await isolated.page.goto(pageUrl);
  await isolated.page.waitForLoadState("domcontentloaded");
  const controller = BrowserController.fromHarnessPage(isolated.page);
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: pageUrl,
    format: "full",
  });
  return { ...isolated, controller, sessionId: started.session_id };
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
        await waitForLiveFrames(isolated.page);

        // Precondition: genuinely site-isolated OOPIFs, not same-process frames.
        expect(await childrenAreSeparateTargets(isolated.page)).toBe(true);

        const rows1 = ((await observe(sessionId!, "compact")) as unknown as Record<string, unknown>)
          .safe_table as Array<[string, string, string?]>;
        const numberRow1 = textboxRow(rows1, "card-number");
        const expiryRow1 = textboxRow(rows1, "expiration");
        const cvvRow1 = textboxRow(rows1, "security-code");
        const nameRow1 = textboxRow(rows1, "name-on-card");

        paymentSession(sessionId).releasedPaymentCard = releasedCard();
        const base = injectArgs(sessionId!);
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
        const entries = (
          (await isolated.page.evaluate(() => (window as unknown as FieldLogWindow).__fieldLog)) ??
          []
        ).filter(
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

  it.skipIf(!available)(
    `fills every field in ONE call across self-driven sibling remounts (${RUNS} consecutive runs)`,
    async () => {
      const results: Array<{ ok: boolean; detail: string }> = [];
      for (let run = 0; run < RUNS; run++) {
        results.push(await singleCallTrial());
      }
      const passed = results.filter((result) => result.ok).length;
      // One green run proves nothing about a race; this is the count that does.
      console.log(`inject_card single-call across self-driven remounts: ${passed}/${RUNS} passed`);
      for (const [index, result] of results.entries()) {
        if (!result.ok) console.log(`  run ${index + 1} FAILED: ${result.detail}`);
      }
      expect({ passed, failures: results.filter((r) => !r.ok).map((r) => r.detail) }).toEqual({
        passed: RUNS,
        failures: [],
      });
    },
    900_000,
  );
});

describe("inject_card write path and verification (real Chromium)", () => {
  it.skipIf(!available)(
    "reports cleared, never filled, when the page alters the written value",
    async () => {
      const truncated = await simpleSession("truncate");
      try {
        const elements = await truncated.controller.extractInteractiveElements();
        const input = elements.find((element) => element.name === "card-number");
        if (input === undefined) throw new Error("missing card-number input");
        const results = await truncated.controller.injectCardIntoTargets(CARD, {
          pan: { element: input },
        });
        expect(results.pan.status).not.toBe("filled");
        expect(results.pan.status).toBe("cleared");
        expect(await truncated.page.locator("#number").inputValue()).toBe("4111");
      } finally {
        await finishProvisionSession(truncated.sessionId).catch(() => undefined);
        await truncated.context.close();
      }

      const doubled = await simpleSession("doubled");
      try {
        const elements = await doubled.controller.extractInteractiveElements();
        const input = elements.find((element) => element.name === "card-number");
        if (input === undefined) throw new Error("missing card-number input");
        const results = await doubled.controller.injectCardIntoTargets(CARD, {
          pan: { element: input },
        });
        expect(results.pan.status).not.toBe("filled");
        expect(results.pan.status).toBe("cleared");
      } finally {
        await finishProvisionSession(doubled.sessionId).catch(() => undefined);
        await doubled.context.close();
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    "still reports filled when the page only reformats the number with separators",
    async () => {
      const grouped = await simpleSession("grouped");
      try {
        const elements = await grouped.controller.extractInteractiveElements();
        const input = elements.find((element) => element.name === "card-number");
        if (input === undefined) throw new Error("missing card-number input");
        const results = await grouped.controller.injectCardIntoTargets(CARD, {
          pan: { element: input },
        });
        expect(results.pan.status).toBe("filled");
        expect(await grouped.page.locator("#number").inputValue()).toBe("4111 1111 1111 1111");
      } finally {
        await finishProvisionSession(grouped.sessionId).catch(() => undefined);
        await grouped.context.close();
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    "types real key events, so a key-event-driven provider accepts the number",
    async () => {
      // Measurement, not assumption: a one-shot fill() sets the value with no
      // keydown, and this provider client marks that invalid even though the
      // DOM value is correct.
      const filled = await simpleSession("keyevents");
      try {
        const input = filled.page.locator("#number");
        await input.fill(CARD.pan);
        expect(await input.getAttribute("data-provider-invalid")).toBe("true");
        // A real key-by-key write is accepted.
        await input.fill("");
        await input.pressSequentially(CARD.pan, { delay: 1 });
        expect(await input.getAttribute("data-provider-invalid")).toBe("false");
      } finally {
        await finishProvisionSession(filled.sessionId).catch(() => undefined);
        await filled.context.close();
      }

      // The card write path itself must leave the provider accepting the value.
      const typed = await simpleSession("keyevents");
      try {
        const elements = await typed.controller.extractInteractiveElements();
        const input = elements.find((element) => element.name === "card-number");
        if (input === undefined) throw new Error("missing card-number input");
        const results = await typed.controller.injectCardIntoTargets(CARD, {
          pan: { element: input },
        });
        expect(results.pan.status).toBe("filled");
        expect(await typed.page.locator("#number").getAttribute("data-provider-invalid")).toBe(
          "false",
        );
        expect(await typed.page.locator("#number").inputValue()).toBe(CARD.pan);
      } finally {
        await finishProvisionSession(typed.sessionId).catch(() => undefined);
        await typed.context.close();
      }
    },
    120_000,
  );
});
