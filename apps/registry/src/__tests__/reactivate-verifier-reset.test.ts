// P1 follow-up: reactivate() must reset verifier-flow state so a
// previously-demoted skill can re-enter the freshness sweep without
// being immediately re-demoted by its stale consecutive_verifier_failures.

import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skill-store-memory.js";
import type { Skill } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

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
    // Drive the rot counter up (2 rot failures, still active), then MANUALLY
    // demote. The verifier now DOWNGRADES rot to pending-review and resets the
    // counter (reconcile edge 2), so the "demoted with a stale nonzero counter"
    // state that reactivate() must clean up comes from the operator/CLI demote
    // path, which leaves consecutive_verifier_failures intact.
    await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      failure_kind: "step_failed",
      reason: "f1",
    });
    await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      failure_kind: "step_failed",
      reason: "f2",
    });
    const demoted = await store.manuallyDemote(
      "01REACT00000000000000000XX",
      "needs re-capture",
    );
    expect(demoted).not.toBeNull();
    expect(demoted!.status).toBe("demoted");
    expect(demoted!.consecutive_verifier_failures).toBe(2); // stale counter reactivate must reset

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
    // 2 rot failures (cvf=2, still active), then manual demote (leaves cvf
    // intact) — the verifier itself now downgrades+resets rather than demotes.
    for (let i = 0; i < 2; i++) {
      await store.recordVerifierOutcome({
        skill_id: "01REACT00000000000000000XX",
        kind: "failure",
        failure_kind: "step_failed",
        reason: `f${i + 1}`,
      });
    }
    await store.manuallyDemote("01REACT00000000000000000XX", "needs re-capture");
    await store.reactivate("01REACT00000000000000000XX");
    const oneFailure = await store.recordVerifierOutcome({
      skill_id: "01REACT00000000000000000XX",
      kind: "failure",
      failure_kind: "step_failed",
      reason: "first failure after reactivate",
    });
    // Without the fix: cvf=4 → already past threshold from the prior
    // demote → instant re-demote. With the fix: cvf=1, transition='none'.
    expect(oneFailure.transition).toBe("none");
    expect(oneFailure.record.status).toBe("active");
    expect(oneFailure.record.consecutive_verifier_failures).toBe(1);
  });
});
