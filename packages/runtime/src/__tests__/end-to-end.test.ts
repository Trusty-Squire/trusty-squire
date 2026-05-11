// End-to-end happy-path test: a run goes CREATED → MANDATE_VALIDATED →
// PROVISIONING → ADAPTER_EXECUTING → CRED_EXTRACTED → COMPLETE entirely
// through the runtime, using the in-memory store + adapter registry +
// mock vault + stubbed fetch. This is the chunk-5 acceptance criterion.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAdapter, type AdapterManifest } from "@trusty-squire/adapter-sdk";
import { InMemoryAdapterRegistry } from "../adapter-registry.js";
import { executeOneStep } from "../executor.js";
import { InMemoryRunStore } from "../run-store.js";
import { transition } from "../state-machine.js";
import { MockVault } from "./_test-vault.js";
import { makeInboxHarness } from "./_test-inbox.js";

const NOW = "2026-05-10T08:00:00.000Z";

function happyPathManifest(): AdapterManifest {
  return defineAdapter({
    service: "happy-svc",
    version: "0.1.0",
    schema_version: 1,
    authored_by: { org: "Test", contact: "t@example.com" },
    audit: { reviewer: "t@example.com", reviewed_at: NOW },
    signature: "TEST",
    metadata: {
      display_name: "Happy",
      category: "test",
      homepage: "https://happy.example.com",
    },
    plans: [{ id: "free", display_name: "Free", monthly_cents: 0, recurrence: "none" }],
    default_plan: "free",
    capabilities: {
      payment: { max_authorize_cents: 0, recurrence: "none" },
      email: { receive_from: [] },
      network: { allowed_domains: ["api.happy.example.com"] },
      vault_writes: [
        {
          kind: "api_key",
          reference_template: "vault://${context.email_alias}/happy/api_key",
          rotation_required: false,
        },
      ],
    },
    signup: {
      steps: [
        {
          id: "create_account",
          type: "http_request",
          request: {
            method: "POST",
            url_template: "https://api.happy.example.com/v1/accounts",
            body_template: { email: "${context.email_alias}" },
          },
          expect: { status: 201, extract: { account_id: "$.body.id" } },
        },
        {
          id: "create_api_key",
          type: "http_request",
          request: {
            method: "POST",
            url_template: "https://api.happy.example.com/v1/api-keys",
            body_template: { name: "${context.project_name}" },
          },
          expect: { status: 200, extract: { api_key: "$.body.token" } },
        },
      ],
    },
    cancel: { steps: [] },
    rotate: { steps: [] },
  });
}

describe("end-to-end happy path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let vault: MockVault;

  beforeEach(() => {
    fetchMock = vi.fn();
    vault = new MockVault();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CREATED → ... → COMPLETE through executeOneStep loop", async () => {
    const store = new InMemoryRunStore();
    const registry = new InMemoryAdapterRegistry();
    registry.register(happyPathManifest());

    const { run } = await store.createRun({
      account_id: "01HACCOUNTAAAAAAAAAAAAAAAA",
      service: "happy-svc",
      plan: "free",
      project_name: "demo",
      mandate_id: "01HMANDATEAAAAAAAAAAAAAAAA",
      adapter_id: "happy-svc",
      adapter_version: "0.1.0",
      context: {
        email_alias: "demo@inbox.trustysquire.ai",
        project_name: "demo",
        user_display_name: null,
        generated: {},
        steps: {},
        vault: {},
      },
    });

    // External (non-executor) advance: validator approves the mandate.
    await store.applyTransition(
      run.id,
      transition(run, { kind: "mandate_validated", needs_approval: false }, NOW),
    );

    // Mock the two HTTP step responses.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "acc_123" }), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "sk_live_xyz" }), { status: 200 }),
      );

    const config = {
      runStore: store,
      registry,
      vault,
      inbox: makeInboxHarness().inbox,
      fetch: fetchMock as unknown as typeof fetch,
    };

    let state = await executeOneStep(config, run.id);
    expect(state.state).toBe("ADAPTER_EXECUTING"); // step 1 done
    state = await executeOneStep(config, run.id);
    expect(state.state).toBe("ADAPTER_EXECUTING"); // step 2 done
    state = await executeOneStep(config, run.id);
    expect(state.state).toBe("CRED_EXTRACTED"); // all_steps_complete + creds
    expect(state.credentials).toHaveLength(1);
    expect(state.credentials?.[0]?.value).toBe("sk_live_xyz");

    state = await executeOneStep(config, run.id);
    expect(state.state).toBe("COMPLETE");
    expect(state.subscription_id).not.toBeNull();
    expect(state.credentials).toBeNull(); // plaintext erased
    expect(vault.stored).toHaveLength(1);
    expect(vault.stored[0]?.input.value).toBe("sk_live_xyz");

    // Audit trail covers every transition.
    const events = await store.loadEvents(run.id);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "mandate_validated",
      "step_succeeded",
      "step_succeeded",
      "all_steps_complete",
      "vault_write_succeeded",
    ]);
  });
});
