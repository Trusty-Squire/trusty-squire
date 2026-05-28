// P1 follow-up: reactivate() must reset verifier-flow state so a
// previously-demoted skill can re-enter the freshness sweep without
// being immediately re-demoted by its stale consecutive_verifier_failures.

import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skill-store-memory.js";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/adapter-sdk";

function activeSkill(): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: "openrouter",
    version: "v1",
    skill_id: "01REACT00000000000000000XX",
    signup_url: "https://openrouter.ai/signup",
    oauth_provider: "google",
    steps: [
      {
        kind: "navigate",
        url: "https://openrouter.ai/signup",
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
        env_var_suggestion: "OPENROUTER_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

describe("reactivate() resets verifier flow state", () => {
  it("clears consecutive_verifier_failures + reschedules freshness sweep", async () => {
    const store = new InMemorySkillStore();
    await store.insert({
      skill: activeSkill(),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    // Demote the skill via three consecutive verifier failures.
    // recordVerifierOutcome's demote branch (active + 3 cvf) sets:
    //   - status='demoted'
    //   - next_freshness_due_at=null
    // and leaves consecutive_verifier_failures=3.
    // We need the skill to first be in 'active' with verifier_succeeded
    // already high enough that the consecutive failures push to demoted
    // — the test fixture starts pending-review-less because we inserted
    // status='active' directly. But the in-memory store's insert path
    // sets verifier_succeeded=0, so the failures-branch only demotes
    // when status==='active'. Two failures with status=active is enough
    // to reach cvf=3 and demote. Let's drive that.
    await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      reason: "f1",
    });
    await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      reason: "f2",
    });
    const demoteResult = await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      reason: "f3 — demotes",
    });
    expect(demoteResult.transition).toBe("demoted");
    expect(demoteResult.record.status).toBe("demoted");
    expect(demoteResult.record.consecutive_verifier_failures).toBe(3);
    expect(demoteResult.record.next_freshness_due_at).toBeNull();

    // Reactivate — and verify the verifier state is clean.
    const reactivated = await store.reactivate("01REACT00000000000000000XX");
    expect(reactivated).not.toBeNull();
    expect(reactivated!.record.status).toBe("active");
    // The bug we're guarding against: stale cvf=3 would re-demote
    // the skill on its next failure.
    expect(reactivated!.record.consecutive_verifier_failures).toBe(0);
    // The other bug: next_freshness_due_at=null would mean the
    // verifier never picks up the reactivated skill.
    expect(reactivated!.record.next_freshness_due_at).not.toBeNull();
  });

  it("a reactivated skill survives one verifier failure (cvf back to 1, not 4)", async () => {
    const store = new InMemorySkillStore();
    await store.insert({
      skill: activeSkill(),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    for (let i = 0; i < 3; i++) {
      await store.recordVerifierOutcome({
        skill_id: "01REACT00000000000000000XX",
        kind: "failure",
        reason: `f${i + 1}`,
      });
    }
    await store.reactivate("01REACT00000000000000000XX");
    const oneFailure = await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      reason: "first failure after reactivate",
    });
    // Without the fix: cvf=4 → already past threshold from the prior
    // demote → instant re-demote. With the fix: cvf=1, transition='none'.
    expect(oneFailure.transition).toBe("none");
    expect(oneFailure.record.status).toBe("active");
    expect(oneFailure.record.consecutive_verifier_failures).toBe(1);
  });
});
