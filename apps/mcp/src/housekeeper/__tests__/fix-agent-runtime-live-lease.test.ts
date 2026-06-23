import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { leaseLocalLiveRun } from "../fix-agent-runtime.js";

describe("leaseLocalLiveRun", () => {
  it("creates an isolated browser-cell namespace for each live attempt", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "ts-live-lease-"));
    try {
      const first = leaseLocalLiveRun({
        repoRoot,
        service: "ClickHouse Cloud!",
        attempt: { attempt: 1, maxAttempts: 3 },
        baseEnv: { PATH: "/bin" },
      });
      const second = leaseLocalLiveRun({
        repoRoot,
        service: "ClickHouse Cloud!",
        attempt: { attempt: 2, maxAttempts: 3 },
        baseEnv: { PATH: "/bin" },
      });

      expect(first.runId).toMatch(/^live-clickhouse-cloud-a1-of-3-/);
      expect(second.runId).toMatch(/^live-clickhouse-cloud-a2-of-3-/);
      expect(first.runId).not.toBe(second.runId);
      expect(first.attemptLabel).toBe("1/3");
      expect(second.attemptLabel).toBe("2/3");
      expect(existsSync(first.debugDir)).toBe(true);
      expect(existsSync(first.tmpDir)).toBe(true);
      expect(first.env.HOUSEKEEPER_CONCURRENCY).toBe("1");
      expect(first.env.UNIVERSAL_BOT_RUN_ID).toBe(first.runId);
      expect(first.env.UNIVERSAL_BOT_DEBUG_DIR).toBe(first.debugDir);
      expect(first.env.TMPDIR).toBeUndefined();
      expect(first.env.TEMP).toBeUndefined();
      expect(first.env.TMP).toBeUndefined();
      expect(first.env.PATH).toBe("/bin");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
