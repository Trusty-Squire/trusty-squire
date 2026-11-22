// The option-building causes of low-confidence stops, and the language-neutral
// credential-change guard. Rows are taken from the traced drives they fixed.
import { describe, expect, it } from "vitest";
import {
  admitsChoice,
  buildDriveQuestions,
  candidateDestinations,
  decideAfterJev,
  driveTargetSets,
  emptyDriveState,
  isCredentialMutationConfirmRow,
  isExistingCredentialMutationRow,
  isSubmitLikeRow,
  pageHasUntriedPendingAction,
  recordUndeliveredDecision,
  recordWaitingDecision,
  stableControlKey,
  waitingFieldsByControl,
  type WireRow,
} from "../operate-drive.js";
import type { JevAnswer } from "../jev-client.js";
import { driveRowsFromSnapshot, type DriveSnapshot } from "../drive-snapshot.js";

function answer(
  criteria: Record<string, string>,
  probabilities: Record<string, number>,
): JevAnswer {
  const full = Object.fromEntries(
    Object.keys(criteria).map((key) => [key, probabilities[key] ?? 0]),
  );
  const [choice, confidence] = Object.entries(full).sort((a, b) => b[1] - a[1])[0]!;
  return { choice, confidence, probabilities: full };
}

function choiceCriteria(
  questions: ReturnType<typeof buildDriveQuestions>,
  name: string,
): Record<string, string> {
  const question = questions[name];
  if (question?.type !== "choice") throw new Error(`missing ${name}`);
  return question.criteria;
}

function slugFor(criteria: Record<string, string>, label: string): string {
  const slug = Object.keys(criteria).find((key) => criteria[key]!.startsWith(label));
  if (slug === undefined) throw new Error(`no option ${label}`);
  return slug;
}

describe("submit detection uses the page's own marker", () => {
  // Darus register form (squire-1.1.58 L160): "Register now" in Indonesian.
  const darus: WireRow[] = [
    ["@e:f0d1", "t", "Nama Anda|s=r|ph=Nama Anda|fm=1"],
    ["@e:f0d2", "t", "username|s=r|fm=1"],
    ["@e:f0d3", "b", "Daftar sekarang|s=d|a=submit|fm=1"],
    ["@e:f0d4", "l", "Daftar|u=https://gateway.darusalfatah.id/masuk?mode=register"],
  ];

  it("counts a form's a=submit control whatever its words", () => {
    expect(isSubmitLikeRow(darus[2]!)).toBe(true);
    expect(isSubmitLikeRow(["@e:x", "b", "Simpan|a=submit|fm=2"])).toBe(true);
  });

  it("does not count a type=submit button outside any form", () => {
    // Fikra's dark-mode toggle (squire-1.1.58 L342) submits nothing.
    expect(isSubmitLikeRow(["@e:f0d2", "b", "☾|a=submit"])).toBe(false);
  });

  it("does not infer submission from a control's words", () => {
    for (const label of ["Submit", "Continue", "Create Account", "Register", "Next", "Pay now"]) {
      expect(isSubmitLikeRow(["@e:x", "b", `${label}|fm=1`])).toBe(false);
    }
  });

  it("offers the hinted fields of a non-English form for typing", () => {
    const url = "https://gateway.darusalfatah.id/masuk?mode=register";
    const facts = { plan: "free", project_name: "grunt" };
    const sets = driveTargetSets(darus, facts, false, [], url);
    expect(sets.operations).toContain("TYPE_TEXT");
    expect(sets.TYPE_TEXT.map((candidate) => candidate.ref)).toEqual(["@e:f0d1", "@e:f0d2"]);
    const questions = buildDriveQuestions(darus, facts, "register grunt", false, [], url);
    expect(Object.keys(questions).filter((name) => name.startsWith("form_value"))).toHaveLength(2);
  });
});

describe("links to the same place are one answer", () => {
  // LiveKit settings (squire-1.1.57 L1062): .47 / .44 over two links to one page.
  const url = "https://cloud.livekit.io/projects/p_1/settings";
  const rows: WireRow[] = [
    ["@e:a", "l", "Observability|u=https://cloud.livekit.io/projects/p_1/settings/observability"],
    [
      "@e:b",
      "l",
      "Observability settings|v=offscreen|u=https://cloud.livekit.io/projects/p_1/settings/observability",
    ],
    ["@e:c", "l", "Members|u=https://cloud.livekit.io/projects/p_1/settings/members"],
    ["@e:d", "b", "Switch project"],
  ];
  const sets = driveTargetSets(rows, {}, false, [], url);
  const questions = buildDriveQuestions(
    rows,
    {},
    "turn observability off",
    false,
    [],
    url,
    new Map(),
    sets,
  );
  const ops = choiceCriteria(questions, "operation");
  const targets = choiceCriteria(questions, "CLICK_target");
  const split = answer(targets, {
    [slugFor(targets, "Observability settings")]: 0.44,
    [slugFor(targets, "Observability")]: 0.47,
    [slugFor(targets, "Members")]: 0.05,
    [slugFor(targets, "Switch project")]: 0.04,
  });

  it("keeps long destinations distinct through snapshot conversion and admission", () => {
    const prefix = `https://cloud.livekit.io/${"x".repeat(130)}`;
    const snapshot: DriveSnapshot = {
      url, title: "Settings", headings: [], text: "", fingerprint: "fp", documentEpoch: "1",
      omittedValues: 0, scriptMs: 0, wallMs: 0,
      elements: [
        { ref: "@e:a", role: "link", label: "First", href: `${prefix}/first`, operations: ["click"], frameOrdinal: 0 },
        { ref: "@e:b", role: "link", label: "Second", href: `${prefix}/second`, operations: ["click"], frameOrdinal: 0 },
        { ref: "@e:c", role: "button", label: "Other", operations: ["click"], frameOrdinal: 0 },
      ],
    };
    const admission = () => {
      const candidates = driveTargetSets(driveRowsFromSnapshot(snapshot), {}, false, [], url).CLICK;
      const criteria = Object.fromEntries(
        candidates.map((candidate) => [candidate.slug, candidate.row[2]!.split("|")[0]!]),
      );
      const votes = answer(criteria, {
        [slugFor(criteria, "First")]: 0.47,
        [slugFor(criteria, "Second")]: 0.44,
        [slugFor(criteria, "Other")]: 0.09,
      });
      return admitsChoice(criteria, votes, { destinations: candidateDestinations(candidates, url) });
    };
    expect(admission()).toMatchObject({ kind: "low_confidence" });
    snapshot.elements[1]!.href = snapshot.elements[0]!.href;
    expect(admission()).toEqual({ ok: true });
  });

  it.each([
    "javascript:void(0)", " JavaScript:void(0) ", "#", "#panel", " #panel ",
    url, `${url}#`, `${url}#panel`, "./settings", "./settings#panel", "mailto:team@example.test",
    "data:text/plain,action", "http://[", "   ",
  ])("does not merge distinct actions sharing the placeholder %s", (href) => {
    const candidates = sets.CLICK.map((candidate) => ({
      ...candidate,
      row: candidate.row[1] === "l"
        ? [candidate.ref, candidate.row[1], `${candidate.description}|u=${href}`] as WireRow
        : candidate.row,
    }));
    const votes = answer(targets, {
      [slugFor(targets, "Observability")]: 0.47,
      [slugFor(targets, "Observability settings")]: 0.44,
      [slugFor(targets, "Members")]: 0.09,
    });
    const destinations = candidateDestinations(candidates, url);
    expect(admitsChoice(targets, votes, { destinations })).toMatchObject({ kind: "low_confidence" });
    expect(decideAfterJev({
      answers: { operation: answer(ops, { CLICK: 1 }), CLICK_target: votes },
      rows: candidates.map((candidate) => candidate.row),
      facts: {}, lastFingerprint: null, lastActionKey: null, fingerprint: "fp",
      goal: "open settings", pageUrl: url, questions, sets: { ...sets, CLICK: candidates },
    })).toMatchObject({ kind: "low_confidence" });
  });

  it.each([
    "/projects/p_1/observability", "https://cloud.livekit.io/other#panel",
    "http://cloud.livekit.io/other", `${url}?view=other#panel`,
  ])("keeps equivalent real navigation links to %s", (href) => {
    const candidates = sets.CLICK.map((candidate) => ({
      ...candidate,
      row: candidate.row[1] === "l"
        ? [candidate.ref, candidate.row[1], `${candidate.description}|u=${href}`] as WireRow
        : candidate.row,
    }));
    expect(admitsChoice(targets, split, { destinations: candidateDestinations(candidates, url) }))
      .toEqual({ ok: true });
  });

  it("ignores a same-destination twin as the runner-up", () => {
    expect(admitsChoice(targets, split)).toMatchObject({ kind: "low_confidence" });
    expect(
      admitsChoice(targets, split, { destinations: candidateDestinations(sets.CLICK, url) }),
    ).toEqual({ ok: true });
  });

  it("acts on the split pick when the operation is sure", () => {
    const decision = decideAfterJev({
      answers: { operation: answer(ops, { CLICK: 0.9, DONE: 0.1 }), CLICK_target: split },
      rows,
      facts: {},
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "fp",
      goal: "turn observability off",
      pageUrl: url,
      sets,
      questions,
    });
    expect(decision).toMatchObject({ kind: "act", action: { kind: "click", target: "@e:a" } });
  });

  it("still counts a different destination as the runner-up", () => {
    const destinations = candidateDestinations(sets.CLICK, url);
    destinations[slugFor(targets, "Observability settings")] = "https://cloud.livekit.io/other";
    expect(admitsChoice(targets, split, { destinations })).toMatchObject({
      kind: "low_confidence",
    });
  });
});

describe("a confident target derives the operation", () => {
  // Zro API keys (squire-1.1.56 L56): CLICK .53 vs SCROLL .33, "Create key" .89.
  const url = "https://zro.moonmath.ai/api-keys";
  const rows: WireRow[] = [
    ["@e:f0d1", "b", "Create key"],
    ["@e:f0d2", "l", "Overview|u=https://zro.moonmath.ai/"],
    ["@e:f0d3", "l", "Docs|v=offscreen|u=https://zro.moonmath.ai/docs"],
  ];
  const goal = "create one API key for grunt";
  const sets = driveTargetSets(rows, {}, false, [], url);
  const questions = buildDriveQuestions(rows, {}, goal, false, [], url, new Map(), sets);
  const ops = choiceCriteria(questions, "operation");
  const targets = choiceCriteria(questions, "CLICK_target");
  const decide = (operation: Record<string, number>, target = 0.89) =>
    decideAfterJev({
      answers: {
        operation: answer(ops, operation),
        CLICK_target: answer(targets, {
          [slugFor(targets, "Create key")]: target,
          [slugFor(targets, "Overview")]: 1 - target,
        }),
      },
      rows,
      facts: {},
      lastFingerprint: null,
      lastActionKey: null,
      fingerprint: "fp",
      goal,
      pageUrl: url,
      sets,
      questions,
    });

  it("clicks a confident target through a CLICK / SCROLL split", () => {
    expect(ops).toHaveProperty("SCROLL");
    expect(decide({ CLICK: 0.53, SCROLL: 0.33, NONE_OF_THESE: 0.14 })).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:f0d1" },
      confidence: 0.89,
    });
    expect(decide({ SCROLL: 0.46, CLICK: 0.31, NONE_OF_THESE: 0.23 })).toMatchObject({
      kind: "act",
      action: { kind: "click", target: "@e:f0d1" },
    });
  });

  it("keeps the bar on acting at all and on the target", () => {
    // Acting vs stopping is still the question: CLICK + SCROLL under the bar refuses.
    expect(decide({ CLICK: 0.5, NONE_OF_THESE: 0.3, BLOCKED: 0.2 })).toMatchObject({
      kind: "low_confidence",
    });
    expect(decide({ CLICK: 0.53, SCROLL: 0.33, NONE_OF_THESE: 0.14 }, 0.56)).toMatchObject({
      kind: "low_confidence",
    });
    // A fixed choice on top is never derived into a click.
    expect(decide({ DONE: 0.45, CLICK: 0.3, SCROLL: 0.25 })).toMatchObject({
      kind: "low_confidence",
    });
  });
});

describe("a guard-refused submit stays offered", () => {
  // Fikra sign-up (squire-1.1.59 L102): the submit was refused for the empty
  // email field and then vanished from every later question.
  const url = "https://fikraapi.co.ke/account/signup";
  const rows: WireRow[] = [
    ["@e:f0d1", "t", "you@example.com|s=r|ph=you@example.com|fm=1"],
    ["@e:f0d7", "b", "Create Account with $0.50 free-model credit|a=submit|fm=1"],
    ["@e:f0d2", "b", "☾|a=submit"],
    ["@e:f0d3", "l", "Sign In|u=https://fikraapi.co.ke/account/login"],
  ];
  const decision = { action: { kind: "click" }, actionKey: "@e:f0d7", confidence: 0.9 };
  const reason =
    "decided submit was not executed because required field you@example.com is still empty";

  it("marks the submit with the field it waits on and offers that field", () => {
    const drive = emptyDriveState("sign up", {});
    recordWaitingDecision(drive, rows, decision, url, rows[0]!, reason);
    expect(drive.failedActionKeys).toEqual([]);
    expect(drive.staleClickRefs).toEqual([]);
    const waitingFields = waitingFieldsByControl(drive.waitingControls!, rows, [], url);
    const sets = driveTargetSets(rows, {}, false, [], url, new Map(), (text) => text, [], {
      failedKeys: drive.failedActionKeys!,
      waitingFields,
    });
    const submit = sets.CLICK.find((candidate) => candidate.ref === "@e:f0d7");
    expect(submit?.waitsFor).toBe("you@example.com");
    expect(sets.TYPE_TEXT.map((candidate) => candidate.ref)).toContain("@e:f0d1");
    const questions = buildDriveQuestions(rows, {}, "sign up", false, [], url, new Map(), sets);
    expect(choiceCriteria(questions, "CLICK_target")[submit!.slug]).toBe(
      "Create Account with $0.50 free-model credit (waits for the empty you@example.com field)",
    );
  });

  it("stops waiting once the field holds a value", () => {
    const drive = emptyDriveState("sign up", {});
    recordWaitingDecision(drive, rows, decision, url, rows[0]!, reason);
    expect(waitingFieldsByControl(drive.waitingControls!, rows, ["@e:f0d1"], url).size).toBe(0);
    const typed: WireRow[] = [
      ["@e:f0d1", "t", "you@example.com|s=rp|n=a@b.co|fm=1"],
      ...rows.slice(1),
    ];
    expect(waitingFieldsByControl(drive.waitingControls!, typed, [], url).size).toBe(0);
    expect(pageHasUntriedPendingAction(typed, drive, url, "sign up")).toBe(true);
    drive.filledRefs.push("@e:f0d1");
    expect(pageHasUntriedPendingAction(rows, drive, url, "sign up")).toBe(true);
    expect(pageHasUntriedPendingAction(rows.slice(1), drive, url, "sign up")).toBe(true);
  });

  it("keeps repeated refusals waiting on the same empty field", () => {
    const drive = emptyDriveState("sign up", {});
    recordWaitingDecision(drive, rows, decision, url, rows[0]!, reason);
    recordWaitingDecision(drive, rows, decision, url, rows[0]!, reason);
    expect(drive.waitingControls).toEqual([
      { control: stableControlKey(rows[1]!, url), field: stableControlKey(rows[0]!, url) },
    ]);
  });

  it("is not untried work while it waits", () => {
    const drive = emptyDriveState("sign up", {});
    expect(pageHasUntriedPendingAction(rows, drive, url, "sign up")).toBe(true);
    recordWaitingDecision(drive, rows, decision, url, rows[0]!, reason);
    expect(pageHasUntriedPendingAction(rows, drive, url, "sign up")).toBe(false);
  });

  it("offers a waiting native select only through SELECT", () => {
    const select: WireRow = ["@e:country", "s", "Country|s=r|fm=1"];
    const formRows = [select, rows[1]!];
    const drive = emptyDriveState("sign up", {});
    recordWaitingDecision(drive, formRows, decision, url, select, reason);
    const waitingFields = waitingFieldsByControl(drive.waitingControls!, formRows, [], url);
    const sets = driveTargetSets(formRows, {}, false, [], url,
      new Map([[select[0], ["Canada", "Japan"]]]), (text) => text, [], { waitingFields });
    expect(sets.TYPE_TEXT.some((candidate) => candidate.ref === select[0])).toBe(false);
    expect(sets.SELECT.filter((candidate) => candidate.ref === select[0]).map((candidate) => candidate.option))
      .toEqual(expect.arrayContaining(["Canada", "Japan"]));
    expect(sets.CLICK.find((candidate) => candidate.ref === decision.actionKey)?.waitsFor).toBe("Country");
  });

  it("still removes a control refused for any other reason", () => {
    const drive = emptyDriveState("sign up", {});
    recordUndeliveredDecision(drive, rows, decision, url, "decided control was no longer bound");
    const sets = driveTargetSets(rows, {}, false, [], url, new Map(), (text) => text, [], {
      failedKeys: drive.failedActionKeys!,
    });
    expect(sets.CLICK.map((candidate) => candidate.ref)).not.toContain("@e:f0d7");
  });
});

describe("credential changes are caught by structure", () => {
  const url = "https://kenari.id/keys";

  it.each(["Cabut key", "Ganti key", "Ganti", "任意"])(
    "refuses an existing credential row's %s control",
    (label) => {
      expect(isExistingCredentialMutationRow(["@e:x", "b", `${label}|credential=1`])).toBe(true);
      expect(isExistingCredentialMutationRow(["@e:x", "s", `${label}|credential=1`])).toBe(true);
      expect(isExistingCredentialMutationRow(["@e:x", "b", label])).toBe(false);
    },
  );

  it("leaves creation, workspace menus and just-shown key presentation available", () => {
    for (const label of ["Create key", "Buat API Key", "Ganti workspace", "Salin", "Reveal key"]) {
      expect(isExistingCredentialMutationRow(["@e:x", "b", label])).toBe(false);
    }
  });

  it.each(["b", "button", "l", "link", "m", "menuitem"])(
    "allows credential reads through the %s role without creation history",
    (role) => {
      for (const label of ["Copy", "Reveal key"]) {
        const row: WireRow = ["@e:read", role, `${label}|credential=1|dialog=@e:dialog`];
        expect(isExistingCredentialMutationRow(row)).toBe(false);
        expect(isCredentialMutationConfirmRow(row, url, { url, credentialRow: true })).toBe(false);
      }
      for (const label of ["Cabut key", "Ganti key", "Ganti"]) {
        expect(isExistingCredentialMutationRow(["@e:rotate", role, `${label}|credential=1`])).toBe(true);
      }
    },
  );

  it("does not treat a dropdown named Copy as a read action", () => {
    expect(isExistingCredentialMutationRow(["@e:select", "s", "Copy|credential=1"])).toBe(true);
  });

  it("guards a following dialog regardless of the confirmation's words", () => {
    const pressed = { url, credentialRow: true };
    for (const label of ["Ganti", "Proceed", "任意"]) {
      expect(
        isCredentialMutationConfirmRow(["@e:y", "b", `${label}|dialog=@e:dialog`], url, pressed),
      ).toBe(true);
    }
    expect(isCredentialMutationConfirmRow(["@e:y", "b", "Ganti"], url, pressed)).toBe(false);
    expect(
      isCredentialMutationConfirmRow(["@e:y", "b", "Ganti|dialog=@e:dialog"], url, { url }),
    ).toBe(false);
    expect(
      isCredentialMutationConfirmRow(
        ["@e:y", "b", "Ganti|dialog=@e:dialog"], "https://kenari.id/other", pressed,
      ),
    ).toBe(false);
  });
});
