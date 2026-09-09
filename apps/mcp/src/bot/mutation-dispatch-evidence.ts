/**
 * A handler may use this error only while it still owns positive evidence that
 * no externally visible mutation was dispatched. The broker checks nominal
 * class identity, never public error text, before making a journal outcome
 * recoverable; arbitrary and post-dispatch exceptions remain uncertain.
 */
export class ProvenPreDispatchMutationError extends Error {
  readonly dispatch = "not_dispatched" as const;

  constructor(
    readonly code: "stale_ref",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ProvenPreDispatchMutationError";
  }
}

export function provenPreDispatchMutationFailure(
  error: unknown,
): ProvenPreDispatchMutationError | null {
  return error instanceof ProvenPreDispatchMutationError ? error : null;
}
