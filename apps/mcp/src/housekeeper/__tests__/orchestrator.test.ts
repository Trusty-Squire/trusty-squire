// Housekeeper orchestrator tests — the unified loop that dispatches
// on task.kind to either the replay or discover path. Both paths are
// covered: success, failure, schema drift, blocked, notifier
// fan-out, and the cross-kind interleaving (a queue can in principle
// mix kinds even though current providers don't).

import { describe, expect, it } from "vitest";
import { runOneBatch, runHealPass } from "../orchestrator.js";
import type { QueueProvider, HousekeeperTask } from "../queues/index.js";
import type { Notifier, NotifierEvent } from "../notifier.js";
import type { VerifierQueueItem } from "../registry-client.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

function makeQueueItem(skill_id: string): VerifierQueueItem {
  return {
    skill_id,
    service: `svc-${skill_id.slice(0, 4)}`,
    version: "v1",
    status: "pending-review",
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
        provenance: { run_id: "r1", round_index: 0 },
      },
      {
        kind: "extract_via_copy_button",
        near_text_hint: "Copy",
        provenance: { run_id: "r1", round_index: 1 },
      },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "K",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
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

function provider(tasks: HousekeeperTask[]): QueueProvider {
  return {
    name: "test",
    fetch: async () => tasks,
  };
}

function recordingClient(opts: {
  skill?: Skill;
  fetchThrows?: Error;
  outcomeTransition?: "promoted" | "retired" | "demoted" | "none";
}) {
  const outcomes: Array<{ skill_id: string; kind: string; reason: string }> = [];
  const client = {
    fetchSkill: async (skill_id: string) => {
      if (opts.fetchThrows !== undefined) throw opts.fetchThrows;
      return opts.skill ?? makeSkill(skill_id, "svc-stub");
    },
    postOutcome: async (input: {
      skill_id: string;
      kind: string;
      reason: string;
    }) => {
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
  };
  return { client, outcomes };
}

describe("runOneBatch — replay path", () => {
  it("calls replay + posts a success outcome on ok", async () => {
    const { client, outcomes } = recordingClient({ outcomeTransition: "promoted" });
    const summary = await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R00000000000000000000001") }]),
      client: client as never,
      replay: async () => ({
        kind: "ok",
        credential: "sk-test-discovery-key-abc123",
        via: "copy_button",
      }),
      log: () => undefined,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("success");
    expect(summary.succeeded).toBe(1);
    expect(summary.transitions.promoted).toBe(1);
  });

  it("posts kind=failure on step_failed", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R00000000000000000000002") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 1,
        reason: "selector not found",
        capturedStep: {
          kind: "extract_via_copy_button",
          near_text_hint: "Copy",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.reason).toMatch(/step_failed/);
  });

  it("skips schema-drift without posting an outcome", async () => {
    const { SkillSchemaDriftError } = await import("../registry-client.js");
    const { client, outcomes } = recordingClient({
      fetchThrows: new SkillSchemaDriftError("01R00000000000000000000003", "shape changed"),
    });
    const summary = await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R00000000000000000000003") }]),
      client: client as never,
      replay: async () => ({ kind: "dry_pass", stepsWalked: 0 }),
      log: () => undefined,
    });
    expect(outcomes).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("returns 'skipped' when no replay runner is wired", async () => {
    const { client, outcomes } = recordingClient({});
    const summary = await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R00000000000000000000004") }]),
      client: client as never,
      log: () => undefined,
      // No replay runner.
    });
    expect(outcomes).toHaveLength(0);
    expect(summary.skipped).toBe(1);
  });
});

describe("runOneBatch — discover path", () => {
  it("calls discover and tallies the outcome", async () => {
    const { client } = recordingClient({});
    const summary = await runOneBatch({
      queue: provider([{ kind: "discover", service: "perplexity" }]),
      client: client as never,
      discover: async () => ({ kind: "ok", reason: "signed up" }),
      log: () => undefined,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("classifies blocked separately from failed", async () => {
    const { client } = recordingClient({});
    const summary = await runOneBatch({
      queue: provider([
        { kind: "discover", service: "koyeb" },
        { kind: "discover", service: "perplexity" },
      ]),
      client: client as never,
      discover: async (input) => {
        if (input.service === "koyeb") return { kind: "blocked", reason: "billing" };
        return { kind: "ok", reason: "ok" };
      },
      log: () => undefined,
    });
    expect(summary.blocked).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("'skipped' (failed bucket) when no discover runner wired", async () => {
    const { client } = recordingClient({});
    const summary = await runOneBatch({
      queue: provider([{ kind: "discover", service: "x" }]),
      client: client as never,
      log: () => undefined,
    });
    expect(summary.failed).toBe(1);
  });
});

describe("runOneBatch — notifier fan-out", () => {
  it("delivers each outcome to every notifier", async () => {
    const events: NotifierEvent[] = [];
    const notifier: Notifier = {
      name: "test",
      notify: async (e) => {
        events.push(e);
      },
    };
    const { client } = recordingClient({});
    await runOneBatch({
      queue: provider([
        { kind: "discover", service: "a" },
        { kind: "discover", service: "b" },
      ]),
      client: client as never,
      discover: async () => ({ kind: "ok", reason: "ok" }),
      notifiers: [notifier],
      log: () => undefined,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "discover_outcome", service: "a", outcome: "ok" });
  });

  it("a failing notifier doesn't break the loop", async () => {
    const goodNotifier: Notifier = {
      name: "good",
      notify: async () => undefined,
    };
    const badNotifier: Notifier = {
      name: "bad",
      notify: async () => {
        throw new Error("notifier crash");
      },
    };
    const { client } = recordingClient({});
    const logs: string[] = [];
    const summary = await runOneBatch({
      queue: provider([{ kind: "discover", service: "x" }]),
      client: client as never,
      discover: async () => ({ kind: "ok", reason: "ok" }),
      notifiers: [badNotifier, goodNotifier],
      log: (l) => logs.push(l),
    });
    expect(summary.succeeded).toBe(1);
    expect(logs.some((l) => l.includes("notifier bad failed"))).toBe(true);
  });
});

describe("runOneBatch — mixed queue", () => {
  it("dispatches per-task on kind even when the queue mixes them", async () => {
    const { client, outcomes } = recordingClient({});
    let discoverCalls = 0;
    const summary = await runOneBatch({
      queue: provider([
        { kind: "replay", queueItem: makeQueueItem("01M00000000000000000000001") },
        { kind: "discover", service: "discoverable" },
      ]),
      client: client as never,
      replay: async () => ({
        kind: "ok",
        credential: "sk-mixed-test-credential-abcdef",
        via: "copy_button",
      }),
      discover: async () => {
        discoverCalls += 1;
        return { kind: "ok", reason: "ok" };
      },
      log: () => undefined,
    });
    expect(outcomes).toHaveLength(1); // replay posts; discover does not
    expect(discoverCalls).toBe(1);
    expect(summary.attempted).toBe(2);
    expect(summary.succeeded).toBe(2);
  });
});

describe("runHealPass — chained verify→discover + digest (T7)", () => {
  it("runs verify then discover and emits a heal_digest with counts", async () => {
    const events: NotifierEvent[] = [];
    const notifier: Notifier = { name: "cap", notify: async (e) => { events.push(e); } };

    // verify: one replay that step_fails → demoted (mock client transition)
    const { client: verifyClient } = recordingClient({ outcomeTransition: "demoted" });
    // discover: one re-skill that publishes a fresh skill → promoted
    const order: string[] = [];

    const result = await runHealPass({
      verify: {
        queue: provider([{ kind: "replay", queueItem: makeQueueItem("01HEAL0000000000000000001") }]),
        client: verifyClient as never,
        replay: async () => {
          order.push("verify");
          return {
            kind: "step_failed",
            stepIndex: 1,
            reason: "selector gone",
            capturedStep: { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
          };
        },
        log: () => undefined,
      },
      discover: {
        queue: provider([{ kind: "discover", service: "neon" }]),
        client: verifyClient as never,
        discover: async () => {
          order.push("discover");
          return { kind: "ok", reason: "re-skilled" };
        },
        log: () => undefined,
      },
      notifiers: [notifier],
      log: () => undefined,
    });

    // verify ran before discover (the chain), and the demote was counted
    expect(order).toEqual(["verify", "discover"]);
    expect(result.verify.transitions.demoted).toBe(1);
    expect(result.discover.succeeded).toBe(1);

    // one digest carrying the verify counts + a "needs human" tally
    const digest = events.find((e) => e.kind === "heal_digest");
    expect(digest).toBeDefined();
    expect(digest).toMatchObject({ demoted: 1, verified: 1, needs_human: 1 });
  });
});
