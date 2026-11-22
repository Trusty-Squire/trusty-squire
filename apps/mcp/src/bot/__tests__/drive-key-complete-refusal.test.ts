import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  emptyDriveState,
  isExistingCredentialMutationRow,
  runOperateDrive,
  type DriveDependencies,
} from "../operate-drive.js";
import { captureFrameSnapshot, driveRowsFromSnapshot } from "../drive-snapshot.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const STORED = { reference: "vault:example:default", service: "example", label: "default" };
const key = "re_abcdefGHIJKLmnop1234567";

// The Copy click is the source the drive stores a key from.
const copyKeyPage = `<main><h1>API keys</h1><div role="dialog" aria-label="API key created">
  <label>API key <input readonly value="${key}"></label>
  <button type="button" aria-label="Copy API key"
    onclick="navigator.clipboard.writeText('${key}')">Copy</button></div></main>`;

const orderConfirmationPage = `<main><h1>Confirmation #TPVQCHG5A</h1>
  <p>Your order is confirmed</p>
  <a href="/orders/TPVQCHG5A?_r=AQABU67ys2zHpjQ-qf-F9aIciaVmu5AD1dZrp8iPPu30NxrXXi8k">View order</a>
  <a href="/account?_r=AQABU67ys2zHpjQ-qf-F9aIciaVmu5AD1dZrp8iPPu30NxrXXi8k">Continue shopping</a>
</main>`;

async function withKeyPage(
  body: string,
  run: (sessionId: string) => Promise<void>,
  path = "/keys",
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `https://app.example.test${path}`;
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body,
    }),
  );
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  try {
    await run(started.session_id);
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}

function dependencies(askJev: DriveDependencies["askJev"]): DriveDependencies {
  return {
    askJev,
    act,
    observe,
    startSession: async () => {
      throw new Error("existing session");
    },
    awaitVerification,
    injectCard: async () => ({ status: "unused" }),
  };
}

it("captures a revealed key despite a binding from the previous page without asking", async () => {
  await withKeyPage(copyKeyPage, async (sessionId) => {
    const session = sessionForCall(sessionId)!;
    session.drive = emptyDriveState("extract an API key", {});
    session.drive.boundFingerprint = "previous page";
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
      attempts: 1,
      elapsedMs: 1,
      result: {
        answers: Object.fromEntries(
          Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice = name === "operation" ? "DONE" : keys[0]!;
            return [
              [
                name,
                {
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    keys.map((key) => [key, key === choice ? 1 : 0]),
                  ),
                },
              ],
            ];
          }),
        ),
      },
    }));
    const persistCredentials = vi.fn(async () => STORED);
    const result = await runOperateDrive(
      { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
      api,
      { persistCredentials },
      dependencies(askJev),
    );
    expect(persistCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { api_key: key },
      }),
    );
    expect(result).toMatchObject({
      status: "complete",
      stored: true,
      stored_credential: STORED,
      message:
        "Key stored in the vault as example/default (reference vault:example:default); the goal is complete.",
    });
    expect(askJev).not.toHaveBeenCalled();
  });
}, 15_000);

it("captures a Copy source on DONE even when the value has no recognized shape", async () => {
  const plainKey = "Ab3kZ9";
  await withKeyPage(
    `<main><dialog open aria-label="API key created">
    <p>${plainKey}</p>
    <button type="button" onclick="navigator.clipboard.writeText('${plainKey}')">Copy</button>
  </dialog></main>`,
    async (sessionId) => {
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).flatMap(([name, question]) => {
              if (question.type !== "choice") return [];
              const keys = Object.keys(question.criteria);
              const choice = name === "operation" ? "DONE" : keys[0]!;
              return [
                [
                  name,
                  {
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      keys.map((key) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ],
              ];
            }),
          ),
        },
      }));
      const persistCredentials = vi.fn(async () => STORED);
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
        api,
        { persistCredentials },
        dependencies(askJev),
      );
      expect(result.status).toBe("complete");
      expect(persistCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: { api_key: plainKey },
        }),
      );
      const session = sessionForCall(sessionId)!;
      expect(await session.browser.readClipboard(session.browser.page!)).toBe(plainKey);
    },
  );
}, 15_000);

it.each(["missing", "rejected", "failed"])(
  "does not complete DONE when storage is %s",
  async (mode) => {
    await withKeyPage(
      `<main><dialog open aria-label="API key created">
      <p>Ab3kZ9</p><button onclick="navigator.clipboard.writeText('Ab3kZ9')">Copy</button>
    </dialog></main>`,
      async (sessionId) => {
        const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
          attempts: 1,
          elapsedMs: 1,
          result: {
            answers: Object.fromEntries(
              Object.entries(questions).flatMap(([name, question]) => {
                if (question.type !== "choice") return [];
                const keys = Object.keys(question.criteria);
                const choice = name === "operation" ? "DONE" : keys[0]!;
                return [
                  [
                    name,
                    {
                      choice,
                      confidence: 1,
                      probabilities: Object.fromEntries(
                        keys.map((key) => [key, key === choice ? 1 : 0]),
                      ),
                    },
                  ],
                ];
              }),
            ),
          },
        }));
        const persistCredentials = vi.fn(async () => {
          if (mode === "failed") throw new Error("vault unavailable");
          return null;
        });
        const result = await runOperateDrive(
          { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
          api,
          mode === "missing" ? {} : { persistCredentials },
          dependencies(askJev),
        );
        expect(askJev).toHaveBeenCalled();
        expect(result.status).not.toBe("complete");
        if (mode !== "missing")
          expect(persistCredentials).toHaveBeenCalledWith(
            expect.objectContaining({ credentials: { api_key: "Ab3kZ9" } }),
          );
      },
    );
  },
  15_000,
);

it("trusts the model's DONE on a page without a key", async () => {
  await withKeyPage(
    "<main><h1>API keys</h1><button>Create key</button><p>No key yet</p></main>",
    async (sessionId) => {
      const session = sessionForCall(sessionId)!;
      session.drive = emptyDriveState("extract an API key", {});
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).flatMap(([name, question]) => {
              if (question.type !== "choice") return [];
              const keys = Object.keys(question.criteria);
              const choice = name === "operation" ? "DONE" : keys[0]!;
              return [
                [
                  name,
                  {
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      keys.map((key) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ],
              ];
            }),
          ),
        },
      }));
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "extract an API key", max_steps: 3, max_seconds: 10 },
        api,
        undefined,
        dependencies(askJev),
      );
      expect(askJev).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "complete", stored: false });
      expect(result).not.toHaveProperty("stored_credential");
    },
  );
}, 15_000);

it("completes a confirmed order with a key-shaped Shopify token only in link destinations", async () => {
  await withKeyPage(
    orderConfirmationPage,
    async (sessionId) => {
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(
            Object.entries(questions).flatMap(([name, question]) => {
              if (question.type !== "choice") return [];
              const keys = Object.keys(question.criteria);
              const choice = name === "operation" ? "DONE" : keys[0]!;
              return [
                [
                  name,
                  {
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      keys.map((key) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ],
              ];
            }),
          ),
        },
      }));
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "buy The Glow Serum", max_steps: 3, max_seconds: 10 },
        api,
        undefined,
        dependencies(askJev),
      );
      expect(askJev).toHaveBeenCalled();
      expect(result.status).toBe("complete");
      expect(JSON.stringify(result.observation?.safe_table)).not.toContain("@key-value");
    },
    "/thank-you",
  );
}, 15_000);

it.each([
  { label: "Rotate key", path: "/keys" },
  { label: "Delete key", path: "/keys" },
  { label: "Delete API key", path: "/keys", confidence: 0.4 },
  { label: "Revoke credential", path: "/keys" },
  { label: "Reset", path: "/keys" },
  { label: "Delete", path: "/settings" },
  // Kenari's Indonesian revoke and rotate (squire-1.1.57 L132-138).
  { label: "Cabut key", path: "/keys" },
  { label: "Ganti key", path: "/keys" },
  { label: "Ganti", path: "/keys" },
  { label: "Ganti", path: "/keys", container: "list" },
  { label: "Ganti", path: "/keys", container: "aria" },
  { label: "Badilisha", path: "/keys" },
])(
  "hands $label back before dispatch",
  async ({ label, path, confidence = 1, container = "table" }) => {
    await withKeyPage(
      `<main><h1>API keys</h1>${
        container === "list"
          ? `<ul><li>Production <code>sk_123456789abcdefghijk</code><button>${label}</button></li></ul>`
          : container === "aria"
            ? `<div role="table"><div role="row">Production <code>sk_123456789abcdefghijk</code><button>${label}</button></div></div>`
            : `<table><tbody><tr><td>Production <code>sk_123456789abcdefghijk</code></td><td><button>${label}</button></td></tr></tbody></table>`
      }</main>`,
      async (sessionId) => {
        const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async () => {
          throw new Error("mutation action must not dispatch");
        });
        const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
          attempts: 1,
          elapsedMs: 1,
          result: {
            answers: Object.fromEntries(
              Object.entries(questions).flatMap(([name, question]) => {
                if (question.type !== "choice") return [];
                const keys = Object.keys(question.criteria);
                const choice =
                  name === "operation"
                    ? "CLICK"
                    : name === "CLICK_target"
                      ? (keys.find((candidate) => question.criteria[candidate]?.includes(label)) ??
                        keys[0]!)
                      : keys[0]!;
                return [
                  [
                    name,
                    {
                      choice,
                      confidence,
                      probabilities: Object.fromEntries(
                        keys.map((key) => [key, key === choice ? 1 : 0]),
                      ),
                    },
                  ],
                ];
              }),
            ),
          },
        }));
        const result = await runOperateDrive(
          { session_id: sessionId, goal: "manage my API key", max_steps: 3, max_seconds: 3 },
          api,
          undefined,
          { ...dependencies(askJev), driveAct },
        );
        expect(result.status).toBe("stuck");
        expect(result.reason).toContain(`operator decision required before ${label}`);
        expect(result.reason).toContain("no action was dispatched");
        expect(driveAct).not.toHaveBeenCalled();
      },
      path,
    );
  },
  15_000,
);

it.each([
  { body: '<ul><li><button>Create key</button></li></ul>', guarded: false },
  { body: '<ul><li><button>Ganti workspace</button></li></ul>', guarded: false },
  { body: '<table><tr><td><button>Create key...</button></td></tr></table>', guarded: false },
  { body: '<ul><li>sk_live_••••<button>Ganti</button></li></ul>', guarded: true },
  { body: '<ul><li><input readonly value="d7bd...4a"><button>Ganti</button></li></ul>', guarded: true },
  { body: '<ul><li>d7bd...4a<button>Ganti</button></li></ul>', guarded: true },
  { body: '<table><tr><td>d7bd…4a</td><td><button>Cabut key</button></td></tr></table>', guarded: true },
  { body: '<ul><li>••••<button>Ganti</button></li></ul>', guarded: true },
  { body: '<ul><li><span hidden>••••</span><button>Create key</button></li></ul>', guarded: false },
  { body: '<ul><li><button>sk_123456789abcdefghijk</button></li></ul>', guarded: true },
  { body: '<ul><li><input readonly value="arbitrary"><button>Ganti</button></li></ul>', guarded: true },
  { body: `<ul><li>${"0123456789abcdef".repeat(4)}<button>Ganti</button></li></ul>`, guarded: true },
  { body: '<ul><li><input readonly type="password" value="arbitrary-format"><button>Ganti</button></li></ul>', guarded: true },
  { body: '<ul><li><input readonly type="password" value=""><button>Ganti</button></li></ul>', guarded: true },
  { body: '<ul><li><input readonly value="sk_123456789abcdefghijk"><button>Ganti</button></li></ul>', guarded: true },
  { body: '<dialog open><code>sk_123456789abcdefghijk</code><button>Copy</button></dialog>', guarded: false },
])("guards only credential-bearing rows: $body", async ({ body, guarded }) => {
  await withKeyPage(`<main>${body}</main>`, async (sessionId) => {
    const page = sessionForCall(sessionId)!.browser.page!;
    const snapshot = await captureFrameSnapshot(page, [], 0);
    expect(snapshot).not.toBeNull();
    const button = driveRowsFromSnapshot(snapshot!).find((row) => row[1] === "b");
    expect(button).toBeDefined();
    expect(isExistingCredentialMutationRow(button!)).toBe(guarded);
  });
});

it.each(["button", "menuitem"])("copies a key using a %s from the inline row just shown", async (role) => {
  const value = "0123456789abcdef".repeat(4);
  await withKeyPage(
    `<main><button type="button" onclick="document.querySelector('ul').hidden=false">Create key</button>
      <ul hidden><li><code>${value}</code>
        <button type="button" role="${role}" onclick="navigator.clipboard.writeText('${value}')">Copy</button>
        <button type="button">Ganti</button>
      </li></ul></main>`,
    async (sessionId) => {
      const page = sessionForCall(sessionId)!.browser.page!;
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate(() => navigator.clipboard.writeText(""));
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
        attempts: 1,
        elapsedMs: 1,
        result: {
          answers: Object.fromEntries(Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice = name === "operation" ? "CLICK" : name === "CLICK_target"
              ? keys.find((key) => question.criteria[key] === "Copy") ?? keys[0]!
              : keys[0]!;
            return [[name, {
              choice, confidence: 1,
              probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
            }]];
          })),
        },
      }));
      const result = await runOperateDrive(
        { session_id: sessionId, goal: "create and copy a key", max_steps: 3, max_seconds: 10 },
        api,
        undefined,
        dependencies(askJev),
      );
      const session = sessionForCall(sessionId)!;
      expect(await session.browser.readClipboard(session.browser.page!)).toBe(value);
      expect(result.reason ?? "").not.toContain("operator decision required");
    },
  );
}, 15_000);
