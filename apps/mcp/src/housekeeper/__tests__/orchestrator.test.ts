// Housekeeper orchestrator tests — the unified loop that dispatches
// on task.kind to either the replay or discover path. Both paths are
// covered: success, failure, schema drift, blocked, notifier
// fan-out, and the cross-kind interleaving (a queue can in principle
// mix kinds even though current providers don't).

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runOneBatch, runHealPass } from "../orchestrator.js";
import type { QueueProvider, HousekeeperTask } from "../queues/index.js";
import type { Notifier, NotifierEvent } from "../notifier.js";

// Disable inter-run pacing here: no cooldown, no daily cap, and an isolated
// state file — these tests exercise dispatch/tally, not pacing (pacing.test.ts
// owns that), and must not depend on or touch the operator's real counter.
process.env.UNIVERSAL_BOT_RUN_COOLDOWN_SEC = "0";
process.env.UNIVERSAL_BOT_DAILY_SIGNUP_CAP = "0";
process.env.UNIVERSAL_BOT_PACE_STATE_FILE = join(tmpdir(), `pace-orch-test-${process.pid}.json`);
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
  // The active-skill count the registry "returns" from the heartbeat (OF#1).
  healSkillsActive?: number;
}) {
  const outcomes: Array<{
    skill_id: string;
    kind: string;
    reason: string;
    failure_kind?: string;
  }> = [];
  const heartbeats: Array<Record<string, number | string>> = [];
  const client = {
    fetchSkill: async (skill_id: string) => {
      if (opts.fetchThrows !== undefined) throw opts.fetchThrows;
      return opts.skill ?? makeSkill(skill_id, "svc-stub");
    },
    postOutcome: async (input: {
      skill_id: string;
      kind: string;
      reason: string;
      failure_kind?: string;
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
    postHealHeartbeat: async (input: Record<string, number | string>) => {
      heartbeats.push(input);
      return { skills_active: opts.healSkillsActive ?? 0 };
    },
  };
  return { client, outcomes, heartbeats };
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
    // A plain step_failed is genuine rot — must keep the rot kind so the
    // demote counter advances.
    expect(outcomes[0]!.failure_kind).toBe("step_failed");
  });

  it("downgrades a disabled returning-user-divergence step_failed to brittle re-synthesis", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000002R") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 5,
        reason:
          "target is disabled (aria-disabled=true) after 6s " +
          "[returning-user: onboarding fill was absent; credential step diverged from fresh-signup capture]",
        capturedStep: {
          kind: "click",
          text_match: "Create service token",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.failure_kind).toBe("brittle_replay_servable");
    expect(outcomes[0]!.reason).toMatch(/disabled target indicates missing replay precondition/);
  });

  it("downgrades a plain disabled-target step_failed to brittle re-synthesis", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000002D") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 2,
        reason:
          "target is disabled (HTML disabled or aria-disabled=true) after 6s — the click would no-op. A required precondition is unmet.",
        capturedStep: {
          kind: "click",
          text_match: "Create API key",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.failure_kind).toBe("brittle_replay_servable");
  });

  it("downgrades a rot step_failed to non-demoting when the probe shows the page is still servable", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000PRB1") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 1,
        reason: "Tokens matched 2 elements",
        capturedStep: {
          kind: "click",
          text_match: "Create token",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      // Probe says: the signup page still offers Google OAuth, no wall.
      probe: async () => ({
        providers: ["google"],
        has_email_signup: false,
        has_email_field: false,
        card_gate: false,
        interstitial: false,
        final_url: "https://fly.io/signup",
        inventory_size: 12,
      }),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    // Brittle, not rot — must not advance the demote counter, and is flagged
    // for re-synthesis via the reason marker.
    expect(outcomes[0]!.failure_kind).toBe("brittle_replay_servable");
    expect(outcomes[0]!.reason).toMatch(/\[brittle: probe shows servable\]/);
  });

  it("does NOT downgrade when the probe shows no entry affordances", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000PRB2") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 1,
        reason: "selector not found",
        capturedStep: {
          kind: "click",
          text_match: "Create token",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      // Probe shows an empty/walled page — no OAuth, no form, an interstitial.
      probe: async () => ({
        providers: [],
        has_email_signup: false,
        has_email_field: false,
        card_gate: false,
        interstitial: true,
        final_url: "https://svc.example/signup",
        inventory_size: 0,
      }),
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    // No clear affordances → leave the rot kind intact (still demotes).
    expect(outcomes[0]!.failure_kind).toBe("step_failed");
  });

  it("does NOT downgrade when the probe itself errors", async () => {
    const { client, outcomes } = recordingClient({});
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000PRB3") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 1,
        reason: "selector not found",
        capturedStep: {
          kind: "click",
          text_match: "Create token",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      probe: async () => {
        throw new Error("net::ERR_TIMED_OUT");
      },
      log: () => undefined,
    });
    expect(outcomes[0]!.kind).toBe("failure");
    expect(outcomes[0]!.failure_kind).toBe("step_failed");
  });

  it("does NOT probe a disabled-target brittle failure", async () => {
    const { client, outcomes } = recordingClient({});
    let probeCalls = 0;
    await runOneBatch({
      queue: provider([{ kind: "replay", queueItem: makeQueueItem("01R0000000000000000000PRB4") }]),
      client: client as never,
      replay: async () => ({
        kind: "step_failed",
        stepIndex: 5,
        reason:
          "target is disabled (aria-disabled=true) after 6s " +
          "[returning-user: onboarding fill was absent; credential step diverged from fresh-signup capture]",
        capturedStep: {
          kind: "click",
          text_match: "Create service token",
          provenance: { run_id: "r1", round_index: 1 },
        },
      }),
      probe: async () => {
        probeCalls += 1;
        return {
          providers: ["google"],
          has_email_signup: false,
          has_email_field: false,
          card_gate: false,
          interstitial: false,
          final_url: "https://svc.example/signup",
          inventory_size: 12,
        };
      },
      log: () => undefined,
    });
    // The disabled-target guard already downgraded it to a non-rot kind, so the
    // probe must not even run (it's gated on failureCountsTowardDemotion).
    expect(probeCalls).toBe(0);
    expect(outcomes[0]!.failure_kind).toBe("brittle_replay_servable");
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
      sleep: async () => undefined, // fast-forward the inter-run cooldown
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
      sleep: async () => undefined, // fast-forward the inter-run cooldown
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

    // verify: one replay that step_fails → demoted (mock client transition).
    // The registry reports 7 active skills back from the heartbeat (OF#1).
    const { client: verifyClient, heartbeats } = recordingClient({
      outcomeTransition: "demoted",
      healSkillsActive: 7,
    });
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

    // The two objective functions ride the digest: OF#1 (skills_active) from
    // the heartbeat, OF#2 (discover counts) from the discover pass.
    expect(digest).toMatchObject({
      objectives: { skills_active: 7, discover_attempted: 1, discover_succeeded: 1 },
    });
    // The heartbeat fired BEFORE the digest and forwarded OF#2's raw counts.
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ discover_attempted: 1, discover_succeeded: 1 });
  });
});

describe("runOneBatch — autonomous loop escalation (the single human surface)", () => {
  it("a wall NEVER escalates; an unknown state escalates exactly ONCE, at the 3rd attempt", async () => {
    // Isolate the persistent attempt store to a temp file for this test.
    process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE = join(
      tmpdir(),
      `unknown-orch-test-${process.pid}.json`,
    );
    const events: NotifierEvent[] = [];
    const notifier: Notifier = { name: "rec", notify: async (e) => void events.push(e) };
    const { client } = recordingClient({});

    const runOnce = (
      runner: (input: { service: string }) => Promise<{
        kind: "blocked" | "failed";
        reason: string;
        state?: string;
        signature?: string;
      }>,
      service: string,
    ): Promise<unknown> =>
      runOneBatch({
        queue: provider([{ kind: "discover", service }]),
        client: client as never,
        discover: runner as never,
        notifiers: [notifier],
        log: () => undefined,
        sleep: async () => undefined,
      });

    // A WALL: classified blocked, auto-skipped — must never produce an escalation.
    await runOnce(async () => ({ kind: "blocked", reason: "anti_bot_blocked", state: "wall" }), "wallsvc");

    // An UNKNOWN state, same (service, signature) three times.
    const unknownRunner = async () => ({
      kind: "failed" as const,
      reason: "weird_new_modal_appeared",
      state: "unknown",
      signature: "sig-zz",
    });
    await runOnce(unknownRunner, "novelsvc");
    await runOnce(unknownRunner, "novelsvc");
    let escalations = events.filter((e) => e.kind === "unknown_state");
    expect(escalations.length).toBe(0); // attempts 1 + 2: handled autonomously

    await runOnce(unknownRunner, "novelsvc"); // attempt 3 → the single ping
    escalations = events.filter((e) => e.kind === "unknown_state");
    expect(escalations.length).toBe(1);
    expect(escalations[0]).toMatchObject({
      kind: "unknown_state",
      service: "novelsvc",
      attempts: 3,
    });

    await runOnce(unknownRunner, "novelsvc"); // attempt 4 → suppressed, no second ping
    expect(events.filter((e) => e.kind === "unknown_state").length).toBe(1);

    delete process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE;
  });
});
