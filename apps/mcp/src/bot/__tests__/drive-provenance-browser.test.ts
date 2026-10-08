import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { extractCredentials } from "../capture/capture.js";
import { emptyDriveState, runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

let profile: string;
let context: BrowserContext;

beforeAll(async () => {
  // The Copy-click path needs a real clipboard, so this fixture runs in an
  // isolated persistent Chrome profile.
  profile = await mkdtemp(join(process.cwd(), ".drive-provenance-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});

afterAll(async () => {
  await context?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const goal = "extract an API key";

async function withPage(html: string, run: (sessionId: string) => Promise<void>): Promise<void> {
  await context.clearPermissions();
  // A harness session owns its page, so each drive gets a fresh one.
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/keys");
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: page.url(),
    format: "compact",
    initialObservation: "drive",
  });
  try {
    await run(started.session_id);
  } finally {
    await finishProvisionSession(started.session_id);
    await page.close();
  }
}

/** A Jev stub that always picks `operation` = DONE (or the first choice). */
function doneJev(): ReturnType<typeof vi.fn<DriveDependencies["askJev"]>> {
  return vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
    attempts: 1,
    elapsedMs: 1,
    result: {
      answers: Object.fromEntries(
        Object.entries(questions).flatMap(([name, question]) => {
          if (question.type !== "choice") return [];
          const keys = Object.keys(question.criteria);
          const choice = name === "operation" && keys.includes("DONE") ? "DONE" : keys[0]!;
          return [
            [
              name,
              {
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
              },
            ],
          ];
        }),
      ),
    },
  }));
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

/** A created-key dialog that shows only a stub; the key reaches the page only
 * as base64 inside the Copy button's click handler. */
function copyOnlyDialog(key: string): string {
  const stub = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-2)}` : "••••";
  return `<!doctype html><div role="dialog" aria-label="API key created">
    <h2>API key created</h2><label>API key <input readonly value="${stub}"></label>
    <button type="button" aria-label="Copy API key">Copy</button></div>
    <script>document.querySelector('[aria-label="Copy API key"]').addEventListener('click',
      () => navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
}

// Reproduction R1: a key-goal drive on a Copy-only page whose key has no known
// prefix. Extraction stores the key via the Copy click, so DONE must hold.
it.each([
  [
    "64-char lowercase hex (Vast)",
    "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a",
  ],
  ["short", "Ab3kZ9"],
  ["all-uppercase", "QWERTYUIOPASDFGHJKLZ"],
  ["UUID-like", "123e4567-e89b-12d3-a456-426614174000"],
  ["unprefixed mixed", "kq3ZpX9vLmT2"],
])(
  "completes a key-goal drive on a Copy-only %s key",
  async (_name, key) => {
    await withPage(copyOnlyDialog(key), async (sessionId) => {
      sessionForCall(sessionId)!.drive = emptyDriveState(goal, {});
      const askJev = doneJev();
      const result = await runOperateDrive(
        { session_id: sessionId, goal, max_steps: 3, max_seconds: 5 },
        api,
        undefined,
        dependencies(askJev),
      );
      expect(result.status, `${result.reason} | ${JSON.stringify(result.trajectory)}`).toBe(
        "complete",
      );
      // operate_finish extracts again: the repeat Copy click leaves the clipboard
      // unchanged, and the session's earlier Copy click still vouches for it.
      const finished = await extractCredentials(sessionId);
      expect(finished.credentials.api_key).toBe(key);
    });
  },
  30_000,
);

it("sends page content to Jev without pattern masking", async () => {
  const unprefixed = "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a";
  // Assembled at runtime so secret scanning does not flag fixture data.
  const prefixed = "sk" + "_live_fixturekey0123456789abcdef";
  const html = `<!doctype html><main><h1>API keys</h1>
    <p>Vast key: <code>${unprefixed}</code></p>
    <p>Stripe key: <code>${prefixed}</code></p>
    <label>Key name <input value="${prefixed}"></label>
    <button>Create API key</button></main>`;
  await withPage(html, async (sessionId) => {
    sessionForCall(sessionId)!.drive = emptyDriveState(goal, {});
    const askJev = doneJev();
    await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 1, max_seconds: 5 },
      api,
      undefined,
      dependencies(askJev),
    );
    expect(askJev).toHaveBeenCalled();
    const payload = JSON.stringify(
      askJev.mock.calls.map(([, state, questions]) => [state, questions]),
    );
    expect(payload).toContain(unprefixed);
    expect(payload).toContain(prefixed);
    // The revealed-key signal stays alongside the unaltered content.
    expect(payload).toContain("the revealed secret value");
  });
}, 30_000);

it.each([
  ["prefixed", "sk" + "_live_fixturekey0123456789abcdef"],
  ["unprefixed", "Ab3kZ9"],
])("stops a key-goal drive on a plain-text %s key and asks for capture", async (_name, key) => {
  // No Copy click and no target: the drive never guesses which text is the key.
  const html = `<!doctype html><main><h1>API keys</h1>
    <label>API key <input readonly value="${key}"></label></main>`;
  await withPage(html, async (sessionId) => {
    sessionForCall(sessionId)!.drive = emptyDriveState(goal, {});
    const result = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 4, max_seconds: 5 },
      api,
      undefined,
      dependencies(doneJev()),
    );
    expect(result.status).toBe("stuck");
    expect(result.reason).toContain("operate_observe");
    expect(result.reason).toContain("capture");
  });
}, 30_000);
