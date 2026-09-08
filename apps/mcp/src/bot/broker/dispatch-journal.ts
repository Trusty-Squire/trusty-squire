import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BrokerRefusal } from "./scheduler.js";

type DispatchPhase = "entered" | "outcome" | "acknowledged" | "settled";

interface DispatchRecord {
  sessionId: string;
  requestId: string;
  phase: DispatchPhase;
  at: number;
  agentId?: string;
  operation?: string;
}

export interface PendingDispatchOutcome {
  sessionId: string;
  requestId: string;
  operation: string;
}

/** Minimal write-ahead custody, never arguments, credentials or card values.
 * Recovery cannot replay a possibly dispatched mutation after losing its reply. */
export class DispatchJournal {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async states(): Promise<Map<string, DispatchRecord>> {
    await this.tail;
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const states = new Map<string, DispatchRecord>();
    try {
      for (const line of source.split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as DispatchRecord;
        if (
          typeof record.sessionId !== "string" ||
          typeof record.requestId !== "string" ||
          !["entered", "outcome", "acknowledged", "settled"].includes(record.phase) ||
          (record.agentId !== undefined && typeof record.agentId !== "string") ||
          (record.operation !== undefined && typeof record.operation !== "string")
        )
          throw new Error("Malformed journal");
        const key = JSON.stringify([record.sessionId, record.requestId]);
        states.set(key, record);
      }
    } catch {
      throw new BrokerRefusal(
        "outcome_unknown",
        "Dispatch journal is incomplete; reconcile before browser replacement",
      );
    }
    return states;
  }

  async assertReconciled(): Promise<void> {
    if ([...(await this.states()).values()].some((record) => record.phase === "entered"))
      throw new BrokerRefusal(
        "outcome_unknown",
        "Prior broker lost mutation custody; reconcile before browser replacement",
      );
  }

  async hasOutstanding(sessionId?: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        (sessionId === undefined || record.sessionId === sessionId) &&
        (record.phase === "entered" || record.phase === "outcome"),
    );
  }

  async pendingOutcomes(agentId: string): Promise<PendingDispatchOutcome[]> {
    return [...(await this.states()).values()]
      .filter((record) => record.phase === "outcome" && record.agentId === agentId)
      .map((record) => ({
        sessionId: record.sessionId,
        requestId: record.requestId,
        operation: record.operation ?? "operate mutation",
      }));
  }

  async hasCompleted(agentId: string, requestId: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        record.agentId === agentId &&
        record.requestId === requestId &&
        (record.phase === "outcome" || record.phase === "acknowledged"),
    );
  }

  async acknowledge(agentId: string, requestId: string): Promise<boolean> {
    const outcomes = [...(await this.states()).values()].filter(
      (record) =>
        record.agentId === agentId &&
        record.requestId === requestId &&
        record.phase === "outcome",
    );
    await Promise.all(
      outcomes.map(async (record) =>
        await this.record(record.sessionId, record.requestId, "acknowledged", {
          agentId,
          operation: record.operation,
        }),
      ),
    );
    return outcomes.length > 0;
  }

  record(
    sessionId: string,
    requestId: string,
    phase: DispatchPhase,
    detail?: Pick<DispatchRecord, "agentId" | "operation">,
  ): Promise<void> {
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, "a", 0o600);
      try {
        await file.write(
          JSON.stringify({ sessionId, requestId, phase, at: Date.now(), ...detail } satisfies DispatchRecord) +
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
