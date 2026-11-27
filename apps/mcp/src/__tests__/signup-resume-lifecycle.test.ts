import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "../bot/browser.js";
import type { DriveDependencies, WireRow } from "../bot/operate-drive.js";
import type { Observation } from "../bot/provision-session.js";
import type * as Capture from "../bot/capture/capture.js";
import type * as Lifecycle from "../bot/session/lifecycle.js";
import type { Session } from "../bot/session/model.js";
import {
  createSignupSession,
  type CapturedCredential,
  type SignupRunRuntime,
  type SignupSession,
} from "../signup.js";

const sessionState = vi.hoisted(() => ({
  sessions: new Map<string, Session>(),
  extractImpl: async (sid: string) => ({
    session_id: sid,
    url: "",
    credentials: {} as Record<string, string>,
  }),
}));

vi.mock("../bot/session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Lifecycle>()),
  sessionForCall: (id: string) => sessionState.sessions.get(id),
  liveProviderSessionsForSession: async () => [],
}));

vi.mock("../bot/capture/capture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Capture>()),
  extractCredentials: (sid: string) => sessionState.extractImpl(sid),
  copySourceClick: async (sid: string) => {
    const res = await sessionState.extractImpl(sid);
    return { ok: true, value: res.credentials.api_key };
  },
}));

const SAMPLE_SESSION: SignupSession = {
  apiBaseUrl: "https://api.example.test",
  registryBaseUrl: "https://registry.example.test",
  accountId: "acc_01JLIFECYCLETEST",
  agentSessionToken: "agt_lifecycle_session_token",
  machineToken: "mch_lifecycle_machine_token",
  savedAt: "2026-11-26T20:00:00.000Z",
  consentOperatorInboxOtp: true,
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ts-signup-lifecycle-test-"));
  sessionState.sessions.clear();
});

afterEach(() => {
  sessionState.sessions.clear();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createSignupSession real operate_drive modal pause/resume lifecycle", () => {
  it("keeps an open key-name modal dialog alive across needs_value and low_confidence resumes, completes in the same dialog without reload, and redacts the captured API key", async () => {
    const appProfileDir = join(tempDir, "modal-lifecycle-profile");
    const pageUrl = "https://console.example.test/api-keys";
    const revealedApiKey = "sk_live_MODAL_DIALOG_RESUMED_SECRET_847291";
    const captured: CapturedCredential[] = [];

    // Stateful SPA page where reloading / calling startHarnessSession again
    // wipes the open modal dialog (proving resume MUST reuse the live session).
    let startCount = 0;
    let modalOpen = false;
    let termsAccepted = false;
    let typedKeyName = "";
    let keyRevealed = false;

    const currentRows = (): WireRow[] => {
      if (keyRevealed) {
        return [
          ["@copy-key", "b", "Copy key|dialog=@dlg"],
          ["@close-modal", "b", "Close|dialog=@dlg"],
        ];
      }
      if (!modalOpen) {
        return [["@new-key", "b", "New API key"]];
      }
      return [
        [
          "@key-name",
          "t",
          `Key name|f=key_name|fm=1|dialog=@dlg|s=r${typedKeyName.length > 0 ? `p|n=${typedKeyName}` : ""}`,
        ],
        ["@accept-terms", "c", `Accept API terms|fm=1|dialog=@dlg${termsAccepted ? "|s=k" : ""}`],
        ["@create-key", "b", "Create API key|a=submit|fm=1|dialog=@dlg"],
        ["@cancel-modal", "b", "Cancel|dialog=@dlg"],
      ];
    };

    const currentObservation = (sid: string): Observation =>
      ({
        session_id: sid,
        url: modalOpen ? `${pageUrl}#new-key-modal` : pageUrl,
        safe_table: currentRows(),
        dom: keyRevealed
          ? `Your new API key is ${revealedApiKey}. Copy it now.`
          : modalOpen
            ? `Create API key modal open (name=${typedKeyName || "empty"})`
            : "API Keys dashboard",
      }) as unknown as Observation;

    const browser = {
      start: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => "closed"),
      currentUrl: () => (modalOpen ? `${pageUrl}#new-key-modal` : pageUrl),
      page: null,
    };

    const startHarnessSession = vi.fn(async () => {
      startCount += 1;
      // Reloading the URL resets transient modal state!
      modalOpen = false;
      termsAccepted = false;
      typedKeyName = "";
      keyRevealed = false;

      const sid = `sess-modal-${startCount}`;
      sessionState.sessions.set(sid, {
        id: sid,
        browser,
        drive: null,
        lastElements: [],
        secretSlots: new Map(),
        committedSelectValues: new Map(),
        releasedPaymentCard: null,
        compactV2Secret: Buffer.alloc(32),
      } as unknown as Session);
      return currentObservation(sid);
    });

    const finishSession = vi.fn(async (sid: string) => {
      sessionState.sessions.delete(sid);
      return {
        session_id: sid,
        operation_id: "op-modal-finish",
        execution: "completed" as const,
        mutation: "not_dispatched" as const,
        cleanup: "closed" as const,
        closed: true,
        url: browser.currentUrl(),
      };
    });
    const forceFinishSession = vi.fn(async (sid: string) => {
      sessionState.sessions.delete(sid);
      return true;
    });

    const observe = vi.fn(async (sid: string) => currentObservation(sid));

    const act = vi.fn(async (sid: string, action: { kind: string; target?: string }) => {
      if (action.kind === "click" && action.target === "@accept-terms") {
        expect(modalOpen).toBe(true);
        termsAccepted = true;
      }
      return currentObservation(sid);
    });

    const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async (_sid, action) => {
      if (action.kind === "click" && action.target === "@new-key") {
        modalOpen = true;
        return { kind: "ok", combobox: false };
      }
      if (action.kind === "type" && action.target === "@key-name") {
        // Fails immediately if the modal dialog was lost by a reload!
        if (!modalOpen) {
          throw new Error("Key name modal dialog was lost due to page reload");
        }
        typedKeyName = action.text;
        return { kind: "ok", combobox: false };
      }
      if (action.kind === "click" && action.target === "@create-key") {
        if (!modalOpen || typedKeyName.length === 0) {
          throw new Error("Cannot create key without an open modal and key name");
        }
        keyRevealed = true;
        return { kind: "ok", combobox: false };
      }
      throw new Error(`Unexpected driveAct: ${JSON.stringify(action)}`);
    });

    let emittedLowConfidence = false;
    const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
      const answers: Record<
        string,
        {
          choice?: string;
          confidence?: number;
          probabilities?: Record<string, number>;
          noul?: number;
        }
      > = {};

      for (const [name, question] of Object.entries(questions)) {
        if (question.type !== "choice") {
          answers[name] = { noul: name === "dead_end" ? 0 : 1 };
          continue;
        }
        const keys = Object.keys(question.criteria);
        const keyForLabel = (needle: string): string | undefined =>
          keys.find((key) => question.criteria[key]?.toLowerCase().includes(needle.toLowerCase()));

        if (name === "operation") {
          let choice: string;
          if (keyRevealed) {
            choice = "DONE";
          } else if (!modalOpen) {
            choice = "CLICK";
          } else if (typedKeyName.length === 0) {
            // Ask to TYPE_TEXT when key_name fact is absent -> real operate_drive pauses with needs_value!
            choice = keys.includes("TYPE_TEXT") ? "TYPE_TEXT" : "BLOCKED";
          } else {
            choice = "CLICK";
          }
          answers[name] = {
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
          };
          continue;
        }

        if (name === "CLICK_target") {
          if (!modalOpen) {
            const target = keyForLabel("new api key") ?? keys[0]!;
            answers[name] = {
              choice: target,
              confidence: 1,
              probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 1 : 0])),
            };
          } else if (typedKeyName.length > 0 && !emittedLowConfidence) {
            // Simulate an ambiguous split between Create API key and Cancel so
            // real operate_drive returns low_confidence and waits for caller's answer!
            emittedLowConfidence = true;
            const createKey = keyForLabel("create api key") ?? keys[0]!;
            const cancelKey = keyForLabel("cancel") ?? keys[1] ?? createKey;
            answers[name] = {
              choice: createKey,
              confidence: 0.45,
              probabilities: Object.fromEntries(
                keys.map((k) => [k, k === createKey ? 0.51 : k === cancelKey ? 0.49 : 0]),
              ),
            };
          } else {
            const target = keyForLabel("create api key") ?? keys[0]!;
            answers[name] = {
              choice: target,
              confidence: 1,
              probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 1 : 0])),
            };
          }
          continue;
        }

        if (name === "TYPE_TEXT_target") {
          const target = keyForLabel("key name") ?? keys[0]!;
          answers[name] = {
            choice: target,
            confidence: 1,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === target ? 1 : 0])),
          };
          continue;
        }

        if (name === "TYPE_TEXT_value") {
          const factKey = keys.find((k) => k !== "none") ?? "none";
          answers[name] = {
            choice: factKey,
            confidence: 1,
            probabilities: Object.fromEntries(keys.map((k) => [k, k === factKey ? 1 : 0])),
          };
          continue;
        }

        const fallback = keys.includes("none") ? "none" : keys[0]!;
        answers[name] = {
          choice: fallback,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === fallback ? 1 : 0])),
        };
      }

      return {
        attempts: 1,
        elapsedMs: 1,
        result: { answers },
      };
    });

    sessionState.extractImpl = async (sid: string) => ({
      session_id: sid,
      url: browser.currentUrl(),
      credentials: keyRevealed ? { api_key: revealedApiKey } : {},
    });

    const storeCredentialSpy = vi.fn();
    const session = await createSignupSession(
      {
        url: pageUrl,
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        createApiClient: () =>
          ({
            setRequestingAgent: vi.fn(),
            storeCredential: storeCredentialSpy,
          }) as unknown as ApiClient,
        startHarnessSession,
        finishSession,
        forceFinishSession,
        act: act as unknown as NonNullable<SignupRunRuntime["act"]>,
        observe,
        extractCredentials: vi.fn(async (sid: string) => sessionState.extractImpl(sid)),
        observedHostsForSession: () => ["console.example.test"],
        currentProvisionUrl: () => browser.currentUrl(),
        driveDependencies: {
          askJev,
          act: act as unknown as DriveDependencies["act"],
          observe,
          driveAct,
          awaitVerification: vi.fn(),
          injectCard: vi.fn(),
          attemptCaptchaAutoSolve: vi.fn(async () => "none"),
        },
      },
    );

    // Turn 1: opens the key-name modal dialog and pauses on missing key_name fact (needs_value).
    const turn1 = await session.drive({
      goal: "Open the new API key dialog and create an API key",
      maxSteps: 6,
    });
    expect(turn1.status).toBe("needs_input");
    expect(turn1.driveStatus).toBe("needs_value");
    expect(modalOpen).toBe(true);
    expect(startCount).toBe(1);
    expect(session.sessionId).toBe("sess-modal-1");
    expect(turn1.observation?.url).toBe(`${pageUrl}#new-key-modal`);
    expect(turn1.observation?.safe_table).toBeDefined();
    expect("dom" in (turn1.observation ?? {})).toBe(false);
    expect(finishSession).not.toHaveBeenCalled();
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();

    // Caller can safely click a control inside the open modal without losing state or closing Chrome.
    const clickedTerms = await session.click("@accept-terms");
    expect(termsAccepted).toBe(true);
    expect(modalOpen).toBe(true);
    expect(clickedTerms.url).toBe(`${pageUrl}#new-key-modal`);
    expect(finishSession).not.toHaveBeenCalled();

    // Turn 2: supplies key_name fact on the exact same live session -> fills the STILL-OPEN modal
    // and pauses on low_confidence for the Create API key vs Cancel confirmation.
    const turn2 = await session.drive({
      goal: "Open the new API key dialog and create an API key",
      facts: { key_name: "Grunt Production Key" },
      maxSteps: 6,
    });
    expect(turn2.status).toBe("low_confidence");
    expect(turn2.driveStatus).toBe("low_confidence");
    expect(typedKeyName).toBe("Grunt Production Key");
    expect(modalOpen).toBe(true);
    expect(startCount).toBe(1);
    expect(finishSession).not.toHaveBeenCalled();
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();

    const createOptionKey = Object.entries(turn2.options ?? {}).find(([, label]) =>
      label.toLowerCase().includes("create api key"),
    )?.[0];
    expect(createOptionKey).toBeDefined();

    // Turn 3: answers the low_confidence prompt in the exact same open modal -> creates & captures key!
    const turn3 = await session.drive({
      goal: "Open the new API key dialog and create an API key",
      answer: createOptionKey!,
      maxSteps: 6,
    });
    expect(turn3.status).toBe("completed");
    expect(turn3.captured).toBe(true);
    expect(keyRevealed).toBe(true);
    expect(startCount).toBe(1);
    expect(browser.start).toHaveBeenCalledTimes(1);

    // Raw key delivered exclusively in-process to onCredentialCaptured; never vaulted; fully redacted.
    expect(storeCredentialSpy).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields).toEqual({ api_key: revealedApiKey });
    expect(JSON.stringify(turn3)).not.toContain(revealedApiKey);
    expect("dom" in (turn3.observation ?? {})).toBe(false);

    // Close idempotently -> exactly one finishSession and one browser.close({ cancelStart: true }).
    await session.close();
    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(finishSession).toHaveBeenCalledWith("sess-modal-1");
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledWith({ cancelStart: true });
  });
});
