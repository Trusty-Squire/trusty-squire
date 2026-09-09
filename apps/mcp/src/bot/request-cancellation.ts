import { AsyncLocalStorage } from "node:async_hooks";

export type MutationDispatchPhase = "prepared" | "dispatch_attempted";

interface RequestAutomationContext {
  signal: AbortSignal;
  phase: MutationDispatchPhase;
  onPhase?: (phase: MutationDispatchPhase) => Promise<void>;
}

const contexts = new AsyncLocalStorage<RequestAutomationContext>();

export async function withOperatorRequestContext<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  onPhase?: (phase: MutationDispatchPhase) => Promise<void>,
): Promise<T> {
  return await contexts.run(
    { signal, phase: "prepared", ...(onPhase ? { onPhase } : {}) },
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

export function operatorMutationDispatchPhase(): MutationDispatchPhase {
  return contexts.getStore()?.phase ?? "prepared";
}
