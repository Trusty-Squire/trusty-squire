import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProvisionRun } from "../provision-run.js";

describe("ProvisionRun evidence persistence", () => {
  it("persists an evidence sidecar and reports persistence status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-provision-evidence-"));
    const run = createProvisionRun({
      service: "Example Service",
      accountId: "acct_1",
      runId: "run_1",
      provisionId: "prov_1",
      evidenceDir: dir,
    });
    run.evidence.append("custom.event", { ok: true });

    const status = run.evidence.persistenceStatus();
    expect(status.ok).toBe(true);
    expect(status.attempted).toBe(true);
    expect(status.path).toBe(run.evidencePath);
    const persisted = JSON.parse(readFileSync(run.evidencePath!, "utf8")) as Array<{ kind: string }>;
    expect(persisted.map((event) => event.kind)).toEqual([
      "provision.run.started",
      "custom.event",
    ]);
  });

  it("can disable sidecar persistence explicitly", () => {
    const run = createProvisionRun({
      service: "Example Service",
      accountId: "acct_1",
      runId: "run_1",
      provisionId: "prov_1",
      evidenceDir: null,
    });
    expect(run.evidencePath).toBeUndefined();
    expect(run.evidence.persistenceStatus()).toEqual({
      attempted: false,
      ok: null,
    });
  });

  it("reports sidecar persistence failures without breaking the run", () => {
    const fileAsDir = join(mkdtempSync(join(tmpdir(), "ts-provision-evidence-")), "not-a-dir");
    writeFileSync(fileAsDir, "x");
    const run = createProvisionRun({
      service: "Example Service",
      accountId: "acct_1",
      runId: "run_1",
      provisionId: "prov_1",
      evidenceDir: fileAsDir,
    });
    const status = run.evidence.persistenceStatus();
    expect(status.attempted).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.error).toBeTypeOf("string");
    expect(run.evidence.snapshot().map((event) => event.kind)).toEqual([
      "provision.run.started",
    ]);
  });
});
