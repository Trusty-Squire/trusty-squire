// OpenIssue ledger + the SERVER-SIDE close-gate (memory-overhaul Phase 4).
// The close-gate is the integrity centerpiece: a ticket cannot reach
// `resolved` without a green-run pointer, nor `wall` without a falsification
// record. These tests pin that you CANNOT close a ticket without evidence —
// the mechanism that blocks "I gave up and called it a wall".

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../server.js";
import { InMemorySkillStore } from "../skill-store-memory.js";
import { InMemoryProvisionEventStore } from "../provision-event-store.js";
import { InMemoryServiceStateStore } from "../service-state-store.js";
import { InMemoryOpenIssueStore } from "../open-issue-store.js";
import { ManifestSigner } from "../signer.js";

const BEARER = "test-admin-bearer";

function build() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = ManifestSigner.fromKeyObject(privateKey, "test-signer");
  const skillStore = new InMemorySkillStore();
  const attemptStore = new InMemoryProvisionEventStore();
  const stateStore = new InMemoryServiceStateStore();
  const issueStore = new InMemoryOpenIssueStore();
  return {
    issueStore,
    build: () =>
      buildServer({
        skillStore,
        signer,
        provisionEventStore: attemptStore,
        serviceStateStore: stateStore,
        openIssueStore: issueStore,
        adminBearer: BEARER,
      }),
  };
}

const auth = { authorization: `Bearer ${BEARER}` };

// ---------- store-level close-gate (pure invariant) -------------------
describe("InMemoryOpenIssueStore — close-gate", () => {
  it("seeds an open ticket on a failure; a recurrence bumps attempts", async () => {
    const s = new InMemoryOpenIssueStore();
    const a = await s.seedFailure("groq", "captcha_blocked");
    expect(a.status).toBe("open");
    expect(a.attempts).toBe(1);
    const b = await s.seedFailure("groq", "captcha_blocked");
    expect(b.attempts).toBe(2);
    expect(b.id).toBe("groq:captcha_blocked");
  });

  it("REFUSES to resolve without a green-run pointer", async () => {
    const s = new InMemoryOpenIssueStore();
    const seeded = await s.seedFailure("groq", "captcha_blocked");
    const bad = await s.closeResolved(seeded.id, "", "loop-1", seeded.version);
    expect(bad.kind).toBe("missing_evidence");
    if (bad.kind === "missing_evidence") expect(bad.need).toBe("resolved_run");
  });

  it("REFUSES to wall without a falsification record", async () => {
    const s = new InMemoryOpenIssueStore();
    const seeded = await s.seedFailure("turso", "oauth_onboarding_failed");
    const bad = await s.closeWall(
      seeded.id,
      { experiment: "", result: "" },
      "loop-1",
      seeded.version,
    );
    expect(bad.kind).toBe("missing_evidence");
    if (bad.kind === "missing_evidence") expect(bad.need).toBe("falsified");
  });

  it("ALLOWS resolve with a green run + wall with a real falsification", async () => {
    const s = new InMemoryOpenIssueStore();
    const r = await s.seedFailure("groq", "captcha_blocked");
    const ok = await s.closeResolved(r.id, "prov_abc123", "loop-1", r.version);
    expect(ok.kind).toBe("ok");

    const w = await s.seedFailure("turso", "oauth_onboarding_failed");
    const okw = await s.closeWall(
      w.id,
      { experiment: "fresh-IP + real-GPU laptop", result: "still hard-blocks at OAuth callback" },
      "loop-1",
      w.version,
    );
    expect(okw.kind).toBe("ok");
    if (okw.kind === "ok") expect(okw.issue.status).toBe("wall");
  });

  it("optimistic concurrency: a stale version is rejected (parallel workers)", async () => {
    const s = new InMemoryOpenIssueStore();
    const r = await s.seedFailure("groq", "captcha_blocked");
    // worker A claims at v0 → bumps to v1
    const a = await s.claim(r.id, "worker-A", r.version);
    expect(a.kind).toBe("ok");
    // worker B tries to resolve at the STALE v0 → conflict
    const b = await s.closeResolved(r.id, "prov_x", "worker-B", r.version);
    expect(b.kind).toBe("version_conflict");
  });

  it("a green run drains the service's open tickets; a wall reopens on a later success", async () => {
    const s = new InMemoryOpenIssueStore();
    const w = await s.seedFailure("groq", "captcha_blocked");
    await s.closeWall(
      w.id,
      { experiment: "x", result: "y" },
      "loop-1",
      w.version,
    );
    // A later green run resolves even a wall — if it went green, it wasn't one.
    const n = await s.resolveServiceOnSuccess("groq", "prov_green");
    expect(n).toBe(1);
    const after = await s.get(w.id);
    expect(after?.status).toBe("resolved");
    expect(after?.resolved_run).toBe("prov_green");
  });
});

// ---------- HTTP surface: auth + the gate over the wire ---------------
describe("HTTP /admin/issues — auth + close-gate", () => {
  it("401s without the admin bearer", async () => {
    const { build: b } = build();
    const server = await b();
    const res = await server.inject({ method: "GET", url: "/admin/issues" });
    expect(res.statusCode).toBe(401);
  });

  it("a failed attempt seeds a ticket visible on the worklist", async () => {
    const { build: b } = build();
    const server = await b();
    await server.inject({
      method: "POST",
      url: "/v1/services/groq/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "failed", failure_kind: "captcha_blocked", mode: "discover", mcp_version: "0.9.17" },
    });
    const res = await server.inject({ method: "GET", url: "/admin/issues?status=open", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issues.length).toBe(1);
    expect(body.issues[0].id).toBe("groq:captcha_blocked");
  });

  it("POST /resolve over the wire 422s without resolved_run", async () => {
    const { issueStore, build: b } = build();
    const server = await b();
    const seeded = await issueStore.seedFailure("groq", "captcha_blocked");
    const res = await server.inject({
      method: "POST",
      url: `/admin/issues/${encodeURIComponent(seeded.id)}/resolve`,
      headers: auth,
      payload: { actor: "loop-1", version: seeded.version, resolved_run: "" },
    });
    // Empty resolved_run fails the zod min(1) → 400 (well-formed-but-invalid is
    // caught at the schema before the gate; the gate's 422 is for a SEMANTIC
    // miss the schema can't see — both block the close, which is the point).
    expect([400, 422]).toContain(res.statusCode);
  });

  it("POST /wall over the wire 422s without a falsification, succeeds with one", async () => {
    const { issueStore, build: b } = build();
    const server = await b();
    const seeded = await issueStore.seedFailure("turso", "oauth_onboarding_failed");
    // Missing falsified entirely → zod 400.
    const bad = await server.inject({
      method: "POST",
      url: `/admin/issues/${encodeURIComponent(seeded.id)}/wall`,
      headers: auth,
      payload: { actor: "loop-1", version: seeded.version },
    });
    expect(bad.statusCode).toBe(400);
    // With a real falsification → 200 wall.
    const ok = await server.inject({
      method: "POST",
      url: `/admin/issues/${encodeURIComponent(seeded.id)}/wall`,
      headers: auth,
      payload: {
        actor: "loop-1",
        version: seeded.version,
        falsified: { experiment: "fresh-IP laptop", result: "still blocks", evidence_ref: "prov_z" },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().issue.status).toBe("wall");
  });

  it("GET /admin/service-states lists materialized states (for STATE.md gen)", async () => {
    const { build: b } = build();
    const server = await b();
    await server.inject({
      method: "POST",
      url: "/v1/services/ipinfo/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", mcp_version: "0.9.17" },
    });
    const noauth = await server.inject({ method: "GET", url: "/admin/service-states" });
    expect(noauth.statusCode).toBe(401);
    const res = await server.inject({ method: "GET", url: "/admin/service-states", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.states.length).toBeGreaterThanOrEqual(1);
    expect(body.states.find((s: { service: string }) => s.service === "ipinfo")).toBeDefined();
  });

  it("a success drains the ticket (drain-on-green over the wire)", async () => {
    const { issueStore, build: b } = build();
    const server = await b();
    await issueStore.seedFailure("ipinfo", "verification_not_sent");
    await server.inject({
      method: "POST",
      url: "/v1/services/ipinfo/attempts",
      headers: { "x-account-id": "acct-a" },
      payload: { status: "success", provision_id: "prov_green", mode: "discover", mcp_version: "0.9.17" },
    });
    const after = await issueStore.get("ipinfo:verification_not_sent");
    expect(after?.status).toBe("resolved");
    expect(after?.resolved_run).toBe("prov_green");
  });
});
