// WebCrypto can reject a failed decrypt with an OperationError whose message
// is empty. Every visible error needs a useful fallback for its current step.
export function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(message)) return message || fallback;
  if (message.endsWith("_expired")) {
    return "This approval has expired. Ask the agent to request a new one.";
  }
  if (message.endsWith("_not_found")) {
    return "This approval link is invalid or was already used.";
  }
  return fallback;
}

export const CARD_UNLOCK_FAILED =
  "This card was saved with a different passkey. Open this link where you saved it, or add the card again here.";

export function cardUnlockError(error: unknown): string {
  return error instanceof DOMException && error.name === "OperationError"
    ? CARD_UNLOCK_FAILED
    : errorText(error, CARD_UNLOCK_FAILED);
}
