import { randomUUID } from "node:crypto";

/** Correlation tag for diagnostics; custody comes from the browser scope. */
export const OPERATOR_BROWSER_MARKER_ENV = "TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER";
export function createOperatorBrowserMarker(): string {
  return randomUUID();
}
