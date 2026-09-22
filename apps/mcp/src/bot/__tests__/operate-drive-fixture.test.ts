// Real-browser fixture for operate_drive: a multi-step signup completes in one
// call; a missing fact returns needs_value naming the field; a no-op action
// returns no_progress; resume with the value completes. Jev is mocked so the
// loop's wiring is under test; the credential-gated matrix replay covers live
// Jev confidence.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  JevUnavailableError,
  type JevAnswer,
  type JevCallOutcome,
  type JevQuestion,
} from "../jev-client.js";
import {
  DRIVE_CONFIDENCE_THRESHOLD,
  DRIVE_EMPTY_SNAPSHOT_WAITS,
  DRIVE_WAIT_MS,
  applyReleasedCardFacts,
  matchingFactKeys,
  emptyDriveState,
  runOperateDrive,
  type DriveDependencies,
  type WireRow,
} from "../operate-drive.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { extractCredentials } from "../capture/capture.js";
import type { ProvisionAction } from "../provision-session.js";
import {
  act,
  observe,
  awaitVerification,
  injectCardIntoSessionTargets,
} from "../provision-session.js";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";
import { dispatchDriveAct } from "../act/act.js";
import { rememberDriveIdentities } from "../act/identity.js";
import { settleDriveStep } from "../drive-act.js";
import type { DriveSnapshot } from "../drive-snapshot.js";
import { sessionForCall } from "../session/lifecycle.js";
import { DriveEvaluateTimeout } from "../drive-evaluate.js";
import { attachOperatorRequestAbort, withOperatorRequestContext } from "../request-cancellation.js";

const SIGNUP_HTML = `<!doctype html><meta charset="utf-8"><title>Signup fixture</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <label>Company <input id="company" name="company" required></label>
    <button type="button" id="continue" onclick="
      const email = document.querySelector('#email').value;
      const company = document.querySelector('#company').value;
      if (!email || !company) return;
      document.querySelector('main').innerHTML = '<p id=done>Account created for '+email+' at '+company+'</p>';
    ">Continue</button>
  </form>
</main>`;

const LINK_VERIFY_HTML = `<!doctype html><meta charset="utf-8"><title>Link verify</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <button type="button" id="continue" onclick="
      const email = document.querySelector('#email').value;
      if (!email) return;
      document.querySelector('main').innerHTML = '<p>Check your email</p><a id=home href=/ >Home</a>';
    ">Continue</button>
  </form>
</main>`;

const VERIFIED_HTML = `<!doctype html><meta charset="utf-8"><title>Verified</title>
<main><p id="done">Email confirmed</p></main>`;

const DISABLED_FORM_HTML = `<!doctype html><meta charset="utf-8"><title>Disabled form</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <button type="button" id="continue" onclick="
      const email = document.querySelector('#email');
      const btn = document.getElementById('continue');
      if (!email.value) return;
      email.disabled = true;
      btn.disabled = true;
      setTimeout(() => {
        document.querySelector('main').innerHTML = '<p>Check your email</p><a id=home href=/ >Home</a>';
      }, 1800);
    ">Continue</button>
  </form>
</main>`;

const NOOP_HTML = `<!doctype html><meta charset="utf-8"><title>Noop fixture</title>
<main><button id="noop">Do nothing</button><p id="status">idle</p></main>`;

// Shopify one-page checkout in miniature: contact + a shipping SELECT first,
// then a same-document swap that leaves the snapshot empty before the payment
// stage mounts card, expiry, name-on-card, a delivery date the card expiry
// must never be typed into, and a site-search box the drive never fills. The
// blank window is longer than one DRIVE_WAIT_MS so the loop must spend more
// than a single re-observation on it no matter how long a snapshot takes.
const MULTI_STAGE_BLANK_MS = 2000;
const MULTI_STAGE_CHECKOUT_HTML = `<!doctype html><meta charset="utf-8"><title>Checkout fixture</title>
<main>
  <h1>Checkout</h1>
  <form id="f">
    <label>Email <input id="email" name="email" required></label>
    <label>First name <input id="first" name="first_name" required></label>
    <label>Last name <input id="last" name="last_name" required></label>
    <label>State <select id="state" required>
      <option value=""></option><option>NY</option><option>CA</option>
    </select></label>
    <button type="button" id="continue">Continue to payment</button>
  </form>
</main>
<script>
  document.querySelector("#continue").addEventListener("click", () => {
    if (!document.querySelector("#email").value) return;
    if (!document.querySelector("#first").value) return;
    if (!document.querySelector("#last").value) return;
    document.querySelector("main").innerHTML = "";
    setTimeout(() => {
      document.querySelector("main").innerHTML =
        '<label>Card number <input id=pan autocomplete=cc-number></label>' +
        '<label>CVV <input id=cvv autocomplete=cc-csc></label>' +
        '<label>Expiration date (MM / YY) <input id=exp></label>' +
        '<label>Name on card <input id=ncard></label>' +
        '<label>Delivery date <input id=when></label>' +
        '<label>State <select id=state2 required>' +
        '<option value=""></option><option>NY</option><option>CA</option></select></label>' +
        '<label>Phone (optional) <input id=tel name=phone></label>' +
        '<label>Search <input id=q type=search></label>' +
        '<p id=stage>payment</p>';
    }, ${MULTI_STAGE_BLANK_MS});
  });
</script>`;

const STALLED_HTML = `<!doctype html><meta charset="utf-8"><title>Stalled form</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label><input id="terms" type="checkbox" checked> I agree to the terms</label>
    <button type="button" id="create" disabled>Create account</button>
  </form>
  <p id="status">Validating your workspace…</p>
</main>`;

// A submit that never leaves its in-flight state: every settle wait observes
// the same disabled surface, so the settle budget is the only thing that ends
// the wait.
const NEVER_SETTLES_HTML = `<!doctype html><meta charset="utf-8"><title>Never settles</title>
<main>
  <h1>Create account</h1>
  <form id="f"><button type="button" id="create" disabled>Creating…</button></form>
</main>`;

// Filled form whose submit stays disabled behind a gate widget until the
// operate-path solver injects a token. The widget is a generic challenge
// surface, not a named provider.
const CAPTCHA_GATE_HTML = `<!doctype html><meta charset="utf-8"><title>Gate widget</title>
<main>
  <h1>Create account</h1>
  <p id="status">Ready</p>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <iframe id="challenge" title="challenge" src="about:blank" width="300" height="80"></iframe>
    <button type="button" id="continue">Continue</button>
  </form>
</main>
<script>
  document.getElementById("continue").addEventListener("click", () => {
    const email = document.getElementById("email");
    const btn = document.getElementById("continue");
    const status = document.getElementById("status");
    if (!email.value) return;
    if (btn.dataset.unlocked === "1") {
      document.querySelector("main").innerHTML = "<p id=done>Account created</p>";
      return;
    }
    btn.disabled = true;
    btn.dataset.gated = "1";
    status.textContent = "Waiting for challenge";
  });
</script>`;

const CAPTCHA_CONSUMED_MESSAGE_HTML = `<!doctype html><meta charset="utf-8"><title>Consumed token</title>
<main>
  <h1>Create account</h1>
  <p id="status">Ready</p>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <iframe id="challenge" title="image challenge" src="about:blank" width="300" height="80"></iframe>
    <button type="button" id="continue">Continue</button>
  </form>
  <p id="msg" hidden></p>
</main>
<script>
  window.consumeDeliveredToken = function () {
    const email = document.getElementById("email");
    const btn = document.getElementById("continue");
    const msg = document.getElementById("msg");
    email.disabled = true;
    btn.disabled = true;
    btn.textContent = "Creating your account";
    msg.hidden = false;
    msg.setAttribute("role", "alert");
    msg.textContent = "This email address has been used to sign up too recently.";
  };
  document.getElementById("continue").addEventListener("click", () => {
    const email = document.getElementById("email");
    const btn = document.getElementById("continue");
    if (!email.value) return;
    if (btn.dataset.consumed === "1") return;
    btn.disabled = true;
    btn.dataset.gated = "1";
  });
</script>`;

const DROPPED_LAST_CHAR_HTML = `<!doctype html><meta charset="utf-8"><title>Dropped last char</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>First name <input id="first" name="first_name"></label>
    <label>Email <input id="email" name="email" type="email"></label>
    <button type="button" id="continue" onclick="
      const first = document.getElementById('first');
      const email = document.getElementById('email');
      if (!first.value || !email.value) return;
      if (first.value !== 'Squire') return;
      document.querySelector('main').innerHTML = '<p id=done>Account created for '+first.value+'</p>';
    ">Continue</button>
  </form>
</main>
<script>
  const first = document.getElementById("first");
  let dropped = false;
  first.addEventListener("input", () => {
    if (dropped || first.value.length === 0) return;
    dropped = true;
    queueMicrotask(() => {
      if (first.value.length > 0) first.value = first.value.slice(0, -1);
    });
  });
</script>`;

const SLOW_SUBMIT_NEXT_HTML = `<!doctype html><meta charset="utf-8"><title>Slow submit</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <iframe id="challenge" title="image challenge" src="about:blank" width="300" height="80"></iframe>
    <button type="button" id="continue">Continue</button>
  </form>
</main>
<script>
  document.getElementById("continue").addEventListener("click", () => {
    const email = document.getElementById("email");
    const btn = document.getElementById("continue");
    if (!email.value) return;
    email.disabled = true;
    btn.disabled = true;
    btn.textContent = "Creating your account";
    setTimeout(() => {
      document.querySelector("main").innerHTML = "<p id=next>Check your email</p>";
    }, 3000);
  });
</script>`;

const CYCLE_LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Log in</title>
<main>
  <h1>Log in</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <button type="button" id="continue">Continue</button>
  </form>
  <a id="to-signup" href="/signup">Create account</a>
</main>`;

const CYCLE_SIGNUP_HTML = `<!doctype html><meta charset="utf-8"><title>Sign up</title>
<main>
  <h1>Create account</h1>
  <form id="f">
    <label>Email <input id="email" name="email" type="email"></label>
    <button type="button" id="continue">Continue</button>
  </form>
  <a id="to-login" href="/login">Log in</a>
</main>`;

// A payment settling behind a blank processor screen: no rows, ever.
const BLANK_PROCESSOR_HTML = `<!doctype html><meta charset="utf-8"><title>Processing</title>
<main></main>`;

const GROWING_HTML = `<!doctype html><meta charset="utf-8"><title>Growing</title>
<main><a href="#keep">Keep</a><div id="sink"></div></main>
<script>
  const sink = document.getElementById("sink");
  setInterval(() => {
    for (let i = 0; i < 200; i += 1) {
      const node = document.createElement("span");
      node.textContent = "n" + i;
      sink.appendChild(node);
    }
  }, 0);
</script>`;

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

// A key `extractApiKeyFromText` recognizes, built by concatenation so no
// contiguous Stripe-shaped literal sits in this file.
const DRIVE_FIXTURE_KEY = "sk" + "_live_fixtureKey" + "1234567890abcde";

function peaked(ids: string[], pick: string, peak = 0.91): Record<string, number> {
  const out: Record<string, number> = {};
  if (ids.length <= 1) {
    if (ids[0] !== undefined) out[ids[0]] = 1;
    return out;
  }
  const rest = (1 - peak) / (ids.length - 1);
  for (const id of ids) out[id] = id === pick ? peak : rest;
  return out;
}

function jevFromQuestions(
  questions: Record<string, { type?: string; criteria?: Record<string, string> }>,
  preferDone = false,
): JevCallOutcome {
  const answers: Record<
    string,
    { choice?: string; confidence?: number; probabilities?: Record<string, number> }
  > = {};
  const typeKeys = Object.keys(questions.TYPE_TEXT_target?.criteria ?? {});
  const selectKeys = Object.keys(questions.SELECT_target?.criteria ?? {});
  const clickKeys = Object.keys(questions.CLICK_target?.criteria ?? {});
  const pickOp = preferDone
    ? "DONE"
    : typeKeys.length > 0
      ? "TYPE_TEXT"
      : selectKeys.length > 0
        ? "SELECT"
        : clickKeys.length > 0
          ? "CLICK"
          : "DONE";
  for (const [name, question] of Object.entries(questions)) {
    if (question.criteria === undefined) continue;
    const keys = Object.keys(question.criteria);
    const pick =
      name === "operation"
        ? pickOp
        : name === "TYPE_TEXT_target"
          ? (typeKeys[0] ?? keys[0]!)
          : name === "SELECT_target"
            ? (selectKeys[0] ?? keys[0]!)
            : name === "CLICK_target"
              ? (clickKeys[0] ?? keys[0]!)
              : keys[0]!;
    answers[name] = {
      choice: pick,
      confidence: 0.93,
      probabilities: peaked(keys, pick),
    };
  }
  return { attempts: 1, elapsedMs: 12, result: { answers } };
}

function choiceCriteria(question: JevQuestion | undefined): Record<string, string> {
  return question?.type === "choice" ? question.criteria : {};
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

async function openFixture(
  html: string,
  host: string,
  initialObservation: "standard" | "drive" = "standard",
  path = "/",
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://${host}${path}`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation,
  });
  return { context, page, started };
}

async function actThroughShared(
  sessionId: string,
  action: ProvisionAction,
  snap?: DriveSnapshot | null,
): Promise<Awaited<ReturnType<typeof dispatchDriveAct>>> {
  const session = sessionForCall(sessionId);
  if (session !== undefined && snap !== undefined && snap !== null) {
    session.drive ??= emptyDriveState("fixture", {});
    rememberDriveIdentities(session.drive, snap.elements, snap.url);
  }
  return await dispatchDriveAct(sessionId, action);
}

function refFor(started: { safe_table?: unknown }, label: string): string {
  const rows = started.safe_table;
  if (!Array.isArray(rows)) throw new Error("no safe_table");
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const facts = String(row[2] ?? "");
    if (facts.split("|")[0] === label || facts.includes(label)) return String(row[0]);
  }
  throw new Error(`missing ${label}`);
}

describe("operate_drive real-browser fixture", () => {
  it.skipIf(process.env.DRIVE_WHITEJADE_STARTUP_AB !== "1")(
    "measures Whitejade drive startup with the general bypass kept versus deleted",
    async () => {
      const samples: Array<{ variant: string; elapsedMs: number; startupCaptures: number }> = [];
      for (let run = 0; run < 3; run += 1) {
        for (const variant of run % 2 === 0 ? ["kept", "deleted"] : ["deleted", "kept"]) {
          const context = await browser.newContext();
          const page = await context.newPage();
          const controller = BrowserController.fromHarnessPage(page);
          const original = controller.extractBrowserUseObservation.bind(controller);
          let starting = false;
          let startupCaptures = 0;
          vi.spyOn(controller, "extractBrowserUseObservation").mockImplementation(
            async (source, settle) => {
              if (starting) startupCaptures += 1;
              return await original(source, starting && variant === "kept" ? false : settle);
            },
          );
          let sessionId: string | undefined;
          try {
            const dependencies = deps(async (_api, _state, questions) =>
              jevFromQuestions(questions, true),
            );
            dependencies.startSession = async (options) => {
              starting = true;
              try {
                const started = await startHarnessProvisionSession({
                  ...options,
                  browser: controller,
                });
                sessionId = started.session_id;
                return started;
              } finally {
                starting = false;
              }
            };
            const begin = performance.now();
            const result = await runOperateDrive(
              {
                url: "https://whitejade.xyz/products/the-recovery-creme?variant=53574851297391",
                goal: "inspect the product page",
              },
              api(),
              undefined,
              dependencies,
            );
            const elapsedMs = performance.now() - begin;
            expect(result.status).toBe("complete");
            expect(result.observation?.url).toContain("whitejade.xyz");
            expect(startupCaptures).toBe(0);
            samples.push({ variant, elapsedMs, startupCaptures });
          } finally {
            if (sessionId !== undefined) await finishProvisionSession(sessionId);
            await context.close();
          }
        }
      }
      const median = (variant: string) =>
        samples
          .filter((sample) => sample.variant === variant)
          .map((sample) => sample.elapsedMs)
          .sort((a, b) => a - b)[1];
      writeFileSync(
        "../../drive-startup-review-evidence.json",
        JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            scope:
              "Live Whitejade product startup and DONE, mocked Jev; not a full checkout timing",
            comparison:
              "Kept variant forces startup general captures to skip settling; deleted uses normal settling",
            landed: "deleted",
            reason: "Drive startup never calls general observation in either variant",
            samples,
            mediansMs: { kept: median("kept"), deleted: median("deleted") },
          },
          null,
          2,
        ) + "\n",
      );
    },
    180_000,
  );

  it("keeps the full general settle for ordinary startup", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: NOOP_HTML }),
    );
    const controller = BrowserController.fromHarnessPage(page);
    const capture = vi.spyOn(controller, "extractBrowserUseObservation");
    let sessionId: string | undefined;
    try {
      const started = await startHarnessProvisionSession({
        browser: controller,
        serviceUrl: "https://ordinary-start.test/",
        format: "compact",
      });
      sessionId = started.session_id;
      expect(capture).toHaveBeenCalledWith(undefined, true);
    } finally {
      if (sessionId !== undefined) await finishProvisionSession(sessionId);
      await context.close();
    }
  }, 30_000);

  it("starts URL-owned drives with deferred general perception and snapshots directly", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: SIGNUP_HTML }),
    );
    let started: Awaited<ReturnType<typeof startHarnessProvisionSession>> | undefined;
    try {
      const startSession = vi.fn(
        async (options: Parameters<DriveDependencies["startSession"]>[0]) => {
          started = await startHarnessProvisionSession({
            ...options,
            browser: BrowserController.fromHarnessPage(page),
          });
          expect(started).not.toHaveProperty("safe_table");
          expect(started).not.toHaveProperty("dom");
          expect(sessionForCall(started.session_id)?.initializing).toBe(false);
          return started;
        },
      );
      const observeSpy = vi.fn(async () => {
        throw new Error("drive startup should not call the general observation");
      });
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.startSession = startSession;
      dependencies.observe = observeSpy;

      const handoff = await runOperateDrive(
        {
          url: "https://signup-direct-start.test/",
          goal: "inspect this signup",
          facts: { email: "ada@fixture.test", company: "Acme" },
        },
        api(),
        undefined,
        dependencies,
      );

      expect(handoff.status).toBe("complete");
      expect(startSession).toHaveBeenCalledWith(
        expect.objectContaining({ initialObservation: "drive", format: "compact" }),
      );
      expect(observeSpy).not.toHaveBeenCalled();
      expect(handoff.observation?.safe_table).toBeDefined();
      expect(JSON.stringify(handoff.observation?.safe_table)).toContain("Email");
      expect(JSON.stringify(handoff.observation?.safe_table)).toContain("Company");
    } finally {
      if (started !== undefined) await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("ends the drive on the Google wall an act hands back", async () => {
    const html = `<main><button id="google">Continue with Google</button></main>`;
    const { context, started } = await openFixture(html, "google-wall.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const actions: ProvisionAction[] = [];
      // OAuth is the drive's own action now: it goes through the drive
      // executor, not the tools fallback. Record it and run the real dispatch
      // so the provider wall is produced by the real session gate.
      dependencies.driveAct = async (sessionId, action) => {
        actions.push(action);
        return await dispatchDriveAct(sessionId, action);
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "sign in with Google" },
        api(),
        undefined,
        dependencies,
      );
      expect(actions).toEqual([
        expect.objectContaining({ kind: "oauth_login", provider: "google" }),
      ]);
      expect(result.status).toBe("needs_value");
      expect(result.field).toBe("google_session");
      expect(result.question).toContain("connect");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("invokes oauth_login on a provider link without treating the miss as fatal", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Signup</title>
<main>
  <h1>Create account</h1>
  <a id="google" href="/oauth/google">Continue with Google</a>
  <a id="github" href="/oauth/github">Continue with GitHub</a>
</main>`;
    const { context, started } = await openFixture(html, "oauth-links.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const actions: ProvisionAction[] = [];
      dependencies.driveAct = async (sessionId, action) => {
        actions.push(action);
        return await dispatchDriveAct(sessionId, action);
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "create an account" },
        api(),
        undefined,
        dependencies,
      );
      expect(actions).toEqual([
        expect.objectContaining({ kind: "oauth_login", provider: "google" }),
      ]);
      expect(result.status).toBe("needs_value");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("finishes a third-party-only signup when the goal excludes those links", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Signup</title>
<main>
  <h1>Create account</h1>
  <a id="google" href="/oauth/google">Continue with Google</a>
  <a id="github" href="/oauth/github">Continue with GitHub</a>
</main>`;
    const { context, started } = await openFixture(html, "oauth-links-excluded.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      dependencies.act = async () => {
        throw new Error("oauth_login must not run when the goal excludes third-party sign-in");
      };
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account with email, not Google or GitHub",
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("stuck");
      expect(result.reason).toMatch(/no other sign-up path/i);
      expect(result.steps).toBeLessThanOrEqual(4);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("records a failed oauth_login as a step instead of aborting the drive", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Signup</title>
<main>
  <h1>Create account</h1>
  <a id="google" href="/oauth/google">Continue with Google</a>
  <a id="github" href="/oauth/github">Continue with GitHub</a>
</main>`;
    const { context, started } = await openFixture(html, "oauth-links-failed.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      // Force the drive executor to hand the OAuth act back, so the tools
      // fallback runs and refuses. The refusal must be recorded as a failed
      // step, never confused with the unchanged page.
      dependencies.driveAct = async (sessionId, action) =>
        action.kind === "oauth_login"
          ? { kind: "unsupported" as const }
          : await dispatchDriveAct(sessionId, action);
      dependencies.act = async () => {
        throw new Error(
          'oauth_login: no element matched target "@e:f0d2". Re-observe and use the OAuth button ref.',
        );
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "sign up with Google", max_steps: 4 },
        api(),
        undefined,
        dependencies,
      );
      expect(["budget", "stuck", "no_progress"]).toContain(result.status);
      expect(result.trajectory.some((step) => step.action === "oauth_login")).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("clicks a nav link over a filter that shares the goal noun", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav><a id="keys" href="/keys">API Keys</a></nav>
<label>All API keys
  <select id="filter"><option>All API keys</option><option>Mine</option></select>
</label>`;
    const { context, page, started } = await openFixture(
      html,
      "keys-filter.test",
      "standard",
      "/dashboard",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "sign up and extract an API key", max_steps: 6 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/keys/);
      expect(result.trajectory.some((step) => step.action === "click")).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("opens unvisited section tabs until the goal noun appears", async () => {
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<nav><a id="settings" href="/settings">Settings</a></nav>
<div role="tablist">
  <button type="button" role="tab" id="billing">billing</button>
  <button type="button" role="tab" id="account">account</button>
  <button type="button" role="tab" id="apps">apps</button>
</div>
<section id="panel"></section>
<script>
  const panels = {
    billing: "<p>Plan</p>",
    account: "<p>Profile</p>",
    apps: '<a id="keys" href="/keys">API Keys</a>',
  };
  const show = (name) => { document.getElementById("panel").innerHTML = panels[name]; };
  document.getElementById("billing").onclick = () => show("billing");
  document.getElementById("account").onclick = () => show("account");
  document.getElementById("apps").onclick = () => show("apps");
</script>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/keys") ? keysHtml : settingsHtml,
      });
    });
    const url = "https://settings-tabs.test/settings";
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/keys/);
      expect(
        result.trajectory.filter((step) => step.action === "click").length,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("reaches a key section from a dashboard without re-entering logo or anchors", async () => {
    const dashboardHtml = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<a id="logo" href="/">Acme</a>
<a id="primitives" href="#primitives">Primitives</a>
<nav><a id="settings" href="/settings">Settings</a></nav>
<section id="primitives"><p>Product primitives</p></section>`;
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<nav><a id="keys" href="/keys">API Keys</a></nav>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    const hits: string[] = [];
    await page.route("**/*", (route) => {
      const url = route.request().url();
      hits.push(new URL(url).pathname);
      const body = url.includes("/keys")
        ? keysHtml
        : url.includes("/settings")
          ? settingsHtml
          : dashboardHtml;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://section-key.test/dashboard";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      let jevCalls = 0;
      const dependencies = deps(async (_api, _state, questions) => {
        jevCalls += 1;
        return jevFromQuestions(questions);
      });
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/keys/);
      expect(hits.filter((path) => path === "/").length).toBe(0);
      expect(
        result.trajectory.filter((step) => step.action === "click").length,
      ).toBeLessThanOrEqual(3);
      expect(jevCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("ends an A-B-A-B two-link page with no_progress in a handful of steps", async () => {
    const alphaHtml = `<!doctype html><meta charset="utf-8"><title>Alpha</title>
<nav>
  <a id="logo" href="/">Acme</a>
  <a id="beta" href="/beta">Beta</a>
</nav>`;
    const betaHtml = `<!doctype html><meta charset="utf-8"><title>Beta</title>
<nav>
  <a id="logo" href="/">Acme</a>
  <a id="alpha" href="/alpha">Alpha</a>
</nav>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/beta") ? betaHtml : alphaHtml,
      });
    });
    const startUrl = "https://section-cycle.test/alpha";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 16 },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("no_progress");
      expect(result.steps).toBeLessThanOrEqual(8);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("reports a page-level notice after navigation as the outcome", async () => {
    const dashHtml = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav><a id="settings" href="/settings">Settings</a></nav>`;
    const noticeHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<main><p role="alert">Your account needs more information to be reactivated.</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/settings") ? noticeHtml : dashHtml,
      });
    });
    const startUrl = "https://section-notice.test/dashboard";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 6 },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("stuck");
      expect(result.reason).toMatch(/more information/i);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("chooses the in-app API Keys link over a docs link with the same noun", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav><a id="keys" href="/keys">API Keys</a></nav>
<aside><a id="docs" href="/docs/api-keys">API keys</a></aside>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const docsHtml = `<!doctype html><meta charset="utf-8"><title>Docs</title>
<main><button type="button" id="sample">POST Create API key</button></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const body = url.includes("/docs/") ? docsHtml : url.includes("/keys") ? keysHtml : html;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://in-app-keys.test/dashboard";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "open the API Keys page from the left navigation, create an API key",
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/keys/);
      expect(page.url()).not.toMatch(/\/docs\//);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not click a reminted ordinal after navigation", async () => {
    const decoys = Array.from(
      { length: 5 },
      (_, i) => `<a id="d${i}" href="#d${i}">Decoy ${i}</a>`,
    ).join("");
    const startHtml = `<!doctype html><meta charset="utf-8"><title>Start</title>
<nav>${decoys}<a id="go" href="/next">Continue</a></nav>`;
    const nextHtml = `<!doctype html><meta charset="utf-8"><title>Next</title>
<nav>${decoys}<a id="trap" href="/trap">Create app</a><a id="keys" href="/keys">API Keys</a></nav>`;
    const trapHtml = `<!doctype html><meta charset="utf-8"><title>Trap</title><p>trapped</p>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const body = url.includes("/trap")
        ? trapHtml
        : url.includes("/keys")
          ? keysHtml
          : url.includes("/next")
            ? nextHtml
            : startHtml;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://stale-ref.test/start";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    let staleRef: string | undefined;
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        const click = questions.CLICK_target;
        const criteria = click?.type === "choice" ? click.criteria : {};
        if (staleRef === undefined) {
          staleRef = Object.keys(criteria).find((key) => /continue/i.test(criteria[key] ?? ""));
        }
        const pick = staleRef ?? Object.keys(criteria)[0];
        const outcome = jevFromQuestions(questions);
        if (pick !== undefined && outcome.result.answers.CLICK_target !== undefined) {
          outcome.result.answers.CLICK_target = {
            choice: pick,
            confidence: 0.93,
            probabilities: peaked(Object.keys(criteria), pick),
          };
        }
        return outcome;
      });
      await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).not.toMatch(/\/trap/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("opens an existing entry or fills the name before Create", async () => {
    const listHtml = `<!doctype html><meta charset="utf-8"><title>Apps</title>
<section>
  <a id="one" href="/apps/one">payments-api</a>
  <a id="two" href="/apps/two">billing-api</a>
  <a id="new" href="/apps/new">+ New app</a>
</section>`;
    const entryHtml = `<!doctype html><meta charset="utf-8"><title>App</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const createHtml = `<!doctype html><meta charset="utf-8"><title>New app</title>
<main>
  <label>App name <input id="name" name="name" required></label>
  <button type="button" id="create" onclick="
    const name = document.getElementById('name').value;
    if (!name) { document.getElementById('err').textContent = 'Name is required'; return; }
    location.href = '/apps/one';
  ">Create</button>
  <p id="err"></p>
</main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const body = url.includes("/apps/new")
        ? createHtml
        : url.includes("/apps/")
          ? entryHtml
          : listHtml;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://listed-entry.test/apps";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "extract an API key",
          facts: { company: "Acme" },
          max_steps: 8,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/apps\/(?:one|two)/);
      const firstClick = result.trajectory.find((step) => step.action === "click");
      expect(firstClick?.jev_ms).toBeGreaterThan(0);
      if (page.url().includes("/apps/new")) {
        expect(await page.locator("#name").inputValue()).not.toBe("");
      }
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("decides on a settings page with entries before exploring a section", async () => {
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<nav>
  <a id="settings" href="/settings">Settings</a>
  <a id="reputation" href="/reputation">Reputation</a>
</nav>
<section>
  <a id="one" href="/apps/one">payments-api</a>
  <a id="two" href="/apps/two">billing-api</a>
  <a id="new" href="/apps/new">+ New app</a>
</section>`;
    const entryHtml = `<!doctype html><meta charset="utf-8"><title>App</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const reputationHtml = `<!doctype html><meta charset="utf-8"><title>Reputation</title>
<nav>
  <a id="settings" href="/settings">Settings</a>
  <a id="reputation" href="/reputation">Reputation</a>
</nav>
<p>scores</p>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const body = url.includes("/reputation")
        ? reputationHtml
        : url.includes("/apps/")
          ? entryHtml
          : settingsHtml;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://settings-entries.test/settings";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      const firstClick = result.trajectory.find((step) => step.action === "click");
      expect(firstClick?.jev_ms).toBeGreaterThan(0);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("logs out of a pre-existing verification page or reports already signed in", async () => {
    const registerHtml = `<!doctype html><meta charset="utf-8"><title>Register</title>
<main>
  <label>Email <input id="email" name="email" type="email"></label>
  <button type="button" id="go">Create account</button>
</main>`;
    const verifyHtml = `<!doctype html><meta charset="utf-8"><title>Verify</title>
<main>
  <h1>Check your email</h1>
  <a id="logout" href="/logged-out">Log out</a>
</main>`;
    const outHtml = `<!doctype html><meta charset="utf-8"><title>Out</title><p>signed out</p>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    let signedIn = true;
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.includes("/logged-out")) {
        signedIn = false;
        route.fulfill({ contentType: "text/html", body: outHtml });
        return;
      }
      if (url.includes("/register") && signedIn) {
        route.fulfill({ contentType: "text/html", body: verifyHtml });
        return;
      }
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/register") ? registerHtml : verifyHtml,
      });
    });
    const startUrl = "https://preexisting-session.test/register";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const offered: string[][] = [];
      const dependencies = deps(async (_api, _state, questions) => {
        const operation = questions.operation;
        if (operation?.type === "choice") offered.push(Object.keys(operation.criteria));
        return jevFromQuestions(questions);
      });
      const startedAt = Date.now();
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "sign up, complete email verification, and extract an API key",
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(offered[0] ?? []).not.toContain("INBOX");
      expect(result.trajectory.some((step) => step.action === "inbox")).toBe(false);
      expect(
        result.reason?.match(/already signed in/i) ||
          page.url().includes("/register") ||
          page.url().includes("/logged-out"),
      ).toBeTruthy();
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("continues an OAuth-goal drive that starts on a signed-in dashboard", async () => {
    const dashHtml = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav>
  <a id="settings" href="/settings">Settings</a>
  <a id="keys" href="/keys">API Keys</a>
  <a id="verify" href="/verifications">Verify email</a>
  <a id="logout" href="/logged-out">Log out</a>
</nav>
<p>Welcome back</p>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">sk_live_fixture</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/keys") ? keysHtml : dashHtml,
      });
    });
    const startUrl = "https://signed-in-dash.test/dashboard";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "use Continue with Google with the account already signed in to this browser and extract an API key",
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(result.reason ?? "").not.toMatch(/already signed in as another account/i);
      expect(result.steps).toBeGreaterThan(0);
      expect(page.url()).toMatch(/\/keys/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("finishes with a same-URL field error after submit", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Register</title>
<main>
  <label>Email <input id="email" name="email" type="email"></label>
  <button type="button" id="go">Register</button>
  <p id="email-error" hidden></p>
</main>
<script>
  document.getElementById("go").onclick = () => {
    const input = document.getElementById("email");
    const err = document.getElementById("email-error");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-errormessage", "email-error");
    err.hidden = false;
    err.textContent = "You are prohibited of registering an account. (Error: A1)";
    const payload = document.getElementById("page-data") ?? document.createElement("script");
    payload.id = "page-data";
    payload.type = "application/json";
    payload.textContent = JSON.stringify({
      props: { errors: { email: "You are prohibited of registering an account. (Error: A1)" } },
    });
    document.body.appendChild(payload);
  };
</script>`;
    const { context, page, started } = await openFixture(
      html,
      "field-error.test",
      "standard",
      "/register",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/register/);
      expect(result.status).toBe("stuck");
      expect(result.reason).toMatch(/prohibited of registering/i);
      expect(result.reason ?? "").not.toMatch(/did not respond/i);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("re-snapshots after a same-URL tab click swaps the panel", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<div role="tablist">
  <button type="button" role="tab" id="account">Account</button>
  <button type="button" role="tab" id="apps">Apps</button>
</div>
<section id="panel"><p id="apps-panel">payments-api</p></section>
<script>
  document.getElementById("account").onclick = () => {
    setTimeout(() => {
      document.getElementById("panel").innerHTML =
        '<label>Name <input id="name" value="Ada"></label><p id="billing-email">billing@example.test</p>';
    }, 120);
  };
</script>`;
    const { context, page, started } = await openFixture(
      html,
      "tab-swap.test",
      "standard",
      "/settings",
    );
    try {
      const seen: string[] = [];
      const dependencies = deps(async (_api, state, questions) => {
        seen.push(JSON.stringify(state));
        return jevFromQuestions(questions);
      });
      await runOperateDrive(
        { session_id: started.session_id, goal: "open the account section", max_steps: 4 },
        api(),
        undefined,
        dependencies,
      );
      expect(await page.locator("#billing-email").count()).toBe(1);
      expect(seen.some((text) => /Name|Ada|billing@example\.test/i.test(text))).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("opens a listed entry and captures the revealed key", async () => {
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<div role="tablist">
  <button type="button" role="tab" id="apps">Apps</button>
  <button type="button" role="tab" id="account">Account</button>
</div>
<section>
  <a id="one" href="/settings/apps/one">payments-api</a>
  <a id="two" href="/settings/apps/two">billing-api</a>
  <a id="new" href="/settings/apps/new">+ New app</a>
</section>`;
    const entryHtml = `<!doctype html><meta charset="utf-8"><title>payments-api</title>
<main>
  <h1>payments-api</h1>
  <p id="secret">••••••••••••</p>
  <button type="button" id="reveal">Reveal</button>
</main>
<script>
  document.getElementById("reveal").onclick = () => {
    document.getElementById("secret").textContent = "${DRIVE_FIXTURE_KEY}";
    document.getElementById("reveal").remove();
  };
</script>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/settings/apps/") ? entryHtml : settingsHtml,
      });
    });
    const startUrl = "https://reveal-entry.test/settings";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).toMatch(/\/settings\/apps\//);
      expect(await page.locator("#secret").innerText()).toBe(DRIVE_FIXTURE_KEY);
      expect(result.status).toBe("complete");
      // The capture flow reveals masked values itself, so the drive never has
      // to click Reveal: the shared extractor is what stored the key.
      expect((await extractCredentials(started.session_id)).credentials.api_key).toBe(
        DRIVE_FIXTURE_KEY,
      );
      expect(JSON.stringify(result)).not.toContain(DRIVE_FIXTURE_KEY);
      expect(JSON.stringify(result.observation?.safe_table)).toMatch(/@key-value\|secret=1\|len=/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("opens a listed entry before a second tab and captures the revealed key", async () => {
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<div role="tablist">
  <button type="button" role="tab" id="apps">Apps</button>
  <button type="button" role="tab" id="billing">Billing</button>
  <button type="button" role="tab" id="account">Account</button>
</div>
<section id="panel">
  <a id="one" href="/settings/apps/one">payments-api</a>
  <a id="two" href="/settings/apps/two">billing-api</a>
  <a id="three" href="/settings/apps/three">alerts-api</a>
  <a id="four" href="/settings/apps/four">usage-api</a>
  <a id="five" href="/settings/apps/five">audit-api</a>
  <a id="new" href="/settings/apps/new">+ New app</a>
</section>
<script>
  const panel = document.getElementById("panel");
  const appsHtml = panel.innerHTML;
  const noteTab = (name) => {
    const prev = JSON.parse(sessionStorage.getItem("tabClicks") || "[]");
    prev.push(name);
    sessionStorage.setItem("tabClicks", JSON.stringify(prev));
  };
  document.getElementById("account").onclick = () => {
    noteTab("account");
    panel.innerHTML = '<label>Name <input id="name" value="Ada"></label><p id="billing-email">billing@example.test</p>';
  };
  document.getElementById("billing").onclick = () => {
    noteTab("billing");
    panel.innerHTML = "<p>Plan</p>";
  };
  document.getElementById("apps").onclick = () => {
    noteTab("apps");
    panel.innerHTML = appsHtml;
  };
</script>`;
    const entryHtml = `<!doctype html><meta charset="utf-8"><title>payments-api</title>
<main>
  <h1>payments-api</h1>
  <p id="secret">••••••••••••</p>
  <button type="button" id="reveal">Reveal</button>
</main>
<script>
  document.getElementById("reveal").onclick = () => {
    document.getElementById("secret").textContent = "${DRIVE_FIXTURE_KEY}";
    document.getElementById("reveal").remove();
  };
</script>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/settings/apps/") ? entryHtml : settingsHtml,
      });
    });
    const startUrl = "https://entries-before-tabs.test/settings";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      const tabClicks = await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("tabClicks") || "[]") as string[],
      );
      expect(tabClicks.length).toBeLessThan(2);
      expect(page.url()).toMatch(/\/settings\/apps\//);
      expect(await page.locator("#secret").innerText()).toBe(DRIVE_FIXTURE_KEY);
      expect(result.status).toBe("complete");
      expect(JSON.stringify(result)).not.toContain(DRIVE_FIXTURE_KEY);
      expect(JSON.stringify(result.observation?.safe_table)).toMatch(/@key-value\|secret=1\|len=/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("never opens Docs from a dashboard that still has Settings and a filter picker", async () => {
    const dashHtml = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav>
  <a id="docs" href="/docs">Docs</a>
  <a id="settings" href="/settings">Settings</a>
  <a id="logo" href="/">Logo</a>
</nav>
<label>Environment <select id="env"><option>Production</option><option>Sandbox</option></select></label>`;
    const settingsHtml = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<nav>
  <a id="docs" href="/docs">Docs</a>
  <a id="settings" href="/settings">Settings</a>
</nav>
<div role="tablist">
  <button type="button" role="tab" id="account">Account</button>
  <button type="button" role="tab" id="billing">Billing</button>
</div>
<section>
  <a id="one" href="/settings/apps/one">payments-api</a>
  <a id="two" href="/settings/apps/two">billing-api</a>
  <a id="three" href="/settings/apps/three">alerts-api</a>
  <a id="new" href="/settings/apps/new">+ New app</a>
</section>`;
    const docsHtml = `<!doctype html><meta charset="utf-8"><title>Docs</title>
<main>
  <h1>Documentation</h1>
  <a id="enroll" href="/docs/enrollment">Enrollment</a>
</main>`;
    const entryHtml = `<!doctype html><meta charset="utf-8"><title>payments-api</title>
<main>
  <h1>payments-api</h1>
  <p id="secret">••••••••••••</p>
  <button type="button" id="reveal">Reveal</button>
</main>
<script>
  document.getElementById("reveal").onclick = () => {
    document.getElementById("secret").textContent = "${DRIVE_FIXTURE_KEY}";
    document.getElementById("reveal").remove();
  };
</script>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const body = url.includes("/docs")
        ? docsHtml
        : url.includes("/settings/apps/")
          ? entryHtml
          : url.includes("/settings")
            ? settingsHtml
            : dashHtml;
      route.fulfill({ contentType: "text/html", body });
    });
    const startUrl = "https://shape-candidates.test/dashboard";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(page.url()).not.toMatch(/\/docs/);
      expect(page.url()).toMatch(/\/settings\/apps\//);
      expect(await page.locator("#secret").innerText()).toBe(DRIVE_FIXTURE_KEY);
      expect(result.status).toBe("complete");
      expect(JSON.stringify(result)).not.toContain(DRIVE_FIXTURE_KEY);
      expect(JSON.stringify(result.observation?.safe_table)).toMatch(/@key-value\|secret=1\|len=/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not treat a signed-in /verifications product page as a pre-existing session", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Verifications</title>
<nav>
  <a id="keys" href="/keys">API Keys</a>
  <a id="logout" href="/logged-out">Log out</a>
</nav>
<main>
  <h1>Identity verifications</h1>
  <p>Review verification requests for this app.</p>
</main>`;
    const keysHtml = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<main><h1>API Keys</h1><p id="key">ready</p></main>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/keys") ? keysHtml : html,
      });
    });
    const startUrl = "https://verifications-section.test/verifications";
    await page.goto(startUrl);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: startUrl,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "extract an API key",
          max_steps: 4,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(result.reason ?? "").not.toMatch(/already signed in as another account/i);
      expect(result.status).not.toBe("stuck");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("starts a new goal on the same session without inheriting cycle memory", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Settings</title>
<nav><a id="settings" href="/settings">Settings</a></nav>
<div role="tablist">
  <button type="button" role="tab" id="billing">billing</button>
  <button type="button" role="tab" id="account">account</button>
  <button type="button" role="tab" id="apps">apps</button>
</div>
<section id="panel"></section>
<script>
  const panels = {
    billing: "<p>Plan</p>",
    account: "<p>Profile</p>",
    apps: '<p id="apps-panel">Your apps</p>',
  };
  const show = (name) => { document.getElementById("panel").innerHTML = panels[name]; };
  document.getElementById("billing").onclick = () => show("billing");
  document.getElementById("account").onclick = () => show("account");
  document.getElementById("apps").onclick = () => show("apps");
</script>`;
    const { context, page, started } = await openFixture(
      html,
      "goal-reset.test",
      "standard",
      "/settings",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const first = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 2 },
        api(),
        undefined,
        dependencies,
      );
      expect(first.trajectory.length).toBeGreaterThan(0);
      const second = await runOperateDrive(
        { session_id: started.session_id, goal: "open the apps section", max_steps: 4 },
        api(),
        undefined,
        dependencies,
      );
      expect(second.trajectory.length).toBeGreaterThan(0);
      expect(second.steps).toBeGreaterThan(0);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not write a company fact into an email field named by its placeholder", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Billing</title>
<main>
  <input id="bill" type="email" placeholder="billing@yourcompany.com">
  <button type="button" id="save">Save</button>
</main>`;
    const { context, page, started } = await openFixture(html, "email-placeholder.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "save billing contact",
          facts: { company: "Acme", email: "ada@fixture.test" },
          max_steps: 6,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(await page.locator("#bill").inputValue()).toBe("ada@fixture.test");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("advances a whole-purchase goal across the empty snapshot into the payment stage", async () => {
    const { context, page, started } = await openFixture(
      MULTI_STAGE_CHECKOUT_HTML,
      "multi-stage-checkout.test",
      "standard",
      "/checkouts/cn1",
    );
    try {
      const session = sessionForCall(started.session_id)!;
      const card = {
        pan: "4111111111111111",
        cvv: "739",
        exp_month: "12",
        exp_year: "2030",
        name: "A L Byron",
        billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
      };
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      let injections = 0;
      const atInject: Record<string, string> = {};
      dependencies.injectCard = async (_session, args) => {
        injections += 1;
        for (const id of ["exp", "ncard", "when", "q", "state2", "tel"]) {
          atInject[id] = await page.locator(`#${id}`).inputValue();
        }
        const fields = await injectCardIntoSessionTargets(started.session_id, card, args.fields);
        session.releasedPaymentCard = {
          approvalId: "approved",
          approvalUrl: "https://approval.test",
          checkout: {
            merchant: "fixture.test",
            checkout_origin: "https://multi-stage-checkout.test",
            amount_cents: 100,
            currency: "USD",
          },
          cardRef: "card-1",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card,
        };
        return { status: "card_injected", complete: true, fields };
      };
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Buy one item: fill the contact and shipping details, pay with the saved card, and stop when the order is confirmed",
          facts: {
            email: "ada@fixture.test",
            first_name: "Ada",
            last_name: "Lovelace",
            state: "NY",
            phone: "2125550100",
            card_ref: "card-1",
            merchant: "fixture.test",
          },
          max_steps: 24,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).not.toBe("stuck");
      // The blank window outlasts one DRIVE_WAIT_MS, so the loop has to keep
      // re-observing instead of asking Jev to rule on an empty snapshot.
      const waits = result.trajectory.filter((step) => step.action === "wait").length;
      expect(waits).toBeGreaterThanOrEqual(Math.ceil(MULTI_STAGE_BLANK_MS / DRIVE_WAIT_MS));
      expect(await page.locator("#stage").textContent()).toBe("payment");

      // The card is released only once every fact-backed fill is done, the
      // required State dropdown included: resolving it afterwards would make
      // the merchant re-cost the order and remount the card frames. The
      // site-search box the drive has no fact for is not a fill and must not
      // hold the card back — gating on it would deadlock the purchase. Expiry
      // and name-on-card stay untouched until the card is released.
      expect(injections).toBe(1);
      expect(atInject.state2).toBe("NY");
      // An optional but fact-backed delivery field is still an address edit.
      // Releasing the card with it pending means the merchant re-costs the
      // order afterwards and remounts the card frames, wiping the PAN.
      expect(atInject.tel).toBe("2125550100");
      expect({ exp: atInject.exp, ncard: atInject.ncard, when: atInject.when }).toEqual({
        exp: "",
        ncard: "",
        when: "",
      });
      expect(await page.locator("#pan").inputValue()).toBe(card.pan);
      expect(await page.locator("#cvv").inputValue()).toBe(card.cvv);

      // After release the expiry and the cardholder name belong to the card
      // controls alone — "Name on card" takes the card's own name, not the
      // shipping name synthesized from first_name + last_name.
      expect(await page.locator("#exp").inputValue()).toBe("12/30");
      expect(await page.locator("#ncard").inputValue()).toBe("A L Byron");
      expect(await page.locator("#last").count()).toBe(0);
      expect(await page.locator("#when").inputValue()).toBe("");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  const CONFIRMATION_HTML = `<!doctype html><meta charset="utf-8"><title>Blank</title><main><p>Your order is confirmed. #1042</p></main>`;

  it("re-observes a second blank window after an auto-applied fill", async () => {
    // The Shopify shape: a stage swap blanks the snapshot, the next stage
    // mounts carrying one outstanding fact-backed fill, and writing it makes
    // the merchant re-render — blanking the snapshot a second time. The
    // re-observation budget belongs to each blank window, so the second one
    // must still be waited through rather than ruled on with zero rows.
    const html = `<!doctype html><meta charset="utf-8"><title>Two blanks</title>
<main><p>loading</p></main>
<script>
  setTimeout(() => {
    document.querySelector("main").innerHTML = '<label>Email <input id=email name=email></label>';
  }, 4000);
  document.addEventListener("input", (event) => {
    if (event.target.id !== "email") return;
    document.querySelector("main").innerHTML = "";
    setTimeout(() => {
      document.querySelector("main").innerHTML = "<p>ready to submit</p>";
    }, 2000);
  }, true);
</script>`;
    const { context, started } = await openFixture(html, "two-blank-windows.test");
    try {
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "reach the ready state",
          facts: { email: "ada@fixture.test" },
          max_seconds: 40,
        },
        api(),
        undefined,
        deps(async (_api, state, questions) => {
          const text = (state as { page?: { text?: string } }).page?.text ?? "";
          const keys = Object.keys(
            questions.operation?.type === "choice" ? questions.operation.criteria : {},
          );
          const pick = text.includes("ready to submit") ? "DONE" : "BLOCKED";
          return {
            attempts: 1,
            elapsedMs: 5,
            result: {
              answers: {
                operation: { choice: pick, confidence: 0.9, probabilities: peaked(keys, pick) },
              },
            },
          };
        }),
      );
      // Without a per-window budget the second blank snapshot goes straight to
      // the model, which can only answer BLOCKED on zero rows — the reported
      // "stuck".
      expect(result.status).toBe("complete");
      expect(result.trajectory.filter((step) => step.action === "type")).toHaveLength(1);
      expect(result.trajectory.filter((step) => step.action === "wait").length).toBeGreaterThan(
        DRIVE_EMPTY_SNAPSHOT_WAITS,
      );
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it.each([
    { answer: "BLOCKED", status: "stuck" },
    { answer: "DONE", status: "complete" },
  ])(
    "asks one terminal-only question on a control-free page and honours $answer",
    async ({ answer, status }) => {
      const { context, started } = await openFixture(CONFIRMATION_HTML, "blank-snapshot.test");
      try {
        const asked: Array<{ names: string[]; operationCriteria: string[]; pageText: string }> = [];
        const criteriaOf = (question: JevQuestion | undefined): string[] =>
          question?.type === "choice" ? Object.keys(question.criteria) : [];
        const result = await runOperateDrive(
          { session_id: started.session_id, goal: "buy one item" },
          api(),
          undefined,
          deps(async (_api, state, questions) => {
            const keys = criteriaOf(questions.operation);
            asked.push({
              names: Object.keys(questions),
              operationCriteria: keys,
              pageText: (state as { page?: { text?: string } }).page?.text ?? "",
            });
            return {
              attempts: 1,
              elapsedMs: 5,
              result: {
                answers: {
                  operation: {
                    choice: answer,
                    confidence: 0.9,
                    probabilities: peaked(keys, answer),
                  },
                },
              },
            };
          }),
        );
        expect(result.status).toBe(status);
        // Exactly one question, carrying no action operation and no target to
        // choose — there is nothing on the page to act on or name.
        expect(asked).toHaveLength(1);
        expect([...asked[0]!.names].sort()).toEqual([
          "blocked_by_layer",
          "dead_end",
          "goal_complete",
          "last_action_worked",
          "operation",
        ]);
        expect([...asked[0]!.operationCriteria].sort()).toEqual([
          "BLOCKED",
          "DONE",
          "GO_BACK",
          "NONE_OF_THESE",
          "WAIT",
        ]);
        // The question says to judge from the page text, so the prose that
        // carries the only confirmation evidence has to be in it. The document
        // has no heading — title and headings alone would say nothing.
        expect(asked[0]!.pageText).toContain("Your order is confirmed. #1042");
        expect(result.trajectory.filter((step) => step.action === "wait")).toHaveLength(
          DRIVE_EMPTY_SNAPSHOT_WAITS,
        );
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("keeps re-observing a control-free page while the terminal answer is WAIT", async () => {
    // A processor/3-D Secure screen stays blank well past the three-wait
    // budget, then settles into the order confirmation.
    const SETTLING_HTML = `<!doctype html><meta charset="utf-8"><title>Blank</title>
<main><p id="body">Processing…</p></main>
<script>
  setTimeout(() => {
    document.querySelector("#body").textContent = "Your order is confirmed. #1042";
  }, 6000);
</script>`;
    const { context, started } = await openFixture(SETTLING_HTML, "settling.test");
    try {
      const seen: string[] = [];
      const criteriaOf = (question: JevQuestion | undefined): string[] =>
        question?.type === "choice" ? Object.keys(question.criteria) : [];
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "buy one item", max_seconds: 40 },
        api(),
        undefined,
        deps(async (_api, state, questions) => {
          const keys = criteriaOf(questions.operation);
          const text = (state as { page?: { text?: string } }).page?.text ?? "";
          seen.push(text);
          const pick = text.includes("Your order is confirmed") ? "DONE" : "WAIT";
          return {
            attempts: 1,
            elapsedMs: 5,
            result: {
              answers: {
                operation: { choice: pick, confidence: 0.9, probabilities: peaked(keys, pick) },
              },
            },
          };
        }),
      );
      // The drive kept settling past the 4.5s re-observation budget instead of
      // forcing a verdict, and completed once the confirmation rendered.
      expect(result.status).toBe("complete");
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[0]).toContain("Processing…");
      expect(seen.at(-1)).toContain("Your order is confirmed. #1042");
      expect(result.trajectory.filter((step) => step.action === "wait").length).toBeGreaterThan(
        DRIVE_EMPTY_SNAPSHOT_WAITS,
      );
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("does not accept a terminal DONE once the page moved under the decision", async () => {
    // The thank-you page renders while the terminal answer is in flight, so
    // the blank snapshot the answer was formed against is already stale.
    const LATE_HTML = `<!doctype html><meta charset="utf-8"><title>Blank</title>
<main><p id="body">Processing…</p></main>`;
    const { context, page, started } = await openFixture(LATE_HTML, "late-swap.test");
    try {
      let calls = 0;
      const criteriaOf = (question: JevQuestion | undefined): string[] =>
        question?.type === "choice" ? Object.keys(question.criteria) : [];
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "buy one item", max_seconds: 30 },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          calls += 1;
          const keys = criteriaOf(questions.operation);
          if (calls === 1) {
            await page.evaluate(() => {
              document.querySelector("main")!.innerHTML =
                '<p id="body">Your order is confirmed. #1042</p><button id="again">Buy again</button>';
            });
          }
          const pick = "DONE";
          return {
            attempts: 1,
            elapsedMs: 5,
            result: {
              answers: {
                operation: { choice: pick, confidence: 0.9, probabilities: peaked(keys, pick) },
              },
            },
          };
        }),
      );
      expect(result.status).toBe("complete");
      // The first DONE was refused against the fresh snapshot, so the drive
      // asked again rather than reporting the stale control-free page.
      expect(calls).toBeGreaterThan(1);
      expect(result.observation?.safe_table?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("reports a malformed DONE on a control-free page as invalid_answer, not stuck", async () => {
    const { context, started } = await openFixture(CONFIRMATION_HTML, "blank-unbacked.test");
    try {
      let calls = 0;
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "buy one item" },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          calls += 1;
          const keys = Object.keys(choiceCriteria(questions.operation));
          const rest = 0.3 / Math.max(1, keys.length - 1);
          const probabilities: Record<string, number> = {};
          for (const key of keys) probabilities[key] = key === "BLOCKED" ? 0.7 : rest;
          // argmax is BLOCKED; validateChoiceReason rejects this as
          // choice_not_argmax everywhere else in the drive.
          return {
            attempts: 1,
            elapsedMs: 5,
            result: {
              answers: {
                operation: { choice: "DONE", confidence: 0.9, probabilities },
              },
            },
          };
        }),
      );
      // A purchase that was never submitted must not be reported complete, and
      // a model that answered garbage is not a blocking page: the host's
      // recovery for the two differs.
      expect(result.status).toBe("invalid_answer");
      expect(result.reason).toBe("choice_not_argmax");
      expect(calls).toBe(2);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("reports a DONE carrying no probabilities as invalid_answer", async () => {
    const { context, started } = await openFixture(CONFIRMATION_HTML, "blank-noprob.test");
    try {
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "buy one item" },
        api(),
        undefined,
        deps(async () => ({
          attempts: 1,
          elapsedMs: 5,
          result: { answers: { operation: { choice: "DONE", confidence: 0.9 } } },
        })),
      );
      expect(result.status).toBe("invalid_answer");
      expect(result.reason).toBe("missing_probabilities");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("refuses a DONE when a control-free page changed only its text", async () => {
    // The optimistic interstitial is replaced by the real PSP result while the
    // answer is in flight. Both snapshots are control-free at the same URL, so
    // only the text can say the page moved.
    const INTERSTITIAL_HTML = `<!doctype html><meta charset="utf-8"><title>Blank</title>
<main><p id="body">Thank you! We're placing your order…</p></main>`;
    const { context, page, started } = await openFixture(INTERSTITIAL_HTML, "decline-swap.test");
    try {
      const seen: string[] = [];
      let calls = 0;
      const criteriaOf = (question: JevQuestion | undefined): string[] =>
        question?.type === "choice" ? Object.keys(question.criteria) : [];
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "buy one item", max_seconds: 30 },
        api(),
        undefined,
        deps(async (_api, state, questions) => {
          calls += 1;
          seen.push((state as { page?: { text?: string } }).page?.text ?? "");
          if (calls === 1) {
            await page.evaluate(() => {
              document.querySelector("#body")!.textContent =
                "Payment declined — your card was not charged.";
            });
          }
          const keys = criteriaOf(questions.operation);
          const pick = calls === 1 ? "DONE" : "BLOCKED";
          return {
            attempts: 1,
            elapsedMs: 5,
            result: {
              answers: {
                operation: { choice: pick, confidence: 0.9, probabilities: peaked(keys, pick) },
              },
            },
          };
        }),
      );
      // The DONE was formed against the interstitial; by the time it landed the
      // page said the payment failed, so it must not be reported complete.
      expect(result.status).not.toBe("complete");
      expect(calls).toBeGreaterThan(1);
      expect(seen[0]).toContain("Thank you! We're placing your order");
      expect(seen.at(-1)).toContain("Payment declined");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("checks DONE against a fresh snapshot even on an unchanged page", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "done-unchanged.test");
    try {
      let snapshots = 0;
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.onSnapshot = () => {
        snapshots += 1;
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "confirm the page is open" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(result.jev_calls).toBe(1);
      expect(snapshots).toBe(2);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("recaptures when the page changes while DONE is being decided", async () => {
    const { context, page, started } = await openFixture(NOOP_HTML, "done-changing.test");
    try {
      let snapshots = 0;
      let decisions = 0;
      const dependencies = deps(async (_api, _state, questions) => {
        decisions += 1;
        if (decisions === 1) {
          await page.evaluate(() => {
            document.querySelector("#status")!.textContent = "changed";
          });
        }
        return jevFromQuestions(questions, true);
      });
      dependencies.onSnapshot = () => {
        snapshots += 1;
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "confirm the page is open" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(result.jev_calls).toBe(1);
      expect(snapshots).toBe(2);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["checked", "disabled", "url", "frame"])(
    "reconsiders DONE when %s changes during the decision",
    async (change) => {
      const html = `<main><label>Notifications <input id="setting" type="checkbox" checked></label>
        <iframe srcdoc='<label>Frame setting <input value=original></label>'></iframe></main>`;
      const { context, page, started } = await openFixture(html, "done-state.test");
      try {
        let decisions = 0;
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "inspect settings",
            ...(change === "frame" ? { facts: { card_ref: "fixture-card" } } : {}),
          },
          api(),
          undefined,
          deps(async (_api, _state, questions) => {
            decisions += 1;
            if (decisions === 1) {
              if (change === "frame") {
                await page.frames()[1]!.evaluate(() => {
                  document.querySelector<HTMLInputElement>("input")!.value = "updated";
                });
              } else {
                await page.evaluate((kind) => {
                  const setting = document.querySelector<HTMLInputElement>("#setting")!;
                  if (kind === "checked") setting.checked = false;
                  if (kind === "disabled") setting.disabled = true;
                  if (kind === "url") history.pushState({}, "", "/updated");
                }, change);
              }
            }
            return jevFromQuestions(questions, true);
          }),
        );
        expect(result.status).toBe("complete");
        expect(decisions).toBe(2);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("retries an identical snapshot when content moves after capture", async () => {
    const { context, page, started } = await openFixture(NOOP_HTML, "capture-race.test");
    try {
      let snapshots = 0;
      let decisions = 0;
      const dependencies = deps(async (_api, state, questions) => {
        decisions += 1;
        if (decisions === 2) expect(JSON.stringify(state)).toMatch(/ready.now/i);
        return jevFromQuestions(questions, decisions > 1);
      });
      dependencies.onSnapshot = async () => {
        snapshots += 1;
        if (snapshots === 2) {
          await page.evaluate(() => {
            document.querySelector("button")!.textContent = "Ready now";
          });
        }
      };
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "click and inspect" },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).toBe("complete");
      expect(decisions).toBe(2);
      expect(snapshots).toBe(4);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("adopts a popup whose initial response takes 150ms", async () => {
    const html = `<main><a href="/destination" target="_blank">Open destination</a></main>`;
    const { context, started } = await openFixture(html, "delayed-popup.test");
    try {
      await context.route("**/destination", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ contentType: "text/html", body: "<main>Destination ready</main>" });
      });
      let decisions = 0;
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "open destination" },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          decisions += 1;
          return jevFromQuestions(questions, decisions > 1);
        }),
      );
      expect(result.status).toBe("complete");
      expect(result.observation?.url).toBe("https://delayed-popup.test/destination");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("completes a multi-step signup in one call", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-complete.test");
    try {
      let round = 0;
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test", company: "Acme" },
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          round += 1;
          return jevFromQuestions(questions, round > 3);
        }),
      );
      expect(handoff.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("ada@fixture.test");
      expect(handoff.trajectory.length).toBeGreaterThanOrEqual(3);
      expect(handoff.observation?.session_id).toBe(started.session_id);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("rewrites a rejected two-digit expiry with the four-digit year", async () => {
    // The control states no year length anywhere the drive can read, so the
    // first write is the two-digit form. It then refuses that value, which is
    // the only thing that can escalate to the four-digit year.
    const html = `<!doctype html><meta charset="utf-8"><title>Long expiry</title>
<main>
  <label>Card number <input id="pan" autocomplete="cc-number"></label>
  <label>CVV <input id="cvv" autocomplete="cc-csc"></label>
  <label>Expiration date <input id="exp" required></label>
  <p id="writes" hidden></p>
</main>
<script>
  const exp = document.getElementById("exp");
  const writes = document.getElementById("writes");
  exp.addEventListener("input", () => {
    writes.textContent = writes.textContent + exp.value + ";";
    if (!/^\\d{2}\\/\\d{4}$/.test(exp.value)) exp.value = "";
  });
</script>`;
    const { context, page, started } = await openFixture(html, "expiry-rewrite.test");
    try {
      const session = sessionForCall(started.session_id)!;
      const card = {
        pan: "4111111111111111",
        cvv: "739",
        exp_month: "12",
        exp_year: "2030",
        name: "Ada",
        billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
      };
      session.releasedPaymentCard = {
        approvalId: "approved",
        approvalUrl: "https://approval.test",
        checkout: {
          merchant: "fixture.test",
          checkout_origin: "https://expiry-rewrite.test",
          amount_cents: 100,
          currency: "USD",
        },
        cardRef: "card-1",
        last4: "1111",
        deadline: Date.now() + 60_000,
        card,
      };
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "fill the card expiry",
          facts: { card_ref: "card-1" },
          max_steps: 4,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => jevFromQuestions(questions, true)),
      );
      expect(result.status).not.toBe("stuck");
      expect(await page.locator("#writes").textContent()).toBe("12/30;12/2030;");
      expect(await page.locator("#exp").inputValue()).toBe("12/2030");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("keeps the four-digit expiry rewrite available after a stale act typed nothing", async () => {
    // A rewrite the act never performed must not consume the one-shot: the
    // remounted-frame stale result used to leave the control empty for the
    // rest of the session with no path back.
    const html = `<!doctype html><meta charset="utf-8"><title>Long expiry stale</title>
<main>
  <label>Card number <input id="pan" autocomplete="cc-number"></label>
  <label>CVV <input id="cvv" autocomplete="cc-csc"></label>
  <label>Expiration date <input id="exp" required></label>
  <p id="writes" hidden></p>
</main>
<script>
  const exp = document.getElementById("exp");
  const writes = document.getElementById("writes");
  exp.addEventListener("input", () => {
    writes.textContent = writes.textContent + exp.value + ";";
    if (!/^\\d{2}\\/\\d{4}$/.test(exp.value)) exp.value = "";
  });
</script>`;
    const { context, page, started } = await openFixture(html, "expiry-rewrite-stale.test");
    try {
      const session = sessionForCall(started.session_id)!;
      session.releasedPaymentCard = {
        approvalId: "approved",
        approvalUrl: "https://approval.test",
        checkout: {
          merchant: "fixture.test",
          checkout_origin: "https://expiry-rewrite-stale.test",
          amount_cents: 100,
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
          name: "Ada",
          billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
        },
      };
      // Jev only ever fills the iteration the stale act yields; every write
      // under test comes from the drive's own expiry handling.
      const dependencies = deps(async (_api, _state, questions) => {
        const answers: Record<string, JevAnswer> = {};
        for (const [name, question] of Object.entries(questions)) {
          if (question.type !== "choice") continue;
          const keys = Object.keys(question.criteria);
          if (keys.length === 0) continue;
          const pick = name === "operation" && keys.includes("WAIT") ? "WAIT" : keys[0]!;
          answers[name] = { choice: pick, confidence: 0.93, probabilities: peaked(keys, pick) };
        }
        return { attempts: 1, elapsedMs: 12, result: { answers } };
      });
      let staled = 0;
      dependencies.driveAct = async (_sessionId, action) => {
        if (action.kind === "type" && action.text === "12/2030" && staled === 0) {
          staled += 1;
          return {
            kind: "stale",
            reason: "card frame remounted",
          };
        }
        return await actThroughShared(started.session_id, action);
      };
      const drive = async (maxSteps: number) =>
        await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "fill the card expiry",
            facts: { card_ref: "card-1" },
            max_steps: maxSteps,
          },
          api(),
          undefined,
          dependencies,
        );
      await drive(3);
      expect(staled).toBe(1);
      expect(await page.locator("#writes").textContent()).toBe("12/30;");
      expect(await page.locator("#exp").inputValue()).toBe("");

      await drive(2);
      expect(await page.locator("#writes").textContent()).toBe("12/30;12/2030;");
      expect(await page.locator("#exp").inputValue()).toBe("12/2030");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("rewrites a rejected two-digit expiry written by an earlier operate_drive call", async () => {
    // The short write and the rewrite land in separate calls, so the read-back
    // correction has to survive the call that wrote the two-digit form.
    const html = `<!doctype html><meta charset="utf-8"><title>Long expiry resume</title>
<main>
  <label>Card number <input id="pan" autocomplete="cc-number"></label>
  <label>CVV <input id="cvv" autocomplete="cc-csc"></label>
  <label>Expiration date <input id="exp" required></label>
  <p id="writes" hidden></p>
</main>
<script>
  const exp = document.getElementById("exp");
  const writes = document.getElementById("writes");
  exp.addEventListener("input", () => {
    writes.textContent = writes.textContent + exp.value + ";";
    if (!/^\\d{2}\\/\\d{4}$/.test(exp.value)) exp.value = "";
  });
</script>`;
    const { context, page, started } = await openFixture(html, "expiry-rewrite-resume.test");
    try {
      const session = sessionForCall(started.session_id)!;
      session.releasedPaymentCard = {
        approvalId: "approved",
        approvalUrl: "https://approval.test",
        checkout: {
          merchant: "fixture.test",
          checkout_origin: "https://expiry-rewrite-resume.test",
          amount_cents: 100,
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
          name: "Ada",
          billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
        },
      };
      const drive = async (maxSteps: number) =>
        await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "fill the card expiry",
            facts: { card_ref: "card-1" },
            max_steps: maxSteps,
          },
          api(),
          undefined,
          deps(async (_api, _state, questions) => jevFromQuestions(questions, true)),
        );
      await drive(1);
      expect(await page.locator("#writes").textContent()).toBe("12/30;");
      expect(await page.locator("#exp").inputValue()).toBe("");

      await drive(2);
      expect(await page.locator("#writes").textContent()).toBe("12/30;12/2030;");
      expect(await page.locator("#exp").inputValue()).toBe("12/2030");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("carries a real control's maxlength through the snapshot into the expiry write", async () => {
    // A split year input that can only hold two digits. Written with "2030" the
    // browser keeps "20", the gateway declines, and nothing in the drive
    // records a reason — so the width has to reach the fact routing.
    const SPLIT_EXPIRY_HTML = `<!doctype html><meta charset="utf-8"><title>Split expiry</title>
<main>
  <label>Card number <input id="pan" autocomplete="cc-number"></label>
  <label>Expiration month <input id="m" maxlength="2"></label>
  <label>Expiration year <input id="y" maxlength="2"></label>
  <label>Name <input id="n"></label>
</main>`;
    const { context, page, started } = await openFixture(SPLIT_EXPIRY_HTML, "split-expiry.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      const rows = driveRowsFromSnapshot(snap) as unknown as WireRow[];
      const yearRow = rows.find((row) => (row[2] ?? "").includes("Expiration year"));
      const nameRow = rows.find((row) => (row[2] ?? "").includes("Name"));
      expect(yearRow).toBeDefined();
      expect(nameRow).toBeDefined();
      if (yearRow === undefined || nameRow === undefined) return;
      // The declared width reaches the row; a control without one carries none.
      expect(yearRow[2]).toContain("w=2");
      expect(nameRow[2]).not.toContain("w=");

      const facts = applyReleasedCardFacts(
        { card_ref: "card-1" },
        { exp_month: "12", exp_year: "2030", name: "Ada" },
      );
      const key = matchingFactKeys(facts, yearRow)[0];
      expect(key).toBeDefined();
      const value = facts[key!]!;
      expect(value).toBe("30");

      const typed = await actThroughShared(started.session_id, { kind: "type", target: yearRow[0], text: value }, snap);
      expect(typed.kind).toBe("ok");
      await settleDriveStep(page, typed.kind === "ok" && typed.combobox);
      expect(await page.locator("#y").inputValue()).toBe("30");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("snapshots visible-text labels and all headings, then acts through the registry", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-snapshot.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      expect(snap.headings).toEqual(expect.arrayContaining(["Create account"]));
      expect(snap.elements.some((element) => element.label.includes("Email"))).toBe(true);
      expect(snap.elements.some((element) => element.label.includes("Continue"))).toBe(true);
      expect(JSON.stringify(snap.elements)).not.toContain("zurich-largest-city");
      const rows = driveRowsFromSnapshot(snap);
      expect(rows.some((row) => (row[2] ?? "").includes("Email"))).toBe(true);
      const email = snap.elements.find((element) => element.label.includes("Email"));
      expect(email).toBeDefined();
      if (email === undefined) return;
      const typed = await actThroughShared(started.session_id, {
        kind: "type",
        target: email.ref,
        text: "ada@fixture.test",
      }, snap);
      expect(typed.kind).toBe("ok");
      await settleDriveStep(page, typed.kind === "ok" && typed.combobox);
      expect(await page.locator("#email").inputValue()).toBe("ada@fixture.test");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("follows a verification link after submit when no OTP field is listed", async () => {
    const host = "link-verify.test";
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = `https://${host}/`;
    await page.route("**/*", (route) => {
      const requested = route.request().url();
      const body = requested.includes("/verified") ? VERIFIED_HTML : LINK_VERIFY_HTML;
      return route.fulfill({ contentType: "text/html", body });
    });
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, state, questions) => {
        const pageUrl =
          typeof state === "object" &&
          state !== null &&
          "page" in state &&
          typeof (state as { page?: { url?: string } }).page?.url === "string"
            ? (state as { page: { url: string } }).page.url
            : "";
        if (pageUrl.includes("/verified")) return jevFromQuestions(questions, true);
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return {
          attempts: 1,
          elapsedMs: 12,
          result: {
            answers: {
              operation: {
                choice: "BLOCKED",
                confidence: 0.7,
                probabilities: peaked(opKeys, "BLOCKED", 0.7),
              },
            },
          },
        };
      });
      dependencies.awaitVerification = async (sessionId) => ({
        session_id: sessionId,
        found: true,
        code: null,
        link: `https://${host}/verified`,
      });
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account and confirm the email",
          facts: { email: "ada@fixture.test" },
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.trajectory.some((step) => step.action === "goto_verify")).toBe(true);
      expect(handoff.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("Email confirmed");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("polls an empty inbox then follows the verification link", async () => {
    const host = "inbox-poll.test";
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = `https://${host}/`;
    await page.route("**/*", (route) => {
      const requested = route.request().url();
      const body = requested.includes("/verified") ? VERIFIED_HTML : LINK_VERIFY_HTML;
      return route.fulfill({ contentType: "text/html", body });
    });
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, state, questions) => {
        const pageUrl =
          typeof state === "object" &&
          state !== null &&
          "page" in state &&
          typeof (state as { page?: { url?: string } }).page?.url === "string"
            ? (state as { page: { url: string } }).page.url
            : "";
        if (pageUrl.includes("/verified")) return jevFromQuestions(questions, true);
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return {
          attempts: 1,
          elapsedMs: 12,
          result: {
            answers: {
              operation: {
                choice: "BLOCKED",
                confidence: 0.7,
                probabilities: peaked(opKeys, "BLOCKED", 0.7),
              },
            },
          },
        };
      });
      let inboxReads = 0;
      dependencies.awaitVerification = async (sessionId) => {
        inboxReads += 1;
        if (inboxReads < 2) {
          return { session_id: sessionId, found: false, code: null, link: null };
        }
        return {
          session_id: sessionId,
          found: true,
          code: null,
          link: `https://${host}/verified`,
        };
      };
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account and confirm the email",
          facts: { email: "ada@fixture.test" },
        },
        api(),
        undefined,
        dependencies,
      );
      expect(inboxReads).toBeGreaterThanOrEqual(2);
      expect(handoff.status).not.toBe("needs_value");
      expect(handoff.trajectory.some((step) => step.action === "goto_verify")).toBe(true);
      expect(handoff.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("Email confirmed");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("waits on a disabled post-submit form, then follows the verification link", async () => {
    const host = "disabled-form.test";
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = `https://${host}/`;
    await page.route("**/*", (route) => {
      const requested = route.request().url();
      const body = requested.includes("/verified") ? VERIFIED_HTML : DISABLED_FORM_HTML;
      return route.fulfill({ contentType: "text/html", body });
    });
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, state, questions) => {
        const pageUrl =
          typeof state === "object" &&
          state !== null &&
          "page" in state &&
          typeof (state as { page?: { url?: string } }).page?.url === "string"
            ? (state as { page: { url: string } }).page.url
            : "";
        if (pageUrl.includes("/verified")) return jevFromQuestions(questions, true);
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return {
          attempts: 1,
          elapsedMs: 12,
          result: {
            answers: {
              operation: {
                choice: "BLOCKED",
                confidence: 0.7,
                probabilities: peaked(opKeys, "BLOCKED", 0.7),
              },
            },
          },
        };
      });
      dependencies.awaitVerification = async (sessionId) => ({
        session_id: sessionId,
        found: true,
        code: null,
        link: `https://${host}/verified`,
      });
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account and confirm the email",
          facts: { email: "ada@fixture.test" },
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.trajectory.some((step) => step.action === "wait")).toBe(true);
      expect(handoff.trajectory.some((step) => step.action === "goto_verify")).toBe(true);
      expect(handoff.status).toBe("complete");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("invokes the captcha solver on a disabled submit and continues after injection", async () => {
    const host = "captcha-gate.test";
    const { context, page, started } = await openFixture(CAPTCHA_GATE_HTML, host);
    try {
      let nowMs = 0;
      const solverCalls: string[] = [];
      const dependencies = deps(async (_api, state, questions) => {
        const pageUrl =
          typeof state === "object" &&
          state !== null &&
          "page" in state &&
          typeof (state as { page?: { url?: string } }).page?.url === "string"
            ? (state as { page: { url: string } }).page.url
            : "";
        if (pageUrl.includes("done") || (await page.locator("#done").count()) > 0) {
          return jevFromQuestions(questions, true);
        }
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return jevFromQuestions(questions, true);
      });
      dependencies.now = () => nowMs;
      dependencies.awaitVerification = async (sessionId) => {
        nowMs += 45_000;
        return { session_id: sessionId, found: false, code: null, link: null };
      };
      dependencies.attemptCaptchaAutoSolve = async (_session, target) => {
        solverCalls.push("solve");
        // First call is the post-submit refresh (fetch still running).
        // Inject on the widget-unready retry, which is the stuck-branch hook.
        if (solverCalls.length === 1) return "fetch_started";
        const unlock = target ?? page;
        const gated = await unlock.evaluate(() => {
          const btn = document.getElementById("continue") as HTMLButtonElement | null;
          if (btn === null || btn.dataset.gated !== "1") return false;
          btn.disabled = false;
          btn.dataset.unlocked = "1";
          return true;
        });
        return gated ? "injected" : "no_challenge";
      };
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
          max_seconds: 120,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(solverCalls.length).toBeGreaterThanOrEqual(1);
      expect(handoff.status).toBe("complete");
      expect(handoff.reason ?? "").not.toMatch(/gate widget/);
      expect(await page.locator("#done").count()).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("finishes with the page message after a delivered captcha, without a second solve", async () => {
    const host = "captcha-consumed.test";
    const { context, page, started } = await openFixture(CAPTCHA_CONSUMED_MESSAGE_HTML, host);
    try {
      const solverCalls: string[] = [];
      const dependencies = deps(async (_api, _state, questions) => {
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return jevFromQuestions(questions, true);
      });
      dependencies.attemptCaptchaAutoSolve = async () => {
        solverCalls.push("solve");
        await page.evaluate(() => {
          const consume = (window as unknown as { consumeDeliveredToken?: () => void })
            .consumeDeliveredToken;
          consume?.();
        });
        return "injected";
      };
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
          max_seconds: 20,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(solverCalls).toEqual(["solve"]);
      expect(handoff.status).not.toBe("budget");
      expect(handoff.reason ?? "").toContain(
        "This email address has been used to sign up too recently.",
      );
      expect(handoff.seconds).toBeLessThan(15);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("retypes a field whose first entry dropped the last character", async () => {
    const { context, page, started } = await openFixture(
      DROPPED_LAST_CHAR_HTML,
      "typed-retry.test",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        if ((await page.locator("#done").count()) > 0) return jevFromQuestions(questions, true);
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return jevFromQuestions(questions, true);
      });
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { first_name: "Squire", email: "ada@fixture.test" },
          max_seconds: 20,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      expect(handoff.reason ?? "").not.toMatch(/typed First name/);
      expect(await page.locator("#done").textContent()).toContain("Squire");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("waits out a slow submit instead of finishing stuck on already_settled", async () => {
    const { context, page, started } = await openFixture(SLOW_SUBMIT_NEXT_HTML, "slow-submit.test");
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        if ((await page.locator("#next").count()) > 0) return jevFromQuestions(questions, true);
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return jevFromQuestions(questions, true);
      });
      dependencies.attemptCaptchaAutoSolve = async () => "already_settled";
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
          max_seconds: 20,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.reason ?? "").not.toMatch(/already_settled/);
      expect(handoff.status).not.toBe("stuck");
      expect(await page.locator("#next").count()).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("stops a two-page no-op submit loop with a cycle or no-response reason", async () => {
    const host = "cycle.test";
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = `https://${host}/login`;
    await page.route("**/*", (route) => {
      const requested = new URL(route.request().url());
      const body = requested.pathname.includes("signup") ? CYCLE_SIGNUP_HTML : CYCLE_LOGIN_HTML;
      return route.fulfill({ contentType: "text/html", body });
    });
    await page.goto(url);
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: url,
      format: "compact",
      initialObservation: "standard",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        const typeKeys = Object.keys(choiceCriteria(questions.TYPE_TEXT_target));
        if (typeKeys.length > 0) return jevFromQuestions(questions);
        const clickCriteria = choiceCriteria(questions.CLICK_target);
        const continueKey = Object.keys(clickCriteria).find((key) =>
          (clickCriteria[key] ?? "").toLowerCase().includes("continue"),
        );
        const opKeys = Object.keys(choiceCriteria(questions.operation));
        if (continueKey !== undefined) {
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: "CLICK",
                  confidence: 0.93,
                  probabilities: peaked(opKeys, "CLICK"),
                },
                CLICK_target: {
                  choice: continueKey,
                  confidence: 0.93,
                  probabilities: peaked(Object.keys(clickCriteria), continueKey),
                },
              },
            },
          };
        }
        return jevFromQuestions(questions);
      });
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
          max_steps: 12,
          max_seconds: 20,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("no_progress");
      expect(handoff.reason ?? "").toMatch(/cycling|did not respond/);
      expect(handoff.steps).toBeLessThanOrEqual(8);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("returns needs_value naming a field with no matching fact, then resume completes", async () => {
    const { context, page, started } = await openFixture(SIGNUP_HTML, "signup-missing.test");
    try {
      const companyRef = refFor(started, "@company");
      const missing = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test" },
        },
        api(),
        undefined,
        deps(async () => {
          throw new Error("jev should not run for a required field with no fact");
        }),
      );
      expect(missing.status).toBe("needs_value");
      expect(missing.field).toMatch(/company/i);
      let round = 0;
      const resumed = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          facts: { email: "ada@fixture.test", company: "Acme" },
          answer: companyRef,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          round += 1;
          return jevFromQuestions(questions, round > 2);
        }),
      );
      expect(resumed.status).toBe("complete");
      expect(await page.locator("#done").textContent()).toContain("Acme");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("returns no_progress when the chosen action does not change the page", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-noop.test");
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "click the button that does nothing",
          max_steps: 5,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => jevFromQuestions(questions)),
      );
      expect(handoff.status).toBe("no_progress");
      expect(handoff.trajectory.length).toBeGreaterThanOrEqual(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("never reports complete on a stalled form the planner cannot act on", async () => {
    const { context, page, started } = await openFixture(STALLED_HTML, "signup-stalled.test");
    try {
      const offered: string[][] = [];
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          max_steps: 4,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          const operations = Object.keys(choiceCriteria(questions.operation));
          offered.push(operations);
          // A planner that would rather wait out the server than claim success.
          const pick = operations.includes("WAIT") ? "WAIT" : operations[0]!;
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: pick,
                  confidence: 0.93,
                  probabilities: peaked(operations, pick),
                },
              },
            },
          };
        }),
      );
      expect(offered.length).toBeGreaterThanOrEqual(1);
      for (const operations of offered) expect(operations).not.toEqual(["DONE"]);
      expect(handoff.status).not.toBe("complete");
      expect(await page.locator("#create").isDisabled()).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("bounds the settle wait on a form that never settles", async () => {
    const { context, started } = await openFixture(NEVER_SETTLES_HTML, "signup-never-settles.test");
    try {
      const offered: string[][] = [];
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "create an account",
          max_steps: 8,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          const operations = Object.keys(choiceCriteria(questions.operation));
          offered.push(operations);
          const pick = operations.includes("BLOCKED") ? "BLOCKED" : operations[0]!;
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: pick,
                  confidence: 0.93,
                  probabilities: peaked(operations, pick),
                },
              },
            },
          };
        }),
      );
      const waits = handoff.trajectory.filter((step) => step.action === "wait");
      expect(waits.length).toBeLessThanOrEqual(DRIVE_EMPTY_SNAPSHOT_WAITS);
      expect(handoff.status).not.toBe("budget");
      expect(handoff.status).not.toBe("complete");
      expect(offered).toHaveLength(1);
      expect([...offered[0]!].sort()).toEqual(["BLOCKED", "DONE", "GO_BACK", "NONE_OF_THESE"]);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("keeps offering WAIT on a blank page past the automatic empty-snapshot waits", async () => {
    const { context, started } = await openFixture(
      BLANK_PROCESSOR_HTML,
      "blank-processor.test",
      "standard",
      "/checkouts/cn9",
    );
    try {
      const offered: string[][] = [];
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "complete the purchase",
          max_steps: 5,
        },
        api(),
        undefined,
        deps(async (_api, _state, questions) => {
          const operations = Object.keys(choiceCriteria(questions.operation));
          offered.push(operations);
          const pick = operations.includes("WAIT") ? "WAIT" : operations[0]!;
          return {
            attempts: 1,
            elapsedMs: 12,
            result: {
              answers: {
                operation: {
                  choice: pick,
                  confidence: 0.93,
                  probabilities: peaked(operations, pick),
                },
              },
            },
          };
        }),
      );
      expect(offered.length).toBeGreaterThanOrEqual(1);
      for (const operations of offered) expect(operations).toContain("WAIT");
      expect(handoff.status).not.toBe("complete");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("returns jev_unavailable when the client budget is exhausted", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-jev.test");
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "anything",
        },
        api(),
        undefined,
        deps(async () => {
          throw new JevUnavailableError("jev_unavailable: retried 503/503", [503, 503], 2, 400);
        }),
      );
      expect(handoff.status).toBe("jev_unavailable");
      expect(handoff.jev_retried).toContain("503");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("refuses a second in-flight drive as busy", async () => {
    const { context, started } = await openFixture(NOOP_HTML, "signup-busy.test");
    try {
      const { sessionForCall } = await import("../session/lifecycle.js");
      const session = sessionForCall(started.session_id);
      expect(session).toBeDefined();
      if (session === undefined) return;
      session.drive = {
        running: true,
        goal: "already running",
        facts: {},
        trajectory: [],
        history: [],
        filledRefs: [],
        expiryShortWrittenRefs: [],
        expiryLongAttemptedRefs: [],
        lastQuestion: null,
        lastActionKey: null,
        lastFingerprint: null,
        jevCalls: 1,
        staleNonWait: 0,
        boundFingerprint: null,
        consumedActionKey: null,
        lastActProfile: null,
      };
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "another drive" },
        api(),
      );
      expect(handoff.status).toBe("busy");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("scrolls an offscreen Country combobox into view then acts", async () => {
    // Storefront and checkout themes commonly set smooth scrolling. A scroll
    // that honours it animates asynchronously, so the guard would measure the
    // pre-scroll rect and burn the attempt it scrolled to save.
    const html = `<!doctype html><title>Country picker</title>
<style>html { scroll-behavior: smooth }</style>
<main style="padding-top:1800px;padding-bottom:120px">
  <div role="combobox" aria-label="Country" id="country" tabindex="0"
    style="width:200px;height:40px" onclick="document.querySelector('#options').hidden=false">Choose country</div>
  <div id="options" hidden><button onclick="
    document.querySelector('#country').textContent='Canada';
    document.querySelector('#options').hidden=true;
  ">Canada</button></div>
</main>`;
    const { context, page, started } = await openFixture(html, "country-offscreen-scroll.test");
    const outcomes: string[] = [];
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        const head = questions.CLICK_target;
        const target =
          head?.type === "choice"
            ? Object.keys(head.criteria).find((key) => head.criteria[key] === "Canada")
            : undefined;
        if (target === undefined) return jevFromQuestions(questions, true);
        const result = jevFromQuestions(questions);
        for (const [name, pick] of [
          ["operation", "CLICK"],
          ["CLICK_target", target],
        ] as const) {
          const question = questions[name];
          if (question?.type !== "choice") throw new Error(`missing ${name}`);
          result.result.answers[name] = {
            choice: pick,
            confidence: 0.93,
            probabilities: peaked(Object.keys(question.criteria), pick),
          };
        }
        return result;
      });
      dependencies.driveAct = async (_sessionId, action) => {
        const result = await actThroughShared(started.session_id, action);
        outcomes.push(result.kind);
        return result;
      };
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Choose Canada as the country",
          facts: { country: "Canada" },
          max_steps: 8,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      expect(outcomes[0]).toBe("ok");
      expect(outcomes).not.toContain("stale");
      expect(await page.locator("#country").textContent()).toBe("Canada");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("yields an occluded Country combobox to model recovery before retrying", async () => {
    const html = `<!doctype html><title>Country picker</title>
<main>
  <div role="combobox" aria-label="Country" id="country" tabindex="0"
    style="width:200px;height:40px" onclick="document.querySelector('#options').hidden=false">Choose country</div>
  <div id="options" hidden><button onclick="
    document.querySelector('#country').textContent='Canada';
    document.querySelector('#options').hidden=true;
  ">Canada</button></div>
</main>
<div id="cover" style="position:absolute;top:0;left:0;width:220px;height:60px"></div>
<button style="margin-top:80px" onclick="document.querySelector('#cover').remove();this.remove()">Dismiss</button>`;
    const { context, page, started } = await openFixture(html, "country-occluded.test");
    const outcomes: string[] = [];
    let modelCalls = 0;
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        modelCalls += 1;
        if (modelCalls > 2) return jevFromQuestions(questions, true);
        if (modelCalls === 1) {
          expect(outcomes).toEqual(["stale"]);
          expect(await page.locator("#options").isVisible()).toBe(false);
        } else {
          expect(outcomes).toEqual(["stale", "ok", "ok"]);
          expect(await page.locator("#options").isVisible()).toBe(true);
        }
        const head = questions.CLICK_target;
        if (head?.type !== "choice") throw new Error("missing CLICK recovery");
        const target = Object.keys(head.criteria).find(
          (key) => head.criteria[key] === (modelCalls === 1 ? "Dismiss" : "Canada"),
        );
        if (target === undefined) throw new Error("missing recovery target");
        const result = jevFromQuestions(questions);
        for (const [name, pick] of [
          ["operation", "CLICK"],
          ["CLICK_target", target],
        ] as const) {
          const question = questions[name];
          if (question?.type !== "choice") throw new Error(`missing ${name}`);
          result.result.answers[name] = {
            choice: pick,
            confidence: 0.93,
            probabilities: peaked(Object.keys(question.criteria), pick),
          };
        }
        return result;
      });
      dependencies.driveAct = async (_sessionId, action) => {
        const result = await actThroughShared(started.session_id, action);
        outcomes.push(result.kind);
        if (outcomes.length === 1) {
          expect(result.kind).toBe("stale");
          await page.locator("#country").evaluate((element) => {
            element.setAttribute("aria-label", "Country choice");
          });
        }
        return result;
      };
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Choose Canada as the country",
          facts: { country: "Canada" },
          max_steps: 8,
        },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      expect(modelCalls).toBe(3);
      expect(outcomes).toEqual(["stale", "ok", "ok", "ok"]);
      expect(await page.locator("#country").textContent()).toBe("Canada");
      expect(handoff.trajectory[0]?.action).toBe("click");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["button", "option"])(
    "yields Billing Country's Canada %s without marking Shipping Country filled",
    async (role) => {
      const { context, page, started } = await openFixture(
        `<!doctype html><title>Shipping and billing</title>
<div id="shipping" role="combobox" aria-label="Shipping Country" tabindex="0"
  onclick="window.shippingClicks=(window.shippingClicks||0)+1">United States</div>
<div id="billing" role="combobox" aria-label="Billing Country" aria-controls="billing-menu"
  aria-expanded="true" tabindex="0">United States</div>
<div id="billing-menu" role="listbox"><div role="${role}" tabindex="0" onclick="
  document.querySelector('#billing').textContent='Canada';
  document.querySelector('#billing-menu').hidden=true;
">Canada</div></div>`,
        `country-ownership-${role}.test`,
      );
      const ask = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
        expect(await page.locator("#shipping").textContent()).toBe("United States");
        expect(await page.locator("#billing").textContent()).toBe("United States");
        expect(await page.evaluate("window.shippingClicks || 0")).toBe(0);
        expect(sessionForCall(started.session_id)?.drive?.filledRefs).toEqual([]);
        return jevFromQuestions(questions, true);
      });
      try {
        const handoff = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "Choose Canada for Shipping Country",
            facts: { country: "Canada" },
            max_steps: 1,
          },
          api(),
          undefined,
          deps(ask),
        );
        expect(ask).toHaveBeenCalledOnce();
        expect(handoff.trajectory).toEqual([]);
        expect(sessionForCall(started.session_id)?.drive?.filledRefs).toEqual([]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("attempts an unchanged fact-backed combobox only once before asking the model", async () => {
    const { context, page, started } = await openFixture(
      `<!doctype html><title>Country picker</title>
<div role="combobox" aria-label="Country" tabindex="0" onclick="window.clicks=(window.clicks||0)+1">Choose country</div>`,
      "country-noop.test",
    );
    const ask = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
      expect(await page.evaluate("window.clicks")).toBe(1);
      return jevFromQuestions(questions, true);
    });
    try {
      const handoff = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "Choose Canada as the country",
          facts: { country: "Canada" },
          max_steps: 5,
        },
        api(),
        undefined,
        deps(ask),
      );
      expect(ask).toHaveBeenCalledOnce();
      expect(handoff.status).toBe("complete");
      expect(await page.evaluate("window.clicks")).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("keeps offscreen fields and drops offscreen buttons off a checkout", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Picker viewport</title>
<main style="min-height:4000px">
  <label>Departure <input id="dep" aria-haspopup="dialog"></label>
  <label>Company <input id="company" style="position:absolute;top:5000px"></label>
  <button type="button" id="done">Done</button>
  <div id="days">${Array.from(
    { length: 40 },
    (_, i) =>
      `<button type="button" style="position:absolute;top:${3000 + i * 40}px">Day ${i + 1}</button>`,
  ).join("")}</div>
</main>`;
    const { context, page, started } = await openFixture(html, "picker-viewport.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      const labels = snap.elements.map((element) => element.label);
      expect(labels.some((label) => label.includes("Departure"))).toBe(true);
      expect(labels.some((label) => label.includes("Company"))).toBe(true);
      expect(labels).toContain("Done");
      expect(labels.filter((label) => /^Day \d+$/.test(label))).toEqual([]);
      const company = snap.elements.find((element) => element.label.includes("Company"));
      expect(company?.offscreen).toBe(true);
      expect(company?.role).toBe("textbox");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("keeps an offscreen checkout submit button whatever its language", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<main style="min-height:4000px">
  <label>Card number <input id="pan"></label>
  <button type="button" id="pay" style="position:absolute;top:1458px">Payer maintenant</button>
</main>`;
    const { context, page, started } = await openFixture(
      html,
      "whitejade.xyz",
      "standard",
      "/checkouts/cn/hWNH38PujD9hoKo3tgk00iw6/fr",
    );
    try {
      const snap = await captureFrameSnapshot(page, [], 0, true);
      expect(snap).not.toBeNull();
      if (snap === null) return;
      const pay = snap.elements.find((element) => element.label === "Payer maintenant");
      expect(pay?.offscreen).toBe(true);
      expect(pay?.role).toBe("button");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("types into the remounted overlay input a picker click focused", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Origin picker</title>
<label>Where from? <input id="from" role="combobox" aria-haspopup="listbox" value="Philadelphia"></label>
<div id="overlay"></div>
<script>
  document.getElementById("from").addEventListener("click", () => {
    setTimeout(() => {
      const input = document.createElement("input");
      input.id = "else";
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-label", "Where else?");
      input.value = "Philadelphia";
      const list = document.createElement("div");
      list.setAttribute("role", "listbox");
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = "Philadelphia, Pennsylvania";
      list.appendChild(option);
      document.getElementById("overlay").replaceChildren(input, list);
      input.focus();
      input.select();
      input.addEventListener("input", () => {
        const typed = input.value;
        setTimeout(() => {
          option.textContent = typed.includes("Zurich")
            ? "Zurich Airport (ZRH)"
            : "Philadelphia, Pennsylvania";
        }, 80);
      });
    }, 80);
  });
</script>`;
    const { context, page, started } = await openFixture(html, "picker-overlay-type.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const from = snap?.elements.find((element) => element.label.includes("Where from?"));
      expect(from).toBeDefined();
      if (from === undefined) return;
      const typed = await actThroughShared(started.session_id, {
        kind: "type",
        target: from.ref,
        text: "Zurich",
      }, snap);
      expect(typed.kind).toBe("ok");
      expect(await page.locator("#else").inputValue()).toBe("Zurich");
      await expect
        .poll(async () => page.locator('[role="option"]').textContent())
        .toBe("Zurich Airport (ZRH)");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("waits for date-grid cells after a click-open", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Date picker</title>
<label>Departure <input id="dep" aria-haspopup="dialog" readonly></label>
<div id="cal"></div>
<script>
  document.getElementById("dep").addEventListener("click", () => {
    setTimeout(() => {
      const grid = document.createElement("div");
      grid.setAttribute("role", "grid");
      const cell = document.createElement("button");
      cell.setAttribute("role", "gridcell");
      cell.textContent = "Sunday, September 20, 2026";
      grid.appendChild(cell);
      document.getElementById("cal").appendChild(grid);
    }, 80);
  });
</script>`;
    const { context, page, started } = await openFixture(html, "date-settle.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const departure = snap?.elements.find((element) => element.label.includes("Departure"));
      expect(departure).toBeDefined();
      if (departure === undefined) return;
      const acted = await actThroughShared(started.session_id, { kind: "click", target: departure.ref }, snap);
      expect(acted.kind).toBe("ok");
      if (acted.kind !== "ok") return;
      expect(acted.combobox).toBe(true);
      const waited = await settleDriveStep(page, acted.combobox);
      expect(waited).toBeGreaterThan(0);
      expect(await page.locator('[role="gridcell"]').count()).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("returns a snapshot on a lazily-growing DOM instead of walking forever", async () => {
    // Exercise drive capture without first walking the growing DOM through
    // general observation during fixture setup.
    const { context, page, started } = await openFixture(GROWING_HTML, "growing.test", "drive");
    try {
      await page.waitForTimeout(50);
      const startedAt = Date.now();
      const snapshot = await captureFrameSnapshot(page, [], 0);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.timedOut).not.toBe(true);
      expect(snapshot?.elements.some((element) => element.label === "Keep")).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not finish on a dialog that shows only a masked secret and creates at most once", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Keys</title>
<main>
  <button type="button" id="create">Create API key</button>
  <dialog id="dlg" open>
    <label>API key <input id="key" value="tvly-dev-****abcd"></label>
    <button type="button" id="copy">Copy</button>
    <button type="button" id="close">Close</button>
  </dialog>
</main>
<script>
  window.createClicks = 0;
  document.getElementById("create").onclick = () => { window.createClicks += 1; };
</script>`;
    const { context, page, started } = await openFixture(html, "dialog-key.test", "drive");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 6 },
        api(),
        undefined,
        dependencies,
      );
      // A masked value is not an unmasked secret: the drive must not report
      // complete, and must not loop creating keys.
      const createClicks = await page.evaluate(
        () => (window as unknown as { createClicks: number }).createClicks,
      );
      expect(createClicks).toBeLessThanOrEqual(1);
      expect(result.status).not.toBe("complete");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("dismisses a fixed consent overlay before checking the box under it", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Signup</title>
<main>
  <form>
    <label><input type="checkbox" id="terms"> I agree to the terms</label>
    <button type="button" id="join">Create account</button>
  </form>
</main>
<div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:40;display:flex;align-items:center;justify-content:center">
  <div style="background:#fff;padding:24px">
    <p>We use cookies</p>
    <button type="button" id="accept">Accept all</button>
  </div>
</div>
<script>
  document.getElementById("accept").onclick = () => document.getElementById("overlay").remove();
  document.getElementById("join").onclick = () => {
    if (!document.getElementById("terms").checked) return;
    document.querySelector("main").innerHTML = "<p id=done>Account created</p>";
  };
</script>`;
    const { context, page, started } = await openFixture(html, "overlay-consent.test", "drive");
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "create an account", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(await page.locator("#overlay").count()).toBe(0);
      expect(await page.locator("#done").count()).toBe(1);
      expect(result.status).not.toBe("no_progress");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("masks a secret-shaped value in a select option", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Tokens</title>
<label>Token <select id="tok"><option>choose</option><option>${DRIVE_FIXTURE_KEY}</option></select></label>`;
    const { context, started } = await openFixture(html, "secret-option.test", "drive");
    try {
      let leaked = false;
      const dependencies = deps(async (_api, state, questions) => {
        if (JSON.stringify({ state, questions }).includes(DRIVE_FIXTURE_KEY)) leaked = true;
        return jevFromQuestions(questions, true);
      });
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 3 },
        api(),
        undefined,
        dependencies,
      );
      expect(leaked).toBe(false);
      expect(JSON.stringify(result)).not.toContain(DRIVE_FIXTURE_KEY);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("clicks Create key after leaving and re-entering the keys page", async () => {
    const dash = `<!doctype html><meta charset="utf-8"><title>Dashboard</title>
<nav><a id="keys" href="/settings/keys">API Keys</a></nav>
<p>Dashboard</p>`;
    const keys = `<!doctype html><meta charset="utf-8"><title>API Keys</title>
<div role="tablist">
  <button type="button" role="tab" id="keys">API Keys</button>
  <button type="button" role="tab" id="general">General</button>
</div>
<section id="panel">
  <button type="button" id="create">Create key</button>
</section>
<script>
  document.getElementById("general").onclick = () => {
    document.getElementById("panel").innerHTML = "<p>Profile</p>";
  };
  document.getElementById("keys").onclick = () => {
    document.getElementById("panel").innerHTML =
      '<button type="button" id="create">Create key</button>';
    document.getElementById("create").onclick = () => {
      document.getElementById("panel").innerHTML = '<p id="secret">${DRIVE_FIXTURE_KEY}</p>';
    };
  };
  document.getElementById("create").onclick = () => {
    document.getElementById("panel").innerHTML = '<p id="secret">${DRIVE_FIXTURE_KEY}</p>';
  };
</script>`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      route.fulfill({
        contentType: "text/html",
        body: url.includes("/settings/keys") ? keys : dash,
      });
    });
    await page.goto("https://reenter-keys.test/dashboard");
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: "https://reenter-keys.test/dashboard",
      format: "compact",
      initialObservation: "drive",
    });
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 10 },
        api(),
        undefined,
        dependencies,
      );
      expect(result.status).not.toBe("no_progress");
      expect(result.reason ?? "").not.toMatch(/^API Keys$/);
      expect(await page.locator("#secret").count()).toBe(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("stops after one retry when OAuth returns to the same login page", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Login</title>
<main>
  <h1>Sign in</h1>
  <button type="button" id="google">Continue with Google</button>
</main>
<script>
  document.getElementById("google").onclick = () => {
    history.replaceState({}, "", "/login?state=" + Math.random().toString(36).slice(2));
  };
</script>`;
    const { context, page, started } = await openFixture(
      html,
      "oauth-bounce.test",
      "drive",
      "/login",
    );
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      dependencies.driveAct = async (sessionId, action) => {
        if (action.kind === "oauth_login") {
          await page.evaluate(() => {
            history.replaceState({}, "", `/login?state=${Math.random().toString(36).slice(2)}`);
          });
          return { kind: "ok", combobox: false } as const;
        }
        return await dispatchDriveAct(sessionId, action);
      };
      const result = await runOperateDrive(
        {
          session_id: started.session_id,
          goal: "sign up with Google using the account already signed in to this browser",
          max_steps: 8,
        },
        api(),
        undefined,
        dependencies,
      );
      const oauthSteps = result.trajectory.filter((step) => step.action === "oauth_login");
      expect(oauthSteps.length).toBeLessThanOrEqual(2);
      // A bounce dispatched and changed the page, so a cycle finish is
      // legitimate; the reason must still name the bounce, not the cycle.
      expect(result.status).toBe("no_progress");
      expect(result.reason ?? "").toMatch(/sign-in hand-off returned to the login page/);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});

describe("coverage-matrix constant", () => {
  it("stays in the measured gap between wrong and correct answers", () => {
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.41);
    expect(DRIVE_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(0.65);
  });
});

describe("drive review regressions", () => {
  it("masks dropdown choices and traces while selecting their original labels", async () => {
    const { context, page, started } = await openFixture(
      '<label>Saved method<select id="method"><option>Choose</option><option value="visa">Visa 41111111****1111</option></select></label>',
      "masked-options.test",
    );
    const dir = mkdtempSync(join(process.cwd(), ".drive-trace-test-"));
    const tracePath = join(dir, "trace.jsonl");
    const previousTrace = process.env.DRIVE_TRACE_PATH;
    process.env.DRIVE_TRACE_PATH = tracePath;
    try {
      sessionForCall(started.session_id)!.browser.registerCardValueOutputMask({
        pan: "4111111111111111",
        cvv: "739",
      });
      let calls = 0;
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "choose saved method", max_steps: 1 },
        api(),
        undefined,
        deps(async (_api, state, questions) => {
          calls++;
          expect(JSON.stringify({ state, questions })).not.toContain("41111111");
          const question = questions.SELECT_target;
          if (question?.type !== "choice") throw new Error("missing SELECT choices");
          const pick = Object.keys(question.criteria).find((key) =>
            question.criteria[key]!.includes("[card number]"),
          )!;
          expect(pick).toBeDefined();
          const outcome = jevFromQuestions(questions);
          outcome.result.answers.SELECT_target = {
            choice: pick,
            confidence: 0.93,
            probabilities: peaked(Object.keys(question.criteria), pick),
          };
          return outcome;
        }),
      );
      expect(calls).toBe(1);
      expect(result.status).toBe("budget");
      expect(await page.locator("#method").inputValue()).toBe("visa");
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).not.toContain("41111111");
      expect(trace).toContain("[card number]");
    } finally {
      if (previousTrace === undefined) delete process.env.DRIVE_TRACE_PATH;
      else process.env.DRIVE_TRACE_PATH = previousTrace;
      rmSync(dir, { recursive: true, force: true });
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it.each(["type", "select"])(
    "does not retain a completed %s ref after navigation",
    async (action) => {
      const html =
        action === "type"
          ? '<form action="/next"><label>Search <input id="field" type="search" name="q" oninput="location.href=\'/next\'"></label></form>'
          : '<label>Country <select id="field" onchange="location.href=\'/next\'"><option value="">Choose</option><option>Canada</option></select></label>';
      const { context, page, started } = await openFixture(html, "fill-navigation.test");
      try {
        await page.route("**/next*", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>Email <input id="email" type="email" required></label>',
          }),
        );
        const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "open form",
            facts: action === "type" ? { query: "hello" } : { country: "Canada" },
          },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe("needs_value");
        expect(result.field).toBe("Email");
        expect(await page.locator("#email").inputValue()).toBe("");
        expect(sessionForCall(started.session_id)!.drive!.filledRefs).toEqual([]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it.each(["same-origin", "cross-origin", "same-url", "srcdoc"])(
    "keeps reused hosted-field selectors frame-scoped (%s)",
    async (frameKind) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      let sessionId: string | undefined;
      try {
        const panUrl = "https://provider.test/pan";
        const cvvUrl =
          frameKind === "cross-origin"
            ? "https://cvv-provider.test/cvv"
            : "https://provider.test/cvv";
        await page.route(panUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>Card number <input id="field" autocomplete="cc-number"></label>',
          }),
        );
        await page.route(cvvUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<label>CVV <input id="field" autocomplete="cc-csc"></label>',
          }),
        );
        let frameMarkup = `<iframe id="pan" src="${panUrl}"></iframe><iframe id="cvv" src="${cvvUrl}"></iframe>`;
        if (frameKind === "same-url") {
          const shared = "https://provider.test/shared";
          await page.route(shared, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<label><span id="label"></span><input id="field"></label><script>document.querySelector('#label').textContent = window.name === 'pan' ? 'Card number' : 'CVV';</script>`,
            }),
          );
          frameMarkup = `<iframe id="pan" name="pan" src="${shared}"></iframe><iframe id="cvv" name="cvv" src="${shared}"></iframe>`;
        } else if (frameKind === "srcdoc") {
          frameMarkup = `<iframe id="pan" srcdoc="<label>Card number <input id='field'></label>"></iframe><iframe id="cvv" srcdoc="<label>CVV <input id='field'></label>"></iframe>`;
        }
        const url = "https://hosted-checkout.test/checkout";
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<input id="field" aria-label="Unrelated" value="unchanged">${frameMarkup}`,
          }),
        );
        await page.goto(url);
        const started = await startHarnessProvisionSession({
          browser: BrowserController.fromHarnessPage(page),
          serviceUrl: url,
          format: "compact",
        });
        sessionId = started.session_id;
        const card = {
          pan: "4111111111111111",
          cvv: "739",
          exp_month: "12",
          exp_year: "2030",
          name: "Ada",
          billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
        };
        const dependencies = deps(async () => {
          throw new Error("card fill should not call Jev");
        });
        let injections = 0;
        dependencies.injectCard = async (_session, args) => {
          injections += 1;
          expect(args.fields.pan?.ref).not.toBe(args.fields.cvv?.ref);
          const fields = await injectCardIntoSessionTargets(started.session_id, card, args.fields);
          expect(fields).toEqual({ pan: { status: "filled" }, cvv: { status: "filled" } });
          return { status: "card_injected", complete: true, fields };
        };
        const result = await runOperateDrive(
          {
            session_id: started.session_id,
            goal: "fill card",
            facts: { card_ref: "card" },
            max_steps: 1,
          },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe("budget");
        expect(injections).toBe(1);
        expect(await page.frameLocator("#pan").locator("#field").inputValue()).toBe(card.pan);
        expect(await page.frameLocator("#cvv").locator("#field").inputValue()).toBe(card.cvv);
        expect(await page.locator("#field").inputValue()).toBe("unchanged");
      } finally {
        if (sessionId !== undefined) await finishProvisionSession(sessionId);
        await context.close();
      }
    },
    30_000,
  );

  it("aborts a stalled card-ref lookup and returns evaluate_timeout without injection", async () => {
    const { context, page, started } = await openFixture(
      '<label>Card number <input id="pan"></label>',
      "lookup-timeout.test",
    );
    const controller = new AbortController();
    attachOperatorRequestAbort(controller.signal, (reason) => controller.abort(reason));
    const session = sessionForCall(started.session_id)!;
    const extract = session.browser.extractInteractiveElements.bind(session.browser);
    const frame = page.mainFrame();
    let evaluation: { mockRestore(): void } | undefined;
    const extraction = vi
      .spyOn(session.browser, "extractInteractiveElements")
      .mockImplementation(async (...args) => {
        const fresh = await extract(...args);
        evaluation = vi
          .spyOn(frame, "evaluate")
          .mockImplementationOnce(() => new Promise(() => undefined));
        return fresh;
      });
    try {
      await page.goto("https://lookup-timeout.test/checkout");
      const dependencies = deps(async () => {
        throw new Error("unexpected Jev call");
      });
      const injection = vi.fn(async () => ({ status: "unused" }));
      dependencies.injectCard = injection;
      const result = await withOperatorRequestContext(controller.signal, () =>
        runOperateDrive(
          { session_id: started.session_id, goal: "fill card", facts: { card_ref: "card" } },
          api(),
          undefined,
          dependencies,
        ),
      );
      expect(result.status).toBe("evaluate_timeout");
      expect(controller.signal.aborted).toBe(true);
      expect(injection).not.toHaveBeenCalled();
    } finally {
      evaluation?.mockRestore();
      extraction.mockRestore();
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("acts on a page whose drive snapshot fell back to the tools observation", async () => {
    // The in-page snapshot refuses a document whose body it cannot read, so the
    // loop runs on rows the drive's own identity map never recorded. Those refs
    // belong to the tools' observation and must still reach the page: reporting
    // a live control stale here loses the provision with an empty trajectory.
    const html = `<!doctype html><meta charset="utf-8"><title>Fallback</title>
<main><button id="go" onclick="document.querySelector('#status').textContent='clicked'">Accept and continue</button>
<p id="status">idle</p></main>
<script>Object.defineProperty(document, "body", { get: () => null, configurable: true });</script>`;
    const { context, page, started } = await openFixture(html, "snapshot-fallback.test");
    try {
      expect(await captureFrameSnapshot(page, [], 0)).toBeNull();
      let decisions = 0;
      const dependencies = deps(async (_api, _state, questions) => {
        decisions += 1;
        return jevFromQuestions(questions, decisions > 1);
      });
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "accept and continue" },
        api(),
        undefined,
        dependencies,
      );
      expect(await page.locator("#status").textContent()).toBe("clicked");
      expect(result.status).toBe("complete");
      expect(result.trajectory).toHaveLength(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("keeps re-deciding when the page changes under the decision instead of ending the drive", async () => {
    // A page that changes between the snapshot and the act must never end the
    // drive: the act was never dispatched, so no-progress is a false reason to
    // stop. The old three-strike bound ended this run on the third change; the
    // re-decide path is now excluded from no-progress accounting entirely, so
    // the run keeps deciding until the page settles and still reaches the goal.
    const html = `<!doctype html><meta charset="utf-8"><title>Live control</title>
<main>
  <a id="go" href="/details">Show details</a>
  <input id="agree" type="checkbox" disabled aria-label="Live agreement">
</main>`;
    const { context, page, started } = await openFixture(html, "redecide.test");
    try {
      // The link's destination is the real outcome the drive must still reach
      // after re-deciding through more changes than the old bound allowed.
      await page.route("**/details", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><title>Details</title><main><h1>Details</h1><p id="done">Here are the details</p></main>',
        }),
      );
      // The change is made by the decider's own turn, after the snapshot the
      // decision came from: exactly the window the pre-act check watches. It is
      // a control-state change (checked), not a value or a page-text tick, so
      // only a real page change re-decides.
      let decisions = 0;
      // More page changes than the old three-strike bound allowed (which ended
      // the drive on the third).
      const changes = 3;
      const dependencies = deps(async (_api, _state, questions) => {
        decisions += 1;
        if (decisions <= changes) {
          await page.evaluate(() => {
            const box = document.querySelector("#agree");
            if (box instanceof HTMLInputElement) box.checked = !box.checked;
          });
        }
        return jevFromQuestions(questions, decisions > changes + 1);
      });
      const result = await runOperateDrive(
        { session_id: started.session_id, goal: "show details" },
        api(),
        undefined,
        dependencies,
      );
      // More changes than the old bound allowed is only meaningful evidence if
      // the loop actually re-decided on them: a run that skipped the guard
      // would decide twice (click, then DONE), not once per change plus the act.
      expect(decisions).toBeGreaterThanOrEqual(changes + 1);
      expect(page.url()).toContain("/details");
      expect(result.status).toBe("complete");
      const clicks = result.trajectory.filter((step) => step.action === "click");
      expect(clicks).toHaveLength(1);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it("registers compact injection refs and retries after four incomplete fills", async () => {
    const { context, page, started } = await openFixture(
      '<label>Card number <input id="pan" autocomplete="cc-number"></label><label>CVV <input id="cvv" autocomplete="cc-csc"></label>',
      "checkout.test",
    );
    try {
      await page.goto("https://checkout.test/checkout");
      const session = sessionForCall(started.session_id)!;
      expect(session.compactV2Active).toBe(true);
      const card = {
        pan: "4111111111111111",
        cvv: "739",
        exp_month: "12",
        exp_year: "2030",
        name: "Ada",
        billing: { line1: "1 Main St", city: "Boston", postal_code: "02110", country: "US" },
      };
      let attempts = 0;
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      dependencies.injectCard = async (_session, args) => {
        attempts += 1;
        const fields = await injectCardIntoSessionTargets(started.session_id, card, args.fields);
        expect(fields).toEqual({ pan: { status: "filled" }, cvv: { status: "filled" } });
        session.releasedPaymentCard = {
          approvalId: "approved",
          approvalUrl: "https://approval.test",
          checkout: {
            merchant: "test",
            checkout_origin: "https://checkout.test",
            amount_cents: 100,
            currency: "USD",
          },
          cardRef: "card",
          last4: "1111",
          deadline: Date.now() + 60_000,
          card,
        };
        return { status: "card_injected", complete: attempts > 4, fields };
      };
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await runOperateDrive(
          { session_id: started.session_id, goal: "fill card", facts: { card_ref: "card" } },
          api(),
          undefined,
          dependencies,
        );
        expect(result.status).toBe(attempt <= 4 ? "card_incomplete" : "complete");
      }
      expect(attempts).toBe(5);
      expect(await page.locator("#pan").inputValue()).toBe(card.pan);
      expect(await page.locator("#cvv").inputValue()).toBe(card.cvv);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 60_000);

  it.each([
    "4111111111111111",
    "4111+1111+1111+1111",
    "4111%201111%201111%201111",
    "4111%C2%B71111%C2%B71111%C2%B71111",
  ])(
    "masks GET query card values before Jev and handoff serialization: %s",
    async (encodedPan) => {
      const { context, page, started } = await openFixture(NOOP_HTML, "card-query.test");
      try {
        const pan = "4111111111111111";
        sessionForCall(started.session_id)!.browser.registerCardValueOutputMask({
          pan,
          cvv: "739",
        });
        await page.goto(`https://card-query.test/?pan=${encodedPan}`);
        const urls: string[] = [];
        const dependencies = deps(async (_api, state, questions) => {
          const serialized = JSON.stringify(state);
          expect(serialized).not.toContain(pan);
          expect(
            new URL((state as { page: { url: string } }).page.url).searchParams.get("pan"),
          ).toBe("[card number]");
          urls.push((state as { page: { url: string } }).page.url);
          return jevFromQuestions(questions, true);
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await runOperateDrive(
            { session_id: started.session_id, goal: "read page" },
            api(),
            undefined,
            dependencies,
          );
          expect(result.status).toBe("complete");
          expect(JSON.stringify(result)).not.toContain(pan);
          expect(new URL(result.observation!.url).searchParams.get("pan")).toBe("[card number]");
        }
        expect(urls).toHaveLength(2);
        expect(urls[0]).toBe(urls[1]);
      } finally {
        await finishProvisionSession(started.session_id);
        await context.close();
      }
    },
    30_000,
  );

  it("does not type when the target is gone at act time", async () => {
    const { context, page, started } = await openFixture(
      '<label>Email <input id="email" value="original"></label><input id="other">',
      "reselect.test",
    );
    try {
      const snapshot = await captureFrameSnapshot(page, [], 0);
      const target = snapshot!.elements.find((element) => element.label.includes("Email"))!;
      await page.evaluate(() => document.querySelector("#email")?.remove());
      const result = await actThroughShared(
        started.session_id,
        { kind: "type", target: target.ref, text: "new value" },
        snapshot,
      );
      expect(result.kind).toBe("stale");
      expect(await page.locator("#other").inputValue()).toBe("");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not type when the in-page identity read times out", async () => {
    const { context, page, started } = await openFixture(
      '<label>Email <input id="email" value="original"></label><input id="other">',
      "reselect-timeout.test",
    );
    try {
      const snapshot = await captureFrameSnapshot(page, [], 0);
      const target = snapshot!.elements.find((element) => element.label.includes("Email"))!;
      const frame = page.mainFrame();
      const spy = vi
        .spyOn(frame, "evaluate")
        .mockRejectedValueOnce(new DriveEvaluateTimeout(1) as never);
      try {
        const result = await actThroughShared(
          started.session_id,
          { kind: "type", target: target.ref, text: "new value" },
          snapshot,
        );
        expect(result.kind).toBe("stale");
      } finally {
        spy.mockRestore();
      }
      expect(await page.locator("#other").inputValue()).toBe("");
      expect(await page.locator("#email").inputValue()).toBe("original");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});

describe("operate_drive feedback loop", () => {
  function setChoice(
    questions: Record<string, JevQuestion>,
    name: string,
    pick: string,
    result: JevCallOutcome,
  ): void {
    const question = questions[name];
    if (question?.type !== "choice") return;
    if (!(pick in question.criteria)) return;
    result.result.answers[name] = {
      choice: pick,
      confidence: 0.93,
      probabilities: peaked(Object.keys(question.criteria), pick),
    };
  }

  function pickByLabel(
    questions: Record<string, JevQuestion>,
    name: string,
    label: string,
    result: JevCallOutcome,
  ): boolean {
    const question = questions[name];
    if (question?.type !== "choice") return false;
    const pick = Object.keys(question.criteria).find((key) => question.criteria[key] === label);
    if (pick === undefined) return false;
    result.result.answers[name] = {
      choice: pick,
      confidence: 0.93,
      probabilities: peaked(Object.keys(question.criteria), pick),
    };
    return true;
  }

  async function driveRef(page: Page, label: string): Promise<string> {
    const snapshot = await captureFrameSnapshot(page, [], 0);
    if (snapshot === null) throw new Error("no drive snapshot");
    const rows = driveRowsFromSnapshot(snapshot);
    const row = rows.find((entry) => {
      const facts = String(entry[2] ?? "");
      return facts.split("|")[0] === label || facts.includes(label);
    });
    if (row === undefined) throw new Error(`missing ${label}`);
    return row[0];
  }

  it("records a never-executed click as not_executed, marks it tried, and never offers it again", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Workspace</title>
<main>
  <h1>Workspace</h1>
  <button id="broken">Broken</button>
  <button id="works" onclick="document.querySelector('main').innerHTML='<p id=done>Opened</p>'">Works</button>
</main>`;
    const { context, page, started } = await openFixture(html, "trail-not-executed.test");
    const seen: Array<{ state: Record<string, unknown>; questions: Record<string, JevQuestion> }> =
      [];
    try {
      const brokenRef = await driveRef(page, "Broken");
      const dependencies = deps(async (_api, state, questions) => {
        seen.push({
          state: state as Record<string, unknown>,
          questions: questions as Record<string, JevQuestion>,
        });
        const result = jevFromQuestions(questions, true);
        const wanted = seen.length === 1 ? "Broken" : "Works";
        if (pickByLabel(questions, "CLICK_target", wanted, result)) {
          setChoice(questions, "operation", "CLICK", result);
        }
        return result;
      });
      dependencies.driveAct = async (_sessionId, action) => {
        if (action.kind === "click" && action.target === brokenRef) {
          return { kind: "stale", reason: "occluded" };
        }
        return await actThroughShared(started.session_id, action);
      };
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "open the workspace", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(seen.length).toBeGreaterThanOrEqual(2);
      const trail = seen[1]!.state.trail as Array<{ outcome: string }>;
      expect(trail.at(-1)?.outcome).toMatch(/^not_executed:/);
      const elements = seen[1]!.state.elements as Array<{ description: string; tried?: boolean }>;
      expect(
        elements.some((element) => element.description === "Broken" && element.tried === true),
      ).toBe(true);
      // Withheld from the question criteria, so Jev cannot choose it again.
      const click = seen[1]!.questions.CLICK_target;
      const labels = click?.type === "choice" ? Object.values(click.criteria) : [];
      expect(labels).not.toContain("Broken");
      expect(handoff.status).toBe("complete");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("never counts the drive's own refusal toward a dead end, and names the refusal", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Workspace</title>
<main><h1>Workspace</h1><button id="advance">Continue</button></main>`;
    const { context, started } = await openFixture(html, "refused-act.test", "drive");
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        const result = jevFromQuestions(questions);
        // Once the control is withdrawn after the refusal, answer NONE_OF_THESE
        // so the drive reports why it stopped instead of inventing a DONE.
        const clickKeys = Object.keys(choiceCriteria(questions.CLICK_target));
        const operation = questions.operation;
        if (
          clickKeys.length === 0 &&
          operation?.type === "choice" &&
          operation.criteria.NONE_OF_THESE !== undefined
        ) {
          result.result.answers.operation = {
            choice: "NONE_OF_THESE",
            confidence: 0.93,
            probabilities: peaked(Object.keys(operation.criteria), "NONE_OF_THESE"),
          };
        }
        return result;
      });
      // The drive's OWN executor refuses every act before it reaches the page.
      dependencies.driveAct = async () => ({ kind: "stale", reason: "occluded" });
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "open the workspace", max_steps: 6 },
        api(),
        undefined,
        dependencies,
      );
      // The refusal is recorded as a not-executed step, never as progress.
      const trail = sessionForCall(started.session_id)?.drive?.outcomeTrail ?? [];
      expect(trail.some((entry) => entry.outcome === "not_executed:covered")).toBe(true);
      // The stop reason is the loop's own dispatch failure, not a description
      // of the unchanged page and not an exhausted-action tally.
      expect(handoff.reason ?? "").toMatch(/covered before|refused before/);
      expect(handoff.reason ?? "").not.toMatch(
        /nothing on the page can advance the goal|no change after/,
      );
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("records an OAuth hand-off that returns to the same path as bounced_back", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<main><h1>Sign in</h1><a id="google" href="/oauth/google">Continue with Google</a></main>`;
    const { context, page, started } = await openFixture(
      html,
      "oauth-bounce-trail.test",
      "standard",
      "/login",
    );
    let bounce = 0;
    try {
      const dependencies = deps(async (_api, _state, questions) => jevFromQuestions(questions));
      dependencies.driveAct = async (sessionId, action) => {
        if (action.kind === "oauth_login") {
          bounce += 1;
          await page.goto(`https://oauth-bounce-trail.test/login?state=s${bounce}`);
          return { kind: "ok", combobox: false } as const;
        }
        return await dispatchDriveAct(sessionId, action);
      };
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "sign in", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("no_progress");
      expect(handoff.reason).toMatch(/hand-off returned to the login page/i);
      expect(bounce).toBe(1);
      const trail = sessionForCall(started.session_id)?.drive?.outcomeTrail ?? [];
      expect(trail.map((entry) => entry.outcome)).toContain("bounced_back");
      expect(trail.every((entry) => !entry.page.includes("state="))).toBe(true);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("finishes a masked key only after the dry extraction sees an unmasked value", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <label>API key <input id="key" readonly value="re_****abcd"></label>
  <button id="reveal">Reveal</button>
</main>
<script>
  document.getElementById("reveal").addEventListener("click", () => {
    document.getElementById("key").value = "re_abcdefGHIJKLmnop1234567";
  });
</script>`;
    const { context, page, started } = await openFixture(html, "reveal-masked-key.test");
    const seen: Array<Record<string, unknown>> = [];
    try {
      const dependencies = deps(async (_api, state, questions) => {
        seen.push(state as Record<string, unknown>);
        return jevFromQuestions(questions, true);
      });
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      // The masked value never satisfied the dry extraction, so the drive had
      // to click Reveal before it could finish.
      expect(await page.locator("#key").inputValue()).toBe("re_abcdefGHIJKLmnop1234567");
      // And the ordinary extraction flow the caller runs stores that same value.
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.api_key).toBe("re_abcdefGHIJKLmnop1234567");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("clicks a create control on a permanently masked key list instead of finishing", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <table><tr><td>key one</td><td>re_****abcd</td></tr>
  <tr><td>key two</td><td>re_****efgh</td></tr></table>
  <button id="create" onclick="window.createClicks=(window.createClicks||0)+1;document.querySelector('table').outerHTML='<label>API key <input id=key readonly value=re_createdKey1234567890abc></label>'">Create key</button>
</main>`;
    const { context, page, started } = await openFixture(html, "create-key-masked-list.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      // The permanently masked rows never satisfied the dry extraction, so the
      // drive had to create a new key before it could finish.
      expect(await page.locator("#key").inputValue()).toBe("re_createdKey1234567890abc");
      expect(
        await page.evaluate(() => (window as unknown as { createClicks?: number }).createClicks),
      ).toBe(1);
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.api_key).toBe("re_createdKey1234567890abc");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not complete on a dashboard whose only secret-shaped text is a masked placeholder", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Overview</title>
<main>
  <h1>Overview</h1>
  <label>API key <input id="key" readonly placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxx"></label>
  <button id="copy" onclick="window.copyClicks=(window.copyClicks||0)+1">Copy</button>
</main>`;
    const { context, page, started } = await openFixture(html, "placeholder-dashboard.test");
    const seen: Array<Record<string, unknown>> = [];
    try {
      const dependencies = deps(async (_api, state, questions) => {
        seen.push(state as Record<string, unknown>);
        return jevFromQuestions(questions, true);
      });
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      // The placeholder is not a storable credential, so the drive never
      // reports the goal complete at step 0.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(handoff.status).not.toBe("complete");
      expect(handoff.status).toBe("stuck");
      expect(await page.locator("#key").inputValue()).toBe("");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("completes on a real unmasked key and the ordinary extraction stores it", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <label>API key <input id="key" readonly value="re_abcdefGHIJKLmnop1234567"></label>
</main>`;
    const { context, page, started } = await openFixture(html, "real-unmasked-key.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.api_key).toBe("re_abcdefGHIJKLmnop1234567");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("captures both same-family keys on a multi-key page", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Sandbox keys</title>
<main>
  <h1>Sandbox keys</h1>
  <label>Sandbox read <input id="read" readonly value="vsk_sandbox_read_Abc123def456Ghi789"></label>
  <label>Sandbox write <input id="write" readonly value="vsk_sandbox_write_Zyx987wvu654Tsr321"></label>
</main>`;
    const { context, started } = await openFixture(html, "two-family-keys.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.sandbox_read_key).toBe("vsk_sandbox_read_Abc123def456Ghi789");
      expect(extracted.credentials.sandbox_write_key).toBe("vsk_sandbox_write_Zyx987wvu654Tsr321");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("captures only the real key, not a cross-family widget token on the same page", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <label>API key <input id="key" readonly value="re_abcdefGHIJKLmnop1234567"></label>
  <label>Widget token <input id="widget" readonly value="mcp-4Y7FDyM9kL2pQ8rT6vW3xZ1"></label>
</main>`;
    const { context, started } = await openFixture(html, "cross-family-widget.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.api_key).toBe("re_abcdefGHIJKLmnop1234567");
      expect(Object.keys(extracted.credentials).sort()).toEqual(["api_key"]);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("answers NONE_OF_THESE instead of forcing a low-confidence click", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Welcome</title>
<main><h1>Welcome</h1><a id="learn" href="/docs">Learn more</a></main>`;
    const { context, started } = await openFixture(html, "none-of-these.test");
    const clicks: ProvisionAction[] = [];
    try {
      const dependencies = deps(async (_api, _state, questions) => {
        const result = jevFromQuestions(questions, true);
        setChoice(questions, "operation", "NONE_OF_THESE", result);
        return result;
      });
      dependencies.driveAct = async (_sessionId, action) => {
        clicks.push(action);
        return { kind: "stale", reason: "detached" };
      };
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("stuck");
      expect(handoff.reason).toMatch(/nothing on the page can advance the goal/i);
      expect(clicks).toEqual([]);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});

describe("capture flow key evidence", () => {
  const READ_KEY = "vsk_sandbox_read_Abc123def456Ghi789";
  const WRITE_KEY = "vsk_sandbox_write_Zyx987wvu654Tsr321";

  it("stores both sibling keys, never a checkbox identifier, and reports no masked remainder", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <label>Secret <input type="checkbox" id="secret" value="fallback123456789"></label>
  <label>Read key <input id="read" readonly value="${READ_KEY}"></label>
  <label>Write key</label>
  <p id="write">vsk_sandbox_write_20af…</p>
  <button id="reveal" type="button">Reveal</button>
</main>
<script>
  document.getElementById("reveal").addEventListener("click", () => {
    document.getElementById("write").textContent = "${WRITE_KEY}";
  });
</script>`;
    const { context, started } = await openFixture(html, "sibling-keys-checkbox.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      expect(handoff.status).toBe("complete");
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.sandbox_read_key).toBe(READ_KEY);
      expect(extracted.credentials.sandbox_write_key).toBe(WRITE_KEY);
      expect(extracted.credentials.secret).toBeUndefined();
      expect(Object.values(extracted.credentials)).not.toContain("fallback123456789");
      expect(extracted.masked_remaining ?? []).toEqual([]);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not report success while a masked sibling key stays masked", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>API keys</title>
<main>
  <h1>API keys</h1>
  <label>Read key <input id="read" readonly value="${READ_KEY}"></label>
  <label>Write key</label>
  <p id="write">vsk_sandbox_write_20af…</p>
  <button id="reveal" type="button">Reveal</button>
</main>
<script>
  // The reveal does nothing: the write key stays masked.
  document.getElementById("reveal").addEventListener("click", () => {});
</script>`;
    const { context, started } = await openFixture(html, "sibling-key-stays-masked.test");
    try {
      const dependencies = deps(async (_api, _state, questions) =>
        jevFromQuestions(questions, true),
      );
      const handoff = await runOperateDrive(
        { session_id: started.session_id, goal: "extract an API key", max_steps: 8 },
        api(),
        undefined,
        dependencies,
      );
      // The drive must not report complete: a credential-shaped value is still
      // masked, so the capture is incomplete.
      expect(handoff.status).not.toBe("complete");
      expect(handoff.status).toBe("stuck");
      expect(handoff.reason ?? "").toMatch(/still masked/i);
      const extracted = await extractCredentials(started.session_id);
      expect(extracted.credentials.sandbox_read_key).toBe(READ_KEY);
      expect((extracted.masked_remaining ?? []).length).toBeGreaterThan(0);
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not click a reminted ordinal that now belongs to another control", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Remint</title>
<nav id="nav">
  <a id="rep" href="/reputation">Reputation</a>
  <a id="set" href="/settings">Settings</a>
</nav>
<p id="hit">none</p>
<script>
  Array.from(document.querySelectorAll("a")).forEach(function (a) {
    a.addEventListener("click", function (event) {
      event.preventDefault();
      document.getElementById("hit").textContent = a.id;
    });
  });
</script>`;
    const { context, page, started } = await openFixture(html, "remint-ordinal.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const reputation = snap?.elements.find((element) => element.label === "Reputation");
      expect(reputation?.ref).toMatch(/^@e:f0d\d+$/);
      await page.evaluate(() => {
        const nav = document.getElementById("nav")!;
        nav.innerHTML = '<a id="new" href="/new">Create app</a><a id="set" href="/settings">Settings</a>';
        Array.from(nav.querySelectorAll("a")).forEach((a) => {
          a.addEventListener("click", (event: Event) => {
            event.preventDefault();
            document.getElementById("hit")!.textContent = a.id;
          });
        });
      });
      const result = await actThroughShared(
        started.session_id,
        { kind: "click", target: reputation!.ref },
        snap,
      );
      expect(result.kind).toBe("stale");
      expect(await page.locator("#hit").textContent()).toBe("none");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("does not act on a ref after navigation away from the decided page", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Nav</title>
<a id="rep" href="/reputation">Reputation</a>
<p id="hit">none</p>`;
    const { context, page, started } = await openFixture(html, "nav-stale.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const reputation = snap?.elements.find((element) => element.label === "Reputation");
      expect(reputation).toBeDefined();
      await page.route("**/next", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>Next</title><a id="rep" href="/other">Other</a><p id="hit">none</p>`,
        }),
      );
      await page.goto("https://nav-stale.test/next");
      const result = await actThroughShared(
        started.session_id,
        { kind: "click", target: reputation!.ref },
        snap,
      );
      expect(result.kind).toBe("stale");
      expect(await page.locator("#hit").textContent()).toBe("none");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);

  it("drive and operate_click agree on page result and staleness", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Parity</title>
<button id="go" type="button">Continue</button>
<p id="hit">none</p>
<script>
  document.getElementById("go").addEventListener("click", () => {
    document.getElementById("hit").textContent = "clicked";
  });
</script>`;
    const { context, page, started } = await openFixture(html, "act-parity.test");
    try {
      const snap = await captureFrameSnapshot(page, [], 0);
      const go = snap?.elements.find((element) => element.label === "Continue");
      expect(go).toBeDefined();
      const toolRef = refFor(started, "@continue");
      const driveClick = await actThroughShared(
        started.session_id,
        { kind: "click", target: go!.ref },
        snap,
      );
      expect(driveClick.kind).toBe("ok");
      expect(await page.locator("#hit").textContent()).toBe("clicked");

      await page.evaluate(() => {
        document.getElementById("hit")!.textContent = "none";
      });
      await act(started.session_id, { kind: "click", target: toolRef });
      expect(await page.locator("#hit").textContent()).toBe("clicked");

      await page.evaluate(() => {
        document.getElementById("go")?.remove();
        const next = document.createElement("button");
        next.id = "other";
        next.textContent = "Create app";
        next.addEventListener("click", () => {
          document.getElementById("hit")!.textContent = "trap";
        });
        document.body.appendChild(next);
        document.getElementById("hit")!.textContent = "none";
      });
      const driveStale = await actThroughShared(
        started.session_id,
        { kind: "click", target: go!.ref },
        snap,
      );
      expect(driveStale.kind).toBe("stale");
      let toolStale = "";
      try {
        await act(started.session_id, { kind: "click", target: toolRef });
      } catch (error) {
        toolStale = error instanceof Error ? error.message : String(error);
      }
      expect(toolStale).toMatch(/stale_ref|reobserve_required|target_stale/);
      expect(await page.locator("#hit").textContent()).toBe("none");
    } finally {
      await finishProvisionSession(started.session_id);
      await context.close();
    }
  }, 30_000);
});
