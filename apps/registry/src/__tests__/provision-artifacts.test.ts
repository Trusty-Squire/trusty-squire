// T45 — provision-attempt artifact linking tests.
// Covers: provision_id round-trips through ProvisionAttempt AND
// ExtractFailureSnapshot, step_trail truncates at the byte cap,
// listRecentFailures + listByProvisionId return the expected shapes,
// and the admin dashboard renders a "Recent failures" section.

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import {
  InMemoryProvisionEventStore,
  STEP_TRAIL_MAX_BYTES,
} from "../provision-event-store.js";
import { InMemoryExtractFailureStore } from "../extract-failure-store.js";
import { ManifestSigner } from "../signer.js";

const ADMIN_BEARER = "t45-admin-bearer-9f8e7d6c";

function build() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const attemptStore = new InMemoryProvisionEventStore();
  const extractFailureStore = new InMemoryExtractFailureStore();
  return {
    skillStore,
    attemptStore,
    extractFailureStore,
    build: () =>
      buildServer({
        skillStore,
        signer,
        provisionEventStore: attemptStore,
        extractFailureStore,
        adminBearer: ADMIN_BEARER,
      }),
  };
}

// ──────────────────────────────────────────────────────────────
// ProvisionAttempt — provision_id + step_trail
// ──────────────────────────────────────────────────────────────

describe("ProvisionAttempt — T45 fields round-trip", () => {
  it("stores provision_id passed via POST /attempts", async () => {
    const { attemptStore, build: b } = build();
    const server = await b();
    await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: {
        status: "failed",
        failure_kind: "captcha_blocked",
        provision_id: "prov_abc123",
        mcp_version: "0.7.x",
      },
    });
    const rows = await attemptStore.listByService("vercel", 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provision_id).toBe("prov_abc123");
  });

  it("stores step_trail and exposes it on the record", async () => {
    const { attemptStore, build: b } = build();
    const server = await b();
    const trail = ["nav: /signup", "fill: email", "click: submit"].join("\n");
    await server.inject({
      method: "POST",
      url: "/v1/services/vercel/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: {
        status: "failed",
        step_trail: trail,
        mcp_version: "0.7.x",
      },
    });
    const rows = await attemptStore.listByService("vercel", 30 * 86_400_000);
    expect(rows[0]?.step_trail).toBe(trail);
  });

  it("truncates step_trail past 32KB", async () => {
    const { attemptStore } = build();
    const big = "x".repeat(STEP_TRAIL_MAX_BYTES + 1000);
    await attemptStore.record({
      service: "vercel",
      status: "failed",
      step_trail: big,
      account_id: "acct-a",
      mcp_version: "0.7.x",
    });
    const rows = await attemptStore.listByService("vercel", 30 * 86_400_000);
    expect(rows[0]?.step_trail?.length).toBeLessThanOrEqual(
      STEP_TRAIL_MAX_BYTES + 30,
    );
    expect(rows[0]?.step_trail).toContain("…truncated");
  });
});

// ──────────────────────────────────────────────────────────────
// ExtractFailureSnapshot — provision_id linking
// ──────────────────────────────────────────────────────────────

describe("ExtractFailureSnapshot — T45 provision_id field", () => {
  it("accepts provision_id on POST /v1/extract-failures and persists it", async () => {
    const { extractFailureStore, build: b } = build();
    const server = await b();
    await server.inject({
      method: "POST",
      url: "/v1/extract-failures",
      headers: { "x-account-id": "acct-a" },
      payload: {
        service: "vercel",
        mcp_version: "0.7.x",
        url: "https://vercel.com/signup",
        title: "Vercel Sign Up",
        step_label: "round-3-fill",
        extract_reason: "round_telemetry: filled email",
        candidates: [],
        html: "<html></html>",
        provision_id: "prov_run_1",
      },
    });
    const linked = await extractFailureStore.listByProvisionId("prov_run_1");
    expect(linked).toHaveLength(1);
    expect(linked[0]?.provision_id).toBe("prov_run_1");
  });

  it("returns nothing for an unmatched provision_id", async () => {
    const { extractFailureStore } = build();
    expect(await extractFailureStore.listByProvisionId("nope")).toEqual([]);
  });

  it("orders snapshots oldest-first within a single provision_id group", async () => {
    const { extractFailureStore } = build();
    // Upload in reverse-chronological order; the store should
    // re-sort.
    for (const label of ["round-3", "round-2", "round-1"]) {
      await extractFailureStore.upload("acct-a", {
        service: "vercel",
        mcp_version: "0.7.x",
        url: "https://vercel.com/signup",
        title: "Vercel",
        step_label: label,
        extract_reason: "x",
        candidates: [],
        html: "<x />",
        provision_id: "prov_run_2",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const ordered = await extractFailureStore.listByProvisionId("prov_run_2");
    expect(ordered.map((s) => s.step_label)).toEqual(["round-3", "round-2", "round-1"]);
  });
});

// ──────────────────────────────────────────────────────────────
// ProvisionAttempt — listRecentFailures
// ──────────────────────────────────────────────────────────────

describe("listRecentFailures", () => {
  it("returns only failed attempts, newest first", async () => {
    const { attemptStore } = build();
    for (const slug of ["a", "b", "c"]) {
      await attemptStore.record({
        service: slug,
        status: "failed",
        account_id: "x",
        mcp_version: "0.7.x",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    await attemptStore.record({
      service: "d",
      status: "success",
      account_id: "x",
      mcp_version: "0.7.x",
    });
    const recent = await attemptStore.listRecentFailures(10);
    expect(recent.map((r) => r.service)).toEqual(["c", "b", "a"]);
  });

  it("respects the limit", async () => {
    const { attemptStore } = build();
    for (let i = 0; i < 8; i++) {
      await attemptStore.record({
        service: `svc-${i}`,
        status: "failed",
        account_id: "x",
        mcp_version: "0.7.x",
      });
    }
    const recent = await attemptStore.listRecentFailures(3);
    expect(recent).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────
// Admin dashboard — "Recent failures" section
// ──────────────────────────────────────────────────────────────

describe("admin dashboard — Recent failures section", () => {
  it("renders the section header when there are no failures", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Recent failed attempts");
    expect(res.body).toContain("No failed attempts on record.");
  });

  it("renders a card per failed attempt", async () => {
    const { attemptStore, build: b } = build();
    await attemptStore.record({
      service: "vercel",
      status: "failed",
      failure_kind: "captcha_blocked",
      provision_id: "prov_x",
      step_trail: "tap: continue\nsubmit: form",
      account_id: "x",
      mcp_version: "0.7.x",
    });
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("vercel");
    expect(res.body).toContain("captcha_blocked");
    expect(res.body).toContain("prov_x");
    // Step trail is collapsed inside a <details> block, but the
    // trail content should still be in the response body.
    expect(res.body).toContain("tap: continue");
  });

  it("renders snapshot links when provision_id matches uploaded ExtractFailureSnapshot rows", async () => {
    const { attemptStore, extractFailureStore, build: b } = build();
    await attemptStore.record({
      service: "vercel",
      status: "failed",
      failure_kind: "anti_bot_blocked",
      provision_id: "prov_link",
      account_id: "x",
      mcp_version: "0.7.x",
    });
    await extractFailureStore.upload("x", {
      service: "vercel",
      mcp_version: "0.7.x",
      url: "https://vercel.com/signup",
      title: "Vercel",
      step_label: "round-5-click",
      extract_reason: "x",
      candidates: [],
      html: "<x />",
      provision_id: "prov_link",
    });
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("round-5-click");
    // Thumbnail link pattern includes the extract-failure id and jpeg endpoint.
    expect(res.body).toMatch(/\/v1\/extract-failures\/[^/]+\/jpeg/);
  });

  it("shows an empty-snapshots note when no rows are tagged with the attempt's provision_id", async () => {
    const { attemptStore, build: b } = build();
    await attemptStore.record({
      service: "vercel",
      status: "failed",
      failure_kind: "verification_not_sent",
      provision_id: "prov_lonely",
      account_id: "x",
      mcp_version: "0.7.x",
    });
    const server = await b();
    const res = await server.inject({
      method: "GET",
      url: `/admin?bearer=${ADMIN_BEARER}`,
    });
    expect(res.body).toContain("No screenshot snapshots tagged with this attempt");
  });
});

// ──────────────────────────────────────────────────────────────
// ProvisionEvent — idempotency (Decision 11): upsert on provision_id
// ──────────────────────────────────────────────────────────────

describe("ProvisionEvent — provision_id idempotency", () => {
  it("upserts on a repeated provision_id (same id, payload overwritten)", async () => {
    const { attemptStore } = build();
    const first = await attemptStore.record({
      service: "railway",
      status: "failed",
      failure_kind: "captcha_blocked",
      provision_id: "prov_dup_1",
      account_id: "x",
      mcp_version: "0.9.0",
    });
    const second = await attemptStore.record({
      service: "railway",
      status: "success", // a retry that resolved differently
      provision_id: "prov_dup_1",
      account_id: "x",
      mcp_version: "0.9.0",
    });
    // Same row id — no double count.
    expect(second.id).toBe(first.id);
    const rows = await attemptStore.listByService("railway", 60 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.failure_kind).toBeNull(); // overwritten by the retry
  });

  it("does NOT dedupe rows with no provision_id (null is distinct)", async () => {
    const { attemptStore } = build();
    await attemptStore.record({ service: "fly", status: "failed", account_id: "x", mcp_version: "0.9.0" });
    await attemptStore.record({ service: "fly", status: "failed", account_id: "x", mcp_version: "0.9.0" });
    const rows = await attemptStore.listByService("fly", 60 * 86_400_000);
    expect(rows).toHaveLength(2);
  });
});
