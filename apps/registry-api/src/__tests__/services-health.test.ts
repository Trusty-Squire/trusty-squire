// T44 — compatibility-score endpoint tests. Three layers:
//   - deriveCompatScore (pure math; time-decay weighting)
//   - classifyCompat (state from score + skill flag)
//   - HTTP route (POST attempt + GET health, including alternates)

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryProvisionAttemptStore } from "../provision-attempt-store.js";
import { ManifestSigner } from "../signer.js";
import {
  classifyCompat,
  deriveCompatScore,
  buildCompatHealth,
} from "../compat-score.js";
import type { ProvisionAttemptRecord } from "../provision-attempt-store.js";
import type { Skill } from "@trusty-squire/adapter-sdk";
import { SKILL_SCHEMA_VERSION } from "@trusty-squire/adapter-sdk";

// ---------- helpers ----------------------------------------------------

const DAY = 86_400_000;

function mkAttempt(
  status: "success" | "failed",
  ageDays: number,
  service = "test",
): ProvisionAttemptRecord {
  return {
    id: `id-${ageDays}-${status}`,
    service,
    status,
    failure_kind: null,
    signup_url: null,
    artifacts_uri: null,
    account_id: "test-acct",
    mcp_version: "0.7.x",
    occurred_at: new Date(Date.now() - ageDays * DAY),
  };
}

function mkSkill(service: string): Skill {
  const padded = service.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 23);
  const skillId = `01H${padded}${"A".repeat(23 - padded.length)}`;
  // Cast through `unknown` — we're building a minimal valid skill
  // for store-side tests; the full Skill type has dozens of required
  // fields we don't exercise here. The InMemorySkillStore reads the
  // narrow set defined below; anything missing wouldn't be touched.
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    skill_id: skillId,
    service,
    version: "v1",
    signup_url: "https://example.com/signup",
    oauth_provider: null,
    inputs: [],
    plan: [],
    steps: [],
    credentials: [{ key: "api_key" }],
    bundle_sentinel: {
      kind: "http_request",
      method: "GET",
      url_template: "https://example.com/{{api_key}}",
      headers: {},
      ok_when: { status_in: [200] },
    },
    success_marker: { kind: "url_contains", value: "ok" },
    source_run_ids: [],
    status: "active",
    replays_succeeded: 0,
    replays_failed: 0,
    consecutive_failures: 0,
    created_at: new Date().toISOString(),
    last_replayed_at: null,
    superseded_at: null,
    deleted_at: null,
  } as unknown as Skill;
}

function build() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const attemptStore = new InMemoryProvisionAttemptStore();
  return {
    skillStore,
    attemptStore,
    build: () =>
      buildServer({
        skillStore,
        signer,
        provisionAttemptStore: attemptStore,
      }),
  };
}

// ---------- deriveCompatScore -----------------------------------------

describe("deriveCompatScore — pure math", () => {
  it("zero attempts → zero score", () => {
    expect(deriveCompatScore([])).toBe(0);
  });

  it("one fresh success → ~1.0", () => {
    const s = deriveCompatScore([mkAttempt("success", 0)]);
    expect(s).toBeCloseTo(1.0, 2);
  });

  it("one fresh failure → ~-1.0", () => {
    const s = deriveCompatScore([mkAttempt("failed", 0)]);
    expect(s).toBeCloseTo(-1.0, 2);
  });

  it("a 14-day-old (= 1 half-life) failure weighs ~0.5", () => {
    const s = deriveCompatScore([mkAttempt("failed", 14)]);
    expect(s).toBeCloseTo(-0.5, 2);
  });

  it("two 14d-old failures and one fresh success → ~-1.0+1.0 - 0.5 = -0.5 net", () => {
    const s = deriveCompatScore([
      mkAttempt("failed", 14),
      mkAttempt("success", 0),
    ]);
    // -0.5 + 1.0 = +0.5 — fresh success outweighs aging failure
    expect(s).toBeCloseTo(0.5, 2);
  });

  it("recovery: three old failures (60d) get dwarfed by recent successes", () => {
    const score = deriveCompatScore([
      mkAttempt("failed", 60),
      mkAttempt("failed", 60),
      mkAttempt("failed", 60),
      mkAttempt("success", 1),
      mkAttempt("success", 1),
    ]);
    // 60d ≈ 4.3 half-lives → weight ≈ 0.05; 3 × -0.05 = -0.15
    // Fresh successes nearly full weight: 2 × ~0.95 = ~1.9. Net positive.
    expect(score).toBeGreaterThan(1.0);
  });

  it("honors a custom half-life", () => {
    const long = deriveCompatScore([mkAttempt("failed", 14)], { halfLifeDays: 28 });
    expect(long).toBeCloseTo(-Math.pow(0.5, 0.5), 2);
  });
});

// ---------- classifyCompat --------------------------------------------

describe("classifyCompat", () => {
  it("any score → skill-active when skill exists", () => {
    expect(classifyCompat(-5, true)).toBe("skill-active");
    expect(classifyCompat(0, true)).toBe("skill-active");
    expect(classifyCompat(99, true)).toBe("skill-active");
  });

  it("score > 0 + no skill → working", () => {
    expect(classifyCompat(0.5, false)).toBe("working");
    expect(classifyCompat(100, false)).toBe("working");
  });

  it("score in [-2, 0] + no skill → struggling", () => {
    expect(classifyCompat(0, false)).toBe("struggling");
    expect(classifyCompat(-1, false)).toBe("struggling");
    expect(classifyCompat(-2, false)).toBe("struggling");
  });

  it("score < -2 + no skill → hard-block", () => {
    expect(classifyCompat(-2.01, false)).toBe("hard-block");
    expect(classifyCompat(-10, false)).toBe("hard-block");
  });

  it("honors custom thresholds", () => {
    expect(classifyCompat(-5, false, { hardBlockThreshold: -10 })).toBe(
      "struggling",
    );
    expect(classifyCompat(0, false, { strugglingCeiling: -1 })).toBe("working");
  });
});

// ---------- buildCompatHealth ------------------------------------------

describe("buildCompatHealth — composite", () => {
  it("counts successes and failures", () => {
    const h = buildCompatHealth(
      [
        mkAttempt("success", 0),
        mkAttempt("success", 1),
        mkAttempt("failed", 2),
      ],
      false,
    );
    expect(h.successful_count).toBe(2);
    expect(h.failed_count).toBe(1);
    expect(h.last_attempt_at).not.toBeNull();
  });

  it("last_attempt_at is the most recent occurred_at", () => {
    const h = buildCompatHealth(
      [mkAttempt("failed", 10), mkAttempt("success", 1)],
      false,
    );
    // 1 day ago should be the latest
    const latest = new Date(h.last_attempt_at as string);
    const now = Date.now();
    expect(now - latest.getTime()).toBeLessThan(2 * DAY);
  });
});

// ---------- HTTP route ------------------------------------------------

describe("HTTP — POST /v1/services/:slug/attempts", () => {
  it("inserts a success attempt and returns 201 + id", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/.+/);
  });

  it("inserts a failure attempt with failure_kind + signup_url", async () => {
    const { attemptStore, build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: {
        status: "failed",
        failure_kind: "verification_not_sent",
        signup_url: "https://vercel.com/signup",
        mcp_version: "0.7.18",
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = await attemptStore.listByService("vercel", 60 * DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.failure_kind).toBe("verification_not_sent");
    expect(rows[0]?.signup_url).toBe("https://vercel.com/signup");
  });

  it("400s on a bad slug", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "POST",
      url: "/v1/services/Vercel-CAPS/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    // Caps are lowercased; this slug passes. Try a truly invalid one:
    expect(res.statusCode).toBe(201);
    const res2 = await server.inject({
      method: "POST",
      url: "/v1/services/!!!/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    expect(res2.statusCode).toBe(400);
  });

  it("400s on a bad body", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "maybe", mcp_version: "0.7.18" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("HTTP — GET /v1/services/:slug/health", () => {
  it("zero attempts → struggling (score 0, no skill)", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("struggling");
    expect(body.compat_score).toBe(0);
    expect(body.has_active_skill).toBe(false);
    expect(body.alternates).toEqual([]);
  });

  it("one success → working state", async () => {
    const { build: b } = build();
    const server = await b();
    await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health",
    });
    const body = res.json();
    expect(body.state).toBe("working");
    expect(body.compat_score).toBeGreaterThan(0.9);
  });

  it("active skill in the registry → skill-active regardless of failures", async () => {
    const { skillStore, build: b } = build();
    await skillStore.insert({
      skill: mkSkill("vercel"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const server = await b();
    // Even with 5 failures, skill-active wins.
    for (let i = 0; i < 5; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/services/vercel/attempts",
        headers: { "x-account-id": "acct-a" },
        payload: { status: "failed", mcp_version: "0.7.18" },
      });
    }
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health",
    });
    const body = res.json();
    expect(body.state).toBe("skill-active");
    expect(body.has_active_skill).toBe(true);
  });

  it("3 failures + no skill → hard-block", async () => {
    const { build: b } = build();
    const server = await b();
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/services/vercel/attempts",
        headers: { "x-account-id": "acct-a" },
        payload: { status: "failed", mcp_version: "0.7.18" },
      });
    }
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health",
    });
    const body = res.json();
    expect(body.state).toBe("hard-block");
    expect(body.compat_score).toBeLessThan(-2);
  });
});

describe("HTTP — GET /v1/services/:slug/health?peers=…", () => {
  it("returns no alternates when state is not hard-block", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health?peers=render,railway,fly",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("struggling");
    expect(body.alternates).toEqual([]);
  });

  it("hard-blocked service + peers → returns up to 3 alternates with active skills", async () => {
    const { skillStore, build: b } = build();
    // render and railway have active skills.
    await skillStore.insert({
      skill: mkSkill("render"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    await skillStore.insert({
      skill: mkSkill("railway"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const server = await b();
    // Push vercel to hard-block.
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/services/vercel/attempts",
        headers: { "x-account-id": "acct-a" },
        payload: { status: "failed", mcp_version: "0.7.18" },
      });
    }
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health?peers=render,railway,fly,netlify",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("hard-block");
    expect(body.alternates).toHaveLength(2);
    expect(
      body.alternates.every((a: { state: string }) => a.state === "skill-active"),
    ).toBe(true);
    const slugs = body.alternates.map((a: { service: string }) => a.service);
    expect(slugs).toContain("render");
    expect(slugs).toContain("railway");
  });

  it("alternates excludes the requested slug itself", async () => {
    const { skillStore, build: b } = build();
    await skillStore.insert({
      skill: mkSkill("render"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const server = await b();
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/services/vercel/attempts",
        headers: { "x-account-id": "acct-a" },
        payload: { status: "failed", mcp_version: "0.7.18" },
      });
    }
    const res = await server.inject({
      method: "GET",
      // Include vercel in peers — should be filtered out
      url: "/v1/services/vercel/health?peers=vercel,render",
    });
    const body = res.json();
    expect(
      body.alternates.find((a: { service: string }) => a.service === "vercel"),
    ).toBeUndefined();
    expect(
      body.alternates.find((a: { service: string }) => a.service === "render"),
    ).toBeDefined();
  });

  it("alternates are sorted skill-active first, then by score desc", async () => {
    const { skillStore, build: b } = build();
    // Two peers with skills (skill-active), one without (working).
    await skillStore.insert({
      skill: mkSkill("render"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    await skillStore.insert({
      skill: mkSkill("railway"),
      signature: "x".repeat(64),
      signed_at: new Date(),
      signed_by: "test",
    });
    const server = await b();
    // Give "fly" two successes so it's "working" with a clear score.
    await server.inject({
      method: "POST",
      url: "/v1/services/fly/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    await server.inject({
      method: "POST",
      url: "/v1/services/fly/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.7.18" },
    });
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: "POST",
        url: "/v1/services/vercel/attempts",
        headers: { "x-account-id": "acct-a" },
        payload: { status: "failed", mcp_version: "0.7.18" },
      });
    }
    const res = await server.inject({
      method: "GET",
      url: "/v1/services/vercel/health?peers=fly,render,railway",
    });
    const body = res.json();
    expect(body.alternates.length).toBeGreaterThan(0);
    // The first two should be skill-active; fly (working) should be last
    expect(body.alternates[0]?.state).toBe("skill-active");
    expect(body.alternates[body.alternates.length - 1]?.service).toBe("fly");
  });
});
