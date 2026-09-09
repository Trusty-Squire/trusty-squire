import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BrokerRefusal } from "./scheduler.js";

type DispatchPhase = "entered" | "outcome" | "acknowledged" | "settled" | "recovered";
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
  outcome?: ReconciledDispatchOutcome;
}

export interface ReconciledDispatchOutcome {
  status:
    | "completed"
    | "done"
    | "payment_3ds_required"
    | "payment_outcome_unknown"
    | "not_dispatched";
  error?: "stale_ref";
  next?: { tool: "operate_payment_status"; wait_seconds: number };
}

export interface PendingDispatchOutcome {
  sessionId: string;
  requestId: string;
  operation: string;
}

export interface CompletedDispatchOutcome extends PendingDispatchOutcome {
  outcome: ReconciledDispatchOutcome;
  start?: true;
}

export interface ExplicitPreDispatchFailureEvidence {
  requestId: string;
  error: "stale_ref";
  dispatch: "not_dispatched";
}

function validOutcome(value: unknown): value is ReconciledDispatchOutcome {
  if (value === null || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  if (
    ![
      "completed",
      "done",
      "payment_3ds_required",
      "payment_outcome_unknown",
      "not_dispatched",
    ].includes(String(outcome.status)) ||
    !Object.keys(outcome).every((key) => key === "status" || key === "next" || key === "error") ||
    (outcome.status === "not_dispatched"
      ? outcome.error !== "stale_ref" || outcome.next !== undefined
      : outcome.error !== undefined)
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
          !["entered", "outcome", "acknowledged", "settled", "recovered"].includes(record.phase) ||
          (record.forwarderId !== undefined && typeof record.forwarderId !== "string") ||
          (record.start !== undefined && record.start !== true) ||
          (record.operation !== undefined && typeof record.operation !== "string") ||
          (record.inputHash !== undefined && typeof record.inputHash !== "string") ||
          (record.outcome !== undefined && !validOutcome(record.outcome))
        )
          throw new Error("Malformed journal");
        if (record.phase === "recovered") continue;
        const key = JSON.stringify([record.sessionId, record.requestId]);
        const prior = states.get(key);
        if (record.phase === "outcome" && prior?.outcome?.status === "payment_outcome_unknown")
          continue;
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

  async hasPendingStartDelivery(forwarderId: string, sessionId?: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        record.forwarderId === forwarderId &&
        (sessionId === undefined || record.sessionId === sessionId) &&
        record.start === true &&
        record.phase === "acknowledged",
    );
  }

  async hasOnlyPaymentCustody(sessionId: string, forwarderId: string): Promise<boolean> {
    const outstanding = [...(await this.states()).values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        record.forwarderId === forwarderId &&
        (record.phase === "entered" || record.phase === "outcome"),
    );
    return (
      outstanding.length > 0 &&
      outstanding.every(
        (record) => record.requestId === "payment-custody" && record.phase === "entered",
      )
    );
  }

  async hasOnlyDetachedPaymentUncertainty(
    sessionId: string,
    forwarderId: string,
  ): Promise<boolean> {
    const outstanding = [...(await this.states()).values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        record.forwarderId === forwarderId &&
        (record.phase === "entered" || record.phase === "outcome"),
    );
    return (
      outstanding.length > 0 &&
      outstanding.every(
        (record) =>
          record.operation === "operate_pay" &&
          record.phase === "outcome" &&
          record.outcome?.status === "payment_outcome_unknown",
      )
    );
  }

  async recordDetachedPaymentUncertainty(sessionId: string, forwarderId: string): Promise<boolean> {
    const payments = [...(await this.states()).values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        record.forwarderId === forwarderId &&
        record.operation === "operate_pay" &&
        record.phase === "entered",
    );
    await Promise.all(
      payments.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "outcome", {
            forwarderId,
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
            outcome: { status: "payment_outcome_unknown" },
          }),
      ),
    );
    return payments.length > 0;
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
          (record.phase === "outcome" || record.phase === "acknowledged"),
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

  /**
   * Reconcile a retained pre-fix record from exact, independently preserved
   * failure metadata. This is intentionally a single supported tuple: an
   * operate_login stale_ref is raised while resolving the observed ref, before
   * the OAuth dispatch boundary. No other exception or operation is inferred.
   */
  async reconcileExplicitPreDispatchFailure(
    forwarderId: string,
    sessionId: string,
    operation: string,
    evidence: ExplicitPreDispatchFailureEvidence,
  ): Promise<CompletedDispatchOutcome | undefined> {
    if (operation !== "operate_login") return undefined;
    const record = [...(await this.states()).values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.requestId === evidence.requestId &&
        candidate.operation === operation &&
        candidate.forwarderId === forwarderId &&
        candidate.inputHash !== undefined,
    );
    if (record === undefined) return undefined;
    const outcome = { status: "not_dispatched" as const, error: evidence.error };
    if (
      (record.phase === "outcome" ||
        record.phase === "acknowledged" ||
        record.phase === "settled") &&
      record.outcome?.status === outcome.status &&
      record.outcome.error === outcome.error
    ) {
      return { sessionId, requestId: record.requestId, operation, outcome };
    }
    if (record.phase !== "entered") return undefined;
    await this.record(sessionId, record.requestId, "settled", {
      forwarderId,
      operation,
      inputHash: record.inputHash,
      outcome,
    });
    return { sessionId, requestId: record.requestId, operation, outcome };
  }

  async acknowledge(forwarderId: string, requestId: string): Promise<boolean> {
    const outcomes = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId === forwarderId &&
        record.requestId === requestId &&
        record.phase === "outcome",
    );
    await Promise.all(
      outcomes.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "acknowledged", {
            forwarderId,
            ...(record.start === true ? { start: true } : {}),
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
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
        record.phase === "acknowledged",
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
        record.phase === "acknowledged",
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

  async expirePendingStartDeliveries(now = Date.now()): Promise<number> {
    const starts = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId !== undefined &&
        record.start === true &&
        record.phase === "acknowledged" &&
        now - record.at >= START_DELIVERY_RETENTION_MS,
    );
    await Promise.all(
      starts.map(
        async (record) =>
          await this.record(record.sessionId, record.requestId, "settled", {
            forwarderId: record.forwarderId!,
            start: true,
            ...(record.operation === undefined ? {} : { operation: record.operation }),
            ...(record.inputHash === undefined ? {} : { inputHash: record.inputHash }),
            ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
          }),
      ),
    );
    return starts.length;
  }

  async recordRecovery(forwarderId: string, completed: CompletedDispatchOutcome): Promise<void> {
    await this.record(completed.sessionId, completed.requestId, "recovered", {
      forwarderId,
      ...(completed.start === true ? { start: true } : {}),
      operation: completed.operation,
      outcome: completed.outcome,
    });
  }

  record(
    sessionId: string,
    requestId: string,
    phase: DispatchPhase,
    detail?: Pick<DispatchRecord, "forwarderId" | "start" | "operation" | "inputHash" | "outcome">,
  ): Promise<void> {
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, "a", 0o600);
      try {
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
    this.tail = operation;
    return operation;
  }
}
