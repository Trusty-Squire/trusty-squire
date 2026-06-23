// Memory-overhaul Phase 4 — the operator ledger CLI's pure renderer + the
// registry client's gate-result mapping (the close-gate verdicts the loop
// acts on). The client is exercised with a fake fetch so no network is needed.

import { describe, it, expect } from "vitest";
import { renderStateDoc } from "../modes/ledger-cli.js";
import {
  VerifierRegistryClient,
  type ServiceStateRow,
} from "../registry-client.js";

describe("renderStateDoc — STATE.md projection", () => {
  const states: ServiceStateRow[] = [
    {
      service: "groq",
      status: "working",
      confidence: 1.0,
      successful_count: 2,
      failed_count: 1,
      last_green_at: "2026-06-17T21:00:00Z",
      last_failure_kind: "captcha_blocked",
      current_diagnosis: "in-modal Turnstile gates the create button",
      wall_classification: null,
    },
    {
      service: "turso",
      status: "hard-block",
      confidence: -3.0,
      successful_count: 0,
      failed_count: 4,
      last_green_at: null,
      last_failure_kind: "oauth_onboarding_failed",
      current_diagnosis: null,
      wall_classification: "wall",
    },
  ];

  it("groups worst-first and carries the diagnosis overlay", () => {
    const md = renderStateDoc(states);
    // wall group (turso) appears before working (groq) — worst-first.
    expect(md.indexOf("## wall")).toBeLessThan(md.indexOf("## working"));
    expect(md).toContain("**turso**");
    expect(md).toContain("in-modal Turnstile gates the create button");
    expect(md).toContain("last_failure=oauth_onboarding_failed");
  });

  it("handles an empty registry", () => {
    expect(renderStateDoc([])).toContain("0 service(s)");
  });
});

// A fake fetch that returns a canned Response for assertions.
function fakeFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("VerifierRegistryClient — ledger mutations map gate verdicts", () => {
  const mk = (f: typeof globalThis.fetch) =>
    new VerifierRegistryClient({
      baseUrl: "https://registry.test",
      adminBearer: "t",
      fetchFn: f,
    });

  it("maps a 422 to missing_evidence (the close-gate refusal)", async () => {
    const c = mk(fakeFetch(422, { ok: false, error: "missing_evidence", need: "falsified" }));
    const r = await c.wallIssue("groq:captcha_blocked", "loop-1", 0, {
      experiment: "x",
      result: "y",
    });
    expect(r.kind).toBe("missing_evidence");
    if (r.kind === "missing_evidence") expect(r.need).toBe("falsified");
  });

  it("maps a 409 to version_conflict (parallel-worker stomp)", async () => {
    const c = mk(fakeFetch(409, { ok: false, error: "version_conflict", current: 3 }));
    const r = await c.resolveIssue("groq:captcha_blocked", "loop-1", 0, "prov_x");
    expect(r.kind).toBe("version_conflict");
    if (r.kind === "version_conflict") expect(r.current).toBe(3);
  });

  it("maps a 200 to ok with the updated issue", async () => {
    const issue = {
      id: "groq:captcha_blocked",
      service: "groq",
      failure_kind: "captcha_blocked",
      status: "resolved",
      attempts: 1,
      resolved_run: "prov_green",
      falsified: null,
      actor: "loop-1",
      version: 1,
      updated_at: "2026-06-17T21:00:00Z",
    };
    const c = mk(fakeFetch(200, { ok: true, issue }));
    const r = await c.resolveIssue("groq:captcha_blocked", "loop-1", 0, "prov_green");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.issue.status).toBe("resolved");
  });
});
