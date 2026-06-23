import { describe, expect, it } from "vitest";
import {
  buildClassificationBackfill,
  classifyFailureBucket,
} from "../cluster-classification.js";
import type { FixBatch, FixBatchFailure } from "../fix-batch.js";
import type { FailureStats } from "../../bot/failure-stats.js";
import type { PostVerifyStep } from "../../bot/agent.js";

const EMPTY_STATS = {
  totalRuns: 0,
  totalPasses: 0,
  overallPassRate: 0,
  stageHistogram: {},
  perService: [],
  passRateVariance: 0,
} as unknown as FailureStats;

const STUCK: PostVerifyStep = { kind: "done", reason: "already logged in via Google OAuth redirect loop" };

function failure(p: Partial<FixBatchFailure>): FixBatchFailure {
  return {
    service: "svc",
    run_id: "r1",
    source_commit: "current",
    failure_stage: "planner_loop",
    terminal_round: 1,
    capture_refs: [],
    signature: "sig",
    reproduce_count: 1,
    planner_reasoning: "already logged in via Google OAuth redirect loop",
    terminal_page: {
      url: "https://example.com/login",
      inventory: [],
      observed: STUCK,
    },
    terminal_capture_ref: "/tmp/cap.json",
    ...p,
  };
}

function batch(failures: FixBatchFailure[]): FixBatch {
  return {
    batch_id: "b1",
    bot_version: "0.0.0",
    generated_at: "2026-06-20T00:00:00.000Z",
    stats: EMPTY_STATS,
    failures,
  };
}

describe("cluster classification", () => {
  it("classifies login-form-after-OAuth as oauth/session, not planner action", () => {
    expect(classifyFailureBucket(failure({}), "current").bucket).toBe(
      "oauth_session_returned_to_login",
    );
  });

  it("marks old-commit failures as stale when current commit is known", () => {
    expect(classifyFailureBucket(failure({ source_commit: "old" }), "current").bucket).toBe(
      "stale_deferred",
    );
  });

  it("classifies Baseten review waiting rooms as async approval pending, not terminal walls", () => {
    const f = failure({
      service: "baseten",
      failure_stage: "extract",
      terminal_page: {
        url: "https://app.baseten.co/waiting_room",
        inventory: [],
        observed: {
          kind: "done",
          reason: "The account is under review, so no further action can be taken.",
        },
      },
    });
    expect(classifyFailureBucket(f, "current")).toMatchObject({
      bucket: "async_approval_pending",
    });
  });

  it("classifies Replit as an account-key wall instead of planner action", () => {
    const f = failure({
      service: "replit",
      terminal_page: {
        url: "https://replit.com/~?settings.show=true&settings.tab=security",
        inventory: [],
        observed: {
          kind: "done",
          reason:
            "Replit does not support user-facing API keys through account settings; external access tokens are app-scoped.",
        },
      },
    });
    expect(classifyFailureBucket(f, "current")).toMatchObject({
      bucket: "no_account_api_key_wall",
    });
  });

  it("builds bucket summaries for backfilled failures", () => {
    const out = buildClassificationBackfill({
      batch: batch([
        failure({ service: "cockroachdb" }),
        failure({ service: "x", failure_stage: "run_timeout" }),
        failure({ service: "y", failure_stage: "captcha" }),
      ]),
      generatedAt: "2026-06-20T00:00:00.000Z",
      currentCommit: "current",
    });
    expect(out.total_failures).toBe(3);
    expect(out.buckets.map((b) => b.bucket)).toContain("oauth_session_returned_to_login");
    expect(out.buckets.map((b) => b.bucket)).toContain("timeout_flake");
    expect(out.buckets.map((b) => b.bucket)).toContain("anti_bot_captcha");
  });
});
