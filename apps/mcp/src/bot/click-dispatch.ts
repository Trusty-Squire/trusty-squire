// Click-dispatch bookkeeping shared between the browser controller and the
// OAuth login module: whether an authorized click actually reached the page.
// Kept in a leaf module so oauth-login.ts can throw the same error class
// without a runtime import cycle back through browser.ts.

export type ClickDispatchStatus = "not_dispatched" | "dispatched" | "unknown";

export class BrowserClickDispatchError extends Error {
  readonly dispatchStatus: ClickDispatchStatus;

  constructor(dispatchStatus: ClickDispatchStatus, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "BrowserClickDispatchError";
    this.dispatchStatus = dispatchStatus;
  }
}

export function clickDispatchStatusForError(error: unknown): ClickDispatchStatus {
  return error instanceof BrowserClickDispatchError ? error.dispatchStatus : "unknown";
}
