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
  onTerminalSettled?: () => void;
  onCapture?: (evidence: CaptureEvidence, recovery: boolean) => Promise<void>;
}

const contexts = new AsyncLocalStorage<RequestAutomationContext>();
const abortBySignal = new WeakMap<AbortSignal, (reason?: unknown) => void>();

/** Bind the registered request AbortController so an in-page deadline can
 * fire the abort path that already exists, without touching other sessions. */
export function attachOperatorRequestAbort(
  signal: AbortSignal,
  abort: (reason?: unknown) => void,
): void {
  abortBySignal.set(signal, abort);
}

export function abortCurrentOperatorRequest(reason?: unknown): boolean {
  const signal = currentOperatorRequestSignal();
  if (signal === undefined) return false;
  const abort = abortBySignal.get(signal);
  if (abort === undefined) return false;
  abort(reason);
  return true;
}

export async function withOperatorRequestContext<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  onPhase?: (phase: MutationDispatchPhase) => Promise<void>,
  receiptContext?: {
    operationId: string;
    onTerminal?: (receipt: OperationReceipt) => Promise<void>;
    onTerminalSettled?: () => void;
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

/** Only call after executor evidence proves the attempt had no effect. Keep
 * earlier mutations uncertain and leave the durable journal conservative until
 * the terminal receipt; a fallback must checkpoint its own dispatch again. */
export function reconcileOperatorMutationNotDispatched(
  phaseBeforeAttempt: MutationDispatchPhase | "unknown",
): void {
  const context = contexts.getStore();
  if (context !== undefined && phaseBeforeAttempt === "prepared") {
    context.phase = "prepared";
  }
}

/** Node 20.0 supports AbortController but not AbortSignal.any. Dispose listeners
 * when the actual operation settles, never merely when delivery times out. */
export function composeOperatorSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  // Propagate a registered request-abort hook (attachOperatorRequestAbort is
  // bound to an input signal — typically the broker's registered request
  // controller). abortCurrentOperatorRequest resolves the hook from the
  // signal running in the request context, which is THIS composed signal,
  // not the original: without propagation the in-page deadline fires into a
  // WeakMap miss and the hung evaluate keeps running to its own timeout.
  for (const signal of signals) {
    const hook = abortBySignal.get(signal);
    if (hook !== undefined) {
      abortBySignal.set(controller.signal, hook);
      break;
    }
  }
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

export function settleOperatorTerminalReceipt(): void {
  contexts.getStore()?.onTerminalSettled?.();
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
