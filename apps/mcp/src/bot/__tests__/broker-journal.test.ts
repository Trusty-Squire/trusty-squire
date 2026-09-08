import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DispatchJournal } from "../broker/dispatch-journal.js";

describe("broker dispatch custody", () => {
  it("refuses replacement after an uncertain dispatch and admits only a settled journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-journal-"));
    const path = join(root, "dispatch.jsonl");
    try {
      const journal = new DispatchJournal(path);
      await journal.assertReconciled();
      await journal.record("session", "request", "entered");
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow(
        "lost mutation custody",
      );
      await journal.record("session", "request", "settled");
      await new DispatchJournal(path).assertReconciled();
      await journal.record("session", "payment-custody", "entered");
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow(
        "lost mutation custody",
      );
      await journal.record("session", "payment-custody", "settled");
      await new DispatchJournal(path).assertReconciled();
      await appendFile(path, '{"session');
      await expect(new DispatchJournal(path).assertReconciled()).rejects.toThrow("incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
