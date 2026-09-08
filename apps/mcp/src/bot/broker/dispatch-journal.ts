import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BrokerRefusal } from "./scheduler.js";

interface DispatchRecord {
  sessionId: string;
  requestId: string;
  phase: "entered" | "settled";
  at: number;
}

/** Minimal write-ahead custody, never arguments, credentials or card values.
 * Recovery cannot replay a possibly dispatched mutation after losing its reply. */
export class DispatchJournal {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async assertReconciled(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const unsettled = new Set<string>();
    try {
      for (const line of source.split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as DispatchRecord;
        if (
          typeof record.sessionId !== "string" ||
          typeof record.requestId !== "string" ||
          !["entered", "settled"].includes(record.phase)
        )
          throw new Error("Malformed journal");
        const key = JSON.stringify([record.sessionId, record.requestId]);
        if (record.phase === "entered") unsettled.add(key);
        else unsettled.delete(key);
      }
    } catch {
      throw new BrokerRefusal(
        "outcome_unknown",
        "Dispatch journal is incomplete; reconcile before browser replacement",
      );
    }
    if (unsettled.size > 0)
      throw new BrokerRefusal(
        "outcome_unknown",
        "Prior broker lost mutation custody; reconcile before browser replacement",
      );
  }

  record(sessionId: string, requestId: string, phase: DispatchRecord["phase"]): Promise<void> {
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, "a", 0o600);
      try {
        await file.write(
          JSON.stringify({ sessionId, requestId, phase, at: Date.now() } satisfies DispatchRecord) +
            "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
    });
    this.tail = operation;
    return operation;
  }
}
