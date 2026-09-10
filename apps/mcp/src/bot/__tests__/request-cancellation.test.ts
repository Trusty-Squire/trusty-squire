import { describe, expect, it, vi } from "vitest";
import {
  composeOperatorSignals,
  markOperatorMutationDispatchAttempted,
  operatorMutationDispatchPhase,
  withOperatorRequestContext,
} from "../request-cancellation.js";

describe("operator cancellation evidence", () => {
  it("cannot claim predispatch proof without a request context", () => {
    expect(operatorMutationDispatchPhase()).toBe("unknown");
  });

  it("waits for durable dispatch evidence and fences cancellation during that write", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutate = vi.fn();
    const operation = withOperatorRequestContext(
      controller.signal,
      async () => {
        expect(operatorMutationDispatchPhase()).toBe("prepared");
        await markOperatorMutationDispatchAttempted();
        mutate();
      },
      async () => {
        entered();
        await gate;
      },
    );
    const rejected = expect(operation).rejects.toThrow("cancelled");
    await writing;
    controller.abort(new Error("cancelled"));
    release();
    await rejected;
    expect(mutate).not.toHaveBeenCalled();
  });

  it("composes signals without AbortSignal.any and removes listeners on settlement", () => {
    const first = new AbortController();
    const second = new AbortController();
    const removed = vi.spyOn(first.signal, "removeEventListener");
    const composed = composeOperatorSignals([first.signal, second.signal]);
    const reason = new Error("lease retired");
    second.abort(reason);
    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe(reason);
    expect(removed).toHaveBeenCalledOnce();
    composed.dispose();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("preserves an already-aborted source and explicit disposal", () => {
    const first = new AbortController();
    first.abort("before registration");
    expect(composeOperatorSignals([first.signal]).signal.reason).toBe("before registration");
    const second = new AbortController();
    const composed = composeOperatorSignals([second.signal]);
    composed.dispose();
    second.abort();
    expect(composed.signal.aborted).toBe(false);
  });
});
