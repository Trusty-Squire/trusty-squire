import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  emptyDriveState,
  revealedKeyCaptureDue,
  revealedSecretCopyRef,
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

// Rows recorded by the 1.1.48-rc.1 BeatAPI drive (trace steps 5 and 6): the
// one-time key was revealed and Copy was clicked, yet the drive kept asking.
const STORED = { reference: "vault:example:default", service: "example", label: "default" };
const beatApiRevealedRows: WireRow[] = [
  ["@e:f0d128", "b", "Copy key"],
  ["@e:f0d129", "b", "Done"],
  ["@e:f0d26", "b", "Close"],
  ["@key-value", "h1", "@key-value|secret=1|len=51"],
];
const withoutMarker = beatApiRevealedRows.slice(0, 3);

describe("revealedKeyCaptureDue", () => {
  it("is due when the page shows a revealed secret row (trace step 5)", () => {
    expect(revealedKeyCaptureDue(beatApiRevealedRows, false)).toBe(true);
  });

  it("is due after the recorded Copy click (trace step 6)", () => {
    expect(revealedKeyCaptureDue(beatApiRevealedRows, true)).toBe(true);
    expect(revealedKeyCaptureDue(withoutMarker, true)).toBe(true);
    expect(revealedKeyCaptureDue([["@e:f0d128", "b", "Copied!"]], true)).toBe(true);
  });

  it("is not due without a revealed key or a clicked Copy control", () => {
    expect(revealedKeyCaptureDue(withoutMarker, false)).toBe(false);
  });
});

// Rows recorded by the 1.1.49-rc.1 Zro drive (run 7, trace steps 4 and 5): the
// new key was revealed inline on the page, not in a dialog, before and after
// its Copy click.
const zroInlineRows = (copyLabel: string): WireRow[] => [
  ["@e:f0d11", "b", "Open account settings. Current workspace: Personal"],
  ["@e:f0d19", "b", "Create key"],
  ["@e:f0d43", "b", "Dismiss"],
  ["@e:f0d44", "b", copyLabel],
  ["@e:f0d20", "b", "Done"],
  ["@e:f0d45", "b", "DeepSeek V4.1 Flash deepseek-v4.1-flash"],
  ["@e:f0d46", "b", "Copy setup"],
  ["@e:f0d47", "b", "Revoke grunt-7|v=offscreen"],
  ["@key-value", "h1", "@key-value|secret=1|len=36|count=2"],
];

describe("revealedSecretCopyRef", () => {
  it("names the inline key's Copy control before it is clicked (trace step 4)", () => {
    expect(revealedSecretCopyRef(zroInlineRows("Copy key"), undefined)).toBe("@e:f0d44");
  });

  it("names the clicked Copy control after it relabels itself (trace step 5)", () => {
    expect(revealedSecretCopyRef(zroInlineRows("Copied"), "@e:f0d44")).toBe("@e:f0d44");
    expect(revealedSecretCopyRef(zroInlineRows("Copied"), undefined)).toBeUndefined();
  });

  it("names no control when several Copy controls are clickable or the only one is covered", () => {
    const rows = zroInlineRows("Copy key");
    expect(revealedSecretCopyRef([...rows, ["@e:f0d48", "b", "Copy"]], undefined)).toBeUndefined();
    expect(
      revealedSecretCopyRef(
        rows.map((row) => (row[0] === "@e:f0d44" ? ["@e:f0d44", "b", "Copy key|oc=overlay"] : row)),
        undefined,
      ),
    ).toBeUndefined();
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
  layer: "dialog" | "inline" = "dialog",
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/dashboard/apikeys";
  const panel = `<h1>${key}</h1>
    <button type="button" onclick="${copyScript}">Copy key</button>
    <button type="button">Done</button>
    <button type="button" aria-label="Close">x</button>`;
  const body =
    layer === "dialog"
      ? `<main><div role="dialog" aria-label="Create API key">${panel}</div></main>`
      : `<main><h2>API keys</h2><section>${panel}</section>
    <button type="button" onclick="navigator.clipboard.writeText('setup')">Copy setup</button></main>`;
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

it("stores a key revealed inline, outside any dialog, from its Copy control", async () => {
  const persistCredentials = vi.fn(async () => STORED);
  const { result, askJev } = await drive(
    `navigator.clipboard.writeText('${key}')`,
    persistCredentials,
    "inline",
  );
  expect(persistCredentials).toHaveBeenCalledWith(
    expect.objectContaining({ credentials: { api_key: key } }),
  );
  expect(result.status).toBe("complete");
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

it("stores an opaque key after Copy relabels itself without another model decision", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = "https://app.example.test/keys";
  const opaqueKey = "Ab3kZ9";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<main><dialog open aria-label="API key created"><p>${opaqueKey}</p>
      <button onclick="navigator.clipboard.writeText('${opaqueKey}');this.textContent='Copied!'">Copy</button>
      </dialog></main>`,
    }),
  );
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
}, 15_000);
