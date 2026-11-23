import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { extractCredentials } from "../capture/capture.js";
import {
  emptyDriveState,
  runOperateDrive,
  type DriveCallContext,
  type DriveDependencies,
} from "../operate-drive.js";
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
      // A key goal completes only once the captured key is in the vault (#1148),
      // so the drive runs with the `store` persistence operate_drive wires up.
      const persistCredentials = vi.fn<NonNullable<DriveCallContext["persistCredentials"]>>(
        async () => ({ reference: "vault://ref", service: "127.0.0.1", label: undefined }),
      );
      const result = await runOperateDrive(
        { session_id: sessionId, goal, max_steps: 3, max_seconds: 5 },
        api,
        { persistCredentials },
        dependencies(askJev),
      );
      expect(result.status, `${result.reason} | ${JSON.stringify(result.trajectory)}`).toBe(
        "complete",
      );
      expect(persistCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.objectContaining({ api_key: key }) }),
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
])(
  "stops a key-goal drive on a plain-text %s key and asks for capture",
  async (_name, key) => {
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
      expect(result.reason).toContain("key not stored");
      expect(result.reason).toContain("operate_extract");
      expect(result.reason).toContain("capture");
    });
  },
  30_000,
);

it("stores a Kenari key shown inline after its dialog closed, through its Salin button", async () => {
  // Kenari 23 Nov (trace rows 15-17): after "Buat Key" the dialog closed and
  // /keys showed the new key once inline with "Salin"/"Tutup" beside it. The
  // drive's revealed-key capture found no Copy source and the key was lost.
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  const html = `<!doctype html><main><h1>API Keys</h1><button>Buat API Key</button>
    <section><p>Simpan key ini sekarang.</p><code id="revealed">${key}</code>
      <button type="button" id="salin">Salin</button><button type="button">Tutup</button></section>
    <table><tr><td>kn-08d5677c grunt 23</td><td><button>Ganti key</button>
      <button>Cabut key</button></td></tr></table></main>
    <script>document.getElementById('salin').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(document.getElementById('revealed').textContent);
      event.target.textContent = 'Tersalin';
    });</script>`;
  await withPage(html, async (sessionId) => {
    sessionForCall(sessionId)!.drive = emptyDriveState(goal, {});
    const persistCredentials = vi.fn<NonNullable<DriveCallContext["persistCredentials"]>>(
      async () => ({ reference: "vault://ref", service: "kenari", label: undefined }),
    );
    const result = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 3, max_seconds: 5 },
      api,
      { persistCredentials },
      dependencies(doneJev()),
    );
    expect(result.status, `${result.reason} | ${JSON.stringify(result.trajectory)}`).toBe(
      "complete",
    );
    expect(persistCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { api_key: key } }),
    );
  });
}, 30_000);

it.each(["Salin", "Tersalin", "⧉"])("retries failed storage after a model click on %s", async (label) => {
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  const html = `<!doctype html><h1>API Keys</h1><div><code>${key}</code>
    <button id="copy">${label}</button></div>
    <script>document.getElementById('copy').addEventListener('click', () =>
      navigator.clipboard.writeText('${key}'));</script>`;
  await withPage(html, async (sessionId) => {
    sessionForCall(sessionId)!.drive = emptyDriveState(goal, {});
    const persistCredentials = vi.fn<NonNullable<DriveCallContext["persistCredentials"]>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ reference: "vault://retry", service: "kenari", label: undefined });
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => ({
      attempts: 1,
      elapsedMs: 1,
      result: {
        answers: Object.fromEntries(Object.entries(questions).flatMap(([name, question]) => {
          if (question.type !== "choice") return [];
          const keys = Object.keys(question.criteria);
          const choice = name === "operation" ? "CLICK" : keys[0]!;
          return [[name, { choice, confidence: 1,
            probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
          }]];
        })),
      },
    }));
    const result = await runOperateDrive(
      { session_id: sessionId, goal, max_steps: 3, max_seconds: 10 },
      api, { persistCredentials }, dependencies(askJev),
    );
    expect(askJev).toHaveBeenCalled();
    expect(result.status).toBe("complete");
    expect(persistCredentials).toHaveBeenCalledTimes(2);
    expect(persistCredentials).toHaveBeenLastCalledWith(
      expect.objectContaining({ credentials: { api_key: key } }),
    );
  });
}, 30_000);

it("reports a submitted form's inline error text to the model and the trace", async () => {
  // Zro 23 Nov (trace rows 24-26): Create left its dialog open and created no
  // key; the trace carried interactive rows only, so nothing said why. The
  // page's own text fills the snapshot's text budget before the dialog.
  const filler = Array.from({ length: 300 }, (_, index) => `Usage line ${index} for the account.`);
  const html = `<!doctype html><main><h1>API keys</h1>
    <div style="font-size:6px">${filler.map((line) => `<span>${line} </span>`).join("")}</div></main>
    <div role="dialog" aria-label="Create API key" style="position:fixed;top:20px;left:20px;background:#fff">
      <form id="create"><label>Alias <input name="alias" value="grunt"></label>
        <button type="submit">Create</button></form><p id="error"></p></div>
    <script>document.getElementById('create').addEventListener('submit', (event) => {
      event.preventDefault();
      document.getElementById('error').textContent = 'An active key already uses the alias grunt.';
    });</script>`;
  const traceDir = await mkdtemp(join(process.cwd(), ".drive-form-error-trace-"));
  const tracePath = join(traceDir, "trace.jsonl");
  vi.stubEnv("DRIVE_TRACE_PATH", tracePath);
  try {
    await withPage(html, async (sessionId) => {
      sessionForCall(sessionId)!.drive = emptyDriveState("create an API key", {});
      let calls = 0;
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
        calls += 1;
        const answers = Object.fromEntries(
          Object.entries(questions).flatMap(([name, question]) => {
            if (question.type !== "choice") return [];
            const keys = Object.keys(question.criteria);
            const choice =
              name === "operation"
                ? calls === 1
                  ? "CLICK"
                  : "BLOCKED"
                : name === "CLICK_target"
                  ? (keys.find((slug) => /create/.test(slug)) ?? keys[0]!)
                  : keys[0]!;
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
        );
        return { attempts: 1, elapsedMs: 1, result: { answers } };
      });
      await runOperateDrive(
        { session_id: sessionId, goal: "create an API key", max_steps: 2, max_seconds: 10 },
        api,
        undefined,
        dependencies(askJev),
      );
      expect(askJev.mock.calls.length).toBeGreaterThanOrEqual(2);
      const afterSubmit = askJev.mock.calls[1]![1] as { page: { notices: string[] } };
      expect(afterSubmit.page.notices.join(" ")).toContain(
        "An active key already uses the alias grunt.",
      );
    });
    const rows = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const afterAct = rows.find((row) => row.at === "after_act");
    expect(afterAct?.submit_response).toContain("An active key already uses the alias grunt.");
    const nextStep = rows.filter((row) => row.at === "step")[1];
    expect(JSON.stringify(nextStep?.notices)).toContain(
      "An active key already uses the alias grunt.",
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(traceDir, { recursive: true, force: true });
  }
}, 30_000);
