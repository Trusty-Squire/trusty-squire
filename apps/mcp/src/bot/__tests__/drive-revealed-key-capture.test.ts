import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  emptyDriveState,
  revealedKeyCaptureDue,
  runOperateDrive,
  type DriveDependencies,
  type DriveCallContext,
  type WireRow,
} from "../operate-drive.js";
import {
  act,
  awaitVerification,
  finishProvisionSession,
  observe,
  startHarnessProvisionSession,
} from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

const STORED = { reference: "vault:example:default", service: "example", label: "default" };

describe("revealedKeyCaptureDue", () => {
  const inlineCopy: WireRow = ["@e:copy", "b", "Copy key"];

  it("is due for a key Copy control inside a dialog", () => {
    expect(revealedKeyCaptureDue([["@e:copy", "b", "Copy key|dialog=@e:dialog"]], false)).toBe(true);
  });

  it("is due after a recorded Copy click, regardless of the new label", () => {
    expect(revealedKeyCaptureDue([["@e:copy", "b", "Copied!"]], true)).toBe(true);
  });

  it("leaves inline Copy controls to the drive decision", () => {
    expect(revealedKeyCaptureDue([inlineCopy], false)).toBe(false);
  });
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

const api = { useCredential: vi.fn() } as unknown as ApiClient;
const key = "sk-beat-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

async function drive(
  copyScript: string,
  persistCredentials: DriveCallContext["persistCredentials"] | null = async () => STORED,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/dashboard/apikeys";
  const body = `<main><div role="dialog" aria-label="Create API key">
    <h1>${key}</h1>
    <button type="button" onclick="${copyScript}">Copy key</button>
    <button type="button">Done</button>
    <button type="button" aria-label="Close">x</button>
  </div></main>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  const goal = "Get one API key. Finish as soon as that key is in the vault.";
  sessionForCall(started.session_id)!.drive = emptyDriveState(goal, {});
  const askJev = vi.fn<DriveDependencies["askJev"]>(async () => {
    throw new Error("model asked");
  });
  try {
    const result = await runOperateDrive(
      { session_id: started.session_id, goal, max_steps: 3, max_seconds: 10 },
      api,
      { ...(persistCredentials == null ? {} : { persistCredentials }) },
      {
        askJev,
        act,
        observe,
        startSession: async () => {
          throw new Error("existing session");
        },
        awaitVerification,
        injectCard: async () => ({ status: "unused" }),
      },
    );
    return { result, askJev };
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}

it("finishes complete from a revealed key without asking the model", async () => {
  const persistCredentials = vi.fn(async () => STORED);
  const { result, askJev } = await drive(
    `navigator.clipboard.writeText('${key}')`,
    persistCredentials,
  );
  expect(persistCredentials).toHaveBeenCalledWith(
    expect.objectContaining({
      credentials: { api_key: key },
    }),
  );
  expect(result).toMatchObject({ status: "complete", stored: true, stored_credential: STORED });
  expect(askJev).not.toHaveBeenCalled();
}, 15_000);

it("asks the model when the Copy control writes nothing", async () => {
  await expect(drive("")).rejects.toThrow("model asked");
}, 15_000);

it.each(["missing", "rejected", "failed"])(
  "asks the model when storage is %s",
  async (mode) => {
    const persistCredentials =
      mode === "missing"
        ? undefined
        : async () => {
            if (mode === "failed") throw new Error("vault unavailable");
            return null;
          };
    await expect(
      drive(`navigator.clipboard.writeText('${key}')`, persistCredentials ?? null),
    ).rejects.toThrow("model asked");
  },
  15_000,
);

async function expectDriveToCaptureRelabeledCopy(display: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/keys";
  const opaqueKey = "Ab3kZ9";
  const copy = `<button onclick="navigator.clipboard.writeText('${opaqueKey}');this.textContent='Copied!'">`;
  const body =
    display === "dialog"
      ? `<main><dialog open aria-label="API key created"><p>${opaqueKey}</p>
       ${copy}Copy</button></dialog></main>`
      : `<main><h1>API key created</h1><div><pre><code>${opaqueKey}</code></pre>
       ${copy}Copy key</button></div></main>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: url,
    format: "compact",
    initialObservation: "drive",
  });
  const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
    if (askJev.mock.calls.length > 1) throw new Error("model asked after Copy");
    return {
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
                  ? keys.find((key) => /copy/i.test(question.criteria[key]!))!
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
        ),
      },
    };
  });
  const persistCredentials = vi.fn(async () => STORED);
  try {
    const result = await runOperateDrive(
      {
        session_id: started.session_id,
        goal: "Get an API key and store it in the vault",
        max_steps: 3,
        max_seconds: 10,
      },
      api,
      { persistCredentials },
      {
        askJev,
        act,
        observe,
        awaitVerification,
        startSession: async () => {
          throw new Error("existing session");
        },
        injectCard: async () => ({ status: "unused" }),
      },
    );
    expect(await page.getByRole("button").textContent()).toBe("Copied!");
    expect(persistCredentials).toHaveBeenCalledTimes(1);
    expect(persistCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { api_key: opaqueKey },
      }),
    );
    expect(askJev).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("complete");
  } finally {
    await finishProvisionSession(started.session_id);
    await context.close();
  }
}

it.each(["dialog", "pre"])(
  "stores an opaque key from %s after Copy relabels itself without another model decision",
  expectDriveToCaptureRelabeledCopy,
  15_000,
);
