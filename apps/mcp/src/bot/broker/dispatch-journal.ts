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

const phaseHasOutstandingCustody = (record: DispatchRecord): boolean =>
  ["prepared", "entered", "outcome", "dispatch_attempted", "observed_result", "unknown"].includes(
    record.phase,
  ) || record.outcome?.status === "unknown";

const phaseHasDeliverableOutcome = (record: DispatchRecord): boolean =>
  ["outcome", "acknowledged", "observed_result", "delivery_acknowledged", "unknown"].includes(
    record.phase,
  );

export interface ReconciledDispatchOutcome {
  capture?: CaptureEvidence;
  status:
    | "completed"
    | "done"
    | "payment_3ds_required"
    | "payment_outcome_unknown"
    | "unknown"
    | "not_dispatched";
  error?: "stale_ref" | "cancelled" | "pre_dispatch_failure";
  reason?: "cancelled" | "execution_error";
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
  alreadySettled?: true;
}

export interface ExplicitPreDispatchFailureEvidence {
  requestId: string;
  error: "stale_ref";
  dispatch: "not_dispatched";
}

export interface AuthorizedPreDispatchFailure {
  sessionId: string;
  requestId: string;
  operation: "operate_login";
  forwarderId: string;
  inputHash: string;
}

const retainedXataPreDispatchFailure = {
  sessionId: "546b6f5a-930e-4473-8aec-43fc355fd108",
  requestId:
    "4ae34aeb-e1b8-4457-a99b-72ac418600ca:4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
  operation: "operate_login",
} as const;

function validOutcome(value: unknown): value is ReconciledDispatchOutcome {
  if (value === null || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  if (
    ![
      "completed",
      "done",
      "payment_3ds_required",
      "payment_outcome_unknown",
      "unknown",
      "not_dispatched",
    ].includes(String(outcome.status)) ||
    !Object.keys(outcome).every((key) =>
      ["status", "next", "error", "reason", "capture"].includes(key),
    ) ||
    (outcome.capture !== undefined && !captureEvidenceSchema.safeParse(outcome.capture).success) ||
    (outcome.status === "not_dispatched"
      ? !["stale_ref", "cancelled", "pre_dispatch_failure"].includes(String(outcome.error)) ||
        outcome.next !== undefined ||
        outcome.reason !== undefined
      : outcome.error !== undefined) ||
    (outcome.status === "unknown"
      ? !["cancelled", "execution_error"].includes(String(outcome.reason))
      : outcome.reason !== undefined)
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
        if (
          ["outcome", "observed_result"].includes(record.phase) &&
          prior?.outcome?.status === "payment_outcome_unknown"
        )
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
    if (
      records.some(
        (record) =>
          record.phase === "entered" ||
          record.phase === "dispatch_attempted" ||
          record.phase === "unknown" ||
          (record.phase === "prepared" && record.dispatchTracked !== true) ||
          record.outcome?.status === "unknown",
      )
    )
      throw new BrokerRefusal(
        "outcome_unknown",
        "Prior broker lost mutation custody; reconcile before browser replacement",
      );
  }

  async retainedXataPreDispatchAuthorization(): Promise<AuthorizedPreDispatchFailure | undefined> {
    const record = [...(await this.states()).values()].find(
      (candidate) =>
        candidate.sessionId === retainedXataPreDispatchFailure.sessionId &&
        candidate.requestId === retainedXataPreDispatchFailure.requestId &&
        candidate.operation === retainedXataPreDispatchFailure.operation &&
        candidate.start === undefined &&
        ((candidate.phase === "entered" && candidate.outcome === undefined) ||
          (candidate.phase === "settled" &&
            candidate.outcome?.status === "not_dispatched" &&
            candidate.outcome.error === "stale_ref")),
    );
    if (record?.forwarderId === undefined || record.inputHash === undefined) return undefined;
    return {
      ...retainedXataPreDispatchFailure,
      forwarderId: record.forwarderId,
      inputHash: record.inputHash,
    };
  }

  async hasOnlyAuthorizedPreDispatchFailure(
    authorization: AuthorizedPreDispatchFailure,
  ): Promise<boolean> {
    if (
      authorization.sessionId !== retainedXataPreDispatchFailure.sessionId ||
      authorization.requestId !== retainedXataPreDispatchFailure.requestId ||
      authorization.operation !== retainedXataPreDispatchFailure.operation
    )
      return false;
    const outstanding = [...(await this.states()).values()].filter(phaseHasOutstandingCustody);
    if (outstanding.length !== 1) return false;
    const [record] = outstanding;
    return (
      record?.phase === "entered" &&
      record.outcome === undefined &&
      record.start === undefined &&
      record.sessionId === authorization.sessionId &&
      record.requestId === authorization.requestId &&
      record.operation === authorization.operation &&
      record.forwarderId === authorization.forwarderId &&
      record.inputHash === authorization.inputHash
    );
  }

  async hasOutstanding(sessionId?: string, forwarderId?: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        (sessionId === undefined || record.sessionId === sessionId) &&
        (forwarderId === undefined || record.forwarderId === forwarderId) &&
        phaseHasOutstandingCustody(record),
    );
  }

  async hasPendingStartDelivery(forwarderId: string, sessionId?: string): Promise<boolean> {
    return [...(await this.states()).values()].some(
      (record) =>
        record.forwarderId === forwarderId &&
        (sessionId === undefined || record.sessionId === sessionId) &&
        record.start === true &&
        ["acknowledged", "delivery_acknowledged"].includes(record.phase),
    );
  }

  async hasOnlyPaymentCustody(sessionId: string, forwarderId: string): Promise<boolean> {
    const outstanding = [...(await this.states()).values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        record.forwarderId === forwarderId &&
        phaseHasOutstandingCustody(record),
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
        phaseHasOutstandingCustody(record),
    );
    return (
      outstanding.length > 0 &&
      outstanding.every(
        (record) =>
          record.operation === "operate_pay" &&
          ["outcome", "observed_result", "delivery_acknowledged"].includes(record.phase) &&
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

  async reconcileExplicitPreDispatchFailure(
    authorization: AuthorizedPreDispatchFailure,
    evidence: ExplicitPreDispatchFailureEvidence,
  ): Promise<CompletedDispatchOutcome | undefined> {
    const { sessionId, requestId, operation, forwarderId, inputHash } = authorization;
    if (evidence.requestId !== requestId) return undefined;
    const record = [...(await this.states()).values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.requestId === requestId &&
        candidate.operation === operation &&
        candidate.forwarderId === forwarderId &&
        candidate.inputHash === inputHash &&
        candidate.start === undefined,
    );
    if (record === undefined) return undefined;
    const outcome = { status: "not_dispatched" as const, error: "stale_ref" as const };
    if (
      record.phase === "settled" &&
      record.outcome?.status === outcome.status &&
      record.outcome.error === outcome.error
    )
      return {
        sessionId,
        requestId: record.requestId,
        operation,
        outcome,
        alreadySettled: true,
      };
    if (record.phase !== "entered") return undefined;
    await this.record(sessionId, record.requestId, "settled", {
      forwarderId,
      operation,
      inputHash,
      outcome,
    });
    return { sessionId, requestId: record.requestId, operation, outcome };
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

  async expirePendingStartDeliveries(now = Date.now()): Promise<number> {
    const starts = [...(await this.states()).values()].filter(
      (record) =>
        record.forwarderId !== undefined &&
        record.start === true &&
        ["acknowledged", "delivery_acknowledged"].includes(record.phase) &&
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
    const operation = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const file = await open(this.path, "a", 0o600);
      try {
        // Refuse capacity rather than forget mutation or closure evidence.
        if ((await file.stat()).size >= 32 * 1024 * 1024)
          throw new BrokerRefusal(
            "capacity",
            "Dispatch journal capacity exhausted; retain custody",
          );
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
