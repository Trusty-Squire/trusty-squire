/** A Trusty Squire API call answered with a non-2xx status. `code` is the API's `error` field. */
export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

/** An API method was called on a client built without a session token. */
export class MissingTokenError extends Error {
  constructor() {
    super(
      "This Squire client has no token. Pass { token } to call the API; keep the token on your server.",
    );
    this.name = "MissingTokenError";
  }
}

export type WebhookVerificationCode =
  | "missing_secret"
  | "missing_signature"
  | "malformed_signature"
  | "invalid_signature"
  | "timestamp_out_of_range"
  | "replayed_event"
  | "invalid_payload";

/** A webhook delivery failed verification. Reject the request; do not act on it. */
export class WebhookVerificationError extends Error {
  constructor(
    public readonly code: WebhookVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export type ApprovalOpenCode = "no_browser" | "invalid_approval_url" | "popup_blocked";

/** `approvals.open()` could not show the Squire approval page. */
export class ApprovalOpenError extends Error {
  constructor(
    public readonly code: ApprovalOpenCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalOpenError";
  }
}
