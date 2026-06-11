import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FixAttempt,
  gradeAttempt,
  applyGrades,
  describeGrade,
  appendFixAttempts,
  readFixLedger,
  gradeLedgerAgainstPass,
} from "../fix-ledger.js";

function attempt(over: Partial<FixAttempt> = {}): FixAttempt {
  return {
    rc_version: "0.9.14-rc.1",
    cluster_id: "step_failed:abc",
    services: ["kinde", "plunk"],
    signature: "abc",
    summary: "force-advance reads full inventory",
    committed_at: "2026-06-11T00:00:00.000Z",
    status: "open",
    ...over,
  };
}

const map = (entries: Array<[string, boolean]>): Map<string, boolean> => new Map(entries);

describe("gradeAttempt", () => {
  it("improved — every re-tested target now succeeds", () => {
    expect(gradeAttempt(attempt(), map([["kinde", true], ["plunk", true]]))).toEqual({
      grade: "improved",
      tested: 2,
      passed: 2,
    });
  });

  it("regressed — no re-tested target succeeds", () => {
    expect(gradeAttempt(attempt(), map([["kinde", false], ["plunk", false]]))).toEqual({
      grade: "regressed",
      tested: 2,
      passed: 0,
    });
  });

  it("partial — some but not all targets succeed", () => {
    expect(gradeAttempt(attempt(), map([["kinde", true], ["plunk", false]]))).toEqual({
      grade: "partial",
      tested: 2,
      passed: 1,
    });
  });

  it("no_data — the pass re-tested none of the targets (stays open)", () => {
    expect(gradeAttempt(attempt(), map([["unrelated", true]]))).toEqual({
      grade: "no_data",
      tested: 0,
      passed: 0,
    });
  });

  it("ignores services the pass did not re-test", () => {
    // only kinde re-ran; plunk wasn't in the sweep → graded on kinde alone
    expect(gradeAttempt(attempt(), map([["kinde", true]]))).toEqual({
      grade: "improved",
      tested: 1,
      passed: 1,
    });
  });
});

describe("applyGrades", () => {
  const NOW = "2026-06-12T00:00:00.000Z";

  it("flips an open attempt to graded and reports it once", () => {
    const { ledger, newlyGraded } = applyGrades([attempt()], map([["kinde", true], ["plunk", true]]), NOW);
    expect(ledger[0]!.status).toBe("graded");
    expect(ledger[0]!.grade).toBe("improved");
    expect(ledger[0]!.graded_at).toBe(NOW);
    expect(newlyGraded).toHaveLength(1);
  });

  it("leaves no_data attempts open for a later pass", () => {
    const { ledger, newlyGraded } = applyGrades([attempt()], map([["other", true]]), NOW);
    expect(ledger[0]!.status).toBe("open");
    expect(newlyGraded).toHaveLength(0);
  });

  it("never re-grades an already-graded attempt", () => {
    const done = attempt({ status: "graded", grade: "regressed", graded_at: "2026-06-11T12:00:00.000Z" });
    const { ledger, newlyGraded } = applyGrades([done], map([["kinde", true], ["plunk", true]]), NOW);
    expect(ledger[0]!.grade).toBe("regressed"); // verdict recorded once, not flipped
    expect(newlyGraded).toHaveLength(0);
  });
});

describe("describeGrade", () => {
  it("renders a ✓ improved line with the target ratio", () => {
    const g = attempt({ status: "graded", grade: "improved", graded_detail: { tested: 2, passed: 2 } });
    expect(describeGrade(g)).toContain("✓ improved");
    expect(describeGrade(g)).toContain("(2/2 targets pass)");
    expect(describeGrade(g)).toContain("kinde,plunk");
  });

  it("renders ✗ for a regression", () => {
    const g = attempt({ status: "graded", grade: "regressed", graded_detail: { tested: 2, passed: 0 } });
    expect(describeGrade(g)).toContain("✗ regressed");
  });
});

describe("ledger round-trip + gradeLedgerAgainstPass (FS)", () => {
  it("appends open attempts, grades them on a later pass, and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "fix-ledger-"));
    const path = join(dir, "fix-ledger.json");
    try {
      appendFixAttempts([attempt()], path);
      expect(readFixLedger(path)).toHaveLength(1);
      expect(readFixLedger(path)[0]!.status).toBe("open");

      // First pass doesn't re-test the targets → stays open.
      expect(gradeLedgerAgainstPass(map([["other", true]]), "2026-06-12T00:00:00.000Z", path)).toHaveLength(0);
      expect(readFixLedger(path)[0]!.status).toBe("open");

      // Second pass re-tests them → graded + persisted.
      const graded = gradeLedgerAgainstPass(map([["kinde", true], ["plunk", true]]), "2026-06-13T00:00:00.000Z", path);
      expect(graded).toHaveLength(1);
      expect(readFixLedger(path)[0]!.status).toBe("graded");
      expect(readFixLedger(path)[0]!.grade).toBe("improved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing ledger reads as empty, not a crash", () => {
    expect(readFixLedger(join(tmpdir(), "does-not-exist-xyz", "fix-ledger.json"))).toEqual([]);
  });
});
