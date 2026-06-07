// Fix B (2026-06-06): promoting a skill to active must collapse EVERY other
// live row for the same service — prior active + lingering demoted + redundant
// pending-review — to `superseded`, not just the prior active. Leaving demoted
// and stale pending-review rows behind was the source of the registry clutter
// (baseten ×4 demoted, railway ×3, ipinfo ×3 pending, all beside a healthy
// active). `quarantined` is deliberately preserved (operator-owned).

import { describe, expect, it } from "vitest";
import { InMemorySkillStore } from "../skill-store-memory.js";
import type { Skill, SkillStatus } from "@trusty-squire/skill-schema";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/skill-schema";

function skill(skill_id: string, status: SkillStatus): Skill {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    service: "baseten",
    version: "v1",
    skill_id,
    signup_url: "https://baseten.co/signup",
    oauth_provider: "google",
    steps: [
      { kind: "navigate", url: "https://baseten.co/signup", provenance: { run_id: "r1", round_index: 0 } },
      { kind: "extract_via_copy_button", near_text_hint: "Copy", provenance: { run_id: "r1", round_index: 1 } },
    ],
    credentials: [
      {
        type: "api_key",
        shape_hint: "opaque",
        env_var_suggestion: "BASETEN_API_KEY",
        post_extract_validator: { min_length: 16, max_length: 256 },
      },
    ],
    source_run_ids: ["r1"],
    status,
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: "2026-05-21T04:00:00.000Z",
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  };
}

async function seed(store: InMemorySkillStore, id: string, status: SkillStatus) {
  await store.insert({
    skill: skill(id, status),
    signature: "x".repeat(64),
    signed_at: new Date(),
    signed_by: "test",
  });
}

async function statusOf(store: InMemorySkillStore, id: string): Promise<string | null> {
  return (await store.findById(id))?.status ?? null;
}

describe("activation collapses stale rows for the service", () => {
  it("approveReview supersedes prior active + demoted + redundant pending-review", async () => {
    const store = new InMemorySkillStore();
    await seed(store, "01ACTIVE0000000000000000AA", "active");
    await seed(store, "01DEMOTED000000000000000BB", "demoted");
    await seed(store, "01DEMOTED000000000000000CC", "demoted");
    await seed(store, "01PENDOLD000000000000000DD", "pending-review");
    await seed(store, "01QUARANT000000000000000EE", "quarantined");
    // The capture we're promoting.
    await seed(store, "01PROMOTE000000000000000FF", "pending-review");

    const approved = await store.approveReview("01PROMOTE000000000000000FF");
    expect(approved!.status).toBe("active");

    // Every other live row collapses to superseded …
    expect(await statusOf(store, "01ACTIVE0000000000000000AA")).toBe("superseded");
    expect(await statusOf(store, "01DEMOTED000000000000000BB")).toBe("superseded");
    expect(await statusOf(store, "01DEMOTED000000000000000CC")).toBe("superseded");
    expect(await statusOf(store, "01PENDOLD000000000000000DD")).toBe("superseded");
    // … except quarantined, which is an operator-owned route-to-human state.
    expect(await statusOf(store, "01QUARANT000000000000000EE")).toBe("quarantined");

    // And exactly one active remains.
    const all = await store.listSkills({ service: "baseten", limit: 50 });
    expect(all.filter((r) => r.status === "active").map((r) => r.skill_id)).toEqual([
      "01PROMOTE000000000000000FF",
    ]);
  });

  it("verifier promote (pending→active) also collapses demoted siblings", async () => {
    const store = new InMemorySkillStore();
    await seed(store, "01DEMOTED000000000000000GG", "demoted");
    await seed(store, "01PROMOTE000000000000000HH", "pending-review");
    // One success at the promotion threshold flips pending→active.
    const res = await store.recordVerifierOutcome({
      skill_id: "01PROMOTE000000000000000HH",
      kind: "success",
      reason: "replay ok",
    });
    expect(res.transition).toBe("promoted");
    expect(res.record.status).toBe("active");
    expect(await statusOf(store, "01DEMOTED000000000000000GG")).toBe("superseded");
  });

  it("reactivate collapses a redundant pending-review for the service", async () => {
    const store = new InMemorySkillStore();
    await seed(store, "01PENDLEFT00000000000000II", "pending-review");
    await seed(store, "01DEMOTED000000000000000JJ", "demoted");

    const reactivated = await store.reactivate("01DEMOTED000000000000000JJ");
    expect(reactivated!.record.status).toBe("active");
    expect(await statusOf(store, "01PENDLEFT00000000000000II")).toBe("superseded");
  });
});
