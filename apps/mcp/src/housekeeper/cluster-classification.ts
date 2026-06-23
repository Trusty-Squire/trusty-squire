import type { FixBatch, FixBatchFailure } from "./fix-batch.js";

export const CLUSTER_CLASSIFIER_VERSION = 1;

export type ClusterBucket =
  | "stale_deferred"
  | "timeout_flake"
  | "oauth_session_returned_to_login"
  | "planner_action_selection"
  | "anti_bot_captcha"
  | "email_verification"
  | "credential_extraction_navigation"
  | "async_approval_pending"
  | "manual_account_review_wall"
  | "no_account_api_key_wall"
  | "phone_payment_wall"
  | "other";

export interface FailureClassification {
  service: string;
  run_id: string;
  bucket: ClusterBucket;
  reason: string;
  source_commit?: string;
  failure_stage: string;
  family_id: string;
}

export interface ClassificationBackfill {
  schema_version: 1;
  classifier_version: number;
  generated_at: string;
  current_commit?: string;
  batch_id: string;
  total_failures: number;
  buckets: Array<{
    bucket: ClusterBucket;
    failures: number;
    services: string[];
  }>;
  failures: FailureClassification[];
}

function isLoginAfterOauth(f: FixBatchFailure): boolean {
  const url = f.terminal_page?.url ?? "";
  const reason = f.terminal_page?.observed.reason ?? f.planner_reasoning ?? "";
  const hasLoginSurface = /login|sign.?in|auth|authorize|oauth/i.test(url + " " + reason);
  const saysAlreadyOauth = /already logged in|google oauth|oauth login|redirect loop|session/i.test(reason);
  return f.failure_stage === "oauth_handshake" || (f.failure_stage === "planner_loop" && hasLoginSurface && saysAlreadyOauth);
}

function isManualAccountReviewGate(f: FixBatchFailure): boolean {
  const url = f.terminal_page?.url ?? "";
  const title = f.terminal_page !== undefined ? "" : "";
  const reason = f.terminal_page?.observed.reason ?? f.planner_reasoning ?? "";
  const haystack = `${url} ${title} ${reason}`.toLowerCase();
  return (
    f.failure_stage === "manual" ||
    /waiting[_-]?room|account (?:review|approval)|under review|verify your account|manual approval/.test(
      haystack,
    )
  );
}

function isAsyncApprovalPending(f: FixBatchFailure): boolean {
  const service = f.service.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const reason = f.terminal_page?.observed.reason ?? f.planner_reasoning ?? "";
  const haystack = `${f.terminal_page?.url ?? ""} ${reason}`.toLowerCase();
  return (
    service === "baseten" &&
    /waiting[_-]?room|account (?:review|approval)|under review|verify your account/.test(
      haystack,
    )
  );
}

function isNoAccountApiKeyWall(f: FixBatchFailure): boolean {
  const service = f.service.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const reason = f.terminal_page?.observed.reason ?? f.planner_reasoning ?? "";
  const haystack = `${f.terminal_page?.url ?? ""} ${reason}`.toLowerCase();
  return (
    service === "replit" ||
    /does not support user-facing api keys|no user-facing api keys|no account-level api key|app-scoped external access token|paid plan/.test(
      haystack,
    )
  );
}

export function coarseFamilyId(f: FixBatchFailure): string {
  const observed = f.terminal_page?.observed.kind ?? "none";
  return `${f.failure_stage}:${observed}:${f.signature}`;
}

export function classifyFailureBucket(
  f: FixBatchFailure,
  currentCommit: string | undefined,
): { bucket: ClusterBucket; reason: string } {
  if (currentCommit !== undefined && f.source_commit !== currentCommit) {
    return { bucket: "stale_deferred", reason: "failure was captured by a different bot commit" };
  }
  if (f.failure_stage === "run_timeout") {
    return { bucket: "timeout_flake", reason: "timeout/env failure should retry before code spend" };
  }
  if (isLoginAfterOauth(f)) {
    return {
      bucket: "oauth_session_returned_to_login",
      reason: "terminal page is a login/auth surface after OAuth was attempted",
    };
  }
  if (f.failure_stage === "anti_bot" || f.failure_stage === "captcha") {
    return { bucket: "anti_bot_captcha", reason: "anti-bot/captcha capability gap" };
  }
  if (f.failure_stage === "verify_email") {
    return { bucket: "email_verification", reason: "email verification capability gap" };
  }
  if (isAsyncApprovalPending(f)) {
    return {
      bucket: "async_approval_pending",
      reason: "service accepted signup details but approval is asynchronous; retry same identity later",
    };
  }
  if (isManualAccountReviewGate(f)) {
    return {
      bucket: "manual_account_review_wall",
      reason: "terminal page requires manual account review/approval",
    };
  }
  if (isNoAccountApiKeyWall(f)) {
    return {
      bucket: "no_account_api_key_wall",
      reason: "service does not expose a normal account-level API key after signup",
    };
  }
  if (f.failure_stage === "extract") {
    return {
      bucket: "credential_extraction_navigation",
      reason: "post-signup credential extraction/navigation failed",
    };
  }
  if (f.failure_stage === "phone" || f.failure_stage === "payment") {
    return { bucket: "phone_payment_wall", reason: "phone/payment wall" };
  }
  if (f.failure_stage === "planner_loop") {
    return { bucket: "planner_action_selection", reason: "planner selected a bad/repeated action" };
  }
  return { bucket: "other", reason: `unclassified failure stage ${f.failure_stage}` };
}

export function buildClassificationBackfill(input: {
  batch: FixBatch;
  generatedAt: string;
  currentCommit?: string;
}): ClassificationBackfill {
  const failures = input.batch.failures.map((f): FailureClassification => {
    const classified = classifyFailureBucket(f, input.currentCommit);
    return {
      service: f.service,
      run_id: f.run_id,
      bucket: classified.bucket,
      reason: classified.reason,
      ...(f.source_commit !== undefined ? { source_commit: f.source_commit } : {}),
      failure_stage: f.failure_stage,
      family_id: coarseFamilyId(f),
    };
  });
  const byBucket = new Map<ClusterBucket, { failures: number; services: Set<string> }>();
  for (const f of failures) {
    const entry = byBucket.get(f.bucket) ?? { failures: 0, services: new Set<string>() };
    entry.failures += 1;
    entry.services.add(f.service);
    byBucket.set(f.bucket, entry);
  }
  return {
    schema_version: 1,
    classifier_version: CLUSTER_CLASSIFIER_VERSION,
    generated_at: input.generatedAt,
    ...(input.currentCommit !== undefined ? { current_commit: input.currentCommit } : {}),
    batch_id: input.batch.batch_id,
    total_failures: failures.length,
    buckets: [...byBucket.entries()]
      .map(([bucket, entry]) => ({
        bucket,
        failures: entry.failures,
        services: [...entry.services].sort(),
      }))
      .sort((a, b) => b.failures - a.failures || a.bucket.localeCompare(b.bucket)),
    failures,
  };
}
