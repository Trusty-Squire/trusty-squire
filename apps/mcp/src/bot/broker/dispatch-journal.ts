import { captureEvidenceSchema, type CaptureEvidence } from "../credential-capture.js";
import { operationReceiptSchema, type OperationReceipt } from "../operation-receipt.js";
import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BrokerRefusal } from "./scheduler.js";

type DispatchPhase =
  | "prepared"
  | "dispatch_attempted"
  | "observed_result"
  | "delivery_acknowledged"
  | "unknown"
  | "entered"
  | "outcome"
  | "acknowledged"
  | "settled"
  | "recovered";
export const START_DELIVERY_RETENTION_MS = 5 * 60_000;

interface DispatchRecord {
  sessionId: string;
  requestId: string;
  phase: DispatchPhase;
  at: number;
  forwarderId?: string;
  start?: true;
  operation?: string;
  inputHash?: string;
  dispatchTracked?: true;
  outcome?: ReconciledDispatchOutcome;
  terminalReceipt?: OperationReceipt;
}

const phaseHasDeliverableOutcome = (record: DispatchRecord): boolean =>
  ["outcome", "acknowledged", "observed_result", "delivery_acknowledged", "unknown"].includes(
    record.phase,
  );

export interface ReconciledDispatchOutcome {
  capture?: CaptureEvidence;
  status: "completed" | "done" | "unknown" | "not_dispatched";
  error?: "stale_ref" | "cancelled" | "pre_dispatch_failure";
  reason?: "cancelled" | "execution_error";
}

export interface PendingDispatchOutcome {
  sessionId: string;
  requestId: string;
  operation: string;
}

export interface CompletedDispatchOutcome extends PendingDispatchOutcome {
  outcome: ReconciledDispatchOutcome;
  start?: true;
  alreadySettled?: true;
}

function validOutcome(value: unknown): value is ReconciledDispatchOutcome {
  if (value === null || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  if (
    !["completed", "done", "unknown", "not_dispatched"].includes(String(outcome.status)) ||
    !Object.keys(outcome).every((key) => ["status", "error", "reason", "capture"].includes(key)) ||
    (outcome.capture !== undefined && !captureEvidenceSchema.safeParse(outcome.capture).success) ||
    (outcome.status === "not_dispatched"
      ? !["stale_ref", "cancelled", "pre_dispatch_failure"].includes(String(outcome.error)) ||
        outcome.reason !== undefined
      : outcome.error !== undefined) ||
    (outcome.status === "unknown"
      ? !["cancelled", "execution_error"].includes(String(outcome.reason))
      : outcome.reason !== undefined)
  )
    return false;
  return true;
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
          ![
            "prepared",
            "dispatch_attempted",
            "observed_result",
            "delivery_acknowledged",
            "unknown",
            "entered",
            "outcome",
            "acknowledged",
            "settled",
            "recovered",
          ].includes(record.phase) ||
          (record.forwarderId !== undefined && typeof record.forwarderId !== "string") ||
          (record.start !== undefined && record.start !== true) ||
          (record.operation !== undefined && typeof record.operation !== "string") ||
          (record.inputHash !== undefined && typeof record.inputHash !== "string") ||
          (record.dispatchTracked !== undefined && record.dispatchTracked !== true) ||
          (record.outcome !== undefined && !validOutcome(record.outcome)) ||
          (record.terminalReceipt !== undefined &&
            !operationReceiptSchema.safeParse(record.terminalReceipt).success)
        )
          throw new Error("Malformed journal");
        if (record.phase === "recovered") continue;
        const key = JSON.stringify([record.sessionId, record.requestId]);
        const prior = states.get(key);
        if (prior?.outcome?.capture && !record.outcome?.capture) {
          record.outcome = { ...(record.outcome ?? prior.outcome), capture: prior.outcome.capture };
        }
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
    // Startup normalization: a dispatch-tracked "prepared" record never left
    // the broker, so settle it as not_dispatched. No retained-custody refusal:
    // the journal stays a record, not a gate on the next call.
    const records = [...(await this.states()).values()];
    for (const record of records.filter(
      (candidate) => candidate.phase === "prepared" && candidate.dispatchTracked === true,
    )) {
      await this.record(record.sessionId, record.requestId, "settled", {
        ...(record.forwarderId === undefined ? {} : { forwarderId: record.forwarderId }),
        ...(record.start === true ? { start: true } : {}),
        ...(record.operation === undefined ? {} : { operation: record.operation }),
        ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
        dispatchTracked: true,
        outcome: { status: "not_dispatched", error: "pre_dispatch_failure" },
      });
    }
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
        phaseHasDeliverableOutcome(record),
    );
    return record === undefined
      ? undefined
      : {
          sessionId: record.sessionId,
          requestId: record.requestId,
          operation: record.operation ?? "operate mutation",
          outcome: record.outcome!,
          ...(record.start === true ? { start: true } : {}),
        };
  }

  async recoveryOutcome(
    forwarderId: string,
    expected: Pick<DispatchRecord, "operation" | "inputHash"> &
      Partial<Pick<DispatchRecord, "sessionId">>,
  ): Promise<CompletedDispatchOutcome | undefined> {
    const record = [...(await this.states()).values()]
      .reverse()
      .find(
        (record) =>
          record.forwarderId === forwarderId &&
          record.operation === expected.operation &&
          record.inputHash === expected.inputHash &&
          (expected.sessionId === undefined || record.sessionId === expected.sessionId) &&
          record.outcome !== undefined &&
          phaseHasDeliverableOutcome(record),
      );
    return record === undefined
      ? undefined
      : {
          sessionId: record.sessionId,
          requestId: record.requestId,
          operation: record.operation ?? "operate mutation",
          outcome: record.outcome!,
          ...(record.start === true ? { start: true } : {}),
        };
  }

  async acknowledge(forwarderId: string, requestId: string): Promise<boolean> {
    const outcomes = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId === forwarderId &&
        record.requestId === requestId &&
        ["outcome", "observed_result", "unknown"].includes(record.phase),
    );
    await Promise.all(
      outcomes.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "delivery_acknowledged", {
            forwarderId,
            ...(record.start === true ? { start: true } : {}),
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
            ...(record.dispatchTracked === true ? { dispatchTracked: true } : {}),
            ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
          }),
      ),
    );
    return outcomes.length > 0;
  }

  async confirmStartDelivery(sessionId: string, forwarderId: string): Promise<boolean> {
    const starts = [...(await this.states()).values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        record.forwarderId === forwarderId &&
        record.start === true &&
        ["acknowledged", "delivery_acknowledged"].includes(record.phase),
    );
    await Promise.all(
      starts.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "settled", {
            forwarderId,
            start: true,
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
            ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
          }),
      ),
    );
    return starts.length > 0;
  }

  async settleExplicitStartDeliveries(forwarderId: string): Promise<boolean> {
    const starts = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId === forwarderId &&
        record.start === true &&
        record.operation === "operate_start" &&
        ["acknowledged", "delivery_acknowledged"].includes(record.phase),
    );
    await Promise.all(
      starts.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "settled", {
            forwarderId,
            start: true,
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
            ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
          }),
      ),
    );
    return starts.length > 0;
  }

  async recordRecovery(forwarderId: string, completed: CompletedDispatchOutcome): Promise<void> {
    await this.record(completed.sessionId, completed.requestId, "recovered", {
      forwarderId,
      ...(completed.start === true ? { start: true } : {}),
      operation: completed.operation,
      outcome: completed.outcome,
    });
  }

  async recordCapture(
    forwarderId: string,
    sessionId: string,
    requestId: string,
    capture: CaptureEvidence,
    recovery: boolean,
    detail?: Pick<DispatchRecord, "operation" | "inputHash" | "dispatchTracked">,
  ): Promise<void> {
    const matching = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId === forwarderId &&
        record.sessionId === sessionId &&
        record.outcome?.capture?.write_id === capture.write_id,
    );
    if (
      recovery &&
      (!matching.length ||
        matching.some((record) => record.outcome?.capture?.binding !== capture.binding))
    )
      throw new BrokerRefusal(
        "unauthorized",
        "Capture recovery requires the original service-bound write identity",
      );
    await this.record(sessionId, requestId, capture.storage === "unknown" ? "unknown" : "settled", {
      forwarderId,
      operation: "operate_extract",
      ...detail,
      outcome:
        capture.storage === "unknown"
          ? { status: "unknown", reason: "execution_error", capture }
          : { status: "completed", capture },
    });
    if (capture.stored || capture.storage === "not_attempted") {
      for (const record of matching)
        await this.record(sessionId, record.requestId, "settled", {
          forwarderId,
          ...(record.operation === undefined ? {} : { operation: record.operation }),
          ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
          ...(record.dispatchTracked === undefined
            ? {}
            : { dispatchTracked: record.dispatchTracked }),
          outcome: { status: "completed", capture },
        });
    }
  }

  async terminalReceipt(
    forwarderId: string,
    sessionId: string,
  ): Promise<OperationReceipt | undefined> {
    const record = [...(await this.states()).values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.forwarderId === forwarderId &&
        candidate.requestId === "terminal-receipt" &&
        candidate.terminalReceipt?.closed === true &&
        Date.now() - candidate.at < START_DELIVERY_RETENTION_MS,
    );
    return record?.terminalReceipt;
  }

  async recordTerminalReceipt(forwarderId: string, receipt: OperationReceipt): Promise<void> {
    const safe = operationReceiptSchema.parse(receipt);
    if (!safe.closed || !["closed", "already_closed"].includes(safe.cleanup))
      throw new Error("Terminal receipt requires established closure");
    await this.record(safe.session_id, "terminal-receipt", "settled", {
      forwarderId,
      operation: "operate_finish",
      terminalReceipt: safe,
    });
  }

  record(
    sessionId: string,
    requestId: string,
    phase: DispatchPhase,
    detail?: Pick<
      DispatchRecord,
      | "forwarderId"
      | "start"
      | "operation"
      | "inputHash"
      | "dispatchTracked"
      | "outcome"
      | "terminalReceipt"
    >,
  ): Promise<void> {
    let started = false;
    let writeAttempted = false;
    const operation = this.tail.then(async () => {
      started = true;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, "a", 0o600);
      try {
        // Refuse capacity rather than forget mutation or closure evidence.
        if ((await file.stat()).size >= 32 * 1024 * 1024)
          throw new BrokerRefusal(
            "capacity",
            "Dispatch journal capacity exhausted; retain custody",
          );
        writeAttempted = true;
        await file.write(
          JSON.stringify({
            sessionId,
            requestId,
            phase,
            at: Date.now(),
            ...detail,
          } satisfies DispatchRecord) + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
    });
    // A failure before any append can be retried without losing evidence.
    // Partial writes/fsync uncertainty poison this instance until recovery;
    // never let a later append claim durable closure over a damaged journal.
    this.tail = operation.catch((error: unknown) => {
      if (!started || writeAttempted) throw error;
    });
    return operation;
  }
}
