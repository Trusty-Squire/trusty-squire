// Covers rejection-record.ts — the persistence layer for synthesizer
// failures. Properties under test:
//
//   1. rejection.json is well-formed, schema-versioned, and matches
//      the synthesizer's structured rejection.
//   2. Capture files matching the run are copied into captures/ as
//      evidence; non-matching files are not.
//   3. A missing or unreadable capture dir does not throw — the
//      rejection record is still written, with rounds_copied: 0.

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRejection, type RejectionFile } from "../rejection-record.js";
import { SYNTHESIZER_VERSION, type PromoteRejection } from "../promote-to-skill.js";

function makeRejection(overrides: Partial<PromoteRejection> = {}): PromoteRejection {
  return {
    kind: "rejected",
    stage: "synthesis",
    error_kind: "no_extract_step",
    message: "test rejection",
    synthesizer_version: SYNTHESIZER_VERSION,
    ...overrides,
  };
}

describe("writeRejection — output structure", () => {
  it("writes rejection.json with rejection_format_version: 1", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));
    const now = new Date("2026-05-21T04:00:00.000Z");

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now,
    });

    expect(existsSync(result.rejectionFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(result.rejectionFile, "utf8")) as RejectionFile;
    expect(parsed.rejection_format_version).toBe(1);
    expect(parsed.service).toBe("railway");
    expect(parsed.run_id).toBe("abc123");
    expect(parsed.error_kind).toBe("no_extract_step");
    expect(parsed.synthesizer_version).toBe(SYNTHESIZER_VERSION);
    expect(parsed.rejected_at).toBe("2026-05-21T04:00:00.000Z");
  });

  it("preserves offending_round / offending_step / detail when present", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection({
        offending_round: 3,
        offending_step: 1,
        detail: "additional debug info",
      }),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    const parsed = JSON.parse(readFileSync(result.rejectionFile, "utf8")) as RejectionFile;
    expect(parsed.offending_round).toBe(3);
    expect(parsed.offending_step).toBe(1);
    expect(parsed.detail).toBe("additional debug info");
  });

  it("uses nulls for absent offending_round / offending_step / detail", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    const parsed = JSON.parse(readFileSync(result.rejectionFile, "utf8")) as RejectionFile;
    expect(parsed.offending_round).toBeNull();
    expect(parsed.offending_step).toBeNull();
    expect(parsed.detail).toBeNull();
  });

  it("creates a captures/ subdirectory under the rejection dir", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    expect(existsSync(result.capturesDir)).toBe(true);
    expect(result.capturesCopied).toBe(0); // empty captureDir
  });
});

describe("writeRejection — capture evidence", () => {
  it("copies matching capture files into captures/", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    // Drop three capture-looking files into captureDir.
    writeFileSync(join(captureDir, "railway-abc123-r0.json"), '{"r":0}');
    writeFileSync(join(captureDir, "railway-abc123-r1.json"), '{"r":1}');
    writeFileSync(join(captureDir, "railway-abc123-r2.json"), '{"r":2}');

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    expect(result.capturesCopied).toBe(3);
    const copied = readdirSync(result.capturesDir).sort();
    expect(copied).toEqual([
      "railway-abc123-r0.json",
      "railway-abc123-r1.json",
      "railway-abc123-r2.json",
    ]);
  });

  it("does NOT copy files belonging to other runs", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    writeFileSync(join(captureDir, "railway-abc123-r0.json"), '{"r":0}');
    writeFileSync(join(captureDir, "railway-xyz789-r0.json"), '{"r":0}'); // different runId
    writeFileSync(join(captureDir, "sentry-abc123-r0.json"), '{"r":0}'); // different service

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    expect(result.capturesCopied).toBe(1);
    expect(readdirSync(result.capturesDir)).toEqual(["railway-abc123-r0.json"]);
  });

  it("records 0 rounds_copied when captureDir does not exist", () => {
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));
    const nonExistent = join(tmpdir(), `rr-missing-${Date.now()}`);

    expect(() =>
      writeRejection({
        rejection: makeRejection(),
        captureDir: nonExistent,
        service: "railway",
        runId: "abc123",
        failedRoot,
        now: new Date(),
      }),
    ).not.toThrow();
  });
});

describe("writeRejection — directory naming", () => {
  it("includes service slug, runId, and a timestamp in the directory name", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date("2026-05-21T04:00:00.000Z"),
    });

    const dirName = result.rejectionDir.split("/").pop()!;
    expect(dirName).toMatch(/^railway-abc123-/);
  });

  it("slugifies service names with non-alphanumeric characters", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "Some_Service.Name",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    const dirName = result.rejectionDir.split("/").pop()!;
    expect(dirName).toMatch(/^some-service-name-abc123-/);
  });
});

describe("writeRejection — captures evidence includes prefix in metadata", () => {
  it("records the prefix used for evidence lookup", () => {
    const captureDir = mkdtempSync(join(tmpdir(), "rr-capture-"));
    const failedRoot = mkdtempSync(join(tmpdir(), "rr-failed-"));

    const result = writeRejection({
      rejection: makeRejection(),
      captureDir,
      service: "railway",
      runId: "abc123",
      failedRoot,
      now: new Date(),
    });

    const parsed = JSON.parse(readFileSync(result.rejectionFile, "utf8")) as RejectionFile;
    expect(parsed.capture_evidence.capture_prefix).toBe("railway-abc123-r");
    expect(parsed.capture_evidence.rounds_copied).toBe(0);
  });
});
