export const UPLOAD_PHASES = [
  "file_validation",
  "chooser_wait",
  "file_write",
  "post_upload",
] as const;
export const UPLOAD_CAUSES = [
  "file_unavailable",
  "chooser_timeout",
  "chooser_failed",
  "file_write_failed",
  "cancelled",
  "post_upload_failed",
] as const;

export interface UploadFailure {
  phase: (typeof UPLOAD_PHASES)[number];
  cause: (typeof UPLOAD_CAUSES)[number];
}

// Only these typed values cross the tool boundary. Native errors can include
// local paths and page content, so never retain them as a message or cause.
export class UploadError extends Error {
  readonly failure: UploadFailure;

  constructor(phase: UploadFailure["phase"], cause: UploadFailure["cause"]) {
    super(
      cause === "chooser_timeout"
        ? "upload: did not open a file picker within 15s"
        : `upload: ${cause}`,
    );
    this.failure = { phase, cause };
  }
}
