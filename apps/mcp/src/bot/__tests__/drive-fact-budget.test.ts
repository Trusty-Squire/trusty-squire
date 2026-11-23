import { describe, expect, it } from "vitest";
import {
  buildDriveQuestions,
  decideAfterJev,
  DRIVE_EMAIL_CODE_QUESTION,
  DRIVE_FIXED_NONE,
  DRIVE_MAX_CRITERIA,
  driveTargetSets,
  peakedProbabilities,
  type WireRow,
} from "../operate-drive.js";

// Kenari's create-key dialog as the drive saw it (23 Nov trace rows 578-582):
// choosing "Model tertentu" reveals one checkbox per model beside the form's
// text fields. Those clicks used to take the whole choice budget, leaving each
// form-value question only `none`, so the supplied key_name and model could
// never be typed.
const goal =
  "On /keys press 'Buat API Key', type the key name in 'Label (opsional)', open 'Pengaturan lanjutan', choose 'Model tertentu' and type the model into 'Cari model...', then press 'Buat Key'.";
const facts = {
  key_name: "grunt",
  model: "ernie-5-5-flash-preview:free",
  plan: "free",
  project_name: "grunt",
};
const pageUrl = "https://kenari.id/keys";
const DIALOG = "fm=1|dialog=@e:f0d54";

const MODELS = [
  "beam-1-0:free",
  "bge-m3",
  "bge-reranker-base",
  "clairic:free",
  "claude-fable-5",
  "claude-haiku-5-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "clef",
  "Pembacaan dokumen",
  "Pencarian dan pengambilan halaman web",
  "Pencarian X",
  "clef-flash:free",
  "clef-omni:free",
  "clef:free",
  "codestral-embed",
  "deepseek-v4-1-flash",
  "deepseek-v4-1-flash-abliterated",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "dots-3-note-preview:free",
  "ernie-5-5-flash-preview:free",
  "flint-v1-0:free",
  "gemini-3-1-flash-lite",
  "gemini-3-1-pro",
  "gemini-3-6-flash",
  "gemini-3-7-flash",
  "gemini-3-8-flash",
  "gemini-3-8-flash-lite-tts",
  "gemini-omni-flash",
  "glm-4-6v-flash:free",
  "glm-4-7-flash:free",
  "glm-5-2",
  "glm-5-3",
  "glm-5-3-abliterated",
  "glm-5-3-flash",
  "glm-5-3-flash-abliterated",
  "gpt-5-6-luna",
  "gpt-5-6-sol",
  "gpt-6-1-sol",
  "gpt-6-1-terra",
  "gpt-6-2-astra",
  "gpt-6-2-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-image-2",
  "gpt-image-2-5-flare",
  "gpt-image-2-5-sunburst",
  "gpt-image-2-6-flare",
  "gpt-image-2-6-sunburst",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "gpt-transcribe",
  "grok-4-5",
  "grok-4-6",
  "grok-4-7",
  "grok-imagine-image",
  "grok-imagine-image-2-0",
  "grok-imagine-image-quality",
  "hy3",
  "hy4",
  "hy4-flash",
  "hy4-flash:free",
  "inkling-2-mini-uncensored",
  "jev-1-13",
  "jev-1-14",
  "kimi-k2-6",
  "kimi-k2-7-code",
  "kimi-k3",
  "kimi-k3-1-pro",
  "kokoro-tts",
  "laguna-xs-2-1:free",
  "lfm-3-1-7b:free",
  "longcat-2-5:free",
  "lyria-3-5",
  "lyria-3-pro",
  "mimo-v2-6-flash",
  "mimo-v2-6-pro",
  "minimax-m2-7",
  "minimax-m2-7-highspeed",
  "minimax-m3",
  "minimax-m3-1-flash",
  "mistral-embed",
  "muse-ember-1-0",
  "muse-glimmer-30b:free",
  "muse-image",
  "muse-spark-1-2",
  "muse-spark-1-2-contributor",
  "muse-spark-1-3",
  "muse-spark-1-3-contributor",
  "muse-video",
  "muse-wonder-1-0",
  "nano-banana-2",
  "nano-banana-2-1",
  "nano-banana-2-lite",
  "nano-banana-pro",
  "nemotron-3-5-lightning:free",
  "nemotron-3-5-super-vl:free",
  "nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nemotron-3-super-120b-a12b",
  "nemotron-3-ultra-550b-a55b",
  "nemotron-3-ultra-550b-a55b:free",
  "north-mini-code:free",
  "particle-1:free",
  "qwen3-7-plus",
  "qwen3-8-27b-uncensored",
  "qwen3-8-flash",
  "qwen3-8-max",
  "qwen3-8-omni-flash",
  "qwen3-embedding-0.6b",
  "solar-mini4:free",
  "step-3-7-flash",
  "step-5-preview",
  "text-embedding-3-large",
  "text-embedding-3-small",
  "veo-3.1-lite",
  "whisper-1",
  "whisper-large-v3-turbo",
];

const LABEL: WireRow = [
  "@e:f0d53",
  "t",
  `Label (opsional)|w=240|ph=Contoh: Produksi, Development...|${DIALOG}`,
];
const SEARCH: WireRow = ["@e:f0d66", "t", `Cari model...|ph=Cari model...|${DIALOG}`];
const SPEND: WireRow = [
  "@e:f0d65",
  "t",
  `Batas biaya, Rp (opsional)|ph=Contoh: 50.000|im=numeric|${DIALOG}`,
];

function checkbox(index: number): WireRow {
  const where = index >= 7 && index < 12 ? `|oc=@e:f0d54` : "";
  const offscreen = index >= 17 ? "v=offscreen|" : "";
  return [`@e:model-${index}`, "c", `${MODELS[index]}|s=u|${offscreen}n=on|${DIALOG}${where}`];
}

/** Trace row 582: "Model tertentu" chosen, the full model list rendered. */
function modelListRows(): WireRow[] {
  const boxes = MODELS.map((_, index) => checkbox(index));
  return [
    ["@e:f0d57", "b", `Buat Key|s=d|v=offscreen|a=submit|${DIALOG}`],
    LABEL,
    [
      "@e:f0d55",
      "b",
      `Pengaturan lanjutan , Berlaku selamanya , semua model , tanpa batas biaya , Tutup|${DIALOG}`,
    ],
    ["@e:f0d58", "r", `Selamanya|s=c|${DIALOG}`],
    ["@e:f0d59", "r", `7 hari|s=u|${DIALOG}`],
    ["@e:f0d60", "r", `30 hari|s=u|${DIALOG}`],
    ["@e:f0d61", "r", `90 hari|s=u|${DIALOG}`],
    ["@e:f0d62", "r", `Kustom|s=u|${DIALOG}`],
    ["@e:f0d63", "r", `Semua model|s=u|${DIALOG}`],
    ["@e:f0d64", "r", `Model tertentu|s=c|${DIALOG}`],
    SEARCH,
    ...boxes.slice(0, 14),
    ["@e:f0d188", "b", `Pilih semua|${DIALOG}`],
    ["@e:f0d189", "b", `Kosongkan|${DIALOG}`],
    ...boxes.slice(14, 17),
    SPEND,
    ...boxes.slice(17),
    ["@e:f0d56", "b", `Batal|v=offscreen|${DIALOG}`],
  ];
}

/** Trace row 578: the dialog as it first opens. */
const DIALOG_ROWS: WireRow[] = [
  ["@e:f0d57", "b", `Buat Key|a=submit|${DIALOG}`],
  LABEL,
  [
    "@e:f0d55",
    "b",
    `Pengaturan lanjutan , Berlaku selamanya , semua model , tanpa batas biaya , Atur|${DIALOG}`,
  ],
  ["@e:f0d56", "b", `Batal|${DIALOG}`],
];

/** Trace row 580: "Pengaturan lanjutan" open, all models still selected. */
const ADVANCED_ROWS: WireRow[] = [
  ["@e:f0d57", "b", `Buat Key|a=submit|${DIALOG}`],
  LABEL,
  [
    "@e:f0d55",
    "b",
    `Pengaturan lanjutan , Berlaku selamanya , semua model , tanpa batas biaya , Tutup|${DIALOG}`,
  ],
  ["@e:f0d58", "r", `Selamanya|s=c|${DIALOG}`],
  ["@e:f0d59", "r", `7 hari|s=u|${DIALOG}`],
  ["@e:f0d60", "r", `30 hari|s=u|${DIALOG}`],
  ["@e:f0d61", "r", `90 hari|s=u|${DIALOG}`],
  ["@e:f0d62", "r", `Kustom|s=u|${DIALOG}`],
  ["@e:f0d63", "r", `Semua model|s=c|${DIALOG}`],
  ["@e:f0d64", "r", `Model tertentu|s=u|${DIALOG}`],
  SPEND,
  ["@e:f0d56", "b", `Batal|${DIALOG}`],
];

function choiceCriteria(question: ReturnType<typeof buildDriveQuestions>[string] | undefined) {
  return question?.type === "choice" ? question.criteria : {};
}

function answer(criteria: Record<string, string>, choice: string) {
  return {
    type: "choice" as const,
    choice,
    confidence: 0.97,
    probabilities: peakedProbabilities(Object.keys(criteria), choice),
  };
}

function plan(rows: WireRow[]) {
  const sets = driveTargetSets(rows, facts, false, [], pageUrl, new Map(), (text) => text, [], {
    goal,
  });
  const questions = buildDriveQuestions(rows, facts, goal, false, [], pageUrl, new Map(), sets);
  return { sets, questions };
}

function typeInto(rows: WireRow[], field: WireRow, factKey: keyof typeof facts) {
  const { sets, questions } = plan(rows);
  const index = sets.TYPE_TEXT.findIndex((candidate) => candidate.ref === field[0]);
  expect(index).toBeGreaterThanOrEqual(0);
  const target = sets.TYPE_TEXT[index]!;
  // Every text field on this form is a form-value field, so its question is
  // numbered by its position in the TYPE_TEXT targets.
  const valueQuestion = `form_value_${index + 1}`;
  const valueCriteria = choiceCriteria(questions[valueQuestion]);
  return decideAfterJev({
    rows,
    facts,
    goal,
    fingerprint: `form-${rows.length}`,
    lastFingerprint: null,
    lastActionKey: null,
    pageUrl,
    sets,
    questions,
    answers: {
      operation: answer(choiceCriteria(questions.operation), "TYPE_TEXT"),
      TYPE_TEXT_target: answer(choiceCriteria(questions.TYPE_TEXT_target), target.slug),
      [valueQuestion]: answer(valueCriteria, factKey),
    },
  });
}

describe("drive budget keeps supplied facts beside a long checkbox list", () => {
  it("keeps operation and email-code choices when form values exhaust the budget", () => {
    const rows: WireRow[] = [
      ...Array.from({ length: 12 }, (_, index): WireRow => [
        `@e:field-${index}`,
        "t",
        `Bidang ${index}|fm=1`,
      ]),
      ["@e:submit", "b", "Kirim|a=submit|fm=1"],
    ];
    const suppliedFacts = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`provided_${index}`, `value-${index}`]),
    );
    const formGoal = "Complete and submit the form using the supplied values.";
    const sets = driveTargetSets(
      rows,
      suppliedFacts,
      false,
      [],
      pageUrl,
      new Map(),
      (text) => text,
      [],
      { goal: formGoal },
    );
    const questions = buildDriveQuestions(
      rows,
      suppliedFacts,
      formGoal,
      false,
      [],
      pageUrl,
      new Map(),
      sets,
    );
    const total = Object.values(questions).reduce(
      (n, question) => n + (question.type === "choice" ? Object.keys(question.criteria).length : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(DRIVE_MAX_CRITERIA);
    expect(Object.keys(choiceCriteria(questions.operation))).toContain("TYPE_TEXT");
    expect(Object.keys(choiceCriteria(questions[DRIVE_EMAIL_CODE_QUESTION]))).toHaveLength(13);
    const target = sets.TYPE_TEXT.find((candidate) => candidate.ref === "@e:field-0")!;
    expect(target).toBeDefined();
    expect(
      decideAfterJev({
        rows,
        facts: suppliedFacts,
        goal: formGoal,
        fingerprint: "localized-form",
        lastFingerprint: null,
        lastActionKey: null,
        pageUrl,
        sets,
        questions,
        answers: {
          operation: answer(choiceCriteria(questions.operation), "TYPE_TEXT"),
          TYPE_TEXT_target: answer(choiceCriteria(questions.TYPE_TEXT_target), target.slug),
          form_value_1: answer(choiceCriteria(questions.form_value_1), "provided_0"),
        },
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "type", target: "@e:field-0", text: "value-0" },
    });
  });

  it("offers every supplied fact for each form field on the Kenari model list", () => {
    const rows = modelListRows();
    expect(rows).toHaveLength(139);
    const { sets, questions } = plan(rows);

    const total = Object.values(questions).reduce(
      (n, question) => n + (question.type === "choice" ? Object.keys(question.criteria).length : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(DRIVE_MAX_CRITERIA);

    const formQuestions = Object.keys(questions).filter((name) => name.startsWith("form_value_"));
    expect(formQuestions).toHaveLength(3);
    for (const name of formQuestions) {
      const question = questions[name];
      expect(question?.type).toBe("choice");
      if (question?.type !== "choice") return;
      expect(question.criteria).toEqual({
        ...facts,
        [DRIVE_FIXED_NONE]: "no supplied value belongs in this field",
      });
      expect(question.instructions).not.toContain("omitted");
    }

    const typeTargets = sets.TYPE_TEXT.map((candidate) => candidate.ref);
    expect(typeTargets).toEqual(expect.arrayContaining([LABEL[0], SEARCH[0], SPEND[0]]));
    expect(Object.keys(choiceCriteria(questions.TYPE_TEXT_target))).toHaveLength(3);

    // The list is still trimmed, but only by what the facts needed.
    const clicks = choiceCriteria(questions.CLICK_target);
    expect(Object.keys(clicks).length).toBeGreaterThan(80);
    expect(Object.values(clicks)).toContain("ernie-5-5-flash-preview:free");
  });

  it("types the supplied key_name and model on the model list", () => {
    const rows = modelListRows();
    expect(typeInto(rows, LABEL, "key_name")).toMatchObject({
      kind: "act",
      action: { kind: "type", target: LABEL[0], text: "grunt" },
    });
    expect(typeInto(rows, SEARCH, "model")).toMatchObject({
      kind: "act",
      action: { kind: "type", target: SEARCH[0], text: "ernie-5-5-flash-preview:free" },
    });
  });

  it("types the supplied key_name at every step of the create-key dialog", () => {
    for (const rows of [DIALOG_ROWS, ADVANCED_ROWS, modelListRows()]) {
      expect(typeInto(rows, LABEL, "key_name")).toMatchObject({
        kind: "act",
        action: { kind: "type", target: LABEL[0], text: "grunt" },
      });
    }
  });
});
