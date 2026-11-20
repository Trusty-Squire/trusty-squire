import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import {
  emptyDriveState,
  revealedKeyCaptureDue,
  runOperateDrive,
  type DriveDependencies,
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
const beatApiRevealedRows: WireRow[] = [
  ["@e:f0d128", "b", "Copy key"],
  ["@e:f0d129", "b", "Done"],
  ["@e:f0d26", "b", "Close"],
  ["@key-value", "h1", "@key-value|secret=1|len=51"],
];
const withoutMarker = beatApiRevealedRows.slice(0, 3);

describe("revealedKeyCaptureDue", () => {
  it("is due when the page shows a revealed secret row (trace step 5)", () => {
    expect(revealedKeyCaptureDue(beatApiRevealedRows, null)).toBe(true);
  });

  it("is due after the recorded Copy click (trace step 6)", () => {
    expect(revealedKeyCaptureDue(beatApiRevealedRows, "@e:f0d128")).toBe(true);
    expect(revealedKeyCaptureDue(withoutMarker, "@e:f0d128")).toBe(true);
  });

  it("is not due without a revealed key or a clicked Copy control", () => {
    expect(revealedKeyCaptureDue(withoutMarker, null)).toBe(false);
    expect(revealedKeyCaptureDue(withoutMarker, "@e:f0d129")).toBe(false);
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

async function drive(copyScript: string) {
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
      undefined,
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
  const { result, askJev } = await drive(`navigator.clipboard.writeText('${key}')`);
  expect(result.status).toBe("complete");
  expect(askJev).not.toHaveBeenCalled();
}, 15_000);

it("asks the model when the Copy control writes nothing", async () => {
  await expect(drive("")).rejects.toThrow("model asked");
}, 15_000);
