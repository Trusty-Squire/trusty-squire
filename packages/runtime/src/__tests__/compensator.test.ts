// Compensator tests — LIFO ordering, retry semantics, non-reversible
// handling, and end-state verification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compensate } from "../compensator.js";
import { InMemoryRunStore } from "../run-store.js";
import { transition } from "../state-machine.js";
import type {
  CompensationResult,
  CompensationResults,
  Run,
  RunContext,
  SideEffect,
} from "../types.js";
import { MockVault } from "./_test-vault.js";

const NOW = "2026-05-10T08:00:00.000Z";

function baseContext(): RunContext {
  return {
    email_alias: "demo@inbox.trustysquire.ai",
    project_name: "Demo",
    user_display_name: null,
    generated: {},
    steps: {},
    vault: {},
  };
}

async function setupRunInCompensating(
  store: InMemoryRunStore,
  effects: SideEffect[],
): Promise<Run> {
  const { run } = await store.createRun({
    account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
    service: "test-svc",
    plan: "free",
    project_name: "Demo",
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
    adapter_id: "test-svc",
    adapter_version: "0.1.0",
    context: baseContext(),
  });
  // CREATED → PROVISIONING
  let state = await store.applyTransition(
    run.id,
    transition(run, { kind: "mandate_validated", needs_approval: false }, NOW),
  );
  // Drop side effects directly through a synthetic step_succeeded — the
  // run-store's apply path is the only mutation surface.
  state = await store.applyTransition(
    state.id,
    transition(
      state,
      {
        kind: "step_succeeded",
        step: {
          index: 0,
          step_id: "seed",
          type: "http_request",
          attempt: 1,
          tier: 1,
          started_at: NOW,
          completed_at: NOW,
          status: "success",
          request: null,
          response: null,
          error: null,
          fixture_uri: null,
        },
        new_side_effects: effects,
      },
      NOW,
    ),
  );
  // ADAPTER_EXECUTING → COMPENSATING via all_steps_complete with no creds
  state = await store.applyTransition(
    state.id,
    transition(state, { kind: "all_steps_complete", credentials_extracted: false }, NOW),
  );
  return state;
}

function makeEffect(overrides: Partial<SideEffect>): SideEffect {
  return {
    id: `01HEFFECT${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    type: "saas_account",
    reference: "test:thing",
    reversible: true,
    reverse_action: { kind: "noop", reason: "test default" },
    emitted_at: NOW,
    ...overrides,
  };
}

describe("compensate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let vault: MockVault;
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vault = new MockVault();
    sleep = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("single reversible HTTP side effect → reversed via fetch + DELETE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const store = new InMemoryRunStore();
    const effect = makeEffect({
      reverse_action: {
        kind: "http_request",
        method: "DELETE",
        url_template: "https://api.test.example/v1/things/abc",
      },
    });
    const run = await setupRunInCompensating(store, [effect]);

    const after = await compensate(store, vault, run.id, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
      now: () => NOW, logger: () => {},
    });
    expect(after.state).toBe("FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test.example/v1/things/abc");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      `${run.id}.compensate.${effect.id}`,
    );
  });

  it("multiple side effects → reversed in LIFO order", async () => {
    const calledRefs: string[] = [];
    const e1 = makeEffect({ id: "01EFF0000000000000000000A1", reverse_action: { kind: "vault_delete", reference_template: "ref1" } });
    const e2 = makeEffect({ id: "01EFF0000000000000000000A2", reverse_action: { kind: "vault_delete", reference_template: "ref2" } });
    const e3 = makeEffect({ id: "01EFF0000000000000000000A3", reverse_action: { kind: "vault_delete", reference_template: "ref3" } });

    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [e1, e2, e3]);

    // Spy on vault.delete to record order
    const realDelete = vault.delete.bind(vault);
    vi.spyOn(vault, "delete").mockImplementation(async (ref: string) => {
      calledRefs.push(ref);
      await realDelete(ref);
    });

    await compensate(store, vault, run.id, { sleep: sleep as unknown as (ms: number) => Promise<void>, now: () => NOW, logger: () => {} });
    expect(calledRefs).toEqual(["ref3", "ref2", "ref1"]);
  });

  it("non-reversible side effect → marked skipped, others continue", async () => {
    const e1 = makeEffect({ id: "01EFF1111111111111111111A1", reverse_action: { kind: "vault_delete", reference_template: "ref-keep" } });
    const e2 = makeEffect({ id: "01EFF1111111111111111111A2", reversible: false });
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [e1, e2]);

    await compensate(store, vault, run.id, { sleep: sleep as unknown as (ms: number) => Promise<void>, now: () => NOW, logger: () => {} });

    const events = await store.loadEvents(run.id);
    const completion = events.find((e) => e.type === "compensation_completed");
    const results = (completion?.payload.results as CompensationResults | undefined)
      ?.per_effect;
    expect(results?.find((r) => r.side_effect_id === e2.id)?.outcome).toBe(
      "skipped_non_reversible",
    );
    expect(results?.find((r) => r.side_effect_id === e1.id)?.outcome).toBe("succeeded");
  });

  it("reverse action fails 3 times → logged, run still reaches FAILED", async () => {
    fetchMock.mockRejectedValue(new TypeError("boom"));
    const effect = makeEffect({
      reverse_action: {
        kind: "http_request",
        method: "DELETE",
        url_template: "https://api.test.example/v1/explode",
      },
    });
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [effect]);

    const after = await compensate(store, vault, run.id, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
      now: () => NOW, logger: () => {},
    });
    expect(after.state).toBe("FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Sleeps between attempts: 1s and 4s (2 sleeps total — none after the
    // final failed attempt).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4_000);
  });

  it("retry succeeds on the second attempt → outcome.attempts is 2", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("transient"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const effect = makeEffect({
      reverse_action: {
        kind: "http_request",
        method: "DELETE",
        url_template: "https://api.test.example/v1/things/x",
      },
    });
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [effect]);

    await compensate(store, vault, run.id, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
      now: () => NOW, logger: () => {},
    });
    const events = await store.loadEvents(run.id);
    const completion = events.find((e) => e.type === "compensation_completed");
    const result = (
      (completion?.payload.results as CompensationResults | undefined)?.per_effect[0]
    ) as CompensationResult | undefined;
    expect(result?.outcome).toBe("succeeded");
    expect(result?.attempts).toBe(2);
  });

  it("all compensations fail → run still transitions to FAILED with per-effect failure detail", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const e1 = makeEffect({
      id: "01EFF2222222222222222222A1",
      reverse_action: {
        kind: "http_request",
        method: "DELETE",
        url_template: "https://api.test.example/v1/a",
      },
    });
    const e2 = makeEffect({
      id: "01EFF2222222222222222222A2",
      reverse_action: {
        kind: "http_request",
        method: "DELETE",
        url_template: "https://api.test.example/v1/b",
      },
    });
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [e1, e2]);

    const after = await compensate(store, vault, run.id, {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
      now: () => NOW, logger: () => {},
    });
    expect(after.state).toBe("FAILED");
    const events = await store.loadEvents(run.id);
    const completion = events.find((e) => e.type === "compensation_completed");
    const results = (completion?.payload.results as CompensationResults | undefined)
      ?.per_effect;
    expect(results?.every((r) => r.outcome === "failed")).toBe(true);
  });

  it("empty side effects → completes immediately (still transitions to FAILED)", async () => {
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, []);

    const after = await compensate(store, vault, run.id, { sleep: sleep as unknown as (ms: number) => Promise<void>, now: () => NOW, logger: () => {} });
    expect(after.state).toBe("FAILED");
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("noop reverse action succeeds without external calls", async () => {
    const effect = makeEffect({
      reverse_action: { kind: "noop", reason: "rotation is non-reversible" },
    });
    const store = new InMemoryRunStore();
    const run = await setupRunInCompensating(store, [effect]);

    const after = await compensate(store, vault, run.id, { sleep: sleep as unknown as (ms: number) => Promise<void>, now: () => NOW, logger: () => {} });
    expect(after.state).toBe("FAILED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the run isn't in COMPENSATING", async () => {
    const store = new InMemoryRunStore();
    const { run } = await store.createRun({
      account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
      service: "test",
      plan: "free",
      project_name: "X",
      mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
      adapter_id: "test",
      adapter_version: "0.1.0",
      context: baseContext(),
    });
    // run is in CREATED
    await expect(
      compensate(store, vault, run.id, { sleep: sleep as unknown as (ms: number) => Promise<void>, now: () => NOW, logger: () => {} }),
    ).rejects.toThrow(/COMPENSATING/);
  });
});
