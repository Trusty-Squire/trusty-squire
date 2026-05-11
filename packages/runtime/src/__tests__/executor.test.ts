// Executor tests — integration of state machine + run store + adapter
// registry + HTTP step executor. fetch is stubbed; the rest is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAdapter, type AdapterManifest } from "@trusty-squire/adapter-sdk";
import { InMemoryAdapterRegistry } from "../adapter-registry.js";
import { ExecutorError, executeOneStep } from "../executor.js";
import { InMemoryRunStore } from "../run-store.js";
import { transition } from "../state-machine.js";
import type { Run } from "../types.js";
import { MockVault } from "./_test-vault.js";
import { makeInboxHarness } from "./_test-inbox.js";
import type { InboxService } from "@trusty-squire/inbox";

const NOW = "2026-05-10T08:00:00.000Z";

// Two-step manifest: simple + tractable for chunk-3 tests.
function makeManifest(): AdapterManifest {
  return defineAdapter({
    service: "test-svc",
    version: "0.1.0",
    schema_version: 1,
    authored_by: { org: "Test", contact: "test@example.com" },
    audit: { reviewer: "test@example.com", reviewed_at: NOW },
    signature: "TEST",
    metadata: { display_name: "Test", category: "test", homepage: "https://example.com" },
    plans: [{ id: "free", display_name: "Free", monthly_cents: 0, recurrence: "none" }],
    default_plan: "free",
    capabilities: {
      payment: { max_authorize_cents: 0, recurrence: "none" },
      email: { receive_from: [] },
      network: { allowed_domains: ["api.test.example"] },
      vault_writes: [
        {
          kind: "api_key",
          reference_template: "vault://${context.email_alias}/test/api_key",
          rotation_required: false,
        },
      ],
    },
    signup: {
      steps: [
        {
          id: "step_one",
          type: "http_request",
          request: {
            method: "POST",
            url_template: "https://api.test.example/v1/start",
            body_template: { name: "${context.project_name}" },
          },
          expect: { status: 200, extract: { id: "$.body.id" } },
        },
        {
          id: "step_two",
          type: "http_request",
          request: {
            method: "POST",
            url_template: "https://api.test.example/v1/finish",
          },
          expect: { status: 200 },
          emit_side_effect: {
            type: "vault_entry",
            reference_template: "vault://${context.email_alias}/test/api_key",
            reversible: true,
            reverse_action: {
              kind: "vault_delete",
              reference_template: "vault://${context.email_alias}/test/api_key",
            },
          },
        },
      ],
    },
    cancel: { steps: [] },
    rotate: { steps: [] },
  });
}

async function setupRunInProvisioning(store: InMemoryRunStore): Promise<Run> {
  const { run } = await store.createRun({
    account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
    service: "test-svc",
    plan: "free",
    project_name: "Demo",
    mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
    adapter_id: "test-svc",
    adapter_version: "0.1.0",
    context: {
      email_alias: "demo@inbox.trustysquire.ai",
      project_name: "Demo",
      user_display_name: null,
      generated: {},
      steps: {},
      vault: {},
    },
  });
  // Drive CREATED → PROVISIONING via state machine + apply.
  const result = transition(run, { kind: "mandate_validated", needs_approval: false }, NOW);
  return store.applyTransition(run.id, result);
}

describe("executeOneStep", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let vault: MockVault;
  let inbox: InboxService;

  beforeEach(() => {
    fetchMock = vi.fn();
    vault = new MockVault();
    inbox = makeInboxHarness().inbox;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PROVISIONING + first http step succeeds → ADAPTER_EXECUTING with step recorded", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const run = await setupRunInProvisioning(store);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "id_one" }), { status: 200 }),
    );

    const result = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(result.state).toBe("ADAPTER_EXECUTING");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("success");
    expect(result.steps[0]?.step_id).toBe("step_one");
  });

  it("capability violation (off-domain url) → COMPENSATING immediately", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    const manifest = makeManifest();
    // Mutate the first step's URL to land outside allowed_domains.
    const firstStep = manifest.signup.steps[0]!;
    if (firstStep.type !== "http_request") throw new Error("test fixture invariant");
    manifest.signup.steps[0] = {
      ...firstStep,
      request: { ...firstStep.request, url_template: "https://evil.example.com/x" },
    };
    registry.register(manifest);
    const run = await setupRunInProvisioning(store);

    const result = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(result.state).toBe("COMPENSATING");
    expect(result.failure_reason).toBe("capability_violation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("network error retries: stays in PROVISIONING with incremented retry_count", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const run = await setupRunInProvisioning(store);

    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    const after1 = await executeOneStep(
      { runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch },
      run.id,
    );
    expect(after1.state).toBe("PROVISIONING");
    expect(after1.retry_count).toBe(1);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "id_one" }), { status: 200 }),
    );
    const after2 = await executeOneStep(
      { runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch },
      run.id,
    );
    expect(after2.state).toBe("ADAPTER_EXECUTING");
  });

  it("403 response triggers tier escalation", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const run = await setupRunInProvisioning(store);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 403 }));
    const result = await executeOneStep(
      { runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch },
      run.id,
    );
    expect(result.state).toBe("TIER_ESCALATING");
  });

  it("all steps complete + extracted credential → CRED_EXTRACTED (chunk-5 routes onward)", async () => {
    // Use a manifest whose second step extracts an api_key — matches the
    // single vault_writes declaration's kind so chunk-5's extractCredentials
    // populates run.credentials.
    const manifest = makeManifest();
    manifest.signup.steps[1] = {
      id: "step_two",
      type: "http_request",
      request: {
        method: "POST",
        url_template: "https://api.test.example/v1/finish",
      },
      expect: { status: 200, extract: { api_key: "$.body.token" } },
      emit_side_effect: {
        type: "vault_entry",
        reference_template: "vault://${context.email_alias}/test/api_key",
        reversible: true,
        reverse_action: {
          kind: "vault_delete",
          reference_template: "vault://${context.email_alias}/test/api_key",
        },
      },
    };
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(manifest);
    let run = await setupRunInProvisioning(store);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "id_one" }), { status: 200 }),
    );
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(run.state).toBe("ADAPTER_EXECUTING");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "sk_test_abc" }), { status: 200 }),
    );
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(run.state).toBe("ADAPTER_EXECUTING"); // both http steps recorded
    expect(run.steps).toHaveLength(2);
    expect(run.side_effects).toHaveLength(1);

    // Third call: no more steps to run → all_steps_complete fires.
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(run.state).toBe("CRED_EXTRACTED");
    expect(run.credentials).toHaveLength(1);
    expect(run.credentials?.[0]?.value).toBe("sk_test_abc");
  });

  it("TIER_ESCALATING + executeOneStep → ADAPTER_EXECUTING with current_tier=2", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    const run = await setupRunInProvisioning(store);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }));
    const escalated = await executeOneStep(
      { runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch },
      run.id,
    );
    expect(escalated.state).toBe("TIER_ESCALATING");

    const promoted = await executeOneStep(
      { runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch },
      escalated.id,
    );
    expect(promoted.state).toBe("ADAPTER_EXECUTING");
    expect(promoted.current_tier).toBe(2);
  });

  it("CRED_EXTRACTED with no credentials extracted lands the run in COMPENSATING (chunk-5)", async () => {
    // The chunk-3 stub manifest declares vault_writes: [api_key] but no
    // step extracts a value named 'api_key'. Chunk-5's extractCredentials
    // returns []; all_steps_complete sees credentials_extracted=false and
    // routes to COMPENSATING (the safe fallback when a flow finishes
    // without producing what its capabilities promised).
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    let run = await setupRunInProvisioning(store);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "id_one" }), { status: 200 }),
    );
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(run.state).toBe("COMPENSATING");
    expect(run.failure_reason).toBe("no_credentials_extracted");

    // The chunk-3 ExecutorError on CRED_EXTRACTED is gone — we now
    // route through compensation, which drives the run to FAILED.
    void ExecutorError;
    const compensated = await executeOneStep(
      {
        runStore: store,
        registry,
        vault,
        inbox,
        fetch: fetchMock as unknown as typeof fetch,
        compensateOptions: { sleep: () => Promise.resolve() },
      },
      run.id,
    );
    expect(compensated.state).toBe("FAILED");
  });

  it("tier 2 dispatch throws not-implemented when stepping after escalation", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeManifest());
    let run = await setupRunInProvisioning(store);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }));
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    run = await executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id);
    expect(run.state).toBe("ADAPTER_EXECUTING");
    expect(run.current_tier).toBe(2);

    await expect(
      executeOneStep({ runStore: store, registry, vault, inbox, fetch: fetchMock as unknown as typeof fetch }, run.id),
    ).rejects.toThrow(/tier 2 dispatch not implemented/);
  });
});

describe("InMemoryRunStore", () => {
  it("createRun is idempotent within (account_id, service, project_name)", async () => {
    const store = new InMemoryRunStore();
    const input = {
      account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
      service: "resend",
      plan: "free",
      project_name: "Demo",
      mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
      adapter_id: "resend",
      adapter_version: "0.1.0",
      context: {
        email_alias: "demo@inbox.trustysquire.ai",
        project_name: "Demo",
        user_display_name: null,
        generated: {},
        steps: {},
        vault: {},
      },
    };
    const a = await store.createRun(input);
    const b = await store.createRun(input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.run.id).toBe(b.run.id);
  });

  it("findRunsInState returns only matching runs", async () => {
    const store = new InMemoryRunStore();
    const r1 = await setupRunInProvisioning(store);
    const r2 = await store.createRun({
      account_id: r1.account_id,
      service: "other-svc",
      plan: "free",
      project_name: "Other",
      mandate_id: r1.mandate_id,
      adapter_id: "other-svc",
      adapter_version: "0.1.0",
      context: r1.context,
    });
    expect(r2.run.state).toBe("CREATED");
    const provisioning = await store.findRunsInState("PROVISIONING", 10);
    const created = await store.findRunsInState("CREATED", 10);
    expect(provisioning).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it("loadEvents replays the audit trail in order", async () => {
    const store = new InMemoryRunStore();
    const run = await setupRunInProvisioning(store);
    const events = await store.loadEvents(run.id);
    // CREATED → PROVISIONING produced one event
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("mandate_validated");
    expect(events[0]?.from_state).toBe("CREATED");
    expect(events[0]?.to_state).toBe("PROVISIONING");
  });
});
