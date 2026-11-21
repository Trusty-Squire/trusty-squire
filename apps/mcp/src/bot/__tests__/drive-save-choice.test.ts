import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { driveRowsFromSnapshot, mergeSnapshots, type DriveSnapshot } from "../drive-snapshot.js";
import {
  buildDriveQuestions,
  DRIVE_MAX_CRITERIA,
  decideAfterJev,
  driveTargetSets,
  runOperateDrive,
  type DriveDependencies,
  type WireRow,
} from "../operate-drive.js";
import type { Session } from "../session/model.js";
import type { Observation } from "../provision-session.js";

const state = vi.hoisted(() => ({ session: undefined as Session | undefined }));
vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/lifecycle.js")>()),
  sessionForCall: () => state.session,
  liveProviderSessionsForSession: async () => [],
}));

const URL = "https://kenari.id/keys";
const STORED = { reference: "vault:kenari:free", service: "kenari", label: "Grunt Free" };
// Control/marker rows from squire-1.1.58-trace.jsonl run 2, L310-L312.
// Unlike that old trace's page-wide marker, SAVE names the actual text source.
const kenariRows: WireRow[] = [
  ["@e:f0d173", "b", "Salin"],
  ["@e:f0d175", "b", "Tutup|a=submit"],
  ["@key-value", "h1", "@key-value|secret=1|len=51"],
];
const prefixedKey = "sk-kenari-0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const hexKey = "0123456789abcdef".repeat(4);

function valueRows(value: string): WireRow[] {
  const snapshot: DriveSnapshot = {
    url: URL,
    title: "API Keys",
    headings: [],
    text: value,
    documentEpoch: "fixture",
    fingerprint: "fixture",
    elements: [],
    omittedValues: 0,
    scriptMs: 0,
    wallMs: 0,
    saveValues: [
      { ref: "@save:f0s1", value: "export KENARI_API_KEY=your-key" },
      { ref: "@save:f0s2", value },
    ],
  };
  return driveRowsFromSnapshot(snapshot);
}

beforeEach(() => {
  state.session = {
    id: "save-unit",
    browser: { page: null, currentUrl: () => URL },
    drive: null,
    lastElements: [],
    secretSlots: new Map(),
    committedSelectValues: new Map(),
    releasedPaymentCard: null,
    compactV2Secret: Buffer.alloc(32),
  } as unknown as Session;
});

async function drive(
  value: string,
  options: { store?: boolean; changed?: boolean; failed?: boolean; resume?: boolean } = {},
) {
  const persistCredentials = vi.fn(async () => (options.failed ? null : STORED));
  let reads = 0;
  const observe = vi.fn(
    async () =>
      ({
        session_id: "save-unit",
        url: URL,
        safe_table: [
          ...kenariRows,
          ...valueRows(options.changed && reads++ > 0 ? "replacement" : value),
        ],
      }) as unknown as Observation,
  );
  let asks = 0;
  const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
    asks += 1;
    expect(persistCredentials).not.toHaveBeenCalled();
    const save = questions.SAVE_target;
    expect(questions.operation?.type).toBe("choice");
    if (options.store === false) {
      expect(save).toBeUndefined();
      expect(questions.operation).not.toHaveProperty("criteria.SAVE");
    }
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, question]) => {
        if (question.type !== "choice") return [name, { noul: name === "dead_end" ? 0 : 1 }];
        const keys = Object.keys(question.criteria);
        const choice =
          name === "operation"
            ? options.store === false || asks > 1
              ? "BLOCKED"
              : "SAVE"
            : name === "SAVE_target"
              ? (keys.find((key) => question.criteria[key] === value) ?? keys[0]!)
              : keys[0]!;
        return [
          name,
          {
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
          },
        ];
      }),
    );
    return { attempts: 1, elapsedMs: 1, result: { answers } };
  });
  const act = vi.fn();
  const result = await runOperateDrive(
    {
      session_id: "save-unit",
      goal: "Store the newly created Kenari key",
      max_steps: 3,
      max_seconds: 5,
      ...(options.resume ? { answer: "save_2" } : {}),
    },
    {} as ApiClient,
    options.store === false ? undefined : { persistCredentials },
    {
      askJev,
      observe,
      act,
      startSession: vi.fn(),
      awaitVerification: vi.fn(),
      injectCard: vi.fn(),
    },
  );
  return { result, persistCredentials, askJev, act };
}

describe("explicit SAVE choice", () => {
  it.each([prefixedKey, hexKey, "opaque|value with separators"])(
    "stores the selected exact value %s",
    async (value) => {
      const { result, persistCredentials, askJev, act } = await drive(value);
      expect(askJev).toHaveBeenCalledOnce();
      expect(act).not.toHaveBeenCalled();
      expect(persistCredentials).toHaveBeenCalledOnce();
      expect(persistCredentials).toHaveBeenCalledWith({
        session_id: "save-unit",
        url: URL,
        credentials: { api_key: value },
      });
      expect(result).toMatchObject({ status: "complete", stored: true, stored_credential: STORED });
    },
  );

  it("does not offer SAVE without storage", async () => {
    const { result, persistCredentials } = await drive(hexKey, { store: false });
    expect(result.status).toBe("stuck");
    expect(persistCredentials).not.toHaveBeenCalled();
  });

  it("does not store a source whose value changed after the choice", async () => {
    const { persistCredentials } = await drive(hexKey, { changed: true });
    expect(persistCredentials).not.toHaveBeenCalled();
  });

  it("reports storage failure instead of completing", async () => {
    const { result, persistCredentials } = await drive(hexKey, { failed: true });
    expect(persistCredentials).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "stuck", reason: "selected credential was not stored" });
  });

  it("can resume the offered SAVE target", async () => {
    const { result, persistCredentials, askJev } = await drive(hexKey, { resume: true });
    expect(askJev).not.toHaveBeenCalled();
    expect(persistCredentials).toHaveBeenCalledOnce();
    expect(result.status).toBe("complete");
  });

  it("offers inline hex without the old shape-derived marker and rejects unknown source choices", () => {
    const rows = valueRows(hexKey);
    const sets = driveTargetSets(rows, {}, false, [], URL, new Map(), (text) => text, [], {
      canSave: true,
    });
    const questions = buildDriveQuestions(rows, {}, "Store a key", false, [], URL, new Map(), sets);
    expect(questions.SAVE_target).toMatchObject({ criteria: { save_2: hexKey } });
    const result = decideAfterJev({
      answers: {
        operation: { choice: "SAVE", confidence: 1 },
        SAVE_target: { choice: "unseen", confidence: 1 },
      },
      rows,
      facts: {},
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "fixture",
      goal: "Store a key",
      sets,
      questions,
    });
    expect(result.kind).toBe("invalid_answer");
  });
});

describe("SAVE candidate budgets", () => {
  it.each([true, false])("shares choices with ordinary actions (storage=%s)", (canSave) => {
    const rows: WireRow[] = [
      ...Array.from({ length: 125 }, (_, index): WireRow => [
        `@save:${index}`,
        "save",
        `text ${index}`,
      ]),
      ...Array.from({ length: 40 }, (_, index): WireRow => [
        `@button:${index}`,
        "b",
        `Action ${index}`,
      ]),
      ...Array.from({ length: 40 }, (_, index): WireRow => [
        `@email:${index}`,
        "t",
        "Email|f=email",
      ]),
      ...Array.from({ length: 40 }, (_, index): WireRow => [
        `@country:${index}`,
        "s",
        "Country|f=country",
      ]),
      ...Array.from({ length: 40 }, (_, index): WireRow => [
        `@offscreen:${index}`,
        "b",
        `Action ${index}|v=offscreen`,
      ]),
    ];
    const facts = { email: "a@b.test", country: "Canada" };
    const sets = driveTargetSets(rows, facts, false, [], URL, new Map(), (text) => text, [], {
      canSave,
    });
    const operations = [...sets.operations];
    const questions = buildDriveQuestions(rows, facts, "Sign up", false, [], URL, new Map(), sets);
    const choices = Object.values(questions).filter((question) => question.type === "choice");
    expect(
      choices.reduce((count, question) => count + Object.keys(question.criteria).length, 0),
    ).toBeLessThanOrEqual(DRIVE_MAX_CRITERIA);
    for (const operation of ["CLICK", "TYPE_TEXT", "SELECT"] as const) {
      expect(sets[operation].length).toBeGreaterThanOrEqual(10);
      const target = questions[`${operation}_target`];
      expect(target?.type).toBe("choice");
      if (target?.type !== "choice") throw new Error("Missing target choices");
      expect(Object.keys(target.criteria)).toEqual(sets[operation].map((candidate) => candidate.slug));
    }
    const scroll = questions.SCROLL_target;
    if (scroll?.type !== "choice") throw new Error("Missing scroll choices");
    expect(Object.keys(scroll.criteria)).toEqual(
      expect.arrayContaining(["down", "up", "bottom", "top"]),
    );
    expect(sets.SCROLL.length).toBeGreaterThanOrEqual(10);
    const operation = questions.operation;
    if (operation?.type !== "choice") throw new Error("Missing operations");
    expect(Object.keys(operation.criteria)).toEqual(expect.arrayContaining(operations));
    if (canSave) {
      expect(sets.SAVE!.length).toBeGreaterThanOrEqual(10);
    } else {
      expect(questions.SAVE_target).toBeUndefined();
    }
  });

  it("keeps active-layer values ahead of background values from other frames", () => {
    const base: DriveSnapshot = {
      url: URL,
      title: "Keys",
      headings: [],
      text: "",
      fingerprint: "fixture",
      documentEpoch: "fixture",
      elements: [],
      omittedValues: 0,
      scriptMs: 0,
      wallMs: 0,
    };
    const snapshot = mergeSnapshots([
      {
        ...base,
        saveValues: Array.from({ length: 300 }, (_, index) => ({
          ref: `@save:f0s${index}`,
          value: `background ${index}`,
        })),
      },
      { ...base, saveValues: [{ ref: "@save:f1s1", value: hexKey, activeLayer: true }] },
    ]);
    const rows = driveRowsFromSnapshot(snapshot);
    const sets = driveTargetSets(rows, {}, false, [], URL, new Map(), (text) => text, [], {
      canSave: true,
    });
    const questions = buildDriveQuestions(rows, {}, "Store the key", false, [], URL, new Map(), sets);
    expect(sets.SAVE?.[0]).toMatchObject({ ref: "@save:f1s1", description: hexKey });
    expect(questions.SAVE_target).toMatchObject({ criteria: { save_1: hexKey } });
  });
});
