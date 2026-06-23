// provision-gate.test.ts — the refuse-walled pre-flight.
//
// Two layers:
//   1. evaluateProvisionGate — pure decision (refuse permanent walls only).
//   2. e2e across the registry boundary — the REAL SkillRegistryClient
//      .fetchServiceState parsing the dossier contract, fed into the gate.
//      The fetchFn is a Response-returning stub so the client's real
//      fetch/parse path runs against the exact JSON the registry serves.

import { describe, expect, it } from "vitest";
import {
  coarseKind,
  evaluateProvisionGate,
  PERMANENT_WALL_KINDS,
  type ProvisionServiceState,
} from "../provision-gate.js";
import { SkillRegistryClient } from "../skill-registry-client.js";

function state(p: Partial<ProvisionServiceState>): ProvisionServiceState {
  return {
    status: "working",
    wall_classification: null,
    last_failure_kind: null,
    ...p,
  };
}

describe("coarseKind", () => {
  it("takes the token before the first colon, lowercased", () => {
    expect(coarseKind("phone: SMS code never arrived")).toBe("phone");
    expect(coarseKind("Phone")).toBe("phone");
    expect(coarseKind("anti_bot_blocked: Cloudflare")).toBe("anti_bot_blocked");
  });
});

describe("evaluateProvisionGate", () => {
  it("fails OPEN on null state (no registry / unknown service)", () => {
    expect(evaluateProvisionGate(null)).toEqual({ decision: "allow" });
  });

  it("allows a healthy service", () => {
    expect(evaluateProvisionGate(state({ status: "working" })).decision).toBe("allow");
  });

  it("refuses an operator-dequeued (unservable) service regardless of kind", () => {
    const v = evaluateProvisionGate(
      state({ status: "struggling", wall_classification: "unservable" }),
    );
    expect(v.decision).toBe("refuse");
  });

  it("refuses a falsified wall whose kind is a PERMANENT identity class (phone)", () => {
    const v = evaluateProvisionGate(
      state({ status: "hard-block", wall_classification: "wall", last_failure_kind: "phone" }),
    );
    expect(v).toEqual({
      decision: "refuse",
      wall_kind: "phone",
      reason: expect.stringContaining("phone verification"),
    });
  });

  it("coarsens a raw failure kind before matching (payment: card declined)", () => {
    const v = evaluateProvisionGate(
      state({
        status: "hard-block",
        wall_classification: "wall",
        last_failure_kind: "payment: card required at signup",
      }),
    );
    expect(v.decision).toBe("refuse");
    if (v.decision === "refuse") expect(v.wall_kind).toBe("payment");
  });

  it("refuses on a bare hard-block when the kind is permanent (no wall_classification yet)", () => {
    const v = evaluateProvisionGate(
      state({ status: "hard-block", wall_classification: null, last_failure_kind: "manual" }),
    );
    expect(v.decision).toBe("refuse");
  });

  it("ALLOWS a temporary / bot-bug wall (anti_bot) — the discover loop cracks those", () => {
    const v = evaluateProvisionGate(
      state({ status: "hard-block", wall_classification: "wall", last_failure_kind: "anti_bot" }),
    );
    expect(v.decision).toBe("allow");
  });

  it("ALLOWS a nav/timeout hard-block (not a permanent class)", () => {
    expect(
      evaluateProvisionGate(
        state({ status: "hard-block", wall_classification: null, last_failure_kind: "nav_timeout" }),
      ).decision,
    ).toBe("allow");
  });

  it("ALLOWS a wall with no failure kind (can't confirm it's permanent)", () => {
    expect(
      evaluateProvisionGate(
        state({ status: "struggling", wall_classification: "wall", last_failure_kind: null }),
      ).decision,
    ).toBe("allow");
  });

  it("the permanent set is exactly {phone, payment, manual, kyc}", () => {
    expect([...PERMANENT_WALL_KINDS].sort()).toEqual(["kyc", "manual", "payment", "phone"]);
  });
});

// ── e2e: real client.fetchServiceState ⇒ gate, across the dossier contract ──

function clientWithDossier(body: unknown, status = 200): SkillRegistryClient {
  // Stub fetch returns the exact JSON shape the registry's
  // GET /v1/services/:slug/dossier serves: { service, state, recent_events }.
  const fetchFn = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  return new SkillRegistryClient({
    baseUrl: "http://registry.test",
    accountId: "acct-test",
    fetchFn,
  });
}

describe("SkillRegistryClient.fetchServiceState ⇒ gate (e2e over the dossier contract)", () => {
  it("parses a permanent-wall dossier and the gate REFUSES", async () => {
    // Exactly what the registry serves for a phone-walled Stripe-like service.
    const dossier = {
      service: "stripe",
      state: {
        service: "stripe",
        status: "hard-block",
        confidence: -0.8,
        successful_count: 0,
        failed_count: 6,
        last_attempt_at: "2026-06-22T00:00:00.000Z",
        last_green_at: null,
        last_failure_kind: "payment",
        current_diagnosis: null,
        diagnosis_evidence: null,
        wall_classification: "wall",
        projection_updated_at: "2026-06-22T00:00:00.000Z",
      },
      recent_events: [],
      recent_count: 0,
    };
    const client = clientWithDossier(dossier);
    const fetched = await client.fetchServiceState("stripe");
    expect(fetched?.wall_classification).toBe("wall");
    expect(fetched?.last_failure_kind).toBe("payment");
    expect(evaluateProvisionGate(fetched).decision).toBe("refuse");
  });

  it("parses a temporary-wall dossier and the gate ALLOWS (anti_bot)", async () => {
    const dossier = {
      service: "codesandbox",
      state: {
        service: "codesandbox",
        status: "hard-block",
        confidence: -0.5,
        successful_count: 1,
        failed_count: 4,
        last_attempt_at: "2026-06-22T00:00:00.000Z",
        last_green_at: "2026-06-10T00:00:00.000Z",
        last_failure_kind: "anti_bot",
        current_diagnosis: null,
        diagnosis_evidence: null,
        wall_classification: "wall",
        projection_updated_at: "2026-06-22T00:00:00.000Z",
      },
      recent_events: [],
      recent_count: 0,
    };
    const fetched = await clientWithDossier(dossier).fetchServiceState("codesandbox");
    expect(evaluateProvisionGate(fetched).decision).toBe("allow");
  });

  it("fails OPEN when the service has no state (null) → gate allows", async () => {
    const fetched = await clientWithDossier({ service: "x", state: null }).fetchServiceState("x");
    expect(fetched).toBeNull();
    expect(evaluateProvisionGate(fetched).decision).toBe("allow");
  });

  it("fails OPEN on a 404 dossier → null → gate allows", async () => {
    const fetched = await clientWithDossier({ error: "not_found" }, 404).fetchServiceState("x");
    expect(fetched).toBeNull();
    expect(evaluateProvisionGate(fetched).decision).toBe("allow");
  });
});
