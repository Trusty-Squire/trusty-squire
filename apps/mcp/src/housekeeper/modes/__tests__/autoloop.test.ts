import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAutoloopCrashReport } from "../autoloop.js";

describe("autoloop crash reporting", () => {
  it("writes a durable crash report and latest pointer with progress context", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-autoloop-crash-"));
    const file = writeAutoloopCrashReport(
      {
        runId: "autoloop-test",
        phase: "fix-pass",
        lap: 4,
        maxLaps: 6,
        agent: "codex",
        currentCommit: "abc123",
        recentLogLines: ["lap 4 began", "cluster baseten stale repro"],
      },
      new Error("boom"),
      dir,
    );

    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(dir, "latest.json"))).toBe(true);
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      kind: string;
      phase: string;
      lap: number;
      max_laps: number;
      agent: string;
      current_commit: string;
      error: { message: string; stack?: string };
      recent_log_lines: string[];
    };
    expect(report.kind).toBe("autoloop_crash");
    expect(report.phase).toBe("fix-pass");
    expect(report.lap).toBe(4);
    expect(report.max_laps).toBe(6);
    expect(report.agent).toBe("codex");
    expect(report.current_commit).toBe("abc123");
    expect(report.error.message).toBe("boom");
    expect(report.error.stack).toContain("Error: boom");
    expect(report.recent_log_lines).toEqual(["lap 4 began", "cluster baseten stale repro"]);
  });
});
