// Verifier-worker loop tests — exercise the queue → replay → outcome
// orchestration without booting a real browser. The registry client
// is a stub returning canned queues + collecting outcomes; the replay
// fn is a stub returning a canned ReplayOutcome.

import { describe, expect, it } from "vitest";
import { runOneBatch, type ReplayRunner } from "../loop.js";
import type {
  VerifierQueueItem,
  VerifierOutcomeResponse,
} from "../registry-client.js";
import type { ReplayOutcome } from "../../bot/replay-skill.js";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/adapter-sdk";

interface StubCall {
  skill_id: string;
  kind: "success" | "failure";
  reason: string;
  duration_ms?: number;
}

function makeQueueItem(skill_id: string, status: string = "pending-review"): VerifierQueueItem {
  return {
    skill_id,
    service: `svc-${skill_id.slice(0, 4)}`,
    version: "v1",
    status,
    verifier_succeeded: 0,
    verifier_failed: 0,
    consecutive_verifier_failures: 0,
    last_verified_at: null,
    next_freshness_due_at: null,
  };
}

function makeSkill(skill_id: string, service: string): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service,
    version: "v1",
    skill_id,
    signup_url: `https://${service}.example/signup`,
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: `https://${service}.example/signup`,
        provenance: { run_id: `run-${skill_id}`, round_index: 0 },
      },
      {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: `run-${skill_id}`, round_index: 1 },
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "TEST_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: [`run-${skill_id}`],
    status: "pending-review",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

function makeStubClient(opts: {
  queue: VerifierQueueItem[];
  outcomeTransition?: VerifierOutcomeResponse["transition"];
  postOutcomeThrows?: boolean;
}) {
  const outcomes: StubCall[] = [];
  const skillFetches: string[] = [];
  return {
    outcomes,
    skillFetches,
    client: {
      fetchQueue: async (_limit: number) => opts.queue,
      fetchSkill: async (skill_id: string): Promise<Skill> => {
        skillFetches.push(skill_id);
        return makeSkill(skill_id, `svc-${skill_id.slice(0, 4)}`);
      },
      postOutcome: async (input: StubCall): Promise<VerifierOutcomeResponse> => {
        if (opts.postOutcomeThrows === true) {
          throw new Error("registry unreachable (test)");
        }
        outcomes.push(input);
        return {
          transition: opts.outcomeTransition ?? "none",
          status: "pending-review",
          verifier_succeeded: 1,
          verifier_failed: 0,
          consecutive_verifier_failures: 0,
          next_freshness_due_at: null,
        };
      },
    },
  };
}

function okReplay(): ReplayRunner {
  return async () =>
    ({
      kind: "ok",
      credential: "ts_test_credential_value_long_enough",
      via: "copy_button",
    }) satisfies ReplayOutcome;
}

function failingReplay(): ReplayRunner {
  return async () =>
    ({
      kind: "step_failed",
      stepIndex: 1,
      reason: "selector not in inventory",
      capturedStep: {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: "x", round_index: 1 },
      },
    }) satisfies ReplayOutcome;
}

function throwingReplay(): ReplayRunner {
  return async () => {
    throw new Error("browser crashed");
  };
}

describe("runOneBatch — outcome routing", () => {
  it("posts kind=success when replay returns ok", async () => {
    const { client, outcomes, skillFetches } = makeStubClient({
      queue: [makeQueueItem("01TEST00000000000000000001")],
      outcomeTransition: "promoted",
    });
    const summary = await runOneBatch({
      client: client as never,
      replay: okReplay(),
      log: () => undefined,
    });
    expect(skillFetches).toEqual(["01TEST00000000000000000001"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("success");
    expect(outcomes[0]!.duration_ms).toBeTypeOf("number");
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.transitions.promoted).toBe(1);
  });

  it("posts kind=failure when replay returns step_failed", async () => {
    const { client, outcomes } = makeStubClient({
      queue: [makeQueueItem("01TEST00000000000000000002")],
    });
    const summary = await runOneBatch({
      client: client as never,
      replay: failingReplay(),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.reason).toMatch(/step_failed.*selector not in inventory/);
    expect(summary.failed).toBe(1);
  });

  it("posts kind=failure with verifier_error reason when replay throws", async () => {
    const { client, outcomes } = makeStubClient({
      queue: [makeQueueItem("01TEST00000000000000000003")],
    });
    await runOneBatch({
      client: client as never,
      replay: throwingReplay(),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.reason).toMatch(/verifier_error: browser crashed/);
  });

  it("processes every queue item even when one fails mid-batch", async () => {
    let nthCall = 0;
    const replay: ReplayRunner = async () => {
      nthCall += 1;
      if (nthCall === 2) throw new Error("transient");
      return { kind: "ok", credential: "ok-cred-value-here-long-enough", via: "copy_button" };
    };
    const { client, outcomes } = makeStubClient({
      queue: [
        makeQueueItem("01TEST00000000000000000004"),
        makeQueueItem("01TEST00000000000000000005"),
        makeQueueItem("01TEST00000000000000000006"),
      ],
    });
    const summary = await runOneBatch({
      client: client as never,
      replay,
      log: () => undefined,
    });
    expect(summary.attempted).toBe(3);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.kind).toBe("success");
    expect(outcomes[1]!.kind).toBe("failure");
    expect(outcomes[2]!.kind).toBe("success");
  });

  it("does not crash when postOutcome fails (skill stays in queue)", async () => {
    const { client } = makeStubClient({
      queue: [makeQueueItem("01TEST00000000000000000007")],
      postOutcomeThrows: true,
    });
    const logs: string[] = [];
    const summary = await runOneBatch({
      client: client as never,
      replay: okReplay(),
      log: (line) => logs.push(line),
    });
    expect(summary.attempted).toBe(1);
    expect(logs.some((l) => l.includes("postOutcome") && l.includes("WARN"))).toBe(true);
  });

  it("empties the queue → empty summary, no replay invocations", async () => {
    const { client, outcomes } = makeStubClient({ queue: [] });
    let replayCalls = 0;
    const summary = await runOneBatch({
      client: client as never,
      replay: async () => {
        replayCalls += 1;
        return { kind: "ok", credential: "x".repeat(40), via: "copy_button" };
      },
      log: () => undefined,
    });
    expect(replayCalls).toBe(0);
    expect(outcomes).toHaveLength(0);
    expect(summary.attempted).toBe(0);
  });
});

describe("runOneBatch — schema drift (P1 fix)", () => {
  it("SKIPS rather than failing when fetchSkill throws SkillSchemaDriftError", async () => {
    const { SkillSchemaDriftError } = await import("../registry-client.js");
    const outcomes: StubCall[] = [];
    const client = {
      fetchQueue: async () => [makeQueueItem("01DRIFT0000000000000000001")],
      fetchSkill: async (skill_id: string) => {
        throw new SkillSchemaDriftError(skill_id, "missing field foo");
      },
      postOutcome: async (input: StubCall) => {
        outcomes.push(input);
        return {
          transition: "none" as const,
          status: "pending-review",
          verifier_succeeded: 0,
          verifier_failed: 0,
          consecutive_verifier_failures: 0,
          next_freshness_due_at: null,
        };
      },
    };
    const logs: string[] = [];
    const summary = await runOneBatch({
      client: client as never,
      replay: okReplay(),
      log: (line) => logs.push(line),
    });
    // The bug we're guarding against: a schema-drift fetchSkill would
    // get caught by the outer catch and posted as a failure outcome.
    // Three such failures retire the skill.
    expect(outcomes).toHaveLength(0);
    expect(summary.failed).toBe(0);
    expect(summary.succeeded).toBe(0);
    expect(summary.attempted).toBe(1);
    expect(logs.some((l) => l.includes("SKIP") && l.includes("schema drift"))).toBe(true);
  });

  it("treats a non-drift fetchSkill error as a skill failure (registry 500)", async () => {
    const outcomes: StubCall[] = [];
    const client = {
      fetchQueue: async () => [makeQueueItem("01ERR000000000000000000001")],
      fetchSkill: async () => {
        throw new Error("HTTP 500 internal");
      },
      postOutcome: async (input: StubCall) => {
        outcomes.push(input);
        return {
          transition: "none" as const,
          status: "pending-review",
          verifier_succeeded: 0,
          verifier_failed: 0,
          consecutive_verifier_failures: 0,
          next_freshness_due_at: null,
        };
      },
    };
    const summary = await runOneBatch({
      client: client as never,
      replay: okReplay(),
      log: () => undefined,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.reason).toMatch(/fetch_error/);
    expect(summary.failed).toBe(1);
  });
});

describe("runOneBatch — dry mode", () => {
  it("treats dry_pass as success", async () => {
    const { client, outcomes } = makeStubClient({
      queue: [makeQueueItem("01TEST00000000000000000008")],
    });
    const replay: ReplayRunner = async ({ mode }) => {
      expect(mode).toBe("dry");
      return { kind: "dry_pass", stepsWalked: 3 };
    };
    const summary = await runOneBatch({
      client: client as never,
      replay,
      mode: "dry",
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("success");
    expect(outcomes[0]!.reason).toMatch(/dry_pass walked=3/);
    expect(summary.succeeded).toBe(1);
  });
});
