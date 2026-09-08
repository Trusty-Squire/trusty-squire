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
  forwarderId?: string;
  operation?: string;
  inputHash?: string;
  outcome?: ReconciledDispatchOutcome;
}

export interface ReconciledDispatchOutcome {
  status: "completed" | "payment_3ds_required" | "payment_outcome_unknown";
  next?: { tool: "operate_payment_status"; wait_seconds: number };
}

export interface PendingDispatchOutcome {
  sessionId: string;
  requestId: string;
  operation: string;
}

export interface CompletedDispatchOutcome extends PendingDispatchOutcome {
  outcome: ReconciledDispatchOutcome;
}

function validOutcome(value: unknown): value is ReconciledDispatchOutcome {
  if (value === null || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  if (
    !["completed", "payment_3ds_required", "payment_outcome_unknown"].includes(
      String(outcome.status),
    ) ||
    !Object.keys(outcome).every((key) => key === "status" || key === "next")
  )
    return false;
  if (outcome.next === undefined) return true;
  if (outcome.next === null || typeof outcome.next !== "object") return false;
  const next = outcome.next as Record<string, unknown>;
  return (
    next.tool === "operate_payment_status" &&
    typeof next.wait_seconds === "number" &&
    Number.isSafeInteger(next.wait_seconds) &&
    next.wait_seconds >= 0 &&
    Object.keys(next).every((key) => key === "tool" || key === "wait_seconds")
  );
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
          (record.forwarderId !== undefined && typeof record.forwarderId !== "string") ||
          (record.operation !== undefined && typeof record.operation !== "string") ||
          (record.inputHash !== undefined && typeof record.inputHash !== "string") ||
          (record.outcome !== undefined && !validOutcome(record.outcome))
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

  async hasOutstanding(sessionId?: string, forwarderId?: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        (sessionId === undefined || record.sessionId === sessionId) &&
        (forwarderId === undefined || record.forwarderId === forwarderId) &&
        (record.phase === "entered" || record.phase === "outcome"),
    );
  }

  async pendingOutcomes(forwarderId: string): Promise<PendingDispatchOutcome[]> {
    return [...(await this.states()).values()]
      .filter((record) => record.phase === "outcome" && record.forwarderId === forwarderId)
      .map((record) => ({
        sessionId: record.sessionId,
        requestId: record.requestId,
        operation: record.operation ?? "operate mutation",
      }));
  }

  async hasCompleted(forwarderId: string, requestId: string): Promise<boolean> {
    return (await this.completedOutcome(forwarderId, requestId)) !== undefined;
  }

  async completedOutcome(
    forwarderId: string,
    requestId: string,
    expected?: Pick<DispatchRecord, "operation" | "inputHash">,
  ): Promise<CompletedDispatchOutcome | undefined> {
    const record = [...(await this.states()).values()].find(
      (record) =>
        record.forwarderId === forwarderId &&
        record.requestId === requestId &&
        (expected === undefined ||
          (record.operation === expected.operation && record.inputHash === expected.inputHash)) &&
        record.outcome !== undefined &&
        (record.phase === "outcome" || record.phase === "acknowledged"),
    );
    return record === undefined
      ? undefined
      : {
          sessionId: record.sessionId,
          requestId: record.requestId,
          operation: record.operation ?? "operate mutation",
          outcome: record.outcome!,
        };
  }

  async acknowledge(forwarderId: string, requestId: string): Promise<boolean> {
    const outcomes = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId === forwarderId &&
        record.requestId === requestId &&
        record.phase === "outcome",
    );
    await Promise.all(
      outcomes.map(async (record) =>
        await this.record(record.sessionId, record.requestId, "acknowledged", {
          agentId: record.agentId,
          forwarderId,
          operation: record.operation,
          inputHash: record.inputHash,
          outcome: record.outcome,
        }),
      ),
    );
    return outcomes.length > 0;
  }

  record(
    sessionId: string,
    requestId: string,
    phase: DispatchPhase,
    detail?: Pick<
      DispatchRecord,
      "agentId" | "forwarderId" | "operation" | "inputHash" | "outcome"
    >,
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
