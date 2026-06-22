// D2.C — the registry trusts the fresh-verify producer's CONVERGED verdict
// (promote / reject / hold) instead of re-deriving from a single success count.
// A `promote` flips pending-review → active THROUGH the C11 phishing/abuse gate
// (which must stay in front); a `hold` is a no-op; a `reject` carrying an
// informative rot failure_kind retires/demotes immediately because the producer
// already spent the fresh-identity sample budget. The replay (non-fresh)
// 3-strike count path stays intact for skills that have no verdict.

import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skill-store-memory.js";
import type { Skill, SkillStatus } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

function skill(
  skill_id: string,
  status: SkillStatus,
  overrides: Partial<Pick<Skill, "service" | "signup_url" | "oauth_provider">> = {},
): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: overrides.service ?? "fresh-svc",
    version: "v1",
    skill_id,
    signup_url: overrides.signup_url ?? "https://fresh.example/signup",
    oauth_provider: overrides.oauth_provider ?? "google",
    steps: [
      { kind: "navigate", url: "https://fresh.example/signup", provenance: { run_id: "r1", round_index: 0 } },
      { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "FRESH_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status,
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-06-02T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

async function seed(
  store: InMemorySkillStore,
  id: string,
  status: SkillStatus,
  overrides: Partial<Pick<Skill, "service" | "signup_url" | "oauth_provider">> = {},
) {
  await store.insert({
    skill: skill(id, status, overrides),
    signature: "x".repeat(64),
    signed_at: new Date(),
    signed_by: "test",
  });
}

const PEND = "01VERDICTPEND0000000000001";
const ACTV = "01VERDICTACTV0000000000002";

describe("D2.C producer verdict semantics", () => {
  it('verdict:"promote" flips pending-review → active on a SINGLE outcome', async () => {
    const store = new InMemorySkillStore();
    await seed(store, PEND, "pending-review");
    const res = await store.recordVerifierOutcome({
      skill_id: PEND,
      kind: "success",
      reason: "fresh-verify promote (2✓/0✗, LCB 0.34)",
      verdict: "promote",
      samples: 2,
      successes: 2,
      failures: 0,
    });
    expect(res.transition).toBe("promoted");
    expect(res.record.status).toBe("active");
  });

  it('verdict:"hold" is a no-op — no status change, no counter bump', async () => {
    const store = new InMemorySkillStore();
    await seed(store, PEND, "pending-review");
    const res = await store.recordVerifierOutcome({
      skill_id: PEND,
      kind: "failure",
      reason: "fresh-verify hold (1✓/1✗)",
      verdict: "hold",
      samples: 2,
      successes: 1,
      failures: 1,
    });
    expect(res.transition).toBe("none");
    expect(res.record.status).toBe("pending-review");
    // A hold learned nothing — stat counters untouched.
    expect(res.record.verifier_succeeded).toBe(0);
    expect(res.record.verifier_failed).toBe(0);
    expect(res.record.consecutive_verifier_failures).toBe(0);
  });

  it('verdict:"reject" with rot failure_kind demotes an active skill immediately', async () => {
    const store = new InMemorySkillStore();
    await seed(store, ACTV, "active");
    const res = await store.recordVerifierOutcome({
      skill_id: ACTV,
      kind: "failure",
      reason: "fresh-verify reject",
      verdict: "reject",
      failure_kind: "extraction_failed",
    });
    expect(res.transition).toBe("demoted");
    expect(res.record.status).toBe("demoted");
    expect(res.record.consecutive_verifier_failures).toBe(1);
  });

  it('verdict:"reject" with rot failure_kind retires a pending-review skill immediately', async () => {
    const store = new InMemorySkillStore();
    await seed(store, PEND, "pending-review");
    const res = await store.recordVerifierOutcome({
      skill_id: PEND,
      kind: "failure",
      reason: "fresh-verify reject",
      verdict: "reject",
      failure_kind: "step_failed",
    });
    expect(res.transition).toBe("retired");
    expect(res.record.deleted_at).not.toBeNull();
  });

  it('verdict:"reject" carrying a WALL failure_kind quarantines on the first hit', async () => {
    const store = new InMemorySkillStore();
    await seed(store, ACTV, "active");
    const res = await store.recordVerifierOutcome({
      skill_id: ACTV,
      kind: "failure",
      reason: "fresh-verify reject (anti-bot)",
      verdict: "reject",
      failure_kind: "anti_bot_blocked",
    });
    expect(res.transition).toBe("quarantined");
    expect(res.record.status).toBe("quarantined");
  });

  it("THE C11 GATE STAYS IN FRONT of the verdict promote path", async () => {
    const store = new InMemorySkillStore();
    // An existing legit active skill for the service.
    await seed(store, ACTV, "active", {
      service: "phish-target",
      signup_url: "https://legit.example/signup",
    });
    // A pending-review submission for the SAME service pointing at a DIFFERENT
    // signup_url (the phishing vector). Even with a converged promote verdict,
    // the C11 gate must hold it in pending-review for operator review.
    await seed(store, PEND, "pending-review", {
      service: "phish-target",
      signup_url: "https://attacker.example/signup",
    });
    const res = await store.recordVerifierOutcome({
      skill_id: PEND,
      kind: "success",
      reason: "fresh-verify promote — but signup_url differs",
      verdict: "promote",
    });
    // C11 protects the existing active row. The verified duplicate is removed
    // from the verifier queue instead of staying pending-review forever.
    expect(res.transition).toBe("superseded");
    expect(res.record.status).toBe("superseded");
    expect((await store.findById(ACTV))?.status).toBe("active");
  });

  it("the replay (non-fresh, NO verdict) 3-strike count path still works", async () => {
    const store = new InMemorySkillStore();
    await seed(store, ACTV, "active");
    // No verdict → historic count-based demote path.
    await store.recordVerifierOutcome({ skill_id: ACTV, kind: "failure", reason: "r", failure_kind: "step_failed" });
    await store.recordVerifierOutcome({ skill_id: ACTV, kind: "failure", reason: "r", failure_kind: "step_failed" });
    const third = await store.recordVerifierOutcome({
      skill_id: ACTV,
      kind: "failure",
      reason: "r",
      failure_kind: "step_failed",
    });
    expect(third.transition).toBe("demoted");
    expect(third.record.consecutive_verifier_failures).toBe(3);
  });

  it("the replay (non-fresh, NO verdict) single-success count promote still works", async () => {
    const store = new InMemorySkillStore();
    await seed(store, PEND, "pending-review");
    // VERIFIER_PROMOTION_THRESHOLD = 1 → one count success promotes, no verdict.
    const res = await store.recordVerifierOutcome({ skill_id: PEND, kind: "success", reason: "replay ok" });
    expect(res.transition).toBe("promoted");
    expect(res.record.status).toBe("active");
  });
});
