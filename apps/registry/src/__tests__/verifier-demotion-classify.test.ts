// T4 — the demote counter must anchor on FIXABLE ROT only. A wall
// (captcha/anti-bot), infra (inbox/delivery), or transient (oauth /
// session / timeout) verifier failure records the stat but must NOT
// advance the 3-strike demote, or a working skill thrashes toward
// demotion on a blip. Walls quarantine on the first hit. demotion_reason
// is persisted so the needs-human worklist can show WHY.

import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skill-store-memory.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

function activeSkill(skill_id: string): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: `svc-${skill_id.slice(-4)}`,
    version: "v1",
    skill_id,
    signup_url: "https://example.com/signup",
    oauth_provider: "google",
    steps: [
      { kind: "navigate", url: "https://example.com/signup", provenance: { run_id: "r1", round_index: 0 } },
      { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "EXAMPLE_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-06-02T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

async function insertActive(store: InMemorySkillStore, id: string): Promise<void> {
  await store.insert({
    skill: activeSkill(id),
    signature: "x".repeat(64),
    signed_at: new Date(),
    signed_by: "test",
  });
}

async function fail(store: InMemorySkillStore, id: string, failure_kind: string) {
  return store.recordVerifierOutcome({ skill_id: id, kind: "failure", failure_kind, reason: failure_kind });
}

const ID = (n: number) => `01CLASSIFY00000000000000${String(n).padStart(2, "0")}`;

describe("verifier demotion classifier (T4)", () => {
  it("rot ×3 DOWNGRADES active → pending-review (still served as a hint), resets counter", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(1));
    await fail(store, ID(1), "step_failed");
    await fail(store, ID(1), "validator_failed");
    const third = await fail(store, ID(1), "extraction_failed");
    // Guidance paradigm (reconcile edge 2): rot no longer demotes → router-skip;
    // it downgrades to pending-review (still served, re-proven).
    expect(third.transition).toBe("downgraded");
    expect(third.record.status).toBe("pending-review");
    expect(third.record.consecutive_verifier_failures).toBe(0); // reset for a fresh verify window
    expect(third.record.demotion_reason).toBe("rot:extraction_failed");
    expect(third.record.next_freshness_due_at).toBeNull();
  });

  it("a single WALL quarantines immediately (no 3-strike), counter stays 0", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(2));
    const r = await fail(store, ID(2), "captcha_blocked");
    expect(r.transition).toBe("quarantined");
    expect(r.record.status).toBe("quarantined");
    expect(r.record.demotion_reason).toBe("wall:captcha_blocked");
    expect(r.record.consecutive_verifier_failures).toBe(0); // wall never counts
    expect(r.record.next_freshness_due_at).toBeNull(); // stop re-verifying
  });

  it("transient failures NEVER demote, even ×5 (counter stays 0, skill active)", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(3));
    let last;
    for (let i = 0; i < 5; i++) last = await fail(store, ID(3), "needs_login");
    expect(last!.transition).toBe("none");
    expect(last!.record.status).toBe("active");
    expect(last!.record.consecutive_verifier_failures).toBe(0);
    expect(last!.record.verifier_failed).toBe(5); // stat still tracked
  });

  it("infra (verification_not_sent) failures never demote", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(4));
    for (let i = 0; i < 3; i++) await fail(store, ID(4), "verification_not_sent");
    const got = await store.findById(ID(4));
    expect(got?.status).toBe("active");
    expect(got?.consecutive_verifier_failures).toBe(0);
  });

  it("a kindless failure defaults to transient — does NOT demote (anti-thrash)", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(5));
    for (let i = 0; i < 3; i++) {
      await store.recordVerifierOutcome({ skill_id: ID(5), kind: "failure", reason: "no kind" });
    }
    const got = await store.findById(ID(5));
    expect(got?.status).toBe("active");
    expect(got?.consecutive_verifier_failures).toBe(0);
  });

  it("a transient failure interleaved with rot does NOT reset the rot counter", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(6));
    await fail(store, ID(6), "step_failed"); // cvf 1
    await fail(store, ID(6), "needs_login"); // transient — no count, no reset
    await fail(store, ID(6), "step_failed"); // cvf 2
    const demote = await fail(store, ID(6), "validator_failed"); // cvf 3 → downgrade
    // The transition firing proves cvf reached 3 (transient didn't reset it);
    // the counter then resets to 0 for the fresh pending-review verify window.
    expect(demote.transition).toBe("downgraded");
    expect(demote.record.consecutive_verifier_failures).toBe(0);
  });

  it("a verifier SUCCESS resets the rot counter", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(7));
    await fail(store, ID(7), "step_failed");
    await fail(store, ID(7), "step_failed");
    await store.recordVerifierOutcome({ skill_id: ID(7), kind: "success", reason: "ok" });
    const after = await store.findById(ID(7));
    expect(after?.consecutive_verifier_failures).toBe(0);
  });

  it("manuallyDemote persists the operator reason", async () => {
    const store = new InMemorySkillStore();
    await insertActive(store, ID(8));
    const r = await store.manuallyDemote(ID(8), "signup form changed, needs re-capture");
    expect(r?.status).toBe("demoted");
    expect(r?.demotion_reason).toBe("manual:signup form changed, needs re-capture");
  });
});
