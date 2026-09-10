import type { CaptureEvidence } from "./credential-capture.js";
import type { OperationReceipt } from "./operation-receipt.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type MutationDispatchPhase = "prepared" | "dispatch_attempted";

interface RequestAutomationContext {
  signal: AbortSignal;
  phase: MutationDispatchPhase;
  onPhase?: (phase: MutationDispatchPhase) => Promise<void>;
  operationId?: string;
  onTerminal?: (receipt: OperationReceipt) => Promise<void>;
  onCapture?: (evidence: CaptureEvidence, recovery: boolean) => Promise<void>;
}

const contexts = new AsyncLocalStorage<RequestAutomationContext>();

export async function withOperatorRequestContext<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  onPhase?: (phase: MutationDispatchPhase) => Promise<void>,
  receiptContext?: {
    operationId: string;
    onTerminal?: (receipt: OperationReceipt) => Promise<void>;
    onCapture?: (evidence: CaptureEvidence, recovery: boolean) => Promise<void>;
  },
): Promise<T> {
  return await contexts.run(
    { signal, phase: "prepared", ...(onPhase ? { onPhase } : {}), ...receiptContext },
    operation,
  );
}

export function currentOperatorRequestSignal(): AbortSignal | undefined {
  return contexts.getStore()?.signal;
}

export function throwIfOperatorRequestCancelled(): void {
  const signal = currentOperatorRequestSignal();
  if (signal?.aborted) throw signal.reason ?? new Error("operator_request_cancelled");
}

/** Await this immediately before the first page/provider mutation. The journal
 * transition completes before dispatch, so a durable `prepared` record is
 * trusted runtime proof that no effect crossed this boundary. */
export async function markOperatorMutationDispatchAttempted(): Promise<void> {
  const context = contexts.getStore();
  if (context === undefined || context.phase === "dispatch_attempted") {
    throwIfOperatorRequestCancelled();
    return;
  }
  throwIfOperatorRequestCancelled();
  await context.onPhase?.("dispatch_attempted");
  context.phase = "dispatch_attempted";
  throwIfOperatorRequestCancelled();
}

export function operatorMutationDispatchPhase(): MutationDispatchPhase | "unknown" {
  return contexts.getStore()?.phase ?? "unknown";
}

/** Node 20.0 supports AbortController but not AbortSignal.any. Dispose listeners
 * when the actual operation settles, never merely when delivery times out. */
export function composeOperatorSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = (): void => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
  };
  for (const signal of signals) {
    if (controller.signal.aborted) break;
    const abort = (): void => {
      controller.abort(signal.reason);
      dispose();
    };
    if (signal.aborted) abort();
    else {
      listeners.set(signal, abort);
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  return { signal: controller.signal, dispose };
}

export function currentOperatorOperationId(): string | undefined {
  return contexts.getStore()?.operationId;
}

export async function persistOperatorTerminalReceipt(receipt: OperationReceipt): Promise<void> {
  await contexts.getStore()?.onTerminal?.(receipt);
}

/** Bounds predispatch waiting only. The underlying connection may finish for
 * another caller; this request must not proceed to mutation after cancellation. */
export async function awaitOperatorPreparation<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return await work;
  let abort!: () => void;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("operator_request_cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function persistOperatorCaptureEvidence(
  evidence: CaptureEvidence,
  recovery = false,
): Promise<void> {
  const persist = contexts.getStore()?.onCapture;
  if (recovery && persist === undefined)
    throw new Error("capture recovery requires recorded write identity");
  await persist?.(evidence, recovery);
}

/** Delivery may time out while execution still owns its lease. Callers must
 * retain that lease until `work` settles; this helper never cancels work itself. */
export async function awaitOperatorSettlement<T>(
  work: Promise<T>,
  signal: AbortSignal,
  settlementMs = 2_000,
): Promise<T> {
  let listener!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        listener = () => {
          timer = setTimeout(() => reject(new Error("operator_execution_unsettled")), settlementMs);
        };
        if (signal.aborted) listener();
        else signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
    if (timer !== undefined) clearTimeout(timer);
  }
}
